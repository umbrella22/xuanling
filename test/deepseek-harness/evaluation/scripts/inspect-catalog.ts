#!/usr/bin/env tsx
// Catalog + dispatch inspector for the filesystem-evaluation arms (C-04).
//
// For each requested arm this script composes the REAL headless profile
// (skills bundle + common overlay + arm overlay) via `dsh --dump-config` —
// no model, no network — and then, for arms that mount the bridge, boots the
// actual adapter + xuanling-mcp server with the arm's bridge argv to verify:
//   - the exact 16-tool fs catalog on the wire (discovery), and
//   - that a hidden non-fs tool is REJECTED on dispatch (server-side trim).
//
// Usage:
//   tsx inspect-catalog.ts --dsh-root /path/to/deepseek-harness \
//     --binary /path/to/xuanling-mcp [--arms A,B,C]
// Prints one JSON verdict; exit 0 = all checks pass.

import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline'

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index === -1 || index + 1 >= process.argv.length ? undefined : process.argv[index + 1]
}

const dshRoot = argValue('--dsh-root')
const binaryArg = argValue('--binary')
const armsArg = argValue('--arms') ?? 'A,B,C'
if (!dshRoot || !binaryArg) {
  console.error('inspect-catalog: --dsh-root and --binary are required')
  process.exit(2)
}
const arms = armsArg.split(',').map((arm) => arm.trim()).filter(Boolean)

function nonSecretChildEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM']) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return { ...env, ...extra }
}

// `yaml` is a DSH-workspace dependency (pnpm-isolated); resolve it through
// the harness checkout this script inspects, never through this repository.
const dshRequire = createRequire(path.join(dshRoot, 'packages', 'skill', 'skill-filesystem', 'package.json'))
const { parse } = dshRequire('yaml') as typeof import('yaml')

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..', '..', '..', '..')
const testRoot = path.join(repoRoot, 'test', 'deepseek-harness')
const evaluationRoot = path.join(testRoot, 'evaluation')
const integrationRoot = path.join(repoRoot, 'integrations', 'deepseek-harness')
const skillsPatch = path.join(integrationRoot, 'xuanling-skills', 'cordis.patch.yml')
const commonPatch = path.join(evaluationRoot, 'overlays', 'common', 'cordis.patch.yml')
const adapterPath = path.join(integrationRoot, 'xuanling-memory', 'schema-adapter.mjs')
const binary = path.resolve(binaryArg)

const EXACT_FS_TOOLS = [
  'fs_copy', 'fs_edit', 'fs_edit_preview', 'fs_glob', 'fs_hash', 'fs_list',
  'fs_mkdir', 'fs_move', 'fs_patch', 'fs_read_bytes', 'fs_read_text',
  'fs_remove', 'fs_replace_text', 'fs_search', 'fs_stat', 'fs_write_text',
]
const NATIVE_FS_ROWS = ['tool-fs', 'tool-fs-search', 'tool-str-replace-editor']
const SHELL_ROWS = ['tool-bash', 'tool-pwsh']
// Model-facing bypass rows that must be disabled in EVERY arm (C-02): no
// routing around the two file families through background jobs, delegation,
// workflows, ralph, or Code Mode's runtime.
const BYPASS_ROWS = [
  'tool-jobs',
  'tool-subagent-control',
  'tool-subagent-list-agents',
  'tool-subagent',
  'tool-subagent-fork',
  'tool-subagent-report',
  'workflow-worker-thread',
  'tool-workflow',
  'tool-ralph',
  'code-runtime',
]

interface Row {
  id?: string
  name?: string
  disabled?: boolean | { js: string }
  insert?: Row[]
  config?: Record<string, unknown>
}

const checks: Array<{ arm: string; name: string; ok: boolean; detail: string }> = []
function check(arm: string, name: string, ok: boolean, detail: string) {
  checks.push({ arm, name, ok, detail })
}

function isDisabled(row: Row | undefined): boolean {
  if (row === undefined) return false
  if (row.disabled === true) return true
  if (typeof row.disabled === 'object' && row.disabled !== null && 'js' in row.disabled) {
    return String((row.disabled as { js: string }).js).includes('true')
  }
  return false
}

