import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { decodeDefinition, validateDefinition } from '../../src/definition/index.ts'
import { computeRevision } from '../../src/definition/revision.ts'
import { mergeResourceCatalog, listHostResources } from '../../src/host/resource-catalog.ts'
import { exportBlueprint } from '../../src/portability/export.ts'
import { readZip } from '../../src/portability/zip.ts'
import { collectPreflight } from '../../src/host/preflight.ts'
import { RuntimeSnapshots } from '../../src/resources/runtime-snapshots.ts'

const base = resources => ({
  schemaVersion: 1,
  id: 'host-resource-blueprint',
  name: 'Host resource blueprint',
  resources,
  graph: { nodes: [{ id: 'input', kind: 'input', outputs: { value: 'string' } }], edges: [] },
})

test('C-14 host agent, skill and MCP sources round-trip as explicit logical identities', () => {
  const definition = base({
    preset: { kind: 'agent', source: { kind: 'host', id: 'preset-main' } },
    review: { kind: 'skill', source: { kind: 'host', id: 'review-skill' } },
    search: { kind: 'mcp', source: { kind: 'host', id: 'mcp__search__query' }, bindingId: 'mcp__search__query' },
  })
  const decoded = decodeDefinition(JSON.stringify(definition))
  validateDefinition(decoded)
  assert.deepEqual(decoded.resources, definition.resources)
})

test('C-14 host resources reject package paths and unknown source fields', () => {
  const withPath = base({ preset: { kind: 'agent', path: 'lib/agents/preset.md', source: { kind: 'host', id: 'preset-main' } } })
  assert.throws(() => validateDefinition(decodeDefinition(JSON.stringify(withPath))), error => error.code === 'DEFINITION_INVALID')
  const withUnknown = base({ preset: { kind: 'agent', source: { kind: 'host', id: 'preset-main', extra: true } } })
  assert.throws(() => decodeDefinition(JSON.stringify(withUnknown)), error => error.code === 'DEFINITION_INVALID')
})

test('C-16 modelSelection is strict, semantic, and preserves explicit provider/model/effort', () => {
  const definition = {
    ...base({ preset: { kind: 'agent', source: { kind: 'host', id: 'preset-main' } } }),
    graph: { nodes: [{ id: 'run', kind: 'agentTask', agentRef: 'preset', modelSelection: { provider: 'openai-responses', model: 'gpt-test', reasoningEffort: 'high' }, outputs: { text: 'string' } }], edges: [] },
  }
  const decoded = decodeDefinition(JSON.stringify(definition))
  validateDefinition(decoded)
  assert.deepEqual(decoded.graph.nodes[0].modelSelection, definition.graph.nodes[0].modelSelection)
  const withoutRoute = decodeDefinition(JSON.stringify({ ...definition, graph: { ...definition.graph, nodes: [{ ...definition.graph.nodes[0], modelSelection: undefined }] } }))
  assert.notEqual(computeRevision({ rootDir: tmpdir(), definition: decoded }).semantic, computeRevision({ rootDir: tmpdir(), definition: withoutRoute }).semantic)
  const invalid = { ...definition, graph: { ...definition.graph, nodes: [{ ...definition.graph.nodes[0], modelSelection: { provider: '', model: 'x', unknown: true } }] } }
  assert.throws(() => decodeDefinition(JSON.stringify(invalid)), error => error.code === 'DEFINITION_INVALID')
})

test('C-14 host catalog is DSH-first and appends definition resources without shadowing', async () => {
  const ctx = { get(name) {
    if (name === 'agentPresets') return { list: async () => [{ id: 'preset-main', name: 'Main', description: 'DSH preset' }, { id: 'broken', broken: 'unavailable' }] }
    if (name === 'skills') return { list: async () => [{ name: 'review-skill', description: 'Review', source: 'user-dsh', provider: 'filesystem', path: '/private/secret/SKILL.md', invocation: { modelInvocable: true, userInvocable: true } }] }
    if (name === 'tools') return { schemas: () => [{ name: 'mcp__search__query', description: 'Search' }, { name: 'run_code', description: 'reserved' }] }
    return undefined
  } }
  const host = await listHostResources(ctx, { cwd: '/private/secret/project' })
  assert.deepEqual(host.map(entry => [entry.kind, entry.id]), [['agent', 'preset-main'], ['agent', 'broken'], ['skill', 'review-skill'], ['mcp', 'mcp__search__query']])
  assert.equal(host.find(entry => entry.id === 'review-skill').path, undefined, 'absolute Skill path must stay host-side')
  const merged = mergeResourceCatalog(host, { 'review-skill': { kind: 'skill', path: 'lib/skills/review-skill' }, packageAgent: { kind: 'agent', path: 'lib/agents/a.md' } })
  assert.deepEqual(merged.slice(0, 4).map(entry => entry.source), ['dsh', 'dsh', 'dsh', 'dsh'])
  assert.ok(merged.some(entry => entry.source === 'blueprint' && entry.id === 'review-skill' && entry.collision === true))
})

