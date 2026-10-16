// Real Panel closure + Workspace/GraphEditor, controlled renderer seats.
// Not a mounted browser/Inspector-buffer acceptance test; main owns that gate.
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { canvasDefinitions } from '../../../../../test/blueprint/capabilities/canvas-fixtures.mjs'
import { en } from '../../src/client/locales.ts'
import { BlueprintWorkspace } from '../../src/client/workspace.ts'

const key = Symbol.for('blueprint.test.nodeux.panel'),
  seat = { active: null }
globalThis[key] = seat
seat.react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  memo: fn => fn,
  useState(initial) {
    const f = seat.active,
      i = f.cursor++
    if (!(i in f.states)) f.states[i] = typeof initial === 'function' ? initial() : initial
    return [
      f.states[i],
      update => {
        f.states[i] = typeof update === 'function' ? update(f.states[i]) : update
      }
    ]
  },
  useRef(initial) {
    const f = seat.active,
      i = f.refCursor++
    return (f.refs[i] ??= { current: initial })
  },
  useMemo(factory, deps) {
    const f = seat.active,
      i = f.memoCursor++,
      last = f.memos[i]
    if (!last || deps.some((v, j) => !Object.is(v, last.deps[j]))) f.memos[i] = { deps, value: factory() }
    return f.memos[i].value
  },
  useCallback: fn => fn,
  useEffect() {}
}
const url = code => `data:text/javascript,${encodeURIComponent(code)}`
const react = url(
  `export default globalThis[Symbol.for('blueprint.test.nodeux.panel')].react; export const createElement=globalThis[Symbol.for('blueprint.test.nodeux.panel')].react.createElement;`
)
const flow = url(`export const useReactFlow=()=>globalThis[Symbol.for('blueprint.test.nodeux.panel')].active.flow;
export const Position={Left:'left',Right:'right'},MarkerType={ArrowClosed:'arrowclosed'};
export const ReactFlow='flow',ReactFlowProvider='provider',Background='background',Controls='controls',MiniMap='minimap',Handle='handle',NodeResizer='resizer',BaseEdge='base-edge'; export const getSmoothStepPath=()=>['M 0 0 L 1 1',0,0];`)
// Inspector is a frozen opaque boundary here, not a fake editor implementation.
const inspector = url('export function NodeInspector(){}')
const client = new URL('../../src/client/', import.meta.url).href
const hooks = registerHooks({
  resolve(spec, context, next) {
    if (context.parentURL?.startsWith(client) && spec === 'react') return { url: react, shortCircuit: true }
    if (context.parentURL === `${client}panel.ts` && spec === '@xyflow/react') return { url: flow, shortCircuit: true }
    if (context.parentURL === `${client}panel.ts` && spec === './inspector.ts') return { url: inspector, shortCircuit: true }
    return next(spec, context)
  }
})
let createBlueprintPanel
let resourceRows
try {
  ;({ createBlueprintPanel, resourceRows } = await import(`${client}panel.ts`))
} finally {
  hooks.deregister()
}

test('resource rows merge public catalog with display metadata and preserve loading availability', () => {
  const definition = {
    resources: {
      worker: { kind: 'agent', source: { kind: 'host', id: 'same' } },
      local: { kind: 'prompt', path: 'prompts/local.md' }
    },
    presentation: {
      resources: {
        worker: { title: 'Pinned worker', description: 'Visible summary' },
        local: { title: 'Local prompt' }
      }
    }
  }
  const rows = resourceRows(
    definition,
    [
      {
        source: 'dsh',
        kind: 'agent',
        id: 'same',
        displayName: 'Host worker',
        description: 'Host summary',
        availability: 'available'
      }
    ],
    'loading'
  )
  assert.equal(rows.agent[0].displayName, 'Pinned worker')
  assert.equal(rows.agent[0].description, 'Visible summary')
  assert.equal(rows.other[0].displayName, 'Local prompt')
  const missing = resourceRows({ resources: { missing: { kind: 'skill', source: { kind: 'host', id: 'gone' } } } }, [], 'loading')
  assert.equal(missing.skill[0].availability, 'unknown')
})

