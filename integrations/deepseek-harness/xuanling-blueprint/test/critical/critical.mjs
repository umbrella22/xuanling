// N-CRITICAL suite (plan §10.2): race/resume/cancel/restore/concurrency
// cases, scoped by wave. Scope 'resources' carries the T04 fresh-read,
// deletion and change-detection races (three consecutive passes required at
// the caller: --repeat 3 on one checkout fingerprint).
import { join } from 'node:path'

const RESOURCES_CASE_IDS = ['T04-R1', 'T04-R2', 'T04-R3']
const COORDINATOR_CASE_IDS = ['RT1', 'RT3', 'RT11']
const RESTORE_CASE_IDS = ['RC1', 'RC2', 'RC3']

export async function getCases(helpers) {
  const scope = helpers.scope ?? 'all'
  const cases = []
  if (scope === 'resources' || scope === 'all') {
    const resources = await import(join(helpers.packageRoot, 'test', 'resources', 'resources.mjs'))
    const all = await resources.getCases(helpers)
    cases.push(...all.filter(c => RESOURCES_CASE_IDS.includes(c.id)))
    if (cases.length !== RESOURCES_CASE_IDS.length) {
      throw new Error(`critical/resources: missing race cases (${RESOURCES_CASE_IDS.join(', ')})`)
    }
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
