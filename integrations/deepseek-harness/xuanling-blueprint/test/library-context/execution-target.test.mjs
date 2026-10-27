/**
 * T02 (C-02): no execution target means "save globally, never execute".
 *
 * Red target: every definition operation currently requires a Host default
 * workspace, and a start request without one fails as `capability-unavailable`
 * instead of the required `workspace-required` guard.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { libraryFixture, minimalDefinition } from './fixtures.mjs'
import { Context } from '@deepseek-ai/cordis'
import { BlueprintService } from '../../src/index.ts'

test('T02: creates and saves a global definition when no workspace exists', async t => {
  const f = await libraryFixture(t, { workspaces: [], globalAssets: [] })
  const definition = { ...minimalDefinition('bp-global', 'Global Draft'), id: 'bp-global' }

  const created = await f.service.createDefinition({ requestId: 'req-global-1', definitionJson: JSON.stringify(definition) })
  assert.match(created.blueprintId, /^bp-[a-f0-9]{64}$/)
  assert.ok(created.documentRevision)

  const stored = await f.service.loadDefinition({ blueprintId: created.blueprintId, library: { kind: 'global' } })
  assert.equal(stored.documentRevision, created.documentRevision)

  const libraries = await f.service.listBlueprintLibraries()
  assert.equal(libraries.libraries[0].library.kind, 'global')
  assert.deepEqual(
    libraries.libraries[0].assets.map(asset => asset.blueprintId),
    [created.blueprintId]
  )

  // The global namespace is durable across a fresh service instance.
  const reopened = new Context()
  reopened.baseUrl = f.ctx.baseUrl
  reopened.provide('systemPrompt', { tools: () => () => {} })
  reopened.provide('workspaceRegistry', { list: () => [] })
  await reopened.plugin(BlueprintService, { globalLibraryRoot: f.globalLibraryRoot })
  t.after(async () => {
    await reopened.fiber.dispose()
  })
  const afterRestart = await reopened.blueprint.loadDefinition({ blueprintId: created.blueprintId })
  assert.equal(afterRestart.documentRevision, created.documentRevision)
})

test('T02: start/preflight/tool execution without a target has zero effect', async t => {
  const f = await libraryFixture(t, { workspaces: [], globalAssets: ['bp-global'] })
  const before = readdirSync(f.root).sort()

  await assert.rejects(
    () => f.service.startRun({ blueprintId: 'bp-global', expectedRevision: 'x', inputJson: '{}', requestId: 'req-start-1' }),
    error => error?.code === 'blueprint/workspace-required'
  )
  await assert.rejects(
    () => f.service.preflightRun({ blueprintId: 'bp-global', expectedRevision: 'x', inputJson: '{}' }),
    error => error?.code === 'blueprint/workspace-required'
  )
  const toolResult = await f.dispatch('workflow_run', { blueprintId: 'bp-global', expectedRevision: 'x', inputJson: '{}', requestId: 'req-tool-1' })
  assert.equal(Boolean(toolResult.isError), true, JSON.stringify(toolResult))

  assert.deepEqual(readdirSync(f.root).sort(), before, 'no workspace/runtime directory may be created')
  const runs = await f.service.queryRuns({ blueprintId: 'bp-global' })
  assert.deepEqual(runs.runs, [])
})

test('T02: a selected project is used and a global asset requires an instance first', async t => {
  const f = await libraryFixture(t, {
    workspaces: [{ id: 'ws-ready', title: 'Alpha', assets: ['bp-project'] }],
    globalAssets: ['bp-global']
  })

  // Project asset with an explicit target is admitted to preflight; an empty
  // input definition has no blocking checks.
  const project = await f.service.loadDefinition({
    blueprintId: 'bp-project',
    library: { kind: 'workspace', workspaceId: 'ws-ready' }
  })
  const preflight = await f.service.preflightRun({
    blueprintId: 'bp-project',
    expectedRevision: project.documentRevision,
    inputJson: JSON.stringify({ value: 'x' }),
    library: { kind: 'workspace', workspaceId: 'ws-ready' }
  })
  assert.equal(preflight.canStart, true)

  // A global asset has no project instance; execution must not silently use it
  // from another library.
  await assert.rejects(
    () =>
      f.service.startRun({
        blueprintId: 'bp-global',
        expectedRevision: 'x',
        inputJson: '{}',
        requestId: 'req-global-run',
        library: { kind: 'global' },
        workspaceId: 'ws-ready'
      }),
    error => error?.code === 'blueprint/instance-required'
  )
  assert.equal(existsSync(join(f.workspacePath('ws-ready'), '.xuanling', 'workflows', 'bp-global')), false)
  assert.deepEqual((await f.service.queryRuns({ workspaceId: 'ws-ready' })).runs, [])
})

test('T02: an unknown workspaceId is rejected before any read or write', async t => {
  const f = await libraryFixture(t, { workspaces: [{ id: 'ws-ready', title: 'Alpha', assets: ['bp-project'] }] })
  await assert.rejects(
    () => f.service.loadDefinition({ blueprintId: 'bp-project', library: { kind: 'workspace', workspaceId: 'ws-forged' } }),
    error => error?.code === 'blueprint/workspace-unavailable'
  )
  await assert.rejects(
    () =>
      f.service.startRun({
        blueprintId: 'bp-project',
        expectedRevision: 'x',
        inputJson: '{}',
        requestId: 'req-forged',
        workspaceId: 'ws-forged'
      }),
    error => error?.code === 'blueprint/workspace-unavailable'
  )
})

test('T02: an explicit workspaceRoot stays a Host constraint and cannot be overridden', async t => {
  const f = await libraryFixture(t, {
    workspaces: [
      { id: 'ws-ready', title: 'Alpha', assets: ['bp-project'] },
      { id: 'ws-other', title: 'Other', assets: ['bp-project'] }
    ],
    configureWorkspace: true
  })
  await assert.rejects(
    () =>
      f.service.loadDefinition({
        blueprintId: 'bp-project',
        library: { kind: 'workspace', workspaceId: 'ws-other' }
      }),
    error => error?.code === 'blueprint/workspace-mismatch'
  )
  const accepted = await f.service.loadDefinition({ blueprintId: 'bp-project' })
  assert.ok(accepted.documentRevision)

  // The legacy configured root still writes project data where it always did.
  const created = await f.service.createDefinition({
    requestId: 'req-configured',
    definitionJson: JSON.stringify(minimalDefinition('bp-configured'))
  })
  assert.ok(
    readFileSync(join(f.workspacePath('ws-ready'), '.xuanling', 'workflows', created.blueprintId, 'blueprint.json'), 'utf8').includes(created.blueprintId)
  )
})
