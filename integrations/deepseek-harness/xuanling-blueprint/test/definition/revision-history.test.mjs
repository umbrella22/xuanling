import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readRevisionHistory } from '../../src/definition/persist.ts'

const v2 = {
  schemaVersion: 2,
  id: 'history-test',
  name: 'History test',
  resources: {},
  graph: { nodes: [{ id: 'input', kind: 'input', outputs: { value: 'string' } }], edges: [] }
}

function writeHistory(root, entry) {
  const revisions = join(root, '.revisions')
  mkdirSync(revisions, { recursive: true })
  writeFileSync(join(revisions, 'index.json'), `${JSON.stringify({ schemaVersion: 1, entries: [entry] })}\n`)
}

function entry(definitionJson = JSON.stringify(v2)) {
  return {
    schemaVersion: 1,
    revision: 'revision-1',
    parentRevision: null,
    createdAt: 1,
    origin: 'canvas',
    document: {
      blueprintId: 'history-test',
      definitionJson,
      documentRevision: 'revision-1',
      semanticRevision: 'semantic-1',
      layoutRevision: 'layout-1'
    }
  }
}

test('revision history rejects unknown entry fields before exposing persisted state', () => {
  const root = mkdtempSync(join(tmpdir(), 'bp-revision-history-'))
  try {
    writeHistory(root, { ...entry(), unexpected: true })
    assert.throws(
      () => readRevisionHistory(root),
      error => error?.code === 'REVISION_HISTORY_INVALID'
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('revision history rejects v1 definition material even when the entry envelope is shaped correctly', () => {
  const root = mkdtempSync(join(tmpdir(), 'bp-revision-history-'))
  try {
    writeHistory(root, entry(JSON.stringify({ ...v2, schemaVersion: 1 })))
    assert.throws(
      () => readRevisionHistory(root),
      error => error?.code === 'REVISION_HISTORY_INVALID'
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
