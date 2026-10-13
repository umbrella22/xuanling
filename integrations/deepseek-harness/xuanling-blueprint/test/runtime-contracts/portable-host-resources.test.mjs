/** Source-only artifact and public registry fixtures; no real profile,
 * provider credential or MCP connection is touched. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { packagePreset, packageMcp, resolveHostExportResources, validatePackagedMcp, validatePackagedPreset } from '../../src/portability/host-resources.ts'
import { exportBlueprint, writeZipWithManifest } from '../../src/portability/export.ts'
import { importBlueprint } from '../../src/portability/import.ts'
import { readZip } from '../../src/portability/zip.ts'
import { RuntimeSnapshots, createHostResourceProvider } from '../../src/resources/runtime-snapshots.ts'
import { resolveEffectiveToolNames } from '../../src/host/preflight.ts'
import { harness, directSpec, contentTool } from './agent-fixtures.mjs'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
function temporary(t) {
  const root = mkdtempSync(join(tmpdir(), 'bp-portable-host-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

test('custom Agent composition preserves !!js data and never treats YAML as Markdown; credentials become required bindings', () => {
  const artifact = packagePreset('custom-preset', `- name: example-plugin\n  disabled: !!js 'globalThis.EXPORT_MUST_NOT_EVALUATE = true'\n  config:\n    value: portable\n    apiKey: CREDENTIAL_SENTINEL\n    cwd: /machine/workspace\n`)
  assert.equal(globalThis.EXPORT_MUST_NOT_EVALUATE, undefined)
  assert.equal(artifact.plugins[0].disabled.__jsExpr, 'globalThis.EXPORT_MUST_NOT_EVALUATE = true')
  assert.equal(artifact.plugins[0].config.value, 'portable')
  assert.equal(JSON.stringify(artifact).includes('CREDENTIAL_SENTINEL'), false)
  assert.equal(JSON.stringify(artifact).includes('/machine/workspace'), false)
  assert.deepEqual(artifact.requiredBindings, ['/plugins/0/config/apiKey', '/plugins/0/config/cwd'])
})

test('preset and MCP URL userinfo/query/hash values become destination bindings', () => {
  const preset = packagePreset('custom-preset', `- name: '@deepseek-ai/dsh-mcp-client'\n  config:\n    url: https://user:PASSWORD_SENTINEL@server.example/mcp?auth=OPAQUE_SENTINEL#fragment\n`)
  assert.equal(preset.plugins[0].config.url, undefined)
  assert.deepEqual(preset.requiredBindings, ['/plugins/0/config/url'])
  assert.equal(JSON.stringify(preset).includes('PASSWORD_SENTINEL'), false)
  assert.equal(JSON.stringify(preset).includes('OPAQUE_SENTINEL'), false)
  assert.deepEqual(validatePackagedPreset(preset), preset)
  assert.throws(() => validatePackagedPreset({ ...preset, plugins: [{ ...preset.plugins[0], config: { url: 'https://user:PASSWORD_SENTINEL@server.example/mcp?auth=OPAQUE_SENTINEL' } }] }), /credential/)

  const mcp = packageMcp('mcp__custom__read', {
    transport: 'streamable-http', serverName: 'custom',
    url: 'https://user:PASSWORD_SENTINEL@server.example/mcp?auth=OPAQUE_SENTINEL#fragment',
  })
  assert.equal(mcp.config.url, undefined)
  assert.deepEqual(mcp.requiredBindings, ['/config/url'])
  assert.equal(JSON.stringify(mcp).includes('PASSWORD_SENTINEL'), false)
  assert.equal(JSON.stringify(mcp).includes('OPAQUE_SENTINEL'), false)
})

const whitespaceUrls = [
  ' https://user:PASSWORD_SENTINEL@server.example/mcp?auth=OPAQUE_SENTINEL',
  '\thttps://user:PASSWORD_SENTINEL@server.example/mcp',
  '\nhttps://server.example/mcp?auth=OPAQUE_SENTINEL',
  ' \t\r\nhttps://server.example/mcp#OPAQUE_SENTINEL',
  'ht\ttps://user:PASSWORD_SENTINEL@server.example/mcp',
  String.raw`https:\\user:PASSWORD_SENTINEL@server.example\mcp?auth=OPAQUE_SENTINEL`,
]
test('URL parser accepted whitespace credential/query/hash URLs become preset bindings', () => {
  for (const url of whitespaceUrls) {
    const parsed = new URL(url)
    assert.ok(parsed.username || parsed.password || parsed.search || parsed.hash)
    const artifact = packagePreset('custom-preset', JSON.stringify([{ name: '@deepseek-ai/dsh-mcp-client', config: { url } }]))
    assert.equal(artifact.plugins[0].config.url, undefined)
    assert.deepEqual(artifact.requiredBindings, ['/plugins/0/config/url'])
  }
})

test('imported preset validator rejects URL parser accepted whitespace credentials', () => {
  for (const url of whitespaceUrls) {
    assert.throws(() => validatePackagedPreset({ schemaVersion: 1, format: 'agent-preset', originalId: 'custom-preset',
      plugins: [{ name: '@deepseek-ai/dsh-mcp-client', config: { url } }], requiredBindings: [] }), /credential/)
  }
})

test('whitespace URL credentials never enter resolved Host preset export ZIP', async t => {
  const root = temporary(t), source = join(root, 'source'); mkdirSync(source)
  const definition = { schemaVersion: 1, id: 'url-whitespace', name: 'URL whitespace',
    resources: { agent: { kind: 'agent', source: { kind: 'host', id: 'custom-preset' } } },
    graph: { nodes: [{ id: 'task', kind: 'agentTask', agentRef: 'agent' }], edges: [] } }
  writeFileSync(join(source, 'blueprint.json'), JSON.stringify(definition))
  const ctx = { get(name) { return name === 'agentPresets' ? {
    list: async () => [{ id: 'custom-preset', name: 'Custom preset' }],
    readDocument: async () => ({ content: JSON.stringify([{ name: '@deepseek-ai/dsh-mcp-client', config: { url: whitespaceUrls[0] } }]) }),
  } : undefined } }
  const hostResources = await resolveHostExportResources(ctx, [definition], source)
  const exported = exportBlueprint(source, { roots: [], hostResources })
  const text = readZip(exported.archive).map(entry => entry.data.toString('utf8')).join('\n')
  assert.equal(text.includes('PASSWORD_SENTINEL'), false)
  assert.equal(text.includes('OPAQUE_SENTINEL'), false)
  assert.deepEqual(exported.manifest.requiredBindings, ['agent:/plugins/0/config/url'])
})

test('archive import rejects whitespace URL credentials after valid integrity checks', t => {
  const root = temporary(t), source = join(root, 'source'); mkdirSync(source)
  const definition = { schemaVersion: 1, id: 'unsafe-url-import', name: 'Unsafe URL import',
    resources: { agent: { kind: 'agent', source: { kind: 'host', id: 'custom-preset' } } },
    graph: { nodes: [{ id: 'task', kind: 'agentTask', agentRef: 'agent' }], edges: [] } }
  writeFileSync(join(source, 'blueprint.json'), JSON.stringify(definition))
  const preset = packagePreset('custom-preset', JSON.stringify([{ name: '@deepseek-ai/dsh-mcp-client', config: { url: 'https://server.example/mcp' } }]))
  const exported = exportBlueprint(source, { roots: [], hostResources: new Map([['agent:custom-preset', { provenance: 'custom', kind: 'agent', preset }]]) })
  for (const [index, url] of whitespaceUrls.entries()) {
    const files = new Map(readZip(exported.archive).filter(entry => entry.name !== 'portability.json').map(entry => [entry.name, { path: entry.name, bytes: entry.data }]))
    const artifact = JSON.parse(files.get('lib/host-resources/agent.json').bytes)
    artifact.plugins[0].config.url = url
    files.get('lib/host-resources/agent.json').bytes = Buffer.from(JSON.stringify(artifact))
    const manifest = structuredClone(exported.manifest)
    manifest.files = Object.fromEntries([...files.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, file]) => [path, digest(file.bytes)]))
    manifest.closureDigest = digest(Object.entries(manifest.files).map(([path, sha]) => `${path}\u0000${sha}\n`).join(''))
    assert.throws(() => importBlueprint(writeZipWithManifest(files, manifest), join(root, `import-${index}`)), /credential/)
  }
})

test('URL classification preserves ordinary strings and clean endpoint original bytes', () => {
  const values = ['ordinary value with spaces', 'not a URL?opaque#fragment', 'https://server.example/mcp', ' \thttps://server.example/mcp\n']
  for (const value of values) {
    const artifact = packagePreset('custom-preset', JSON.stringify([{ name: 'example-plugin', config: { value } }]))
    assert.equal(artifact.plugins[0].config.value, value)
    assert.deepEqual(artifact.requiredBindings, [])
  }
})

test('preset sanitization keeps ordinary token and secret option names', () => {
  const artifact = packagePreset('custom-preset', `- name: example-plugin\n  config:\n    maxTokens: 256\n    tokenLimit: 512\n    includeTokens: true\n    tokenizer: cl100k\n    secretMode: strict\n    passwordPrompt: false\n    accessToken: SECRET_SENTINEL\n    clientSecret: SECRET_SENTINEL\n`)
  assert.equal(artifact.plugins[0].config.maxTokens, 256)
  assert.equal(artifact.plugins[0].config.tokenLimit, 512)
  assert.equal(artifact.plugins[0].config.includeTokens, true)
  assert.equal(artifact.plugins[0].config.tokenizer, 'cl100k')
  assert.equal(artifact.plugins[0].config.secretMode, 'strict')
  assert.equal(artifact.plugins[0].config.passwordPrompt, false)
  assert.equal(artifact.plugins[0].config.accessToken, undefined)
  assert.equal(artifact.plugins[0].config.clientSecret, undefined)
  assert.deepEqual(artifact.requiredBindings, ['/plugins/0/config/accessToken', '/plugins/0/config/clientSecret'])
  assert.equal(JSON.stringify(artifact).includes('SECRET_SENTINEL'), false)
})

const credentialKeyVariants = ['apiKey', 'api_key', 'apikey', 'APIKEY', 'APIKey', 'ApiKEY', 'api-key', 'customAPIKey']
const ordinaryConfig = { maxTokens: 256, tokenLimit: 512, includeTokens: true, tokenizer: 'cl100k', secretMode: 'strict', passwordPrompt: false }
test('API key aliases and acronyms are omitted while ordinary config values stay exact', () => {
  for (const key of credentialKeyVariants) {
    const artifact = packagePreset('custom-preset', JSON.stringify([{ name: 'example-plugin', config: { ...ordinaryConfig, [key]: 'SYNTHETIC_CREDENTIAL_SENTINEL' } }]))
    assert.deepEqual(artifact.plugins[0].config, ordinaryConfig, key)
    assert.deepEqual(artifact.requiredBindings, [`/plugins/0/config/${key}`], key)
    assert.equal(JSON.stringify(artifact).includes('SYNTHETIC_CREDENTIAL_SENTINEL'), false, key)
  }
})

test('preset validator rejects API key aliases and acronyms without mutating ordinary config', () => {
  for (const key of credentialKeyVariants) {
    const artifact = { schemaVersion: 1, format: 'agent-preset', originalId: 'custom-preset',
      plugins: [{ name: 'example-plugin', config: { ...ordinaryConfig, [key]: 'SYNTHETIC_CREDENTIAL_SENTINEL' } }], requiredBindings: [] }
    const before = JSON.stringify(artifact)
    assert.throws(() => validatePackagedPreset(artifact), /credential/, key)
    assert.equal(JSON.stringify(artifact), before, 'validation must not rewrite imported integrity bytes')
  }
})

function credentialExportFixture(t) {
  const root = temporary(t), source = join(root, 'source'); mkdirSync(source)
  const definition = { schemaVersion: 1, id: 'credential-key', name: 'Credential key',
    resources: { agent: { kind: 'agent', source: { kind: 'host', id: 'custom-preset' } } },
    graph: { nodes: [{ id: 'task', kind: 'agentTask', agentRef: 'agent' }], edges: [] } }
  writeFileSync(join(source, 'blueprint.json'), JSON.stringify(definition))
  return { root, source, definition }
}

test('resolved Host preset export ZIP excludes every API key alias and keeps ordinary config exact', async t => {
  const { source, definition } = credentialExportFixture(t)
  for (const key of credentialKeyVariants) {
    const ctx = { get(name) { return name === 'agentPresets' ? {
      list: async () => [{ id: 'custom-preset', name: 'Custom preset' }],
      readDocument: async () => ({ content: JSON.stringify([{ name: 'example-plugin', config: { ...ordinaryConfig, [key]: 'SYNTHETIC_CREDENTIAL_SENTINEL' } }]) }),
    } : undefined } }
    const resources = await resolveHostExportResources(ctx, [definition], source)
    const exported = exportBlueprint(source, { roots: [], hostResources: resources }), entries = readZip(exported.archive)
    assert.equal(entries.some(entry => entry.data.toString('utf8').includes('SYNTHETIC_CREDENTIAL_SENTINEL')), false, key)
    const artifact = JSON.parse(entries.find(entry => entry.name === 'lib/host-resources/agent.json').data)
    assert.deepEqual(artifact.plugins[0].config, ordinaryConfig, key)
    assert.deepEqual(exported.manifest.requiredBindings, [`agent:/plugins/0/config/${key}`], key)
  }
})

test('integrity-valid archive import rejects every API key alias before publication', t => {
  const { root, source } = credentialExportFixture(t)
  const preset = packagePreset('custom-preset', JSON.stringify([{ name: 'example-plugin', config: ordinaryConfig }]))
  const exported = exportBlueprint(source, { roots: [], hostResources: new Map([['agent:custom-preset', { provenance: 'custom', kind: 'agent', preset }]]) })
  for (const [index, key] of credentialKeyVariants.entries()) {
    const files = new Map(readZip(exported.archive).filter(entry => entry.name !== 'portability.json').map(entry => [entry.name, { path: entry.name, bytes: entry.data }]))
    const artifact = JSON.parse(files.get('lib/host-resources/agent.json').bytes)
    artifact.plugins[0].config[key] = 'SYNTHETIC_CREDENTIAL_SENTINEL'
    files.get('lib/host-resources/agent.json').bytes = Buffer.from(JSON.stringify(artifact))
    const manifest = structuredClone(exported.manifest)
    manifest.files = Object.fromEntries([...files.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, file]) => [path, digest(file.bytes)]))
    manifest.closureDigest = digest(Object.entries(manifest.files).map(([path, sha]) => `${path}\u0000${sha}\n`).join(''))
    assert.throws(() => importBlueprint(writeZipWithManifest(files, manifest), join(root, `import-${index}`)), /credential/, key)
  }
})

test('custom MCP artifact carries portable connection definition, excludes values and marks destination bindings', () => {
  const artifact = packageMcp('mcp__custom__read', { transport: 'stdio', serverName: 'custom', command: 'npx',
    args: ['--yes', 'example-mcp'], env: { TOKEN: 'CREDENTIAL_SENTINEL' }, cwd: '/machine/workspace', toolCallTimeoutMs: 1234 })
  assert.equal(artifact.config.command, 'npx')
  assert.deepEqual(artifact.config.args, ['--yes', 'example-mcp'])
  assert.equal(JSON.stringify(artifact).includes('CREDENTIAL_SENTINEL'), false)
  assert.equal(JSON.stringify(artifact).includes('/machine/workspace'), false)
  assert.deepEqual(artifact.requiredBindings, ['/config/env/TOKEN', '/config/cwd'])
  assert.deepEqual(validatePackagedMcp(artifact), artifact)
  assert.throws(() => validatePackagedMcp({ ...artifact, config: { ...artifact.config, env: { TOKEN: 'CREDENTIAL_SENTINEL' } } }), /credential/)
  const http = packageMcp('mcp__custom__read', { transport: 'streamable-http', serverName: 'custom', url: 'https://server.example/mcp?token=hidden', headers: { Authorization: 'Bearer hidden' } })
  assert.equal(http.config.url, undefined)
  assert.deepEqual(http.requiredBindings, ['/config/headers/Authorization', '/config/url'])
  const machineArgs = packageMcp('mcp__custom__read', { transport: 'stdio', serverName: 'custom', command: 'npx', args: ['example-mcp', '/machine/workspace'] })
  assert.equal(machineArgs.config.args, undefined)
  assert.ok(machineArgs.requiredBindings.includes('/config/args'))
  assert.equal(JSON.stringify(machineArgs).includes('null'), false)
})

test('export-import-export preserves formatted Host artifact bindings and complete MCP identity', t => {
  const root = temporary(t), packageRoot = join(root, 'source')
  mkdirSync(packageRoot)
  const definition = {
    schemaVersion: 1, id: 'portable-roundtrip', name: 'Portable roundtrip',
    resources: {
      customAgent: { kind: 'agent', source: { kind: 'host', id: 'custom-preset' } },
      customMcp: { kind: 'mcp', bindingId: 'mcp__custom__read', source: { kind: 'host', id: 'mcp__custom__read' } },
    },
    graph: { nodes: [{ id: 'work', kind: 'agentTask', agentRef: 'customAgent', toolsetRefs: ['customMcp'] }], edges: [] },
  }
  writeFileSync(join(packageRoot, 'blueprint.json'), JSON.stringify(definition))
  const agent = packagePreset('custom-preset', `- name: example-plugin\n  config:\n    apiKey: AGENT_SECRET_SENTINEL\n    url: https://user:PASSWORD_SENTINEL@server.example/mcp?auth=OPAQUE_SENTINEL\n`)
  const mcp = packageMcp('mcp__custom__read', {
    transport: 'stdio', serverName: 'custom', command: 'npx', args: ['example-mcp'],
    env: { TOKEN: 'MCP_SECRET_SENTINEL' },
  })
  const first = exportBlueprint(packageRoot, { roots: [], hostResources: new Map([
    ['agent:custom-preset', { provenance: 'custom', kind: 'agent', preset: agent }],
    ['mcp:mcp__custom__read', { provenance: 'custom', kind: 'mcp', definition: mcp }],
  ]) })
  const imported = importBlueprint(first.archive, join(root, 'imported'))
  const second = exportBlueprint(imported.targetDir, { roots: [] })
  assert.deepEqual(second.manifest.requiredBindings, first.manifest.requiredBindings)
  assert.deepEqual(second.manifest.files, first.manifest.files)
  assert.ok(second.manifest.requiredBindings.includes('customAgent:/plugins/0/config/apiKey'))
  assert.ok(second.manifest.requiredBindings.includes('customAgent:/plugins/0/config/url'))
  assert.ok(second.manifest.requiredBindings.includes('customMcp:/config/env/TOKEN'))
  assert.ok(second.manifest.requiredBindings.includes('mcp__custom__read'))
})

test('unknown provenance custom MCP resolves matching public configEditor entry and excludes fixture secret', async () => {
  const ctx = { get(name) {
    if (name === 'tools') return { schemas: () => [{ name: 'mcp__custom__read', description: 'Read' }] }
    if (name === 'configEditor') return { entries: () => [{ options: { name: '@deepseek-ai/dsh-mcp-client', config: {
      transport: 'stdio', serverName: 'custom', command: 'npx', args: ['example-mcp'], env: { TOKEN: 'CREDENTIAL_SENTINEL' },
    } } }] }
    return undefined
  } }
  const definitions = [{ resources: { custom: { kind: 'mcp', bindingId: 'mcp__custom__read', source: { kind: 'host', id: 'mcp__custom__read' } } } }]
  const resources = await resolveHostExportResources(ctx, definitions, process.cwd())
  assert.equal(resources.get('mcp:mcp__custom__read').definition.config.command, 'npx')
  assert.equal(JSON.stringify([...resources.values()]).includes('CREDENTIAL_SENTINEL'), false)
})

test('export includes custom Skill full tree and typed Agent/MCP artifacts, excludes proven builtin body, import never executes', async t => {
  const root = temporary(t), packageRoot = join(root, 'source')
  mkdirSync(packageRoot)
  const definition = { schemaVersion: 1, id: 'portable-host', name: 'Portable Host resources', resources: {
    builtin: { kind: 'agent', source: { kind: 'host', id: 'official-preset' } },
    customAgent: { kind: 'agent', source: { kind: 'host', id: 'custom-preset' } },
    customSkill: { kind: 'skill', source: { kind: 'host', id: 'custom-skill' } },
    customMcp: { kind: 'mcp', bindingId: 'mcp__custom__read', source: { kind: 'host', id: 'mcp__custom__read' } },
  }, graph: { nodes: [{ id: 'work', kind: 'agentTask', agentRef: 'customAgent', skillRefs: ['customSkill'], toolsetRefs: ['customMcp'] }], edges: [] } }
  writeFileSync(join(packageRoot, 'blueprint.json'), JSON.stringify(definition))
  const files = [{ path: 'SKILL.md', bytes: Buffer.from('---\nname: custom-skill\n---\nSkill body') }, { path: 'assets/data.txt', bytes: Buffer.from('ASSET_BYTES') }]
    .map(file => ({ ...file, digest: digest(file.bytes) }))
  const hostResources = new Map([
    ['agent:official-preset', { provenance: 'builtin' }],
    ['agent:custom-preset', { provenance: 'custom', kind: 'agent', preset: packagePreset('custom-preset', '- name: example-plugin\n  config:\n    value: portable\n') }],
    ['skill:custom-skill', { provenance: 'custom', kind: 'skill', files }],
    ['mcp:mcp__custom__read', { provenance: 'custom', kind: 'mcp', definition: packageMcp('mcp__custom__read', { transport: 'stdio', serverName: 'custom', command: 'npx', args: ['example-mcp'] }) }],
  ])
  const exported = exportBlueprint(packageRoot, { roots: [], hostResources })
  assert.deepEqual(exported.manifest.hostResources, [{ kind: 'agent', id: 'official-preset' }])
  assert.ok(exported.manifest.requiredBindings.includes('mcp__custom__read'))
  assert.ok(exported.manifest.files['lib/host-resources/customAgent.json'])
  assert.ok(exported.manifest.files['lib/host-resources/customMcp.json'])
  assert.ok(exported.manifest.files['lib/host-resources/customSkill/assets/data.txt'])
  assert.throws(() => exportBlueprint(packageRoot, { roots: [] }), /provenance/)
  const imported = importBlueprint(exported.archive, join(root, 'imported'))
  const packaged = JSON.parse(readFileSync(join(imported.targetDir, 'blueprint.json'), 'utf8'))
  assert.equal(packaged.resources.builtin.source.kind, 'host')
  assert.equal(packaged.resources.customAgent.format, 'agent-preset')
  assert.equal(packaged.resources.customMcp.format, 'mcp-definition')
  assert.equal(packaged.resources.customSkill.source, undefined)
  assert.equal(readFileSync(join(imported.targetDir, 'lib/host-resources/customSkill/assets/data.txt'), 'utf8'), 'ASSET_BYTES')
  const snapshots = new RuntimeSnapshots(join(root, 'runtime'))
  await snapshots.freezePackage('run', packaged, imported.targetDir)
  const prepared = await snapshots.prepare('run', packaged, packaged.graph.nodes[0])
  assert.equal(prepared.agentMd, '')
  assert.equal(prepared.agentComposition.format, 'agent-preset')
  assert.equal(prepared.skills.length, 1)
})

test('packaged preset registers after dispatch admission and is disposed after fresh Agent cleanup; no Markdown injection', async t => {
  const h = await harness(t)
  const registrations = [], cleanup = []
  h.ctx.provide('agentPresets', { async register(value) {
    registrations.push(value)
    return async () => { cleanup.push(h.host.calls[0]?.disposed) }
  } })
  const composition = packagePreset('custom-preset', '- name: example-plugin\n')
  const result = await h.executor().execute(directSpec(h, { agentMd: '', agentComposition: composition }))
  assert.equal(result.outcome.ok, true)
  assert.equal(registrations.length, 1)
  assert.match(registrations[0].id, /^bp-preset-[0-9a-f]{16}-/)
  assert.deepEqual(registrations[0].plugins, composition.plugins)
  assert.equal(h.host.calls[0].options.meta.agentPreset, registrations[0].id)
  assert.deepEqual(cleanup, [true])
  assert.equal(result.scopedInjections.includes('agent@snapshot'), false)
})

test('Host preset Attempt digests bind immutable composition bytes, not only identity; normal Host config stays private', async t => {
  const root = temporary(t)
  let body = '- name: example-plugin\n  config:\n    persona: FIRST_PROMPT\n    apiKey: HOST_ONLY_SENTINEL\n'
  const provider = createHostResourceProvider({ get: name => name === 'agentPresets' ? {
    resolve: async id => ({ id }), readDocument: async () => ({ content: body }),
  } : undefined })
  const snapshots = new RuntimeSnapshots(join(root, 'runtime'), undefined, provider)
  const definition = { schemaVersion: 1, id: 'host-attempt', name: 'Host attempt', resources: { agent: { kind: 'agent', source: { kind: 'host', id: 'host-custom' } } }, graph: { nodes: [{ id: 'work', kind: 'agentTask', agentRef: 'agent' }], edges: [] } }
  await snapshots.freezePackage('run', definition)
  const first = await snapshots.prepare('run', definition, definition.graph.nodes[0])
  body = '- name: example-plugin\n  config:\n    persona: SECOND_PROMPT\n    apiKey: HOST_ONLY_SENTINEL\n'
  const second = await snapshots.prepare('run', definition, definition.graph.nodes[0])
  assert.notEqual(first.resourceDigests.agent, second.resourceDigests.agent)
  assert.equal(first.hostAgentComposition.plugins[0].config.persona, 'FIRST_PROMPT')
  assert.equal(second.hostAgentComposition.plugins[0].config.persona, 'SECOND_PROMPT')
  assert.equal(first.agentMd, '')
  assert.equal(JSON.stringify(first.resourceDigests).includes('HOST_ONLY_SENTINEL'), false)
})

test('packaged MCP exact tool fallback cannot be expanded by a same-name configured binding', async t => {
  const h = await harness(t)
  h.ctx.tools.register(contentTool('mcp__custom__read', () => 'read'))
  h.ctx.tools.register(contentTool('outsider', () => 'outside'))
  const definition = { resources: { custom: { kind: 'mcp', format: 'mcp-definition', bindingId: 'mcp__custom__read', path: 'lib/mcp.json' } } }
  const effective = resolveEffectiveToolNames(h.ctx, definition, { toolsetRefs: ['custom'] }, { mcp__custom__read: { tools: ['outsider'] } })
  assert.deepEqual(effective, ['mcp__custom__read'])
})
