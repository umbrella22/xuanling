/** Optional native Tools registrations. Caller identity is supplied by the
 * host execution carrier; it never appears in model-authored parameters. */
import { z } from 'zod'
import { candidateCodec, type AuthoringCandidate } from '../definition/authoring.ts'
import type { PreflightRunArgs, PreflightRunValue } from '../host/preflight.ts'
import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  inspectSessionCodec,
  runIdCodec,
  runAdmissionCodec,
  type InspectSessionArgs,
  type InspectSessionValue,
  type RunAdmissionView,
  type RunSource
} from './contracts.ts'
import { WORKFLOW_HOST_APPROVAL } from '../service/apply-service.ts'

export interface ConversationToolService {
  listDefinitions(): Promise<{ definitions: Array<{ blueprintId: string; name: string; documentRevision: string | null; semanticRevision: string | null }> }>
  inspectSession(args: InspectSessionArgs): Promise<InspectSessionValue>
  describeBlueprint(blueprintId?: string): Promise<unknown>
  validateBlueprint(candidate: AuthoringCandidate): Promise<unknown>
  createBlueprint(candidate: AuthoringCandidate, requestId: string, source: RunSource, signal?: AbortSignal): Promise<unknown>
  preflightRun(args: PreflightRunArgs): Promise<PreflightRunValue>
  workflowList(): Promise<unknown>
  workflowGet(args: { workflowId: string }): Promise<unknown>
  workflowValidate(args: { workflowId: string; definitionJson: string }): Promise<unknown>
  workflowPropose(args: {
    workflowId: string
    definitionJson: string
    expectedRevision?: string | null
    origin?: 'canvas' | 'conversation' | 'import'
    message?: string
  }): Promise<unknown>
  workflowApply(args: {
    workflowId: string
    definitionJson: string
    expectedRevision: string
    origin?: 'canvas' | 'conversation' | 'import'
    message?: string
  }): Promise<unknown>
  workflowApplyFromHost(args: {
    workflowId: string
    definitionJson: string
    expectedRevision: string
    origin?: 'canvas' | 'conversation' | 'import'
    message?: string
    approval: typeof WORKFLOW_HOST_APPROVAL
  }): Promise<unknown>
  workflowRevisions(args: { workflowId: string }): Promise<unknown>
  workflowRevert(args: { workflowId: string; revision: string; expectedRevision: string; message?: string }): Promise<unknown>
  workflowRevertFromHost(args: {
    workflowId: string
    revision: string
    expectedRevision: string
    message?: string
    approval: typeof WORKFLOW_HOST_APPROVAL
  }): Promise<unknown>
  workflowInspect(args: { runId: string; sessionId?: string }): Promise<unknown>
  workflowReport(args: { runId: string; sessionId?: string }): Promise<unknown>
  /** Optional: scope one tool call to the caller conversation's Workspace. */
  withSessionWorkspace?<T>(sessionId: string | undefined, action: () => Promise<T>, cwd?: string): Promise<T>
}
export interface ToolStartArgs {
  blueprintId: string
  expectedRevision: string
  inputJson: string
}

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
  const boundary = (
    ctx.get('sessionProjections') as
      | { stateOf(session: Session, key: 'turnBoundary'): { lastTurn: number; openTurnStartSeq: number | null } | undefined }
      | undefined
  )?.stateOf(agent.session, 'turnBoundary')
  return {
    sessionId: agent.session.id,
    kind: 'tool',
    callId: exec.callId,
    ...(boundary === undefined || boundary.openTurnStartSeq === null ? {} : { turn: boundary.lastTurn })
  }
}

const toolStartArgs = z.strictObject({ blueprintId: z.string().min(1), expectedRevision: z.string().min(1), input: z.json() })
const toolInspectArgs = z.strictObject({ runId: runIdCodec().optional() })
function strictToolArgs<T>(codec: z.ZodType<T>, args: unknown): T {
  const parsed = codec.safeParse(args)
  if (!parsed.success) throw new HarnessError('INVALID_ARGS', 'INVALID_ARGS')
  return parsed.data
}