const resourceSectionOf = f => one(f.render(), n => n.props['data-bp-section'] === 'resources')
const resourceDialogOf = f => one(f.render(), n => n.props['data-bp-resource-dialog'] === true)

test('resource cards categorize historical references once and expose full descriptions through hover and focus', async () => {
  const f = await fixture()
  const description = 'A complete resource description. '.repeat(12).trim()
  for (const kind of ['agent', 'skill', 'mcp']) {
    const ref = { kind, source: { kind: 'host', id: `host-${kind}` } }
    f.workspace.editor.updateResource(`old-${kind}`, ref)
    f.workspace.editor.updateResource(`alias-${kind}`, ref)
  }
  f.workspace.editor.updateResource('local-agent', { kind: 'agent', path: 'lib/agents/local.md' }, { title: 'Review agent', description })
  f.workspace.editor.updateResource('local-skill', { kind: 'skill', source: { kind: 'shared', rootId: 'skills', path: 'review' } })
  f.workspace.editor.updateResource('local-mcp', { kind: 'mcp', bindingId: 'tools' })
  f.workspace.editor.updateResource('prompt', { kind: 'prompt', path: 'lib/prompts/review.md' })
  f.workspace.resourceCatalog = [{ kind: 'agent', id: 'host-agent', displayName: 'Host agent', source: 'dsh', availability: 'available', description: '' }]
  const before = f.workspace.editor.exportDefinition()
  const section = resourceSectionOf(f)
  for (const kind of ['agent', 'skill', 'mcp']) {
    const category = one(section, n => n.props['data-bp-resource-category'] === kind)
    assert.deepEqual(
      all(category, n => n.props['data-bp-resource-row'])
        .map(n => n.props['data-bp-resource-row'])
        .sort(),
      [`blueprint:local-${kind}`, `dsh:${kind}:host-${kind}`].sort()
    )
  }
  const other = one(section, n => n.props['data-bp-resource-category'] === 'other')
  assert.deepEqual(
    all(other, n => n.props['data-bp-resource-row']).map(n => n.props['data-bp-resource-row']),
    ['blueprint:prompt']
  )
  assert.equal(all(section, n => n.type === 'details' || n.type === 'form').length, 0, 'legacy lists and creation forms must not duplicate the category cards')
  const card = one(section, n => n.props['data-bp-resource-row'] === 'blueprint:local-agent')
  assert.equal(one(card, n => n.props['data-bp-resource-title']).children[0], 'Review agent - Blueprint')
  assert.equal(one(card, n => n.props['data-bp-resource-description']).children[0], description)
  for (const handler of ['onMouseEnter', 'onFocus']) {
    card.props[handler]({ currentTarget: {} })
    const tooltip = one(f.render(), n => n.props.content?.action === 'resource-blueprint:local-agent')
    assert.equal(tooltip.props.content.text, description, 'ellipsis is presentation only; tooltip retains the entire description')
    card.props.onMouseLeave()
  }
  assert.deepEqual(f.workspace.editor.exportDefinition(), before, 'display and tooltips preserve historical resource identities and metadata')
})

test('W4.3 RED actual resource dialog exposes structured metadata, safe configuration details and advanced JSON', async () => {
  const f = await fixture()
  f.workspace.editor.updateResource('worker', { kind: 'agent', path: 'lib/agents/worker.md' })
  f.render()
  one(resourceSectionOf(f), n => n.props['data-bp-resource-row'] === 'blueprint:worker').props.onClick()
  const dialog = resourceDialogOf(f)
  assert.equal(all(dialog, n => n.props['data-bp-resource-field'] === 'title').length, 1, 'resource title field must be part of the actual dialog')
  assert.equal(all(dialog, n => n.props['data-bp-resource-field'] === 'description').length, 1, 'resource description field must be part of the actual dialog')
  assert.equal(
    all(dialog, n => n.props['data-bp-resource-detail'] === 'configuration').length,
    1,
    'resource configuration details must be visible without opening a Host private config'
  )
  assert.equal(all(dialog, n => n.props['data-bp-resource-advanced'] === true).length, 1, 'advanced JSON must remain available behind an explicit disclosure')
})

