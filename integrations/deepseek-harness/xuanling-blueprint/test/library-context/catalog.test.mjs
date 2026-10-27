/**
 * T01 (C-01): cascade library discovery.
 *
 * Red target: a multi-workspace profile with no default workspace currently
 * fails every library read with `blueprint/capability-unavailable`, and there
 * is no per-workspace library projection at all.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { libraryFixture } from './fixtures.mjs'
import { BLUEPRINT_INVOCATIONS } from '../../src/typert-descriptors.ts'

test('T01: discovers global and every registered workspace library without a default workspace', async t => {
  const f = await libraryFixture(t, {
    workspaces: [
      { id: 'ws-ready', title: 'Alpha Docs', assets: ['bp-ready'] },
      { id: 'ws-empty', title: 'Beta Empty', emptyWorkflows: true },
      { id: 'ws-absent', title: 'Gamma Absent', absent: true }
    ],
    globalAssets: ['bp-shared']
  })

  assert.equal(typeof f.service.listBlueprintLibraries, 'function', 'public library API is absent')
  const value = await f.service.listBlueprintLibraries()
  const libraries = value.libraries

  assert.equal(libraries[0].library.kind, 'global', 'global library must be first')
  assert.equal(libraries[0].status, 'ready')
  assert.deepEqual(
    libraries[0].assets.map(asset => asset.blueprintId),
    ['bp-shared']
  )

  const byId = new Map(libraries.filter(row => row.library.kind === 'workspace').map(row => [row.library.workspaceId, row]))
  assert.equal(byId.size, 3)
  assert.equal(byId.get('ws-ready').status, 'ready')
  assert.equal(byId.get('ws-ready').title, 'Alpha Docs')
  assert.deepEqual(
    byId.get('ws-ready').assets.map(asset => asset.blueprintId),
    ['bp-ready']
  )
  assert.equal(byId.get('ws-empty').status, 'empty')
  assert.deepEqual(byId.get('ws-empty').assets, [])
  assert.equal(byId.get('ws-absent').status, 'absent')

  // Discovery is read-only: no `.xuanling`, no global library directory.
  assert.equal(existsSync(join(f.workspacePath('ws-empty'), '.xuanling', 'workflows', 'bp-new')), false)
  assert.equal(existsSync(join(f.workspacePath('ws-absent'), '.xuanling')), false)
  assert.equal(existsSync(join(f.globalLibraryRoot, 'bp-new')), false)

  // Wire result validates against the shared strict codec.
  const descriptor = BLUEPRINT_INVOCATIONS.find(entry => entry.method === 'listBlueprintLibraries')
  assert.ok(descriptor, 'listBlueprintLibraries descriptor is absent from the wire contract')
  assert.doesNotThrow(() => descriptor.result.create().parse(value))
})

test('T01: isolates a broken package and keeps same-ID assets distinct across libraries', async t => {
  const f = await libraryFixture(t, {
    workspaces: [
      { id: 'ws-ready', title: 'Alpha Docs', assets: ['bp-same'] },
      { id: 'ws-broken', title: 'Broken Docs', corrupt: true }
    ],
    globalAssets: ['bp-same']
  })

  const value = await f.service.listBlueprintLibraries()
  const byId = new Map(value.libraries.filter(row => row.library.kind === 'workspace').map(row => [row.library.workspaceId, row]))

  // Same logical ID in global and project: both are visible under their own library.
  assert.deepEqual(
    value.libraries[0].assets.map(asset => asset.blueprintId),
    ['bp-same']
  )
  assert.deepEqual(
    byId.get('ws-ready').assets.map(asset => asset.blueprintId),
    ['bp-same']
  )

  // The broken package is a diagnostic row, not a whole-library failure.
  assert.equal(byId.get('ws-broken').status, 'ready')
  const broken = byId.get('ws-broken').assets.find(asset => asset.blueprintId === 'bp-broken')
  assert.ok(broken, 'broken package must remain visible as a diagnostic asset')
  assert.equal(broken.status, 'invalid')
  assert.ok(broken.diagnostic)

  // Loading the same ID from two libraries yields the correct document.
  const global = await f.service.loadDefinition({ blueprintId: 'bp-same', library: { kind: 'global' } })
  const project = await f.service.loadDefinition({
    blueprintId: 'bp-same',
    library: { kind: 'workspace', workspaceId: 'ws-ready' }
  })
  assert.equal(global.blueprintId, 'bp-same')
  assert.equal(project.blueprintId, 'bp-same')
  assert.notEqual(global.documentRevision, undefined)
  assert.notEqual(project.documentRevision, undefined)
})

test('T01: unreadable library reports unavailable without breaking the selector', async t => {
  const f = await libraryFixture(t, {
    workspaces: [{ id: 'ws-ready', title: 'Alpha Docs', assets: ['bp-ready'] }]
  })
  // Simulate a Host registry entry whose root cannot be read by pointing it at
  // a file. The Host still owns the identity; only this library is unavailable.
  const badRoot = join(f.root, 'not-a-directory')
  const original = f.ctx.workspaceRegistry.list
  f.ctx.workspaceRegistry.list = () => [...original(), { id: 'ws-offline', path: badRoot, title: 'Offline', sessionIds: [] }]
  assert.equal(existsSync(badRoot), false, 'fixture must not create the unavailable root')

  const value = await f.service.listBlueprintLibraries()
  const offline = value.libraries.find(row => row.library.kind === 'workspace' && row.library.workspaceId === 'ws-offline')
  assert.ok(offline)
  assert.ok(['absent', 'unavailable'].includes(offline.status))
  const ready = value.libraries.find(row => row.library.kind === 'workspace' && row.library.workspaceId === 'ws-ready')
  assert.equal(ready.status, 'ready')
})
