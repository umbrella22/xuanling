import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createReportDir,
  validateNewReportDir,
  validateCollectorGate,
  PLAN_ID,
  secretCategories,
  errorCategory
} from '../../../../../test/blueprint/capabilities/conversation-evidence.mjs'

test('fresh report refuses existing, traversal, symlink and dangling symlink paths', () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'conversation-path-test-'))
  try {
    const report = createReportDir(join(root, 'new'), root)
    assert.throws(() => validateNewReportDir(report, root), /REPORT_ALREADY_EXISTS/)
    assert.throws(() => validateNewReportDir(join(root, '..', 'escape'), root), /REPORT_OUTSIDE_ROOT/)
    assert.throws(() => validateNewReportDir(`${root}/a/../new2`, root), /REPORT_OUTSIDE_ROOT/)
    symlinkSync(join(root, 'new'), join(root, 'link'))
    assert.throws(() => validateNewReportDir(join(root, 'link', 'child'), root), /PATH_SYMLINK/)
    symlinkSync(join(root, 'absent'), join(root, 'dangling'))
    assert.throws(() => validateNewReportDir(join(root, 'dangling'), root), /PATH_SYMLINK/)
    assert.throws(() => validateNewReportDir(root, root), /REPORT_OUTSIDE_ROOT/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('synthetic passed receipt cannot substitute for native browser and provider evidence', () => {
  const fp = { revision: 'a'.repeat(40), source_sha256: 'b'.repeat(64), artifact_sha256: 'c'.repeat(64) }
  assert.throws(
    () =>
      validateCollectorGate({ planId: PLAN_ID, mode: 'live', status: 'passed', cases: [] }, { reportDir: '/absent', fingerprint: fp, fingerprintAfter: fp }),
    /EVIDENCE_/
  )
})

test('upstream failure output and secret findings expose categories only', () => {
  const value = `sk-${'a'.repeat(30)}`
  assert.equal(errorCategory(new Error(value)), 'CONVERSATION_OPERATION_FAILED')
  assert.equal(errorCategory({ code: 'HOST_BOOT_TIMEOUT', message: value }), 'HOST_BOOT_TIMEOUT')
  assert.deepEqual(secretCategories(value), ['api-key'])
  assert.ok(!JSON.stringify(secretCategories(`https://localhost/?token=${value}`)).includes(value))
})
