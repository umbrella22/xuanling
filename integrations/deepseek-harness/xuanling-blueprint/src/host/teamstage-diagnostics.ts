/** Content-free TeamStage facts shared by durable records and browser DTOs. */
import { z } from 'zod'

const timestamp = () => z.number().int().nonnegative()
const count = () => z.number().int().nonnegative()
export const teamStageExecutionCodec = () =>
  z
    .strictObject({
      startedAt: timestamp(),
      deadlineAt: timestamp().optional(),
      timeoutMs: z.number().int().positive().optional(),
      abort: z
        .strictObject({
          source: z.enum(['deadline', 'caller', 'stage_control']),
          code: z.enum([
            'teamstage-deadline-exceeded',
            'teamstage-cancelled',
            'teamstage-team-effect-unknown',
            'teamstage-not-dispatching',
            'teamstage-aborted'
          ]),
          occurredAt: timestamp()
        })
        .optional()
    })
    .refine(
      value =>
        (value.deadlineAt === undefined) === (value.timeoutMs === undefined) &&
        (value.deadlineAt === undefined || value.deadlineAt === value.startedAt + value.timeoutMs!) &&
        (value.abort === undefined || value.abort.occurredAt >= value.startedAt) &&
        (value.abort === undefined ||
          (value.abort.source === 'deadline' && value.deadlineAt !== undefined && value.abort.code === 'teamstage-deadline-exceeded') ||
          (value.abort.source === 'caller' && value.abort.code === 'teamstage-cancelled') ||
          (value.abort.source === 'stage_control' &&
            ['teamstage-team-effect-unknown', 'teamstage-not-dispatching', 'teamstage-aborted'].includes(value.abort.code))),
      'execution timing and abort source must match'
    )
export type TeamStageExecution = z.infer<ReturnType<typeof teamStageExecutionCodec>>

export const teamStageRuntimeCodec = () =>
  z.strictObject({
    attemptId: z.string().min(1),
    observedAt: timestamp(),
    members: z.array(
      z.strictObject({
        memberId: z.string().min(1),
        sessionId: z.string().min(1),
        activity: z.enum(['waiting_model', 'thinking', 'responding', 'tool_call', 'executing_tool', 'idle']),
        updatedAt: timestamp(),
        requestOrdinal: count(),
        requestStartedAt: timestamp().optional(),
        lastProgressAt: timestamp().optional(),
        textDeltas: count(),
        reasoningDeltas: count(),
        toolCallDeltas: count()
      })
    )
  })
export type TeamStageRuntime = z.infer<ReturnType<typeof teamStageRuntimeCodec>>