function dumpConfig(arm: string): string {
  const armPatch = path.join(evaluationRoot, 'overlays', arm, 'cordis.patch.yml')
  // Invoke the checkout's CLI directly. `pnpm dsh` may emit workspace install
  // progress to stdout when spawned without a TTY, which would corrupt the
  // YAML dump and make catalog inspection fail before any contract is checked.
  const result = spawnSyncText(
    path.join(dshRoot, 'node_modules', '.bin', 'tsx'),
    [path.join(dshRoot, 'apps', 'cli', 'src', 'bin.ts'), '--profile', 'headless', '--patch', skillsPatch, '--patch', commonPatch, '--patch', armPatch, '--dump-config'],
    dshRoot,
    { TSX_TSCONFIG_PATH: path.join(dshRoot, 'tsconfig.json') },
  )
  if (result.code !== 0) {
    throw new Error(`arm ${arm}: dsh --dump-config exited ${result.code}:\n${result.stdout}\n${result.stderr}`)
  }
  return result.stdout
}

function spawnSyncText(
  program: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): { code: number; stdout: string; stderr: string } {
  const child = spawnSync(program, args, {
    cwd,
    encoding: 'utf8',
    env: nonSecretChildEnv(env),
  })
  return { code: child.status ?? -1, stdout: child.stdout ?? '', stderr: child.stderr ?? '' }
}

const jsTag = {
  tag: 'tag:yaml.org,2002:js',
  resolve(value: string) {
    return { js: value }
  },
}

function parseDump(text: string): Row[] {
  const parsed = parse(text, { customTags: [jsTag as never] })
  if (!Array.isArray(parsed)) throw new Error('dump-config did not produce a top-level array')
  return parsed as Row[]
}

function collectRows(rows: Row[]): Row[] {
  const flat: Row[] = []
  for (const row of rows) {
    flat.push(row)
    if (Array.isArray(row.insert)) flat.push(...row.insert)
  }
  return flat
}

// ---------------------------------------------------------------------------
// Minimal MCP stdio client for the live catalog/dispatch probe.
// ---------------------------------------------------------------------------

interface McpFrame {
  jsonrpc: '2.0'
  id?: number
  method?: string
  params?: unknown
  result?: { tools?: Array<{ name: string }>; isError?: boolean; content?: Array<{ text?: string }> }
  error?: { message?: string }
}

let nextRequestId = 1

