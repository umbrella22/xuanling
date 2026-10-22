// Isolated real DSH/Edge/provider runner. Observers never supply model output,
// approval decisions, Session events, or Blueprint acceptance results.
import { randomUUID, createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as yaml from 'js-yaml'
import { chromium } from 'playwright'
import { prepareProfile, bootHost, stopHost } from './conversation-runtime.mjs'
import { probeBrowserEnv } from './probe.mjs'

export const digest = value => createHash('sha256').update(value).digest('hex')
export function check(value, code) {
  if (!value) throw Object.assign(new Error(code), { code })
}
export async function poll(read, accepts, code, timeout = 120000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await read()
    if (accepts(value)) return value
    await new Promise(done => setTimeout(done, 100))
  }
  check(false, code)
}

// This function is serialized into the owned profile as an observation-only
// Cordis plugin. Only controlled identities, enums and counts leave the Host.
function observe(ctx, publish) {
  const facts = { tools: [], errors: [], reviews: [], finishes: [], agents: [], teamAvailable: false }
  const safeId = value => (typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,200}$/.test(value) ? value : undefined)
  const flush = () => publish(facts)
  ctx.on('agent/created', ({ agent }) => {
    facts.teamAvailable = !!ctx.get('agentTeams')
    facts.agents.push({ sessionId: agent.id, preset: ctx.get('permissionPresets')?.current(agent.session) })
    flush()
  })
  ctx.on('tools/result', (exec, result) => {
    let value = {}
    try {
      value = JSON.parse(result.content.map(item => item.text ?? '').join(''))
    } catch {
      /* no body is retained */
    }
    facts.tools.push({
      name: safeId(exec.name),
      sessionId: exec.agent.id,
      callId: exec.callId,
      isError: result.isError,
      blueprintId: safeId(value.blueprintId),
      runId: safeId(value.runId),
      documentRevision: safeId(value.documentRevision),
      canStart: typeof value.canStart === 'boolean' ? value.canStart : undefined,
      errorCode: safeId(result.error?.info?.code),
      validationOk: typeof value.ok === 'boolean' ? value.ok : undefined,
      issues: Array.isArray(value.issues) ? value.issues.map(issue => ({ code: safeId(issue.code), pointer: safeId(issue.pointer) })) : undefined,
      candidateShape:
        exec.name === 'blueprint_validate'
          ? {
              definitionType: typeof exec.arguments.definition,
              fields: Object.keys(exec.arguments.definition ?? {}).filter(key => /^[A-Za-z]+$/.test(key)),
              nodes: exec.arguments.definition?.graph?.nodes?.map(node => ({
                fields: Object.keys(node).filter(key => /^[A-Za-z]+$/.test(key)),
                kind: safeId(node.kind)
              }))
            }
          : undefined
    })
    flush()
  })
  ctx.on('agent/error', ({ agent, error }) => {
    const text = String(error?.message ?? '').toLowerCase()
    facts.errors.push({
      sessionId: agent.id,
      code: safeId(error?.info?.code ?? error?.code),
      categories: ['timeout', 'rate limit', 'schema', 'network', 'fetch', 'response', 'unauthorized', '401', '403', '404', '429'].filter(word =>
        text.includes(word)
      )
    })
    flush()
  })
  ctx.on(
    'llm/stream',
    async function* (options, next) {
      const isReview = typeof options.system === 'string' && options.system.startsWith('REVIEW_POLICY\n')
      const review = isReview ? { startedAt: new Date().toISOString(), completed: false, failed: false } : undefined
      let reviewText = ''
      if (review) {
        facts.reviews.push(review)
        flush()
      }
      try {
        for await (const chunk of next()) {
          if (review && chunk.type === 'text-delta') reviewText += chunk.text
          if (chunk.type === 'finish') {
            const error = chunk.reason.error
            const text = String(error?.message ?? '').toLowerCase()
            facts.finishes.push({
              kind: chunk.reason.kind,
              code: safeId(error?.code),
              categories: [
                'timeout',
                'connection',
                'rate limit',
                'schema',
                'network',
                'fetch',
                'response',
                'unauthorized',
                '401',
                '403',
                '404',
                '429',
                'certificate',
                'unsupported'
              ].filter(word => text.includes(word))
            })
            flush()
          }
          if (review && chunk.type === 'finish') {
            review.completed = chunk.reason.kind === 'stop'
            review.finishKind = chunk.reason.kind
            try {
              const value = JSON.parse(reviewText)
              if (['low', 'medium', 'high'].includes(value.risk) && ['allow', 'deny'].includes(value.decision)) {
                review.risk = value.risk
                review.decision = value.decision
              }
            } catch {
              /* Do not retain raw reviewer text or errors. */
            }
            flush()
          }
          yield chunk
        }
      } catch (error) {
        if (review) review.failed = true
        throw error
      } finally {
        if (review) {
          review.endedAt = new Date().toISOString()
          flush()
        }
      }
    },
    { prepend: true }
  )
  flush()
}

