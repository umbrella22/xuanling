// Exercise private ACTUAL probe sinks with synthetic non-real canaries. The VM
// substitutes only stdout/stderr/file/exit effects; no DSH, network or profile.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const probeUrl = new URL('../../../../../test/blueprint/capabilities/probe.mjs', import.meta.url)
const helperUrl = new URL('./probe-evidence.mjs', probeUrl)
const queryCanary = 'CANARY_GATEWAY_QUERY_NOT_REAL'
const headerCanary = 'CANARY_AUTH_HEADER_NOT_REAL'
const authUrl = `http://127.0.0.1:12345/?token=${queryCanary}&route=blueprint#canvas`
const maskedUrl = 'http://127.0.0.1:12345/?token=<redacted>&route=blueprint#canvas'

function between(source, start, end) {
  const from = source.indexOf(start)
  assert.notEqual(from, -1, `fixture extraction start: ${start}`)
  const to = source.indexOf(end, from + start.length)
  assert.notEqual(to, -1, `fixture extraction end: ${end}`)
  return source.slice(from, to)
}

async function actualSinks() {
  const source = readFileSync(probeUrl, 'utf8')
  const stdout = [],
    stderr = [],
    writes = [],
    exits = []
  const report = { probe: 'sink-fixture', plan_id: 'fixture-plan', environment: {}, steps: [], assertions: [], artifacts: {}, passed: false }
  const context = {
    report,
    REPORT_DIR: '/synthetic/reports',
    ARTIFACT_PATHS: { report: '/synthetic/reports/probe.json' },
    mkdirSync() {},
    writeFileSync(path, body) {
      writes.push({ path, body })
    },
    process: { stdout: { write: text => stdout.push(text) }, stderr: { write: text => stderr.push(text) }, exit: code => exits.push(code) }
  }
  // Baseline has no helper import, so the same tests run the unmodified old
  // sinks before any helper exists. Current sink imports are supplied verbatim.
  if (source.includes("from './probe-evidence.mjs'")) Object.assign(context, await import(helperUrl))
  const logAssertStep = between(source, 'function log(message) {', '\nfunction run(')
  const finalize = between(source, 'function finalize(exitCode) {', '\nconst isDirectRun')
  const fatalBody = between(source, '  main().catch((error) => {\n', '\n  })').split('\n').slice(1).join('\n')
  const routeLine = source.split('\n').find(line => line.startsWith('catch (error) { process.stderr.write('))
  assert.ok(routeLine, 'fixture extraction: actual routing error sink')
  const routeBody = routeLine.slice('catch (error) { '.length, -2)
  const httpBody = between(source, '  } catch (error) {\n    httpOk = false', '\n  }\n  s5.done').split('\n').slice(1).join('\n')
  const browserBody = between(source, '  } catch (error) {\n    report.artifacts.browser_error', '\n  }\n\n  boot.kill').split('\n').slice(1).join('\n')
  const bootLines = [
    '  report.artifacts.boot_log_tail = ',
    "  assert('P4a', 'web profile boots and prints its authenticated URL', true, baseUrl)",
    '  report.environment.base_url = '
  ].map(prefix => source.split('\n').find(line => line.startsWith(prefix)))
  assert.ok(
    bootLines.every(line => line !== undefined),
    'fixture extraction: actual boot evidence assignments and assertion'
  )
  const addLine = source.split('\n').find(line => line.trimStart().startsWith('report.artifacts.add_output = '))
  const initLine = source.split('\n').find(line => line.trimStart().startsWith('report.artifacts.init_output = '))
  const securityLine = source.split('\n').find(line => line.trimStart().startsWith('report.artifacts.host_tools_contract = '))
  const previewLine = source.split('\n').find(line => line.trimStart().startsWith("httpOk &= assert('P4d',"))
  assert.ok(addLine && initLine && securityLine && previewLine, 'fixture extraction: actual diagnostic truncation sinks')
  const functions = `${logAssertStep}\n${finalize}\n
    function emitFatal(error) { ${fatalBody}\n }
    function emitRouteError(error) { ${routeBody}\n }
    function emitHttpError(error) { let httpOk = true; ${httpBody}\n return httpOk }
    function emitBrowserError(error, browserTried = true) { const s6 = step('S6', 'browser fixture'); ${browserBody}\n }
    function recordBoot(bootLog, baseUrl) { ${bootLines.join('\n')}\n }
    function recordAdd(add) { ${addLine}\n }
    function recordInit(init) { ${initLine}\n }
    function recordSecurity(security) { const securityReportPath = '/synthetic/security.json'; const securityReport = null; ${securityLine}\n }
    function recordPreview(echoBody) { let httpOk = true; const echoOk = false; ${previewLine}\n }
    ({ log, assert, step, finalize, emitFatal, emitRouteError, emitHttpError, emitBrowserError, recordBoot, recordAdd, recordInit, recordSecurity, recordPreview })`
  const sinks = vm.runInNewContext(functions, context, { filename: 'actual-probe-private-sinks.mjs' })
  return { ...sinks, report, stdout, stderr, writes, exits, json: () => JSON.parse(writes.at(-1).body) }
}

