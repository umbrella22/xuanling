// W3.2 source/session/React-props contracts, not mounted native DSH acceptance.
// Real React server rendering exercises hooks; DOM event props are driven directly.
import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { GraphEditor } from '../../src/client/features/authoring/logic/graph/graph-editor.ts'
import { decodeDefinition } from '../../src/definition/codec.ts'
import { validateDefinition } from '../../src/definition/validator.ts'
import { en, zh } from '../../src/client/shared/i18n/locales.ts'
import {
  NodeInspector,
  InspectorSession,
  renderNodeInspector,
  parseInspectorJson,
  applyInspectorPatch,
  referenceMembership
} from '../../src/client/features/authoring/ui/inspector/inspector-composition.tsx'

const definition = {
  schemaVersion: 2,
  id: 'Inspector_Roundtrip',
  name: '用户蓝图 / never translated',
  resources: {
    Agent_A1: { kind: 'agent', path: 'agents/first.md' },
    Agent_B2: { kind: 'agent', path: 'agents/second.md' },
    Skill_A1: { kind: 'skill', source: { kind: 'shared', rootId: 'shared-root', path: '中文 path / SKILL.md' } },
    Skill_B2: { kind: 'skill', path: 'skills/second/SKILL.md' },
    MCP_A1: { kind: 'mcp', bindingId: 'Scope_A1' },
    MCP_B2: { kind: 'mcp', bindingId: 'Scope_B2' },
    Schema_A1: { kind: 'schema', path: 'schemas/a.json' },
    Schema_B2: { kind: 'schema', path: 'schemas/b.json' },
    Prompt_A1: { kind: 'prompt', path: 'prompts/user.md' }
  },
  graph: {
    nodes: [
      {
        id: 'task',
        kind: 'agentTask',
        agentRef: 'Agent_A1',
        skillRefs: ['Skill_A1'],
        toolsetRefs: ['MCP_A1'],
        outputSchemaRef: 'Schema_A1',
        inputs: { '用户.port [中文] / %': '用户 wire type / exact', ' spaced ': 'string' },
        outputs: { 'result.part': 'string' },
        branches: ['Branch_A1', 'Branch_B2'],
        modelSelection: { provider: 'fixture-provider', model: 'fixture-model', reasoningEffort: 'balanced' }
      }
    ],
    edges: []
  },
  presentation: { nodes: { task: { x: -42.125, y: 90.25 } } },
  metadata: { retained: ['中文 Prompt 在资源内容中，不是 node 字段', { b: 2, a: 1 }] }
}
const t =
  language =>
  (key, params = {}) =>
    (language === 'zh' ? zh : en)[key]?.replace(/\{(\w+)\}/g, (_, name) => String(params[name])) ?? key
function fixture() {
  const editor = GraphEditor.fromDefinition(definition)
  const session = new InspectorSession(editor, 'task')
  const off = session.subscribe(() => {})
  const node = () => editor.nodes.find(item => item.id === 'task')
  const props = language => ({ node: node(), editor, resources: editor.exportDefinition().resources, t: t(language) })
  const render = (language = 'en') => renderNodeInspector(props(language), session, session.getSnapshot())
  return { editor, session, node, props, render, off }
}
function elements(tree) {
  if (Array.isArray(tree)) return tree.flatMap(elements)
  if (!React.isValidElement(tree)) return []
  return [tree, ...elements(tree.props.children)]
}
function find(tree, attribute, value, extra = () => true) {
  const element = elements(tree).find(item => item.props[attribute] === value && extra(item))
  assert.ok(element, `${attribute}=${value}`)
  return element
}
const event = value => ({ currentTarget: { value } })
function hostRoundtrip(editor) {
  const decoded = decodeDefinition(JSON.stringify(editor.exportDefinition()))
  validateDefinition(decoded)
  return decoded
}
function retained(actual) {
  assert.equal(actual.name, definition.name)
  assert.deepEqual(actual.resources, definition.resources)
  assert.deepEqual(actual.metadata, definition.metadata)
  assert.deepEqual(actual.graph.nodes[0].branches, definition.graph.nodes[0].branches)
  assert.deepEqual(actual.graph.nodes[0].modelSelection, definition.graph.nodes[0].modelSelection)
  assert.equal(Object.hasOwn(actual.graph.nodes[0], 'name'), false)
  assert.equal(Object.hasOwn(actual.graph.nodes[0], 'prompt'), false)
}

