// N-FOUNDATION suite: the runner's own calibration, the safety helpers, and
// the scaffold's public seam. These are harness contracts (C-18): a red that
// is really a module/compile error, a silently skipped case, or an undefined
// resolution must all fail this suite.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export async function getCases(helpers) {
  const { runCases, makeIsolatedHome, assertAllowedNpmCwd, scanForSecrets, packageRoot, repoRoot } = helpers
  const cases = []

  // ── runner classification meta-tests ────────────────────────────────────
  cases.push({
    id: 'F1', title: 'runner classifies a passing case as pass', expect: 'pass',
    run: async () => {
      const [r] = await runCases([{ id: 'synth', title: 'synthetic pass', expect: 'pass', run: async () => ({ ok: true }) }])
      return r.status === 'pass'
    },
  })
  cases.push({
    id: 'F2', title: 'runner treats undefined/false resolution as no-evidence, not a pass', expect: 'pass',
    run: async () => {
      const [a] = await runCases([{ id: 's-undef', title: 'undefined', expect: 'pass', run: async () => undefined }])
      const [b] = await runCases([{ id: 's-false', title: 'false', expect: 'pass', run: async () => false }])
      return a.status === 'fail' && b.status === 'fail'
    },
  })
  cases.push({
    id: 'F3', title: 'runner records expected-red only for the exact named failure', expect: 'pass',
    run: async () => {
      const [a] = await runCases([{ id: 's-red', title: 'exact red', expect: 'red', redCode: 'x/y', run: async () => { const e = new Error('boom'); e.code = 'x/y'; throw e } }])
      return a.status === 'expected-red'
    },
  })
  cases.push({
    id: 'F4', title: 'runner rejects a wrong red failure and an unexpected green', expect: 'pass',
    run: async () => {
      const [wrong] = await runCases([{ id: 's-wrong', title: 'wrong code', expect: 'red', redCode: 'x/y', run: async () => { const e = new TypeError('module missing'); throw e } }])
      const [green] = await runCases([{ id: 's-green', title: 'unexpected green', expect: 'red', redCode: 'x/y', run: async () => 'should not happen' }])
      return wrong.status === 'fail' && green.status === 'fail'
        && wrong.detail.includes('wrong failure') && green.detail.includes('unexpected green')
    },
  })

  // ── scaffold public seam (built lib, not sources) ───────────────────────
  const libIndex = join(packageRoot, 'lib', 'index.js')
  const libTypert = join(packageRoot, 'lib', 'typert.host.js')
  cases.push({
    id: 'F5', title: 'built lib exposes the service and typert wire surface', expect: 'pass',
    run: async () => {
      if (!existsSync(libIndex) || !existsSync(libTypert)) {
        throw new Error('lib/index.js or lib/typert.host.js missing — run `npm run build` first (build absence is a harness failure, not test evidence)')
      }
      const mod = await import(libIndex)
      const typert = await import(libTypert)
      const { default: assert } = await import('node:assert/strict')
      const methods = typert.TYPERT.invocations.map(i => i.method).sort()
      const expected = [
        'cancelRun', 'decide', 'exportDefinition', 'hostProbe', 'importDefinition', 'inspectRun',
        'listDefinitions', 'loadDefinition', 'mcpProbe', 'ping', 'preflightRun', 'saveDefinition', 'startRun', 'validate',
      ]
      assert.equal(typeof mod.default, 'function', 'built service default export must be a function')
      assert.equal(typert.TYPERT.face, 'host', 'built wire descriptor must expose the host face')
      assert.deepEqual(methods, expected, 'public wire must have exactly the contracted methods, with no missing, duplicate or extra methods')
      for (const invocation of typert.TYPERT.invocations) {
        assert.equal(invocation.result?.mode, 'strict', `${invocation.method} result codec must be strict`)
        assert.equal(typeof invocation.result?.create, 'function', `${invocation.method} result codec must provide create`)
      }
      return true
    },
  })
  cases.push({
    id: 'F6', title: 'service ping returns build metadata on a plain cordis context', expect: 'pass',
    run: async () => {
      const { Context } = await import('@deepseek-ai/cordis')
      const mod = await import(libIndex)
      const service = new mod.default(new Context())
      const value = await service.ping()
      return value?.status === 'ok' && value?.service === '@xuanling-rs/xuanling-dsh-blueprint' && value?.version === '0.0.1'
    },
  })

  // ── safety helpers ───────────────────────────────────────────────────────
  cases.push({
    id: 'F7', title: 'isolated home helper builds a disposable env and cleans up', expect: 'pass',
    run: async () => {
      const home = makeIsolatedHome('foundation-f7')
      try {
        const under = Object.values(home.env).every(p => p.startsWith(home.root))
        const existsBefore = existsSync(join(home.env.DSH_HOME))
        home.cleanup()
        return under && existsBefore && !existsSync(home.root)
      } finally {
        home.cleanup()
      }
    },
  })
  cases.push({
    id: 'F8', title: 'npm cwd guard admits package roots and rejects the repo root', expect: 'pass',
    run: async () => {
      let rejected = false
      try {
        assertAllowedNpmCwd(repoRoot)
      } catch {
        rejected = true
      }
      assertAllowedNpmCwd(packageRoot)
      return rejected
    },
  })
  cases.push({
    id: 'F9', title: 'secret canary scanner detects planted credentials and passes clean text', expect: 'pass',
    run: async () => {
      const dirty = scanForSecrets('token BP_SECRET_CANARY and sk-abcdefghijklmnopqrstuvwx inside')
      const clean = scanForSecrets('ordinary evidence text with no credentials')
      return dirty.includes('bp-canary') && dirty.includes('openai-key') && clean.length === 0
    },
  })

  // ── pack basics (C-17 seam; full pack gate is W8) ────────────────────────
  cases.push({
    id: 'F10', title: 'dry-run pack ships only delivery files (no src/test/scripts)', expect: 'pass',
    run: async () => {
      assertAllowedNpmCwd(packageRoot)
      const res = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: packageRoot, encoding: 'utf8', timeout: 120_000 })
      if (res.status !== 0) throw new Error(`npm pack --dry-run failed: ${res.stderr.slice(0, 200)}`)
      const packed = JSON.parse(res.stdout)[0]
      const paths = packed.files.map(f => f.path)
      const required = ['package.json', 'cordis.patch.yml', 'LICENSE', 'README.md', 'lib/index.js', 'lib/client.js', 'lib/typert.host.js']
      const forbidden = paths.filter(p => p.startsWith('src/') || p.startsWith('test/') || p.startsWith('scripts/') || p === 'tsdown.config.ts' || p === 'tsconfig.json')
      const missing = required.filter(p => !paths.includes(p))
      if (missing.length > 0 || forbidden.length > 0) {
        throw new Error(`pack content mismatch — missing: ${missing.join(', ')}; forbidden: ${forbidden.join(', ')}`)
      }
      return { ok: true, files: paths.length }
    },
  })

  return cases
}