test('W4.3 RED invalid package path keeps the real dialog draft and leaves the editor resource set unchanged', async () => {
  const f = await fixture()
  const section = resourceSectionOf(f)
  one(section, n => n.props['data-bp-action'] === 'add-resource').props.onClick()
  let dialog = resourceDialogOf(f)
  one(dialog, n => n.props['aria-label'] === 'New resource ID').props.onChange({
    currentTarget: { value: 'unsafe' }
  })
  f.render()
  dialog = resourceDialogOf(f)
  one(dialog, n => n.props.label === 'New resource JSON').props.onChange('{"kind":"agent","path":"../secret.md"}')
  f.render()
  dialog = resourceDialogOf(f)
  one(dialog, n => n.props['data-bp-action'] === 'resource-apply').props.onClick()
  const definition = f.workspace.editor.exportDefinition()
  assert.equal(Object.hasOwn(definition.resources, 'unsafe'), false, 'invalid path must not be committed')
  assert.equal(all(f.render(), n => n.props['data-bp-resource-dialog'] === true).length, 1, 'failed Apply must retain the dialog draft')
  assert.equal(
    one(resourceDialogOf(f), n => n.props.label === 'New resource JSON').props.value,
    '{"kind":"agent","path":"../secret.md"}',
    'failed Apply must retain the malformed semantic draft'
  )
})

test('W4.3 invalid logical IDs are rejected before the ResourceRef transaction', async () => {
  const f = await fixture()
  one(resourceSectionOf(f), n => n.props['data-bp-action'] === 'add-resource').props.onClick()
  let dialog = resourceDialogOf(f)
  one(dialog, n => n.props['aria-label'] === 'New resource ID').props.onChange({
    currentTarget: { value: 'bad id' }
  })
  f.render()
  dialog = resourceDialogOf(f)
  one(dialog, n => n.props['data-bp-action'] === 'resource-apply').props.onClick()
  assert.equal(Object.hasOwn(f.workspace.editor.exportDefinition().resources, 'bad id'), false)
  assert.equal(all(f.render(), n => n.props['data-bp-resource-dialog'] === true).length, 1)
})

test('malformed advanced resource drafts never render object values as configuration children', async () => {
  const f = await fixture()
  const before = f.workspace.editor.exportDefinition()
  one(resourceSectionOf(f), n => n.props['data-bp-action'] === 'add-resource').props.onClick()
  const json = '{"kind":"agent","path":{"unexpected":"object"}}'
  one(resourceDialogOf(f), n => n.props.label === 'New resource JSON').props.onChange(json)
  const dialog = one(f.render(), n => n.props?.['data-bp-resource-dialog'] === true)
  const configuration = one(dialog, n => n.props?.['data-bp-resource-detail'] === 'configuration')
  for (const detail of all(configuration, n => n.type === 'dd')) {
    assert.ok(
      detail.children.every(child => typeof child === 'string'),
      'invalid drafts must not reach React as object children'
    )
  }
  assert.equal(one(dialog, n => n.props.label === 'New resource JSON').props.value, json)
  assert.deepEqual(f.workspace.editor.exportDefinition(), before)
})