test('C-04 fixture and unmodified Inspector definition roundtrip through the real Host decoder and validator', t => {
  const f = fixture()
  t.after(f.off)
  retained(hostRoundtrip(f.editor))
  assert.equal(f.editor.canUndo, false)
})

test('C-04 NodeInspector uses actual React props/hooks, legal structured fields and collapsed stable advanced hooks', t => {
  const f = fixture()
  t.after(f.off)
  const props = f.props('en')
  const html = renderToStaticMarkup(React.createElement(NodeInspector, props))
  assert.ok(html.includes('data-bp-json-editor="true"'))
  const tree = f.render()
  assert.equal(find(tree, 'data-bp-field', 'agentRef').props.value, 'Agent_A1')
  assert.equal(find(tree, 'data-bp-field', 'outputSchemaRef').props.value, 'Schema_A1')
  assert.equal(find(tree, 'data-bp-field', 'inputs.name').props.value, '用户.port [中文] / %')
  assert.equal(find(tree, 'data-bp-field', 'inputs.type').props.value, '用户 wire type / exact')
  const summary = find(tree, 'data-bp-inspector-advanced', true)
  assert.equal(summary.type, 'summary')
  const details = elements(tree).find(item => item.type === 'details')
  assert.equal(details.props.open, undefined, 'advanced is collapsed by default, not controlled by locale')
  for (const field of ['inputs', 'outputs', 'options']) {
    const input = find(tree, 'data-bp-json', field)
    assert.equal(typeof input.props.onChange, 'function')
    assert.equal(typeof input.props.onBlur, 'function')
  }
  assert.equal(typeof find(tree, 'data-bp-action', 'apply-node-options').props.onClick, 'function')
  assert.equal(
    elements(tree).some(item => ['name', 'prompt'].includes(item.props['data-bp-field'])),
    false
  )
  assert.equal(f.editor.canUndo, false)
})

test('C-04 Agent/output schema React select handlers patch only their field and retain imported branches/model route', t => {
  const f = fixture()
  t.after(f.off)
  find(f.render(), 'data-bp-field', 'agentRef').props.onChange(event('Agent_B2'))
  find(f.render(), 'data-bp-field', 'outputSchemaRef').props.onChange(event('Schema_B2'))
  const result = hostRoundtrip(f.editor)
  retained(result)
  assert.equal(result.graph.nodes[0].agentRef, 'Agent_B2')
  assert.equal(result.graph.nodes[0].outputSchemaRef, 'Schema_B2')
  assert.deepEqual(result.graph.nodes[0].inputs, definition.graph.nodes[0].inputs)
})

test('C-04 Skill/MCP declaration checkbox handlers preserve exact refs and array order, without probes', t => {
  const f = fixture()
  t.after(f.off)
  for (const [field, ref] of [
    ['skillRefs', 'Skill_B2'],
    ['toolsetRefs', 'MCP_B2']
  ]) {
    const checkbox = find(f.render(), 'data-bp-field', field, item => item.props['data-bp-ref'] === ref)
    assert.equal(checkbox.props.type, 'checkbox')
    checkbox.props.onChange({ currentTarget: { checked: true } })
  }
  let result = hostRoundtrip(f.editor)
  retained(result)
  assert.deepEqual(result.graph.nodes[0].skillRefs, ['Skill_A1', 'Skill_B2'])
  assert.deepEqual(result.graph.nodes[0].toolsetRefs, ['MCP_A1', 'MCP_B2'])
  const before = JSON.stringify(f.editor.exportDefinition())
  find(f.render(), 'data-bp-field', 'skillRefs', item => item.props['data-bp-ref'] === 'Skill_B2').props.onChange({ currentTarget: { checked: true } })
  assert.equal(JSON.stringify(f.editor.exportDefinition()), before)
  assert.deepEqual(referenceMembership(['Skill_B2', 'Skill_A1'], 'Skill_A1', true), ['Skill_B2', 'Skill_A1'])
  assert.deepEqual(referenceMembership(['Skill_B2', 'Skill_A1'], 'Skill_B2', false), ['Skill_A1'])
})

