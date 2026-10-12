// Direct published-peer regressions against Main-built bytes. Only declared
// peers are exposed to the packed host, using installed public packages as
// dependency fixtures. No closure copy/resolver, build, or DSH CLI boot.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { hasPnpmImporterDependency, readPnpmLock } from './pnpm-lock.mjs'

const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const VERSION = '0.2.1-alpha.2'
const REQUIRED = [
  '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-storage', '@deepseek-ai/dsh-storage-domain',
  '@deepseek-ai/dsh-storage-json', '@deepseek-ai/dsh-storage-sqlite',
]
const SOURCE_FILES = [
  'src/index.ts', 'src/conversation/host-tools.ts', 'src/conversation/native-session-lineage.ts',
  'src/host/agent-executor.ts', 'src/persistence/domain.ts',
]
const json = path => JSON.parse(readFileSync(path, 'utf8'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

function imports(source) {
  const entries = []
  for (const match of source.matchAll(/^(?:import|export)\s+(?!type\b)(?:[^'";]*?\bfrom\s+)?['"]([^'"]+)['"]/gm)) {
    entries.push({ name: match[1], kind: 'static' })
  }
  for (const match of source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) entries.push({ name: match[1], kind: 'dynamic' })
  return entries
}

const external = name => name.startsWith('@deepseek-ai/') || name === 'zod'
const packageName = name => name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name

test('all six public runtime peers have fixed required declarations and matching lock metadata', () => {
  const manifest = json(join(PACKAGE_ROOT, 'package.json')), lock = readPnpmLock(PACKAGE_ROOT)
  assert.deepEqual(REQUIRED.filter(name => manifest.peerDependencies[name] !== VERSION), [], 'Missing fixed public runtime peers')
  for (const name of REQUIRED) {
    assert.notEqual(manifest.peerDependenciesMeta?.[name]?.optional, true)
    assert.equal(hasPnpmImporterDependency(lock, 'devDependencies', name, VERSION), true, `${name}: pnpm importer version drift`)
  }
})

test('fresh packed host imports and its static/dynamic externals have published peer coverage', t => {
  assert.ok(existsSync(join(PACKAGE_ROOT, 'lib/index.js')), 'Main-built artifact required; the test never builds')
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bp-packed-peers-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'home'))
  writeFileSync(join(root, 'empty.npmrc'), '')
  writeFileSync(join(root, 'empty-global.npmrc'), '')
  const env = { HOME: join(root, 'home'), NPM_CONFIG_CACHE: join(root, 'cache'),
    NPM_CONFIG_USERCONFIG: join(root, 'empty.npmrc'), NPM_CONFIG_GLOBALCONFIG: join(root, 'empty-global.npmrc') }
  for (const name of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT']) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  const argv = ['pack', '--ignore-scripts', '--offline', '--json', '--pack-destination', root]
  const packed = spawnSync('npm', argv, { cwd: PACKAGE_ROOT, env, encoding: 'utf8' })
  assert.equal(packed.status, 0, `pack failed: ${packed.error?.message ?? packed.stderr}`)
  const [{ filename }] = JSON.parse(packed.stdout)
  const extracted = spawnSync('tar', ['-xzf', join(root, filename), '-C', root], { cwd: root, env, encoding: 'utf8' })
  assert.equal(extracted.status, 0, `extract failed: ${extracted.error?.message ?? extracted.stderr}`)
  const plugin = join(root, 'package'), manifest = json(join(plugin, 'package.json'))
  assert.equal(manifest.name, '@xuanling-rs/xuanling-dsh-blueprint')
  assert.ok(!existsSync(join(plugin, 'src')))
  assert.equal(readFileSync(join(plugin, 'lib/index.js'), 'utf8'), readFileSync(join(PACKAGE_ROOT, 'lib/index.js'), 'utf8'))
  const devRequire = createRequire(join(PACKAGE_ROOT, 'package.json'))
  for (const name of Object.keys(manifest.peerDependencies)) {
    const link = join(plugin, 'node_modules', name)
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(dirname(devRequire.resolve(`${name}/package.json`)), link, 'junction')
  }
  assert.ok(!existsSync(join(root, 'node_modules')), 'No development-tree hoisting at the packed host anchor')
  const script = join(root, 'import-host.mjs')
  writeFileSync(script, `
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
try {
  const require = createRequire(${JSON.stringify(join(plugin, 'package.json'))})
  const host = await import(pathToFileURL(require.resolve('.')).href)
  assert.equal(typeof host.default, 'function')
  assert.equal(typeof host.default.prototype.startSessionRun, 'function')
  assert.equal(typeof host.default.prototype.inspectSession, 'function')
  const resolved = ${JSON.stringify(REQUIRED)}.map(name => ({ name, entry: require.resolve(name) }))
  process.stdout.write(JSON.stringify({ ok: true, resolved: resolved.map(item => item.name) }) + '\\n')
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: error.code, message: error.message }) + '\\n')
  process.exitCode = 1
}
`)
  const imported = spawnSync(process.execPath, [script], { cwd: root, env, encoding: 'utf8' })
  t.diagnostic(JSON.stringify({ operation: 'packed-host-import', argv: ['npm', ...argv], packExit: packed.status,
    tarballSha256: hash(readFileSync(join(root, filename))), result: imported.stdout.trim(),
    dependencyFixtures: 'declared peers only; existing public packages', build: false, dshCli: false, keyRead: false, providerCalls: 0 }))
  assert.equal(imported.status, 0, imported.stdout || imported.stderr || imported.error?.message)
  assert.deepEqual(JSON.parse(imported.stdout), { ok: true, resolved: REQUIRED })

  const emitted = [], visited = new Set()
  const visit = path => {
    if (visited.has(path)) return
    visited.add(path)
    for (const entry of imports(readFileSync(path, 'utf8'))) {
      if (entry.name.startsWith('.')) visit(resolve(dirname(path), entry.name))
      else if (external(entry.name)) emitted.push(entry)
    }
  }
  visit(join(plugin, 'lib/index.js'))
  const source = SOURCE_FILES.flatMap(path => imports(readFileSync(join(PACKAGE_ROOT, path), 'utf8'))).filter(entry => external(entry.name))
  for (const inventory of [source, emitted]) {
    for (const name of REQUIRED) {
      assert.ok(inventory.some(entry => entry.name === name), `Actual runtime inventory must contain ${name}`)
      if (name.startsWith('@deepseek-ai/dsh-storage')) {
        assert.ok(inventory.some(entry => entry.name === name && entry.kind === 'dynamic'), `Dynamic backend import ${name} must be covered`)
      }
    }
    assert.deepEqual([...new Set(inventory.map(entry => packageName(entry.name)))].filter(name => !Object.hasOwn(manifest.peerDependencies, name)).sort(), [],
      'Runtime external imports must not rely on development dependencies or transitive hoisting')
  }
  t.diagnostic(JSON.stringify({ sourceExternals: [...new Set(source.map(entry => entry.name))].sort(),
    emittedExternals: [...new Set(emitted.map(entry => entry.name))].sort(), visitedHostChunks: visited.size }))
})
