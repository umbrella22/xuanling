import { supportsDshVersion } from './dsh-version.mjs'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'
import { ROOT, PLUGIN, ensure, sha256, confined, assertPhysicalPath } from './conversation-evidence.mjs'
import { observerSource } from './conversation-observer.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const PACKAGE = '@xuanling-rs/xuanling-dsh-blueprint'
export const CLI = join(ROOT, 'test/blueprint/node_modules/.bin/dsh')
export const KEYLESS_SEED_TEXT = 'Isolated conversation fixture: reject this seed turn before any model request.'
export const APPROVAL_FILE_CONTENT = 'isolated conversation approval fixture\n'
export function artifactInventory(root) {
  const files = []
  const walk = (dir, prefix = '') => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name),
        label = prefix ? `${prefix}/${name}` : name,
        stat = lstatSync(path)
      ensure(!stat.isSymbolicLink(), 'HOST_ARTIFACT_SYMLINK')
      if (stat.isDirectory()) walk(path, label)
      else if (stat.isFile() && name.endsWith('.js')) files.push({ path: label, sha256: sha256(readFileSync(path)) })
    }
  }
  walk(root)
  return files
}
export function isolatedEnvironment(home, source = process.env) {
  const env = {}
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT'])
    if (source[key] !== undefined) env[key] = source[key]
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    DSH_HOME: join(home, 'dsh'),
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_CACHE_HOME: join(home, 'cache'),
    COREPACK_HOME: join(home, 'cache/node/corepack'),
    TMPDIR: join(home, 'tmp'),
    TMP: join(home, 'tmp'),
    TEMP: join(home, 'tmp'),
    npm_config_cache: join(home, 'npm-cache'),
    npm_config_userconfig: join(home, '.npmrc'),
    npm_config_globalconfig: join(home, 'global.npmrc'),
    NO_COLOR: '1',
    DSH_TELEMETRY_MODE: 'OFF',
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0'
  }
}
const pnpmVersion = value => /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(value)
export function pnpmExecutableProvenance(path) {
  ensure(typeof path === 'string' && isAbsolute(path) && resolve(path) === path, 'HOST_PNPM_EXECUTABLE_INVALID')
  assertPhysicalPath(path)
  ensure(existsSync(path) && lstatSync(path).isFile(), 'HOST_PNPM_EXECUTABLE_INVALID')
  const bytes = readFileSync(path),
    sha = sha256(bytes)
  // Native pnpm standalone executables use the platform loader. Node package
  // entries additionally have to be the pnpm bin of an installed package.
  const nativeMagic = bytes.subarray(0, 4).toString('hex')
  if (['7f454c46', 'feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca'].includes(nativeMagic)) {
    ensure((lstatSync(path).mode & 0o111) !== 0, 'HOST_PNPM_EXECUTABLE_INVALID')
    return { path, sha256: sha, runner: 'direct' }
  }
  ensure(/\.(?:c|m)?js$/.test(path), 'HOST_PNPM_EXECUTABLE_INVALID')
  let packageRoot = dirname(path)
  while (!existsSync(join(packageRoot, 'package.json')) && dirname(packageRoot) !== packageRoot) packageRoot = dirname(packageRoot)
  const manifestPath = join(packageRoot, 'package.json')
  ensure(existsSync(manifestPath), 'HOST_PNPM_EXECUTABLE_INVALID')
  assertPhysicalPath(manifestPath)
  const manifestBytes = readFileSync(manifestPath)
  let manifest
  try {
    manifest = JSON.parse(manifestBytes)
  } catch {
    ensure(false, 'HOST_PNPM_EXECUTABLE_INVALID')
  }
  ensure(
    ['pnpm', 'corepack'].includes(manifest.name) && pnpmVersion(manifest.version) && typeof manifest.bin?.pnpm === 'string',
    'HOST_PNPM_EXECUTABLE_INVALID'
  )
  const entry = resolve(packageRoot, manifest.bin.pnpm)
  ensure(confined(packageRoot, entry), 'HOST_PNPM_EXECUTABLE_INVALID')
  assertPhysicalPath(entry)
  // pnpm 11 ships an older-Corepack CJS entry delegating to its declared ESM bin.
  const compatibilityEntry =
    manifest.name === 'pnpm' &&
    path === join(dirname(entry), 'pnpm.cjs') &&
    entry === join(dirname(path), 'pnpm.mjs') &&
    bytes.toString('utf8').includes("import('./pnpm.mjs')")
  ensure(path === entry || compatibilityEntry, 'HOST_PNPM_EXECUTABLE_INVALID')
  const related = [manifestPath, ...(entry === path ? [] : [entry])]
  for (const name of manifest.name === 'pnpm' ? ['dist/pnpm.cjs', 'dist/pnpm.mjs'] : ['dist/lib/corepack.cjs']) {
    const file = join(packageRoot, name)
    if (existsSync(file)) related.push(file)
  }
  return {
    path,
    sha256: sha,
    runner: 'node',
    packageName: manifest.name,
    packageVersion: manifest.version,
    files: related.map(file => {
      assertPhysicalPath(file)
      return { path: file, sha256: sha256(readFileSync(file)) }
    })
  }
}
export function pnpmShimSource(executable, node = process.execPath) {
  const quote = value => "'" + value.replace(/'/g, "'\\''") + "'"
  return '#!/bin/sh\nexec ' + (executable.runner === 'node' ? quote(node) + ' ' : '') + quote(executable.path) + ' "$@"\n'
}
export function preparePnpmEnvironment({ root, cwd, env, steps, pnpmExecutable }) {
  assertPhysicalPath(root)
  ensure(confined(root, cwd) && confined(root, env.HOME), 'HOST_PNPM_ISOLATION_INVALID')
  let path = pnpmExecutable
  if (!path) {
    const candidate = (env.PATH ?? '')
      .split(delimiter)
      .filter(dir => isAbsolute(dir))
      .map(dir => join(dir, 'pnpm'))
      .find(file => existsSync(file))
    ensure(candidate, 'HOST_PNPM_UNAVAILABLE')
    path = realpathSync(candidate) // resolve actual PATH links; never search a user cache
  }
  let executable
  try {
    executable = pnpmExecutableProvenance(path)
  } catch (error) {
    if (pnpmExecutable) throw error
    ensure(false, 'HOST_PNPM_UNAVAILABLE')
  }
  const bin = join(root, 'pnpm-bin'),
    shim = join(bin, 'pnpm'),
    source = pnpmShimSource(executable)
  mkdirSync(bin, { mode: 0o700 })
  writeFileSync(shim, source, { mode: 0o700, flag: 'wx' })
  const installEnv = { ...env, PATH: bin + delimiter + (env.PATH ?? '') }
  const at = new Date().toISOString()
  // Availability must not bootstrap/download Corepack. The actual DSH install
  // keeps its normal registry/network/compatibility behavior after this probe.
  const result = spawnSync(shim, ['--version'], {
    env: { ...installEnv, COREPACK_ENABLE_NETWORK: '0' },
    cwd,
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 64 * 1024
  })
  const version = result.stdout?.trim()
  const step = {
    id: 'pnpm-available',
    ...commandReceipt(shim, ['--version'], result, at),
    executable,
    source: pnpmExecutable ? 'explicit' : 'PATH',
    shimSha256: sha256(source)
  }
  if (pnpmVersion(version) && (executable.packageName !== 'pnpm' || version === executable.packageVersion)) step.version = version
  else step.passed = false
  steps.push(step)
  ensure(step.passed, 'HOST_PNPM_UNAVAILABLE')
  return { env: installEnv, executable }
}
export function commandReceipt(command, args, result, at) {
  return {
    command,
    args,
    at,
    exitCode: result.status,
    signal: result.signal ?? null,
    errorCategory: result.error ? 'HOST_SUBPROCESS_FAILED' : null,
    passed: result.status === 0 && !result.signal && !result.error
  }
}
function execute(command, args, env, cwd, steps, id, timeout = 600000) {
  const at = new Date().toISOString()
  const result = spawnSync(command, args, {
    env,
    cwd,
    encoding: 'utf8',
    timeout,
    maxBuffer: 4 * 1024 * 1024
  })
  // Arbitrary CLI diagnostics may contain raw auth, config, or provider values.
  // Persist status/category only; do not hash or serialize those values.
  steps.push({ id, ...commandReceipt(command, args, result, at) })
  ensure(result.status === 0 && !result.signal && !result.error, 'HOST_CLI_FAILED')
  return result
}
// Only combines patches for the collector's fresh owned profile. Existing
// nonempty block lists keep their bytes; other forms require explicit review.
export function collectorOverlaySource(prior, patches) {
  let entries
  try {
    entries = yaml.load(prior || '[]')
  } catch {
    ensure(false, 'HOST_PROFILE_OVERLAY_INVALID')
  }
  ensure(Array.isArray(entries), 'HOST_PROFILE_OVERLAY_INVALID')
  if (entries.length === 0) return `${patches}\n`
  const lines = prior.split(/\r?\n/).filter(line => line.trim() && !line.trimStart().startsWith('#'))
  ensure(lines[0].trimStart().startsWith('- ') && !lines.some(line => line.trim() === '...'), 'HOST_PROFILE_OVERLAY_UNSAFE_MERGE')
  return `${prior}${prior.endsWith('\n') ? '' : '\n'}${patches}\n`
}
export async function prepareProfile(options, fixture, tempRoot, steps) {
  ensure(existsSync(CLI) && existsSync(join(PLUGIN, 'lib/index.js')), 'HOST_OR_ARTIFACT_MISSING')
  const home = join(tempRoot, 'home'),
    cwd = join(tempRoot, 'cwd'),
    profile = `bp-conversation-${randomUUID()}`
  const profileDir = join(home, 'dsh/profiles', profile),
    env = isolatedEnvironment(home)
  for (const path of [home, cwd, join(home, 'tmp')]) mkdirSync(path, { recursive: true, mode: 0o700 })
  const version = execute(CLI, ['--version'], env, cwd, steps, 'version', 15000)
  ensure(supportsDshVersion(version.stdout.trim()), 'HOST_VERSION_MISMATCH')
  const config = fixture ? await fixture.prepare({ root: tempRoot, mode: options.mode }) : { workspaceRoot: tempRoot }
  ensure(config && typeof config.workspaceRoot === 'string' && isAbsolute(config.workspaceRoot), 'FIXTURE_CONFIG_INVALID')
  ensure(config.workspaceRoot === tempRoot || confined(tempRoot, config.workspaceRoot), 'FIXTURE_WORKSPACE_OUTSIDE_ISOLATION')
  assertPhysicalPath(config.workspaceRoot)
  const runtimeRoot = config.runtimeRoot ?? join(config.workspaceRoot, '.xuanling')
  ensure(confined(tempRoot, runtimeRoot), 'FIXTURE_RUNTIME_OUTSIDE_ISOLATION')
  assertPhysicalPath(runtimeRoot)
  let installedPackage, packageManager
  if (options.installMode === 'cli') {
    packageManager = preparePnpmEnvironment({
      root: tempRoot,
      cwd,
      env,
      steps,
      pnpmExecutable: options.pnpmExecutable
    })
    const packed = execute('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', tempRoot], env, PLUGIN, steps, 'pack', 300000)
    let filename
    try {
      filename = JSON.parse(packed.stdout)?.[0]?.filename
    } catch {
      ensure(false, 'HOST_PACK_INVALID')
    }
    ensure(typeof filename === 'string' && filename === filename.split('/').at(-1) && filename.endsWith('.tgz'), 'HOST_PACK_INVALID')
    execute(CLI, ['--profile', profile, '--from-default-profile', 'web', '--dump-config'], packageManager.env, cwd, steps, 'init')
    execute(CLI, ['plugin', '--profile', profile, 'add', join(tempRoot, filename)], packageManager.env, cwd, steps, 'install')
    installedPackage = join(profileDir, 'node_modules', PACKAGE)
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    ensure(manifest.dsh?.profile?.bundles?.includes(PACKAGE), 'HOST_INSTALLED_BUNDLE_MISSING')
  } else {
    // Supported public profile resolution, as used by runtime-contracts journey.
    // Label this as linked build; never call it tarball-install evidence.
    mkdirSync(join(profileDir, 'node_modules/@xuanling-rs'), { recursive: true, mode: 0o700 })
    installedPackage = join(profileDir, 'node_modules', PACKAGE)
    symlinkSync(PLUGIN, installedPackage, 'dir')
    writeFileSync(
      join(profileDir, 'package.json'),
      JSON.stringify({
        name: profile,
        private: true,
        type: 'module',
        dsh: {
          profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', PACKAGE] }
        }
      }),
      { mode: 0o600 }
    )
    steps.push({
      id: 'linked-profile',
      passed: true,
      provenance: 'public profile manifest + Main-built package symlink'
    })
  }
  // Verify the actual mounted entry bytes, not a report-supplied success flag.
  const installedInventory = artifactInventory(join(installedPackage, 'lib'))
  ensure(sha256(JSON.stringify(installedInventory)) === sha256(JSON.stringify(artifactInventory(join(PLUGIN, 'lib')))), 'HOST_INSTALLED_ARTIFACT_MISMATCH')
  const observer = join(profileDir, 'conversation-observer.mjs'),
    observerFile = join(tempRoot, 'observer-facts.json')
  // DSH's native profile resolution routes this bare import to the installation
  // singleton, sharing the actual AgentLoop request marker's WeakSet.
  writeFileSync(observer, observerSource('@deepseek-ai/dsh-llm'), { mode: 0o600 })
  env.BP_CONVERSATION_OBSERVER_FILE = observerFile
  const disabled = [
    'llm-deepseek',
    'llm-deepseek-account',
    'deepseek-account',
    'session-log-deepseek',
    'session-telemetry-otel',
    'desktop-product-telemetry',
    'product-analytics',
    'session-title-llm',
    'hmr'
  ]
  const patches = disabled.map(id => `- id: ${id}\n  disabled: true`)
  if (options.mode === 'live') {
    Object.assign(env, {
      BP_CONVERSATION_CREDENTIAL_CHILD: '1',
      BP_CONVERSATION_KEY_FILE: options.keyFile,
      NODE_OPTIONS: `--import=${pathToFileURL(join(HERE, 'conversation-credential.mjs')).href}`,
      BP_LIVE_PROVIDER_BASE_URL: options.providerBaseUrl,
      BP_LIVE_PROVIDER_MODEL: options.providerModel,
      BP_LIVE_PROVIDER_PROTOCOL: options.providerProtocol
    })
    patches.push(
      '- id: llm-pi-ai\n  config:\n    providers:\n      blueprint-live:\n        apiKeyEnv: BP_LIVE_PROVIDER_KEY\n        api: !!js process.env.BP_LIVE_PROVIDER_PROTOCOL\n        baseURL: !!js process.env.BP_LIVE_PROVIDER_BASE_URL\n        models:\n          - id: !!js process.env.BP_LIVE_PROVIDER_MODEL\n            input: [text]\n            reasoningEfforts: false\n            contextWindow: 32768' +
        (options.inheritProviderOutputLimit ? '' : '\n            maxTokens: 2048')
    )
    patches.push('- id: agent-default-model\n  config:\n    provider: blueprint-live\n    model: !!js process.env.BP_LIVE_PROVIDER_MODEL')
  } else patches.push('- id: llm-pi-ai\n  disabled: true')
  patches.push(
    `- id: xuanling-blueprint\n  config: ${JSON.stringify({ workspaceRoot: config.workspaceRoot, runtimeRoot, skillRoots: config.skillRoots ?? [] })}`
  )
  patches.push(`- insert:\n    - id: conversation-observer\n      name: ${JSON.stringify(observer)}\n      config: {}`)
  // Optional operator-owned modules prepare REAL public Session/Tools fixtures.
  // Main must review them; they are never allowed to supply acceptance facts.
  for (const [i, path] of (config.operatorModules ?? []).entries()) {
    ensure(confined(tempRoot, path) && existsSync(path), 'FIXTURE_OPERATOR_MODULE_INVALID')
    assertPhysicalPath(path)
    patches.push(`- insert:\n    - id: conversation-operator-${i}\n      name: ${JSON.stringify(path)}\n      config: {}`)
  }
  const patchFile = join(profileDir, 'cordis.patch.yml')
  const prior = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : ''
  writeFileSync(patchFile, collectorOverlaySource(prior, patches.join('\n')), { mode: 0o600 })
  return {
    home,
    cwd,
    profile,
    profileDir,
    installedPackage,
    env,
    observerFile,
    config,
    installedInventory,
    packageManager
  }
}