test('C-04 structured port rows preserve awkward legal keys/types and never normalize identity', t => {
  const f = fixture()
  t.after(f.off)
  find(f.render(), 'data-bp-field', 'inputs.name').props.onChange(event('  renamed.part [中文] / %  '))
  find(f.render(), 'data-bp-field', 'inputs.type').props.onChange(event(' exact custom/type [中文] '))
  assert.deepEqual(f.editor.exportDefinition().graph.nodes[0].inputs, definition.graph.nodes[0].inputs, 'unfinished rows do not mutate the graph')
  find(f.render(), 'data-bp-action', 'apply-input-ports').props.onClick()
  retained(hostRoundtrip(f.editor))
  assert.equal(f.editor.exportDefinition().graph.nodes[0].inputs['  renamed.part [中文] / %  '], ' exact custom/type [中文] ')
  assert.equal(f.editor.exportDefinition().graph.nodes[0].inputs[' spaced '], 'string')
  find(f.render(), 'data-bp-action', 'add-output-port').props.onClick()
  const row = f.session.getSnapshot().rows.outputs.at(-1)
  find(f.render(), 'data-bp-field', 'outputs.name', item => item.props['data-bp-port-row'] === row.id).props.onChange(event('constructor'))
  find(f.render(), 'data-bp-action', 'apply-output-ports').props.onClick()
  assert.equal(hostRoundtrip(f.editor).graph.nodes[0].outputs.constructor, 'string', 'object-looking keys stay own port keys')
})

test('C-04 advanced input/output JSON handles awkward valid ports and applies only the targeted field', t => {
  const f = fixture()
  t.after(f.off)
  const ports = { 'awkward.port [中文]': ' raw:type / 中文 ', '': 'string' }
  for (const field of ['inputs', 'outputs']) {
    const textarea = find(f.render(), 'data-bp-json', field)
    textarea.props.onChange(JSON.stringify(ports))
    find(f.render(), 'data-bp-json', field).props.onBlur(event(JSON.stringify(ports)))
    assert.deepEqual(hostRoundtrip(f.editor).graph.nodes[0][field], ports)
  }
  retained(hostRoundtrip(f.editor))
  assert.deepEqual(f.session.getSnapshot().notice, { key: 'inspector.editApplied' })
})

test('C-04 malformed JSON and invalid field shapes retain definition/history and unfinished text, with stable non-raw errors', t => {
  const f = fixture()
  t.after(f.off)
  const before = JSON.stringify(f.editor.exportDefinition())
  for (const [field, text, expectedKey] of [
    ['inputs', '{raw /private/secret', 'inspector.invalidJsonRetained'],
    ['inputs', '[]', 'inspector.portTypesRequired'],
    ['outputs', '{"x":42}', 'inspector.portTypesRequired'],
    ['options', JSON.stringify({ id: 'task', kind: 'agentTask', skillRefs: 'not-an-array' }), 'inspector.invalidJson'],
    ['options', JSON.stringify({ id: 'task', kind: 'agentTask', budget: { maxIterations: 'wrong', maxDurationMs: 12 } }), 'inspector.invalidJson'],
    ['options', JSON.stringify({ id: 'other', kind: 'agentTask' }), 'inspector.identityNotOption'],
    ['options', JSON.stringify({ id: 'task', kind: 'agentTask', name: 'unsupported node name' }), 'inspector.invalidJson'],
    ['options', JSON.stringify({ id: 'task', kind: 'agentTask', prompt: 'unsupported prompt' }), 'inspector.invalidJson']
  ]) {
    const area = find(f.render(), 'data-bp-json', field)
    area.props.onChange(text)
    find(f.render(), 'data-bp-json', field).props.onBlur(event(text))
    assert.equal(find(f.render(), 'data-bp-json', field).props.value, text)
    assert.equal(f.session.getSnapshot().notice.key, expectedKey)
    assert.equal(JSON.stringify(f.editor.exportDefinition()), before)
    assert.equal(f.editor.canUndo, false)
    assert.equal(JSON.stringify(f.session.getSnapshot().notice).includes('secret'), false)
  }
})

