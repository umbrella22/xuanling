/** Optional native Tools registrations. Caller identity is supplied by the
 * host execution carrier; it never appears in model-authored parameters. */
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { inspectSessionCodec, runAdmissionCodec, type InspectSessionArgs, type InspectSessionValue, type RunAdmissionView, type RunSource } from './contracts.ts'

export interface ConversationToolService {
  listDefinitions(): Promise<{ definitions: Array<{ blueprintId: string; name: string; documentRevision: string | null; semanticRevision: string | null }> }>
  inspectSession(args: InspectSessionArgs): Promise<InspectSessionValue>
}
export interface ToolStartArgs { blueprintId: string; expectedRevision: string; inputJson: string }

/** UI admission must refer to an exact native Session owned by a live Agent. */
export function liveCaller(ctx: Context, sessionId: string, caller?: Agent): Agent {
  const registry = ctx.get('agents')
  const live = registry?.get(SessionId(sessionId))
  if (!live || live.session.id !== sessionId || (caller !== undefined && live !== caller)) {
    throw new HarnessError('session-unavailable', 'session-unavailable')
  }
  return live
}
export function assertRootCaller(agent: Agent): void {
  if (agent.session.header.origin === 'subagent') throw new HarnessError('nested-run-unavailable', 'nested-run-unavailable')
}
export function callerSource(ctx: Context, exec: ToolRunContext): RunSource {
  if (!exec.agent || typeof exec.callId !== 'string' || !exec.callId) throw new HarnessError('session-unavailable', 'session-unavailable')
  const agent = liveCaller(ctx, exec.agent.session.id, exec.agent)
  assertRootCaller(agent)
  const boundary = (ctx.get('sessionProjections') as { stateOf(session: Session, key: 'turnBoundary'): { lastTurn: number; openTurnStartSeq: number | null } | undefined } | undefined)?.stateOf(agent.session, 'turnBoundary')
  return { sessionId: agent.session.id, kind: 'tool', callId: exec.callId,
    ...(boundary === undefined || boundary.openTurnStartSeq === null ? {} : { turn: boundary.lastTurn }) }
}

const toolStartArgs = z.strictObject({ blueprintId: z.string().min(1), expectedRevision: z.string().min(1), inputJson: z.string() })
const toolInspectArgs = z.strictObject({ runId: z.string().min(1).optional() })
function strictToolArgs<T>(codec: z.ZodType<T>, args: unknown): T {
  const parsed = codec.safeParse(args)
  if (!parsed.success) throw new HarnessError('INVALID_ARGS', 'INVALID_ARGS')
  return parsed.data
}

const renderJson = (_args: unknown, value: unknown): [{ type: 'text'; text: string }] => [{ type: 'text', text: JSON.stringify(value) }]
export const TEAMSTAGE_ERROR_CODES = [
  'blueprint/team-unavailable', 'blueprint/team-identity-unavailable', 'blueprint/team-stage-conflict',
  'blueprint/team-task-conflict', 'blueprint/team-output-rejected', 'blueprint/durability-failed',
] as const

/** Translate internal TeamStage failures to the stable redacted host error
 * vocabulary. Error messages and provider payloads never cross this boundary. */
