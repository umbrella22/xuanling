import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { isLogicalWorkflowId, libraryDocumentRoot, libraryIds } from '../../src/definition/library.ts'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bp-workspace-root-'))
  return {
    root,
    workflowRoot: join(root, '.xuanling', 'workflows'),
    outside: join(root, 'outside'),
    cleanup: () => rmSync(root, { recursive: true, force: true })
  }
}

test('P0 workspace root maps logical IDs to .xuanling/workflows without accepting path fragments', () => {
  const f = fixture()
  try {
    mkdirSync(f.workflowRoot, { recursive: true })
    mkdirSync(join(f.workflowRoot, 'code-review'), { recursive: true })
    writeFileSync(join(f.workflowRoot, 'code-review', 'blueprint.json'), '{}')
    assert.equal(isLogicalWorkflowId('code-review'), true)
    assert.equal(isLogicalWorkflowId('team/review'), false)
    assert.equal(isLogicalWorkflowId('../outside'), false)
    assert.equal(isLogicalWorkflowId('/tmp/escape'), false)
    assert.equal(libraryDocumentRoot(f.workflowRoot, 'code-review'), resolve(f.workflowRoot, 'code-review'))
    assert.deepEqual(libraryIds(f.workflowRoot), ['code-review'])
    assert.equal(libraryDocumentRoot(f.workflowRoot, '../outside'), undefined)
    assert.equal(libraryDocumentRoot(f.workflowRoot, '/tmp/escape'), undefined)
  } finally {
    f.cleanup()
  }
})

test('P0 workspace root rejects workflow directory symlink escape before writes', () => {
  const f = fixture()
  try {
    mkdirSync(f.workflowRoot, { recursive: true })
    mkdirSync(f.outside, { recursive: true })
    symlinkSync(f.outside, join(f.workflowRoot, 'escaped'))
    assert.throws(() => libraryDocumentRoot(f.workflowRoot, 'escaped'), { code: 'PACKAGE_BOUNDARY_REJECTED' })
  } finally {
    f.cleanup()
  }
})