test('C-04 duplicate structured port names reject atomically and keep unfinished rows', t => {
  const f = fixture()
  t.after(f.off)
  const before = JSON.stringify(f.editor.exportDefinition())
  find(f.render(), 'data-bp-field', 'inputs.name').props.onChange(event(' spaced '))
  find(f.render(), 'data-bp-action', 'apply-input-ports').props.onClick()
  assert.deepEqual(f.session.getSnapshot().notice, { key: 'inspector.invalidJson', params: { code: 'duplicate-port-name' } })
  assert.equal(find(f.render(), 'data-bp-field', 'inputs.name').props.value, ' spaced ')
  assert.equal(JSON.stringify(f.editor.exportDefinition()), before)
  assert.equal(f.editor.canUndo, false)
})

test('C-04 options onBlur and explicit Apply are compatible without duplicate history; omitted imported fields stay intact', t => {
  const f = fixture()
  t.after(f.off)
  const before = JSON.stringify(f.editor.exportDefinition())
  const text = JSON.stringify({ id: 'task', kind: 'agentTask', outputs: { 'new.port / 中文': 'string' } })
  find(f.render(), 'data-bp-json', 'options').props.onChange(text)
  find(f.render(), 'data-bp-json', 'options').props.onBlur(event(text))
  const after = JSON.stringify(f.editor.exportDefinition())
  find(f.render(), 'data-bp-action', 'apply-node-options').props.onClick()
  assert.equal(JSON.stringify(f.editor.exportDefinition()), after)
  retained(hostRoundtrip(f.editor))
  assert.equal(f.editor.undo(), true)
  assert.equal(JSON.stringify(f.editor.exportDefinition()), before)
  assert.equal(f.editor.canUndo, false, 'blur+click produce one history entry, not two')
})

test('C-04 unfinished full options JSON patches only fields edited relative to its base, preserving newer structured edits', t => {
  const f = fixture()
  t.after(f.off)
  const candidate = { ...f.editor.exportDefinition().graph.nodes[0], outputs: { 'edited.port': 'string' } }
  find(f.render(), 'data-bp-json', 'options').props.onChange(JSON.stringify(candidate))
  find(f.render(), 'data-bp-field', 'agentRef').props.onChange(event('Agent_B2'))
  find(f.render(), 'data-bp-action', 'apply-node-options').props.onClick()
  const result = hostRoundtrip(f.editor)
  assert.equal(result.graph.nodes[0].agentRef, 'Agent_B2', 'stale unchanged options must not clobber a newer field edit')
  assert.deepEqual(result.graph.nodes[0].outputs, { 'edited.port': 'string' })
  retained(result)
})

