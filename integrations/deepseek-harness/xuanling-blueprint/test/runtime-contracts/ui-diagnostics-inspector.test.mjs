/** C-04/C-07/C-08/C-10 source/component oracles; real UI is a separate collector. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { BlueprintClientModel } from '../../src/client/features/authoring/logic/run/client-model.ts'
import { resolveBlueprintHost } from '../../src/client/adapters/host/remote.ts'
import { renderAttemptDiagnostics, projectAttemptDiagnostics } from '../../src/client/shared/diagnostics/diagnostics.ts'
import { GraphEditor } from '../../src/client/features/authoring/logic/graph/graph-editor.ts'
import { InspectorSession, renderNodeInspector, parseInspectorJson } from '../../src/client/features/authoring/ui/inspector/inspector-composition.tsx'
import { BUILTIN_NODE_CATALOG, searchBuiltinNodes } from '../../src/client/features/authoring/logic/graph/node-catalog.ts'
import { en, zh } from '../../src/client/shared/i18n/locales.ts'
const t =
  dict =>
  (key, params = {}) =>
    dict[key].replace(/\{([^}]+)\}/g, (_, p) => String(params[p]))
const digest = 'a'.repeat(64)
const diagnostics = () => ({
  status: 'available',
  input: { type: 'object', bytes: 28, sha256: digest },
  resourceDigests: { '资源.ID': digest },
  modelSelection: { provider: 'fixture-provider', model: 'fixture-model', reasoningEffort: 'adapter-owned-effort' },
  tools: { effectiveNames: ['用户.tool'], denials: [{ toolName: 'blocked.tool', code: 'tool-not-permitted' }] },
  acceptance: { code: 'output-invalid', issueCount: 2 },
  recovery: { code: 'unknown-external-effect' }
})
const snapshot = value => ({
  runId: 'run',
  state: 'failed',
  seq: 2,
  definitionRevision: 'semantic',
  attempts: [{ nodeId: '用户.node', state: 'failed', attempt: 1, ...(value === undefined ? {} : { diagnostics: value }) }],
  logTail: [{ seq: 2, kind: 'state' }]
})
function treeChildren(tree) {
  return Array.isArray(tree) ? tree.flatMap(treeChildren) : tree && typeof tree === 'object' && tree.props ? [tree, ...treeChildren(tree.props.children)] : []
}
const field = (tree, name) => treeChildren(tree).find(node => node.props['data-bp-field'] === name)
function editorFixture() {
  return GraphEditor.fromDefinition({
    schemaVersion: 1,
    id: 'fixture',
    name: '用户.标题',
    resources: {},
    graph: {
      nodes: [
        {
          id: 'user-condition',
          kind: 'condition',
          inputs: { '用户.boolean': 'boolean' },
          branches: ['true-path', 'false-path'],
          condition: { inputPort: '用户.boolean', trueBranch: 'true-path', falseBranch: 'false-path' }
        },
        { id: 'user-join', kind: 'join' },
        { id: 'user-agent', kind: 'agentTask', agentRef: 'user-agent-ref', toolAllowlist: [], outputSchemaRef: 'user-schema-ref' }
      ],
      edges: []
    },
    presentation: { nodes: {} }
  })
}
test('C-04/C-07 diagnostics renderer consumes every allowed durable fact and legacy is unavailable', () => {
  const value = diagnostics()
  for (const dict of [zh, en]) {
    const html = renderToStaticMarkup(renderAttemptDiagnostics(value, t(dict)))
    for (const text of [
      digest,
      '资源.ID',
      'fixture-provider',
      'fixture-model',
      'adapter-owned-effort',
      '用户.tool',
      'blocked.tool',
      'tool-not-permitted',
      'output-invalid',
      'unknown-external-effect'
    ])
      assert.ok(html.includes(text), text)
    for (const key of ['input', 'resources', 'model', 'tools', 'denials', 'acceptance', 'recovery']) assert.ok(html.includes(`data-bp-diagnostic="${key}"`))
    const legacy = renderToStaticMarkup(renderAttemptDiagnostics(undefined, t(dict)))
    assert.ok(legacy.includes('data-bp-diagnostics="unavailable"'))
    assert.ok(legacy.includes(dict['diagnostics.unavailable']))
    assert.equal(legacy.includes('fixture-model'), false)
  }
  assert.deepEqual(projectAttemptDiagnostics(undefined), { status: 'unavailable' })
})
test('C-07 diagnostic raw-field rejection at remote/model and renderer fallback never surfaces raw', async () => {
  for (const path of [[], ['input'], ['modelSelection'], ['tools'], ['tools', 'denials', 0], ['acceptance'], ['recovery']]) {
    const value = diagnostics()
    let target = value
    for (const key of path) target = target[key]
    target.rawBody = 'PRIVATE_RAW_SENTINEL'
    const ns = {
      async inspectRun() {
        return { ok: true, value: snapshot(value) }
      }
    }
    const host = resolveBlueprintHost({ get: () => ns })
    await assert.rejects(host.inspectRun('run'), error => error.code === 'blueprint/dto-invalid' && !error.message.includes('PRIVATE_RAW'))
    const model = new BlueprintClientModel()
    model.applySnapshot(snapshot(undefined))
    const before = structuredClone(model.view)
    assert.throws(() => model.applySnapshot(snapshot(value)), { message: 'blueprint/diagnostics-invalid' })
    assert.deepEqual(model.view, before)
    const html = renderToStaticMarkup(renderAttemptDiagnostics(value, t(en)))
    assert.ok(html.includes('data-bp-diagnostics="unavailable"'))
    assert.equal(html.includes('PRIVATE_RAW_SENTINEL'), false)
  }
})
test('C-08 legacy absence stays absent in projection; available diagnostics are detached from caller', () => {
  const model = new BlueprintClientModel()
  model.applySnapshot(snapshot(undefined))
  assert.equal(Object.hasOwn(model.view.attempts[0], 'diagnostics'), false)
  const current = snapshot(diagnostics())
  model.applySnapshot(current)
  current.attempts[0].diagnostics.tools.effectiveNames.push('later')
  assert.deepEqual(model.view.attempts[0].diagnostics.tools.effectiveNames, ['用户.tool'])
})
test('C-07 condition/default-all Inspector props use existing editor commands, exact identifiers and undo', () => {
  const editor = editorFixture(),
    node = editor.nodes[0],
    session = new InspectorSession(editor, node.id)
  const render = dict => renderNodeInspector({ node, editor, resources: {}, t: t(dict) }, session, session.getSnapshot())
  assert.equal(field(render(en), 'condition.inputPort').props.value, '用户.boolean')
  assert.equal(field(render(zh), 'condition.trueBranch').props.value, 'true-path')
  field(render(en), 'condition.trueBranch').props.onChange({ currentTarget: { value: 'false-path' } })
  assert.equal(editor.exportDefinition().graph.nodes[0].condition.trueBranch, 'false-path', 'shape editor preserves identifiers; Host decides branch validity')
  assert.equal(editor.undo(), true)
  assert.equal(editor.exportDefinition().graph.nodes[0].condition.trueBranch, 'true-path')
  for (const value of [
    { inputPort: '用户.boolean', trueBranch: 'true-path' },
    { inputPort: '用户.boolean', trueBranch: 'true-path', falseBranch: 'false-path', raw: 'x' }
  ]) {
    assert.deepEqual(parseInspectorJson(node, 'options', JSON.stringify({ condition: value })), { ok: false, issue: 'node-options-shape' })
  }
  const join = editor.nodes[1],
    joinSession = new InspectorSession(editor, join.id)
  const joinTree = renderNodeInspector({ node: join, editor, resources: {}, t: t(en) }, joinSession, joinSession.getSnapshot())
  assert.equal(field(joinTree, 'join').props.value, 'all')
  field(joinTree, 'join').props.onChange({ currentTarget: { value: 'all' } })
  assert.equal(editor.exportDefinition().graph.nodes[1].join, 'all')
  assert.deepEqual(
    parseInspectorJson(join, 'options', '{"join":"any"}'),
    { ok: true, patch: { join: 'any' } },
    'legacy remains readable, not execution support'
  )
  const agent = editor.nodes[2]
  assert.deepEqual(parseInspectorJson(agent, 'options', '{"toolAllowlist":[],"outputSchemaRef":"user-schema-ref"}'), {
    ok: true,
    patch: { toolAllowlist: [], outputSchemaRef: 'user-schema-ref' }
  })
})
test('C-07 palette advertises exactly accepted kinds; zh/en never rewrite graph, input or Inspector drafts', () => {
  assert.deepEqual(BUILTIN_NODE_CATALOG.map(item => item.kind).sort(), ['agentTask', 'condition', 'humanDecision', 'input', 'join', 'output'].sort())
  for (const query of ['condition', '条件', 'join', '汇合']) assert.ok(searchBuiltinNodes(query).length > 0)
  for (const deferred of ['TeamStage', 'toolCall', 'scriptCall', 'subflow', 'iteration', 'join-any'])
    assert.equal(
      BUILTIN_NODE_CATALOG.some(item => item.kind === deferred),
      false
    )
  const editor = editorFixture(),
    node = editor.nodes[0],
    session = new InspectorSession(editor, node.id)
  editor.toggleSelect(node.id, false)
  session.setJson('options', '{ "condition":')
  const before = JSON.stringify(editor.exportDefinition()),
    draft = session.getSnapshot().json.options
  for (const dict of [zh, en, zh]) {
    renderToStaticMarkup(renderNodeInspector({ node, editor, resources: {}, t: t(dict) }, session, session.getSnapshot()))
    assert.equal(JSON.stringify(editor.exportDefinition()), before)
    assert.equal(session.getSnapshot().json.options, draft)
    assert.equal(editor.selection.has(node.id), true)
    for (const item of BUILTIN_NODE_CATALOG) assert.ok(dict[item.titleKey] && dict[item.descriptionKey])
  }
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
})