test('TARGET: actual log emits a credential-free gateway locator with route and fragment intact', async () => {
  const f = await actualSinks()
  f.log(`web ready: ${authUrl}; status=200`)
  assert.equal(
    f.stdout.join(''),
    `[probe] web ready: ${maskedUrl}; status=200\n`,
    'TARGET: actual stdout must redact the auth query without rewriting route/fragment'
  )
})

test('TARGET: actual P4a assert and finalize redact evidence, not the raw local authentication input', async () => {
  const f = await actualSinks()
  f.recordBoot(`web started ${authUrl}\nserving=ready`, authUrl)
  assert.equal(f.report.assertions[0].passed, true)
  f.finalize(0)
  const output = f.json()
  assert.equal(output.assertions[0].detail, maskedUrl, 'TARGET: actual P4a serialized detail must be credential-free')
  assert.equal(output.environment.base_url, maskedUrl)
  assert.equal(output.artifacts.boot_log_tail, `web started ${maskedUrl}\nserving=ready`)
  assert.equal(output.assertions[0].id, 'P4a')
  assert.equal(output.passed, true)
  assert.equal(output.assertions.length, 1)
  assert.deepEqual(f.exits, [0])
  assert.equal(f.report.assertions[0].detail, authUrl, 'raw in-memory auth locator is not rewritten')
  assert.equal(f.stdout.join('').includes(queryCanary), false)
})

test('TARGET: actual nested JSON emission masks exact query names and encoded values without URL reconstruction', async () => {
  const f = await actualSinks()
  const locator = 'https://gateway.invalid/a%2Fb?route=a%2Bb&authToken=CANARY%2F%2B%3D%26%23ENCODED&token=SECOND_CANARY#frag?token=logical-fragment'
  const masked = 'https://gateway.invalid/a%2Fb?route=a%2Bb&authToken=<redacted>&token=<redacted>#frag?token=logical-fragment'
  f.report.artifacts.nested = [{ result: { error: `request failed at "${locator}"; status=403`, count: 7, ok: false, id: 'run-α', route: '/a%2Fb' } }]
  f.finalize(1)
  assert.equal(
    f.json().artifacts.nested[0].result.error,
    `request failed at "${masked}"; status=403`,
    'TARGET: actual nested report must redact both credential query values'
  )
  assert.equal(f.json().artifacts.nested[0].result.count, 7)
  assert.equal(f.json().artifacts.nested[0].result.id, 'run-α')
  assert.equal(f.json().artifacts.nested[0].result.ok, false)
  assert.equal(f.json().artifacts.nested[0].result.route, '/a%2Fb')
})

