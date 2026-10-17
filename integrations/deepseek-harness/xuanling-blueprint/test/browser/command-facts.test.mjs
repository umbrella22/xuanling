import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveCommandFacts } from '../../src/client/shared/controls/command-facts.ts'

const input = () => ({
  editor: {
    selection: new Set(['a']),
    nodes: [{ id: 'a', presentation: { pinned: false } }],
    groups: [{ id: 'g', nodeIds: ['a'] }],
    canUndo: false,
    canRedo: true
  },
  targetGroupId: 'g',
  selectedEdges: 2,
  canvasFocused: true,
  hasDefinition: true,
  busy: false,
  canvasLocked: false,
  canPaste: true,
  canRun: true,
  canCancel: false,
  canOpen: true,
  canRefreshDefinitions: true
})
test('pure command facts sample current editor, group and capability values without retaining output', () => {
  const value = input(),
    before = structuredClone(value)
  const first = deriveCommandFacts(value)
  assert.equal(first.selectedGroups, 1)
  assert.equal(first.selectedNodes, 0)
  assert.equal(first.selectedEdges, 0)
  assert.equal(first.movableNodes, 1)
  assert.deepEqual(value, before)
  first.canRun = false
  value.editor.nodes[0].presentation.pinned = true
  value.editor.canUndo = true
  assert.equal(deriveCommandFacts(value).movableNodes, 0)
  assert.equal(deriveCommandFacts(value).canUndo, true)
  assert.equal(deriveCommandFacts(value).canRun, true)
  value.editor.groups = []
  value.editor.selection = new Set(['missing'])
  const next = deriveCommandFacts(value)
  assert.equal(next.selectedGroups, 0)
  assert.equal(next.selectedNodes, 1)
  assert.equal(next.selectedEdges, 2)
  assert.equal(next.movableNodes, 0)
})
