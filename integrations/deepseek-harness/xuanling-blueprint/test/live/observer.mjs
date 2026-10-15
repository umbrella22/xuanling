// Operator-owned read-only observer: public Cordis events and public LLM API.
// Never replaces an Agent factory, request, response, stream, or settlement.
import { writeFileSync } from 'node:fs'
import { isAgentLoopRequest } from '@deepseek-ai/dsh-llm'

export const inject = ['agents', 'llm']

export function apply(ctx) {
  const sessions = new Map()
  const flush = () => writeFileSync(process.env.BP_LIVE_OBSERVER_FILE, JSON.stringify({ sessions: [...sessions.values()] }), { mode: 0o600 })
  const record = agent => sessions.get(agent.id)
  ctx.on('agent/created', ({ agent }) => {
    if (!agent.id.startsWith('bp-')) return
    sessions.set(agent.id, {
      sessionId: agent.id,
      agentCreated: true,
      inboxSeen: false,
      scopedAgentSeen: false,
      requestSeen: false,
      requestAborted: false,
      loopRequestSeen: false,
      responseSeen: false,
      completed: false,
      disposed: false
    })
    flush()
  })
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    const item = record(agent)
    if (!item) return
    item.inboxSeen = true
    item.scopedAgentSeen ||= message.content.some(block => block.type === 'text' && block.text.startsWith('[blueprint agent]'))
    flush()
  })
  ctx.on('agent/error', ({ agent, error }) => {
    const item = record(agent)
    if (!item) return
    // Match only known public runtime boundary diagnostics; do not archive text.
    item.runtimeFailure = /has no provider\/model/.test(error?.message ?? '')
      ? 'MODEL_ROUTE_MISSING'
      : /prompt variable.*model.*has no value for this assembly/.test(error?.message ?? '')
        ? 'PROMPT_MODEL_MISSING'
        : 'OTHER_RUNTIME_ERROR'
    flush()
  })
  ctx.on('agent/request', async ({ agent, signal }, next) => {
    const item = record(agent)
    if (item) {
      item.requestSeen = true
      // `agent/request` is the public AgentLoop admission boundary. The
      // `isAgentLoopRequest()` marker is process-local, so a pnpm profile can
      // legitimately resolve another dsh-llm instance for the observer even
      // when the runtime itself is using the reviewed DSH tuple. Keep the
      // public event as the authoritative loop fact and use the marker as an
      // additive stream check below.
      item.loopRequestSeen = true
      const aborted = () => {
        item.requestAborted = true
        flush()
      }
      if (signal.aborted) aborted()
      else signal.addEventListener('abort', aborted, { once: true })
      flush()
    }
    return await next()
  })
  ctx.on('agent/request-error', async ({ agent, failure }, next) => {
    const item = record(agent)
    if (item) {
      const codes = [
        'MISSING_CREDENTIAL',
        'INVALID_CREDENTIAL',
        'HTTP_401',
        'HTTP_403',
        'HTTP_404',
        'HTTP_429',
        'HTTP_500',
        'HTTP_502',
        'HTTP_503',
        'HTTP_504',
        'AUTHENTICATION',
        'AUTHENTICATION_FAILED',
        'INVALID_REQUEST',
        'MODEL_NOT_FOUND',
        'RATE_LIMIT',
        'NETWORK',
        'PROVIDER_ERROR',
        'UNKNOWN',
        'ABORTED'
      ]
      item.failureCode = codes.includes(failure?.code) ? failure.code : 'OTHER_TYPED_FAILURE'
      item.failureStatus = Number.isInteger(failure?.httpStatus) && failure.httpStatus >= 100 && failure.httpStatus <= 599 ? failure.httpStatus : null
      flush()
    }
    return await next()
  })
  ctx.on('llm/stream', async function* (options, next) {
    // Only attribute AgentLoop-marked calls to the current public initiator.
    const agent = ctx.get('agents')?.currentInitiator()
    const item = agent && record(agent)
    if (item && (isAgentLoopRequest(options) || item.requestSeen)) {
      item.loopRequestSeen = true
      flush()
    }
    for await (const chunk of next()) {
      if (item && item.loopRequestSeen && chunk.type === 'text-delta' && chunk.text.length > 0) {
        item.responseSeen = true
        flush()
      }
      yield chunk
    }
  })
  ctx.on('agent/disposed', ({ agent }) => {
    const item = record(agent)
    if (!item) return
    const events = agent.session.snapshotEvents()
    item.completed = events.some(event => event.type === 'turn/end' && event.data.reason?.kind === 'completed')
    item.disposed = true
    flush()
  })
  flush()
}
