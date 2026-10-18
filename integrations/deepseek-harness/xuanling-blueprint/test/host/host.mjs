// N-HOST suite (W4): host-path contracts verified against a REAL isolated
// DSH profile. The suite drives the external mount probe (probe.mjs
// --expect=blueprint), which packs this package, installs it into a fresh
// profile, boots the real web app, and asserts: gateway ping, typed
// capability-unavailable, scoped agent execution from frozen snapshot bytes
// (P4h/P4i) public diagnostic-probe removal evidence. Missing build or a
// failed probe exits non-zero — never a skip.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export async function getCases(helpers) {
  const { packageRoot, repoRoot } = helpers
  const cases = []

  cases.push({
    id: 'H1',
    title: 'T05/T14: real-profile mount probe passes end to end (install, boot, gateway, scoped agent)',
    contract: 'C-05',
    expect: 'pass',
    run: async () => {
      const probeDir = join(repoRoot, 'test', 'blueprint')
      const parentDir = helpers.reportDir ?? join(repoRoot, 'docs', 'validation', 'blueprint', 'current', 'takeover', 'w2', 'host')
      mkdirSync(parentDir, { recursive: true })
      const reportDir = mkdtempSync(join(parentDir, 'host-probe-'))
      const reportPath = join(reportDir, 'w0.2-probe-report.json')
      const planId = helpers.planId ?? 'dsh-blueprint-plugin-v1'
      if (!existsSync(join(packageRoot, 'lib', 'index.js'))) {
        throw new Error('lib missing — run `pnpm run build` first (build absence is a harness failure)')
      }
      const res = spawnSync(
        process.execPath,
        [join(probeDir, 'capabilities', 'probe.mjs'), `--plugin-dir=${packageRoot}`, '--expect=blueprint', '--report-dir', reportDir, '--plan-id', planId],
        { cwd: probeDir, encoding: 'utf8', timeout: 15 * 60_000 }
      )
      if (res.status !== 0 || res.signal || res.error) {
        throw new Error(`probe process failed (exit ${res.status}, signal ${res.signal}): ${res.error?.message ?? String(res.stderr).slice(0, 300)}`)
      }
      if (!existsSync(reportPath)) {
        throw new Error(`probe produced no report (exit ${res.status}): ${String(res.stderr).slice(0, 300)}`)
      }
      const report = JSON.parse(readFileSync(reportPath, 'utf8'))
      if (report.passed !== true || report.plan_id !== planId || !Array.isArray(report.assertions) || report.assertions.some(a => a.passed !== true)) {
        const failed = (Array.isArray(report.assertions) ? report.assertions : []).filter(a => !a.passed).map(a => a.id)
        throw new Error(`probe failed or plan-id mismatch (${report.plan_id}): ${failed.join(', ')}`)
      }
      const assertions = Object.fromEntries((report.assertions ?? []).map(a => [a.id, a.passed === true]))
      // Host-surface evidence (P4h/P4i live in the probe report).
      return ['P4h', 'P4i', 'P4f', 'P4j-raw', 'P4j', 'P4k', 'P4w'].every(id => assertions[id] === true)
        ? { ok: true, detail: `${report.assertions.length} probe assertions passed; isolated report: ${reportPath}` }
        : { ok: false, detail: 'probe passed but host-execution assertions are missing' }
    }
  })

  return cases
}
