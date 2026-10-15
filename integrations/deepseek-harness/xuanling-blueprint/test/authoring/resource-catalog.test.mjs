import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { BlueprintService } from '../../src/index.ts'
import { BLUEPRINT_INVOCATIONS } from '../../src/typert-descriptors.ts'
import { resolveBlueprintHost } from '../../src/client/remote.ts'

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'blueprint-resource-authoring-'))
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(`${root}/`).href
  ctx.provide('systemPrompt', {
    tools() {
      return () => {}
    }
  })
  ctx.provide('agentPresets', {
    list: async () => [{ id: 'standard' }, { id: 'my-reviewer', name: '  Review / QA  ', description: 'Review using JSON / Markdown' }]
  })
  ctx.provide('skills', {
    list: async () => [
      {
        name: 'my-review',
        description: 'Project skill',
        source: 'project-agents',
        provider: 'filesystem',
        path: '/private/my-review/SKILL.md',
        resourceBase: { kind: 'directory', path: '/private/my-review' }
      }
    ]
  })
  new ToolRuntime(ctx, { mode: 'native' })
  ctx.tools.register(
    defineTool({
      name: 'mcp__project__read',
      description: 'Read project files',
      parameters: {},
      output: { schema: { type: 'json' }, render: () => [] },
      execute: async () => ({})
    })
  )
  await ctx.plugin(BlueprintService, {})
  t.after(async () => {
    await ctx.fiber.dispose()
    rmSync(root, { recursive: true, force: true })
  })
  return { ctx, service: ctx.blueprint }
}

test('listResources returns strict safe DTO including provenance and describe exposes the same authoring catalog', async t => {
  const { service } = await fixture(t)
  const value = await service.listResources()
  const resultCodec = BLUEPRINT_INVOCATIONS.find(row => row.method === 'listResources').result.create()
  assert.equal(resultCodec.safeParse(value).success, true)
  assert.deepEqual(
    value.resources.map(row => [row.id, row.provenance]),
    [
      ['standard', 'unknown'],
      ['my-reviewer', 'custom'],
      ['my-review', 'custom'],
      ['mcp__project__read', 'unknown']
    ]
  )
  assert.equal(value.resources[1].displayName, '  Review / QA  ')
  for (const row of value.resources) {
    assert.equal(Object.hasOwn(row, 'identity'), false)
    assert.equal(Object.hasOwn(row, 'refId'), false)
    assert.equal(Object.hasOwn(row, 'path'), false)
    assert.equal(Object.hasOwn(row, 'resourceBase'), false)
  }
  assert.equal(JSON.stringify(value).includes('/private'), false)
  const guide = await service.describeBlueprint()
  assert.deepEqual(guide.resourceCatalog, value.resources)
  const candidate = {
    definition: {
      schemaVersion: 1,
      id: 'draft',
      name: 'Uses DSH resources',
      resources: {
        reviewer: { kind: 'agent', source: { kind: 'host', id: 'my-reviewer' } },
        review: { kind: 'skill', source: { kind: 'host', id: 'my-review' } }
      },
      graph: {
        nodes: [
          {
            id: 'task',
            kind: 'agentTask',
            agentRef: 'reviewer',
            skillRefs: ['review'],
            modelSelection: { provider: 'explicit-provider', model: 'explicit-model' }
          }
        ],
        edges: []
      }
    },
    files: []
  }
  assert.equal((await service.validateBlueprint(candidate)).ok, true)
  const document = await service.createBlueprint(candidate, 'resource-authoring', { sessionId: 'author', callId: 'create' })
  assert.deepEqual((await service.describeBlueprint(document.blueprintId)).resourceCatalog, value.resources)
})

test('remote listResources rejects missing provenance, private locators and internal merge identities', async () => {
  const safe = { id: 'review', kind: 'skill', displayName: 'Review / QA', description: '', source: 'dsh', availability: 'available', provenance: 'custom' }
  let value = { resources: [safe] }
  const host = resolveBlueprintHost({ get: () => ({ listResources: async () => ({ ok: true, value }) }) })
  assert.deepEqual(await host.listResources(), value)
  for (const field of ['identity', 'refId', 'path', 'resourceBase', 'config']) {
    value = { resources: [{ ...safe, [field]: 'private' }] }
    await assert.rejects(host.listResources(), { code: 'blueprint/dto-invalid' })
  }
  const { provenance: _provenance, ...missing } = safe
  value = { resources: [missing] }
  await assert.rejects(host.listResources(), { code: 'blueprint/dto-invalid' })
})