test('C-02/C-04 zh/en view updates preserve ALL unfinished JSON/port buffers, keys, definition, history and selection', t => {
  const f = fixture()
  t.after(f.off)
  f.editor.setSelection(['task'])
  for (const field of ['inputs', 'outputs', 'options']) find(f.render(), 'data-bp-json', field).props.onChange(`{ unfinished ${field} / 中文`)
  find(f.render(), 'data-bp-field', 'inputs.name').props.onChange(event(' pending 用户.port '))
  find(f.render(), 'data-bp-field', 'outputs.type').props.onChange(event(' unfinished / 用户.type '))
  const snapshot = f.session.getSnapshot()
  const bytes = JSON.stringify(f.editor.exportDefinition())
  const keys = elements(f.render())
    .filter(item => item.props['data-bp-json'])
    .map(item => item.key)
  for (const language of ['zh', 'en', 'zh']) {
    const tree = f.render(language)
    const html = renderToStaticMarkup(tree)
    assert.ok(html.includes(f.props(language).t('inspector.agentBinding')))
    assert.ok(html.includes(f.props(language).t('inspector.portName')))
    assert.equal(f.session.getSnapshot(), snapshot, 'translation does not reset buffers or session snapshot')
    assert.equal(find(tree, 'data-bp-json', 'options').props.value, '{ unfinished options / 中文')
    assert.equal(find(tree, 'data-bp-field', 'inputs.name').props.value, ' pending 用户.port ')
    assert.deepEqual(
      elements(tree)
        .filter(item => item.props['data-bp-json'])
        .map(item => item.key),
      keys
    )
    assert.equal(JSON.stringify(f.editor.exportDefinition()), bytes)
    assert.deepEqual([...f.editor.selection], ['task'])
    assert.equal(f.editor.canUndo, false)
    assert.equal(f.editor.canRedo, false)
  }
})

test('C-04 pristine buffers follow Undo/Redo; external updates do not discard an unfinished alternative buffer', t => {
  const f = fixture()
  t.after(f.off)
  find(f.render(), 'data-bp-field', 'agentRef').props.onChange(event('Agent_B2'))
  assert.equal(JSON.parse(f.session.getSnapshot().json.options).agentRef, 'Agent_B2')
  find(f.render(), 'data-bp-json', 'inputs').props.onChange('{ unfinished')
  f.editor.undo()
  assert.equal(JSON.parse(f.session.getSnapshot().json.options).agentRef, 'Agent_A1')
  assert.equal(f.session.getSnapshot().json.inputs, '{ unfinished')
  f.editor.redo()
  assert.equal(JSON.parse(f.session.getSnapshot().json.options).agentRef, 'Agent_B2')
  assert.equal(f.session.getSnapshot().json.inputs, '{ unfinished')
})

test('C-04 optional schema can be cleared without an empty invalid ref; equivalent patches never add history', t => {
  const f = fixture()
  t.after(f.off)
  find(f.render(), 'data-bp-field', 'outputSchemaRef').props.onChange(event(''))
  assert.equal(Object.hasOwn(hostRoundtrip(f.editor).graph.nodes[0], 'outputSchemaRef'), false)
  f.editor.undo()
  assert.equal(f.editor.canUndo, false)
  const reordered = Object.fromEntries(Object.entries(f.node().inputs).reverse())
  assert.deepEqual(applyInspectorPatch(f.editor, 'task', { inputs: reordered }), { ok: true, changed: false })
  assert.equal(f.editor.canUndo, false)
  assert.deepEqual(parseInspectorJson(f.node(), 'options', JSON.stringify({ id: 'task', kind: 'output' })), { ok: false, issue: 'identity-not-option' })
})

test('C-04 removed node vocabulary is rejected at the Host definition boundary while subflow resources remain portable', () => {
  const imported = structuredClone(definition)
  imported.resources.Subflow_A1 = { kind: 'subflow', path: 'subflows/child.json' }
  imported.graph.nodes.push(
    {
      id: 'condition',
      kind: 'condition',
      condition: { inputPort: 'input', trueBranch: 'Approved_A1', falseBranch: 'Rejected_B2' },
      outputs: { '分支.port': 'string' }
    },
    { id: 'join', kind: 'join', join: 'all', outputs: { 'join.port': 'string' } },
    { id: 'subflow', kind: 'subflow', subflowRef: 'Subflow_A1', outputs: { 'sub.port': 'string' } }
  )
  assert.throws(
    () => hostRoundtrip(GraphEditor.fromDefinition(imported)),
    error => {
      assert.equal(error.code, 'DEFINITION_INVALID')
      assert.ok(error.issues.some(issue => issue.pointer === '/graph/nodes/3/kind' && issue.code === 'unsupported-step-kind'))
      assert.ok(error.issues.some(issue => issue.pointer === '/graph/nodes/3/subflowRef' && issue.code === 'unknown-field'))
      return true
    }
  )
  assert.equal(imported.resources.Subflow_A1.kind, 'subflow')
})

