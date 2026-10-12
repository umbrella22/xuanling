// Operator-owned, keyless fixtures. Never read a real profile, Skill, or key.
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function performanceDefinition() {
  const resources = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`agent-${i}`, { kind: 'agent', path: `lib/agents/a-${i}.md` }]))
  const nodes = [], edges = [], positions = {}
  for (let i = 0; i < 100; i++) {
    const index = String(i).padStart(3, '0')
    nodes.push({ id: `perf-in-${index}`, kind: 'input', outputs: { value: 'string' } })
    nodes.push({ id: `perf-out-${index}`, kind: 'output', inputs: { a: 'string', b: 'string', c: 'string' } })
    positions[`perf-in-${index}`] = { x: (i % 10) * 600, y: Math.floor(i / 10) * 420 }
    positions[`perf-out-${index}`] = { x: (i % 10) * 600 + 300, y: Math.floor(i / 10) * 420 }
    for (const [offset, port] of ['a', 'b', 'c'].entries()) {
      edges.push({ kind: 'data', from: `perf-in-${String((i + offset) % 100).padStart(3, '0')}.value`, to: `perf-out-${index}.${port}` })
    }
  }
  return { schemaVersion: 1, id: 'canvas-performance', name: 'Performance · 200 / 300 / 20', resources,
    graph: { nodes, edges }, presentation: { nodes: positions }, metadata: { fixture: 'w3-performance-v1' } }
}
const structural = id => ({ schemaVersion: 1, id, name: id, resources: {}, graph: {
  nodes: [{ id: 'in', kind: 'input', outputs: { request: 'string' } }, { id: 'out', kind: 'output', inputs: { value: 'string' } }],
  edges: [{ kind: 'data', from: 'in.request', to: 'out.value' }],
}, presentation: { nodes: { in: { x: 80, y: 80 }, out: { x: 460, y: 80 } } } })
export function canvasDefinitions() {
  const alpha = structural('canvas-alpha')
  alpha.name = 'Canvas alpha'
  alpha.resources = { a: { kind: 'agent', path: 'lib/agents/a.md' }, skill: { kind: 'skill', source: { kind: 'shared', rootId: 'probe-skills', path: 'sample' } } }
  alpha.graph.nodes[0].outputs.number = 'number'
  alpha.graph.nodes.push({ id: 'spare', kind: 'output', inputs: { value: 'string' } })
  alpha.presentation.nodes.spare = { x: 460, y: 460 }
  alpha.metadata = { retained: { note: 'Keep all existing document fields' } }
  const beta = structural('canvas-beta')
  beta.name = 'Canvas beta'
  const approval = { schemaVersion: 1, id: 'canvas-approval', name: 'Approval workflow', resources: {}, graph: {
    nodes: [{ id: 'gate', kind: 'humanDecision' }, { id: 'out', kind: 'output' }], edges: [{ kind: 'control', from: 'gate', to: 'out' }],
  }, presentation: { nodes: { gate: { x: 80, y: 80 }, out: { x: 460, y: 80 } } } }
  const portable = structural('probe-portable')
  portable.resources = { a: { kind: 'agent', path: 'lib/agents/a.md' } }
  const skill = structural('probe-skill')
  skill.resources = { probe: { kind: 'skill', source: { kind: 'shared', rootId: 'probe-skills', path: 'sample' } } }
  return [structural('probe-lifecycle'), portable, skill, alpha, beta, approval, performanceDefinition()]
}
export function fixtureEvidence(definition) {
  const json = JSON.stringify(definition)
  return { id: definition.id, nodes: definition.graph.nodes.length, edges: definition.graph.edges.length,
    resources: Object.keys(definition.resources).length, json, sha256: createHash('sha256').update(json).digest('hex'), generator: 'canvas-fixtures.mjs:performanceDefinition/w3-performance-v1' }
}
export function prepareCanvasFixtures(tempRoot, decodeDefinition, validateDefinition) {
  const config = { blueprints: {}, runtimeRoot: join(tempRoot, 'runtime'), skillRoots: [{ rootId: 'probe-skills', rootPath: join(tempRoot, 'shared-skills') }] }
  const evidence = []
  mkdirSync(config.runtimeRoot, { recursive: true })
  mkdirSync(join(config.skillRoots[0].rootPath, 'sample'), { recursive: true })
  writeFileSync(join(config.skillRoots[0].rootPath, 'sample', 'SKILL.md'), '---\nname: sample\ndescription: host probe\n---\nCONTENT-H1\n')
  for (const definition of canvasDefinitions()) {
    // Same production decoder/validator used by host save. A broken fixture
    // fails before install/boot, never counts as a product red assertion.
    validateDefinition(decodeDefinition(JSON.stringify(definition)))
    const root = join(tempRoot, 'blueprints', definition.id)
    config.blueprints[definition.id] = root
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'blueprint.json'), JSON.stringify(definition))
    for (const ref of Object.values(definition.resources)) if (ref.path) {
      mkdirSync(join(root, 'lib', 'agents'), { recursive: true })
      writeFileSync(join(root, ref.path), '---\nname: fixture-agent\ndescription: isolated keyless Agent\n---\nReturn the supplied input.\n')
    }
    evidence.push(fixtureEvidence(definition))
  }
  return { config, evidence, skillDir: join(config.skillRoots[0].rootPath, 'sample') }
}
