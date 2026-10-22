/** W1.3 explicit definition contract. Source codecs/preflight and public service
 * admission run; no Team driver, native Team profile, model or provider is used. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeDefinition, validateDefinition, computeRevision, DefinitionInvalidError } from '../../src/definition/index.ts'
import { documentRevisions } from '../../src/definition/document.ts'
import { collectPreflight } from '../../src/host/preflight.ts'
import { harness, runArgs, records, drain, sha256, runSaved } from '../runtime-contracts/agent-fixtures.mjs'

const packageFiles = {
  'lib/agents/worker.md': 'definition worker\n',
  'lib/agents/alternate.md': 'definition alternate\n',
  'lib/schemas/answer.json': '{"type":"object","properties":{"answer":{"type":"number"}},"required":["answer"],"additionalProperties":false}'
}
const resourceDigests = Object.fromEntries(Object.entries(packageFiles).map(([path, bytes]) => [path, sha256(bytes)]))
const config = () => ({
  task: { subject: 'Review output', description: 'Review the schema and artifact.' },
  members: [
    { name: 'worker-one', description: 'Review schema', agentRef: 'worker', context: 'fresh' },
    { name: 'worker-two', description: 'Review artifact', agentRef: 'alternate', context: 'fork' }
  ],
  requiredChecks: ['schema', 'artifact-digest']
})
const ordinary = () => ({
  schemaVersion: 2,
  id: 'runtime-contracts',
  name: 'Definition config',
  resources: {
    worker: { kind: 'agent', path: 'lib/agents/worker.md' },
    alternate: { kind: 'agent', path: 'lib/agents/alternate.md' },
    answerSchema: { kind: 'schema', path: 'lib/schemas/answer.json' },
    alternateSchema: { kind: 'schema', path: 'lib/schemas/answer.json' }
  },
  graph: { nodes: [{ id: 'work', kind: 'agentTask', agentRef: 'worker', outputSchemaRef: 'answerSchema' }], edges: [] },
  presentation: { nodes: { work: { x: 20, y: 30 } } },
  metadata: { origin: 'legacy-fixture' }
})
function definition() {
  const value = ordinary()
  value.graph.nodes[0].teamStage = config()
  return value
}
function read(value) {
  const parsed = decodeDefinition(JSON.stringify(value))
  validateDefinition(parsed)
  return parsed
}
function invalid(value, code, pointer) {
  assert.throws(
    () => read(value),
    error => {
      assert.ok(error instanceof DefinitionInvalidError, 'definition failure must be typed, not an import/fixture error')
      assert.equal(error.code, 'DEFINITION_INVALID')
      assert.ok(
        error.issues.some(issue => issue.code === code && issue.pointer === pointer),
        `expected ${code} at ${pointer}, got ${JSON.stringify(error.issues)}`
      )
      return true
    }
  )
}
const change = mutate => {
  const value = definition()
  mutate(value.graph.nodes[0].teamStage, value.graph.nodes[0], value)
  return value
}
function snapshot(value) {
  return {
    document: {
      blueprintId: value.id,
      documentRevision: 'document-1',
      semanticRevision: 'semantic-1',
      layoutRevision: 'layout-1',
      definitionJson: JSON.stringify(value)
    },
    files: new Map(Object.entries(packageFiles).map(([path, bytes]) => [path, Buffer.from(bytes)]))
  }
}
function admissionContext() {
  const effects = []
  const forbidden = label => () => {
    effects.push(label)
    assert.fail(`${label} must not occur during unavailable-driver admission`)
  }
  const services = {
    agents: { create: forbidden('agent-create') },
    tools: { get: () => undefined, restrict: forbidden('tool-restrict'), guard: forbidden('tool-guard') },
    agentTeams: Object.fromEntries(
      ['membership', 'listMembers', 'createTask', 'spawnTeammate', 'sendMessage', 'getTask', 'listTasks', 'updateTask', 'waitForChange', 'interrupt'].map(
        name => [name, forbidden(`team-${name}`)]
      )
    )
  }
  return { ctx: { get: key => services[key] }, effects }
}

test('W1.3 C-02 valid TeamStage definition is readable without an unknown-field rejection', () => {
  const value = definition()
  assert.deepEqual(read(value), value)
})
test('W1.3 C-02 native text/name limits validate without rewriting authored values', () => {
  const value = change(team => {
    team.task.subject = `  ${'s'.repeat(200)}  `
    team.task.description = `\n${'d'.repeat(16_384)}\n`
    team.members[0].name = 'a'.repeat(64)
    team.members[0].description = `  ${'m'.repeat(200)}  `
    team.members[1].name = '0'
    team.requiredChecks = [' schema ', 'digest/用户']
  })
  assert.deepEqual(read(value), value)
})

for (const key of ['role', 'model', 'provider', 'toolFilter', 'createTeam', 'unknown']) {
  for (const [label, object, pointer] of [
    ['config', team => team, '/graph/nodes/0/teamStage'],
    ['task', team => team.task, '/graph/nodes/0/teamStage/task'],
    ['member', team => team.members[0], '/graph/nodes/0/teamStage/members/0']
  ]) {
    test(`W1.3 C-08 strict ${label} rejects ${key}`, () => {
      invalid(
        change(team => {
          object(team)[key] = 'forbidden'
        }),
        'unknown-field',
        `${pointer}/${key}`
      )
    })
  }
}
for (const [label, mutate, pointer] of [
  [
    'null config',
    (_team, node) => {
      node.teamStage = null
    },
    '/teamStage'
  ],
  [
    'missing task',
    team => {
      delete team.task
    },
    '/teamStage/task'
  ],
  [
    'missing members',
    team => {
      delete team.members
    },
    '/teamStage/members'
  ],
  [
    'missing checks',
    team => {
      delete team.requiredChecks
    },
    '/teamStage/requiredChecks'
  ],
  [
    'empty roster',
    team => {
      team.members = []
    },
    '/teamStage/members'
  ],
  [
    'empty checks',
    team => {
      team.requiredChecks = []
    },
    '/teamStage/requiredChecks'
  ],
  [
    'non-string check',
    team => {
      team.requiredChecks = [1]
    },
    '/teamStage/requiredChecks/0'
  ],
  [
    'blank check',
    team => {
      team.requiredChecks = [' \t\n']
    },
    '/teamStage/requiredChecks/0'
  ],
  [
    'blank subject',
    team => {
      team.task.subject = ' \n'
    },
    '/teamStage/task/subject'
  ],
  [
    'long subject',
    team => {
      team.task.subject = 's'.repeat(201)
    },
    '/teamStage/task/subject'
  ],
  [
    'subject type',
    team => {
      team.task.subject = 1
    },
    '/teamStage/task/subject'
  ],
  [
    'missing description',
    team => {
      delete team.task.description
    },
    '/teamStage/task/description'
  ],
  [
    'blank description',
    team => {
      team.task.description = '\t'
    },
    '/teamStage/task/description'
  ],
  [
    'long description',
    team => {
      team.task.description = 'd'.repeat(16_385)
    },
    '/teamStage/task/description'
  ],
  [
    'description type',
    team => {
      team.task.description = []
    },
    '/teamStage/task/description'
  ],
  [
    'missing name',
    team => {
      delete team.members[0].name
    },
    '/teamStage/members/0/name'
  ],
  [
    'uppercase name',
    team => {
      team.members[0].name = 'Worker'
    },
    '/teamStage/members/0/name'
  ],
  [
    'underscore name',
    team => {
      team.members[0].name = 'worker_one'
    },
    '/teamStage/members/0/name'
  ],
  [
    'path name',
    team => {
      team.members[0].name = '../worker'
    },
    '/teamStage/members/0/name'
  ],
  [
    'whitespace name',
    team => {
      team.members[0].name = ' worker '
    },
    '/teamStage/members/0/name'
  ],
  [
    'reserved name',
    team => {
      team.members[0].name = 'lead'
    },
    '/teamStage/members/0/name'
  ],
  [
    'long name',
    team => {
      team.members[0].name = 'a'.repeat(65)
    },
    '/teamStage/members/0/name'
  ],
  [
    'blank member description',
    team => {
      team.members[0].description = '  '
    },
    '/teamStage/members/0/description'
  ],
  [
    'long member description',
    team => {
      team.members[0].description = 'm'.repeat(201)
    },
    '/teamStage/members/0/description'
  ],
  [
    'missing context',
    team => {
      delete team.members[0].context
    },
    '/teamStage/members/0/context'
  ],
  [
    'wrong context',
    team => {
      team.members[0].context = 'inherit'
    },
    '/teamStage/members/0/context'
  ],
  [
    'missing member agent',
    team => {
      delete team.members[0].agentRef
    },
    '/teamStage/members/0/agentRef'
  ]
]) {
  test(`W1.3 C-02 malformed ${label} has an exact pointer`, () => {
    invalid(change(mutate), 'invalid-value', `/graph/nodes/0${pointer}`)
  })
}
for (const [label, mutate, code, pointer] of [
  [
    'non-agentTask',
    (_team, node) => {
      node.kind = 'output'
    },
    'invalid-value',
    '/teamStage'
  ],
  [
    'missing output schema',
    (_team, node) => {
      delete node.outputSchemaRef
    },
    'dangling-ref',
    '/outputSchemaRef'
  ],
  [
    'unknown output schema',
    (_team, node) => {
      node.outputSchemaRef = 'missing'
    },
    'dangling-ref',
    '/outputSchemaRef'
  ],
  [
    'wrong output resource',
    (_team, node) => {
      node.outputSchemaRef = 'worker'
    },
    'dangling-ref',
    '/outputSchemaRef'
  ],
  [
    'unknown member agent',
    team => {
      team.members[0].agentRef = 'missing'
    },
    'dangling-ref',
    '/teamStage/members/0/agentRef'
  ],
  [
    'wrong member resource',
    team => {
      team.members[0].agentRef = 'answerSchema'
    },
    'dangling-ref',
    '/teamStage/members/0/agentRef'
  ],
  [
    'duplicate member',
    team => {
      team.members[1].name = team.members[0].name
    },
    'duplicate-id',
    '/teamStage/members/1/name'
  ],
  [
    'duplicate check',
    team => {
      team.requiredChecks = ['schema', 'schema']
    },
    'duplicate-id',
    '/teamStage/requiredChecks/1'
  ]
]) {
  test(`W1.3 C-02 semantic ${label} has an exact pointer`, () => {
    invalid(change(mutate), code, `/graph/nodes/0${pointer}`)
  })
}
test('W1.3 C-02 single aggregate rejects only the second declared TeamStage', () => {
  const value = definition()
  value.graph.nodes.unshift({ id: 'input', kind: 'input' })
  value.graph.nodes.push({ ...structuredClone(value.graph.nodes[1]), id: 'second' })
  invalid(value, 'invalid-value', '/graph/nodes/2/teamStage')
})

test('W1.3 C-02 legacy definition shape and semantic revisions remain unchanged', t => {
  const value = ordinary()
  const parsed = read(value)
  assert.deepEqual(parsed, value)
  assert.equal(Object.hasOwn(parsed.graph.nodes[0], 'teamStage'), false)
  const rootDir = mkdtempSync(join(tmpdir(), 'bp-team-definition-'))
  t.after(() => rmSync(rootDir, { recursive: true, force: true }))
  for (const [path, bytes] of Object.entries(packageFiles)) {
    mkdirSync(join(rootDir, path, '..'), { recursive: true })
    writeFileSync(join(rootDir, path), bytes)
  }
  const revision = computeRevision({ rootDir, definition: parsed })
  const document = documentRevisions(parsed, resourceDigests)
  assert.equal(revision.semantic, '8bc873f93f035632adcc5c70d086f4283870bd1ea45570c8a30183557880337e')
  assert.equal(document.semanticRevision, '6f18d3e8ccecde884bc2e469101b57c2184cbc771107473616fcc3b6538794ce')
})
for (const [label, mutate] of [
  [
    'task subject',
    team => {
      team.task.subject = 'Changed subject'
    }
  ],
  [
    'task description',
    team => {
      team.task.description = 'Changed description'
    }
  ],
  [
    'member name',
    team => {
      team.members[0].name = 'changed-worker'
    }
  ],
  [
    'member description',
    team => {
      team.members[0].description = 'Changed member'
    }
  ],
  [
    'member agent',
    team => {
      team.members[0].agentRef = 'alternate'
    }
  ],
  [
    'member context',
    team => {
      team.members[0].context = 'fork'
    }
  ],
  [
    'member roster',
    team => {
      team.members.pop()
    }
  ],
  [
    'required checks',
    team => {
      team.requiredChecks.push('extra-check')
    }
  ],
  [
    'output schema ref',
    (_team, node) => {
      node.outputSchemaRef = 'alternateSchema'
    }
  ]
]) {
  test(`W1.3 C-02 ${label} changes the semantic revision`, t => {
    const rootDir = mkdtempSync(join(tmpdir(), 'bp-team-semantic-'))
    t.after(() => rmSync(rootDir, { recursive: true, force: true }))
    for (const [path, bytes] of Object.entries(packageFiles)) {
      mkdirSync(join(rootDir, path, '..'), { recursive: true })
      writeFileSync(join(rootDir, path), bytes)
    }
    const before = read(definition()),
      after = read(change(mutate))
    assert.notEqual(computeRevision({ rootDir, definition: before }).semantic, computeRevision({ rootDir, definition: after }).semantic)
    assert.notEqual(documentRevisions(before, resourceDigests).semanticRevision, documentRevisions(after, resourceDigests).semanticRevision)
  })
}
test('W1.3 C-02 schema bytes are semantic, presentation changes are layout only', t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'bp-team-schema-'))
  t.after(() => rmSync(rootDir, { recursive: true, force: true }))
  for (const [path, bytes] of Object.entries(packageFiles)) {
    mkdirSync(join(rootDir, path, '..'), { recursive: true })
    writeFileSync(join(rootDir, path), bytes)
  }
  const before = read(definition()),
    moved = structuredClone(before)
  moved.presentation.nodes.work.x = 50
  const initial = computeRevision({ rootDir, definition: before })
  const layout = computeRevision({ rootDir, definition: moved })
  assert.equal(initial.semantic, layout.semantic)
  assert.notEqual(initial.layout, layout.layout)
  assert.equal(documentRevisions(before, resourceDigests).semanticRevision, documentRevisions(moved, resourceDigests).semanticRevision)
  writeFileSync(join(rootDir, 'lib/schemas/answer.json'), '{"type":"object"}')
  assert.notEqual(initial.semantic, computeRevision({ rootDir, definition: before }).semantic)
})

test('W1.3 C-08 undeployed TeamStage driver blocks preflight before any effect', async () => {
  // Exercise the admission component separately from decoding: on the old
  // implementation this oracle reaches the silent ordinary-agent fallback.
  const value = definition(),
    host = admissionContext()
  const report = await collectPreflight(host.ctx, snapshot(value), value, { skillRoots: [] })
  assert.equal(report.canStart, false, 'undeployed TeamStage driver must not be admitted as an ordinary agentTask')
  assert.ok(report.checks.some(check => check.code === 'teamstage-executor-unavailable' && check.status === 'block' && check.nodeId === 'work'))
  assert.equal(
    report.checks.some(check => check.code === 'node-executor-ready' && check.nodeId === 'work'),
    false
  )
  assert.deepEqual(host.effects, [], 'refusal must not create or then cancel a Team task/member/Agent')
})
test('W1.3 C-08 driver absence blocks independently of the optional Team profile', async () => {
  const value = read(definition()),
    host = admissionContext()
  const withoutTeam = { get: key => (key === 'agentTeams' ? undefined : host.ctx.get(key)) }
  const report = await collectPreflight(withoutTeam, snapshot(value), value, { skillRoots: [] })
  assert.equal(report.canStart, false)
  assert.ok(report.checks.some(check => check.code === 'teamstage-executor-unavailable' && check.nodeId === 'work'))
  assert.deepEqual(host.effects, [])
})
test('W1.3 C-08 metadata TeamStage hint is inert and ordinary preflight is unchanged', async () => {
  const value = ordinary(),
    host = admissionContext()
  value.metadata.teamStage = config()
  const parsed = read(value)
  const report = await collectPreflight(host.ctx, snapshot(parsed), parsed, { skillRoots: [] })
  assert.equal(report.canStart, true)
  assert.equal(
    report.checks.some(check => check.code.startsWith('teamstage-')),
    false
  )
  assert.deepEqual(host.effects, [])
})
test('W1.3 C-08 public admission refuses unavailable TeamStage before durable Run or cancellation effects', async t => {
  const h = await harness(t)
  writeFileSync(join(h.rootDir, 'lib/agents/alternate.md'), packageFiles['lib/agents/alternate.md'])
  const effects = []
  h.ctx.provide(
    'agentTeams',
    Object.fromEntries(
      ['membership', 'listMembers', 'createTask', 'spawnTeammate', 'sendMessage', 'getTask', 'listTasks', 'updateTask', 'waitForChange', 'interrupt'].map(
        name => [
          name,
          () => {
            effects.push(name)
            assert.fail(`unexpected Team ${name}`)
          }
        ]
      )
    )
  )
  const value = definition()
  delete value.resources.alternateSchema // Public resource admission forbids path aliases.
  const doc = await h.save(value),
    args = runArgs(doc)
  const report = await h.service.preflightRun({ blueprintId: args.blueprintId, expectedRevision: args.expectedRevision, inputJson: args.inputJson })
  assert.equal(report.canStart, false)
  assert.ok(report.checks.some(check => check.code === 'teamstage-executor-unavailable' && check.nodeId === 'work'))
  await assert.rejects(h.service.startRun(args), error => {
    assert.equal(error.code, 'blueprint/preflight-blocked')
    assert.ok(error.details.checks.some(check => check.code === 'teamstage-executor-unavailable'))
    return true
  })
  await drain(h)
  assert.equal((await records(h)).length, 0)
  assert.equal(h.host.calls.length, 0)
  assert.deepEqual(h.effects, [])
  assert.deepEqual(effects, [], 'blocked declaration has no task/member creation or cancellation to compensate')
})
test('W1.3 C-08 malformed TeamStage save is typed and has no effect to cancel', async t => {
  const h = await harness(t)
  await assert.rejects(
    h.save(
      change(team => {
        team.members[0].role = 'reviewer'
      })
    ),
    error => {
      assert.equal(error.code, 'blueprint/definition-invalid')
      return true
    }
  )
  assert.equal(h.host.calls.length, 0)
  assert.deepEqual(h.effects, [])
})
test('W1.3 C-08 legacy ordinary agentTask still runs through the unchanged driver', async t => {
  const h = await harness(t)
  const value = ordinary()
  delete value.graph.nodes[0].outputSchemaRef
  delete value.resources.alternate
  delete value.resources.alternateSchema
  const { record } = await runSaved(h, value)
  assert.equal(record.state, 'succeeded')
  assert.equal(record.teamStage, undefined)
  assert.equal(h.host.calls.length, 1)
})
