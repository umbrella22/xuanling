import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { decodeDefinition } from '../definition/codec.ts'
import type { RunRecord, AttemptRecord } from '../persistence/records.ts'
import type { RunStore } from '../persistence/run-store.ts'
import { ManagedNodeError } from '../persistence/managed-node-error.ts'
import type { NodeMessageArgs, NodeMessageReceipt, NodeSessionView } from '../conversation/managed-node-contracts.ts'

interface LiveNode {
  runId: string
  attemptId: string
  agent: Agent
  signal: AbortSignal
  uncertain: () => void
  accepting: boolean
  tail: Promise<unknown>
}

export interface ManagedNodeBinding {
  close(): void
  waiting(): Promise<void>
  drain(): Promise<void>
  dispose(): void
}

/** Run-owned live inbox access. Native generic continuation stays disabled. */
export class ManagedNodeSessions {
  private readonly live = new Map<string, LiveNode>()
  constructor(
    private readonly ctx: Context,
    private readonly store: RunStore
  ) {}

  bind(runId: string, attemptId: string, agent: Agent, signal: AbortSignal, uncertain: () => void): ManagedNodeBinding {
    if (this.live.has(agent.session.id)) throw new ManagedNodeError('node-session-unavailable')
    const entry: LiveNode = { runId, attemptId, agent, signal, uncertain, accepting: true, tail: Promise.resolve() }
    this.live.set(agent.session.id, entry)
    return {
      close: () => {
        entry.accepting = false
      },
      waiting: async () => {
        if (!entry.accepting || signal.aborted) return
        await this.serial(entry, async () => {
          const record = await this.store.get(runId)
          const attempt = record.attempts.find(item => item.attemptId === attemptId)
          if (!entry.accepting || signal.aborted || record.state !== 'running' || attempt?.result || attempt?.state === 'waiting_input') return
          await this.store.transition(runId, draft => {
            if (entry.accepting && !signal.aborted && draft.state === 'running') {
              const current = draft.attempts.find(item => item.attemptId === attemptId)!
              if (!current.result && entry.agent.status === 'idle') current.state = 'waiting_input'
            }
          })
        })
      },
      drain: async () => {
        await entry.tail
      },
      dispose: () => {
        entry.accepting = false
        if (this.live.get(agent.session.id) === entry) this.live.delete(agent.session.id)
      }
    }
  }

  closeRun(runId: string): void {
    for (const entry of this.live.values()) if (entry.runId === runId) entry.accepting = false
  }

  private async serial<T>(entry: LiveNode, action: () => Promise<T>): Promise<T> {
    const result = entry.tail.then(action)
    entry.tail = result.catch(() => {})
    return result
  }

  private active(record: RunRecord, args: Pick<NodeMessageArgs, 'attemptId' | 'sessionId'>): AttemptRecord {
    const attempt = record.attempts.find(item => item.attemptId === args.attemptId && item.sessionId === args.sessionId)
    const node = decodeDefinition(record.definitionJson).graph.nodes.find(item => item.id === attempt?.nodeId)
    if (record.state !== 'running' || !attempt || attempt.result || !['running', 'waiting_input'].includes(attempt.state) || node?.interaction !== 'managed')
      throw new ManagedNodeError('node-not-active')
    return attempt
  }

  view(record: RunRecord, attempt: AttemptRecord): NodeSessionView {
    const node = decodeDefinition(record.definitionJson).graph.nodes.find(item => item.id === attempt.nodeId)
    if (node?.interaction !== 'managed' || attempt.sessionId === undefined) return { status: 'unmanaged' }
    const entry = this.live.get(attempt.sessionId)
    const canMessage =
      record.state === 'running' &&
      !attempt.result &&
      ['running', 'waiting_input'].includes(attempt.state) &&
      entry?.runId === record.runId &&
      entry.attemptId === attempt.attemptId &&
      entry.accepting &&
      !entry.signal.aborted
    return {
      status: 'managed',
      runId: record.runId,
      attemptId: attempt.attemptId,
      nodeId: attempt.nodeId,
      sessionId: attempt.sessionId,
      state: canMessage ? (attempt.state === 'waiting_input' ? 'waiting_input' : 'active') : 'closed',
      canMessage: !!canMessage
    }
  }

  async message(args: NodeMessageArgs): Promise<NodeMessageReceipt> {
    const entry = this.live.get(args.sessionId)
    // Inspect canonical membership even when there is no live handle, so a
    // terminal retry cannot silently resurrect a cold Agent.
    this.active(await this.store.get(args.runId), args)
    if (!entry || entry.runId !== args.runId || entry.attemptId !== args.attemptId) throw new ManagedNodeError('node-session-unavailable')
    return this.serial(entry, async () => {
      const assertLive = () => {
        if (!entry.accepting || entry.signal.aborted) throw new ManagedNodeError('node-not-active')
        if (this.ctx.get('agents')?.get(SessionId(args.sessionId)) !== entry.agent) throw new ManagedNodeError('node-session-unavailable')
      }
      assertLive()
      const record = await this.store.get(args.runId)
      const attempt = this.active(record, args)
      assertLive()
      const digest = createHash('sha256')
        .update(JSON.stringify([args.delivery, args.text]))
        .digest('hex')
      const prior = attempt.messages?.find(item => item.requestId === args.requestId)
      const receipt = (messageId: string, replayed: boolean): NodeMessageReceipt => ({
        runId: args.runId,
        attemptId: args.attemptId,
        sessionId: args.sessionId,
        requestId: args.requestId,
        messageId,
        replayed
      })
      if (prior) {
        if (prior.digest !== digest) throw new ManagedNodeError('command-conflict')
        if (prior.state !== 'accepted') throw new ManagedNodeError('node-message-unknown')
        return receipt(prior.messageId, true)
      }
      const message = createUserMessage({ content: [{ type: 'text', text: args.text }], source: { kind: 'user', rpcId: args.requestId } })
      await this.store.transition(args.runId, draft => {
        assertLive()
        const current = this.active(draft, args)
        current.messages ??= []
        current.messages.push({ requestId: args.requestId, digest, messageId: message.id, state: 'pending', at: Date.now() })
        current.state = 'running'
      })
      let dispatched = false
      try {
        this.active(await this.store.get(args.runId), args)
        assertLive()
        dispatched = true // synchronous inbox methods may throw after acceptance
        if (args.delivery === 'steer') entry.agent.steer(message)
        else entry.agent.followup(message)
        const sessions = this.ctx.get('sessions')
        if (!sessions) throw new Error('session store unavailable')
        const flushed = await sessions.flush(entry.agent.session)
        if (this.ctx.get('sessionPersistence') !== undefined && !flushed) throw new Error('session flush unavailable')
        await this.store.transition(args.runId, draft => {
          const pending = draft.attempts.find(item => item.attemptId === args.attemptId)?.messages?.find(item => item.requestId === args.requestId)
          if (!pending || pending.messageId !== message.id) throw new ManagedNodeError('node-message-unknown')
          pending.state = 'accepted'
        })
        return receipt(message.id, false)
      } catch (error) {
        if (dispatched) {
          entry.accepting = false
          entry.uncertain()
          throw new ManagedNodeError('node-message-unknown')
        }
        throw error
      }
    })
  }
}
