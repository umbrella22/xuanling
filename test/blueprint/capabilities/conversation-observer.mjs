// Read-only public Host observer. No model/Agent factory/stream substitution.
// Runtime materializes this SMALL module with the installed public LLM import.
export function createConversationObserver(ctx, { isAgentLoopRequest, flush, hash, clock = () => new Date().toISOString() }) {
  const records = new WeakMap(), bySession = new Map(), sessions = []
  const publish = () => flush({ provenance: 'public DSH observer', at: clock(), sessions: sessions.map(item => structuredClone(item)) })
  ctx.on('agent/created', ({ agent }) => {
    const facts = { sessionId: agent.id, requests: [], approvals: [], toolCalls: [], runtimeError: false, disposed: false }
    records.set(agent, facts); bySession.set(agent.id, facts); sessions.push(facts); publish()
  })
  ctx.on('session/event', (session, event) => {
    const facts = bySession.get(session.id)
    if (!facts) return
    if (event.type === 'approval/asked') facts.approvals.push({ auditId: event.data.id, callId: event.data.callId,
      pending: true, outcome: null, askedSeq: event.seq, decidedSeq: null, decidedLogged: false })
    if (event.type === 'approval/decided') {
      const approval = facts.approvals.find(item => item.auditId === event.data.id)
      if (approval) { approval.outcome = event.data.outcome; approval.pending = false; approval.decidedSeq = event.seq; approval.decidedLogged = true }
    }
    let inputJson
    if (event.type === 'tool/call' && event.data.name === 'blueprint_start') {
      try { inputJson = JSON.stringify(JSON.parse(event.data.arguments).input) } catch { /* invalid arguments have no input authority */ }
    }
    if (event.type === 'tool/call' && ['blueprint_describe', 'blueprint_validate', 'blueprint_create', 'blueprint_preflight', 'blueprint_start', 'blueprint_list', 'blueprint_inspect', 'write'].includes(event.data.name))
      facts.toolCalls.push({ name: event.data.name, callId: event.data.callId, turn: event.data.turn, callSeq: event.seq, resultSeq: null,
        callLogged: true, resultLogged: false, ok: false,
        ...(hash && typeof inputJson === 'string' ? { inputSha256: hash(inputJson) } : {}) })
    if (event.type === 'tool/result') {
      // Public ToolResultMessage carries toolCallId and a tool source, not a
      // top-level callId. Both identities must agree before linking a result.
      const message = event.data.message
      const call = message.role === 'tool' && message.source?.kind === 'tool' && message.source.callId === message.toolCallId
        ? facts.toolCalls.findLast(item => item.callId === message.toolCallId) : undefined
      if (call) { call.isError = message.isError; call.ok = message.isError === false; call.resultLogged = true; call.resultSeq = event.seq }
    }
    if (['approval/asked', 'approval/decided', 'tool/call', 'tool/result'].includes(event.type)) publish()
  })
  const frames = new WeakMap()
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (frame.type === 'start') frames.set(agent, { attemptId: frame.attemptId, turn: frame.turn, step: frame.step })
  })
  ctx.on('llm/stream', async function* (options, next) {
    const agent = ctx.get('agents')?.currentInitiator(), facts = agent && records.get(agent)
    const marked = facts && isAgentLoopRequest(options) && options.sessionId === agent.id
    // Counts every adapter dispatch, even retries. No inspectSession poll enters here.
    const frame = agent && frames.get(agent)
    const request = marked ? { identity: frame?.attemptId ?? null, turn: frame?.turn ?? null, step: frame?.step ?? null, ordinal: facts.requests.length + 1,
      startedAt: clock(), active: true, textDeltas: 0, failed: false } : undefined
    if (request) { facts.requests.push(request); publish() }
    try {
      for await (const chunk of next()) {
        if (request && chunk.type === 'text-delta' && chunk.text?.length) { request.textDeltas++; publish() }
        yield chunk
      }
    } catch (error) { if (request) request.failed = true; throw error }
    finally { if (request) { request.active = false; request.finishedAt = clock(); publish() } }
  }, { prepend: true })
  ctx.on('approval/request', async (request, next) => {
    const facts = records.get(request.agent)
    const record = facts?.approvals.findLast(item => item.pending && item.callId === request.callId)
    if (record) publish()
    try { const outcome = await next(); if (record) record.outcome = outcome; return outcome }
    finally { if (record) { record.pending = false; publish() } }
  }, { prepend: true })
  ctx.on('tools/result', (exec, result) => {
    const facts = records.get(exec.agent)
    if (facts && ['blueprint_describe', 'blueprint_validate', 'blueprint_create', 'blueprint_preflight', 'blueprint_start', 'blueprint_list', 'blueprint_inspect', 'write'].includes(exec.name)) {
      const call = facts.toolCalls.findLast(item => item.callId === exec.callId && item.name === exec.name)
      if (call) { call.pipelineIsError = result.isError; call.pipelineResultObserved = result.isError === false }
      publish()
    }
  })
  ctx.on('agent/error', ({ agent }) => { const facts = records.get(agent); if (facts) { facts.runtimeError = true; publish() } })
  ctx.on('agent/disposed', ({ agent }) => { const facts = records.get(agent); if (facts) { facts.disposed = true; publish() } })
  publish()
}

export function observerSource(publicLlmEntry) {
  return `import {writeFileSync,renameSync} from 'node:fs';\nimport {createHash} from 'node:crypto';\nimport {isAgentLoopRequest} from ${JSON.stringify(publicLlmEntry)};\nexport const inject=['agents','llm'];\nconst createConversationObserver=${createConversationObserver.toString()};\nexport function apply(ctx){createConversationObserver(ctx,{isAgentLoopRequest,hash:value=>createHash('sha256').update(value).digest('hex'),flush:facts=>{const path=process.env.BP_CONVERSATION_OBSERVER_FILE;writeFileSync(path+'.next',JSON.stringify(facts),{mode:0o600});renameSync(path+'.next',path)}})}\n`
}
