import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resourceRows } from '../../src/client/panel.ts'

const ref = (kind, source) => ({ kind, ...(source ? { source } : {}) })
const deepFreeze = value => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

test('W4.2 resource projection keeps categories and cross-kind identities distinct', () => {
  const rows = resourceRows(
    {
      resources: {
        hostAgent: ref('agent', { kind: 'host', id: 'shared-name' }),
        hostSkill: ref('skill', { kind: 'host', id: 'shared-name' }),
        packagePrompt: ref('prompt', { kind: 'package', path: 'prompts/shared-name.md' })
      }
    },
    [
      {
        id: 'shared-name',
        kind: 'agent',
        displayName: 'Shared name',
        description: '',
        source: 'dsh',
        availability: 'available',
        provenance: 'custom'
      },
      {
        id: 'shared-name',
        kind: 'skill',
        displayName: 'Shared name',
        description: '',
        source: 'dsh',
        availability: 'available',
        provenance: 'custom'
      }
    ],
    'current'
  )

  assert.equal(rows.agent.length, 1)
  assert.equal(rows.skill.length, 1)
  assert.equal(rows.other.length, 1)
  assert.notEqual(rows.agent[0].key, rows.skill[0].key)
  assert.equal(rows.other[0].source, 'blueprint')
})

test('W4.2 definition Host refs remain visible with unknown availability while catalog is loading', () => {
  const rows = resourceRows(
    {
      resources: {
        missingAgent: ref('agent', { kind: 'host', id: 'pending-agent' }),
        missingMcp: ref('mcp', { kind: 'host', id: 'pending-mcp' })
      }
    },
    [],
    'loading'
  )

  assert.equal(rows.agent[0].availability, 'unknown')
  assert.equal(rows.mcp[0].availability, 'unknown')
  assert.equal(rows.agent[0].refId, 'missingAgent')
  assert.equal(rows.mcp[0].refId, 'missingMcp')
})

