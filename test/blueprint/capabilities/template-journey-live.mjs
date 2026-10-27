#!/usr/bin/env node
/**
 * W7.3 / J04 live journey: extract a template from one isolated project,
 * instantiate it into two structurally different projects, and execute one
 * instance with the real provider.
 *
 * Usage:
 *   node test/blueprint/capabilities/template-journey-live.mjs \
 *     --key-config <authorized YAML> --provider DeepSeek|GLM \
 *     --report-dir <fresh directory> [--phase provider|web|all]
 *
 * The harness never reads the user's profile, never installs into it, and
 * writes only inside a fresh HOME. The provider key enters the child process
 * through BP_LIVE_PROVIDER_KEY and is never printed or persisted.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { spawn } from 'node:child_process'
import {
  configuration,
  isolatedJourneyEnvironment,
  profilePatch
} from '../../../integrations/deepseek-harness/xuanling-blueprint/test/live/journey.mjs'
import { LiveJourneyError } from '../../../integrations/deepseek-harness/xuanling-blueprint/test/live/live-diagnostic-evidence.mjs'

const PACKAGE = '@xuanling-rs/xuanling-dsh-blueprint'
const { values } = parseArgs({
  options: {
    'key-config': { type: 'string' },
    provider: { type: 'string', default: 'DeepSeek' },
    'report-dir': { type: 'string' },
    phase: { type: 'string', default: 'all' },
    'user-profile': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false }
  }
})
if (values.help) {
  console.log(
    'template-journey-live.mjs --key-config <authorized YAML> --provider DeepSeek|GLM --report-dir <fresh directory> [--phase provider|web|all] [--user-profile]\n' +
      'Default: isolated HOME/profile with an authorized provider. --user-profile boots the real web profile (symlinked local build) and registers temporary project workspaces, which are removed afterwards. No original blueprint or repository is modified.'
  )
  process.exit(0)
}
const fail = code => {
  throw new LiveJourneyError(code)
}
if (!values['key-config'] || !values['report-dir'] || !['provider', 'web', 'all'].includes(values.phase)) fail('ARGUMENTS_INVALID')

const repoRoot = resolve(import.meta.dirname, '..', '..', '..')
const packageRoot = join(repoRoot, 'integrations', 'deepseek-harness', 'xuanling-blueprint')
const cli = join(repoRoot, 'test', 'blueprint', 'node_modules', '.bin', 'dsh')
const reportDir = resolve(values['report-dir'])
mkdirSync(reportDir, { recursive: false, mode: 0o700 })
const receipt = {
  planId: 'dsh-blueprint-conversation-library-template-v1',
  journey: 'J04-template-two-project-live',
  mode: values['user-profile'] ? 'user-profile' : 'isolated',
  startedAt: new Date().toISOString(),
  provider: values.provider,
  phase: values.phase,
  cases: [],
  ok: false
}
let child
let gateway
const temporaryWorkspaces = []
let stage = 'configuration'
try {
  if (!existsSync(cli) || !existsSync(join(packageRoot, 'lib', 'index.js'))) fail('LIVE_HOST_OR_ARTIFACT_MISSING')
  const config = configuration(
    {
      BP_LIVE_PROVIDER_KEY: providerKey(values['key-config'], values.provider),
      BP_LIVE_PROVIDER_BASE_URL: providerField(values['key-config'], values.provider, 'base_url'),
      BP_LIVE_PROVIDER_MODEL: providerField(values['key-config'], values.provider, 'model'),
      BP_LIVE_PROVIDER_PROTOCOL: protocolFor(providerField(values['key-config'], values.provider, 'type'))
    },
    class extends Error {
      code = 'LIVE_CONFIGURATION_MISSING'
    }
  )
  stage = 'workspaces'
  const temp = join(reportDir, 'journey')
  const source = join(temp, 'source-docs')
  const nodeProject = join(temp, 'node-docs')
  const rustProject = join(temp, 'rust-docs')
  for (const path of [join(source, '.xuanling', 'workflows', 'live-template'), nodeProject, rustProject]) mkdirSync(path, { recursive: true })
  writeFileSync(join(nodeProject, 'package.json'), JSON.stringify({ name: 'node-docs', scripts: { test: 'node --test' } }))
  writeFileSync(join(nodeProject, 'README.md'), '# Node docs\n')
  writeFileSync(join(rustProject, 'Cargo.toml'), '[package]\nname = "rs_lvgl"\nversion = "0.1.0"\n')
  writeFileSync(join(rustProject, 'README.md'), '# rs_lvgl docs\n')
  // The template source has no package files: its Agent is a Host preset, so
  // the extracted template is instantly portable to both projects.
  writeFileSync(
    join(source, '.xuanling', 'workflows', 'live-template', 'blueprint.json'),
    JSON.stringify({
      schemaVersion: 2,
      id: 'live-template',
      name: 'Live template journey',
      resources: { standard: { kind: 'agent', source: { kind: 'host', id: 'standard' } } },
      graph: {
        nodes: [
          { id: 'input', kind: 'input', outputs: { value: 'string' } },
          { id: 'work', kind: 'agentTask', agentRef: 'standard', inputs: { value: 'string' }, outputs: { text: 'string' } },
          { id: 'output', kind: 'output', inputs: { text: 'string' } }
        ],
        edges: [
          { kind: 'data', from: 'input.value', to: 'work.value' },
          { kind: 'data', from: 'work.text', to: 'output.text' }
        ]
      }
    })
  )
  let bootArgs
  let env
  if (values['user-profile']) {
    // Real web profile: no HOME/DSH_HOME redirection. The local build must be
    // symlinked into the profile by the caller; this runner never edits it.
    const overlay = join(temp, 'overlay.yml')
    writeFileSync(
      overlay,
      '- id: agent-default-model\n  config:\n    provider: zai-coding-cn\n    model: glm-5.3-flash\n    reasoningEffort: max\n',
      { mode: 0o600 }
    )
    bootArgs = ['--profile', 'web', '--patch', overlay, '--host', '127.0.0.1', '--port', '0', '--no-open']
    env = { ...process.env }
  } else {
    const home = join(temp, 'home')
    const profile = `bp-template-${randomUUID()}`
    const profileDir = join(home, 'dsh', 'profiles', profile)
    const documents = join(temp, 'documents')
    for (const path of [profileDir, join(home, 'tmp'), documents]) mkdirSync(path, { recursive: true })
    mkdirSync(join(profileDir, 'node_modules', '@xuanling-rs'), { recursive: true })
    const { symlinkSync } = await import('node:fs')
    symlinkSync(packageRoot, join(profileDir, 'node_modules', '@xuanling-rs', 'xuanling-dsh-blueprint'), 'dir')
    writeFileSync(
      join(profileDir, 'package.json'),
      JSON.stringify({ name: profile, private: true, type: 'module', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', PACKAGE] } } })
    )
    const observer = join(temp, 'observer.mjs')
    writeFileSync(observer, 'export default function observer() {}\n')
    const nm = join(repoRoot, 'test', 'blueprint', 'node_modules', '@deepseek-ai')
    const toolIds = []
    for (const bundle of ['dsh-base', 'dsh-web-app']) {
      const yaml = readFileSync(join(nm, bundle, 'cordis.patch.yml'), 'utf8')
      for (const match of yaml.matchAll(/id: (tool-[\w-]+)/g)) toolIds.push(match[1])
    }
    symlinkSync(join(repoRoot, 'test', 'blueprint', 'node_modules'), join(temp, 'node_modules'), 'dir')
    // No workspaceRoot: the plugin resolves every target from the Host registry,
    // which is exactly the multi-workspace path under test.
    writeFileSync(
      join(profileDir, 'cordis.patch.yml'),
      `${profilePatch({ workspaceRoot: undefined, runtimeRoot: undefined, observerModule: observer, toolIds, liveConfig: config })}
- id: workspace-controller
  config:
    documentsDirectory: ${JSON.stringify(documents)}
`,
      { mode: 0o600 }
    )
    bootArgs = ['--profile', profile, '--host', '127.0.0.1', '--port', '0', '--no-open']
    env = isolatedJourneyEnvironment(home, config)
  }
  stage = 'boot'
  child = spawn(cli, bootArgs, { cwd: temp, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const authUrl = await readyUrl(child)
  gateway = gatewayFor(authUrl)
  await gateway.authenticate()
  stage = 'plugin'
  const ping = await gateway.call('blueprint/ping', {}, null)
  if (ping?.status !== 'ok') fail('LIVE_PLUGIN_NOT_MOUNTED')

  stage = 'workspaces-registered'
  const sourceView = await gateway.call('workspace/create', { path: source }, 'request')
  const nodeView = await gateway.call('workspace/create', { path: nodeProject }, 'request')
  const rustView = await gateway.call('workspace/create', { path: rustProject }, 'request')
  const sourceId = sourceView.workspace.workspaceId
  const nodeId = nodeView.workspace.workspaceId
  const rustId = rustView.workspace.workspaceId
  temporaryWorkspaces.push(nodeId, rustId, sourceId)
  receipt.cases.push({ id: 'workspaces', passed: true, sourceId, nodeId, rustId })

  stage = 'extract'
  const extracted = await gateway.call('blueprint/extractTemplate', {
    blueprintId: 'live-template',
    requestId: randomUUID(),
    library: { kind: 'workspace', workspaceId: sourceId }
  })
  if (!extracted.portable) fail('TEMPLATE_NOT_PORTABLE')
  await gateway.call('blueprint/saveTemplate', { template: extracted.template, requestId: randomUUID() })
  receipt.cases.push({ id: 'extract', passed: true, templateId: extracted.template.templateId, residual: extracted.residual })

  stage = 'instantiate'
  const nodeInstance = await gateway.call('blueprint/instantiateTemplate', {
    templateId: extracted.template.templateId,
    workspaceId: nodeId,
    requestId: `instantiate-node-${randomUUID()}`,
    parameters: { name: 'Node documentation' }
  })
  const rustInstance = await gateway.call('blueprint/instantiateTemplate', {
    templateId: extracted.template.templateId,
    workspaceId: rustId,
    requestId: `instantiate-rust-${randomUUID()}`,
    parameters: { name: 'Rust documentation' }
  })
  if (nodeInstance.status !== 'ready' || rustInstance.status !== 'ready') fail('TEMPLATE_INSTANTIATION_BLOCKED')
  const nodeDefinition = JSON.parse(readFileSync(join(nodeProject, '.xuanling', 'workflows', nodeInstance.instance.asset.blueprintId, 'blueprint.json'), 'utf8'))
  if (JSON.stringify(nodeDefinition).includes('{{')) fail('TEMPLATE_PLACEHOLDER_LEAKED')
  receipt.cases.push({
    id: 'instantiate',
    passed: true,
    nodeId: nodeInstance.instance.asset.blueprintId,
    rustId: rustInstance.instance.asset.blueprintId,
    nodeDefinition: nodeDefinition.name
  })

  stage = 'run'
  const nonce = `bp-template-${randomUUID()}`
  const started = await gateway.call('blueprint/startRun', {
    blueprintId: nodeInstance.instance.asset.blueprintId,
    expectedRevision: nodeInstance.instance.documentRevision,
    inputJson: JSON.stringify({ value: `Reply with exactly NONCE:${nonce} and nothing else. Do not use tools.` }),
    requestId: randomUUID(),
    library: { kind: 'workspace', workspaceId: nodeId },
    workspaceId: nodeId
  })
  let snapshot
  const deadline = Date.now() + 90000
  while (Date.now() < deadline) {
    snapshot = await gateway.call('blueprint/inspectRun', { runId: started.runId, workspaceId: nodeId })
    if (['succeeded', 'failed', 'cancelled', 'timed_out', 'recovery_required'].includes(snapshot.state)) break
    await new Promise(resolvePoll => setTimeout(resolvePoll, 250))
  }
  if (snapshot?.state !== 'succeeded') fail(`TEMPLATE_RUN_${String(snapshot?.state ?? 'timeout').toUpperCase()}`)
  const output = [...(snapshot.attempts ?? [])].reverse().find(attempt => attempt.nodeId === 'output')
  const text = JSON.stringify(snapshot)
  if (!text.includes(nonce)) fail('TEMPLATE_RUN_NONCE_MISSING')
  receipt.cases.push({ id: 'run', passed: true, runId: started.runId, nodeId: nodeInstance.instance.asset.blueprintId, output: output?.state ?? null })
  receipt.ok = true
  receipt.finishedAt = new Date().toISOString()
} catch (error) {
  receipt.ok = false
  receipt.error = { stage, code: error?.code ?? 'TEMPLATE_JOURNEY_FAILED' }
} finally {
  if (gateway !== undefined && temporaryWorkspaces.length > 0) {
    for (const workspaceId of temporaryWorkspaces) {
      try {
        await gateway.call('workspace/delete', { workspaceId }, 'request')
      } catch {
        // Cleanup is best-effort; the report still records the temporary IDs.
      }
    }
  }
  if (child && child.exitCode === null) {
    child.kill('SIGTERM')
    await new Promise(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
  writeFileSync(join(reportDir, 'template-journey-report.json'), JSON.stringify(receipt, null, 2))
}
console.log(JSON.stringify({ ok: receipt.ok, cases: receipt.cases.map(item => item.id), error: receipt.error ?? null, reportDir }))
if (!receipt.ok) process.exitCode = 1

function providerKey(path, provider) {
  return providerField(path, provider, 'key')
}
function providerField(path, provider, field) {
  const text = readFileSync(path, 'utf8')
  let inside = false
  for (const line of text.split(/\r?\n/)) {
    if (new RegExp(`^${provider.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*$`).test(line)) {
      inside = true
      continue
    }
    if (inside && /^[A-Za-z]/.test(line)) break
    if (!inside) continue
    const match = new RegExp(`^\\s+${field}:\\s*(.+)$`).exec(line)
    if (match) return match[1].trim().replace(/^["']|["']$/g, '')
  }
  throw new LiveJourneyError('LIVE_CONFIGURATION_MISSING')
}
function protocolFor(type) {
  return { responses: 'openai-responses', anthropic: 'anthropic-messages', completions: 'openai-completions' }[type] ?? 'openai-completions'
}
function readyUrl(process) {
  return new Promise((resolveReady, reject) => {
    let tail = ''
    const timer = setTimeout(() => reject(new LiveJourneyError('LIVE_HOST_BOOT_TIMEOUT')), 30000)
    const take = chunk => {
      tail = (tail + chunk.toString()).slice(-8192)
      const match = tail.match(/http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/[^\s]*token=[A-Za-z0-9._-]+/)
      if (match) {
        clearTimeout(timer)
        resolveReady(match[0])
      }
    }
    process.stdout.on('data', take)
    process.stderr.on('data', take)
    process.once('exit', () => {
      clearTimeout(timer)
      reject(new LiveJourneyError('LIVE_HOST_EXITED'))
    })
  })
}
function gatewayFor(authUrl) {
  const url = new URL(authUrl)
  let cookie = ''
  const allowed = new Set([
    'blueprint/ping',
    'blueprint/extractTemplate',
    'blueprint/saveTemplate',
    'blueprint/instantiateTemplate',
    'blueprint/startRun',
    'blueprint/inspectRun',
    'workspace/create',
    'workspace/delete'
  ])
  return {
    async authenticate() {
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
      cookie = (response.headers.getSetCookie?.() ?? []).map(value => value.split(';')[0]).join('; ')
      if (!cookie || ![302, 303].includes(response.status)) fail('LIVE_GATEWAY_AUTH_FAILED')
    },
    async call(method, args, parameter = 'args') {
      if (!allowed.has(method)) fail('LIVE_GATEWAY_METHOD_INVALID')
      const payloadArgs = parameter === null ? {} : { [parameter]: args }
      const target = new URL(`/api/${method}`, url.origin)
      const response = await fetch(target, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(120000),
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args: payloadArgs } })
      })
      const body = await response.json()
      if (response.status !== 200 || body?.result?.ok !== true) {
        const detail = body?.result?.error?.code ?? body?.error?.code ?? `HTTP_${response.status}`
        const message = String(body?.result?.error?.message ?? body?.error?.message ?? '').slice(0, 400)
        fail(`LIVE_GATEWAY_${String(detail).replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()}_${message.replace(/[^A-Za-z0-9_ .:-]/g, '_')}`)
      }
      return body.result.value
    }
  }
}