const renderJson = (_args: unknown, value: unknown): [{ type: 'text'; text: string }] => [{ type: 'text', text: JSON.stringify(value) }]
export const TEAMSTAGE_ERROR_CODES = [
  'blueprint/team-unavailable',
  'blueprint/team-identity-unavailable',
  'blueprint/team-stage-conflict',
  'blueprint/team-task-conflict',
  'blueprint/team-output-rejected',
  'blueprint/durability-failed'
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
  try {
    return await operation()
  } catch (error) {
    const code = (error as { code?: unknown })?.code
    const allowed = [
      'blueprint/definition-deleted',
      'blueprint/library-state-invalid',
      'blueprint/library-busy',
      'blueprint/capability-unavailable',
      'blueprint/definition-write-failed',
      'blueprint/definition-commit-pending',
      'blueprint/approval-required',
      'session-unavailable',
      'nested-run-unavailable',
      'blueprint/definition-not-found',
      'blueprint/definition-invalid',
      'blueprint/revision-conflict',
      'blueprint/preflight-blocked',
      'blueprint/durability-failed',
      'blueprint/run-not-found',
      'blueprint/team-unavailable',
      'blueprint/team-identity-unavailable',
      'blueprint/team-stage-conflict',
      'blueprint/team-task-conflict',
      'blueprint/team-output-rejected',
      'COMMAND_CONFLICT',
      'gateway/bad-request',
      'INVALID_ARGS'
    ]
    const safe =
      typeof code === 'string' && allowed.includes(code)
        ? code
        : code === 'TEAM_STAGE_CONFLICT' ||
            code === 'TEAM_TASK_CONFLICT' ||
            code === 'TEAM_OUTPUT_REJECTED' ||
            code === 'TEAM_UNAVAILABLE' ||
            code === 'TEAM_IDENTITY_UNAVAILABLE' ||
            code === 'DURABILITY_FAILED' ||
            code === 'RUN_NOT_FOUND'
          ? mapTeamStageError(error)
          : 'blueprint/tool-failed'
    const hint = safe === 'blueprint/capability-unavailable' ? 'Configure workspaceRoot for workflow definitions or runtimeRoot for Run storage.' : undefined
    throw new HarnessError(hint ? `${safe}: ${hint}` : safe, safe)
  }
}

