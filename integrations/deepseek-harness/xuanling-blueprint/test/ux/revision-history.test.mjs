import assert from 'node:assert/strict'
import test from 'node:test'
import {
  readRevisionEntries,
  revisionResourceFilesChanged,
  summarizeDefinitionDiff
} from '../../src/client/features/authoring/logic/history/revision-history.ts'
import { isRecoveryLifecycleConflict, nodeResourceRefs } from '../../src/client/features/authoring/ui/panel/run-insights.tsx'
import { BlueprintRemoteError } from '../../src/client/adapters/host/remote.ts'
import { zh, en, REPORT_GUIDANCE_CODES } from '../../src/client/shared/i18n/history.ts'
import { REPORT_GUIDANCE } from '../../src/conversation/run-report.ts'

// Schema-v2 production shapes: an edge is { kind, from: string, to: string }.
const base = {
  schemaVersion: 2,
  id: 'flow',
  name: 'Flow',
  resources: { reviewer: { kind: 'agent', path: 'lib/reviewer.md' } },
  graph: {
    nodes: [
      { id: 'input', kind: 'input' },
      { id: 'review', kind: 'agentTask', agentRef: 'reviewer' }
    ],
    edges: [{ kind: 'data', from: 'input.value', to: 'review.in' }]
  },
  presentation: { nodes: { input: { x: 0, y: 0 }, review: { x: 1, y: 0 } } }
}
const json = value => JSON.stringify(value)

test('revision diff separates semantic, layout-only and identical changes', () => {
  const identical = summarizeDefinitionDiff(json(base), json(base))
  assert.equal(identical.identical, true)
  assert.equal(identical.semanticChanged, false)
  assert.equal(identical.metadataChanged, false)
  const moved = { ...base, presentation: { nodes: { input: { x: 5, y: 0 }, review: { x: 1, y: 0 } } } }
  const layout = summarizeDefinitionDiff(json(base), json(moved))
  assert.equal(layout.layoutOnly, true)
  assert.equal(layout.identical, false)
  assert.equal(layout.semanticChanged, false)
  assert.equal(layout.metadataChanged, false)
  const changed = {
    ...base,
    name: 'Flow 2',
    resources: { reviewer: { kind: 'agent', path: 'lib/reviewer-v2.md' }, schema: { kind: 'schema', path: 'lib/out.json' } },
    graph: { nodes: [base.graph.nodes[0], { ...base.graph.nodes[1], toolAllowlist: ['read'] }, { id: 'out', kind: 'output' }], edges: [] }
  }
  const diff = summarizeDefinitionDiff(json(base), json(changed))
  assert.equal(diff.nameChanged, true)
  assert.equal(diff.metadataChanged, false)
  assert.equal(diff.semanticChanged, true)
  assert.deepEqual(diff.nodesAdded, ['out'])
  assert.deepEqual(diff.nodesChanged, ['review'])
  assert.deepEqual(diff.nodesRemoved, [])
  assert.equal(diff.edgesRemoved, 1)
  assert.deepEqual(diff.resourcesAdded, ['schema'])
  assert.deepEqual(diff.resourcesChanged, ['reviewer'])
  assert.equal(diff.layoutOnly, false)
})

test('metadata-only changes are classified instead of looking identical or layout-only', () => {
  const metadata = summarizeDefinitionDiff(json(base), json({ ...base, metadata: { example: true } }))
  assert.equal(metadata.metadataChanged, true)
  assert.equal(metadata.semanticChanged, true)
  assert.equal(metadata.identical, false)
  assert.equal(metadata.layoutOnly, false)
  // A file-format version difference is never presentation-only.
  const version = summarizeDefinitionDiff(json(base), json({ ...base, schemaVersion: 1 }))
  assert.equal(version.metadataChanged, true)
  assert.equal(version.semanticChanged, true)
  assert.equal(version.layoutOnly, false)
})

