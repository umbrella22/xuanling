// Operator actions only. Acceptance comes from public Host/Session observations
// and native DOM in the collector, never from values fabricated by this module.
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, isAbsolute, resolve } from 'node:path'
import { ensure, assertPhysicalPath } from './conversation-evidence.mjs'
import { KEYLESS_SEED_TEXT, APPROVAL_FILE_CONTENT } from './conversation-runtime.mjs'

export const BLUEPRINT_ID = 'conversation-fixture'
const PREFIX = 'conversation-fixture-'

// Serialized into an isolated operator module. These are ordinary public
// policy seams: no Session append, Agent factory, LLM stream, or UI substitution.
export function installFixturePolicies(ctx, mode) {
  if (mode === 'keyless') ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    return agent.id.startsWith('conversation-fixture-') ? { kind: 'reject' } : decision
  }, { prepend: true })
  if (mode === 'live') ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next()
    if (decision.kind !== 'allow' || exec.name !== 'write'
      || !exec.agent?.id.startsWith('conversation-fixture-source-')
      || exec.arguments.file_path !== 'native-approval.txt') return decision
    return { kind: 'ask', reason: 'Explicit isolated conversation fixture file write',
      displayReason: { en: 'Allow the isolated fixture file write once.', zh: '允许隔离场景文件写入一次。' } }
  }, { prepend: true })
}
export async function prepare({ root, mode }) {
  ensure(['keyless', 'live'].includes(mode), 'FIXTURE_MODE_INVALID')
  ensure(isAbsolute(root) && resolve(root) === root, 'FIXTURE_ROOT_INVALID'); assertPhysicalPath(root)
  const dir = join(root, 'conversation-blueprint')
  mkdirSync(dir, { mode: 0o700 }) // exclusive: never overwrite another scene
  const graph = mode === 'keyless' ? {
    nodes: [{ id: 'input', kind: 'input' }, { id: 'review', kind: 'humanDecision' },
      { id: 'approved', kind: 'output' }, { id: 'rejected', kind: 'output' }],
    edges: [{ kind: 'control', from: 'input', to: 'review' },
      { kind: 'control', from: 'review@approve', to: 'approved' }, { kind: 'control', from: 'review@reject', to: 'rejected' }],
  } : {
    nodes: [{ id: 'model', kind: 'agentTask', agentRef: 'worker', outputSchemaRef: 'answer', outputs: { payload: 'json' } },
      { id: 'downstream', kind: 'output', inputs: { payload: 'json' }, outputs: { payload: 'json' } }],
    edges: [{ kind: 'data', from: 'model.payload', to: 'downstream.payload' }],
  }
  const resources = {}
  if (mode === 'live') {
    mkdirSync(join(dir, 'agents'), { mode: 0o700 }); mkdirSync(join(dir, 'schema'), { mode: 0o700 })
    writeFileSync(join(dir, 'agents/worker.md'), 'Call structured_output exactly once with {"nonce": <the exact nonce from input JSON>}. Do not answer with plain text. Do not add properties or call other tools.\n', { mode: 0o600 })
    writeFileSync(join(dir, 'schema/answer.json'), JSON.stringify({ type: 'object', additionalProperties: false,
      required: ['nonce'], properties: { nonce: { type: 'string' } } }), { mode: 0o600 })
    Object.assign(resources, { worker: { kind: 'agent', path: 'agents/worker.md' }, answer: { kind: 'schema', path: 'schema/answer.json' } })
  }
  writeFileSync(join(dir, 'blueprint.json'), JSON.stringify({ schemaVersion: 1, id: BLUEPRINT_ID,
    name: 'Isolated native conversation fixture', resources, graph }), { mode: 0o600 })
  const operator = join(root, 'conversation-fixture-policy.mjs')
  writeFileSync(operator, `export const inject=['agents','tools'];\nconst installFixturePolicies=${installFixturePolicies.toString()};\nexport function apply(ctx){installFixturePolicies(ctx,${JSON.stringify(mode)})}\n`, { flag: 'wx', mode: 0o600 })
  return { blueprints: { [BLUEPRINT_ID]: dir }, operatorModules: [operator] }
}
export async function waitForFixture(read, predicate, code, { now = Date.now, pause = ms => new Promise(done => setTimeout(done, ms)) } = {}) {
  const deadline = now() + 30000
  while (now() < deadline) {
    const value = await read()
    if (now() < deadline && predicate(value)) return value
    await pause(Math.min(50, Math.max(0, deadline - now())))
  }
  ensure(false, code)
}
async function prompt(gateway, sessionId, text) {
  const value = await gateway.call('session/prompt', { request: { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text }] } })
  ensure(value?.accepted === true, 'FIXTURE_PROMPT_NOT_ACCEPTED')
}
async function idle(gateway, sessionId) {
  return waitForFixture(() => gateway.call('session/list', { _request: {} }), value => value?.items?.some(item => item.sessionId === sessionId && !item.running && !item.blank), 'FIXTURE_SESSION_NOT_IDLE')
}
async function openWorkspaceSession(page, sessionId) {
  // First-run acknowledgement is a native action, including on a new Host origin.
  const preview = page.getByRole('dialog', { name: /^(?:预览版说明|Preview Notice)$/ })
  if (await preview.isVisible()) {
    await preview.getByRole('button', { name: /^(?:继续|Continue)$/ }).click()
    await preview.waitFor({ state: 'hidden', timeout: 15000 })
  }
  // Fixture-created ordinary Sessions have no workspace assignment; their
  // parent bucket is exactly UNGROUPED_KEY='', not every workspace in the tree.
  const workspace = page.locator('[data-row-key="workspace:"][role="treeitem"]')
  try { await workspace.waitFor({ state: 'visible', timeout: 15000 }) }
  catch { ensure(false, 'FIXTURE_NATIVE_WORKSPACE_ROW_MISSING') }
  ensure(await workspace.count() === 1, 'FIXTURE_NATIVE_WORKSPACE_ROW_MISSING')
  if (await workspace.getAttribute('aria-expanded') === 'false') await workspace.click()
  // Actual DSH sidebar row and its native onOpen handler. No client store access.
  const row = page.locator(`[data-row-key="session:${sessionId}"][role="treeitem"]`)
  try { await row.waitFor({ state: 'visible', timeout: 15000 }) }
  catch { ensure(false, 'FIXTURE_NATIVE_SESSION_ROW_MISSING') }
  ensure(await row.count() === 1, 'FIXTURE_NATIVE_SESSION_ROW_MISSING')
  await row.click()
  ensure(await row.getAttribute('aria-selected') === 'true', 'FIXTURE_NATIVE_SESSION_NOT_SELECTED')
}
export async function openSession({ page, sessionId, gateway }) {
  ensure(typeof sessionId === 'string' && /^[A-Za-z0-9_-]+$/.test(sessionId), 'FIXTURE_SESSION_ID_INVALID')
  ensure(typeof gateway?.call === 'function', 'FIXTURE_GATEWAY_REQUIRED')
  const listed = await gateway.call('session/list', { _request: {} })
  const item = listed.items.find(session => session.sessionId === sessionId)
  ensure(item, 'FIXTURE_NATIVE_SESSION_ROW_MISSING')
  if (item.origin !== 'subagent') return openWorkspaceSession(page, sessionId)

  const parentId = item.parentSessionId, parent = listed.items.find(session => session.sessionId === parentId)
  ensure(typeof parentId === 'string' && /^[A-Za-z0-9_-]+$/.test(parentId) && parent && parent.origin !== 'subagent',
    'FIXTURE_EXECUTION_SESSION_NATIVE_NAVIGATION_UNAVAILABLE')
  // Read fresh public projections, not possibly stale session/list hints.
  const catalog = await gateway.call('session/projections', { request: { sessionId: parentId } })
  const own = await gateway.call('session/projections', { request: { sessionId } })
  const matches = catalog?.values?.subagentCatalog?.filter(entry => entry.id === sessionId), entry = matches?.[0]
  ensure(matches?.length === 1 && ['one-shot', 'continuable'].includes(entry.mode)
    && own?.values?.subagent?.mode === entry.mode, 'FIXTURE_EXECUTION_SESSION_NATIVE_NAVIGATION_UNAVAILABLE')
  const label = entry.label ?? entry.id
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  await openWorkspaceSession(page, parentId)
  const header = page.locator('header[data-window-drag]'), trigger = header.locator('button[aria-haspopup="tree"]')
  await trigger.waitFor({ state: 'visible', timeout: 15000 })
  ensure(await trigger.count() === 1, 'FIXTURE_NATIVE_CHILD_CATALOG_MISSING')
  await trigger.click()
  ensure(await trigger.getAttribute('aria-expanded') === 'true', 'FIXTURE_NATIVE_CHILD_CATALOG_MISSING')
  // DSH portals this native tree to document.body. Click the main treeitem,
  // whose handler owns the durable child address, rather than its aside button.
  const tree = page.getByRole('tree', { name: /^(?:Subagent sessions|子智能体会话)$/ })
  await tree.waitFor({ state: 'visible', timeout: 15000 })
  const row = tree.getByRole('treeitem', { name: new RegExp(`^${escaped}(?:\\s|$)`) })
  if (await row.count() === 0) await row.waitFor({ state: 'visible', timeout: 15000 })
  ensure(await row.count() === 1, 'FIXTURE_NATIVE_CHILD_CATALOG_ROW_MISSING')
  await row.click()
  await tree.waitFor({ state: 'hidden', timeout: 15000 })
  const selected = header.getByRole('button', { name: new RegExp(`^(?:Switch subagent: |切换子智能体：)${escaped}$`) })
  await selected.waitFor({ state: 'visible', timeout: 15000 })
  ensure(await selected.count() === 1, 'FIXTURE_NATIVE_CHILD_NOT_SELECTED')
}
export async function arrange({ page, gateway, root, mode }) {
  ensure(['keyless', 'live'].includes(mode), 'FIXTURE_MODE_INVALID')
  assertPhysicalPath(root)
  const cwd = join(root, 'cwd'), definitionPath = join(root, 'conversation-blueprint/blueprint.json')
  // DSH's public startup seam owns the default ungrouped Workspace. Prepare it
  // before creating ordinary Sessions so the native sidebar can account for
  // those Sessions during its first navigation.
  await gateway.call('workspace/initializeDefault', {})
  const create = async kind => {
    const requestedId = `${PREFIX}${kind}-${randomUUID()}`
    const value = await gateway.call('session/create', { request: { sessionId: requestedId, cwd, agentPreset: 'standard' } })
    ensure(value?.sessionId === requestedId, 'FIXTURE_SESSION_CREATE_MISMATCH')
    return requestedId
  }
  const sessionId = await create('source'), plainSessionId = await create('plain')
  // Source and plain are genuinely nonblank: keyless AgentLoop is policy-blocked
  // before its model request, live plain uses an ordinary short provider turn.
  await prompt(gateway, plainSessionId, mode === 'keyless' ? KEYLESS_SEED_TEXT : 'Reply with exactly: ordinary conversation. Do not call any tools.')
  await idle(gateway, plainSessionId)
  if (mode === 'keyless') {
    await prompt(gateway, sessionId, KEYLESS_SEED_TEXT); await idle(gateway, sessionId)
    const definition = await gateway.call('blueprint/loadDefinition', { args: { blueprintId: BLUEPRINT_ID } })
    const value = await gateway.call('blueprint/startSessionRun', { args: { blueprintId: BLUEPRINT_ID,
      sessionId, requestId: randomUUID(), expectedRevision: definition.documentRevision, inputJson: '{}' } })
    ensure(value?.runId && value.replayed === false, 'FIXTURE_RUN_ADMISSION_FAILED')
    await waitForFixture(() => gateway.call('blueprint/inspectSession', { args: { sessionId } }), value =>
      value?.status === 'bound' && value.selected.run.state === 'waiting_input'
      && value.selected.source?.kind === 'ui' && value.selected.source.sessionId === sessionId
      && value.selected.focusAttemptIds.length > 0, 'FIXTURE_WAITING_RUN_NOT_READY')
    await openSession({ page, sessionId, gateway })
    return { sessionId, plainSessionId, blueprintId: BLUEPRINT_ID, definitionPath }
  }
  const nonce = `conversation-nonce-${randomUUID()}`, inputJson = JSON.stringify({ nonce })
  await prompt(gateway, sessionId, `Use the native blueprint_list tool, then blueprint_start exactly once for blueprintId ${BLUEPRINT_ID}, using the documentRevision returned by the list and this exact inputJson: ${inputJson}. Do not invent the revision or source/call/session identities. Then call blueprint_inspect with the returned runId. Finish with a short acknowledgement; no other tools.`)
  const bound = await waitForFixture(() => gateway.call('blueprint/inspectSession', { args: { sessionId } }), value => {
    if (value?.status !== 'bound') return false
    ensure(!['failed', 'cancelled', 'timed_out', 'recovery_required'].includes(value.selected.run.state), 'FIXTURE_CHILD_EXECUTION_FAILED')
    return value.selected.source?.kind === 'tool' && value.selected.source.sessionId === sessionId
      && value.selected.run.state === 'succeeded'
  }, 'FIXTURE_NATIVE_RUN_NOT_READY')
  await idle(gateway, sessionId)
  const model = bound.selected.run.attempts.find(item => item.nodeId === 'model'), downstream = bound.selected.run.attempts.find(item => item.nodeId === 'downstream')
  ensure(model?.sessionId && model.state === 'succeeded' && downstream?.state === 'succeeded', 'FIXTURE_CHILD_ATTEMPT_MISSING')
  const payload = attempt => { try { return JSON.parse(attempt.outputJson)?.outputs?.payload } catch { return null } }
  ensure(payload(model)?.nonce === nonce && payload(downstream)?.nonce === nonce, 'FIXTURE_CHILD_ARTIFACT_MISMATCH')
  await openSession({ page, sessionId, gateway })
  return { sessionId, plainSessionId, blueprintId: BLUEPRINT_ID, definitionPath, executionSessionId: model.sessionId, streamSessionId: sessionId, inputJson }
}
export async function startStreaming({ page, gateway, scene }) {
  ensure(scene.executionSessionId, 'FIXTURE_LIVE_SCENE_REQUIRED')
  await idle(gateway, scene.sessionId); await openSession({ page, sessionId: scene.sessionId, gateway })
  await prompt(gateway, scene.sessionId, 'Do not call tools. Begin output immediately with line 1 and continue with 200 numbered lines in the exact form "streaming fixture line N" until the response token budget is exhausted. Do not plan, explain, or ask for confirmation before line 1.')
  return { sessionId: scene.sessionId }
}
export async function startApproval({ page, gateway, scene }) {
  ensure(scene.executionSessionId, 'FIXTURE_LIVE_SCENE_REQUIRED')
  // Finish the real stream naturally. Never cancel it or manufacture delays.
  await idle(gateway, scene.sessionId); await openSession({ page, sessionId: scene.sessionId, gateway })
  await prompt(gateway, scene.sessionId, `Call the native write tool exactly once with these exact JSON arguments: ${JSON.stringify({ file_path: 'native-approval.txt', content: APPROVAL_FILE_CONTENT })}. This is an explicit file-write request. Do not use bash, edit, or other tools. Wait for the native approval result and then give a short acknowledgement.`)
  return { sessionId: scene.sessionId }
}
