import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import test from 'node:test'
import { publishPackage } from '../../src/definition/package-create.ts'
import { definition } from '../feedback-fixtures.mjs'

test('POSIX package publication flushes newly created ancestors and nested file directories before publish', { skip: process.platform === 'win32' }, t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'bp-durable-fs-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const opened = new Map()
  const events = []
  const original = { openSync: fs.openSync, closeSync: fs.closeSync, fsyncSync: fs.fsyncSync, renameSync: fs.renameSync }
  fs.openSync = (...args) => {
    const fd = original.openSync(...args)
    opened.set(fd, String(args[0]))
    return fd
  }
  fs.closeSync = fd => {
    opened.delete(fd)
    return original.closeSync(fd)
  }
  fs.fsyncSync = fd => {
    events.push(['sync', opened.get(fd)])
    return original.fsyncSync(fd)
  }
  fs.renameSync = (from, to) => {
    events.push(['rename', from, to])
    return original.renameSync(from, to)
  }
  syncBuiltinESMExports()
  try {
    const target = join(root, 'workspace/.xuanling/workflows/feedback')
    publishPackage(target, definition(), [{ path: 'lib/nested/value.txt', text: 'value' }])
    const publish = events.findIndex(event => event[0] === 'rename' && event[2] === target)
    for (const directory of [root, join(root, 'workspace'), join(root, 'workspace/.xuanling'), dirname(target)])
      assert.ok(
        events.slice(0, publish).some(event => event[0] === 'sync' && event[1] === directory),
        `missing durable ancestor ${directory}`
      )
    assert.ok(
      events.slice(0, publish).some(event => event[0] === 'sync' && event[1]?.endsWith('/lib/nested')),
      'nested file entry must survive publication'
    )
    assert.ok(events.slice(publish + 1).some(event => event[0] === 'sync' && event[1] === dirname(target)))
  } finally {
    Object.assign(fs, original)
    syncBuiltinESMExports()
  }
})
