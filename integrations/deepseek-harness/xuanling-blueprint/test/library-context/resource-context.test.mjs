/**
 * T03 (C-03): catalog, preflight and freeze read Skills in the same Workspace
 * and Host scope. Red target (confirmed F-02): the previous implementation
 * called `listResources` with `process.cwd()` and never passed a scope.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { BlueprintService } from '../../src/index.ts'

function definition(id = 'bp-skill') {
  return {
    schemaVersion: 2,
    id,
    name: id,
    resources: {
      reviewer: { kind: 'agent', source: { kind: 'host', id: 'standard' } },
      review: { kind: 'skill', source: { kind: 'host', id: 'project-review' } }
    },
    graph: {
      nodes: [
        { id: 'input', kind: 'input', outputs: { value: 'string' } },
        { id: 'task', kind: 'agentTask', inputs: { value: 'string' }, outputs: { value: 'string' }, agentRef: 'reviewer', skillRefs: ['review'] }
      ],
      edges: [{ kind: 'data', from: 'input.value', to: 'task.value' }]
    }
  }
}

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'bp-resource-context-'))
  const workspace = join(root, 'alpha')
  const other = join(root, 'beta')
  const profile = join(root, 'profile')
  mkdirSync(join(workspace, '.xuanling', 'workflows', 'bp-skill'), { recursive: true })
  mkdirSync(other, { recursive: true })
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(workspace, '.xuanling', 'workflows', 'bp-skill', 'blueprint.json'), JSON.stringify(definition()))
  mkdirSync(join(workspace, '.agents', 'agents'), { recursive: true })
  writeFileSync(
    join(workspace, '.agents', 'agents', 'reviewer.md'),
    '---\nname: Project Reviewer\ndescription: Reviews fixture changes\nmodel: should-not-be-executed\n---\n# Reviewer\nRead only.\n'
  )
  const calls = []
  const agent = { id: 'session-1', session: { header: { cwd: workspace } } }
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(`${profile}/`).href
  ctx.provide('systemPrompt', { tools: () => () => {} })
  new ToolRuntime(ctx, { mode: 'native' })
  ctx.provide('workspaceRegistry', {
    list: () => [
      { id: 'ws-alpha', title: 'Alpha', path: workspace, sessionIds: ['session-1'] },
      { id: 'ws-beta', title: 'Beta', path: other, sessionIds: [] }
    ]
  })
  ctx.provide('agents', { get: id => (id === 'session-1' ? agent : undefined), list: () => [agent] })
  ctx.provide('skills', {
    list: async options => {
      calls.push({ method: 'list', options })
      return [
        { name: 'project-review', description: 'Project review', source: 'project-agents', provider: 'filesystem' },
        { name: 'global-helper', description: 'Global helper', source: 'user-agents', provider: 'filesystem' }
      ]
    },
    get: async (name, options) => {
      calls.push({ method: 'get', name, options })
      return name === 'project-review' ? { name, description: 'Project review', content: '# Review', source: 'project-agents' } : undefined
    }
  })
  await ctx.plugin(BlueprintService, { globalLibraryRoot: join(profile, 'data', 'xuanling-blueprint', 'library-v2') })
  t.after(async () => {
    await ctx.fiber.dispose()
    rmSync(root, { recursive: true, force: true })
  })
  return { ctx, service: ctx.blueprint, workspace, other, calls, agent }
}

test('T03: catalog reads Skills in the selected workspace, not process.cwd', async t => {
  const f = await fixture(t)
  const globalCwd = process.cwd()
  const value = await f.service.listResources({ library: { kind: 'workspace', workspaceId: 'ws-alpha' } })
  const list = f.calls.find(call => call.method === 'list')
  assert.ok(list)
  assert.equal(list.options.cwd, f.workspace)
  assert.notEqual(list.options.cwd, globalCwd)
  assert.equal(list.options.scope, undefined, 'no live session means no borrowed scope')
  assert.deepEqual(
    value.resources.map(row => row.id),
    ['project-review', 'global-helper']
  )

  // Global-only editing never borrows another workspace's cwd or scope.
  f.calls.length = 0
  await f.service.listResources({ library: { kind: 'global' } })
  const globalList = f.calls.find(call => call.method === 'list')
  assert.equal(globalList.options.cwd, undefined)
  assert.equal(globalList.options.scope, undefined)
})

test('T03: a live session contributes its agent scope', async t => {
  const f = await fixture(t)
  await f.service.listResources({ library: { kind: 'workspace', workspaceId: 'ws-alpha' }, sessionId: 'session-1' })
  const list = f.calls.find(call => call.method === 'list')
  assert.equal(list.options.cwd, f.workspace)
  assert.equal(list.options.scope, f.agent)
})

test('T03: preflight resolves a host Skill with the same cwd', async t => {
  const f = await fixture(t)
  const document = await f.service.loadDefinition({ blueprintId: 'bp-skill', library: { kind: 'workspace', workspaceId: 'ws-alpha' } })
  const report = await f.service.preflightRun({
    blueprintId: 'bp-skill',
    expectedRevision: document.documentRevision,
    inputJson: JSON.stringify({ value: 'x' }),
    library: { kind: 'workspace', workspaceId: 'ws-alpha' }
  })
  const get = f.calls.find(call => call.method === 'get' && call.name === 'project-review')
  assert.ok(get, 'preflight must probe the declared host Skill')
  assert.equal(get.options.cwd, f.workspace)
  assert.ok(!report.checks.some(check => check.code === 'host-resource-unavailable' && check.resourceId === 'review'), JSON.stringify(report.checks))
})

test('T03: Agent Markdown discovery is read-only and import copies exact bytes', async t => {
  const f = await fixture(t)
  const value = await f.service.listAgentDocuments({ library: { kind: 'workspace', workspaceId: 'ws-alpha' } })
  const documents = value.documents.filter(document => document.source === 'project')
  assert.equal(documents.length, 1, 'only the fixture project document belongs to this workspace')
  assert.equal(documents[0].name, 'Project Reviewer')
  assert.equal(documents[0].description, 'Reviews fixture changes')
  assert.equal(documents[0].source, 'project')
  assert.match(documents[0].digest, /^[a-f0-9]{64}$/)
  assert.equal(JSON.stringify(documents).includes('.agents'), false, 'source paths must not enter the DTO')

  const source = join(f.workspace, '.agents', 'agents', 'reviewer.md')
  const before = readFileSync(source)
  const document = await f.service.loadDefinition({ blueprintId: 'bp-skill', library: { kind: 'workspace', workspaceId: 'ws-alpha' } })
  const imported = await f.service.importAgentDocument({
    documentId: documents[0].documentId,
    blueprintId: 'bp-skill',
    expectedRevision: document.documentRevision,
    library: { kind: 'workspace', workspaceId: 'ws-alpha' }
  })
  assert.match(imported.path, /^agents\/project-reviewer-[a-f0-9]{8}\.md$/)
  assert.deepEqual(readFileSync(source), before, 'the source document must not be modified')
  assert.deepEqual(readFileSync(join(f.workspace, '.xuanling', 'workflows', 'bp-skill', imported.path)), before)
  const after = await f.service.loadDefinition({ blueprintId: 'bp-skill', library: { kind: 'workspace', workspaceId: 'ws-alpha' } })
  const stored = JSON.parse(after.definitionJson)
  assert.equal(stored.resources[imported.resourceId].kind, 'agent')
  assert.equal(stored.resources[imported.resourceId].path, imported.path)

  // Replaying the same import is idempotent and does not bump the revision.
  const again = await f.service.importAgentDocument({
    documentId: documents[0].documentId,
    blueprintId: 'bp-skill',
    expectedRevision: document.documentRevision,
    library: { kind: 'workspace', workspaceId: 'ws-alpha' }
  })
  assert.equal(again.documentRevision, imported.documentRevision)
  assert.equal(again.resourceId, imported.resourceId)
})

test('T03: Run admission resolves host Skills with the same workspace cwd as preflight', async t => {
  const f = await fixture(t)
  // A resource-only definition executes a single input node; admission still
  // validates every declared host resource before creating the Run.
  const admissionDefinition = {
    schemaVersion: 2,
    id: 'bp-admission',
    name: 'Admission skill',
    resources: { review: { kind: 'skill', source: { kind: 'host', id: 'project-review' } } },
    graph: { nodes: [{ id: 'input', kind: 'input' }], edges: [] }
  }
  mkdirSync(join(f.workspace, '.xuanling', 'workflows', 'bp-admission'), { recursive: true })
  writeFileSync(join(f.workspace, '.xuanling', 'workflows', 'bp-admission', 'blueprint.json'), JSON.stringify(admissionDefinition))
  const document = await f.service.loadDefinition({ blueprintId: 'bp-admission', library: { kind: 'workspace', workspaceId: 'ws-alpha' } })
  const admitted = await f.service.startRun({
    blueprintId: 'bp-admission',
    expectedRevision: document.documentRevision,
    inputJson: JSON.stringify({ value: 'x' }),
    requestId: 'admission-skill-cwd',
    library: { kind: 'workspace', workspaceId: 'ws-alpha' }
  })
  assert.match(admitted.runId, /^[A-Za-z0-9_-]+$/)
  const get = f.calls.find(call => call.method === 'get' && call.name === 'project-review')
  assert.ok(get, 'admission must resolve the declared host Skill')
  assert.equal(get.options.cwd, f.workspace, 'admission must not fall back to process.cwd or an empty lookup')
})
