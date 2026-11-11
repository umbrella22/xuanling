/** BP-01 contract: a repository-shaped task can declare the capabilities it
 * needs, and the definition boundary rejects typos, duplicates and fields on
 * node kinds that cannot execute them. Preflight enforcement is covered by
 * test/runtime-contracts/required-capabilities.test.mjs. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeDefinition } from '../../src/definition/codec.ts'
import { validateDefinition } from '../../src/definition/validator.ts'
import { ClipboardError, decodeClipboard } from '../../src/client/features/authoring/logic/graph/clipboard.ts'

const resources = { worker: { kind: 'agent', path: 'lib/agents/worker.md' } }
const workNode = (extra = {}) => ({ id: 'work', kind: 'agentTask', agentRef: 'worker', ...extra })
const raw = (extra = {}) => ({
  schemaVersion: 2,
  id: 'required-capabilities',
  name: 'Required capabilities',
  resources,
  graph: {
    nodes: [workNode(extra)],
    edges: []
  },
  presentation: { nodes: {} }
})
const decode = value => decodeDefinition(JSON.stringify(value))
const issuesOf = value => {
  try {
    validateDefinition(decode(value))
    return []
  } catch (error) {
    return error.issues ?? []
  }
}
const clipboard = extra => ({
  version: 1,
  sourceBlueprintId: 'required-capabilities',
  nodes: [workNode(extra)],
  edges: [],
  incoming: [],
  resources,
  presentation: { nodes: {} }
})

test('BP-01 required capabilities decode strictly and survive validation', () => {
  const definition = decode(raw({ requiredCapabilities: ['repository-read', 'command-exec'] }))
  validateDefinition(definition)
  assert.deepEqual(definition.graph.nodes[0].requiredCapabilities, ['repository-read', 'command-exec'])
})

test('BP-01 unknown or empty capability vocabulary fails at definition decode', () => {
  for (const [value, pointer] of [
    [['repo-read'], '/graph/nodes/0/requiredCapabilities/0'],
    [[], '/graph/nodes/0/requiredCapabilities']
  ]) {
    assert.throws(
      () => decode(raw({ requiredCapabilities: value })),
      error => error.code === 'DEFINITION_INVALID' && error.issues.some(issue => issue.pointer === pointer),
      `${JSON.stringify(value)} must fail closed with its pointer`
    )
  }
})

test('BP-01 capabilities belong to agentTask only', () => {
  const issues = issuesOf(raw({ kind: 'input', requiredCapabilities: ['repository-read'] }))
  assert.ok(issues.some(issue => issue.code === 'invalid-value' && issue.pointer === '/graph/nodes/0/requiredCapabilities'))
})

test('BP-01 duplicate capabilities are semantic issues, not silent sets', () => {
  const issues = issuesOf(raw({ requiredCapabilities: ['repository-read', 'repository-read'] }))
  assert.ok(issues.some(issue => issue.code === 'duplicate-id' && issue.pointer === '/graph/nodes/0/requiredCapabilities/1'))
})

test('BP-01 clipboard preserves the declared capabilities and rejects invalid ones', () => {
  assert.deepEqual(decodeClipboard(clipboard({ requiredCapabilities: ['command-exec'] })).nodes[0].requiredCapabilities, ['command-exec'])
  for (const requiredCapabilities of [['not-a-capability'], [], ['repository-read', 'repository-read']]) {
    assert.throws(
      () => decodeClipboard(clipboard({ requiredCapabilities })),
      error => error instanceof ClipboardError && error.pointer === '/nodes/0/requiredCapabilities',
      `${JSON.stringify(requiredCapabilities)} must not enter the clipboard`
    )
  }
})
