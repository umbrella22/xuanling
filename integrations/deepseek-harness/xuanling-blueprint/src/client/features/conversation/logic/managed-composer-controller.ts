import type { NodeMessageArgs, NodeMessageReceipt, NodeSessionView } from '../../../../conversation/managed-node-contracts.ts'
import { BlueprintRemoteError } from '../../../adapters/host/remote.ts'

export interface ManagedComposerHost {
  inspectNodeSession(args: { sessionId: string }): Promise<NodeSessionView>
  messageNode(args: NodeMessageArgs): Promise<NodeMessageReceipt>
}
export interface ManagedComposerSnapshot {
  node: NodeSessionView | null
  connection: 'loading' | 'ready' | 'unavailable'
  draft: string
  delivery: 'queue' | 'steer'
  submission: 'idle' | 'sending' | 'uncertain' | 'rejected' | 'sent'
}

/** One Session generation owns the draft and immutable retry payload. */
export class ManagedComposerController {
  private snapshot: ManagedComposerSnapshot = { node: null, connection: 'loading', draft: '', delivery: 'queue', submission: 'idle' }
  private readonly listeners = new Set<() => void>()
  private request: NodeMessageArgs | null = null
  private active = true
  private inFlight = false
  private reading: Promise<void> | null = null
  constructor(
    private readonly host: ManagedComposerHost,
    readonly sessionId: string
  ) {}
  readonly getSnapshot = () => this.snapshot
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private publish(change: Partial<ManagedComposerSnapshot>) {
    this.snapshot = { ...this.snapshot, ...change }
    for (const listener of this.listeners) listener()
  }
  close() {
    this.active = false
    this.publish({ connection: 'unavailable' })
  }
  setDraft(draft: string) {
    if (!this.request && !this.inFlight) this.publish({ draft, submission: 'idle' })
  }
  setDelivery(delivery: 'queue' | 'steer') {
    if (!this.request && !this.inFlight) this.publish({ delivery })
  }
  refresh(): Promise<void> {
    if (!this.active) return Promise.resolve()
    if (this.reading) return this.reading
    const read = async () => {
      try {
        const node = await this.host.inspectNodeSession({ sessionId: this.sessionId })
        if (node.status === 'managed' && node.sessionId !== this.sessionId) throw new BlueprintRemoteError('blueprint/dto-invalid')
        if (this.active) this.publish({ node, connection: 'ready' })
      } catch {
        if (this.active) this.publish({ connection: 'unavailable' })
      }
    }
    this.reading = read().finally(() => {
      this.reading = null
    })
    return this.reading
  }
  async send(retry = false): Promise<void> {
    if (!this.active || this.inFlight || (retry ? !this.request : !!this.request || !this.snapshot.draft.trim())) return
    this.inFlight = true
    this.publish({ submission: 'sending' })
    try {
      await this.refresh()
      const node = this.snapshot.node
      if (!this.active || this.snapshot.connection !== 'ready' || node?.status !== 'managed' || !node.canMessage) {
        this.publish({ submission: this.request ? 'uncertain' : 'rejected' })
        return
      }
      if (!this.request)
        this.request = {
          runId: node.runId,
          attemptId: node.attemptId,
          sessionId: this.sessionId,
          requestId: crypto.randomUUID(),
          delivery: this.snapshot.delivery,
          text: this.snapshot.draft
        }
      const request = this.request
      if (request.runId !== node.runId || request.attemptId !== node.attemptId) throw new BlueprintRemoteError('blueprint/node-not-active')
      const receipt = await this.host.messageNode(request)
      if (['runId', 'attemptId', 'sessionId', 'requestId'].some(key => receipt[key as keyof NodeMessageReceipt] !== request[key as keyof NodeMessageArgs]))
        throw new BlueprintRemoteError('blueprint/dto-invalid')
      this.request = null
      this.publish({ draft: this.snapshot.draft === request.text ? '' : this.snapshot.draft, submission: 'sent' })
    } catch (error) {
      const rejected =
        error instanceof BlueprintRemoteError &&
        ['blueprint/node-not-active', 'blueprint/node-session-unavailable', 'blueprint/command-conflict'].includes(error.code)
      if (rejected) this.request = null
      this.publish({ submission: rejected || !this.request ? 'rejected' : 'uncertain' })
    } finally {
      this.inFlight = false
      await this.refresh()
    }
  }
}