const methods = new Set([
  'workspace/initializeDefault',
  'commands/execute',
  'session/create',
  'session/prompt',
  'session/list',
  'session/projections',
  'session/page',
  'blueprint/ping',
  'blueprint/loadDefinition',
  'blueprint/listDefinitions',
  'blueprint/inspectBlueprintReference',
  'blueprint/createDefinition',
  'blueprint/saveDefinition',
  'blueprint/preflightRun',
  'blueprint/startSessionRun',
  'blueprint/inspectSession',
  'blueprint/inspectRun',
  'blueprint/inspectRunView',
  'blueprint/inspectNodeSession',
  'blueprint/messageNode',
  'blueprint/cancelRun',
  'blueprint/queryRuns'
])

async function gatewayFor(authUrl, receipt, hostInstance) {
  const url = new URL(authUrl)
  check(url.protocol === 'http:' && url.hostname === '127.0.0.1', 'NON_LOCAL_HOST')
  const auth = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000) })
  const cookie = (auth.headers.getSetCookie?.() ?? []).map(item => item.split(';')[0]).join('; ')
  check(cookie && [302, 303].includes(auth.status), 'AUTH_FAILED')
  return {
    origin: url.origin,
    async call(method, args = {}) {
      check(methods.has(method), 'METHOD_NOT_ALLOWED')
      const rpcId = randomUUID()
      const response = await fetch(new URL(`/api/${method}`, url.origin), {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } })
      })
      const body = await response.json()
      const ok = response.status === 200 && body.type === 'server-response' && body.rpcId === rpcId && body.result?.ok === true
      const rawCode = body.result?.error?.code ?? body.result?.error?.info?.code
      const errorCode = typeof rawCode === 'string' && /^[A-Za-z0-9_./-]+$/.test(rawCode) ? rawCode : undefined
      const operation = body.result?.error?.details?.operation === 'runtime-open' ? 'runtime-open' : undefined
      receipt.rpc.push({ method, rpcId, hostInstance, at: new Date().toISOString(), status: response.status, ok, errorCode, operation })
      if (!ok) throw Object.assign(new Error('PUBLIC_RPC_FAILED'), { code: 'PUBLIC_RPC_FAILED', method, remoteCode: errorCode, remoteOperation: operation })
      return body.result.value
    }
  }
}