test('C-04 declaration shape preflight is not Host validation: dangling refs still fail the Host oracle', t => {
  const f = fixture()
  t.after(f.off)
  const parsed = parseInspectorJson(f.node(), 'options', '{"id":"task","kind":"agentTask","agentRef":"Missing_Agent"}')
  assert.equal(parsed.ok, true, 'JSON/field shape is local, reference semantics remain Host-owned')
  assert.equal(applyInspectorPatch(f.editor, 'task', parsed.patch).ok, true)
  assert.throws(
    () => hostRoundtrip(f.editor),
    error => error.issues.some(issue => issue.code === 'dangling-ref')
  )
  assert.equal(find(f.render(), 'data-bp-field', 'agentRef').props.value, 'Missing_Agent', 'display never silently replaces an unresolved declaration')
})

// Host's current Zod record codec drops this key. Do not normalize the client
// declaration to work around that separate Host boundary (outside W3.2).
test('C-04 prototype-looking port keys remain own client data; Host codec behavior is explicit', t => {
  const f = fixture()
  t.after(f.off)
  const text = '{"__proto__":"string","constructor":"string","中文.port":"wire / exact"}'
  find(f.render(), 'data-bp-json', 'outputs').props.onChange(text)
  find(f.render(), 'data-bp-json', 'outputs').props.onBlur(event(text))
  const exported = f.editor.exportDefinition().graph.nodes[0].outputs
  assert.equal(Object.hasOwn(exported, '__proto__'), true)
  assert.equal(exported.__proto__, 'string')
  const decoded = hostRoundtrip(f.editor).graph.nodes[0].outputs
  assert.equal(Object.hasOwn(decoded, '__proto__'), false, 'known Host codec boundary, not a client normalization')
  assert.equal(decoded.constructor, 'string')
  assert.equal(decoded['中文.port'], 'wire / exact')
})

test('C-02/C-04 locale updates preserve dirty saved semantics, selection and nonempty Undo/Redo stacks', t => {
  const f = fixture()
  t.after(f.off)
  const baseline = hostRoundtrip(f.editor)
  find(f.render(), 'data-bp-field', 'agentRef').props.onChange(event('Agent_B2'))
  find(f.render(), 'data-bp-field', 'outputSchemaRef').props.onChange(event('Schema_B2'))
  f.editor.undo()
  f.editor.setSelection(['task'])
  assert.equal(f.editor.canUndo, true)
  assert.equal(f.editor.canRedo, true)
  for (const field of ['inputs', 'outputs', 'options']) find(f.render(), 'data-bp-json', field).props.onChange(`unfinished ${field}`)
  const before = JSON.stringify(f.editor.exportDefinition())
  const snapshot = f.session.getSnapshot()
  for (const language of ['zh', 'en', 'zh']) {
    const tree = f.render(language)
    assert.equal(f.session.getSnapshot(), snapshot)
    assert.equal(JSON.stringify(f.editor.exportDefinition()), before)
    assert.deepEqual([...f.editor.selection], ['task'])
    assert.equal(f.editor.canUndo, true)
    assert.equal(f.editor.canRedo, true)
    for (const field of ['inputs', 'outputs', 'options']) assert.equal(find(tree, 'data-bp-json', field).props.value, `unfinished ${field}`)
  }
  f.editor.redo()
  retained(hostRoundtrip(f.editor))
  assert.equal(f.editor.exportDefinition().graph.nodes[0].outputSchemaRef, 'Schema_B2')
  f.editor.undo()
  f.editor.undo()
  assert.deepEqual(hostRoundtrip(f.editor), baseline)
})

