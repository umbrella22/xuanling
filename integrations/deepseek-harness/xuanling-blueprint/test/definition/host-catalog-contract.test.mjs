import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { decodeDefinition } from '../../src/definition/codec.ts'
import { validateDefinition } from '../../src/definition/validator.ts'
import { computeRevision } from '../../src/definition/revision.ts'
import { listHostResources, mergeResourceCatalog, skillProvenance, hostResourceCatalogValue } from '../../src/host/resource-catalog.ts'

const require = createRequire(import.meta.url)
const includeRequire = createRequire(require.resolve('@deepseek-ai/cordis-plugin-include/package.json'))
const yaml = includeRequire('js-yaml')

function definition() {
  return {
    schemaVersion: 2,
    id: 'host-contract',
    name: 'Host contract',
    resources: {
      agent: { kind: 'agent', source: { kind: 'host', id: 'standard' } },
      skill: { kind: 'skill', source: { kind: 'host', id: 'review' } },
      mcp: { kind: 'mcp', source: { kind: 'host', id: 'mcp__repo__read' }, bindingId: 'mcp__repo__read' }
    },
    graph: { nodes: [{ id: 'task', kind: 'agentTask', agentRef: 'agent', skillRefs: ['skill'], toolsetRefs: ['mcp'] }], edges: [] }
  }
}

function accepted(value) {
  const decoded = decodeDefinition(JSON.stringify(value))
  validateDefinition(decoded)
  return decoded
}

function invalid(value, pointer) {
  assert.throws(
    () => accepted(value),
    error => error.code === 'DEFINITION_INVALID' && error.issues.some(issue => issue.pointer?.startsWith(pointer))
  )
}

test('host source is explicit, strict, and supported only for agent/skill/mcp without package paths', () => {
  accepted(definition())
  for (const kind of ['agent', 'skill', 'mcp']) {
    const value = definition()
    value.resources[kind].path = 'lib/agents/incorrect.md'
    invalid(value, `/resources/${kind}`)
  }
  for (const source of [
    { kind: 'host', id: '' },
    { kind: 'host', id: '  ' },
    { kind: 'host', id: 'standard', path: '/private/config' },
    { kind: 'host', id: 'standard', credentials: 'secret' }
  ]) {
    const value = definition()
    value.resources.agent.source = source
    invalid(value, '/resources/agent/source')
  }
  const value = definition()
  value.resources.schema = { kind: 'schema', source: { kind: 'host', id: 'schema' } }
  invalid(value, '/resources/schema')
})

test('explicit node model selection preserves bytes and rejects blank or unknown route fields', () => {
  const value = definition()
  value.graph.nodes[0].modelSelection = { provider: 'provider-A', model: 'model-A', reasoningEffort: 'high' }
  assert.deepEqual(accepted(value).graph.nodes[0].modelSelection, value.graph.nodes[0].modelSelection)
  for (const field of ['provider', 'model', 'reasoningEffort']) {
    for (const bad of ['', ' \t ', 3]) {
      const edited = structuredClone(value)
      edited.graph.nodes[0].modelSelection[field] = bad
      invalid(edited, `/graph/nodes/0/modelSelection/${field}`)
    }
  }
  const edited = structuredClone(value)
  edited.graph.nodes[0].modelSelection.apiKey = 'secret'
  invalid(edited, '/graph/nodes/0/modelSelection/apiKey')
  const notAgent = structuredClone(value)
  notAgent.graph.nodes[0] = { id: 'input', kind: 'input', modelSelection: value.graph.nodes[0].modelSelection }
  invalid(notAgent, '/graph/nodes/0/modelSelection')
})

