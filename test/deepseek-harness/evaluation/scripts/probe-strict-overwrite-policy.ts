#!/usr/bin/env tsx
// Direct, non-model probe for RFC 0002 Stage 1.
//
// This assembles the checked-out DSH Cordis and ToolRuntime sources. It proves
// that the XuanLing policy runs before a tool body for both direct and Code
// Mode sub-dispatches, delegates the two safe write intents unchanged, unloads
// with its plugin fiber, and starts from local-directory and packed installs.
// With --binary it also mounts the official DSH MCP bridge through a temporary
// call-counting stdio proxy and checks the real Rust file effects.

import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index === -1 || index + 1 >= process.argv.length ? undefined : process.argv[index + 1]
}

const dshRootArg = argValue('--dsh-root')
if (dshRootArg === undefined) {
  console.error('probe-strict-overwrite-policy: --dsh-root is required')
  process.exit(2)
}

const dshRoot = path.resolve(dshRootArg)
const binaryArg = argValue('--binary')
const binary = binaryArg === undefined ? undefined : path.resolve(binaryArg)
const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..', '..', '..', '..')
const integrationRoot = path.join(repoRoot, 'integrations', 'deepseek-harness')
const bundleRoot = path.join(integrationRoot, 'xuanling-skills')
const policyModulePath = path.join(bundleRoot, 'strict-overwrite-policy.mjs')
const GUARDED_TOOL = 'mcp__xuanling__fs_write_text'
const DENIAL_CODE = 'XUANLING_FS_OVERWRITE_REQUIRES_SHA256'

type Check = {
  name: string
  ok: boolean
  detail: string
}

const checks: Check[] = []
function check(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail })
}

function resultErrorMessage(result: unknown): string {
  if (typeof result !== 'object' || result === null) return ''
  const error = (result as { error?: unknown }).error
  if (typeof error !== 'object' || error === null) return ''
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' ? message : ''
}

const sourceUrl = (relative: string): string =>
  pathToFileURL(path.join(dshRoot, relative)).href

const [{ Context }, SystemPromptModule, ToolsModule, policyModule] =
  await Promise.all([
    import(sourceUrl('vendor/cordis/src/index.ts')),
    import(sourceUrl('packages/core/system-prompt/src/index.ts')),
    import(sourceUrl('packages/core/tools/src/index.ts')),
    import(pathToFileURL(policyModulePath).href),
  ])

const SystemPrompt = SystemPromptModule.default ?? SystemPromptModule
const ToolRuntime = ToolsModule.default ?? ToolsModule
const { defineTool } = ToolsModule

async function runtime(mode: 'native' | 'code') {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt as never)
  await ctx.plugin(ToolRuntime as never, { mode })
  const calls: unknown[] = []
  ctx.tools.register(defineTool({
    name: GUARDED_TOOL,
    description: 'Strict-overwrite policy probe body.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
    },
    execute(args: unknown) {
      calls.push(args)
      return Promise.resolve('dispatched')
    },
  }))
  const policyFiber = await ctx.plugin(policyModule as never)
  return { ctx, calls, policyFiber }
}

let callId = 0
function input(argumentsValue: Record<string, unknown>, codeMode = false) {
  callId += 1
  return {
    callId: `xuanling-policy-probe-${callId}`,
    ...(codeMode
      ? { rootCallId: 'xuanling-policy-probe-root', parent: Symbol('run_code') }
      : {}),
    name: GUARDED_TOOL,
    arguments: argumentsValue,
    signal: AbortSignal.timeout(20_000),
  }
}

