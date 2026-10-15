// N-DEFINITION suite (W2.1): T02 (validation/persistence) and T10 (revisions,
// layout-only edits, conflict) behavior assertions against the built
// lib/definition.js module seam. Host/API-level definition evidence remains
// with its responsible waves.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'

const VALID_DEFINITION = {
  schemaVersion: 1,
  id: 'code-review',
  name: '代码审查',
  resources: {
    reviewer: { kind: 'agent', path: 'lib/agents/reviewer.md' },
    reviewSkill: { kind: 'skill', source: { kind: 'shared', rootId: 'user-agents-skills', path: 'skillA' } },
    resultSchema: { kind: 'schema', path: 'lib/schemas/review-result.json' },
    repoTools: { kind: 'mcp', bindingId: 'repo-readonly' }
  },
  graph: {
    nodes: [
      { id: 'input', kind: 'input', outputs: { request: 'string' } },
      {
        id: 'review',
        kind: 'agentTask',
        agentRef: 'reviewer',
        skillRefs: ['reviewSkill'],
        toolsetRefs: ['repoTools'],
        outputSchemaRef: 'resultSchema',
        inputs: { input: 'string' },
        outputs: { result: 'json' }
      },
      { id: 'result', kind: 'output', inputs: { value: 'json' } }
    ],
    edges: [
      { kind: 'data', from: 'input.request', to: 'review.input' },
      { kind: 'data', from: 'review.result', to: 'result.value' }
    ]
  },
  presentation: { nodes: { review: { x: 380, y: 160 } } }
}