export function installConversationTools(
  ctx: Context,
  service: ConversationToolService,
  start: (args: ToolStartArgs, source: RunSource) => Promise<RunAdmissionView>
): void {
  // Do not await this child: absent Tools is a supported headless composition.
  ctx.inject(['tools'], scoped => {
    scoped.effect(() => {
      const removers: Array<() => void> = []
      try {
        // Approval belongs to this exact Host execution, never model JSON.
        // A monotonic guard also covers pre-execute handlers that short-circuit
        // this hook; the body consumes the registry token once.
        const grants = new Set<ToolRunContext['token']>()
        removers.push(() => grants.clear())
        const mutatesWorkflow = (name: string) => name === 'workflow_apply' || name === 'workflow_revert'
        const consumeApproval = (exec: ToolRunContext) => {
          if (!exec || !grants.delete(exec.token)) throw new HarnessError('Workflow requires Host approval', 'blueprint/approval-required')
          exec.signal.throwIfAborted()
        }
        removers.push(
          scoped.on('tools/pre-execute', async (exec, next) => {
            if (!mutatesWorkflow(exec.name)) return next()
            const approval = scoped.get('approval' as never) as unknown as
              | {
                  request(args: { agent: Agent; toolName: string; callId: ToolRunContext['callId']; reason: string; signal: AbortSignal }): Promise<string>
                }
              | undefined
            if (approval === undefined || exec.agent === undefined || exec.signal.aborted)
              return { kind: 'deny' as const, reason: 'Workflow Host approval unavailable' }
            let outcome: string
            try {
              outcome = await approval.request({
                agent: exec.agent,
                toolName: exec.name,
                callId: exec.callId,
                reason: 'Changing a canonical workflow requires approval.',
                signal: exec.signal
              })
            } catch {
              return { kind: 'deny' as const, reason: 'Workflow Host approval unavailable' }
            }
            if (outcome !== 'allowed-once' || exec.signal.aborted) return { kind: 'deny' as const, reason: 'Workflow Host approval was not granted' }
            grants.add(exec.token)
            return { kind: 'allow' as const }
          }),
          scoped.tools.guard(exec => (mutatesWorkflow(exec.name) && !grants.has(exec.token) ? 'Workflow requires Host approval' : undefined)),
          scoped.on('tools/result', exec => {
            grants.delete(exec.token)
          })
        )
        // Every conversation tool resolves definitions and Runs inside the
        // Workspace of the calling session, so switching projects in DSH
        // switches the workflow library with it.
        const register: typeof scoped.tools.register = tool => {
          const scope = service.withSessionWorkspace?.bind(service)
          if (scope === undefined) return scoped.tools.register(tool)
          const execute = tool.execute
          return scoped.tools.register({
            ...tool,
            execute: ((args: never, exec: ToolRunContext) =>
              scope(exec?.agent?.session?.id, async () => await execute(args, exec), exec?.agent?.session?.header?.cwd)) as typeof execute
          })
        }
        const jsonOutput = { schema: { type: 'json' as const }, render: renderJson }
        const candidateParameters = {
          definition: { type: 'json' as const, required: true as const },
          files: {
            type: 'array' as const,
            required: true as const,
            items: {
              type: 'object' as const,
              additionalProperties: false as const,
              properties: {
                path: { type: 'string' as const, required: true as const },
                text: { type: 'string' as const, required: true as const }
              }
            }
          }
        }
        removers.push(
          register(
            defineTool({
              name: 'blueprint_describe',
              description:
                'Read the current blueprint schema, executable node kinds, declared-resource creation example and available tool bindings. With blueprintId, read that saved graph, revision and input contract. Call this before creating or starting a blueprint.',
              parameters: { blueprintId: { type: 'string' } },
              output: jsonOutput,
              execute: args =>
                toolResult(async () =>
                  JSON.parse(
                    JSON.stringify(
                      await service.describeBlueprint(strictToolArgs(z.strictObject({ blueprintId: z.string().min(1).optional() }), args).blueprintId)
                    )
                  )
                )
            })
          )
        )
        removers.push(
          register(
            defineTool({
              name: 'blueprint_validate',
              description:
                'Validate a candidate definition and all its declared text resource files without saving or running. Returns safe issue codes and JSON pointers. Get the current schema and example with blueprint_describe.',
              parameters: candidateParameters,
              output: jsonOutput,
              execute: args => toolResult(async () => JSON.parse(JSON.stringify(await service.validateBlueprint(strictToolArgs(candidateCodec, args)))))
            })
          )
        )
        removers.push(
          register(
            defineTool({
              name: 'blueprint_create',
              description:
                'Save a complete new blueprint and its declared resource text files atomically. Does not run it. Use a stable requestId for retries; changing the payload requires a new requestId. Validate first, then preflight the returned ID/revision.',
              parameters: { ...candidateParameters, requestId: { type: 'string', required: true } },
              output: jsonOutput,
              execute: (args, exec) =>
                toolResult(async () => {
                  exec.signal.throwIfAborted()
                  const parsed = strictToolArgs(candidateCodec.extend({ requestId: z.string().min(1) }), args)
                  return JSON.parse(
                    JSON.stringify(
                      await service.createBlueprint(
                        { definition: parsed.definition, files: parsed.files },
                        parsed.requestId,
                        callerSource(ctx, exec),
                        exec.signal
                      )
                    )
                  )
                })
            })
          )
        )
        removers.push(
          register(
            defineTool({
              name: 'blueprint_preflight',
              description:
                'Read-only checks for a saved blueprint revision and JSON input. Returns blocking node/resource/tool checks. Fix blocks before blueprint_start; Host permissions and dynamic outputs are still checked at runtime.',
              parameters: {
                blueprintId: { type: 'string', required: true },
                expectedRevision: { type: 'string', required: true },
                input: { type: 'json', required: true }
              },
              output: jsonOutput,
              execute: args =>
                toolResult(async () => {
                  const parsed = strictToolArgs(toolStartArgs, args)
                  return JSON.parse(
                    JSON.stringify(
                      await service.preflightRun({
                        blueprintId: parsed.blueprintId,
                        expectedRevision: parsed.expectedRevision,
                        inputJson: JSON.stringify(parsed.input)
                      })
                    )
                  )
                })
            })
          )
        )
        removers.push(
          register(
            defineTool({
              name: 'blueprint_list',
              description: 'List configured blueprints and their current document revision for an explicit blueprint_start.',
              parameters: {},
              output: {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    definitions: {
                      type: 'array',
                      required: true,
                      items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          blueprintId: { type: 'string', required: true },
                          name: { type: 'string', required: true },
                          documentRevision: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true }
                        }
                      }
                    }
                  }
                },
                render: renderJson
              },
              execute: args =>
                toolResult(async () => {
                  strictToolArgs(z.strictObject({}), args)
                  return {
                    definitions: (await service.listDefinitions()).definitions.map(({ blueprintId, name, documentRevision }) => ({
                      blueprintId,
                      name,
                      documentRevision
                    }))
                  }
                })
            })
          )
        )
        removers.push(
          register(
            defineTool({
              name: 'blueprint_start',
              description:
                'Explicitly start a saved blueprint after blueprint_describe and blueprint_preflight. Use its current document revision and a JSON input value. Input never creates agents or nodes.',
              parameters: {
                blueprintId: { type: 'string', required: true },
                expectedRevision: { type: 'string', required: true },
                input: { type: 'json', required: true }
              },
              output: {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    runId: { type: 'string', required: true },
                    semanticRevision: { type: 'string', required: true },
                    state: { type: 'string', required: true },
                    replayed: { type: 'boolean', required: true }
                  }
                },
                render: renderJson
              },
              execute: (args, exec) =>
                toolResult(async () => {
                  exec.signal.throwIfAborted()
                  const parsed = strictToolArgs(toolStartArgs, args)
                  return runAdmissionCodec().parse(
                    await start(
                      { blueprintId: parsed.blueprintId, expectedRevision: parsed.expectedRevision, inputJson: JSON.stringify(parsed.input) },
                      callerSource(ctx, exec)
                    )
                  )
                })
            })
          )
        )
        removers.push(
          register(
            defineTool({
              name: 'blueprint_inspect',
              description: 'Read only the frozen blueprint Run associated with this conversation. Optionally select a Run belonging to this session.',
              parameters: { runId: { type: 'string' } },
              // The strict discriminated codec owns the public result, including all
              // nested whitelists. JSON preserves both bound/unbound branches.
              output: { schema: { type: 'json' }, render: renderJson },
              execute: (args, exec) =>
                toolResult(async () => {
                  const parsed = strictToolArgs(toolInspectArgs, args)
                  if (!exec.agent) throw new HarnessError('session-unavailable', 'session-unavailable')
                  const live = liveCaller(ctx, exec.agent.session.id, exec.agent)
                  const value = inspectSessionCodec().parse(
                    await service.inspectSession({ sessionId: live.session.id, ...(parsed.runId === undefined ? {} : { runId: parsed.runId }) })
                  )
                  return JSON.parse(JSON.stringify(value))
                })
            })
          )
        )
        const workflowProposeArgs = z.strictObject({
          workflowId: z.string().min(1),
          definition: z.json(),
          expectedRevision: z.string().min(1).nullable().optional(),
          origin: z.enum(['canvas', 'conversation', 'import']).optional(),
          message: z.string().min(1).optional()
        })
        const workflowApplyArgs = z.strictObject({
          workflowId: z.string().min(1),
          definition: z.json(),
          expectedRevision: z.string().min(1),
          origin: z.enum(['canvas', 'conversation', 'import']).optional(),
          message: z.string().min(1).optional()
        })
        removers.push(
          register(
            defineTool({
              name: 'workflow_list',
              description: 'List canonical workspace workflow definitions and their current document revisions.',
              parameters: {},
              output: jsonOutput,
              execute: args =>
                toolResult(async () => {
                  strictToolArgs(z.strictObject({}), args)
                  return JSON.parse(JSON.stringify(await service.workflowList()))
                })
            })
          )
        )
        removers.push(
          register(
            defineTool({
              name: 'workflow_get',
              description: 'Read one canonical workflow definition, including its document and semantic revisions.',
              parameters: { workflowId: { type: 'string', required: true } },
              output: jsonOutput,
              execute: args =>
                toolResult(async () =>
                  JSON.parse(JSON.stringify(await service.workflowGet(strictToolArgs(z.strictObject({ workflowId: z.string().min(1) }), args))))
                )
            })
          )
        )
        removers.push(
          register(
            defineTool({
              name: 'workflow_validate',
              description: 'Validate a complete workflow candidate without changing the canonical file.',
              parameters: { workflowId: { type: 'string', required: true }, definition: { type: 'json', required: true } },
              output: jsonOutput,
              execute: args =>
                toolResult(async () => {
                  const parsed = strictToolArgs(z.strictObject({ workflowId: z.string().min(1), definition: z.json() }), args)
                  return JSON.parse(
                    JSON.stringify(await service.workflowValidate({ workflowId: parsed.workflowId, definitionJson: JSON.stringify(parsed.definition) }))
                  )
                })
            })
          )
        )
        for (const [name, method, description] of [
          ['workflow_propose', 'workflowPropose', 'Propose a validated candidate and return semantic/layout diff and a candidate ID.'],
          ['workflow_apply', 'workflowApplyFromHost', 'Apply a candidate through the shared validation, host approval and required revision CAS authority.']
        ] as const) {
          removers.push(
            register(
              defineTool({
                name,
                description,
                parameters: {
                  workflowId: { type: 'string', required: true },
                  definition: { type: 'json', required: true },
                  expectedRevision: { type: 'string', ...(method === 'workflowApplyFromHost' ? { required: true as const } : {}) },
                  origin: { type: 'string' },
                  message: { type: 'string' }
                },
                output: jsonOutput,
                execute: (args, exec) =>
                  toolResult(async () => {
                    if (method === 'workflowApplyFromHost') consumeApproval(exec)
                    const parsed = strictToolArgs(method === 'workflowApplyFromHost' ? workflowApplyArgs : workflowProposeArgs, args)
                    return JSON.parse(
                      JSON.stringify(
                        await service[method]({
                          workflowId: parsed.workflowId,
                          definitionJson: JSON.stringify(parsed.definition),
                          ...(parsed.expectedRevision === undefined ? {} : { expectedRevision: parsed.expectedRevision }),
                          ...(parsed.origin === undefined ? {} : { origin: parsed.origin }),
                          ...(parsed.message === undefined ? {} : { message: parsed.message }),
                          ...(method === 'workflowApplyFromHost' ? { approval: WORKFLOW_HOST_APPROVAL } : {})
                        } as never)
                      )
                    )
                  })
              })
            )
          )
        }
        removers.push(
          register(
            defineTool({
              name: 'workflow_revisions',
              description: 'List immutable workflow apply history.',
              parameters: { workflowId: { type: 'string', required: true } },
              output: jsonOutput,
              execute: args =>
                toolResult(async () =>
                  JSON.parse(JSON.stringify(await service.workflowRevisions(strictToolArgs(z.strictObject({ workflowId: z.string().min(1) }), args))))
                )
            })
          )
        )
        removers.push(
          register(
            defineTool({
              name: 'workflow_revert',
              description: 'Create a new revision from an immutable historical workflow revision.',
              parameters: {
                workflowId: { type: 'string', required: true },
                revision: { type: 'string', required: true },
                expectedRevision: { type: 'string', required: true },
                message: { type: 'string' }
              },
              output: jsonOutput,
              execute: (args, exec) =>
                toolResult(async () => {
                  consumeApproval(exec)
                  const parsed = strictToolArgs(
                    z.strictObject({
                      workflowId: z.string().min(1),
                      revision: z.string().min(1),
                      expectedRevision: z.string().min(1),
                      message: z.string().optional()
                    }),
                    args
                  )
                  return JSON.parse(
                    JSON.stringify(
                      await service.workflowRevertFromHost({
                        workflowId: parsed.workflowId,
                        revision: parsed.revision,
                        expectedRevision: parsed.expectedRevision,
                        ...(parsed.message === undefined ? {} : { message: parsed.message }),
                        approval: WORKFLOW_HOST_APPROVAL
                      })
                    )
                  )
                })
            })
          )
        )
        removers.push(
          register(
            defineTool({
              name: 'workflow_run',
              description: 'Run a saved workflow after its revision and input have been preflighted.',
              parameters: {
                blueprintId: { type: 'string', required: true },
                expectedRevision: { type: 'string', required: true },
                input: { type: 'json', required: true }
              },
              output: jsonOutput,
              execute: (args, exec) =>
                toolResult(async () => {
                  exec.signal.throwIfAborted()
                  const parsed = strictToolArgs(toolStartArgs, args)
                  return runAdmissionCodec().parse(
                    await start(
                      { blueprintId: parsed.blueprintId, expectedRevision: parsed.expectedRevision, inputJson: JSON.stringify(parsed.input) },
                      callerSource(ctx, exec)
                    )
                  )
                })
            })
          )
        )
        for (const [name, method] of [
          ['workflow_inspect', 'workflowInspect'],
          ['workflow_report', 'workflowReport']
        ] as const) {
          removers.push(
            register(
              defineTool({
                name,
                description:
                  name === 'workflow_inspect'
                    ? 'Inspect a frozen workflow Run.'
                    : 'Report what a workflow Run did, which step failed, why, and what to change next time (codes plus fixed guidance; no raw evidence).',
                parameters: { runId: { type: 'string', required: true } },
                output: jsonOutput,
                execute: (args, exec) =>
                  toolResult(async () => {
                    const parsed = strictToolArgs(z.strictObject({ runId: runIdCodec() }), args)
                    if (!exec.agent) throw new HarnessError('session-unavailable', 'session-unavailable')
                    const live = liveCaller(ctx, exec.agent.session.id, exec.agent)
                    return JSON.parse(JSON.stringify(await service[method]({ ...parsed, sessionId: live.session.id })))
                  })
              })
            )
          )
        }
      } catch (error) {
        for (const remove of removers.reverse()) remove()
        throw error
      }
      return () => {
        for (const remove of removers.reverse()) remove()
      }
    }, 'blueprint: native conversation tools')
  })
}