async function probeDirectRuntime(): Promise<void> {
  const { ctx, calls, policyFiber } = await runtime('native')
  try {
    const unsafe = Object.freeze({ path: 'existing.txt', content: 'next', mode: 'overwrite' })
    const denied = await ctx.tools.execute(input(unsafe))
    check(
      'direct unsafe overwrite denied before body',
      denied.isError === true && resultErrorMessage(denied).includes(DENIAL_CODE) && calls.length === 0,
      `isError=${String(denied.isError)} body_calls=${calls.length} error=${JSON.stringify(resultErrorMessage(denied))}`,
    )

    const create = Object.freeze({ path: 'new.txt', content: 'new', mode: 'create' })
    const created = await ctx.tools.execute(input(create))
    check(
      'explicit create delegates unchanged',
      created.isError === false && calls.length === 1 && JSON.stringify(calls[0]) === JSON.stringify(create),
      `isError=${String(created.isError)} body_calls=${calls.length} args=${JSON.stringify(calls[0])}`,
    )

    const overwrite = Object.freeze({
      path: 'existing.txt',
      content: 'next',
      mode: 'overwrite',
      expected_sha256: 'a'.repeat(64),
    })
    const replaced = await ctx.tools.execute(input(overwrite))
    check(
      'hash-bearing overwrite delegates unchanged',
      replaced.isError === false && calls.length === 2 && JSON.stringify(calls[1]) === JSON.stringify(overwrite),
      `isError=${String(replaced.isError)} body_calls=${calls.length} args=${JSON.stringify(calls[1])}`,
    )

    await policyFiber.dispose()
    const afterDispose = await ctx.tools.execute(input(unsafe))
    check(
      'plugin disposal removes the listener',
      afterDispose.isError === false && calls.length === 3,
      `isError=${String(afterDispose.isError)} body_calls=${calls.length}`,
    )
  } finally {
    await ctx.fiber.dispose()
  }
}

async function probeCodeModeSubDispatch(): Promise<void> {
  const { ctx, calls } = await runtime('code')
  try {
    const denied = await ctx.tools.execute(input({
      path: 'existing.txt',
      content: 'next',
      mode: 'overwrite',
    }, true))
    check(
      'Code Mode sub-dispatch cannot bypass the policy',
      denied.isError === true && resultErrorMessage(denied).includes(DENIAL_CODE) && calls.length === 0,
      `isError=${String(denied.isError)} body_calls=${calls.length} error=${JSON.stringify(resultErrorMessage(denied))}`,
    )
  } finally {
    await ctx.fiber.dispose()
  }
}

function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM']) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return { ...env, ...extra }
}

type InstallKind = 'local-directory-install' | 'packed-tarball-install'

function installBundle(modulesDir: string, kind: InstallKind): void {
  const destination = path.join(modulesDir, 'xuanling-dsh-skills')
  if (kind === 'local-directory-install') {
    cpSync(bundleRoot, destination, { recursive: true })
    return
  }

  const packDir = path.join(path.dirname(modulesDir), 'pack')
  mkdirSync(packDir, { recursive: true })
  const packed = spawnSync('npm', [
    'pack', bundleRoot,
    '--json',
    '--pack-destination', packDir,
  ], {
    cwd: bundleRoot,
    encoding: 'utf8',
    env: childEnv({}),
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  })
  if (packed.status !== 0) {
    throw new Error(`npm pack failed: ${String(packed.stderr ?? packed.stdout)}`)
  }
  const report = JSON.parse(packed.stdout) as Array<{ filename?: string }>
  const filename = report[0]?.filename
  if (typeof filename !== 'string') throw new Error('npm pack did not report a tarball filename')
  mkdirSync(destination, { recursive: true })
  const extracted = spawnSync('tar', [
    '-xzf', path.join(packDir, filename),
    '-C', destination,
    '--strip-components=1',
  ], {
    encoding: 'utf8',
    env: childEnv({}),
    timeout: 60_000,
  })
  if (extracted.status !== 0) {
    throw new Error(`tar extraction failed: ${String(extracted.stderr ?? extracted.stdout)}`)
  }
}

