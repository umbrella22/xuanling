// Shared launch/report boundary for the browser and performance suites. Each
// invocation gets a NEW child directory, never a historical w0 fallback.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { BROWSER_ASSERTIONS, PERFORMANCE_ASSERTIONS, PERFORMANCE_BUDGET, percentile95 } from './canvas-journey.mjs'
import { fixtureEvidence, performanceDefinition } from './canvas-fixtures.mjs'

// Installation/boot/gateway/real Agent/latest Skill/guard/script/MCP assertions
// remain required alongside the new canvas assertions. UI cannot replace them.
export const HOST_ASSERTIONS = Object.freeze(['P0', 'P1a', 'P2p', 'P2a', 'P2b', 'P3a', 'P3b', 'P5a', 'P5b', 'P4a', 'P4b', 'P4f', 'P4g', 'P4m', 'P4n', 'P4o', 'P4p', 'P4q', 'P4r', 'P4s', 'P4h', 'P4i', 'P4j-raw', 'P4j', 'P4k', 'P4w', 'P4l', 'P4t', 'P4u', 'P4v', 'P6a', 'P4c2', 'P6b', 'P6c', 'P4x'])
export function requiredCanvasAssertions(mode) {
  if (!['browser', 'performance'].includes(mode)) throw new Error('unknown canvas suite')
  return [...new Set([...HOST_ASSERTIONS, ...(mode === 'browser' ? BROWSER_ASSERTIONS : PERFORMANCE_ASSERTIONS)])]
}
function confined(dir, path) {
  if (typeof path !== 'string' || !isAbsolute(path)) return false
  const rel = relative(resolve(dir), resolve(path))
  return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\')
}
export function validatePerformanceEvidence(perf, environment) {
  if (!perf || !isDeepStrictEqual(perf.budget, PERFORMANCE_BUDGET)) throw new Error('performance budget missing or changed')
  if (!isDeepStrictEqual(perf.fixture, fixtureEvidence(performanceDefinition()))) throw new Error('performance fixture/generator/hash differs from 200/300/20 contract')
  if (typeof perf.provenance !== 'string' || !perf.provenance.startsWith('real DSH closure factory')) throw new Error('performance is not attributed to the actual DSH mounted canvas')
  if (environment?.platform !== 'darwin/arm64' || !/^v\d+\./.test(environment.node ?? '') || !environment.browser_version || environment.dsh_version_output !== '0.2.1-alpha.4') throw new Error('performance machine/runtime/browser provenance missing or outside frozen environment')
  const { loadMs, paintP95Ms } = perf.measured ?? {}
  if (!Number.isFinite(loadMs) || loadMs <= 0 || loadMs > PERFORMANCE_BUDGET.loadMs) throw new Error('mounted canvas load exceeds 2000ms or is not measured')
  if (!Array.isArray(perf.samples) || perf.samples.length !== PERFORMANCE_BUDGET.interactions
    || !perf.samples.every((sample, i) => sample.index === i && sample.trusted === true
      && sample.kind === (i % 2 === 0 ? 'pan' : 'zoom') && sample.type === (i % 2 === 0 ? 'pointermove' : 'wheel')
      && Number.isFinite(sample.startMs) && Number.isFinite(sample.changeObservedAt) && sample.changeObservedAt >= sample.startMs
      && Number.isFinite(sample.latencyMs) && sample.latencyMs >= sample.changeObservedAt - sample.startMs
      && typeof sample.before === 'string' && sample.before.length > 0 && typeof sample.after === 'string' && sample.after.length > 0 && sample.before !== sample.after)) throw new Error('20 ordered trusted pointermove/wheel change-to-rAF samples are required')
  const actualP95 = percentile95(perf.samples.map(s => s.latencyMs))
  if (paintP95Ms !== actualP95 || actualP95 > PERFORMANCE_BUDGET.paintP95Ms) throw new Error('paint p95 exceeds 100ms or differs from actual samples')
  if (!Array.isArray(perf.viewports) || perf.viewports.length !== PERFORMANCE_BUDGET.interactions
    || !perf.viewports.every(v => typeof v.before === 'string' && typeof v.after === 'string' && v.before !== v.after)
    || perf.canonicalUnchanged !== true) throw new Error('pan/zoom must change viewport and leave the complete host document unchanged')
}
export function validateCanvasReport(report, { mode, planId, reportDir, packageRoot, invokedAt, finishedAt }) {
  if (report?.passed !== true || report.plan_id !== planId || report.environment?.canvas_test !== mode) throw new Error('probe failed or plan/mode mismatch')
  const started = Date.parse(report.started_at), finished = Date.parse(report.finished_at)
  if (!Number.isFinite(started) || !Number.isFinite(finished) || started < invokedAt || finished < started || finished > finishedAt) throw new Error('probe timestamps are stale or invalid')
  if (!Array.isArray(report.assertions) || report.assertions.length === 0) throw new Error('probe assertions missing')
  const ids = new Set()
  for (const a of report.assertions) {
    if (typeof a.id !== 'string' || ids.has(a.id) || a.passed !== true) throw new Error(`failed or duplicate probe assertion: ${a.id}`)
    ids.add(a.id)
  }
  const missing = requiredCanvasAssertions(mode).filter(id => !ids.has(id))
  if (missing.length) throw new Error(`required host/canvas assertions missing: ${missing.join(', ')}`)
  const screenshot = report.artifacts?.sidebar_screenshot
  const tools = report.artifacts?.host_tools_contract
  if (!confined(reportDir, screenshot) || !existsSync(screenshot)
    || !confined(join(reportDir, 'tools'), tools?.reportPath) || !existsSync(tools.reportPath)) throw new Error('screenshot/nested security evidence is not isolated in this fresh probe directory')
  const nested = JSON.parse(readFileSync(tools.reportPath, 'utf8'))
  if (tools.status !== 0 || nested.passed !== true || nested.plan_id !== planId || !isDeepStrictEqual(nested, tools.report)) throw new Error('nested tools policy report failed, stale or mismatched')
  for (const file of ['lib/index.js', 'lib/client.js', 'lib/typert.host.js']) {
    const hash = createHash('sha256').update(readFileSync(join(packageRoot, file))).digest('hex')
    if (report.artifacts?.plugin_source?.[file] !== hash) throw new Error(`probe build fingerprint differs from current ${file}`)
  }
  if (mode === 'performance') validatePerformanceEvidence(report.artifacts?.canvas_performance, report.environment)
  else if (!report.artifacts?.canvas_journey?.binding || !report.artifacts.canvas_journey.provenance?.startsWith('real DSH boot graph')) throw new Error('real mounted canvas and refresh/switch evidence missing')
  return { ok: true, detail: `${report.assertions.length} actual host/canvas assertions; isolated report: ${join(reportDir, 'w0.2-probe-report.json')}` }
}
export async function runCanvasSuite(helpers, mode) {
  requiredCanvasAssertions(mode)
  const { packageRoot, repoRoot } = helpers
  for (const file of ['lib/index.js', 'lib/client.js', 'lib/typert.host.js']) if (!existsSync(join(packageRoot, file))) throw new Error(`${file} missing — main must build first (harness absence, not behavior evidence)`)
  const parent = resolve(helpers.reportDir ?? join(repoRoot, 'docs', 'validation', 'blueprint', 'current', 'takeover'))
  const suites = join(parent, 'suites'); mkdirSync(suites, { recursive: true })
  const reportDir = mkdtempSync(join(suites, `${mode}-probe-`))
  const planId = helpers.planId ?? 'dsh-blueprint-takeover-v1'
  const probeDir = join(repoRoot, 'test', 'blueprint')
  const env = {}
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT']) if (process.env[key] !== undefined) env[key] = process.env[key]
  const invokedAt = Date.now()
  const child = spawnSync(process.execPath, [join(probeDir, 'capabilities', 'probe.mjs'),
    `--plugin-dir=${packageRoot}`, '--expect=blueprint', `--canvas-test=${mode}`,
    '--report-dir', reportDir, '--plan-id', planId], { cwd: probeDir, env, encoding: 'utf8', timeout: 20 * 60_000 })
  if (child.status !== 0 || child.signal || child.error) throw new Error(`probe process failed (exit ${child.status}, signal ${child.signal}): ${child.error?.message ?? String(child.stderr).slice(0, 300)}; isolated report: ${reportDir}`)
  const reportPath = join(reportDir, 'w0.2-probe-report.json')
  if (!existsSync(reportPath)) throw new Error(`probe produced no fresh report: ${reportPath}`)
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  return validateCanvasReport(report, { mode, planId, reportDir, packageRoot, invokedAt, finishedAt: Date.now() })
}
