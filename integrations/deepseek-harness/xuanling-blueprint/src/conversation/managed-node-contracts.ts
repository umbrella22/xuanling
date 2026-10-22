import { z } from 'zod'
import { runIdCodec } from './contracts.ts'
import type {} from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'blueprint/node-not-active': Record<string, never>
    'blueprint/node-session-unavailable': Record<string, never>
    'blueprint/command-conflict': Record<string, never>
    'blueprint/node-message-unknown': Record<string, never>
  }
}

const id = () => z.string().min(1)
export const nodeMessageArgsCodec = () =>
  z.strictObject({
    runId: runIdCodec(),
    attemptId: id(),
    sessionId: id(),
    requestId: id(),
    delivery: z.enum(['queue', 'steer']),
    text: z.string().refine(value => value.trim().length > 0)
  })
export type NodeMessageArgs = z.infer<ReturnType<typeof nodeMessageArgsCodec>>
export const nodeMessageReceiptCodec = () =>
  z.strictObject({
    runId: runIdCodec(),
    attemptId: id(),
    sessionId: id(),
    requestId: id(),
    messageId: id(),
    replayed: z.boolean()
  })
export type NodeMessageReceipt = z.infer<ReturnType<typeof nodeMessageReceiptCodec>>
export const nodeSessionArgsCodec = () => z.strictObject({ sessionId: id() })
export const nodeSessionCodec = () =>
  z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('unmanaged') }),
    z.strictObject({
      status: z.literal('managed'),
      runId: runIdCodec(),
      attemptId: id(),
      nodeId: id(),
      sessionId: id(),
      state: z.enum(['active', 'waiting_input', 'closed']),
      canMessage: z.boolean()
    })
  ])
export type NodeSessionView = z.infer<ReturnType<typeof nodeSessionCodec>>
