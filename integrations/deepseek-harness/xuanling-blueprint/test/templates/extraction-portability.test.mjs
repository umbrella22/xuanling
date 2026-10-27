/**
 * T09 (C-09): extract a reusable template without changing the source, and
 * distinguish "export current blueprint" from "extract generic template".
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { BlueprintService } from '../../src/index.ts'
import { extractTemplateArgsCodec } from '../../src/templates/contracts.ts'

const definition = (id, name, extra = {}) => ({
  schemaVersion: 2,
  id,
  name,
  resources: {},
  graph: { nodes: [{ id: 'input', kind: 'input' }], edges: [] },
  ...extra
})

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'bp-templates-'))
  const profile = join(root, 'profile')
  const globalLibrary = join(profile, 'data', 'xuanling-blueprint', 'library-v2')
  const source = join(root, 'source')
  const nodeProject = join(root, 'node-project')
  const sourceRoot = join(source, '.xuanling', 'workflows')
  const nodeRoot = join(nodeProject, '.xuanling', 'workflows')
  mkdirSync(join(sourceRoot, 'bp-clean'), { recursive: true })
  mkdirSync(join(sourceRoot, 'bp-dirty'), { recursive: true })
  mkdirSync(nodeRoot, { recursive: true })
  mkdirSync(join(nodeProject, '.github', 'workflows'), { recursive: true })
  writeFileSync(join(nodeProject, 'package.json'), JSON.stringify({ name: 'node-fixture', scripts: { test: 'node --test', build: 'tsc -b' } }))
  writeFileSync(join(nodeProject, 'README.md'), '# Node Fixture\n\nDeterministic docs.\n')
  writeFileSync(join(source, 'Cargo.toml'), '[package]\nname = "rs_lvgl"\nversion = "0.1.0"\n')
  writeFileSync(join(source, 'README.md'), '# rs_lvgl docs\n')
  writeFileSync(join(nodeProject, '.github', 'workflows', 'ci.yml'), 'name: ci\non: push\n')
  writeFileSync(join(sourceRoot, 'bp-clean', 'blueprint.json'), JSON.stringify(definition('bp-clean', 'Documentation workflow')))
  writeFileSync(
    join(sourceRoot, 'bp-dirty', 'blueprint.json'),
    JSON.stringify(
      definition('bp-dirty', 'rs_lvgl documentation', {
        graph: { nodes: [{ id: 'input', kind: 'input', outputs: { value: 'string' } }], edges: [] },
        presentation: { nodes: { input: { x: 0, y: 0, title: '/Users/ikaros/rs_lvgl docs' } } }
      })
    )
  )
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(`${profile}/`).href
  ctx.provide('systemPrompt', { tools: () => () => {} })
  new ToolRuntime(ctx, { mode: 'native' })
  ctx.provide('workspaceRegistry', {
    list: () => [
      { id: 'ws-source', title: 'Source Docs', path: source, sessionIds: [] },
      { id: 'ws-node', title: 'Node Project', path: nodeProject, sessionIds: [] }
    ]
  })
  await ctx.plugin(BlueprintService, { globalLibraryRoot: globalLibrary })
  t.after(async () => {
    await ctx.fiber.dispose()
    rmSync(root, { recursive: true, force: true })
  })
  const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex')
  return { ctx, service: ctx.blueprint, root, globalLibrary, source, sourceRoot, nodeProject, nodeRoot, digest }
}

test('T09: clean extraction is portable, parameterised and does not touch the source', async t => {
  const f = await fixture(t)
  const sourceFile = join(f.sourceRoot, 'bp-clean', 'blueprint.json')
  const before = f.digest(sourceFile)
  const value = await f.service.extractTemplate({
    blueprintId: 'bp-clean',
    requestId: 'extract-clean',
    library: { kind: 'workspace', workspaceId: 'ws-source' }
  })
  assert.equal(value.portable, true, JSON.stringify(value.residual))
  assert.deepEqual(value.residual, [])
  assert.match(value.template.templateId, /^tpl-[a-f0-9]{32}$/)
  assert.deepEqual(
    value.template.parameters.map(parameter => parameter.key),
    ['name']
  )
  assert.equal(value.template.pattern.id, '{{id}}')
  assert.equal(value.template.pattern.name, '{{name}}')
  assert.equal(
    value.template.provenance.sourceRevision,
    (
      await f.service.loadDefinition({
        blueprintId: 'bp-clean',
        library: { kind: 'workspace', workspaceId: 'ws-source' }
      })
    ).documentRevision
  )

  const saved = f.service.saveTemplate({ template: value.template, requestId: 'save-clean' })
  assert.equal(saved.template.templateId, value.template.templateId)
  assert.deepEqual(
    f.service.listTemplates().map(item => item.templateId),
    [value.template.templateId]
  )
  assert.deepEqual(f.service.loadTemplate({ templateId: value.template.templateId }), value.template)

  assert.equal(f.digest(sourceFile), before, 'extraction must not rewrite the source blueprint')
})

test('T09: template identity cannot escape the template namespace', async t => {
  const f = await fixture(t)
  const value = await f.service.extractTemplate({
    blueprintId: 'bp-clean',
    requestId: 'extract-escape',
    library: { kind: 'workspace', workspaceId: 'ws-source' }
  })
  assert.throws(
    () => f.service.saveTemplate({ template: { ...value.template, templateId: '../../escape' }, requestId: 'escape' }),
    error => error?.code === 'blueprint/template-invalid'
  )
})

test('T09: project-specific names and absolute paths stop a portable claim', async t => {
  const f = await fixture(t)
  const sourceFile = join(f.sourceRoot, 'bp-dirty', 'blueprint.json')
  const before = f.digest(sourceFile)
  const value = await f.service.extractTemplate({
    blueprintId: 'bp-dirty',
    requestId: 'extract-dirty',
    library: { kind: 'workspace', workspaceId: 'ws-source' }
  })
  assert.equal(value.portable, false)
  assert.ok(value.residual.includes('source-project-name'), JSON.stringify(value.residual))
  assert.ok(value.residual.includes('absolute-path'), JSON.stringify(value.residual))
  assert.deepEqual(value.template.provenance.residualNotes, value.residual)
  assert.equal(f.digest(sourceFile), before)
})

test('T09: extract-template wire args accept global and workspace libraries', () => {
  const codec = extractTemplateArgsCodec()
  assert.equal(codec.safeParse({ blueprintId: 'x', requestId: 'r' }).success, true)
  assert.equal(codec.safeParse({ blueprintId: 'x', requestId: 'r', library: { kind: 'global' } }).success, true)
  assert.equal(codec.safeParse({ blueprintId: 'x', requestId: 'r', library: { kind: 'workspace', workspaceId: 'ws-a' } }).success, true)
  assert.equal(codec.safeParse({ blueprintId: 'x', requestId: 'r', library: { kind: 'workspace', workspaceId: '' } }).success, false)
})
