import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SessionQuery from '@deepseek-ai/dsh-session-query'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { BlueprintService } from '../../src/index.ts'
import { provideFixtureWorkingDirectory } from '../runtime-contracts/agent-fixtures.mjs'

const baseRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-base'))
const { default: AgentLoop } = await import(baseRequire.resolve('@deepseek-ai/dsh-agent-loop'))
const { default: SystemPrompt } = await import(baseRequire.resolve('@deepseek-ai/dsh-system-prompt'))
const { default: ApprovalService } = await import(baseRequire.resolve('@deepseek-ai/dsh-user-approval'))
const { default: PermissionPresets } = await import(baseRequire.resolve('@deepseek-ai/dsh-permission-presets'))
const AutoReview = await import(baseRequire.resolve('@deepseek-ai/dsh-experimental-auto-review'))

export const toolResponse = (name, args, id = 'call-1') => [
  { type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: JSON.stringify(args) },
  { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: JSON.stringify(args) } },
  { type: 'finish', reason: { kind: 'tool-calls' } }
]

export const textResponse = text => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
  { type: 'finish', reason: { kind: 'stop' } }
]

// Only the external model is scripted. AgentLoop, inbox, scope, tools, Session,
// query, and native continuation authorization are the installed DSH services.
export class ScriptedAdapter extends LlmAdapter {
  requests = []
  constructor(script) {
    super()
    this.script = [...script]
  }
  async resolveModel(provider, model) {
    return { provider, id: model, name: model }
  }
  async *stream(options) {
    this.requests.push(options)
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('managed workflow model script exhausted')
    const chunks = typeof entry === 'function' ? await entry(options) : entry
    for (const chunk of chunks) {
      options.signal?.throwIfAborted()
      yield chunk
    }
  }
}

class PointQuery extends SessionQuery {
  searchSessions() {
    throw new Error('search not used')
  }
  searchEvents() {
    throw new Error('search not used')
  }
}

export async function publicHost(t, script) {
  const ctx = new Context()
  const adapter = new ScriptedAdapter(script)
  for (const service of [LlmRuntime, SessionStore, SessionProjections, SystemPrompt, ToolRuntime, AgentRegistry]) await ctx.plugin(service)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['managed-fixture'], adapter)
  provideFixtureWorkingDirectory(ctx, process.cwd())
  new PointQuery(ctx)
  await ctx.plugin(SubagentRuntime, {})
  t.after(() => ctx.fiber.dispose())
  const selection = { provider: 'managed-fixture', model: 'scripted' }
  return { ctx, adapter, selection }
}

export async function workflowHost(
  t,
  { preset = 'workspace-write', script = [], approval = 'allowed-once', auto = false, scopedClient = false, team = false } = {}
) {
  const h = await publicHost(t, script)
  const root = mkdtempSync(join(tmpdir(), 'bp-managed-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  h.ctx.provide('shell', { sandboxMode: 'workspace-write' })
  await h.ctx.plugin(ApprovalService, { policy: 'ask' })
  await h.ctx.plugin(PermissionPresets, {})
  if (auto) await h.ctx.plugin(AutoReview)
  if (team) {
    const teamRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-experimental-agent-team-profile/package.json'))
    const persistence = await import(baseRequire.resolve('@deepseek-ai/dsh-session-persistence-jsonl'))
    const { default: TeamService } = await import(teamRequire.resolve('@deepseek-ai/dsh-experimental-agent-team'))
    const TeamTools = await import(teamRequire.resolve('@deepseek-ai/dsh-experimental-tool-agent-team'))
    await h.ctx.plugin(persistence, { root: join(root, 'sessions') })
    await h.ctx.plugin(TeamService)
    await h.ctx.plugin(TeamTools)
  }
  const caller = await h.ctx.agentLoop.create(SessionId('workflow-caller'), h.selection)
  h.ctx.permissionPresets.set(caller.session, preset)
  const approvals = []
  h.ctx.on('approval/request', async req => {
    approvals.push(req)
    return typeof approval === 'function' ? approval(req) : approval
  })
  await h.ctx.plugin(BlueprintService, { workspaceRoot: root, runtimeRoot: join(root, '.runs') })
  let service = h.ctx.blueprint
  if (scopedClient) {
    await h.ctx.plugin({
      name: 'managed-blueprint-client',
      inject: ['blueprint'],
      apply(ctx) {
        service = ctx.blueprint
      }
    })
  }
  let callId = 0
  const dispatch = (name, args, signal = new AbortController().signal) =>
    h.ctx.tools.execute({ name, arguments: args, agent: caller, signal, callId: `policy-${++callId}` })
  return { ...h, root, caller, approvals, dispatch, service }
}