test('a semanticRevision-only difference on an identical definition means packaged files differ', () => {
  const currentSemanticRevision = 'sem-current'
  const entrySemanticRevision = 'sem-entry'
  const filesChanged = overrides =>
    revisionResourceFilesChanged({
      isCurrent: false,
      semanticChanged: false,
      entrySemanticRevision,
      currentSemanticRevision,
      ...overrides
    })
  assert.equal(filesChanged(), true)
  // The current revision is not a restore target.
  assert.equal(filesChanged({ isCurrent: true }), false)
  // A structural difference already explains the semanticRevision difference;
  // never claim packaged files changed on top of it.
  assert.equal(filesChanged({ semanticChanged: true }), false)
  // Legacy entries without semanticRevision cannot be classified.
  assert.equal(filesChanged({ entrySemanticRevision: undefined }), false)
  assert.equal(filesChanged({ currentSemanticRevision: undefined }), false)
  // Equal semantic revisions imply the same package closure (layout-only revisions
  // inherit their parent closure); no file change is reported.
  assert.equal(filesChanged({ entrySemanticRevision: currentSemanticRevision }), false)
  const layout = summarizeDefinitionDiff(json(base), json({ ...base, presentation: { nodes: {} } }))
  assert.equal(layout.layoutOnly, true)
  assert.equal(filesChanged({ semanticChanged: layout.semanticChanged }), true)
})

test('revision entries are narrowed, malformed rows dropped, newest first', () => {
  const entries = readRevisionEntries({
    revisions: [
      { revision: 'a', parentRevision: null, createdAt: 1, origin: 'canvas', document: { definitionJson: '{}', semanticRevision: 'sem-a' } },
      { revision: 'bad', createdAt: 'x' },
      {
        revision: 'b',
        parentRevision: 'a',
        createdAt: 2,
        origin: 'conversation',
        message: 'm',
        document: { definitionJson: '{}', semanticRevision: 'sem-b', documentRevision: 'b' }
      },
      { revision: 'legacy', parentRevision: null, createdAt: 0, origin: 'import', document: { definitionJson: '{}' } }
    ]
  })
  assert.deepEqual(
    entries.map(entry => entry.revision),
    ['b', 'a', 'legacy']
  )
  assert.equal(entries[0].message, 'm')
  assert.equal(entries[0].semanticRevision, 'sem-b')
  assert.equal(entries[1].semanticRevision, 'sem-a')
  assert.equal(entries[2].semanticRevision, undefined)
  assert.deepEqual(readRevisionEntries(null), [])
})

test('node resource refs collect *Ref, *Refs and TeamStage member agentRefs once', () => {
  assert.deepEqual(nodeResourceRefs({ id: 'n', agentRef: 'a', skillRefs: ['s1', 's2', 'a'], outputSchemaRef: 'o', label: 'x' }), ['a', 's1', 's2', 'o'])
  assert.deepEqual(
    nodeResourceRefs({
      id: 'team',
      kind: 'agentTask',
      skillRefs: ['shared-skill', 'shared-skill'],
      teamStage: {
        task: { subject: 'Review', description: 'Review the change' },
        members: [
          { name: 'one', description: 'd', agentRef: 'member-a', context: 'fresh' },
          { name: 'two', description: 'd', agentRef: 'member-b', context: 'fork' },
          { name: 'bad', description: 'd', agentRef: 42 }
        ],
        requiredChecks: ['check']
      }
    }),
    ['shared-skill', 'member-a', 'member-b']
  )
  // The revision projection is untrusted input: tolerate malformed teamStage shapes.
  assert.deepEqual(nodeResourceRefs({ id: 'n', teamStage: 'invalid' }), [])
  assert.deepEqual(nodeResourceRefs({ id: 'n', teamStage: { members: 'invalid' } }), [])
  assert.deepEqual(nodeResourceRefs({ id: 'n', teamStage: { members: [null, { agentRef: 'm' }] } }), ['m'])
})

test('only a typed lifecycle conflict triggers an authoring recovery re-read', () => {
  assert.equal(isRecoveryLifecycleConflict(new BlueprintRemoteError('blueprint/run-lifecycle-conflict')), true)
  assert.equal(isRecoveryLifecycleConflict(new BlueprintRemoteError('blueprint/remote-failed')), false)
  assert.equal(isRecoveryLifecycleConflict(new Error('boom')), false)
  assert.equal(isRecoveryLifecycleConflict(undefined), false)
  assert.equal(isRecoveryLifecycleConflict(null), false)
})

test('client report guidance covers every Host report code in both locales', () => {
  assert.deepEqual([...REPORT_GUIDANCE_CODES].sort(), Object.keys(REPORT_GUIDANCE).sort())
  for (const code of REPORT_GUIDANCE_CODES) {
    for (const field of ['why', 'avoid']) {
      assert.ok(zh[`report.code.${code}.${field}`], `zh ${code}.${field}`)
      assert.equal(en[`report.code.${code}.${field}`], REPORT_GUIDANCE[code][field], `en mirrors Host text for ${code}.${field}`)
    }
  }
})