test('C-04 public patch helper cannot introduce unsupported Host fields or invalid shapes', t => {
  const f = fixture()
  t.after(f.off)
  const before = JSON.stringify(f.editor.exportDefinition())
  for (const patch of [{ name: 'unsupported' }, { prompt: 'unsupported' }, { id: 'other' }, { inputs: [] }, { skillRefs: 'wrong' }]) {
    assert.deepEqual(applyInspectorPatch(f.editor, 'task', patch), { ok: false, issue: 'node-options-shape' })
    assert.equal(JSON.stringify(f.editor.exportDefinition()), before)
    assert.equal(f.editor.canUndo, false)
  }
  assert.deepEqual(applyInspectorPatch(f.editor, 'missing', {}), { ok: false, issue: 'node-unavailable' })
  assert.deepEqual(referenceMembership(['Skill_B2', 'Skill_B2'], 'Skill_A1', true), ['Skill_B2', 'Skill_B2', 'Skill_A1'])
})

test('C-04 session subscription disposes editor listeners and separate editor identity isolates unfinished buffers', t => {
  const f = fixture()
  t.after(f.off)
  let emissions = 0
  const off = f.session.subscribe(() => emissions++)
  const before = f.session.getSnapshot()
  f.off()
  off()
  f.editor.updateNode('task', { agentRef: 'Agent_B2' })
  assert.equal(emissions, 0)
  assert.equal(f.session.getSnapshot(), before)
  find(f.render(), 'data-bp-json', 'options').props.onChange('{ unfinished / original')
  const replacement = fixture()
  t.after(replacement.off)
  assert.notEqual(replacement.editor, f.editor)
  assert.notEqual(replacement.session.getSnapshot().json.options, f.session.getSnapshot().json.options)
  assert.equal(replacement.editor.canUndo, false)
})

test('W3-UI-01 real React labels and SSR retain exact Skill · skill checkbox name without changing refs', context => {
  const imported = structuredClone(definition)
  imported.resources.skill = structuredClone(imported.resources.Skill_A1)
  imported.resources.tools = structuredClone(imported.resources.MCP_A1)
  imported.graph.nodes[0].skillRefs = ['skill']
  imported.graph.nodes[0].toolsetRefs = ['tools']
  const editor = GraphEditor.fromDefinition(imported)
  const session = new InspectorSession(editor, 'task')
  context.after(session.subscribe(() => {}))
  const before = JSON.stringify(editor.exportDefinition())
  for (const language of ['en', 'zh', 'en']) {
    const props = { node: editor.nodes[0], editor, resources: imported.resources, t: t(language) }
    const tree = renderNodeInspector(props, session, session.getSnapshot())
    const label = (field, ref) =>
      elements(tree).find(
        item =>
          item.type === 'label' && elements(item.props.children).some(child => child.props['data-bp-field'] === field && child.props['data-bp-ref'] === ref)
      )
    const html = renderToStaticMarkup(React.createElement(NodeInspector, props))
    assert.equal(label('skillRefs', 'skill').props.children.at(-1), 'Skill · skill', 'existing exact checkbox name requires the Skill prefix')
    assert.ok(html.includes('/>Skill · skill</label>'), 'actual NodeInspector SSR has the wrapping label text, not an aria-label workaround')
    assert.equal(label('toolsetRefs', 'tools').props.children.at(-1), 'MCP · tools')
    assert.ok(html.includes('/>MCP · tools</label>'))
    assert.equal(find(tree, 'data-bp-field', 'skillRefs', item => item.props['data-bp-ref'] === 'skill').props.checked, true)
    assert.equal(JSON.stringify(editor.exportDefinition()), before, 'display locale must not change stored references')
    assert.equal(editor.canUndo, false)
  }
  const props = { node: editor.nodes[0], editor, resources: imported.resources, t: t('en') }
  const tree = renderNodeInspector(props, session, session.getSnapshot())
  find(tree, 'data-bp-field', 'skillRefs', item => item.props['data-bp-ref'] === 'skill').props.onChange({ currentTarget: { checked: false } })
  const decoded = hostRoundtrip(editor)
  assert.deepEqual(decoded.graph.nodes[0].skillRefs, [])
  assert.deepEqual(decoded.graph.nodes[0].toolsetRefs, ['tools'])
  assert.deepEqual(decoded.resources, imported.resources)
})
