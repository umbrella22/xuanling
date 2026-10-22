import assert from 'node:assert/strict'
import test from 'node:test'
import * as ui from '../../src/client/features/authoring/logic/graph/flow-interactions.ts'
import { GraphEditor } from '../../src/client/features/authoring/logic/graph/graph-editor.ts'

const definition = () => ({
  schemaVersion: 2,
  id: 'flow',
  name: 'Flow',
  resources: {},
  graph: {
    nodes: [
      { id: 'a', kind: 'input', outputs: { raw: 'string' } },
      { id: 'b', kind: 'output', inputs: { raw: 'string' } }
    ],
    edges: [{ kind: 'data', from: 'a.raw', to: 'b.raw' }]
  },
  presentation: { nodes: { a: { x: 20, y: 30 }, b: { x: 400, y: 80 } } }
})
const setup = () => {
  const editor = GraphEditor.fromDefinition(definition())
  editor.setSelection(['a'])
  const context = { editor, blueprintId: 'flow', documentRevision: 'v1', busy: false, locked: false, composing: false }
  return { editor, context, controller: new ui.CanvasInteractions(() => context) }
}
test('W2 production module loads but editing controller must exist', () => {
  assert.equal(typeof ui.applyCanvasNodeChanges, 'function')
  assert.equal(typeof ui.CanvasInteractions, 'function', 'W2_UI_CONTROLLER_MISSING')
  assert.equal(typeof ui.compatibleSearchNodes, 'function', 'W2_LINK_DROP_SEARCH_MISSING')
})
test('C03 typed search filters declared ports; add and connect has one undo', () => {
  const { editor, controller } = setup(),
    before = editor.exportDefinition()
  const from = { nodeId: 'a', port: 'raw', direction: 'out', kind: 'data', type: 'string' }
  assert.ok(!ui.compatibleSearchNodes('', from).some(n => n.kind === 'input' || n.kind === 'condition'))
  const added = controller.add('output', { x: 250, y: 90 }, from)
  assert.ok(added)
  assert.equal(editor.edges.length, 2)
  editor.undo()
  assert.deepEqual(editor.exportDefinition(), before)
  assert.equal(editor.canUndo, false)
})
test('C04 actual clipboard adapter write-before-cut and permission failure retain graph', async () => {
  const { editor, controller } = setup(),
    before = editor.exportDefinition()
  let release
  const writes = [],
    clipboard = {
      writeText: text => {
        writes.push(text)
        return new Promise(resolve => (release = resolve))
      }
    }
  const pending = controller.clipboard('cut', clipboard, { x: 0, y: 0 })
  assert.deepEqual(editor.exportDefinition(), before)
  assert.equal(writes.length, 1)
  release()
  assert.equal((await pending).ok, true)
  assert.equal(editor.nodes.length, 1)
  editor.undo()
  assert.deepEqual(editor.exportDefinition(), before)
  editor.setSelection(['a'])
  const denied = await controller.clipboard(
    'cut',
    {
      writeText: async () => {
        throw new Error('denied')
      }
    },
    { x: 0, y: 0 }
  )
  assert.equal(denied.code, 'clipboard-unavailable')
  assert.deepEqual(editor.exportDefinition(), before)
})
for (const drift of ['selection', 'document', 'editor', 'cancel', 'busy', 'lock', 'composition', 'edit-undo']) {
  test(`C04 clipboard late result rejects ${drift}`, async () => {
    const { editor, context, controller } = setup()
    let release
    const pending = controller.clipboard('paste', { readText: () => new Promise(resolve => (release = resolve)) }, { x: 1, y: 2 })
    if (drift === 'selection') editor.setSelection(['b'])
    if (drift === 'document') context.documentRevision = 'v2'
    if (drift === 'editor') context.editor = GraphEditor.fromDefinition(definition())
    if (drift === 'cancel') controller.cancel()
    if (drift === 'busy') context.busy = true
    if (drift === 'lock') context.locked = true
    if (drift === 'composition') context.composing = true
    if (drift === 'edit-undo') {
      editor.patchPresentation(['a'], { title: 'temporary' })
      editor.undo()
      editor.setSelection(['a'])
    }
    const before = context.editor.exportDefinition()
    release(JSON.stringify(editor.createClipboard(['a'])))
    assert.equal((await pending).code, 'clipboard-stale')
    assert.deepEqual(context.editor.exportDefinition(), before)
    controller.dispose()
  })
}
test('C05 routing preview/cancel/commit never changes graph and commits one history', () => {
  const { editor, controller } = setup(),
    before = editor.exportDefinition(),
    id = editor.edges[0].id
  controller.beginRoute(id)
  controller.previewRoute([{ x: 220, y: 100 }])
  assert.deepEqual(editor.exportDefinition(), before)
  controller.cancel()
  assert.deepEqual(editor.exportDefinition(), before)
  assert.equal(editor.canUndo, false)
  controller.beginRoute(id)
  controller.previewRoute([{ x: 222.5, y: 111.25 }])
  controller.commitGesture()
  assert.deepEqual(editor.exportDefinition().graph, before.graph)
  assert.deepEqual(editor.edges[0].points, [{ x: 222.5, y: 111.25 }])
  editor.undo()
  assert.deepEqual(editor.exportDefinition(), before)
  assert.equal(editor.canUndo, false)
})
test('C06 resize preview cancels and commits atomically; pin and busy guards stop gestures', () => {
  const { editor, controller, context } = setup(),
    before = editor.exportDefinition()
  controller.beginResize('a')
  controller.previewResize({ width: 350, height: 240 })
  controller.cancel()
  assert.deepEqual(editor.exportDefinition(), before)
  controller.beginResize('a')
  controller.previewResize({ width: 350, height: 240 })
  controller.commitGesture()
  assert.equal(editor.nodes[0].presentation.width, 350)
  editor.undo()
  assert.deepEqual(editor.exportDefinition(), before)
  context.busy = true
  assert.equal(controller.beginResize('a'), false)
  assert.equal(controller.add('output', { x: 0, y: 0 }), null)
  context.busy = false
  editor.patchPresentation(['a'], { pinned: true })
  assert.equal(controller.beginDrag(['a'], false), false)
})
test('C04 Alt clone moves new nodes only and contributes one undo', () => {
  const { editor, controller } = setup(),
    before = editor.exportDefinition()
  controller.beginDrag(['a'], true)
  controller.previewDrag(80, 20)
  controller.commitGesture()
  assert.equal(editor.nodes.length, 3)
  assert.equal(editor.nodes[0].x, 20)
  assert.equal(editor.nodes[2].x, 100)
  editor.undo()
  assert.deepEqual(editor.exportDefinition(), before)
  assert.equal(editor.canUndo, false)
})
test('C05 Shift reconnect copies and invalid reconnect retains ID/points/history', () => {
  const { editor, controller } = setup()
  controller.add('output', { x: 500, y: 500 })
  const id = editor.edges[0].id,
    before = editor.exportDefinition(),
    target = editor.nodes.at(-1).id
  const from = { nodeId: 'a', port: 'raw', direction: 'out', kind: 'data', type: 'string' }
  const to = { nodeId: target, port: 'input', direction: 'in', kind: 'data', type: 'string' }
  assert.equal(controller.reconnect(id, from, { ...to, type: 'number' }, false).ok, false)
  assert.deepEqual(editor.exportDefinition(), before)
  assert.equal(controller.reconnect(id, from, to, true).ok, true)
  assert.equal(editor.edges.length, 2)
  assert.equal(editor.edges[0].id, id)
  assert.equal(editor.edges[0].to, 'b.raw')
  editor.undo()
  assert.deepEqual(editor.exportDefinition(), before)
})
test('C02 clipboard copy remains available with locked canvas, while cut/paste remain disabled by the same policy', async () => {
  const { editor, controller, context } = setup(),
    before = editor.exportDefinition(),
    writes = []
  context.locked = true
  const clipboard = { writeText: async text => writes.push(text), readText: async () => writes[0] }
  assert.equal((await controller.clipboard('copy', clipboard, { x: 0, y: 0 })).ok, true)
  assert.equal(writes.length, 1)
  assert.equal((await controller.clipboard('cut', clipboard, { x: 0, y: 0 })).ok, false)
  assert.equal((await controller.clipboard('paste', clipboard, { x: 0, y: 0 })).ok, false)
  assert.deepEqual(editor.exportDefinition(), before)
  assert.equal(editor.canUndo, false)
})