test('TARGET: actual stdout masks diagnostic authorization credentials and preserves adjacent metadata', async () => {
  const f = await actualSinks()
  const diagnostic = `request headers:\nAuthorization: Bearer ${headerCanary}\nauthorization: Basic Q0FOQVJZX05PVF9SRUFM\nAuthorization: Bearer ${headerCanary} traceId=trace-17\n{"Authorization":"Bearer ${headerCanary}"}, status=403`
  const expected =
    'request headers:\nAuthorization: Bearer <redacted>\nauthorization: Basic <redacted>\nAuthorization: Bearer <redacted> traceId=trace-17\n{"Authorization":"Bearer <redacted>"}, status=403'
  f.log(diagnostic)
  assert.equal(f.stdout.join(''), `[probe] ${expected}\n`, 'TARGET: actual diagnostic stdout must not emit authorization credentials')
})

test('TARGET: actual serialized diagnostic header objects redact credentials, leaving noncredential/domain fields unchanged', async () => {
  const f = await actualSinks()
  f.report.artifacts.error = {
    request: { headers: { Authorization: `Bearer ${headerCanary}`, authorization: 'Basic Q0FOQVJZX05PVF9SRUFM', 'X-Trace': 'trace-17' } },
    token: 'domain-token',
    authToken: 'domain-auth-ref',
    authorization: 'Team: Editor'
  }
  f.finalize(1)
  assert.deepEqual(
    f.json().artifacts.error,
    {
      request: { headers: { Authorization: 'Bearer <redacted>', authorization: 'Basic <redacted>', 'X-Trace': 'trace-17' } },
      token: 'domain-token',
      authToken: 'domain-auth-ref',
      authorization: 'Team: Editor'
    },
    'TARGET: header credential masking must not become generic domain-key sanitization'
  )
  assert.equal(f.report.artifacts.error.request.headers.Authorization, `Bearer ${headerCanary}`, 'canonical in-memory value remains unchanged')
})

test('TARGET: actual fatal handler emits redacted error stack and preserves failed classification/exit', async () => {
  const f = await actualSinks()
  f.report.artifacts.failure = { error: `at ${authUrl}`, state: 'failed' }
  const error = new Error('synthetic failure')
  error.stack = `Error: ${authUrl}\nAuthorization: Bearer ${headerCanary}\n    at route.js:17:3`
  f.emitFatal(error)
  assert.equal(f.stdout.join('').includes(queryCanary), false, 'TARGET: actual fatal stdout must not emit an authentication query value')
  assert.equal(f.stdout.join('').includes(headerCanary), false)
  assert.equal(f.json().artifacts.failure.error, `at ${maskedUrl}`)
  assert.equal(f.json().passed, false)
  assert.deepEqual(f.exits, [1])
  assert.ok(f.stdout.join('').includes('at route.js:17:3'))
})

test('TARGET: actual HTTP/browser error sinks redact before diagnostic truncation, preserving assertions/status', async () => {
  const f = await actualSinks()
  const error = new Error(`GET https://gateway.invalid/?token=${'CANARY_LONG_NOT_REAL'.repeat(50)}#failure status=503`)
  assert.equal(f.emitHttpError(error), false)
  f.emitBrowserError(error)
  f.finalize(1)
  assert.equal(f.stdout.join('').includes('CANARY_LONG_NOT_REAL'), false, 'TARGET: error detail truncation must not leave raw credential prefixes')
  const output = f.json()
  assert.deepEqual(
    output.assertions.map(value => [value.id, value.passed]),
    [
      ['P4b', false],
      ['P6z', false]
    ]
  )
  assert.equal(output.steps[0].status, 'failed')
  assert.equal(output.artifacts.http_error, 'Error: GET https://gateway.invalid/?token=<redacted>#failure status=503')
  assert.equal(output.artifacts.browser_error, output.artifacts.http_error)
  assert.equal(output.assertions[1].detail, output.artifacts.browser_error)
})