async function mcpSession(
  argv: string[],
  handler: (
    request: (method: string, params: unknown) => Promise<McpFrame>,
    notify: (frame: McpFrame) => void,
  ) => Promise<void>,
): Promise<void> {
  // Detached: teardown signals the whole process group so the adapter's
  // xuanling-mcp child never leaks.
  const child = spawn(process.execPath, argv, {
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
    env: nonSecretChildEnv(),
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => { stderr += chunk })

  const buffered: McpFrame[] = []
  let wake: (() => void) | undefined
  let finished = false
  const push = (frame: McpFrame) => { buffered.push(frame); wake?.() }
  const finish = () => { finished = true; wake?.() }

  const lineReader = readline.createInterface({ input: child.stdout })
  lineReader.on('line', (line: string) => {
    if (!line.trim()) return
    try {
      push(JSON.parse(line) as McpFrame)
    } catch {
      finish()
    }
  })

  const write = (frame: McpFrame) => {
    child.stdin.write(`${JSON.stringify(frame)}\n`)
  }

  const pending = new Map<number, (frame: McpFrame) => void>()
  const failAll = (message: string) => {
    for (const waiter of pending.values()) waiter({ jsonrpc: '2.0', error: { message } })
    pending.clear()
    finish()
  }

  const timeout = setTimeout(() => {
    void killProcessGroup(child)
    failAll(`MCP probe timed out; adapter stderr:\n${stderr}`)
  }, 30_000)

  // Single dispatcher: one iteration of the frame stream routes each response
  // to its waiter. Concurrent for-await loops over one shared iterable would
  // terminate it on the first early return.
  void (async () => {
    while (true) {
      while (buffered.length > 0) {
        const frame = buffered.shift() as McpFrame
        if (frame.id === undefined) continue
        const waiter = pending.get(frame.id)
        if (waiter !== undefined) {
          pending.delete(frame.id)
          waiter(frame)
        }
      }
      if (finished) return
      await new Promise<void>((resolve) => { wake = resolve })
    }
  })()

  const request = (method: string, params: unknown): Promise<McpFrame> =>
    new Promise((resolve, reject) => {
      const id = nextRequestId++
      pending.set(id, resolve)
      try {
        write({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })

  try {
    await handler(request, write)
    child.stdin.end()
    await new Promise<void>((resolve) => {
      child.once('close', () => resolve())
      child.once('error', () => resolve())
    })
    if (stderr.trim().length > 0) {
      // Adapter diagnostics are fine to surface but do not fail the probe.
      process.stderr.write(`inspect-catalog: adapter stderr: ${stderr}`)
    }
  } finally {
    clearTimeout(timeout)
    lineReader.close()
    // Always sweep the detached group: the adapter can exit cleanly while its
    // xuanling-mcp child is still alive and holding the temporary DB open.
    await killProcessGroup(child)
  }
}

/** TERM the child's whole process group, then force-KILL it after a grace. */
async function killProcessGroup(child: { pid?: number; exitCode: number | null; signalCode: NodeJS.Signals | null }) {
  const pid = child.pid
  if (pid === undefined) return
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(-pid, signal)
    } catch {
      // The group may already be gone.
    }
  }
  signalGroup('SIGTERM')
  await new Promise<void>((resolve) => setTimeout(resolve, 300))
  // The adapter may exit before its xuanling-mcp child, so always signal the
  // detached process group after the grace period.
  signalGroup('SIGKILL')
}

async function probeBridgeCatalog(arm: string): Promise<void> {
  const workspace = mkdtempSync(path.join(tmpdir(), `xuanling-inspect-${arm}-`))
  const argv = [
    adapterPath,
    '--binary', binary,
    '--', '--workspace-root', workspace, '--memory-db', path.join(workspace, 'memory.db'), '--tool-profile', 'fs',
  ]
  try {
    await mcpSession(argv, async (request, notify) => {
      const initialized = await request('initialize', {
        capabilities: {},
        clientInfo: { name: 'xuanling-inspect-catalog', version: '0' },
        protocolVersion: '2024-11-05',
      })
      if (initialized.error !== undefined) {
        throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`)
      }
      notify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })

      const listed = await request('tools/list', {})
      const names = (listed.result?.tools ?? []).map((tool) => tool.name).sort()
      // Probed through the schema adapter directly: names are the server's raw
      // tool names (the mcp__xuanling__ prefix is added by the DSH bridge mount,
      // proven separately by the bridge verifier and live sessions).
      const fsNames = names.filter((name) => name.startsWith('fs_'))
      const unexpected = names.filter((name) => !name.startsWith('fs_'))
      check(
        arm,
        'bridge catalog is the exact fs16 family',
        JSON.stringify(fsNames) === JSON.stringify(EXACT_FS_TOOLS),
        `${fsNames.length} fs tools, unexpected: ${unexpected.join(', ') || '(none)'}`,
      )

      const hidden = await request('tools/call', {
        // This client talks to the adapter/server directly, before DSH adds
        // its mcp__<server>__ mount prefix. Use the raw server name so a
        // rejection proves profile dispatch isolation rather than a typo.
        name: 'memory_search',
        arguments: { namespace: 'inspect', scope: { type: 'global' }, query: 'x', candidate_limit: 1, limit: 1 },
      })
      const rejected = hidden.error !== undefined || hidden.result?.isError === true
      check(
        arm,
        'hidden non-fs tool is rejected on dispatch',
        rejected,
        hidden.error !== undefined
          ? `error: ${hidden.error.message ?? ''}`
          : `isError=${JSON.stringify(hidden.result?.isError ?? null)}`,
      )
    })
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// Arms.
// ---------------------------------------------------------------------------

const armReports: Record<string, unknown> = {}
for (const arm of arms) {
  const rows = collectRows(parseDump(dumpConfig(arm)))
  const byId = new Map(rows.map((row) => [row.id, row]))

  const shellDisabled = SHELL_ROWS.every((id) => isDisabled(byId.get(id)))
  check(arm, 'shell rows disabled in every arm', shellDisabled, SHELL_ROWS.join(', '))

  const bypassEnabled = BYPASS_ROWS.filter((id) => !isDisabled(byId.get(id)))
  check(
    arm,
    'bypass rows (jobs/subagent/workflow/ralph/code-runtime) disabled',
    bypassEnabled.length === 0,
    bypassEnabled.length === 0 ? 'all bypass rows disabled' : `still enabled: ${bypassEnabled.join(', ')}`,
  )

  const skillsRow = byId.get('xuanling-skills')
  const skillsOk =
    skillsRow?.name === '@deepseek-ai/dsh-skill-filesystem' &&
    (skillsRow.config?.providerName as string | undefined) === 'xuanling-dsh-skills' &&
    skillsRow.config?.includeDefaultRoots === false
  check(arm, 'isolated skills provider mounted', skillsOk === true, `provider=${JSON.stringify(skillsRow?.config?.providerName ?? null)}`)

  const credentialsRow = byId.get('credentials')
  const credentialsPath = credentialsRow?.config?.path
  const credentialsPathJs = typeof credentialsPath === 'object' && credentialsPath !== null && 'js' in credentialsPath
    ? String((credentialsPath as { js: string }).js)
    : ''
  const credentialsIsolated = credentialsRow?.name === '@deepseek-ai/dsh-credentials-local'
    && credentialsRow.config?.watch === false
    && credentialsPathJs.includes('XUANLING_DSH_CREDENTIALS_FILE')
    && credentialsPathJs.includes("node:assert').fail(")
  check(
    arm,
    'credential provider uses one fail-closed external reference',
    credentialsIsolated,
    credentialsIsolated ? 'path env required, watcher disabled' : 'credential row is not isolated',
  )

  const bridgeRow = byId.get('xuanling-tools')
  const bridgeArgs = Array.isArray(bridgeRow?.config?.args) ? (bridgeRow?.config?.args as unknown[]) : []
  const profileIndex = bridgeArgs.indexOf('--tool-profile')
  const bridgeProfile = profileIndex === -1 ? null : bridgeArgs[profileIndex + 1]
  const failClosed = bridgeArgs.every(
    (arg) => typeof arg !== 'object' || arg === null || !('js' in arg) || String((arg as { js: string }).js).includes("node:assert').fail("),
  )

  const expectBridge = arm !== 'A'
  check(
    arm,
    `bridge row ${expectBridge ? 'mounted' : 'absent'}`,
    expectBridge ? bridgeRow !== undefined && bridgeProfile === 'fs' : bridgeRow === undefined,
    expectBridge ? `profile=${JSON.stringify(bridgeProfile)}` : 'no xuanling-tools row',
  )
  if (expectBridge) {
    check(arm, 'bridge arguments are fail-closed', failClosed, 'every !!js arg aborts on missing env')
    await probeBridgeCatalog(arm)
  }

  const nativeFsEnabled = NATIVE_FS_ROWS.every((id) => !isDisabled(byId.get(id)))
  const expectNative = arm !== 'B'
  check(
    arm,
    `native fs rows ${expectNative ? 'enabled' : 'disabled'}`,
    nativeFsEnabled === expectNative,
    NATIVE_FS_ROWS.map((id) => `${id}=${isDisabled(byId.get(id)) ? 'disabled' : 'enabled'}`).join(', '),
  )

  armReports[arm] = {
    bridge: expectBridge ? { profile: bridgeProfile } : null,
    native_fs: nativeFsEnabled,
    shell_disabled: shellDisabled,
    skills_provider: skillsOk === true,
  }
}

const failed = checks.filter((entry) => !entry.ok)
process.stdout.write(
  `${JSON.stringify({ arms: armReports, checks, pass: failed.length === 0 }, null, 2)}\n`,
)
if (failed.length > 0) {
  console.error(`inspect-catalog: ${failed.length} check(s) failed`)
  process.exit(1)
}
console.error(`inspect-catalog OK: ${checks.length} checks passed`)