function withFixture(run) {
  const root = mkdtempSync('/tmp/bp-definition-')
  try {
    return run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function preparePackageFiles(root) {
  mkdirSync(join(root, 'lib', 'agents'), { recursive: true })
  mkdirSync(join(root, 'lib', 'schemas'), { recursive: true })
  writeFileSync(join(root, 'lib', 'agents', 'reviewer.md'), 'reviewer prompt')
  writeFileSync(join(root, 'lib', 'schemas', 'review-result.json'), '{"type":"object"}')
}

function expectInvalid(run, wantedCode, wantedPointerIncludes) {
  try {
    run()
    return { ok: false, detail: 'expected DEFINITION_INVALID but nothing threw' }
  } catch (error) {
    if (error?.code !== 'DEFINITION_INVALID') {
      return { ok: false, detail: `wrong failure: ${String(error?.stack ?? error).slice(0, 200)}` }
    }
    const issue = error.issues.find(i => i.code === wantedCode)
    if (issue === undefined) return { ok: false, detail: `no issue ${wantedCode}: ${JSON.stringify(error.issues).slice(0, 200)}` }
    if (wantedPointerIncludes !== undefined && !(issue.pointer ?? '').includes(wantedPointerIncludes)) {
      return { ok: false, detail: `pointer ${issue.pointer} missing ${wantedPointerIncludes}` }
    }
    return { ok: true }
  }
}

export async function getCases(helpers) {
  const { packageRoot } = helpers
  const def = await import(join(packageRoot, 'lib', 'definition.js'))
  const cases = []

  cases.push({
    id: 'D1',
    title: 'T02: valid definition decodes, validates and save/load roundtrips the semantic revision',
    contract: 'C-02',
    expect: 'pass',
    run: () =>
      withFixture(root => {
        preparePackageFiles(root)
        const definition = JSON.parse(JSON.stringify(VALID_DEFINITION))
        const text = JSON.stringify(definition, null, 2)
        def.decodeDefinition(text)
        def.validateDefinition(def.decodeDefinition(text))
        const saved = def.saveDefinition(root, definition)
        const loaded = def.loadDefinition(root)
        return loaded.revision.semantic === saved.revision.semantic && loaded.definition.id === 'code-review'
      })
  })

  cases.push({
    id: 'D2',
    title: 'T02: unknown behavioral field is rejected with its JSON Pointer',
    contract: 'C-02',
    expect: 'pass',
    run: () => {
      const bad = JSON.parse(JSON.stringify(VALID_DEFINITION))
      bad.graph.autoRetry = true
      const verdict = expectInvalid(() => def.decodeDefinition(JSON.stringify(bad)), 'unknown-field', '/graph/autoRetry')
      return { ok: verdict.ok, ...(verdict.ok ? {} : { detail: verdict.detail }) }
    }
  })

  cases.push({
    id: 'D3',
    title: 'T02: malformed JSON fails with invalid-json (not a crash)',
    contract: 'C-02',
    expect: 'pass',
    run: () => {
      const verdict = expectInvalid(() => def.decodeDefinition('{"schemaVersion": 1, '), 'invalid-json')
      return { ok: verdict.ok, ...(verdict.ok ? {} : { detail: verdict.detail }) }
    }
  })

  cases.push({
    id: 'D4',
    title: 'T02: unknown schemaVersion fails closed',
    contract: 'C-02',
    expect: 'pass',
    run: () => {
      const bad = JSON.parse(JSON.stringify(VALID_DEFINITION))
      bad.schemaVersion = 2
      const verdict = expectInvalid(() => def.decodeDefinition(JSON.stringify(bad)), 'schema-version', '/schemaVersion')
      return { ok: verdict.ok, ...(verdict.ok ? {} : { detail: verdict.detail }) }
    }
  })

  cases.push({
    id: 'D5',
    title: 'T02: duplicate node id, dangling resource ref and port mismatches are located',
    contract: 'C-02',
    expect: 'pass',
    run: () => {
      const bad = JSON.parse(JSON.stringify(VALID_DEFINITION))
      bad.graph.nodes.push({ id: 'review', kind: 'output' })
      bad.graph.nodes[1].agentRef = 'missingAgent'
      bad.graph.edges.push({ kind: 'data', from: 'input.nope', to: 'result.value' })
      try {
        def.validateDefinition(def.decodeDefinition(JSON.stringify(bad)))
        return { ok: false, detail: 'expected DEFINITION_INVALID' }
      } catch (error) {
        if (error?.code !== 'DEFINITION_INVALID') return { ok: false, detail: `wrong failure: ${String(error).slice(0, 200)}` }
        const codes = error.issues.map(i => i.code).sort()
        const wanted = ['dangling-ref', 'dangling-ref', 'duplicate-id', 'port-mismatch']
        return codes.length >= wanted.length && wanted.every(w => codes.includes(w))
          ? { ok: true }
          : { ok: false, detail: `issues mismatch: ${JSON.stringify(error.issues.map(i => `${i.code}:${i.pointer ?? ''}`).slice(0, 10))}` }
      }
    }
  })

  cases.push({
    id: 'D6',
    title: 'T02/T07: data edge cycles are rejected (bounded iteration is the loop mechanism)',
    contract: 'C-07',
    expect: 'pass',
    run: () => {
      const bad = JSON.parse(JSON.stringify(VALID_DEFINITION))
      bad.graph.nodes[0].inputs = { request: 'string' }
      bad.graph.nodes[2].outputs = { value: 'string' }
      bad.graph.edges.push({ kind: 'data', from: 'result.value', to: 'input.request' })
      const verdict = expectInvalid(() => def.validateDefinition(def.decodeDefinition(JSON.stringify(bad))), 'cycle')
      return { ok: verdict.ok, ...(verdict.ok ? {} : { detail: verdict.detail }) }
    }
  })

  cases.push({
    id: 'D7',
    title: 'T02: escaping resource paths rejected; missing package file fails revision loudly',
    contract: 'C-02',
    expect: 'pass',
    run: () => {
      const escape = JSON.parse(JSON.stringify(VALID_DEFINITION))
      escape.resources.reviewer = { kind: 'agent', path: '../outside/reviewer.md' }
      const escapeVerdict = expectInvalid(() => def.validateDefinition(def.decodeDefinition(JSON.stringify(escape))), 'path-invalid')
      if (!escapeVerdict.ok) return { ok: false, detail: escapeVerdict.detail }
      return withFixture(root => {
        let threw = null
        try {
          def.saveDefinition(root, JSON.parse(JSON.stringify(VALID_DEFINITION)))
        } catch (error) {
          threw = error
        }
        return threw?.name === 'RevisionInputMissingError'
      })
    }
  })

  cases.push({
    id: 'D8',
    title: 'T10: layout-only edit changes layout revision, never the semantic revision',
    contract: 'C-10',
    expect: 'pass',
    run: () =>
      withFixture(root => {
        preparePackageFiles(root)
        const first = JSON.parse(JSON.stringify(VALID_DEFINITION))
        const saved = def.saveDefinition(root, first)
        const moved = JSON.parse(JSON.stringify(VALID_DEFINITION))
        moved.presentation.nodes.review = { x: 999, y: 1 }
        def.saveDefinition(root, moved, { expectedRevision: saved.revision.semantic })
        const loaded = def.loadDefinition(root)
        return loaded.revision.semantic === saved.revision.semantic && loaded.revision.layout !== saved.revision.layout
      })
  })

  cases.push({
    id: 'D9',
    title: 'T10: semantic edit changes the semantic revision; stale expectedRevision conflicts and keeps the stored file',
    contract: 'C-10',
    expect: 'pass',
    run: () =>
      withFixture(root => {
        preparePackageFiles(root)
        const first = JSON.parse(JSON.stringify(VALID_DEFINITION))
        const saved = def.saveDefinition(root, first)
        const edited = JSON.parse(JSON.stringify(VALID_DEFINITION))
        edited.graph.edges[1].to = 'result.otherValue'
        edited.graph.nodes[2].inputs.otherValue = 'json'
        const second = def.saveDefinition(root, edited, { expectedRevision: saved.revision.semantic })
        if (second.revision.semantic === saved.revision.semantic) return false
        let conflict = null
        try {
          def.saveDefinition(root, first, { expectedRevision: saved.revision.semantic })
        } catch (error) {
          conflict = error
        }
        if (conflict?.code !== 'REVISION_CONFLICT') return false
        const stored = def.loadDefinition(root)
        return stored.revision.semantic === second.revision.semantic
      })
  })

  cases.push({
    id: 'D10',
    title: 'T02: failed save leaves no staging residue and the previous definition intact',
    contract: 'C-02',
    expect: 'pass',
    run: () =>
      withFixture(root => {
        preparePackageFiles(root)
        const definition = JSON.parse(JSON.stringify(VALID_DEFINITION))
        def.saveDefinition(root, definition)
        const before = readFileSync(join(root, 'blueprint.json'), 'utf8')
        const staging = join(root, '.blueprint-staging')
        mkdirSync(staging)
        chmodSync(staging, 0o500)
        let threw = null
        try {
          def.saveDefinition(root, definition, { stagingDir: staging })
        } catch (error) {
          threw = error
        }
        // persist.ts removes the whole staging dir on failure (no residue);
        // only restore permissions when it somehow survived.
        if (existsSync(staging)) chmodSync(staging, 0o700)
        const after = readFileSync(join(root, 'blueprint.json'), 'utf8')
        const staged = existsSync(join(staging, 'blueprint.json'))
        return threw?.code === 'IO_WRITE_FAILED' && before === after && !staged
      })
  })

  return cases
}