test('W4.3 RED Apply stores display metadata in presentation without changing the ResourceRef shape', async () => {
  const f = await fixture()
  f.workspace.editor.updateResource('worker', { kind: 'agent', path: 'lib/agents/worker.md' })
  f.render()
  one(resourceSectionOf(f), n => n.props['data-bp-resource-row'] === 'blueprint:worker').props.onClick()
  let dialog = resourceDialogOf(f)
  const title = one(dialog, n => n.props['data-bp-resource-field'] === 'title')
  const description = one(dialog, n => n.props['data-bp-resource-field'] === 'description')
  title.props.onChange({ currentTarget: { value: 'Visible worker' } })
  description.props.onChange({ currentTarget: { value: 'Safe public summary' } })
  f.render()
  dialog = resourceDialogOf(f)
  one(dialog, n => n.props['data-bp-action'] === 'resource-apply').props.onClick()
  const saved = f.workspace.editor.exportDefinition()
  assert.deepEqual(saved.resources.worker, { kind: 'agent', path: 'lib/agents/worker.md' })
  assert.deepEqual(saved.presentation?.resources?.worker, {
    title: 'Visible worker',
    description: 'Safe public summary'
  })
})
test('W4.4 missing package/shared descriptions use localized display fallback without persisting it', async () => {
  const f = await fixture()
  f.workspace.editor.updateResource('worker', { kind: 'agent', path: 'lib/agents/worker.md' })
  f.render()
  one(resourceSectionOf(f), n => n.props['data-bp-resource-row'] === 'blueprint:worker').props.onClick()
  const dialog = resourceDialogOf(f)
  const fallback = one(dialog, n => n.props?.['data-bp-resource-description-fallback'] === true)
  assert.equal(fallback.children?.[0], f.t('resource.noDescription'))
  assert.equal(one(dialog, n => n.props?.['data-bp-resource-field'] === 'description').props.value, '')
  assert.equal(f.workspace.editor.exportDefinition().presentation?.resources?.worker, undefined)
})
test.after(() => {
  delete globalThis[key]
})
const all = (tree, predicate) =>
  !tree || typeof tree !== 'object' ? [] : [...(predicate(tree) ? [tree] : []), ...(tree.children ?? []).flat(Infinity).flatMap(child => all(child, predicate))]
const one = (tree, predicate) => {
  const found = all(tree, predicate)
  assert.equal(found.length, 1)
  return found[0]
}
const flowOf = f => one(f.render(), n => n.type === 'flow')
async function fixture(kind) {
  const definition = structuredClone(canvasDefinitions()[0]),
    calls = [],
    values = new Map()
  if (kind) {
    definition.graph.nodes[0].kind = kind
    definition.graph.nodes[0].agentRef = 'legacy-synthetic-agent'
  }
  const doc = {
    blueprintId: definition.id,
    definitionJson: JSON.stringify(definition),
    documentRevision: 'doc-1',
    semanticRevision: 'semantic-1',
    layoutRevision: 'layout-1'
  }
  const snapshot = {
    runId: 'durable-run',
    state: 'succeeded',
    seq: 7,
    definitionRevision: 'semantic-1',
    attempts: [
      {
        nodeId: definition.graph.nodes[0].id,
        attempt: 1,
        state: 'succeeded',
        outputJson: '{"原样":"payload"}'
      }
    ],
    logTail: []
  }
  const host = {
    async loadDefinition(id) {
      calls.push(['load', id])
      return structuredClone(doc)
    },
    async listDefinitions() {
      calls.push(['list'])
      return {
        definitions: [
          {
            blueprintId: definition.id,
            name: definition.name,
            documentRevision: 'doc-1',
            semanticRevision: 'semantic-1'
          }
        ]
      }
    },
    async inspectRun(id) {
      calls.push(['inspect', id])
      return structuredClone(snapshot)
    },
    async validate() {
      return { ok: true, semanticRevision: 'semantic-1' }
    },
    async saveDefinition(id, json) {
      calls.push(['save', json])
      doc.definitionJson = json
      doc.documentRevision = 'doc-2'
      doc.layoutRevision = 'layout-2'
      return structuredClone(doc)
    }
  }
  const f = {
    states: [],
    refs: [],
    memos: [],
    cursor: 0,
    refCursor: 0,
    memoCursor: 0,
    calls,
    doc,
    definition,
    snapshot,
    dict: en,
    flow: {
      getNodes: () => [],
      fitView: async () => true,
      screenToFlowPosition: position => position
    }
  }
  f.t = (k, params = {}) => {
    assert.ok(Object.hasOwn(f.dict, k), `typed dictionary key ${k}`)
    return f.dict[k].replace(/\{([^}]+)\}/g, (_, p) => String(params[p] ?? `{${p}}`))
  }
  const Panel = createBlueprintPanel({
    hostLink: host,
    storage: { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) }
  })
  seat.active = f
  f.shell = Panel({ t: f.t })
  assert.equal(f.shell.type, 'provider')
  const entry = f.shell.children[0]
  f.render = () => {
    seat.active = f
    f.cursor = f.refCursor = f.memoCursor = 0
    return (f.tree = entry.type({ t: f.t }))
  }
  f.render()
  f.workspace = f.states[0]
  assert.ok(f.workspace instanceof BlueprintWorkspace)
  await f.workspace.initialize()
  await f.workspace.load(definition.id)
  f.workspace.runId = snapshot.runId
  await f.workspace.inspect()
  f.calls.length = 0
  f.render()
  return f
}

