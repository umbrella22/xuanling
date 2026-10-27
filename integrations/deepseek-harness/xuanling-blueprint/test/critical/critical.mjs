// N-CRITICAL suite (plan §10.2): race/resume/cancel/restore/concurrency
// cases, scoped by wave. Scope 'resources' carries the T04 fresh-read,
// deletion and change-detection races (three consecutive passes required at
// the caller: --repeat 3 on one checkout fingerprint).
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const RESOURCES_CASE_IDS = ['T04-R1', 'T04-R2', 'T04-R3']
const COORDINATOR_CASE_IDS = ['RT1', 'RT3', 'RT11']
const RESTORE_CASE_IDS = ['RC1', 'RC2', 'RC3']

export async function getCases(helpers) {
  const scope = helpers.scope ?? 'all'
  const cases = []
  if (scope === 'all' || scope === 'workspace')
    cases.push({
      id: 'T11b',
      title: 'Workspace write serialization, preimage, cancellation and recovery',
      contract: 'C-11',
      expect: 'pass',
      run: async () => {
        const result = spawnSync(
          process.execPath,
          [
            '--experimental-transform-types',
            '--import',
            './scripts/test-tsx-register.mjs',
            '--test',
            '--test-reporter=tap',
            'test/runtime/workspace-write-policy.test.mjs'
          ],
          { cwd: helpers.packageRoot, encoding: 'utf8', timeout: 60000 }
        )
        const ok = result.status === 0 && /# fail 0\b/.test(result.stdout) && /# skipped 0\b/.test(result.stdout) && /# tests [1-9]\d*/.test(result.stdout)
        return { ok, detail: ok ? result.stdout.slice(-350) : `${result.stderr}\n${result.stdout}` }
      }
    })
  if (scope === 'resources' || scope === 'all') {
    const resources = await import(join(helpers.packageRoot, 'test', 'resources', 'resources.mjs'))
    const all = await resources.getCases(helpers)
    const selected = all.filter(c => RESOURCES_CASE_IDS.includes(c.id))
    if (selected.length !== RESOURCES_CASE_IDS.length) {
      throw new Error(`critical/resources: missing race cases (${RESOURCES_CASE_IDS.join(', ')})`)
    }
    cases.push(...selected)
  }
  if (scope === 'coordinator' || scope === 'all') {
    const runtime = await import(join(helpers.packageRoot, 'test', 'runtime', 'runtime.mjs'))
    const all = await runtime.getCases(helpers)
    cases.push(...all.filter(c => COORDINATOR_CASE_IDS.includes(c.id)))
  }
  if (scope === 'restore' || scope === 'all') {
    const recovery = await import(join(helpers.packageRoot, 'test', 'recovery', 'recovery.mjs'))
    const all = await recovery.getCases({ ...helpers, scope: 'portability' })
    cases.push(...all.filter(c => RESTORE_CASE_IDS.includes(c.id)))
  }
  if (cases.length === 0) {
    throw new Error(`critical: scope "${scope}" has no registered race cases yet`)
  }
  return cases
}
