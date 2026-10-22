import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { definition, fixture } from '../feedback-fixtures.mjs'
import { WORKFLOW_HOST_APPROVAL } from '../../src/service/apply-service.ts'
import { loadDefinitionDocument, saveDefinitionDocument } from '../../src/definition/persist.ts'

test('resource revert restores bytes including empty files, removes additions, and restores semantic revision', async t => {
  const f = await fixture(t)
  mkdirSync(join(f.workflow, 'lib'), { recursive: true })
  writeFileSync(join(f.workflow, 'lib/a.txt'), 'original')
  writeFileSync(join(f.workflow, 'lib/empty.txt'), '')
  const original = await f.ctx.blueprint.saveDefinition({ blueprintId: 'feedback', definitionJson: JSON.stringify(definition()), expectedRevision: null })
  writeFileSync(join(f.workflow, 'lib/a.txt'), 'edited')
  writeFileSync(join(f.workflow, 'lib/added.txt'), 'added')
  const changed = loadDefinitionDocument(f.workflow)
  const saved = await f.ctx.blueprint.saveDefinition({
    blueprintId: 'feedback',
    definitionJson: JSON.stringify({ ...definition(), name: 'second' }),
    expectedRevision: changed.documentRevision
  })
  const reverted = await f.ctx.blueprint.workflowRevertFromHost({
    workflowId: 'feedback',
    revision: original.documentRevision,
    expectedRevision: saved.documentRevision,
    approval: WORKFLOW_HOST_APPROVAL
  })
  assert.equal(reverted.status, 'applied')
  assert.equal(reverted.document.semanticRevision, original.semanticRevision)
  assert.equal(loadDefinitionDocument(f.workflow).documentRevision, original.documentRevision)
  assert.equal(readFileSync(join(f.workflow, 'lib/a.txt'), 'utf8'), 'original')
  assert.equal(readFileSync(join(f.workflow, 'lib/empty.txt')).length, 0)
  assert.equal(existsSync(join(f.workflow, 'lib/added.txt')), false)
  const publicHistory = await f.ctx.blueprint.workflowRevisions({ workflowId: 'feedback' })
  assert.ok(publicHistory.revisions.length >= 2)
  assert.ok(publicHistory.revisions.every(entry => !Object.hasOwn(entry, 'packageFiles')))
  assert.equal(JSON.stringify(publicHistory).includes(Buffer.from('original').toString('base64')), false)
  const historyIndex = JSON.parse(readFileSync(join(f.workflow, '.revisions', 'index.json'), 'utf8'))
  assert.equal(JSON.stringify(historyIndex).includes('"packageFiles"'), false)
  const originalEntry = JSON.parse(readFileSync(join(f.workflow, '.revisions', `${original.documentRevision}.json`), 'utf8'))
  assert.ok(Object.hasOwn(originalEntry, 'packageFiles'))
})

test('history write failure leaves canonical bytes unchanged; retry succeeds from the same base', async t => {
  const f = await fixture(t)
  mkdirSync(f.workflow, { recursive: true })
  writeFileSync(join(f.workflow, 'blueprint.json'), JSON.stringify(definition()))
  const initial = loadDefinitionDocument(f.workflow)
  const before = readFileSync(join(f.workflow, 'blueprint.json'))
  writeFileSync(join(f.workflow, '.revisions'), 'not a directory')
  assert.throws(() => saveDefinitionDocument(f.workflow, { ...definition(), name: 'changed' }, initial.documentRevision), { code: 'IO_WRITE_FAILED' })
  assert.deepEqual(readFileSync(join(f.workflow, 'blueprint.json')), before)
  rmSync(join(f.workflow, '.revisions'))
  assert.equal(JSON.parse(saveDefinitionDocument(f.workflow, { ...definition(), name: 'changed' }, initial.documentRevision).definitionJson).name, 'changed')
})

test('resource revert rejects a symlinked destination before changing outside bytes', async t => {
  const f = await fixture(t)
  mkdirSync(join(f.workflow, 'lib/nested'), { recursive: true })
  writeFileSync(join(f.workflow, 'lib/nested/a.txt'), 'original')
  const original = await f.ctx.blueprint.saveDefinition({ blueprintId: 'feedback', definitionJson: JSON.stringify(definition()), expectedRevision: null })
  const saved = await f.ctx.blueprint.saveDefinition({
    blueprintId: 'feedback',
    definitionJson: JSON.stringify({ ...definition(), name: 'second' }),
    expectedRevision: original.documentRevision
  })
  const outside = join(f.root, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, 'a.txt'), 'outside')
  rmSync(join(f.workflow, 'lib/nested'), { recursive: true })
  symlinkSync(outside, join(f.workflow, 'lib/nested'), 'dir')
  await assert.rejects(() =>
    f.ctx.blueprint.workflowRevertFromHost({
      workflowId: 'feedback',
      revision: original.documentRevision,
      expectedRevision: saved.documentRevision,
      approval: WORKFLOW_HOST_APPROVAL
    })
  )
  assert.equal(readFileSync(join(outside, 'a.txt'), 'utf8'), 'outside')
})