function writeStartupProfile(home: string, profileName: string, kind: InstallKind): string {
  const profileDir = path.join(home, 'profiles', profileName)
  const modulesDir = path.join(profileDir, 'node_modules')
  const markerBundle = path.join(modulesDir, 'xuanling-policy-startup-marker')
  const ready = path.join(home, `${profileName}.ready`)
  mkdirSync(markerBundle, { recursive: true })

  const markerModule = path.join(markerBundle, 'marker.mjs')
  writeFileSync(markerModule, [
    "import { writeFileSync } from 'node:fs'",
    "export const name = 'xuanling-policy-startup-marker'",
    'export function apply(ctx) {',
    '  let active = true',
    '  void ctx.loader.await().then(() => {',
    "    if (!active) return",
    "    writeFileSync(process.env.XUANLING_POLICY_READY_FILE, 'ready')",
    "    process.kill(process.pid, 'SIGTERM')",
    '  })',
    '  ctx.effect(() => () => { active = false })',
    '}',
    '',
  ].join('\n'))
  writeFileSync(path.join(markerBundle, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: xuanling-policy-startup-marker',
    `      name: ${pathToFileURL(markerModule).href}`,
    '',
  ].join('\n'))
  writeFileSync(path.join(markerBundle, 'package.json'), JSON.stringify({
    name: 'xuanling-policy-startup-marker',
    version: '0.0.0',
    type: 'module',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, undefined, 2) + '\n')

  installBundle(modulesDir, kind)
  writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: `dsh-profile-${profileName}`,
    private: true,
    dependencies: {},
    dsh: {
      profile: {
        bundles: [
          '@deepseek-ai/dsh-base',
          'xuanling-dsh-skills',
          'xuanling-policy-startup-marker',
        ],
      },
    },
  }, undefined, 2) + '\n')
  writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '[]\n')
  return ready
}

