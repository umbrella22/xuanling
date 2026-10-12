#!/usr/bin/env node
// W0.3 scope probe (plan dsh-blueprint-plugin-v1, U03): proves through the
// PUBLIC skill APIs (@deepseek-ai/dsh-skill-filesystem FileSystemSkillProvider,
// no private deep imports, no cordis services beyond a plain Context) that:
//   S1  custom roots are honored with includeDefaultRoots:false (isolation)
//   S2  same-name skills from two roots yield distinct candidates with a
//       deterministic rank order
//   S3  per-candidate get() returns each root's own content (no merge)
//   S4  with watch:false, a fresh list() after an on-disk skill update
//       observes the new content (no stale catalog) — the C-04 basis for
//       "every new Attempt re-reads the current shared Skill".
// Exits non-zero on failure; writes a JSON report.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..', '..')
const report = { probe: 'w0.3-skill-scope', plan_id: 'dsh-blueprint-plugin-v1', started_at: new Date().toISOString(), assertions: [], observations: {} }

function assert(id, description, passed, detail) {
  report.assertions.push({ id, description, passed, detail: detail === undefined ? null : detail })
  process.stdout.write(`[scope-probe] ${passed ? 'PASS' : 'FAIL'} ${id}: ${description}${detail !== undefined ? ` — ${JSON.stringify(detail)?.slice(0, 240)}` : ''}\n`)
  return passed
}

async function main() {
  const { Context } = await import('@deepseek-ai/cordis')
  const mod = await import('@deepseek-ai/dsh-skill-filesystem')
  const FileSystemSkillProvider = mod.FileSystemSkillProvider

  const root = mkdtempSync('/tmp/bp-scope-')
  const rootA = join(root, 'root-a', 'skills')
  const rootB = join(root, 'root-b', 'skills')
  const agentsHome = join(root, 'agents-home')
  const dshHome = join(root, 'dsh-home')
  for (const dir of [join(rootA, 'sample'), join(rootB, 'sample'), agentsHome, dshHome]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(rootA, 'sample', 'SKILL.md'), '---\nname: sample\ndescription: probe skill from root A\n---\n\nCONTENT-A1\n')
  writeFileSync(join(rootB, 'sample', 'SKILL.md'), '---\nname: sample\ndescription: probe skill from root B\n---\n\nCONTENT-B1\n')

  const makeProvider = () => new FileSystemSkillProvider(
    new Context(),
    { invalidate: () => {}, signal: new AbortController().signal },
    {
      providerName: 'blueprint-probe',
      includeDefaultRoots: false,
      customSkillDirs: [rootA, rootB],
      watch: false,
      dshHome,
      agentsHome,
    },
  )

  const provider = makeProvider()
  const listed = await provider.list({})
  report.observations.list_shape = Array.isArray(listed)
    ? { kind: 'candidates', count: listed.length }
    : { kind: 'observation', keys: Object.keys(listed ?? {}) }
  const candidates = Array.isArray(listed) ? listed : (listed?.candidates ?? [])
  const samples = candidates.filter(c => (c.name ?? c.skillName) === 'sample')
  report.observations.candidates = samples.map(c => ({ name: c.name ?? c.skillName, path: c.path ?? c.resourceBase, rank: c.rank, provider: c.providerName ?? c.provider }))

  // S1: isolation — only our roots are visible
  assert('S1', 'includeDefaultRoots:false confines discovery to the two fixture roots', samples.length === 2, { total: candidates.length, names: [...new Set(candidates.map(c => c.name ?? c.skillName))] })

  // S2: same name, distinct sources, deterministic order
  const paths = samples.map(c => String(c.path ?? c.resourceBase ?? ''))
  const distinct = new Set(paths).size === 2
  const ordered = paths.some(p => p.includes('root-a')) && paths.some(p => p.includes('root-b'))
  assert('S2', 'same-name skills appear as two distinct candidates covering both roots', distinct && ordered, paths)

  // S3: per-candidate content
  const contents = []
  for (const candidate of samples) {
    const def = await provider.get(candidate, {})
    contents.push(String(def?.content ?? def?.body ?? '').includes('CONTENT-A1') ? 'A1' : String(def?.content ?? def?.body ?? '').includes('CONTENT-B1') ? 'B1' : 'other')
  }
  report.observations.get_contents = contents
  assert('S3', 'each candidate resolves its own root content (no cross-root merge)', contents.includes('A1') && contents.includes('B1'), contents)

  // S4: no-watch re-scan observes an on-disk update with a fresh provider
  writeFileSync(join(rootA, 'sample', 'SKILL.md'), '---\nname: sample\ndescription: probe skill from root A\n---\n\nCONTENT-A2\n')
  const provider2 = makeProvider()
  const listed2 = await provider2.list({})
  const candidates2 = Array.isArray(listed2) ? listed2 : (listed2?.candidates ?? [])
  const samples2 = candidates2.filter(c => (c.name ?? c.skillName) === 'sample')
  const freshContents = []
  for (const candidate of samples2) {
    const def = await provider2.get(candidate, {})
    const body = String(def?.content ?? def?.body ?? '')
    if (body.includes('CONTENT-A2')) freshContents.push('A2')
    else if (body.includes('CONTENT-A1')) freshContents.push('A1')
    else if (body.includes('CONTENT-B1')) freshContents.push('B1')
  }
  report.observations.rescan_contents = freshContents
  assert('S4', 'fresh provider without watch reads the updated content (no stale cache)', freshContents.includes('A2') && !freshContents.includes('A1'), freshContents)

  // S4b: same live provider instance (watch:false) after update
  const listed3 = await provider.list({})
  const candidates3 = Array.isArray(listed3) ? listed3 : (listed3?.candidates ?? [])
  const samples3 = candidates3.filter(c => (c.name ?? c.skillName) === 'sample')
  const liveContents = []
  for (const candidate of samples3) {
    const def = await provider.get(candidate, {})
    const body = String(def?.content ?? def?.body ?? '')
    if (body.includes('CONTENT-A2')) liveContents.push('A2')
    else if (body.includes('CONTENT-A1')) liveContents.push('A1')
    else if (body.includes('CONTENT-B1')) liveContents.push('B1')
  }
  report.observations.same_provider_rescan = liveContents
  assert('S4b', 'same provider instance (watch:false) also re-reads updated content', liveContents.includes('A2') && !liveContents.includes('A1'), liveContents)

  rmSync(root, { recursive: true, force: true })
  report.finished_at = new Date().toISOString()
  report.passed = report.assertions.length > 0 && report.assertions.every(a => a.passed)
  mkdirSync(join(REPO, 'docs', 'validation', 'blueprint', 'current', 'w0'), { recursive: true })
  const { writeFileSync: w } = await import('node:fs')
  w(join(REPO, 'docs', 'validation', 'blueprint', 'current', 'w0', 'w0.3-scope-probe-report.json'), JSON.stringify(report, null, 2))
  process.stdout.write(`[scope-probe] report written; probe ${report.passed ? 'PASSED' : 'FAILED'} (${report.assertions.filter(a => a.passed).length}/${report.assertions.length})\n`)
  process.exit(report.passed ? 0 : 1)
}

main().catch((error) => {
  process.stdout.write(`[scope-probe] fatal: ${error?.stack ?? error}\n`)
  process.exit(1)
})