for (const kind of ['input', 'output', 'condition', 'join', 'humanDecision']) {
  test(`U03 RED actual Panel ${kind} summary excludes ineffective legacy Agent binding`, async () => {
    const f = await fixture(kind),
      editor = f.workspace.editor,
      id = editor.nodes[0].id
    const before = editor.exportDefinition()
    const flow = flowOf(f),
      node = flow.props.nodes.find(n => n.id === id)
    assert.deepEqual(editor.exportDefinition(), before, 'render must retain canonical legacy binding')
    assert.equal(node.data.summary.includes('legacy-synthetic-agent'), false, 'actual Panel summary must follow node capability')
    const view = flow.props.nodeTypes.blueprint({ id, data: node.data, selected: false })
    assert.equal(all(view, n => n.children?.includes('legacy-synthetic-agent')).length, 0)
  })
}
for (const field of ['control', 'inputs', 'outputs']) {
  test(`U05 RED actual BlueprintNode ${field} off removes rows and handles`, async () => {
    const f = await fixture(),
      editor = f.workspace.editor,
      id = editor.nodes[0].id
    const flow = flowOf(f),
      node = flow.props.nodes.find(n => n.id === id)
    // Invoke the actual registered BlueprintNode with copied props; codec and
    // editor export are not bypassed/changed. This isolates render preference.
    const data = {
      ...node.data,
      graphEdges: [],
      inputs: { 'raw.in': 'string' },
      outputs: { 'raw.out': 'string' },
      presentation: { ports: { [field]: false } }
    }
    const view = flow.props.nodeTypes.blueprint({ id, data, selected: false })
    const handles = all(
      view,
      n =>
        n.type === 'handle' &&
        (field === 'control'
          ? n.props.id?.startsWith('control:')
          : n.props.id?.startsWith('data:') && n.props.type === (field === 'inputs' ? 'target' : 'source'))
    )
    assert.equal(handles.length, 0, `${field} handles remain rendered`)
  })
}
test('U05 RED ordinary node without control facts defaults to no control handles', async () => {
  const f = await fixture(),
    flow = flowOf(f),
    node = flow.props.nodes.find(n => n.type === 'blueprint')
  const data = { ...node.data, branches: [], presentation: {} }
  const view = flow.props.nodeTypes.blueprint({ id: node.id, data, selected: false })
  assert.equal(all(view, n => n.type === 'handle' && n.props.id?.startsWith('control:')).length, 0)
})