test('interrupted closure commit replays on reopen before exposing a document', async t => {
  const f = await fixture(t)
  mkdirSync(join(f.workflow, 'lib'), { recursive: true })
  writeFileSync(join(f.workflow, 'lib/a.txt'), 'before')
  const initial = saveDefinitionDocument(f.workflow, definition(), null)
  const rename = fs.renameSync
  fs.renameSync = (from, to) => {
    if (to === join(f.workflow, 'blueprint.json')) throw Object.assign(new Error('injected commit interruption'), { code: 'EIO' })
    return rename(from, to)
  }
  syncBuiltinESMExports()
  try {
    assert.throws(
      () =>
        saveDefinitionDocument(
          f.workflow,
          { ...definition(), name: 'after' },
          initial.documentRevision,
          { origin: 'revert' },
          new Map([['lib/a.txt', Buffer.from('after')]])
        ),
      { code: 'DEFINITION_COMMIT_PENDING' }
    )
  } finally {
    fs.renameSync = rename
    syncBuiltinESMExports()
  }
  const recovered = loadDefinitionDocument(f.workflow)
  assert.equal(JSON.parse(recovered.definitionJson).name, 'after')
  assert.equal(readFileSync(join(f.workflow, 'lib/a.txt'), 'utf8'), 'after')
  assert.equal(loadDefinitionDocument(f.workflow).documentRevision, recovered.documentRevision)
  assert.equal(existsSync(join(f.workflow, '.blueprint-commit.json')), false)
})

test('resource revert restores file and directory shape changes', async t => {
  const f = await fixture(t)
  mkdirSync(join(f.workflow, 'lib/was-dir'), { recursive: true })
  writeFileSync(join(f.workflow, 'lib/was-file'), 'original file')
  writeFileSync(join(f.workflow, 'lib/was-dir/nested.txt'), 'original nested')
  const original = saveDefinitionDocument(f.workflow, definition(), null)
  rmSync(join(f.workflow, 'lib/was-file'))
  mkdirSync(join(f.workflow, 'lib/was-file'))
  writeFileSync(join(f.workflow, 'lib/was-file/added.txt'), 'added')
  rmSync(join(f.workflow, 'lib/was-dir'), { recursive: true })
  writeFileSync(join(f.workflow, 'lib/was-dir'), 'changed to file')
  const base = loadDefinitionDocument(f.workflow)
  const changed = saveDefinitionDocument(f.workflow, { ...definition(), name: 'changed' }, base.documentRevision)
  const result = await f.ctx.blueprint.workflowRevertFromHost({
    workflowId: 'feedback',
    revision: original.documentRevision,
    expectedRevision: changed.documentRevision,
    approval: WORKFLOW_HOST_APPROVAL
  })
  assert.equal(result.status, 'applied')
  assert.equal(readFileSync(join(f.workflow, 'lib/was-file'), 'utf8'), 'original file')
  assert.equal(readFileSync(join(f.workflow, 'lib/was-dir/nested.txt'), 'utf8'), 'original nested')
  assert.equal(loadDefinitionDocument(f.workflow).documentRevision, original.documentRevision)
})

test('layout-only revision reuses its parent package closure for revert', async t => {
  const f = await fixture(t)
  mkdirSync(join(f.workflow, 'lib'), { recursive: true })
  writeFileSync(join(f.workflow, 'lib/a.txt'), 'original')
  const original = await f.ctx.blueprint.saveDefinition({
    blueprintId: 'feedback',
    definitionJson: JSON.stringify(definition()),
    expectedRevision: null
  })
  const layout = await f.ctx.blueprint.saveDefinition({
    blueprintId: 'feedback',
    definitionJson: JSON.stringify({ ...definition(), presentation: { nodes: {} } }),
    expectedRevision: original.documentRevision
  })
  const layoutEntry = JSON.parse(readFileSync(join(f.workflow, '.revisions', `${layout.documentRevision}.json`), 'utf8'))
  assert.equal(Object.hasOwn(layoutEntry, 'packageFiles'), false)
  const history = await f.ctx.blueprint.workflowRevisions({ workflowId: 'feedback' })
  assert.ok(history.revisions.every(entry => !Object.hasOwn(entry, 'packageFiles')))
  const back = await f.ctx.blueprint.saveDefinition({
    blueprintId: 'feedback',
    definitionJson: JSON.stringify(definition()),
    expectedRevision: layout.documentRevision
  })
  const reverted = await f.ctx.blueprint.workflowRevertFromHost({
    workflowId: 'feedback',
    revision: layout.documentRevision,
    expectedRevision: back.documentRevision,
    approval: WORKFLOW_HOST_APPROVAL
  })
  assert.equal(reverted.status, 'applied')
  assert.equal(readFileSync(join(f.workflow, 'lib/a.txt'), 'utf8'), 'original')
})