export function bootHost(profile, steps, id = 'boot') {
  const args = ['--profile', profile.profile, '--host', '127.0.0.1', '--port', '0', '--no-open']
  const child = spawn(CLI, args, {
    env: profile.env,
    cwd: profile.cwd,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const step = {
    id,
    command: CLI,
    args,
    at: new Date().toISOString(),
    pid: child.pid,
    passed: false,
    exitCode: null
  }
  steps.push(step)
  const ready = new Promise((done, reject) => {
    let tail = ''
    const fail = code => {
      clearTimeout(timer)
      reject(Object.assign(new Error(code), { code }))
    }
    const timer = setTimeout(() => fail('HOST_BOOT_TIMEOUT'), 30000)
    const take = bytes => {
      tail = (tail + bytes.toString()).slice(-8192)
      const match = tail.match(/http:\/\/127\.0\.0\.1:\d+\/[^\s]*token=[A-Za-z0-9._-]+/)
      if (match) {
        clearTimeout(timer)
        tail = ''
        step.passed = true
        done(match[0])
      }
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    child.once('error', () => fail('HOST_BOOT_FAILED'))
    child.once('exit', (code, signal) => {
      step.exitCode = code
      step.signal = signal
      fail('HOST_EXITED')
    })
  })
  return { child, ready }
}
export async function stopHost(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  await new Promise((done, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(Object.assign(new Error('HOST_STOP_TIMEOUT'), { code: 'HOST_STOP_TIMEOUT' }))
    }, 5000)
    child.once('exit', () => {
      clearTimeout(timer)
      done()
    })
    child.kill('SIGTERM')
  })
}
export const PUBLIC_METHODS = Object.freeze([
  'blueprint/ping',
  'blueprint/loadDefinition',
  'blueprint/inspectSession',
  'blueprint/inspectRun',
  'blueprint/startSessionRun',
  'workspace/initializeDefault',
  'session/create',
  'session/selectModel',
  'session/prompt',
  'session/list',
  'session/page',
  'session/projections'
])
export function makeGateway(authUrl, rpc, mode, hostInstance = 1) {
  const url = new URL(authUrl)
  ensure(url.protocol === 'http:' && url.hostname === '127.0.0.1', 'HOST_GATEWAY_NOT_LOCAL')
  let cookie
  return {
    async authenticate() {
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000) })
      cookie = (response.headers.getSetCookie?.() ?? []).map(value => value.split(';')[0]).join('; ')
      ensure(cookie && [302, 303].includes(response.status), 'HOST_AUTH_FAILED')
    },
    async call(method, args) {
      ensure(PUBLIC_METHODS.includes(method), 'HOST_GATEWAY_METHOD_INVALID')
      const seed = args?.request
      ensure(
        method !== 'session/prompt' ||
          mode === 'live' ||
          (mode === 'keyless' &&
            seed?.sessionId?.startsWith('conversation-fixture-') &&
            typeof seed.requestId === 'string' &&
            seed.requestId &&
            seed.mode === 'queue' &&
            seed.content?.length === 1 &&
            seed.content[0].type === 'text' &&
            seed.content[0].text === KEYLESS_SEED_TEXT),
        'PROVIDER_KEYLESS_PROMPT_FORBIDDEN'
      )
      const rpcId = randomUUID(),
        at = new Date().toISOString()
      const response = await fetch(new URL(`/api/${method}`, url.origin), {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } })
      })
      const body = await response.json()
      const ok = response.status === 200 && body?.type === 'server-response' && body.rpcId === rpcId && body.result?.ok === true
      rpc.push({
        method,
        rpcId,
        at,
        status: response.status,
        ok,
        hostInstance,
        provenance: 'real public DSH gateway',
        responseRpcId: body?.rpcId === rpcId ? rpcId : null
      })
      ensure(ok, 'HOST_GATEWAY_RPC_FAILED')
      return body.result.value
    },
    origin: url.origin
  }
}
