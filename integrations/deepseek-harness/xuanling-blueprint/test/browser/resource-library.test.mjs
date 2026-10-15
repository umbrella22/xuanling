import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resourceRows } from '../../src/client/panel.ts'

const ref = (kind, source) => ({ kind, ...(source ? { source } : {}) })

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