export async function createHarness({ keyConfig, providerName, reportDir, team, receipt }) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'bp-managed-live-'))
  const selected = yaml.load(readFileSync(keyConfig, 'utf8'))?.[providerName]
  check(typeof selected?.key === 'string' && selected.key.length > 0, 'PROVIDER_KEY_MISSING')
  const protocol = { responses: 'openai-responses', anthropic: 'anthropic-messages' }[selected.type]
  check(protocol && typeof selected.model === 'string', 'PROVIDER_CONFIG_INVALID')
  const keyFile = join(root, 'provider-key')
  writeFileSync(keyFile, selected.key, { mode: 0o600, flag: 'wx' })
  const factsFile = join(root, 'managed-facts.json')
  let profile,
    host,
    browser,
    page,
    gateway,
    hostInstance = 0
  const observers = []
  const leaseFile = join(root, '.xuanling', 'coordinator-lease.json')
  // src/persistence/lease.ts: default takeover requires a dead owner AND a
  // heartbeat older than 30 seconds. Observe that window without modifying it.
  const takeoverThresholdMs = 30_000
  const readLease = () => {
    const value = JSON.parse(readFileSync(leaseFile, 'utf8'))
    return { pid: value.pid, ownerId: value.ownerId, heartbeatAt: statSync(leaseFile).mtimeMs }
  }
  let crashedLease, recoveryObservation
  const facts = () => (existsSync(factsFile) ? JSON.parse(readFileSync(factsFile, 'utf8')) : { tools: [], errors: [], reviews: [], agents: [] })
  const observer = () => (existsSync(profile?.observerFile ?? '') ? JSON.parse(readFileSync(profile.observerFile, 'utf8')) : { sessions: [] })
  const h = {
    root,
    facts,
    observer,
    get gateway() {
      return gateway
    },
    get page() {
      return page
    },
    get profile() {
      return profile
    },
    async boot() {
      host = bootHost(profile, receipt.steps, `boot-${++hostInstance}`)
      const authUrl = await host.ready
      gateway = await gatewayFor(authUrl, receipt, hostInstance)
      if (!browser) browser = await chromium.launch({ channel: 'msedge', headless: true, env: probeBrowserEnv(root) })
      if (!page) {
        page = await browser.newPage({ viewport: { width: 1600, height: 1050 } })
        page.setDefaultTimeout(15000)
        page.on('pageerror', error => receipt.browserErrors.push({ name: error.name, messageSha256: digest(error.message) }))
        // Observe the native transport without intercepting, fulfilling or
        // altering it. Never retain message text, headers, tokens or raw errors.
        receipt.nativeMessages = []
        const sent = new Map()
        const observeSent = raw => {
          let value
          try {
            value = JSON.parse(raw)
          } catch {
            return
          }
          if (value.method !== 'blueprint/messageNode' || typeof value.rpcId !== 'string') return
          const args = value.payload?.args?.args
          const entry = {
            rpcId: value.rpcId,
            at: new Date().toISOString(),
            runId: args?.runId,
            attemptId: args?.attemptId,
            sessionId: args?.sessionId,
            requestId: args?.requestId,
            delivery: args?.delivery
          }
          sent.set(value.rpcId, entry)
          receipt.nativeMessages.push(entry)
        }
        const observeReceived = raw => {
          let value
          try {
            value = JSON.parse(raw)
          } catch {
            return
          }
          const entry = sent.get(value.rpcId)
          if (!entry || value.type !== 'server-response') return
          entry.ok = value.result?.ok
          const code = value.result?.error?.code
          if (typeof code === 'string' && /^[A-Za-z0-9_./-]+$/.test(code)) entry.errorCode = code
          entry.receivedAt = new Date().toISOString()
        }
        page.on('request', request => {
          if (request.method() === 'POST') observeSent(request.postData() ?? '')
        })
        page.on('response', async response => {
          if (!response.url().includes('/api/blueprint/messageNode')) return
          try {
            observeReceived(await response.text())
          } catch {
            /* transport failure is recorded by missing receipt */
          }
        })
        page.on('websocket', socket => {
          socket.on('framesent', frame => observeSent(frame.payload))
          socket.on('framereceived', frame => observeReceived(frame.payload))
        })
      }
      await page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
      await gateway.call('workspace/initializeDefault')
      await page.getByRole('button', { name: /^(XuanLing Blueprint|XuanLing 蓝图|玄灵蓝图)$/ }).waitFor()
      const preview = page.getByRole('dialog', { name: /^(Preview Notice|预览版说明)$/ })
      // The first notice loads after the sidebar. A momentarily absent dialog
      // is not acknowledgement; the Host persists the native Continue action.
      if (hostInstance === 1) await preview.waitFor({ state: 'visible' })
      if (await preview.isVisible()) {
        await preview.getByRole('button', { name: /^(Continue|继续)$/ }).click()
        await preview.waitFor({ state: 'hidden' })
      }
      // Configured providers should finish onboarding without credential input.
      const account = page.getByRole('dialog', { name: /^(Get started|开始使用)$/ })
      if (await account.isVisible()) {
        await account.getByRole('button', { name: /^(Close|关闭)$/ }).click()
        await account.waitFor({ state: 'hidden' })
      }
    },
    async crash() {
      observers.push({ hostInstance, observer: observer(), facts: facts() })
      await new Promise(done => {
        host.child.once('exit', done)
        host.child.kill('SIGKILL')
      })
      crashedLease = readLease()
      check(crashedLease.pid === host.child.pid, 'CRASHED_LEASE_OWNER_MISMATCH')
      let dead = false
      try {
        process.kill(crashedLease.pid, 0)
      } catch (error) {
        dead = error.code === 'ESRCH'
      }
      check(dead, 'CRASHED_OWNER_STILL_ALIVE')
      recoveryObservation = {
        hostInstance,
        crashedAt: new Date().toISOString(),
        signal: 'SIGKILL',
        ownerProcessExited: true,
        heartbeatAt: crashedLease.heartbeatAt,
        takeoverThresholdMs,
        blockedReads: 0
      }
      ;(receipt.processRecovery ??= []).push(recoveryObservation)
    },
    async waitForRuntime(runId) {
      check(crashedLease && recoveryObservation, 'CRASH_OBSERVATION_MISSING')
      await poll(
        async () => {
          const current = readLease()
          const requestedAt = Date.now()
          try {
            return await gateway.call('blueprint/inspectRun', { args: { runId } })
          } catch (error) {
            if (error.remoteCode !== 'blueprint/durability-failed' || error.remoteOperation !== 'runtime-open') throw error
            if (current.ownerId !== crashedLease.ownerId || requestedAt - current.heartbeatAt > takeoverThresholdMs) throw error
            recoveryObservation.blockedReads++
            return undefined
          }
        },
        value => value !== undefined,
        'RUNTIME_REOPEN_TIMEOUT'
      )
      const current = readLease()
      check(current.pid === host.child.pid && current.ownerId !== crashedLease.ownerId, 'RESTART_LEASE_NOT_REACQUIRED')
      recoveryObservation.reopenedAt = new Date().toISOString()
      recoveryObservation.reopenAfterHeartbeatMs = Date.now() - crashedLease.heartbeatAt
      recoveryObservation.newOwnerConfirmed = true
    },
    async snapshot(name) {
      const path = join(reportDir, `${String(receipt.images.length + 1).padStart(2, '0')}-${name}.png`)
      await page.screenshot({ path, mask: [page.locator('[data-composer-input]'), page.locator('[data-approval-scroll]')], fullPage: false })
      receipt.images.push({ name, path, sha256: digest(readFileSync(path)) })
    },
    async close() {
      receipt.hostObservations = [...observers, { hostInstance, observer: observer(), facts: facts() }]
      await browser?.close()
      await stopHost(host?.child)
      check(!JSON.stringify(receipt).includes(selected.key), 'SECRET_IN_RECEIPT')
      rmSync(root, { recursive: true, force: true })
    }
  }
  try {
    profile = await prepareProfile(
      {
        mode: 'live',
        installMode: 'linked',
        keyFile,
        providerBaseUrl: selected.base_url,
        providerModel: selected.model,
        providerProtocol: protocol,
        inheritProviderOutputLimit: true
      },
      {
        async prepare() {
          const module = join(root, 'managed-observer.mjs')
          writeFileSync(
            module,
            `import {writeFileSync,renameSync} from 'node:fs';\nexport const inject=['agents','llm','tools'];\nconst observe=${observe.toString()};\nexport function apply(ctx){observe(ctx,facts=>{const path=${JSON.stringify(factsFile)};writeFileSync(path+'.next',JSON.stringify(facts),{mode:0o600});renameSync(path+'.next',path)})}\n`,
            { mode: 0o600 }
          )
          return { workspaceRoot: root, runtimeRoot: join(root, '.xuanling'), operatorModules: [module] }
        }
      },
      root,
      receipt.steps
    )
    const manifestFile = join(profile.profileDir, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
    manifest.dsh.profile.bundles.push('@deepseek-ai/dsh-experimental-auto-review')
    if (team) manifest.dsh.profile.bundles.push('@deepseek-ai/dsh-experimental-agent-team-profile')
    writeFileSync(manifestFile, JSON.stringify(manifest), { mode: 0o600 })
    receipt.environment = {
      dsh: '0.2.1-rc.2',
      installMode: 'linked-build',
      platform: `${process.platform}/${process.arch}`,
      team,
      provider: providerName,
      model: selected.model,
      protocol,
      outputLimitSource: 'DSH provider default; no collector override',
      providerOrigin: new URL(selected.base_url).origin
    }
    await h.boot()
    return h
  } catch (error) {
    await h.close()
    throw error
  }
}

export async function createSession(h, preset = 'danger-full-access') {
  const sessionId = `managed-live-${randomUUID()}`
  const created = await h.gateway.call('session/create', { request: { sessionId, cwd: h.profile.cwd, agentPreset: 'standard' } })
  check(created.sessionId === sessionId, 'SESSION_ID_MISMATCH')
  const command = await h.gateway.call('commands/execute', { agentId: sessionId, line: `/permission ${preset}`, submittedAttachments: [] })
  check(command?.result?.kind === 'success', 'PRESET_CHANGE_FAILED')
  return sessionId
}
export async function prompt(h, sessionId, text) {
  const value = await h.gateway.call('session/prompt', { request: { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text }] } })
  check(value.accepted, 'PROMPT_REJECTED')
}
export async function idle(h, sessionId) {
  return poll(
    async () => {
      check(!h.facts().errors.some(item => item.sessionId === sessionId), 'AGENT_RUNTIME_ERROR')
      return h.gateway.call('session/list', { _request: {} })
    },
    list => list.items.some(item => item.sessionId === sessionId && !item.running && !item.blank),
    'SESSION_IDLE_TIMEOUT'
  )
}
