/** BP-02 contract example: a strict implementation report rejects placeholders
 * and missing receipts at the schema boundary, and the shipped example opts
 * into the BP-01 capability declaration. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { assertObjectJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { decodeDefinition } from '../../src/definition/codec.ts'
import { validateDefinition } from '../../src/definition/validator.ts'

const schema = JSON.parse(readFileSync(new URL('../../examples/repository-implementation/lib/schemas/implementation-report.json', import.meta.url), 'utf8'))
const example = JSON.parse(readFileSync(new URL('../../examples/code-review/blueprint.json', import.meta.url), 'utf8'))

test('BP-02 implementation report is a supported object schema', () => {
  assert.doesNotThrow(() => assertObjectJsonSchema(schema))
})

test('BP-02 placeholder and incomplete reports fail the delivery contract', () => {
  for (const rejected of [
    { text: 'placeholder' },
    { outcome: 'delivered', checkout: 'HEAD', commands: [], blockers: [] },
    { outcome: 'delivered', checkout: 'HEAD', commands: [{ command: 'pnpm test' }], receipts: ['r'], blockers: [] },
    { outcome: 'delivered', checkout: 'HEAD', commands: [], receipts: [], blockers: [], extra: true }
  ]) {
    assert.ok(validateJsonSchemaValue(schema, rejected).length > 0, `${JSON.stringify(rejected)} must not satisfy the contract`)
  }
  assert.deepEqual(
    validateJsonSchemaValue(schema, {
      outcome: 'delivered',
      checkout: 'bd42f69',
      commands: [{ command: 'pnpm test', exitCode: 0 }],
      receipts: ['docs/plans/example-execution-ledger.md'],
      blockers: []
    }),
    []
  )
})

test('BP-01 shipped code-review example declares its repository capability', () => {
  const definition = decodeDefinition(JSON.stringify(example))
  validateDefinition(definition)
  assert.deepEqual(definition.graph.nodes.find(node => node.id === 'review').requiredCapabilities, ['repository-read'])
})
