import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, symlinkSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BlueprintTemplateStore } from '../../src/templates/store.ts'

const template = {
  schemaVersion: 1,
  templateId: 'tpl-boundary',
  name: 'Docs',
  pattern: {},
  parameters: [],
  requirements: { discovery: [], roles: [], resources: [], acceptance: [] },
  provenance: { sourceAsset: null, sourceRevision: null, extractedAt: '2026-10-27', residualNotes: [] }
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'bp-template-boundary-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'outside'))
  return root
}

test('review: template and preparation writes reject symlink destinations', t => {
  const root = fixture(t)
  mkdirSync(join(root, 'library', 'templates'), { recursive: true })
  symlinkSync(join(root, 'outside'), join(root, 'library', 'templates', template.templateId), 'dir')
  assert.throws(() => new BlueprintTemplateStore(join(root, 'library')).save(template, 'r'))
  assert.equal(existsSync(join(root, 'outside', 'template.json')), false)
  mkdirSync(join(root, 'project', '.xuanling'), { recursive: true })
  symlinkSync(join(root, 'outside'), join(root, 'project', '.xuanling', 'preparations'), 'dir')
  assert.throws(() =>
    BlueprintTemplateStore.writeManifest(join(root, 'project', '.xuanling', 'preparations'), {
      schemaVersion: 1,
      preparationId: 'prep-one',
      target: { workspaceId: 'w' },
      templateId: template.templateId,
      facts: [],
      bindings: [],
      unresolved: [],
      generated: null,
      status: 'needs_input',
      revision: 1
    })
  )
  assert.equal(existsSync(join(root, 'outside', 'prep-one.json')), false)
})

test('review: duplicate template save replays and changed request cannot overwrite', t => {
  const root = fixture(t),
    store = new BlueprintTemplateStore(join(root, 'library'))
  const first = store.save(template, 'same-request')
  assert.deepEqual(store.save(template, 'same-request'), first)
  assert.throws(
    () => store.save({ ...template, name: 'Changed' }, 'same-request'),
    error => error.code === 'blueprint/template-invalid'
  )
  assert.throws(
    () => store.save({ ...template, templateId: 'tpl-other' }, 'same-request'),
    error => error.code === 'blueprint/template-invalid'
  )
  assert.equal(store.load(template.templateId).name, 'Docs')
})