test('TARGET: actual boot-tail sink redacts a long credential before its existing 6000-character tail bound', async () => {
  const f = await actualSinks()
  const longUrl = `http://127.0.0.1:12345/?token=${'CANARY_LONG_BOOT_NOT_REAL'.repeat(400)}#canvas`
  const boot = `startup\nserving ${longUrl}\nstate=ready\n`
  f.recordBoot(boot, longUrl)
  f.finalize(0)
  assert.equal(
    f.json().artifacts.boot_log_tail,
    'startup\nserving http://127.0.0.1:12345/?token=<redacted>#canvas\nstate=ready\n',
    'TARGET: truncation must not drop locator context and leak a raw credential tail'
  )
  assert.equal(f.stdout.join('').includes('CANARY_LONG_BOOT_NOT_REAL'), false)
})

test('TARGET: actual routing catch redacts stderr before exit without changing failure code', async () => {
  const f = await actualSinks()
  f.emitRouteError(new Error(`invalid option at ${authUrl}\nAuthorization: Bearer ${headerCanary}`))
  assert.equal(
    f.stderr.join(''),
    `probe: invalid option at ${maskedUrl}\nAuthorization: Bearer <redacted>\n`,
    'TARGET: actual catch stderr is an evidence credential boundary'
  )
  assert.deepEqual(f.exits, [2])
  assert.deepEqual(f.writes, [])
})

test('CONTROL: awkward valid noncredential text, domain values, exact identities and empty query values are preserved', async () => {
  const f = await actualSinks()
  const ordinary =
    'Unicode α/蓝图; token=logical-ref; authToken=skill-ref; https://host.invalid/r%2Fpath?notoken=one&authTokenSuffix=two&Token=three&tokenId=four&token=&route=a%2Bb#canvas; https://host.invalid/?route=callback?token=ordinary-route#fragment?authToken=ordinary-fragment; X-Authorization: Bearer logical-description'
  f.log(ordinary)
  f.assert('P-α', ordinary, true, ordinary)
  f.report.artifacts.domain = {
    token: 'token-domain-id',
    authToken: 'logical-skill-ref',
    authorization: 'policy label',
    Authorization: 'Bearer domain-policy-label',
    id: 'run-17',
    count: 42,
    route: '/token/authToken',
    inputJson: '{"token":"ordinary","authToken":"ref"}',
    missing: null,
    zero: 0,
    enabled: false,
    text: ordinary
  }
  const original = JSON.stringify(f.report.artifacts.domain)
  f.finalize(0)
  const output = f.json()
  assert.equal(output.assertions[0].id, 'P-α')
  assert.equal(output.assertions[0].description, ordinary)
  assert.equal(output.assertions[0].detail, ordinary)
  assert.equal(JSON.stringify(output.artifacts.domain), original)
  assert.equal(JSON.stringify(f.report.artifacts.domain), original)
  assert.equal(output.assertions[0].passed, true)
  assert.ok(f.stdout[0] === `[probe] ${ordinary}\n`)
  assert.deepEqual(f.exits, [0])
})

test('CONTROL: noncredential boot/error text retains original tail bound and failed oracle', async () => {
  const f = await actualSinks()
  const ordinary = 'trace-line\n'.repeat(800)
  f.recordBoot(ordinary, 'https://host.invalid/?route=blueprint#canvas')
  f.emitBrowserError(new Error('ordinary failure: panel unavailable'), false)
  f.finalize(1)
  assert.equal(f.json().artifacts.boot_log_tail, ordinary.slice(-6000))
  assert.equal(f.json().steps[0].status, 'not_run')
  assert.equal(f.json().assertions.at(-1).passed, false)
  assert.equal(f.json().assertions.at(-1).id, 'P6z')
  assert.equal(f.json().passed, false)
  assert.deepEqual(f.exits, [1])
})

