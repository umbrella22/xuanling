/**
 * T10 (C-10): a template instantiated into two structurally different projects
 * produces its own concrete v2 definition and an evidence-backed preparation.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { BlueprintService } from '../../src/index.ts'

const definition = (id, name) => ({
  schemaVersion: 2,
  id,
  name,
  resources: {},
  graph: { nodes: [{ id: 'input', kind: 'input', outputs: { value: 'string' } }], edges: [] }
})

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'bp-instantiate-'))
  const profile = join(root, 'profile')
  const globalLibrary = join(profile, 'data', 'xuanling-blueprint', 'library-v2')
  const source = join(root, 'source')
  const nodeProject = join(root, 'node-project')
  const sourceRoot = join(source, '.xuanling', 'workflows')
  mkdirSync(join(sourceRoot, 'bp-clean'), { recursive: true })
  mkdirSync(join(nodeProject, '.github', 'workflows'), { recursive: true })
  writeFileSync(join(sourceRoot, 'bp-clean', 'blueprint.json'), JSON.stringify(definition('bp-clean', 'Documentation workflow')))
  writeFileSync(join(source, 'Cargo.toml'), '[package]\nname = "rs_lvgl"\n')
  writeFileSync(join(nodeProject, 'package.json'), JSON.stringify({ name: 'node-fixture', scripts: { test: 'node --test' } }))
  writeFileSync(join(nodeProject, 'README.md'), '# Node Fixture\n')
  writeFileSync(join(nodeProject, '.github', 'workflows', 'ci.yml'), 'name: ci\n')
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
  return { ctx, service: ctx.blueprint, source, nodeProject, globalLibrary }
}

async function cleanTemplate(f) {
  const extracted = await f.service.extractTemplate({
    blueprintId: 'bp-clean',
    requestId: 'extract-for-instantiation',
    library: { kind: 'workspace', workspaceId: 'ws-source' }
  })
  f.service.saveTemplate({ template: extracted.template, requestId: 'save-for-instantiation' })
  return extracted.template
}

test('T10: instantiation generates concrete v2 definitions in two different projects', async t => {
  const f = await fixture(t)
  const template = await cleanTemplate(f)

  const node = await f.service.instantiateTemplate({
    templateId: template.templateId,
    workspaceId: 'ws-node',
    requestId: 'instantiate-node',
    parameters: { name: 'Node documentation' }
  })
  assert.equal(node.status, 'ready', JSON.stringify(node.manifest.unresolved))
  assert.equal(node.instance.asset.library.kind, 'workspace')
  assert.equal(node.instance.asset.library.workspaceId, 'ws-node')
  const nodeFile = join(f.nodeProject, '.xuanling', 'workflows', node.instance.asset.blueprintId, 'blueprint.json')
  assert.equal(existsSync(nodeFile), true)
  const nodeDefinition = JSON.parse(readFileSync(nodeFile, 'utf8'))
  assert.equal(nodeDefinition.name, 'Node documentation')
  assert.equal(nodeDefinition.id, node.instance.asset.blueprintId)
  assert.equal(JSON.stringify(nodeDefinition).includes('{{'), false, 'no unresolved placeholders may be published')
  assert.equal(JSON.stringify(nodeDefinition).includes('rs_lvgl'), false, 'the second project must not inherit source names')
  assert.equal(nodeDefinition.schemaVersion, 2)
  assert.equal(node.manifest.status, 'ready')
  assert.deepEqual(node.manifest.unresolved, [])
  assert.ok(node.manifest.facts.some(fact => fact.kind === 'command' && fact.value === 'npm run test'))
  assert.ok(node.manifest.facts.some(fact => fact.kind === 'readme' && fact.value === '# Node Fixture'))
  const manifestFile = join(f.nodeProject, '.xuanling', 'preparations', `${node.manifest.preparationId}.json`)
  assert.equal(existsSync(manifestFile), true)
  assert.equal(JSON.parse(readFileSync(manifestFile, 'utf8')).status, 'ready')

  const source = await f.service.instantiateTemplate({
    templateId: template.templateId,
    workspaceId: 'ws-source',
    requestId: 'instantiate-source',
    parameters: { name: 'Source documentation' }
  })
  assert.equal(source.status, 'ready')
  assert.notEqual(source.instance.asset.blueprintId, node.instance.asset.blueprintId)
  assert.ok(source.manifest.facts.some(fact => fact.kind === 'manifest' && fact.value === 'cargo:rs_lvgl'))
  assert.ok(source.manifest.facts.some(fact => fact.kind === 'command' && fact.status === 'unknown' && fact.sourcePath === 'Cargo.toml'))
})

test('T10: a required parameter without a default returns needs_input and publishes nothing', async t => {
  const f = await fixture(t)
  const template = await cleanTemplate(f)
  const strict = {
    ...template,
    templateId: 'tpl-strict',
    parameters: template.parameters.map(parameter => {
      const { default: _default, ...rest } = parameter
      return rest
    })
  }
  f.service.saveTemplate({ template: strict, requestId: 'save-strict' })
  const value = await f.service.instantiateTemplate({
    templateId: 'tpl-strict',
    workspaceId: 'ws-node',
    requestId: 'instantiate-missing',
    parameters: {}
  })
  assert.equal(value.status, 'needs_input')
  assert.deepEqual(value.manifest.unresolved, ['name'])
  assert.equal(value.instance, null)
  assert.equal(existsSync(join(f.nodeProject, '.xuanling', 'workflows')), false, 'a blocked preparation must not publish a package')
  const manifest = JSON.parse(readFileSync(join(f.nodeProject, '.xuanling', 'preparations', `${value.manifest.preparationId}.json`), 'utf8'))
  assert.equal(manifest.status, 'needs_input')
  assert.deepEqual(manifest.unresolved, ['name'])
})

test('T10: retrying the same instantiation returns the existing instance; changed parameters conflict', async t => {
  const f = await fixture(t)
  const template = await cleanTemplate(f)
  const first = await f.service.instantiateTemplate({
    templateId: template.templateId,
    workspaceId: 'ws-node',
    requestId: 'instantiate-retry',
    parameters: { name: 'Node docs' }
  })
  assert.equal(first.status, 'ready')
  const before = readFileSync(join(f.nodeProject, '.xuanling', 'workflows', first.instance.asset.blueprintId, 'blueprint.json'))
  const retry = await f.service.instantiateTemplate({
    templateId: template.templateId,
    workspaceId: 'ws-node',
    requestId: 'instantiate-retry',
    parameters: { name: 'Node docs' }
  })
  assert.equal(retry.status, 'ready')
  assert.equal(retry.instance.asset.blueprintId, first.instance.asset.blueprintId)
  assert.equal(retry.instance.documentRevision, first.instance.documentRevision)
  assert.deepEqual(readFileSync(join(f.nodeProject, '.xuanling', 'workflows', first.instance.asset.blueprintId, 'blueprint.json')), before)
  await assert.rejects(
    () =>
      f.service.instantiateTemplate({
        templateId: template.templateId,
        workspaceId: 'ws-node',
        requestId: 'instantiate-retry',
        parameters: { name: 'Changed' }
      }),
    error => error?.code === 'blueprint/revision-conflict'
  )
})

test('review: template carries complete packaged agent and skill files to a different workspace', async t => {
  const f = await fixture(t)
  const root = join(f.source, '.xuanling', 'workflows', 'bp-clean')
  mkdirSync(join(root, 'lib', 'agents'), { recursive: true })
  mkdirSync(join(root, 'lib', 'skills', 'docs', 'references'), { recursive: true })
  const files = {
    'lib/agents/writer.md': '# Writer\nUse discovered sources.',
    'lib/skills/docs/SKILL.md': '---\nname: docs\ndescription: Write docs\n---\nRead references/style.md',
    'lib/skills/docs/references/style.md': '# Style\nCite evidence.',
    'lib/skills/docs/references/sample.bin': Buffer.from([0, 255, 128, 24])
  }
  for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text)
  writeFileSync(
    join(root, 'blueprint.json'),
    JSON.stringify({
      schemaVersion: 2,
      id: 'bp-clean',
      name: 'Documentation workflow',
      resources: { writer: { kind: 'agent', path: 'lib/agents/writer.md' }, docs: { kind: 'skill', path: 'lib/skills/docs' } },
      graph: { nodes: [{ id: 'write', kind: 'agentTask', agentRef: 'writer', skillRefs: ['docs'] }], edges: [] }
    })
  )
  const template = await cleanTemplate(f)
  const value = await f.service.instantiateTemplate({
    templateId: template.templateId,
    workspaceId: 'ws-node',
    requestId: 'with-closure',
    parameters: { name: 'Portable docs' }
  })
  assert.equal(value.status, 'ready', JSON.stringify(value.manifest.unresolved))
  for (const [path, expected] of Object.entries(files)) {
    assert.deepEqual(readFileSync(join(f.nodeProject, '.xuanling', 'workflows', value.instance.asset.blueprintId, path)), Buffer.from(expected))
  }
})

test('review: linked instance with corrupt or missing preparation cannot start', async t => {
  const f = await fixture(t)
  const template = await cleanTemplate(f)
  const result = await f.service.instantiateTemplate({
    templateId: template.templateId,
    workspaceId: 'ws-node',
    requestId: 'corrupt-preparation',
    parameters: { name: 'Node docs' }
  })
  const manifest = join(f.nodeProject, '.xuanling', 'preparations', `${result.manifest.preparationId}.json`)
  const start = () =>
    f.service.startRun({
      blueprintId: result.instance.asset.blueprintId,
      expectedRevision: result.instance.documentRevision,
      inputJson: '{"value":"docs"}',
      requestId: 'blocked',
      workspaceId: 'ws-node',
      library: result.instance.asset.library
    })
  writeFileSync(manifest, '{broken')
  await assert.rejects(start, { code: 'blueprint/preparation-stale' })
  rmSync(manifest)
  await assert.rejects(start, { code: 'blueprint/preparation-stale' })
})

test('review: source evidence drift blocks admission until explicit re-preparation', async t => {
  const f = await fixture(t)
  const template = await cleanTemplate(f)
  const args = { templateId: template.templateId, workspaceId: 'ws-node', requestId: 'prepared-start', parameters: { name: 'Node docs' } }
  const first = await f.service.instantiateTemplate(args)
  writeFileSync(join(f.nodeProject, 'README.md'), '# Node Fixture\n\nChanged project requirements.\n')
  await assert.rejects(
    () =>
      f.service.startRun({
        blueprintId: first.instance.asset.blueprintId,
        expectedRevision: first.instance.documentRevision,
        inputJson: '{"value":"docs"}',
        requestId: 'stale-start',
        workspaceId: 'ws-node',
        library: first.instance.asset.library
      }),
    error => error.code === 'blueprint/preparation-stale'
  )
  const refreshed = await f.service.instantiateTemplate(args)
  const run = await f.service.startRun({
    blueprintId: refreshed.instance.asset.blueprintId,
    expectedRevision: refreshed.instance.documentRevision,
    inputJson: '{"value":"docs"}',
    requestId: 'fresh-start',
    workspaceId: 'ws-node',
    library: refreshed.instance.asset.library
  })
  assert.ok(run.runId)
})