test('host logical identity and explicit model route change semantic revision without package files', () => {
  const root = mkdtempSync(join(tmpdir(), 'blueprint-host-revision-'))
  try {
    const original = accepted(definition())
    const baseline = computeRevision({ rootDir: root, definition: original })
    assert.deepEqual(baseline.files, {})
    const otherHost = structuredClone(original)
    otherHost.resources.agent.source.id = 'minimal'
    assert.notEqual(computeRevision({ rootDir: root, definition: otherHost }).semantic, baseline.semantic)
    const explicit = structuredClone(original)
    explicit.graph.nodes[0].modelSelection = { provider: 'p', model: 'm' }
    assert.notEqual(computeRevision({ rootDir: root, definition: explicit }).semantic, baseline.semantic)
    const moved = structuredClone(original)
    moved.presentation = { nodes: { task: { x: 200, y: 50 } } }
    assert.equal(computeRevision({ rootDir: root, definition: moved }).semantic, baseline.semantic)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('catalog reads host presets, cwd skills and MCP schemas while omitting provider paths and internals', async () => {
  let seenCwd
  const services = {
    agentPresets: {
      list: async () => [
        { id: 'standard', name: 'Standard' },
        { id: 'broken', broken: '/private/profile/secret.yml failed' }
      ]
    },
    skills: {
      list: async options => {
        seenCwd = options.cwd
        return [
          {
            name: 'review',
            description: 'Review source files',
            path: '/private/skills/review/SKILL.md',
            provider: 'hidden',
            resourceBase: { kind: 'directory', path: '/private/skills' }
          }
        ]
      }
    },
    tools: {
      schemas: () => [
        { name: 'native_read', description: 'Native' },
        { name: 'mcp__repo__read', description: 'Reads /private/repo/file safely', execute: 'hidden', url: 'https://secret' }
      ]
    }
  }
  const rows = await listHostResources({ get: name => services[name] }, { cwd: '/project' })
  assert.equal(seenCwd, '/project')
  assert.deepEqual(
    rows.map(row => [row.kind, row.id, row.availability]),
    [
      ['agent', 'standard', 'available'],
      ['agent', 'broken', 'unavailable'],
      ['skill', 'review', 'available'],
      ['mcp', 'mcp__repo__read', 'available']
    ]
  )
  assert.equal(rows[3].bindingId, 'mcp__repo__read')
  assert.equal(rows[3].description, 'Reads /private/repo/file safely', 'public display text is preserved')
  assert.equal(rows[2].path, undefined)
  assert.equal(rows[2].resourceBase, undefined)
  assert.equal(JSON.stringify(rows).includes('hidden'), false)
  assert.deepEqual(await listHostResources({ get: () => undefined }), [])
})

test('catalog provenance keeps user/custom and third-party bundled resources exportable; preserves display bytes', async () => {
  const services = {
    agentPresets: {
      list: async () => [{ id: 'standard' }, { id: 'standard-custom', name: '  Review / QA\nteam  ', description: 'Keep / syntax\nand spacing' }]
    },
    skills: {
      list: async () => [
        { name: 'mine', description: 'Mine', source: 'user-dsh', provider: 'filesystem' },
        { name: 'project', description: 'Project', source: 'project-agents', provider: 'filesystem' },
        { name: 'vendor', description: 'Vendor', source: 'bundled', provider: 'third-party' },
        {
          name: 'office-custom',
          description: 'Custom assets',
          source: 'bundled',
          provider: 'dsh-office',
          resourceBase: { kind: 'directory', path: '/private/custom-office' }
        }
      ]
    },
    tools: { schemas: () => [{ name: 'mcp__custom__read', description: 'Custom MCP' }] }
  }
  const rows = await listHostResources({ get: name => services[name] })
  assert.deepEqual(
    rows.map(row => [row.id, row.provenance]),
    [
      ['standard', 'unknown'],
      ['standard-custom', 'custom'],
      ['mine', 'custom'],
      ['project', 'custom'],
      ['vendor', 'unknown'],
      ['office-custom', 'unknown'],
      ['mcp__custom__read', 'unknown']
    ]
  )
  assert.equal(rows[1].displayName, '  Review / QA\nteam  ')
  assert.equal(rows[1].description, 'Keep / syntax\nand spacing')
})

test('unnamed official preset requires exact public package plugins; user edits and missing proofs remain exportable', async () => {
  for (const id of ['standard', 'ptc', 'minimal', 'cordis']) {
    const patch = yaml.load(require('node:fs').readFileSync(require.resolve(`@deepseek-ai/dsh-web-app/presets/${id}.patch.yml`), 'utf8'), {
      schema: entryListSchema
    })
    const plugins = patch.flatMap(row => row.insert ?? []).find(row => row.config?.id === id).config.plugins
    const rows = await listHostResources({
      get: service =>
        service === 'agentPresets'
          ? {
              list: async () => [{ id }],
              readDocument: async () => ({ agentPreset: id, content: yaml.dump(plugins, { schema: entryListSchema, noRefs: true }) })
            }
          : undefined
    })
    assert.equal(rows[0].provenance, 'builtin', `public exported ${id} preset must classify by content proof`)
  }
  const patch = yaml.load(require('node:fs').readFileSync(require.resolve('@deepseek-ai/dsh-web-app/presets/minimal.patch.yml'), 'utf8'), {
    schema: entryListSchema
  })
  const plugins = patch.flatMap(row => row.insert ?? []).find(row => row.config?.id === 'minimal').config.plugins
  const official = yaml.dump(plugins, { schema: entryListSchema, noRefs: true })
  const edited = yaml.dump([...plugins, { name: 'user-plugin', config: { token: 'must-stay-private' } }], { schema: entryListSchema, noRefs: true })
  const observe = (content, row = { id: 'minimal' }) =>
    listHostResources({
      get: service =>
        service === 'agentPresets'
          ? {
              list: async () => [row],
              readDocument: async () => ({ agentPreset: row.id, content })
            }
          : undefined
    })
  assert.equal((await observe(official))[0].provenance, 'builtin')
  const custom = await observe(edited)
  assert.equal(custom[0].provenance, 'custom')
  assert.equal(JSON.stringify(custom).includes('must-stay-private'), false)
  assert.equal((await observe(official, { id: 'minimal', name: 'User-owned minimal' }))[0].provenance, 'custom')
  assert.equal((await observe(official, { id: 'not-a-shipped-preset' }))[0].provenance, 'unknown')
  assert.equal((await observe('malformed: [yaml'))[0].provenance, 'unknown')
})

test('official bundled Skill requires exact provider plus its real package assets, not a third-party bundle or symlink escape', () => {
  const root = mkdtempSync(join(tmpdir(), 'official-skill-assets-'))
  try {
    const assets = join(root, 'assets'),
      custom = join(root, 'custom')
    mkdirSync(join(assets, 'office-docx'), { recursive: true })
    mkdirSync(custom)
    const summary = {
      name: 'office-docx',
      description: 'Office',
      source: 'bundled',
      provider: 'dsh-office',
      resourceBase: { kind: 'directory', path: join(assets, 'office-docx') }
    }
    assert.equal(skillProvenance(summary, assets), 'builtin')
    assert.equal(skillProvenance({ ...summary, provider: 'third-party' }, assets), 'unknown')
    assert.equal(skillProvenance({ ...summary, resourceBase: { kind: 'directory', path: custom } }, assets), 'custom')
    symlinkSync(custom, join(assets, 'escape'))
    assert.equal(skillProvenance({ ...summary, resourceBase: { kind: 'directory', path: join(assets, 'escape') } }, assets), 'custom')
    assert.equal(skillProvenance({ ...summary, source: 'user-dsh' }, assets), 'custom')
    assert.equal(skillProvenance(summary), 'unknown')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('missing official Skill resource metadata uses only a targeted lookup and never forwards its content', async () => {
  let loaded = []
  const summary = { name: 'office-docx', description: 'Office', source: 'bundled', provider: 'dsh-office' }
  const rows = await listHostResources({
    get: service =>
      service === 'skills'
        ? {
            list: async () => [summary, { name: 'user', description: 'User', source: 'user-dsh', provider: 'filesystem' }],
            get: async name => {
              loaded.push(name)
              return { ...summary, content: 'private-skill-body', resourceBase: { kind: 'opaque', description: 'not-locatable' } }
            }
          }
        : undefined
  })
  assert.deepEqual(loaded, ['office-docx'])
  assert.equal(rows[0].provenance, 'unknown')
  assert.equal(JSON.stringify(rows).includes('private-skill-body'), false)
  assert.equal(JSON.stringify(rows).includes('not-locatable'), false)
})

test('resource catalog DTO whitelists public fields and forbids internal merge/locator data', () => {
  const row = {
    id: 'review',
    kind: 'skill',
    displayName: 'Review / QA',
    description: 'Keep public text',
    source: 'dsh',
    availability: 'available',
    provenance: 'custom',
    identity: 'review',
    refId: 'definition-key',
    path: '/private',
    providerConfig: { token: 'secret' }
  }
  assert.deepEqual(hostResourceCatalogValue([row]), {
    resources: [
      {
        id: 'review',
        kind: 'skill',
        displayName: 'Review / QA',
        description: 'Keep public text',
        source: 'dsh',
        availability: 'available',
        provenance: 'custom'
      }
    ]
  })
})

test('packaged preset and MCP artifact formats have strict kind/source constraints and enter file revision closure', () => {
  const root = mkdtempSync(join(tmpdir(), 'blueprint-resource-formats-'))
  try {
    mkdirSync(join(root, 'lib'))
    writeFileSync(join(root, 'lib/preset.json'), '{"plugins":[]}')
    writeFileSync(join(root, 'lib/mcp.json'), '{"serverName":"custom"}')
    const value = definition()
    value.resources.agent = { kind: 'agent', format: 'agent-preset', path: 'lib/preset.json' }
    value.resources.mcp = { kind: 'mcp', format: 'mcp-definition', path: 'lib/mcp.json', bindingId: 'mcp__custom__read' }
    const parsed = accepted(value)
    assert.deepEqual(Object.keys(computeRevision({ rootDir: root, definition: parsed }).files).sort(), ['lib/mcp.json', 'lib/preset.json'])
    for (const [kind, format] of [
      ['agent', 'mcp-definition'],
      ['skill', 'agent-preset'],
      ['mcp', 'agent-preset']
    ]) {
      const edited = structuredClone(value)
      edited.resources[kind].format = format
      invalid(edited, `/resources/${kind}`)
    }
    const host = definition()
    host.resources.agent.format = 'agent-preset'
    invalid(host, '/resources/agent')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('pure catalog merge keeps host first, deduplicates identity, reuses host refs and marks package collisions', () => {
  const host = {
    id: 'standard',
    kind: 'agent',
    displayName: 'Standard',
    description: '',
    source: 'dsh',
    availability: 'available',
    identity: 'standard',
    provenance: 'unknown'
  }
  const resources = {
    installed: { kind: 'agent', source: { kind: 'host', id: 'standard' } },
    absent: { kind: 'skill', source: { kind: 'host', id: 'missing' } },
    standard: { kind: 'agent', path: 'lib/agents/standard.md' },
    extra: { kind: 'skill', path: 'lib/skills/extra/SKILL.md' }
  }
  const rows = mergeResourceCatalog([host, { ...host, displayName: 'Duplicate' }], resources)
  assert.deepEqual(
    rows.map(row => [row.source, row.id]),
    [
      ['dsh', 'standard'],
      ['dsh', 'missing'],
      ['blueprint', 'standard'],
      ['blueprint', 'extra']
    ]
  )
  assert.equal(rows[0].refId, 'installed')
  assert.equal(rows[1].refId, 'absent')
  assert.equal(rows[1].availability, 'unavailable')
  assert.equal(rows[2].collision, true)
  assert.equal(rows[2].ref, resources.standard)
  assert.equal(rows[3].collision, undefined)
  assert.equal(host.refId, undefined)
})
