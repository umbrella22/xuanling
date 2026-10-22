// Direct published-peer regressions against Main-built bytes. Only declared
// peers are exposed to the packed host, using installed public packages as
// dependency fixtures. No closure copy/resolver, build, or DSH CLI boot.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { evaluatePluginCompatibility } from '@deepseek-ai/dsh-app-boot'
import { parseAst } from 'vite/rolldown/parseAst'
import { hasPnpmImporterDependency, readPnpmLock } from './pnpm-lock.mjs'

const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const VERSION = '0.2.1-rc.2'
const MINIMUM_RANGE = '>=0.2.1-alpha.5'
const REQUIRED = ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session']
const SOURCE_FILES = [
  'src/index.ts',
  'src/conversation/host-tools.ts',
  'src/conversation/native-session-lineage.ts',
  'src/host/agent-executor.ts',
  'src/persistence/domain.ts'
]
const json = path => JSON.parse(readFileSync(path, 'utf8'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

function imports(source, filename = 'runtime.mjs') {
  const entries = []
  const normalized = filename.endsWith('.ts') ? stripTypeScriptTypes(source, { mode: 'transform' }) : source
  const ast = parseAst(normalized, undefined, filename)
  for (const node of ast.body) {
    if ((node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') && node.source?.value) {
      entries.push({ name: node.source.value, kind: 'static' })
    }
  }
  const literalValue = node => {
    if (node?.type === 'Literal' && typeof node.value === 'string') return node.value
    if (node?.type === 'TemplateLiteral' && node.expressions.length === 0 && node.quasis.length === 1) return node.quasis[0].value.cooked
    return undefined
  }
  const visit = node => {
    if (!node || typeof node !== 'object') return
    if (node.type === 'ImportExpression') {
      const name = literalValue(node.source)
      if (name !== undefined) entries.push({ name, kind: 'dynamic' })
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit)
      else if (value && typeof value === 'object') visit(value)
    }
  }
  visit(ast)
  return entries
}

const external = name => name.startsWith('@deepseek-ai/') || name === 'zod'
const packageName = name => (name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name)

test('public runtime peers declare a minimum while development dependencies stay reproducible', () => {
  const manifest = json(join(PACKAGE_ROOT, 'package.json')),
    lock = readPnpmLock(PACKAGE_ROOT)
  assert.deepEqual(
    Object.keys(manifest.peerDependencies).filter(name => name.startsWith('@deepseek-ai/dsh') && manifest.peerDependencies[name] !== MINIMUM_RANGE),
    [],
    'DSH public peers must expose the supported minimum, not an exact development tuple'
  )
  for (const [root, section] of [
    [PACKAGE_ROOT, 'devDependencies'],
    [resolve(PACKAGE_ROOT, '../../../test/blueprint'), 'dependencies']
  ]) {
    const development = json(join(root, 'package.json'))
    const developmentLock = readPnpmLock(root)
    for (const [name, version] of Object.entries(development[section]).filter(([name]) => name.startsWith('@deepseek-ai/dsh'))) {
      assert.equal(version, VERSION, `${name}: reproducible development version`)
      assert.equal(hasPnpmImporterDependency(developmentLock, section, name, VERSION), true, `${name}: lock importer drift`)
    }
  }
  for (const name of REQUIRED) {
    assert.equal(manifest.peerDependencies[name], MINIMUM_RANGE, `${name}: required public peer missing or range drift`)
    assert.notEqual(manifest.peerDependenciesMeta?.[name]?.optional, true)
    assert.equal(hasPnpmImporterDependency(lock, 'devDependencies', name, VERSION), true, `${name}: pnpm importer version drift`)
  }
})

test('real DSH compatibility preflight rejects below the minimum and accepts equal or newer runtimes', () => {
  const manifest = json(join(PACKAGE_ROOT, 'package.json'))
  for (const version of ['0.2.0-rc.2', '0.2.0', '0.2.1-alpha.4']) {
    const issue = evaluatePluginCompatibility(manifest, {}, version)
    assert.ok(issue, `${version} must be rejected`)
    assert.equal(issue.exempted, false)
    assert.ok(Object.keys(issue.requirements).length > 0)
  }
  for (const version of ['0.2.1-alpha.5', '0.2.1-alpha.6', '0.2.1-alpha.10', '0.2.1-rc.1', '0.2.1', '0.2.2-alpha.1', '0.3.0', '1.0.0']) {
    assert.equal(evaluatePluginCompatibility(manifest, {}, version), undefined, `${version} must satisfy the minimum`)
  }
})

test('fresh packed host imports and its static/dynamic externals have published peer coverage', t => {
  assert.ok(existsSync(join(PACKAGE_ROOT, 'lib/index.js')), 'Main-built artifact required; the test never builds')
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bp-packed-peers-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'home'))
  writeFileSync(join(root, 'empty.npmrc'), '')
  writeFileSync(join(root, 'empty-global.npmrc'), '')
  const env = {
    HOME: join(root, 'home'),
    NPM_CONFIG_CACHE: join(root, 'cache'),
    NPM_CONFIG_USERCONFIG: join(root, 'empty.npmrc'),
    NPM_CONFIG_GLOBALCONFIG: join(root, 'empty-global.npmrc')
  }
  for (const name of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT']) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  const argv = ['pack', '--ignore-scripts', '--offline', '--json', '--pack-destination', root]
  const packed = spawnSync('npm', argv, { cwd: PACKAGE_ROOT, env, encoding: 'utf8' })
  assert.equal(packed.status, 0, `pack failed: ${packed.error?.message ?? packed.stderr}`)
  const [{ filename }] = JSON.parse(packed.stdout)
  const extracted = spawnSync('tar', ['-xzf', join(root, filename), '-C', root], { cwd: root, env, encoding: 'utf8' })
  assert.equal(extracted.status, 0, `extract failed: ${extracted.error?.message ?? extracted.stderr}`)
  const plugin = join(root, 'package'),
    manifest = json(join(plugin, 'package.json'))
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
  writeFileSync(
    script,
    `
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
`
  )
  const imported = spawnSync(process.execPath, [script], { cwd: root, env, encoding: 'utf8' })
  t.diagnostic(
    JSON.stringify({
      operation: 'packed-host-import',
      argv: ['npm', ...argv],
      packExit: packed.status,
      tarballSha256: hash(readFileSync(join(root, filename))),
      result: imported.stdout.trim(),
      dependencyFixtures: 'declared peers only; existing public packages',
      build: false,
      dshCli: false,
      keyRead: false,
      providerCalls: 0
    })
  )
  assert.equal(imported.status, 0, imported.stdout || imported.stderr || imported.error?.message)
  assert.deepEqual(JSON.parse(imported.stdout), { ok: true, resolved: REQUIRED })

  const emitted = [],
    visited = new Set()
  const visit = path => {
    if (visited.has(path)) return
    visited.add(path)
    for (const entry of imports(readFileSync(path, 'utf8'), path)) {
      if (entry.name.startsWith('.')) visit(resolve(dirname(path), entry.name))
      else if (external(entry.name)) emitted.push(entry)
    }
  }
  visit(join(plugin, 'lib/index.js'))
  const source = SOURCE_FILES.flatMap(path => imports(readFileSync(join(PACKAGE_ROOT, path), 'utf8'), path)).filter(entry => external(entry.name))
  for (const inventory of [source, emitted]) {
    for (const name of REQUIRED) {
      assert.ok(
        inventory.some(entry => entry.name === name),
        `Actual runtime inventory must contain ${name}`
      )
    }
    assert.deepEqual(
      [...new Set(inventory.map(entry => packageName(entry.name)))].filter(name => !Object.hasOwn(manifest.peerDependencies, name)).sort(),
      [],
      'Runtime external imports must not rely on development dependencies or transitive hoisting'
    )
  }
  t.diagnostic(
    JSON.stringify({
      sourceExternals: [...new Set(source.map(entry => entry.name))].sort(),
      emittedExternals: [...new Set(emitted.map(entry => entry.name))].sort(),
      visitedHostChunks: visited.size
    })
  )
})