test('resource rows preserve complete mixed-source values, metadata precedence, deduplication and ordering without mutating inputs', () => {
  const definition = deepFreeze({
    resources: {
      linkedAgent: { kind: 'agent', source: { kind: 'host', id: 'shared' }, bindingId: 'agent-binding' },
      duplicateAgent: ref('agent', { kind: 'host', id: 'shared' }),
      linkedSkill: ref('skill', { kind: 'host', id: 'shared' }),
      missingMcp: ref('mcp', { kind: 'host', id: 'missing' }),
      zPackage: { kind: 'prompt', source: { kind: 'package', path: 'prompts/read.md' }, format: 'agent-preset' },
      aShared: ref('script', { kind: 'shared', rootId: 'scripts', path: 'check.js' }),
      legacy: { kind: 'schema', path: 'schemas/result.json', bindingId: 'legacy-binding' }
    },
    presentation: {
      resources: {
        linkedAgent: { title: '  Alpha agent  ', description: 'Presentation description' },
        duplicateAgent: { title: 'Must not duplicate or replace the first reference' },
        linkedSkill: { title: '   ', description: '' },
        missingMcp: { description: 'Missing catalog entry' },
        zPackage: { title: 'Same title' },
        aShared: { title: 'Same title', description: 'Shared description' }
      }
    }
  })
  const catalog = deepFreeze([
    { id: 'unbound', kind: 'agent', displayName: 'Zulu agent', description: 'Host only', availability: 'unavailable', source: 'dsh' },
    { id: 'shared', kind: 'agent', displayName: 'Host agent', description: 'Host description', availability: 'available', source: 'dsh' },
    {
      id: 'shared',
      kind: 'skill',
      displayName: 'Host skill',
      description: 'Suppressed by empty presentation description',
      availability: 'unavailable',
      source: 'dsh'
    }
  ])
  const before = structuredClone({ definition, catalog })
  assert.deepEqual(resourceRows(definition, catalog, 'current'), {
    agent: [
      {
        key: 'dsh:agent:shared',
        id: 'shared',
        kind: 'agent',
        displayName: 'Alpha agent',
        source: 'dsh',
        availability: 'available',
        description: 'Presentation description',
        configuration: { source: 'host', identity: 'shared', bindingId: 'agent-binding' },
        metadata: { titleSource: 'presentation', descriptionSource: 'presentation' },
        refId: 'linkedAgent',
        ref: definition.resources.linkedAgent
      },
      {
        key: 'dsh:agent:unbound',
        id: 'unbound',
        kind: 'agent',
        displayName: 'Zulu agent',
        source: 'dsh',
        availability: 'unavailable',
        description: 'Host only',
        configuration: { source: 'unbound', identity: 'unbound' },
        metadata: { titleSource: 'host', descriptionSource: 'host' }
      }
    ],
    skill: [
      {
        key: 'dsh:skill:shared',
        id: 'shared',
        kind: 'skill',
        displayName: 'Host skill',
        source: 'dsh',
        availability: 'unavailable',
        description: '',
        configuration: { source: 'host', identity: 'shared' },
        metadata: { titleSource: 'host', descriptionSource: 'host' },
        refId: 'linkedSkill',
        ref: definition.resources.linkedSkill
      }
    ],
    mcp: [
      {
        key: 'dsh:mcp:missing',
        id: 'missing',
        kind: 'mcp',
        displayName: 'missing',
        source: 'dsh',
        availability: 'unavailable',
        description: 'Missing catalog entry',
        configuration: { source: 'host', identity: 'missing' },
        metadata: { titleSource: 'reference', descriptionSource: 'presentation' },
        refId: 'missingMcp',
        ref: definition.resources.missingMcp
      }
    ],
    other: [
      {
        key: 'blueprint:legacy',
        id: 'legacy',
        kind: 'schema',
        displayName: 'legacy',
        source: 'blueprint',
        availability: 'available',
        description: '',
        configuration: { source: 'package', identity: 'schemas/result.json', path: 'schemas/result.json', bindingId: 'legacy-binding' },
        metadata: { titleSource: 'reference', descriptionSource: 'none' },
        refId: 'legacy',
        ref: definition.resources.legacy
      },
      {
        key: 'blueprint:aShared',
        id: 'aShared',
        kind: 'script',
        displayName: 'Same title',
        source: 'blueprint',
        availability: 'available',
        description: 'Shared description',
        configuration: { source: 'shared', identity: 'scripts', path: 'check.js' },
        metadata: { titleSource: 'presentation', descriptionSource: 'presentation' },
        refId: 'aShared',
        ref: definition.resources.aShared
      },
      {
        key: 'blueprint:zPackage',
        id: 'zPackage',
        kind: 'prompt',
        displayName: 'Same title',
        source: 'blueprint',
        availability: 'available',
        description: '',
        configuration: { source: 'package', identity: 'prompts/read.md', path: 'prompts/read.md', format: 'agent-preset' },
        metadata: { titleSource: 'presentation', descriptionSource: 'none' },
        refId: 'zPackage',
        ref: definition.resources.zPackage
      }
    ]
  })
  assert.deepEqual({ definition, catalog }, before, 'projection preserves every frozen input field and catalog order')
})

for (const [state, matched, missing] of [
  ['loading', 'unknown', 'unknown'],
  ['current', 'available', 'unavailable'],
  ['unavailable', 'unknown', 'unknown']
]) {
  test(`resource availability distinguishes catalog matches and missing references while ${state}`, () => {
    const definition = deepFreeze({
      resources: {
        matched: ref('agent', { kind: 'host', id: 'known' }),
        missing: ref('mcp', { kind: 'host', id: 'absent' }),
        local: ref('prompt', { kind: 'package', path: 'prompt.md' })
      }
    })
    const catalog = deepFreeze([{ id: 'known', kind: 'agent', displayName: '', availability: 'available' }])
    const before = structuredClone({ definition, catalog })
    const rows = resourceRows(definition, catalog, state)
    assert.equal(rows.agent[0].availability, matched)
    assert.equal(rows.agent[0].displayName, 'known', 'empty Host title falls back to its reference identity')
    assert.equal(rows.mcp[0].availability, missing)
    assert.equal(rows.other[0].availability, 'available', 'catalog state cannot change package availability')
    assert.deepEqual({ definition, catalog }, before)
  })
}

test('resource projection accepts absent and empty definitions without inventing rows', () => {
  for (const definition of [null, deepFreeze({}), deepFreeze({ resources: {} })]) {
    assert.deepEqual(resourceRows(definition, Object.freeze([]), 'loading'), { agent: [], skill: [], mcp: [], other: [] })
  }
})