test('C-15 proven official builtins stay out of archives while package closure and MCP binding remain', () => {
  const root = mkdtempSync(join(tmpdir(), 'bp-host-export-'))
  try {
    mkdirSync(join(root, 'lib', 'agents'), { recursive: true })
    writeFileSync(join(root, 'lib', 'agents', 'package.md'), 'package agent\n')
    const definition = base({
      hostAgent: { kind: 'agent', source: { kind: 'host', id: 'preset-main' } },
      packageAgent: { kind: 'agent', path: 'lib/agents/package.md' },
      search: { kind: 'mcp', source: { kind: 'host', id: 'mcp__search__query' }, bindingId: 'mcp__search__query' },
    })
    writeFileSync(join(root, 'blueprint.json'), JSON.stringify(definition))
    const result = exportBlueprint(root, { roots: [], exportedAt: '2026-10-13T00:00:00.000Z', hostResources: new Map([
      ['agent:preset-main', { provenance: 'builtin' }], ['mcp:mcp__search__query', { provenance: 'builtin' }],
    ]) })
    const names = readZip(result.archive).map(entry => entry.name)
    assert.ok(names.includes('lib/agents/package.md'))
    assert.equal(names.some(name => name.includes('preset-main') || name.includes('mcp__search__query')), false)
    assert.deepEqual(result.manifest.requiredBindings, ['mcp__search__query'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

function readyTeamHost() {
  const effects = []
  const forbidden = name => () => { effects.push(name); assert.fail(`${name} must not run during preflight`) }
  const services = {
    agents: { create: forbidden('agent-create') },
    tools: { get: () => undefined, restrict: forbidden('tool-restrict'), guard: forbidden('tool-guard') },
    agentPresets: { register: forbidden('preset-register') },
    loader: { entries: () => [{ options: { name: 'example-plugin' } }] },
    sessions: { get: forbidden('session-get'), flush: forbidden('session-flush') },
    subagents: { getProvider: name => ({ prepareContinuable: forbidden('subagent-prepare'), inheritsParentContext: name === 'fork' }) },
    agentTeams: Object.fromEntries(['membership', 'listMembers', 'createTask', 'spawnTeammate', 'sendMessage', 'getTask', 'listTasks', 'updateTask', 'waitForChange', 'interrupt'].map(name => [name, forbidden(`team-${name}`)])),
  }
  return { ctx: { get: name => services[name] }, effects }
}

function teamPresetFixture(role, kind = 'packaged') {
  const resources = {
    lead: { kind: 'agent', path: 'lib/lead.md' },
    member: { kind: 'agent', path: 'lib/member.md' },
    answer: { kind: 'schema', path: 'lib/answer.json' },
  }
  if (role) resources[role] = kind === 'host'
    ? { kind: 'agent', source: { kind: 'host', id: 'custom-agent' } }
    : { kind: 'agent', path: 'lib/preset.json', format: 'agent-preset' }
  const definition = decodeDefinition(JSON.stringify({
    ...base(resources),
    graph: { nodes: [{ id: 'work', kind: 'agentTask', agentRef: 'lead', outputSchemaRef: 'answer',
      teamStage: { task: { subject: 'Review', description: 'Review result' }, members: [{ name: 'worker', description: 'Review', agentRef: 'member', context: 'fresh' }], requiredChecks: ['schema'] },
    }], edges: [] },
  }))
  validateDefinition(definition)
  const files = new Map([
    ['lib/lead.md', Buffer.from('Lead instructions')], ['lib/member.md', Buffer.from('Member instructions')],
    ['lib/answer.json', Buffer.from('{"type":"object"}')],
    ['lib/preset.json', Buffer.from(JSON.stringify({ schemaVersion: 1, format: 'agent-preset', originalId: 'custom-agent', plugins: [{ name: 'example-plugin' }], requiredBindings: [] }))],
  ])
  return { definition, snapshot: { document: { blueprintId: definition.id, documentRevision: 'doc', semanticRevision: 'semantic' }, files } }
}

async function frozenTeamFixture(t, fixture) {
  const root = mkdtempSync(join(tmpdir(), 'bp-team-preset-admission-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const packageRoot = join(root, 'package')
  mkdirSync(join(packageRoot, 'lib'), { recursive: true })
  for (const [path, bytes] of fixture.snapshot.files) writeFileSync(join(packageRoot, path), bytes)
  const snapshots = new RuntimeSnapshots(join(root, 'runtime'))
  await snapshots.freezePackage('run', fixture.definition, packageRoot)
  return snapshots
}

for (const role of ['lead', 'member']) {
  test(`C-15 packaged Agent preset TeamStage ${role} blocks admission before effects`, async t => {
    const fixture = teamPresetFixture(role), host = readyTeamHost()
    const report = await collectPreflight(host.ctx, fixture.snapshot, fixture.definition, { skillRoots: [] })
    assert.equal(report.canStart, false, `packaged TeamStage ${role} must be blocked before runtime rejects it`)
    assert.ok(report.checks.some(check => check.code === 'teamstage-packaged-agent-unavailable' && check.status === 'block' && check.nodeId === 'work'))
    assert.equal(report.checks.some(check => check.code === 'node-executor-ready' && check.nodeId === 'work'), false)
    assert.equal(report.checks.some(check => check.code === 'teamstage-host-agent-unavailable'), false)
    assert.deepEqual(host.effects, [])
    const snapshots = await frozenTeamFixture(t, fixture)
    await assert.rejects(snapshots.prepareTeam('run', fixture.definition, fixture.definition.graph.nodes[0]), error => error.code === 'RESOURCE_UNAVAILABLE' && error.refId === role)
  })
  test(`C-14 Host Agent TeamStage ${role} preserves its distinct admission block`, async () => {
    const fixture = teamPresetFixture(role, 'host'), host = readyTeamHost()
    const report = await collectPreflight(host.ctx, fixture.snapshot, fixture.definition, { skillRoots: [], hostResources: { getAgentPreset: async () => ({ id: 'custom-agent' }) } })
    assert.equal(report.canStart, false)
    assert.ok(report.checks.some(check => check.code === 'teamstage-host-agent-unavailable' && check.status === 'block' && check.nodeId === 'work'))
    assert.equal(report.checks.some(check => check.code === 'teamstage-packaged-agent-unavailable'), false)
    assert.deepEqual(host.effects, [])
  })
}

test('C-15 packaged Agent preset ordinary AgentTask remains available', async t => {
  const fixture = teamPresetFixture('lead'), host = readyTeamHost()
  delete fixture.definition.graph.nodes[0].teamStage
  const report = await collectPreflight(host.ctx, fixture.snapshot, fixture.definition, { skillRoots: [] })
  assert.equal(report.canStart, true)
  assert.equal(report.checks.some(check => check.code.startsWith('teamstage-')), false)
  const snapshots = await frozenTeamFixture(t, fixture)
  const prepared = await snapshots.prepare('run', fixture.definition, fixture.definition.graph.nodes[0])
  assert.equal(prepared.agentComposition.format, 'agent-preset')
  assert.equal(prepared.agentMd, '')
  assert.deepEqual(host.effects, [])
})

test('C-15 Markdown Agent TeamStage remains available', async t => {
  const fixture = teamPresetFixture(), host = readyTeamHost()
  const report = await collectPreflight(host.ctx, fixture.snapshot, fixture.definition, { skillRoots: [] })
  assert.equal(report.canStart, true)
  assert.ok(report.checks.some(check => check.code === 'teamstage-executor-ready' && check.status === 'pass'))
  const snapshots = await frozenTeamFixture(t, fixture)
  const prepared = await snapshots.prepareTeam('run', fixture.definition, fixture.definition.graph.nodes[0])
  assert.equal(prepared.agentMd, 'Lead instructions')
  assert.equal(prepared.members[0].agentMd, 'Member instructions')
  assert.deepEqual(host.effects, [])
})
