// Deterministic fixture/loader contracts only; these never claim browser or provider evidence.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync, readFileSync, mkdirSync, readdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as ui from '../../../../../test/blueprint/capabilities/conversation-ui.mjs'
import { ROOT, confined } from '../../../../../test/blueprint/capabilities/conversation-evidence.mjs'
import { decodeDefinition, validateDefinition } from '../../src/definition/index.ts'
import { KEYLESS_SEED_TEXT, APPROVAL_FILE_CONTENT } from '../../../../../test/blueprint/capabilities/conversation-runtime.mjs'
import { approvalSettlementObservation } from '../../../../../test/blueprint/capabilities/conversation-browser.mjs'

const { TYPERT } = await import(pathToFileURL(join(ROOT, 'test/blueprint/node_modules/@deepseek-ai/dsh-api-session-controller/lib/typert.host.js')).href)
const { TYPERT: WORKSPACE_TYPERT } = await import(
  pathToFileURL(join(ROOT, 'test/blueprint/node_modules/@deepseek-ai/dsh-api-workspace-controller/lib/typert.host.js')).href
)

const path = join(ROOT, 'test/blueprint/capabilities/conversation-fixture.mjs')
const fixture = await import(pathToFileURL(path).href).catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error
  return {}
})
function policyHarness(mode) {
  const hooks = new Map()
  fixture.installFixturePolicies({ on: (name, handler) => hooks.set(name, handler) }, mode)
  return hooks
}
test('keyless guard blocks the real Agent pre-step without replacing requests or completing Sessions', async () => {
  const hooks = policyHarness('keyless'),
    enter = { kind: 'enter', messages: [] }
  assert.equal(hooks.has('llm/stream'), false)
  assert.deepEqual(await hooks.get('agent/pre-step')({ agent: { id: 'conversation-fixture-source-unit' } }, async () => enter), { kind: 'reject' })
  assert.equal(await hooks.get('agent/pre-step')({ agent: { id: 'ordinary-user-session' } }, async () => enter), enter)
})
test('native write ask preserves upstream denial and leaves unrelated calls and Sessions alone', async () => {
  const hooks = policyHarness('live'),
    check = hooks.get('tools/pre-execute')
  const exec = { name: 'write', agent: { id: 'conversation-fixture-source-unit' }, arguments: { file_path: 'native-approval.txt' } }
  assert.equal((await check(exec, async () => ({ kind: 'allow' }))).kind, 'ask')
  const denied = { kind: 'deny', reason: 'actual upstream policy' }
  assert.equal(await check(exec, async () => denied), denied)
  for (const other of [
    { ...exec, name: 'blueprint_start' },
    { ...exec, agent: { id: 'ordinary-session' } },
    { ...exec, arguments: { file_path: 'other.txt' } }
  ]) {
    const allowed = { kind: 'allow' }
    assert.equal(await check(other, async () => allowed), allowed)
  }
})
function nativePage(actions, state = {}) {
  Object.assign(state, { expanded: true, preview: false, selected: null, ...state })
  const preview = {
    isVisible: async () => state.preview,
    waitFor: async ({ state: visibility }) => {
      assert.equal(visibility, 'hidden')
      assert.equal(state.preview, false)
    },
    getByRole: (role, options) => {
      assert.equal(role, 'button')
      assert.ok(options.name.test(state.continueLabel ?? 'Continue'))
      assert.equal(options.name.test('Continue another operation'), false)
      return {
        click: async () => {
          actions.push('native-preview-continue')
          if (!state.acknowledgementFails) state.preview = false
        }
      }
    }
  }
  const workspace = {
    waitFor: async () => {},
    count: async () => state.workspaceCount ?? 1,
    getAttribute: async name => {
      assert.equal(name, 'aria-expanded')
      return String(state.expanded)
    },
    click: async () => {
      assert.equal(state.preview, false, 'preview notice blocks native workspace interaction')
      assert.equal(state.expanded, false, 'already expanded ungrouped row must not be toggled closed')
      actions.push('native-ungrouped-row')
      state.expanded = true
    }
  }
  return {
    locator: selector => {
      if (selector === '[data-row-key="workspace:"][role="treeitem"]') return workspace
      const match = /^\[data-row-key="session:([A-Za-z0-9_-]+)"\]\[role="treeitem"\]$/.exec(selector)
      assert.ok(match, 'only exact ungrouped and Session tree rows are supported')
      return {
        waitFor: async () => {
          if (state.preview || !state.expanded || state.sessionMissing) throw new Error('native Session row is unavailable')
        },
        count: async () => 1,
        click: async () => {
          assert.equal(state.preview, false)
          assert.equal(state.expanded, true)
          actions.push(selector)
          state.selected = match[1]
        },
        getAttribute: async () => (state.selected === match[1] ? 'true' : 'false')
      }
    },
    getByRole: (role, options) => {
      assert.equal(role, 'dialog')
      assert.ok(options.name.test(state.previewTitle ?? 'Preview Notice'))
      assert.equal(options.name.test('Unrelated dialog'), false)
      return preview
    }
  }
}
function workspaceNavigationHarness(state) {
  const actions = [],
    calls = [],
    sourceId = 'conversation-fixture-source-unit',
    plainId = 'conversation-fixture-plain-unit'
  const gateway = {
    call: async (method, args) => {
      assert.equal(method, 'session/list')
      assert.deepEqual(args, { _request: {} })
      calls.push(method)
      return { items: [sourceId, plainId].map(sessionId => ({ sessionId, blank: false, running: false })) }
    }
  }
  return { actions, calls, gateway, page: nativePage(actions, state), sourceId, plainId }
}
test('native workspace navigation acknowledges the blocking preview notice in zh/en before expanding ungrouped Sessions', async () => {
  for (const [previewTitle, continueLabel] of [
    ['预览版说明', '继续'],
    ['Preview Notice', 'Continue']
  ]) {
    const h = workspaceNavigationHarness({ expanded: false, preview: true, previewTitle, continueLabel })
    await fixture.openSession({ page: h.page, gateway: h.gateway, sessionId: h.sourceId })
    assert.deepEqual(h.actions, ['native-preview-continue', 'native-ungrouped-row', `[data-row-key="session:${h.sourceId}"][role="treeitem"]`])
    assert.deepEqual(h.calls, ['session/list'])
  }
})
test('native workspace navigation expands a collapsed ungrouped row when no preview notice is present', async () => {
  const h = workspaceNavigationHarness({ expanded: false })
  await fixture.openSession({ page: h.page, gateway: h.gateway, sessionId: h.plainId })
  assert.deepEqual(h.actions, ['native-ungrouped-row', `[data-row-key="session:${h.plainId}"][role="treeitem"]`])
})
test('native workspace navigation acknowledges preview without closing an already expanded ungrouped row', async () => {
  const h = workspaceNavigationHarness({ preview: true })
  await fixture.openSession({ page: h.page, gateway: h.gateway, sessionId: h.sourceId })
  assert.deepEqual(h.actions, ['native-preview-continue', `[data-row-key="session:${h.sourceId}"][role="treeitem"]`])
})
test('native workspace navigation reopens source/plain idempotently and acknowledges preview again on a fresh origin', async () => {
  const state = { expanded: false, preview: true },
    h = workspaceNavigationHarness(state)
  for (const sessionId of [h.sourceId, h.plainId, h.sourceId]) await fixture.openSession({ page: h.page, gateway: h.gateway, sessionId })
  assert.deepEqual(h.actions, [
    'native-preview-continue',
    'native-ungrouped-row',
    ...[h.sourceId, h.plainId, h.sourceId].map(id => `[data-row-key="session:${id}"][role="treeitem"]`)
  ])
  state.preview = true
  state.expanded = false
  h.actions.length = 0
  await fixture.openSession({ page: h.page, gateway: h.gateway, sessionId: h.sourceId })
  assert.deepEqual(h.actions, ['native-preview-continue', 'native-ungrouped-row', `[data-row-key="session:${h.sourceId}"][role="treeitem"]`])
})
test('native workspace navigation does not click through a preview acknowledgement that remains blocked', async () => {
  const h = workspaceNavigationHarness({ expanded: false, preview: true, acknowledgementFails: true })
  await assert.rejects(() => fixture.openSession({ page: h.page, gateway: h.gateway, sessionId: h.sourceId }))
  assert.deepEqual(h.actions, ['native-preview-continue'])
})
test('native workspace navigation preserves missing Session failure after native expansion', async () => {
  const h = workspaceNavigationHarness({ expanded: false, sessionMissing: true })
  await assert.rejects(() => fixture.openSession({ page: h.page, gateway: h.gateway, sessionId: h.sourceId }), { code: 'FIXTURE_NATIVE_SESSION_ROW_MISSING' })
  assert.deepEqual(h.actions, ['native-ungrouped-row'])
})
test('native workspace navigation refuses missing or ambiguous ungrouped rows instead of guessing another workspace', async () => {
  for (const workspaceCount of [0, 2]) {
    const h = workspaceNavigationHarness({ expanded: false, workspaceCount })
    await assert.rejects(() => fixture.openSession({ page: h.page, gateway: h.gateway, sessionId: h.sourceId }), {
      code: 'FIXTURE_NATIVE_WORKSPACE_ROW_MISSING'
    })
    assert.deepEqual(h.actions, [])
  }
})
test('keyless arrange uses actual installed Session wire codecs and source-bound humanDecision admission', async () => {
  const actions = [],
    calls = [],
    ids = [],
    root = '/private/collector-unit-isolation'
  const gateway = {
    call: async (method, args) => {
      calls.push({ method, args })
      if (method === 'workspace/initializeDefault') {
        const descriptor = WORKSPACE_TYPERT.invocations.find(item => item.namespace === 'workspace' && item.method === 'initializeDefault')
        assert.ok(descriptor, 'must use a public installed Workspace method')
        assert.equal(descriptor.parameters.length, 0, 'default Workspace initialization has no wire parameters')
        assert.deepEqual(args, {}, 'no-argument Remote uses an empty args object')
        return { workspace: { workspaceId: 'default' } }
      }
      if (method.startsWith('session/')) {
        const descriptor = TYPERT.invocations.find(item => item.namespace === 'session' && item.method === method.split('/')[1])
        assert.ok(descriptor, 'must use a public installed Session method')
        for (const parameter of descriptor.parameters) parameter.codec.create().parse(args[parameter.wire])
      }
      if (method === 'session/create') {
        ids.push(args.request.sessionId)
        return { sessionId: args.request.sessionId }
      }
      if (method === 'session/prompt') return { accepted: true }
      if (method === 'session/list') return { items: ids.map(sessionId => ({ sessionId, running: false, blank: false })) }
      if (method === 'blueprint/loadDefinition') return { documentRevision: 'unit-document' }
      if (method === 'blueprint/startSessionRun') {
        assert.equal(args.args.sessionId, ids[0])
        assert.equal(args.args.expectedRevision, 'unit-document')
        assert.equal(typeof args.args.requestId, 'string')
        assert.equal(args.args.inputJson, '{}')
        assert.equal(args.args.source, undefined)
        return { runId: 'unit-run', replayed: false }
      }
      if (method === 'blueprint/inspectSession')
        return {
          status: 'bound',
          selected: { source: { kind: 'ui', sessionId: ids[0] }, run: { state: 'waiting_input' }, focusAttemptIds: ['unit-real-policy-focus'] }
        }
      assert.fail('unexpected method')
    }
  }
  const scene = await fixture.arrange({ page: nativePage(actions), gateway, root, mode: 'keyless' })
  assert.equal(calls[0]?.method, 'workspace/initializeDefault')
  assert.deepEqual(calls[0]?.args, {})
  assert.deepEqual(
    calls.slice(0, 3).map(item => item.method),
    ['workspace/initializeDefault', 'session/create', 'session/create']
  )
  assert.equal(scene.sessionId, ids[0])
  assert.equal(scene.plainSessionId, ids[1])
  assert.equal(scene.executionSessionId, undefined)
  assert.deepEqual(Object.keys(scene).sort(), ['blueprintId', 'definitionPath', 'plainSessionId', 'sessionId'])
  assert.ok(calls.filter(item => item.method === 'session/prompt').every(item => item.args.request.content[0].text === KEYLESS_SEED_TEXT))
  assert.equal(actions.length, 1)
  assert.ok(actions[0].includes(ids[0]))
})
test('live streaming and approval enqueue normal same-Session requests and return locators only', async () => {
  const actions = [],
    prompts = [],
    scene = { sessionId: 'conversation-fixture-source-unit', executionSessionId: 'bp-real-session-locator' }
  const gateway = {
    call: async (method, args) => {
      if (method === 'session/list') return { items: [{ sessionId: scene.sessionId, running: false, blank: false }] }
      assert.equal(method, 'session/prompt')
      prompts.push(args.request)
      const descriptor = TYPERT.invocations.find(item => item.namespace === 'session' && item.method === 'prompt')
      descriptor.parameters[0].codec.create().parse(args.request)
      return { accepted: true }
    }
  }
  for (const hook of [fixture.startStreaming, fixture.startApproval])
    assert.deepEqual(await hook({ page: nativePage(actions), gateway, scene }), { sessionId: scene.sessionId })
  assert.ok(prompts.every(item => item.sessionId === scene.sessionId && item.mode === 'queue'))
  assert.notEqual(prompts[0].requestId, prompts[1].requestId)
  assert.match(prompts[0].content[0].text, /200 numbered lines/)
  assert.ok(prompts[1].content[0].text.includes(JSON.stringify({ file_path: 'native-approval.txt', content: APPROVAL_FILE_CONTENT })))
  await assert.rejects(() => fixture.startStreaming({ page: nativePage([]), gateway, scene: { sessionId: scene.sessionId } }), {
    code: 'FIXTURE_LIVE_SCENE_REQUIRED'
  })
})
test('orphaned execution Session is a typed native-navigation gap, never a forged parent or source substitution', async () => {
  const actions = [],
    gateway = {
      call: async (method, args) => {
        assert.equal(method, 'session/list')
        assert.deepEqual(args, { _request: {} })
        return { items: [{ sessionId: 'bp-orphan', origin: 'subagent' }] }
      }
    }
  await assert.rejects(() => fixture.openSession({ page: nativePage(actions), gateway, sessionId: 'bp-orphan' }), {
    code: 'FIXTURE_EXECUTION_SESSION_NATIVE_NAVIGATION_UNAVAILABLE'
  })
  assert.equal(actions.length, 0)
})
function childNavigationHarness(label = 'worker [model].*', workspaceState = {}) {
  const actions = [],
    calls = [],
    parentId = 'fixture-parent',
    childId = 'fixture-child'
  const parent = { sessionId: parentId, blank: false },
    child = { sessionId: childId, origin: 'subagent', parentSessionId: parentId }
  const entry = { id: childId, mode: 'one-shot', ...(label === undefined ? {} : { label }) }
  const projections = {
    [parentId]: { asOfSeq: 8, values: { subagentCatalog: [entry] } },
    [childId]: { asOfSeq: 10, values: { subagent: { mode: 'one-shot', seq: 1, ...(label === undefined ? {} : { label }) } } }
  }
  let openedParent = false,
    menuOpen = false,
    selectedChild = false
  const gateway = {
    call: async (method, args) => {
      calls.push({ method, args })
      const descriptor = TYPERT.invocations.find(item => item.namespace === 'session' && item.method === method.split('/')[1])
      assert.ok(descriptor, 'navigation uses public read methods')
      for (const parameter of descriptor.parameters) parameter.codec.create().parse(args[parameter.wire])
      if (method === 'session/list') return { items: [parent, child] }
      assert.equal(method, 'session/projections')
      return projections[args.request.sessionId]
    }
  }
  const row = {
    waitFor: async () => {},
    count: async () => 1,
    click: async () => {
      assert.ok(openedParent && menuOpen)
      actions.push('native-child-row')
      menuOpen = false
      selectedChild = true
    }
  }
  const tree = {
    waitFor: async ({ state }) => assert.equal(menuOpen, state === 'visible'),
    count: async () => (menuOpen ? 1 : 0),
    getByRole: (role, options) => {
      assert.equal(role, 'treeitem')
      assert.ok(options.name.test((entry.label ?? entry.id) + ' one-shot completed'))
      assert.equal(options.name.test('another ' + (entry.label ?? entry.id) + ' one-shot completed'), false)
      return row
    }
  }
  const header = {
    locator: selector => {
      assert.equal(selector, 'button[aria-haspopup="tree"]')
      return {
        waitFor: async () => {},
        count: async () => 1,
        click: async () => {
          assert.ok(openedParent)
          actions.push('native-header-catalog')
          menuOpen = true
        },
        getAttribute: async () => (menuOpen ? 'true' : 'false')
      }
    },
    getByRole: (role, options) => {
      assert.equal(role, 'button')
      assert.ok(options.name.test('Switch subagent: ' + (entry.label ?? entry.id)))
      return { waitFor: async () => assert.ok(selectedChild), count: async () => (selectedChild ? 1 : 0) }
    }
  }
  const workspacePage = nativePage(actions, workspaceState)
  const page = {
    locator: selector => {
      if (selector === 'header[data-window-drag]') return header
      if (selector === '[data-row-key="workspace:"][role="treeitem"]') return workspacePage.locator(selector)
      assert.equal(selector, `[data-row-key="session:${parentId}"][role="treeitem"]`, 'child must never use a workspace tree row')
      const parentRow = workspacePage.locator(selector)
      return {
        ...parentRow,
        click: async () => {
          assert.equal(workspaceState.preview, false)
          assert.equal(workspaceState.expanded, true)
          actions.push('native-parent-row')
          openedParent = true
        },
        getAttribute: async () => (openedParent ? 'true' : 'false')
      }
    },
    getByRole: (role, options) => {
      if (role === 'dialog') return workspacePage.getByRole(role, options)
      assert.equal(role, 'tree')
      assert.ok(options.name.test('Subagent sessions'))
      return tree
    }
  }
  return { actions, calls, parent, child, entry, projections, page, gateway, row, parentId, childId }
}
test('native workspace navigation opens the same ungrouped parent before the child header catalog', async () => {
  const h = childNavigationHarness('worker [model].*', { expanded: false, preview: true })
  await fixture.openSession({ page: h.page, gateway: h.gateway, sessionId: h.childId })
  assert.deepEqual(h.actions, ['native-preview-continue', 'native-ungrouped-row', 'native-parent-row', 'native-header-catalog', 'native-child-row'])
  assert.deepEqual(
    h.calls.map(item => [item.method, item.args.request?.sessionId]),
    [
      ['session/list', undefined],
      ['session/projections', h.parentId],
      ['session/projections', h.childId]
    ]
  )
})
test('valid child without workspace row opens through native parent header catalog using actual label or id and matching descriptor', async () => {
  for (const label of ['worker [model].*', null]) {
    const h = childNavigationHarness(label ?? undefined)
    if (label === null) {
      delete h.entry.label
      delete h.projections[h.childId].values.subagent.label
    }
    await fixture.openSession({ page: h.page, gateway: h.gateway, sessionId: h.childId })
    assert.deepEqual(h.actions, ['native-parent-row', 'native-header-catalog', 'native-child-row'])
    assert.deepEqual(
      h.calls.map(item => [item.method, item.args.request?.sessionId]),
      [
        ['session/list', undefined],
        ['session/projections', h.parentId],
        ['session/projections', h.childId]
      ]
    )
  }
})
test('child parent/catalog/descriptor failures refuse before any UI navigation', async () => {
  for (const mutate of [
    h => (h.child.parentSessionId = 'missing-parent'),
    h => (h.parent.origin = 'subagent'),
    h => (h.projections[h.parentId].values.subagentCatalog = []),
    h => (h.entry.mode = 'continuable'),
    h => h.projections[h.parentId].values.subagentCatalog.push({ ...h.entry }),
    h => (h.entry.id = 'wrong-child'),
    h => (h.projections[h.childId] = null),
    h => (h.projections[h.childId].values.subagent = null),
    h => (h.projections[h.childId].values.subagent.mode = 'unknown')
  ]) {
    const h = childNavigationHarness()
    mutate(h)
    await assert.rejects(
      () => fixture.openSession({ page: h.page, gateway: h.gateway, sessionId: h.childId }),
      /FIXTURE_EXECUTION_SESSION_NATIVE_NAVIGATION_UNAVAILABLE/
    )
    assert.equal(h.actions.length, 0)
  }
})
test('ambiguous native catalog row fails rather than choosing an arbitrary child', async () => {
  const h = childNavigationHarness()
  h.row.count = async () => 2
  await assert.rejects(() => fixture.openSession({ page: h.page, gateway: h.gateway, sessionId: h.childId }), /FIXTURE_NATIVE_CHILD_CATALOG_ROW_MISSING/)
  assert.deepEqual(h.actions, ['native-parent-row', 'native-header-catalog'])
})
test('native child catalog may load asynchronously; fixture waits for its real row without inventing navigation', async () => {
  const h = childNavigationHarness()
  let loaded = false
  h.row.count = async () => (loaded ? 1 : 0)
  h.row.waitFor = async ({ state }) => {
    assert.equal(state, 'visible')
    loaded = true
  }
  await fixture.openSession({ page: h.page, gateway: h.gateway, sessionId: h.childId })
  assert.deepEqual(h.actions, ['native-parent-row', 'native-header-catalog', 'native-child-row'])
})
test('fixture readiness deadline fails typed and does not manufacture completion', async () => {
  let elapsed = 0
  await assert.rejects(
    () =>
      fixture.waitForFixture(
        async () => ({ state: 'running' }),
        value => value.state === 'succeeded',
        'FIXTURE_UNIT_NOT_READY',
        {
          now: () => elapsed,
          pause: async ms => {
            elapsed += ms
          }
        }
      ),
    { code: 'FIXTURE_UNIT_NOT_READY' }
  )
  assert.equal(elapsed, 30000)
  elapsed = 0
  await assert.rejects(
    () =>
      fixture.waitForFixture(
        async () => {
          elapsed = 30001
          return { state: 'succeeded' }
        },
        value => value.state === 'succeeded',
        'FIXTURE_UNIT_NOT_READY',
        { now: () => elapsed, pause: async () => {} }
      ),
    { code: 'FIXTURE_UNIT_NOT_READY' }
  )
})
test('approval settlement independently checks public call/result sequence and actual confined file bytes', () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'collector-write-unit-'))
  try {
    mkdirSync(join(root, 'cwd'))
    const file = join(root, 'cwd/native-approval.txt'),
      approval = { sessionId: 'unit', callId: 'write-unit', decidedSeq: 5, decidedLogged: true, outcome: 'allowed-once' }
    const facts = {
      sessions: [
        {
          sessionId: 'unit',
          toolCalls: [
            {
              name: 'write',
              callId: 'write-unit',
              callSeq: 3,
              resultSeq: 6,
              callLogged: true,
              resultLogged: true,
              ok: true,
              isError: false,
              pipelineResultObserved: true,
              pipelineIsError: false
            }
          ]
        }
      ]
    }
    assert.throws(() => approvalSettlementObservation(facts, 'unit', approval, root), /EVIDENCE_NATIVE_APPROVAL_FILE_MISSING/)
    writeFileSync(file, 'wrong effect')
    assert.throws(() => approvalSettlementObservation(facts, 'unit', approval, root), /EVIDENCE_NATIVE_APPROVAL_EFFECT_MISMATCH/)
    writeFileSync(file, APPROVAL_FILE_CONTENT)
    const observed = approvalSettlementObservation(facts, 'unit', approval, root)
    assert.equal(observed.effect.bytes, Buffer.byteLength(APPROVAL_FILE_CONTENT))
    assert.ok(!JSON.stringify(observed).includes(root))
    assert.ok(!JSON.stringify(observed).includes(APPROVAL_FILE_CONTENT))
    for (const change of [
      { resultSeq: 5 },
      { resultSeq: '6' },
      { isError: true },
      { isError: undefined },
      { pipelineIsError: true },
      { callId: 'wrong-call' }
    ]) {
      const wrong = structuredClone(facts)
      Object.assign(wrong.sessions[0].toolCalls[0], change)
      assert.throws(() => approvalSettlementObservation(wrong, 'unit', approval, root), /EVIDENCE_NATIVE_APPROVAL_TOOL_NOT_SETTLED/)
    }
    rmSync(file)
    symlinkSync(join(root, 'outside-missing'), file)
    assert.throws(() => approvalSettlementObservation(facts, 'unit', approval, root), /PATH_SYMLINK/)
    rmSync(join(root, 'cwd'), { recursive: true })
    symlinkSync(root, join(root, 'cwd'))
    writeFileSync(join(root, 'native-approval.txt'), APPROVAL_FILE_CONTENT)
    assert.throws(() => approvalSettlementObservation(facts, 'unit', approval, root), /PATH_SYMLINK/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
test('restart orchestrator invokes stop and new boot, isolates observer files, and rejects stop/auth failures', async () => {
  const profile = { profile: 'isolated-unit', env: {}, observerFile: '/private/unit/observer-facts.json' }
  const observer = { provenance: 'public DSH observer', sessions: [] },
    firstHost = { child: { pid: 11, exitCode: null, signalCode: null } }
  const receipt = { steps: [], rpc: [], package: { name: '@xuanling-rs/xuanling-dsh-blueprint' } },
    order = []
  const deps = {
    stop: async child => {
      order.push('stop')
      child.exitCode = 0
    },
    boot: (secondProfile, steps, id) => {
      order.push('boot')
      assert.equal(id, 'boot-2')
      assert.equal(secondProfile.profile, profile.profile)
      assert.notEqual(secondProfile.env.BP_CONVERSATION_OBSERVER_FILE, profile.observerFile)
      steps.push({ id })
      return { child: { pid: 12 }, ready: Promise.resolve('http://127.0.0.1:1234/') }
    },
    gatewayFactory: (_url, _rpc, _mode, instance) => {
      assert.equal(instance, 2)
      return {
        authenticate: async () => order.push('auth'),
        call: async () => ({ status: 'ok', service: receipt.package.name })
      }
    },
    readObserver: () => observer
  }
  const result = await ui.restartOwnedHost({ profile, firstHost, receipt, mode: 'keyless', onBoot: () => order.push('owned') }, deps)
  assert.deepEqual(order, ['stop', 'boot', 'owned', 'auth'])
  assert.ok(result.gateway)
  assert.equal(receipt.observer, observer)
  for (const failure of ['stop', 'auth']) {
    const failedReceipt = { steps: [], rpc: [], package: receipt.package },
      error = Object.assign(new Error('unit failure'), { code: 'HOST_UNIT_FAILURE' })
    const failedDeps = {
      ...deps,
      ...(failure === 'stop'
        ? {
            stop: async () => {
              throw error
            }
          }
        : {
            gatewayFactory: () => ({
              authenticate: async () => {
                throw error
              }
            })
          })
    }
    await assert.rejects(() => ui.restartOwnedHost({ profile, firstHost, receipt: failedReceipt, mode: 'keyless', onBoot: () => {} }, failedDeps), error)
    assert.equal(failedReceipt.restart.invoked, true)
    assert.equal(failedReceipt.restart.authenticated, false)
  }
})
test('reviewed real fixture declares all five operator exports', () => {
  for (const name of ['prepare', 'arrange', 'openSession', 'startStreaming', 'startApproval'])
    assert.equal(typeof fixture[name], 'function', `required operator export ${name}`)
})
test('fixture loader rejects omitted live actions before installing or booting', () => {
  assert.equal(typeof ui.validateFixtureExports, 'function', 'fixture loader must validate mode-specific exports')
  const fn = () => {},
    valid = { prepare: fn, arrange: fn, openSession: fn, startStreaming: fn, startApproval: fn }
  assert.equal(ui.validateFixtureExports(valid, 'live'), valid)
  assert.equal(ui.validateFixtureExports({ prepare: fn, arrange: fn, openSession: fn }, 'keyless').prepare, fn)
  for (const name of Object.keys(valid)) {
    const broken = { ...valid }
    delete broken[name]
    assert.throws(() => ui.validateFixtureExports(broken, 'live'), { code: 'FIXTURE_EXPORTS_MISSING' })
  }
})
test('prepare creates compilable real blueprints and an isolated policy module, with no acceptance facts', async () => {
  assert.equal(typeof fixture.prepare, 'function', 'real blueprint preparation is required')
  for (const mode of ['keyless', 'live']) {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'collector-fixture-unit-'))
    try {
      const config = await fixture.prepare({ root, mode })
      assert.deepEqual(Object.keys(config).sort(), ['operatorModules', 'runtimeRoot', 'workspaceRoot'])
      assert.equal(config.workspaceRoot, root)
      assert.equal(config.runtimeRoot, join(root, '.xuanling'))
      assert.equal(config.operatorModules.length, 1)
      const workflowRoot = join(config.workspaceRoot, '.xuanling', 'workflows')
      const dirs = readdirSync(workflowRoot).map(id => join(workflowRoot, id))
      assert.equal(dirs.length, 1)
      for (const dir of dirs) {
        assert.ok(confined(root, dir))
        const definition = decodeDefinition(readFileSync(join(dir, 'blueprint.json'), 'utf8'))
        validateDefinition(definition)
        assert.ok(
          mode === 'keyless'
            ? definition.graph.nodes.some(node => node.kind === 'humanDecision')
            : definition.graph.nodes.some(node => node.kind === 'agentTask')
        )
      }
      assert.ok(confined(root, config.operatorModules[0]))
      const operator = await import(pathToFileURL(config.operatorModules[0]).href)
      assert.equal(typeof operator.apply, 'function')
      assert.ok(!readFileSync(config.operatorModules[0], 'utf8').includes('AgentFactory'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
})