for (const stream of ['stdout', 'stderr']) {
  test(`TARGET: actual add_output ${stream} masks long credentials before its existing 4000-character tail`, async () => {
    const f = await actualSinks()
    const long = 'CANARY_ADD_TAIL_NOT_REAL'.repeat(250)
    const diagnostic =
      stream === 'stdout'
        ? `install log\nhttps://gateway.invalid/?authToken=${long}#add\nstate=ready\n`
        : `install log\nAuthorization: Bearer ${long} traceId=add-17\nstate=failed\n`
    const masked =
      stream === 'stdout'
        ? 'install log\nhttps://gateway.invalid/?authToken=<redacted>#add\nstate=ready\n'
        : 'install log\nAuthorization: Bearer <redacted> traceId=add-17\nstate=failed\n'
    const add = { status: 17, stdout: '', stderr: '', [stream]: diagnostic }
    f.recordAdd(add)
    f.finalize(1)
    assert.equal(f.json().artifacts.add_output[stream], masked, 'TARGET: add tail truncation must not discard credential context before masking')
    assert.equal(f.json().artifacts.add_output.status, 17)
    assert.equal(add[stream], diagnostic, 'raw subprocess input remains unchanged')
    assert.deepEqual(f.exits, [1])
  })
}

test('TARGET: actual init_output masks a quoted diagnostic header before its existing 4000-character head', async () => {
  const f = await actualSinks()
  const diagnostic = `headers={"Authorization":"Bearer ${'CANARY_INIT_HEAD_NOT_REAL'.repeat(250)}"}; state=failed`
  const init = { stdout: diagnostic, stderr: diagnostic }
  f.recordInit(init)
  f.finalize(1)
  assert.deepEqual(
    f.json().artifacts.init_output,
    { stdout: 'headers={"Authorization":"Bearer <redacted>"}; state=failed', stderr: 'headers={"Authorization":"Bearer <redacted>"}; state=failed' },
    'TARGET: a head-truncated quoted header must not leak an unfinished credential'
  )
  assert.equal(init.stdout, diagnostic)
  assert.equal(init.stderr, diagnostic)
})

test('TARGET: actual compact assertion preview masks diagnostic headers before its existing 300-character head', async () => {
  const f = await actualSinks()
  const body = { headers: { Authorization: `Bearer ${'CANARY_PREVIEW_HEAD_NOT_REAL'.repeat(30)}` }, status: 403, id: 'preview-17' }
  f.recordPreview(body)
  f.finalize(1)
  const expected = JSON.stringify({ headers: { Authorization: 'Bearer <redacted>' }, status: 403, id: 'preview-17' })
  assert.equal(f.json().assertions[0].detail, expected, 'TARGET: JSON evidence must mask credential values before preview truncation')
  assert.equal(f.json().assertions[0].id, 'P4d')
  assert.equal(f.json().assertions[0].passed, false)
  assert.equal(f.stdout.join('').includes('CANARY_PREVIEW_HEAD_NOT_REAL'), false)
})

test('CONTROL: actual add/init/security and compact preview retain ordinary text budgets and status', async () => {
  const f = await actualSinks()
  const stdout = 'α/蓝图 token=logical-ref; record=17\n'.repeat(250)
  const stderr = 'ordinary warning; authToken=skill-ref; id=17\n'.repeat(250)
  f.recordAdd({ status: 17, stdout, stderr })
  f.recordInit({ stdout, stderr })
  f.recordSecurity({ status: 23, stderr })
  const body = {
    id: 'preview-α',
    token: 'domain-token',
    authToken: 'domain-ref',
    authorization: 'Bearer policy label',
    Authorization: 'Bearer domain-policy-label',
    text: stdout
  }
  f.recordPreview(body)
  f.finalize(1)
  const output = f.json()
  assert.deepEqual(output.artifacts.add_output, { status: 17, stdout: stdout.slice(-4000), stderr: stderr.slice(-4000) })
  assert.deepEqual(output.artifacts.init_output, { stdout: stdout.slice(0, 4000), stderr: stderr.slice(0, 4000) })
  assert.deepEqual(output.artifacts.host_tools_contract, { status: 23, reportPath: '/synthetic/security.json', report: null, stderr: stderr.slice(-2000) })
  assert.equal(output.assertions[0].detail, JSON.stringify(body).slice(0, 300))
  assert.equal(output.assertions[0].passed, false)
  assert.equal(output.passed, false)
  assert.deepEqual(f.exits, [1])
})