function probeProfileStartup(kind: InstallKind): void {
  const home = mkdtempSync(path.join(tmpdir(), `xuanling-policy-${kind}-`))
  const profileName = kind === 'packed-tarball-install' ? 'packed-policy' : 'local-policy'
  const ready = writeStartupProfile(home, profileName, kind)
  const args = [
    path.join(dshRoot, 'apps', 'cli', 'src', 'bin.ts'),
    '--profile', profileName,
  ]
  const env = childEnv({
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1',
    TSX_TSCONFIG_PATH: path.join(dshRoot, 'tsconfig.json'),
    XUANLING_POLICY_READY_FILE: ready,
  })

  try {
    const child = spawnSync(path.join(dshRoot, 'node_modules', '.bin', 'tsx'), args, {
      cwd: home,
      encoding: 'utf8',
      env,
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    })
    const output = `${child.stdout ?? ''}${child.stderr ?? ''}`
    check(
      `${kind} reaches a settled DSH profile`,
      child.status === 0 && child.signal === null && existsSync(ready),
      `exit=${String(child.status)} signal=${String(child.signal)} ready=${String(existsSync(ready))}` +
        (child.status === 0 && existsSync(ready) ? '' : ` output=${JSON.stringify(output.slice(0, 600))}`),
    )
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
}

function renderedText(result: unknown): string {
  if (typeof result !== 'object' || result === null) return ''
  const content = (result as { content?: unknown }).content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => typeof block === 'object' && block !== null &&
      (block as { type?: unknown }).type === 'text' && typeof (block as { text?: unknown }).text === 'string'
      ? (block as { text: string }).text
      : '')
    .join('\n')
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function writeCountingProxy(root: string): { module: string; log: string } {
  const module = path.join(root, 'counting-mcp-proxy.mjs')
  const log = path.join(root, 'tools-call.log')
  writeFileSync(log, '')
  writeFileSync(module, [
    "import { appendFileSync } from 'node:fs'",
    "import { spawn } from 'node:child_process'",
    "import readline from 'node:readline'",
    "const value = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }",
    "const separator = process.argv.indexOf('--')",
    "const binary = value('--binary')",
    "const log = value('--log')",
    "if (!binary || !log || separator < 0) throw new Error('counting proxy requires --binary, --log, and --')",
    "const child = spawn(binary, process.argv.slice(separator + 1), { stdio: ['pipe', 'pipe', 'pipe'], env: process.env })",
    "child.stdout.pipe(process.stdout)",
    "child.stderr.pipe(process.stderr)",
    "const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })",
    "lines.on('line', line => {",
    "  try {",
    "    const frame = JSON.parse(line)",
    "    if (frame?.method === 'tools/call' && typeof frame?.params?.name === 'string') appendFileSync(log, `${frame.params.name}\\n`)",
    "  } catch {}",
    "  child.stdin.write(`${line}\\n`)",
    "})",
    "lines.on('close', () => child.stdin.end())",
    "let stopping = false",
    "const stop = signal => {",
    "  if (stopping) return",
    "  stopping = true",
    "  child.kill(signal)",
    "  setTimeout(() => child.kill('SIGKILL'), 500).unref()",
    "}",
    "process.on('SIGTERM', () => stop('SIGTERM'))",
    "process.on('SIGINT', () => stop('SIGINT'))",
    "child.on('error', error => { process.stderr.write(`${String(error)}\\n`); process.exitCode = 1 })",
    "child.on('close', (code, signal) => {",
    "  lines.close()",
    "  process.stdin.unref()",
    "  process.exitCode = code ?? (signal ? 1 : 0)",
    "})",
    '',
  ].join('\n'))
  return { module, log }
}

function wireCalls(log: string): string[] {
  return readFileSync(log, 'utf8').split('\n').filter(Boolean)
}

async function probeLiveBridge(binaryPath: string): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'xuanling-policy-live-bridge-'))
  const workspace = path.join(root, 'workspace')
  const memoryDb = path.join(root, 'memory.db')
  mkdirSync(workspace, { recursive: true })
  const proxy = writeCountingProxy(root)
  const McpModule = await import(sourceUrl('packages/mcp/mcp-client/src/index.ts'))
  const ctx = new Context()
  let dispatchStages = 0
  try {
    await ctx.plugin(SystemPrompt as never)
    await ctx.plugin(ToolRuntime as never, { mode: 'both' })
    await ctx.plugin(policyModule as never)
    ctx.on('tools/execute', (exec: { name: string }, next: () => Promise<unknown>) => {
      if (exec.name === GUARDED_TOOL) dispatchStages += 1
      return next()
    })
    await ctx.plugin({
      name: 'xuanling-policy-live-bridge',
      inject: McpModule.inject,
      apply: McpModule.apply,
    } as never, {
      transport: 'stdio',
      serverName: 'xuanling',
      command: process.execPath,
      args: [
        proxy.module,
        '--log', proxy.log,
        '--binary', binaryPath,
        '--',
        '--workspace-root', workspace,
        '--memory-db', memoryDb,
        '--tool-profile', 'fs',
      ],
      env: {},
      cwd: '',
      toolCallTimeoutMs: 60_000,
      failOnStartupError: true,
    } as never)

    check(
      'official bridge registers the guarded fs tool',
      ctx.tools.get(GUARDED_TOOL) !== undefined,
      `registered=${String(ctx.tools.get(GUARDED_TOOL) !== undefined)}`,
    )

    const existingPath = path.join(workspace, 'existing.txt')
    const original = 'original\n'
    writeFileSync(existingPath, original)
    const initialMtime = statSync(existingPath).mtimeMs
    const unsafe = await ctx.tools.execute(input({
      path: 'existing.txt',
      content: 'unsafe\n',
      mode: 'overwrite',
    }))
    check(
      'unsafe overwrite has zero MCP calls and zero file effects',
      unsafe.isError === true && resultErrorMessage(unsafe).includes(DENIAL_CODE) &&
        wireCalls(proxy.log).length === 0 && dispatchStages === 0 &&
        readFileSync(existingPath, 'utf8') === original && statSync(existingPath).mtimeMs === initialMtime,
      `isError=${String(unsafe.isError)} wire=${wireCalls(proxy.log).length} dispatch=${dispatchStages}`,
    )

    const defaultUnsafe = await ctx.tools.execute(input({
      path: 'existing.txt',
      content: 'unsafe-default\n',
    }))
    check(
      'default overwrite has zero MCP calls and zero file effects',
      defaultUnsafe.isError === true && resultErrorMessage(defaultUnsafe).includes(DENIAL_CODE) &&
        wireCalls(proxy.log).length === 0 && dispatchStages === 0 &&
        readFileSync(existingPath, 'utf8') === original && statSync(existingPath).mtimeMs === initialMtime,
      `isError=${String(defaultUnsafe.isError)} wire=${wireCalls(proxy.log).length} dispatch=${dispatchStages}`,
    )

    const createdPath = path.join(workspace, 'created.txt')
    const created = await ctx.tools.execute(input({
      path: 'created.txt',
      content: 'created\n',
      mode: 'create',
    }))
    check(
      'create reaches Rust once and creates the target',
      created.isError === false && wireCalls(proxy.log).length === 1 && dispatchStages === 1 &&
        wireCalls(proxy.log)[0] === 'fs_write_text' && readFileSync(createdPath, 'utf8') === 'created\n',
      `isError=${String(created.isError)} wire=${JSON.stringify(wireCalls(proxy.log))} dispatch=${dispatchStages}`,
    )

    const createdMtime = statSync(createdPath).mtimeMs
    const createExisting = await ctx.tools.execute(input({
      path: 'created.txt',
      content: 'must-not-replace\n',
      mode: 'create',
    }))
    check(
      'create-existing preserves canonical already_exists',
      createExisting.isError === true && renderedText(createExisting).includes('already_exists') &&
        wireCalls(proxy.log).length === 2 && dispatchStages === 2 &&
        readFileSync(createdPath, 'utf8') === 'created\n' && statSync(createdPath).mtimeMs === createdMtime,
      `isError=${String(createExisting.isError)} wire=${wireCalls(proxy.log).length} dispatch=${dispatchStages}`,
    )

    const matching = await ctx.tools.execute(input({
      path: 'existing.txt',
      content: 'matched\n',
      mode: 'overwrite',
      expected_sha256: sha256(original),
    }))
    check(
      'matching preimage reaches Rust once and replaces atomically',
      matching.isError === false && wireCalls(proxy.log).length === 3 && dispatchStages === 3 &&
        readFileSync(existingPath, 'utf8') === 'matched\n',
      `isError=${String(matching.isError)} wire=${wireCalls(proxy.log).length} dispatch=${dispatchStages}`,
    )

    const staleHash = sha256('matched\n')
    writeFileSync(existingPath, 'external\n')
    const externalMtime = statSync(existingPath).mtimeMs
    const stale = await ctx.tools.execute(input({
      path: 'existing.txt',
      content: 'must-not-win\n',
      mode: 'overwrite',
      expected_sha256: staleHash,
    }))
    check(
      'stale preimage reaches Rust once and preserves external bytes',
      stale.isError === true && renderedText(stale).includes('conflict') &&
        wireCalls(proxy.log).length === 4 && dispatchStages === 4 &&
        readFileSync(existingPath, 'utf8') === 'external\n' && statSync(existingPath).mtimeMs === externalMtime,
      `isError=${String(stale.isError)} wire=${wireCalls(proxy.log).length} dispatch=${dispatchStages}`,
    )

    const codeModeDenied = await ctx.tools.execute(input({
      path: 'existing.txt',
      content: 'code-mode-unsafe\n',
      mode: 'overwrite',
    }, true))
    check(
      'Code Mode bridge sub-dispatch has zero additional MCP calls',
      codeModeDenied.isError === true && resultErrorMessage(codeModeDenied).includes(DENIAL_CODE) &&
        wireCalls(proxy.log).length === 4 && dispatchStages === 4 &&
        readFileSync(existingPath, 'utf8') === 'external\n',
      `isError=${String(codeModeDenied.isError)} wire=${wireCalls(proxy.log).length} dispatch=${dispatchStages}`,
    )
  } finally {
    await ctx.fiber.dispose()
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
  const processes = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
  const residue = (processes.stdout ?? '').split('\n').filter((line) => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    return match !== null && Number(match[1]) !== process.pid && match[2].includes(root)
  })
  check(
    'live bridge teardown removes processes and temporary state',
    processes.status === 0 && residue.length === 0 && !existsSync(root),
    `ps_exit=${String(processes.status)} residue=${residue.length} temp_removed=${String(!existsSync(root))}`,
  )
}

try {
  await probeDirectRuntime()
  await probeCodeModeSubDispatch()
  probeProfileStartup('local-directory-install')
  probeProfileStartup('packed-tarball-install')
  if (binary !== undefined) await probeLiveBridge(binary)
} catch (error) {
  check('probe harness completes', false, error instanceof Error ? error.stack ?? error.message : String(error))
}

const counts = {
  total: checks.length,
  passed: checks.filter((item) => item.ok).length,
  failed: checks.filter((item) => !item.ok).length,
}
process.stdout.write(`${JSON.stringify({ dsh_root: dshRoot, binary: binary ?? null, checks, counts }, null, 2)}\n`)
if (counts.total === 0 || counts.failed > 0) process.exit(1)