test('W4.3 RED actual Panel resource detail exposes type/name/config/description and cancel is side-effect free', async () => {
  const f = await fixture(),
    before = f.workspace.editor.exportDefinition(),
    callsBefore = structuredClone(f.calls)
  const tree = f.render(),
    add = one(tree, n => n.props?.['data-bp-action'] === 'add-resource')
  add.props.onClick()
  const opened = f.render(),
    dialog = one(opened, n => n.props?.['data-bp-resource-dialog'] === true)
  const text = JSON.stringify(dialog)
  assert.match(text, /kind|type/i)
  assert.match(text, /description|config|JSON/i)
  assert.ok(
    all(dialog, n => /description/i.test(String(n.children?.[0] ?? n.props?.['aria-label'] ?? ''))).length > 0,
    'resource description must be separately visible'
  )
  const cancel = one(dialog, n => n.props?.['data-bp-action'] === 'resource-cancel')
  cancel.props.onClick()
  f.render()
  assert.equal(all(f.tree, n => n.props?.['data-bp-resource-dialog'] === true).length, 0)
  assert.deepEqual(f.workspace.editor.exportDefinition(), before)
  assert.deepEqual(f.calls, callsBefore)
  assert.equal(f.workspace.editor.canUndo, false)
})

test('W4.3 resource detail exposes source and availability as readonly identity facts', async () => {
  const f = await fixture()
  one(f.render(), n => n.props?.['data-bp-action'] === 'add-resource').props.onClick()
  const dialog = resourceDialogOf(f)
  const source = one(dialog, n => Object.hasOwn(n.props ?? {}, 'data-bp-resource-source'))
  const availability = one(dialog, n => Object.hasOwn(n.props ?? {}, 'data-bp-resource-availability'))
  assert.equal(source.children?.[0], f.t('resource.blueprint'))
  assert.equal(availability.children?.[0], f.t('resource.available'))
})

test('W4.4 resource dialog owns focus and Escape closes through its production handler', async () => {
  const f = await fixture()
  const add = one(f.render(), n => n.props?.['data-bp-action'] === 'add-resource')
  add.props.onClick()
  const dialog = resourceDialogOf(f)
  assert.equal(dialog.props.tabIndex, -1, 'dialog must be programmatically focusable')
  assert.equal(typeof dialog.props.onKeyDown, 'function')
  dialog.props.onKeyDown({ key: 'Escape', preventDefault() {} })
  assert.equal(all(f.render(), n => n.props?.['data-bp-resource-dialog'] === true).length, 0)
})

test('W4.3 RED invalid resource JSON retains draft and kind mismatch is rejected without history', async () => {
  const f = await fixture(),
    add = one(f.render(), n => n.props?.['data-bp-action'] === 'add-resource')
  add.props.onClick()
  let tree = f.render()
  let dialog = one(tree, n => n.props?.['data-bp-resource-dialog'] === true)
  const json = one(dialog, n => n.props?.label === f.t('resource.newJson'))
  json.props.onChange('{invalid json')
  tree = f.render()
  dialog = one(tree, n => n.props?.['data-bp-resource-dialog'] === true)
  const retained = one(dialog, n => n.props?.label === f.t('resource.newJson'))
  assert.equal(retained.props.value, '{invalid json')
  const kind = one(dialog, n => n.type?.name === 'StyledSelect')
  kind.props.onChange({ target: { value: 'mcp' } })
  tree = f.render()
  dialog = one(tree, n => n.props?.['data-bp-resource-dialog'] === true)
  assert.equal(one(dialog, n => n.props?.label === f.t('resource.newJson')).props.value, '{invalid json')
  const apply = one(dialog, n => n.props?.['data-bp-action'] === 'resource-apply')
  apply.props.onClick()
  tree = f.render()
  assert.ok(one(tree, n => n.props?.role === 'alert' || n.props?.['data-bp-resource-dialog'] === true))
  assert.equal(f.workspace.editor.canUndo, false)
})