export function mapTeamStageError(error: unknown): string {
  const code = (error as { code?: unknown })?.code
  if (code === 'TEAM_STAGE_CONFLICT') return 'blueprint/team-stage-conflict'
  if (code === 'TEAM_TASK_CONFLICT') return 'blueprint/team-task-conflict'
  if (code === 'TEAM_OUTPUT_REJECTED') return 'blueprint/team-output-rejected'
  if (code === 'TEAM_UNAVAILABLE') return 'blueprint/team-unavailable'
  if (code === 'TEAM_IDENTITY_UNAVAILABLE') return 'blueprint/team-identity-unavailable'
  if (code === 'DURABILITY_FAILED') return 'blueprint/durability-failed'
  if (code === 'RUN_NOT_FOUND') return 'blueprint/run-not-found'
  if (code === 'COMMAND_CONFLICT') return 'COMMAND_CONFLICT'
  return 'blueprint/durability-failed'
}
/** Raw dependency exceptions never leave a model-facing tool. */
async function toolResult<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation() } catch (error) {
    const code = (error as { code?: unknown })?.code
    const allowed = ['session-unavailable', 'nested-run-unavailable', 'blueprint/definition-not-found', 'blueprint/definition-invalid',
      'blueprint/revision-conflict', 'blueprint/preflight-blocked', 'blueprint/durability-failed', 'blueprint/run-not-found',
      'blueprint/team-unavailable', 'blueprint/team-identity-unavailable', 'blueprint/team-stage-conflict',
      'blueprint/team-task-conflict', 'blueprint/team-output-rejected', 'COMMAND_CONFLICT', 'gateway/bad-request', 'INVALID_ARGS']
    const safe = typeof code === 'string' && allowed.includes(code) ? code
      : (code === 'TEAM_STAGE_CONFLICT' || code === 'TEAM_TASK_CONFLICT' || code === 'TEAM_OUTPUT_REJECTED' || code === 'TEAM_UNAVAILABLE' || code === 'TEAM_IDENTITY_UNAVAILABLE' || code === 'DURABILITY_FAILED' || code === 'RUN_NOT_FOUND'
        ? mapTeamStageError(error) : 'blueprint/tool-failed')
    throw new HarnessError(safe, safe)
  }
}

export function installConversationTools(ctx: Context, service: ConversationToolService,
  start: (args: ToolStartArgs, source: RunSource) => Promise<RunAdmissionView>): void {
  // Do not await this child: absent Tools is a supported headless composition.
  ctx.inject(['tools'], scoped => {
    scoped.effect(() => {
      const removers: Array<() => void> = []
      try {
        removers.push(scoped.tools.register(defineTool({ name: 'blueprint_list', description: 'List configured blueprints and their current document revision for an explicit blueprint_start.',
          parameters: {}, output: { schema: { type: 'object', additionalProperties: false, properties: {
            definitions: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
              blueprintId: { type: 'string', required: true }, name: { type: 'string', required: true },
              documentRevision: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
            } } },
          } }, render: renderJson },
          execute: args => toolResult(async () => { strictToolArgs(z.strictObject({}), args); return { definitions: (await service.listDefinitions()).definitions.map(({ blueprintId, name, documentRevision }) => ({ blueprintId, name, documentRevision })) } }),
        })))
        removers.push(scoped.tools.register(defineTool({ name: 'blueprint_start', description: 'Explicitly start a configured blueprint from this root conversation using the document revision returned by blueprint_list.',
          parameters: { blueprintId: { type: 'string', required: true }, expectedRevision: { type: 'string', required: true }, inputJson: { type: 'string', required: true } },
          output: { schema: { type: 'object', additionalProperties: false, properties: {
            runId: { type: 'string', required: true }, semanticRevision: { type: 'string', required: true }, state: { type: 'string', required: true }, replayed: { type: 'boolean', required: true },
          } }, render: renderJson },
          execute: (args, exec) => toolResult(async () => { exec.signal.throwIfAborted(); return runAdmissionCodec().parse(await start(strictToolArgs(toolStartArgs, args), callerSource(ctx, exec))) }),
        })))
        removers.push(scoped.tools.register(defineTool({ name: 'blueprint_inspect', description: 'Read only the frozen blueprint Run associated with this conversation. Optionally select a Run belonging to this session.',
          parameters: { runId: { type: 'string' } },
          // The strict discriminated codec owns the public result, including all
          // nested whitelists. JSON preserves both bound/unbound branches.
          output: { schema: { type: 'json' }, render: renderJson },
          execute: (args, exec) => toolResult(async () => {
            const parsed = strictToolArgs(toolInspectArgs, args)
            if (!exec.agent) throw new HarnessError('session-unavailable', 'session-unavailable')
            const live = liveCaller(ctx, exec.agent.session.id, exec.agent)
            const value = inspectSessionCodec().parse(await service.inspectSession({ sessionId: live.session.id, ...(parsed.runId === undefined ? {} : { runId: parsed.runId }) }))
            return JSON.parse(JSON.stringify(value))
          }),
        })))
      } catch (error) { for (const remove of removers.reverse()) remove(); throw error }
      return () => { for (const remove of removers.reverse()) remove() }
    }, 'blueprint: native conversation tools')
  })
}
