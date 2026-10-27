import test from 'node:test'
import assert from 'node:assert/strict'
import { scopeBlueprintHost, conversationAuthoringHost } from '../../src/client/adapters/host/remote.ts'
import { libraryFixture, minimalDefinition } from './fixtures.mjs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

test('review: sidebar lifecycle and reference calls retain the selected workspace', async () => {
  const calls = []
  let library = { kind: 'workspace', workspaceId: 'ws-project' }
  const target = new Proxy(
    {},
    {
      get:
        (_, method) =>
        (...args) => {
          calls.push({ method, args })
          return Promise.resolve({})
        }
    }
  )
  const host = scopeBlueprintHost(target, () => library)
  for (const method of ['inspectRun', 'cancelRun', 'archiveRun', 'restoreRun', 'workflowReport']) {
    await host[method]('r1')
    assert.deepEqual(calls.at(-1), { method, args: ['r1', 'ws-project'] })
  }
  await host.decide('r1', 'decision', 'approve')
  assert.deepEqual(calls.at(-1).args, ['r1', 'decision', 'approve', 'ws-project'])
  await host.resolveRecovery({ runId: 'r1', resolution: 'failed', note: 'checked', expectedSeq: 1 })
  assert.equal(calls.at(-1).args[0].workspaceId, 'ws-project')
  await host.inspectBlueprintReference({ blueprintId: 'same-id' })
  assert.deepEqual(calls.at(-1).args[0].library, library)
  library = { kind: 'global' }
  await host.inspectBlueprintReference({ blueprintId: 'same-id' })
  assert.deepEqual(calls.at(-1).args[0].library, { kind: 'global' })
})

test('review: unscoped creation never initializes or picks an unrelated default workspace', async t => {
  let defaults = 0
  const f = await libraryFixture(t, {
    noDefaultWorkspace: false,
    provide(ctx) {
      ctx.provide('workspaceController', {
        initializeDefault: async () => {
          defaults++
          return { id: 'ws-ready' }
        }
      })
    }
  })
  const saved = await f.service.createDefinition({ requestId: 'bare-create', definitionJson: JSON.stringify(minimalDefinition()) })
  assert.equal(defaults, 0)
  assert.equal(existsSync(join(f.globalLibraryRoot, saved.blueprintId, 'blueprint.json')), true)
  assert.equal(existsSync(join(f.workspacePath('ws-ready'), '.xuanling', 'workflows', saved.blueprintId, 'blueprint.json')), false)
})

test('review: conversation saves and loads associate full asset; execution keeps supplied input', async () => {
  const calls = [],
    library = { kind: 'workspace', workspaceId: 'ws-one' }
  const doc = { blueprintId: 'bp-one', documentRevision: 'd'.repeat(64) }
  const host = conversationAuthoringHost(
    {
      loadDefinition: async () => doc,
      saveDefinition: async () => doc,
      associateDefinition: async args => {
        calls.push(['associate', args])
      },
      startSessionRun: async args => {
        calls.push(['run', args])
        return { runId: 'r1' }
      }
    },
    'session-one'
  )
  await host.loadDefinition('bp-one', library)
  assert.deepEqual(calls[0], ['associate', { sessionId: 'session-one', asset: { library, blueprintId: 'bp-one' }, documentRevision: doc.documentRevision }])
  await host.startRun('bp-one', doc.documentRevision, '{"topic":"guide"}', 'request', { library, workspaceId: 'ws-one' })
  assert.equal(calls.at(-1)[1].inputJson, '{"topic":"guide"}')
  assert.equal(calls.at(-1)[1].sessionId, 'session-one')
})

// A shared DSH home cannot collapse profile-global library identities.
test('review: profiles sharing a DSH home retain separate global roots', async () => {
  const { BlueprintLibraryResolver } = await import('../../src/service/library-resolver.ts')
  const resolve = name =>
    new BlueprintLibraryResolver({
      config: {},
      ctx: { get: () => undefined, baseUrl: `file:///tmp/dsh-profiles/${name}/`, dshHomePath: () => '/tmp/shared-dsh-home' }
    }).globalRoot()
  assert.equal(resolve('a'), '/tmp/dsh-profiles/a/data/xuanling-blueprint/library-v2')
  assert.equal(resolve('b'), '/tmp/dsh-profiles/b/data/xuanling-blueprint/library-v2')
})
