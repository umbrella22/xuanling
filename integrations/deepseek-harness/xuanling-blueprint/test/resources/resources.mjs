// N-RESOURCES suite (W2.2): T03 (logical roots, no links, no merging) and
// T04 (fresh reads per attempt, deletion, change detection) against the
// built lib/resources.js seam. Shared skills resolve through the explicit
// rootId mapping — no default winner, no symlinks, no machine paths stored.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function fixtureRoots() {
  const root = mkdtempSync('/tmp/bp-resources-')
  const rootA = join(root, 'root-a', 'skills')
  const rootB = join(root, 'root-b', 'skills')
  const blueprintRoot = join(root, 'blueprint')
  for (const dir of [join(rootA, 'sample'), join(rootA, 'sample', 'scripts'), join(rootB, 'sample'), blueprintRoot]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(rootA, 'sample', 'SKILL.md'), '---\nname: sample\ndescription: A\n---\nCONTENT-A1\n')
  writeFileSync(join(rootA, 'sample', 'scripts', 'run.sh'), 'echo a1\n')
  writeFileSync(join(rootB, 'sample', 'SKILL.md'), '---\nname: sample\ndescription: B\n---\nCONTENT-B1\n')
  return { root, rootA, rootB, blueprintRoot }
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true })
}

function hasSymlinkSomewhere(dir) {
  const walk = (d) => readdirSync(d, { withFileTypes: true }).some(e => e.isSymbolicLink() || (e.isDirectory() && walk(join(d, e.name))))
  return existsSync(dir) && walk(dir)
}

export async function getCases(helpers) {
  const { packageRoot } = helpers
  const res = await import(join(packageRoot, 'lib', 'resources.js'))
  const admission = await import(join(packageRoot, 'lib', 'resource-admission.js'))
  const cases = []

  const refFor = (rootId, path = 'sample') => ({ kind: 'skill', source: { kind: 'shared', rootId, path } })
  const ctxFor = (fixture) => ({
    blueprintRoot: fixture.blueprintRoot,
    roots: [
      { rootId: 'root-a', rootPath: fixture.rootA },
      { rootId: 'root-b', rootPath: fixture.rootB },
    ],
  })

  cases.push({
    id: 'T03-R1', title: 'T03: same-name skills resolve per explicit rootId; roots stay distinct', contract: 'C-03', expect: 'pass',
    run: async () => {
      const fixture = fixtureRoots()
      try {
        const a = await res.resolveResource('skillA', refFor('root-a'), ctxFor(fixture))
        const b = await res.resolveResource('skillB', refFor('root-b'), ctxFor(fixture))
        if (a.kind !== 'shared-skill' || b.kind !== 'shared-skill') return { ok: false, detail: 'unexpected resolution kinds' }
        return a.skillDir.includes('root-a') && b.skillDir.includes('root-b') && a.skillDir !== b.skillDir
      } finally {
        cleanup(fixture.root)
      }
    },
  })

  cases.push({
    id: 'T03-R2', title: 'T03: unbound rootId fails typed (explicit bind required, no default winner)', contract: 'C-03', expect: 'pass',
    run: async () => {
      const fixture = fixtureRoots()
      try {
        try {
          await res.resolveResource('skillX', refFor('no-such-root'), ctxFor(fixture))
          return { ok: false, detail: 'expected RESOURCE_UNAVAILABLE' }
        } catch (error) {
          return error?.code === 'RESOURCE_UNAVAILABLE' && String(error.message).includes('no-such-root')
        }
      } finally {
        cleanup(fixture.root)
      }
    },
  })

  cases.push({
    id: 'T03-R3', title: 'T03: resolution and snapshot create no symlinks or junctions anywhere', contract: 'C-03', expect: 'pass',
    run: async () => {
      const fixture = fixtureRoots()
      try {
        const resolution = await res.resolveResource('skillA', refFor('root-a'), ctxFor(fixture))
        res.snapshotDirectory(resolution.skillDir, { kind: 'shared-skill', rootId: resolution.rootId, skillDir: resolution.skillDir, skillName: resolution.skillName })
        return !hasSymlinkSomewhere(fixture.root)
      } finally {
        cleanup(fixture.root)
      }
    },
  })

  cases.push({
    id: 'T04-R1', title: 'T04: a new snapshot after a shared-skill update reads the NEW content in full (S1→S2)', contract: 'C-04', expect: 'pass',
    run: async () => {
      const fixture = fixtureRoots()
      try {
        const resolution = await res.resolveResource('skillA', refFor('root-a'), ctxFor(fixture))
        const source = { kind: 'shared-skill', rootId: resolution.rootId, skillDir: resolution.skillDir, skillName: resolution.skillName }
        const first = res.snapshotDirectory(resolution.skillDir, source)
        const firstRead = first.files.find(f => f.path === 'SKILL.md').bytes.toString()
        writeFileSync(join(resolution.skillDir, 'SKILL.md'), '---\nname: sample\ndescription: A\n---\nCONTENT-A2\n')
        const second = res.snapshotDirectory(resolution.skillDir, source)
        const secondRead = second.files.find(f => f.path === 'SKILL.md').bytes.toString()
        return firstRead.includes('CONTENT-A1') && secondRead.includes('CONTENT-A2')
          && second.treeDigest !== first.treeDigest
          && first.files.some(f => f.path === 'scripts/run.sh')
      } finally {
        cleanup(fixture.root)
      }
    },
  })

  cases.push({
    id: 'T04-R2', title: 'T04: deleted shared skill fails the next attempt typed (no stale fallback)', contract: 'C-04', expect: 'pass',
    run: async () => {
      const fixture = fixtureRoots()
      try {
        const resolution = await res.resolveResource('skillA', refFor('root-a'), ctxFor(fixture))
        rmSync(resolution.skillDir, { recursive: true, force: true })
        try {
          res.snapshotDirectory(resolution.skillDir, { kind: 'shared-skill', rootId: resolution.rootId, skillDir: resolution.skillDir, skillName: resolution.skillName })
          return { ok: false, detail: 'expected RESOURCE_UNAVAILABLE' }
        } catch (error) {
          return error?.code === 'RESOURCE_UNAVAILABLE'
        }
      } finally {
        cleanup(fixture.root)
      }
    },
  })

  cases.push({
    id: 'T04-R3', title: 'T04: change detected between digest passes retries within budget then fails typed (no mixed snapshot)', contract: 'C-04', expect: 'pass',
    run: async () => {
      const fixture = fixtureRoots()
      try {
        const resolution = await res.resolveResource('skillA', refFor('root-a'), ctxFor(fixture))
        let mutation = 0
        try {
          res.snapshotDirectory(resolution.skillDir, { kind: 'shared-skill', rootId: resolution.rootId, skillDir: resolution.skillDir, skillName: resolution.skillName }, {
            maxAttempts: 3,
            onBetweenPasses: () => {
              mutation += 1
              writeFileSync(join(resolution.skillDir, 'SKILL.md'), `---\nname: sample\ndescription: A\n---\nMUTATION-${mutation}\n`)
            },
          })
          return { ok: false, detail: 'expected RESOURCE_CHANGED_DURING_READ' }
        } catch (error) {
          if (error?.code !== 'RESOURCE_CHANGED_DURING_READ') return { ok: false, detail: `wrong failure: ${String(error).slice(0, 160)}` }
          const settled = res.snapshotDirectory(resolution.skillDir, { kind: 'shared-skill', rootId: resolution.rootId, skillDir: resolution.skillDir, skillName: resolution.skillName })
          return settled.files.find(f => f.path === 'SKILL.md').bytes.toString().includes('MUTATION-')
        }
      } finally {
        cleanup(fixture.root)
      }
    },
  })

  cases.push({
    id: 'T16-R1', title: 'T16: admission rejects escapes, Windows reserved names, case and Unicode collisions without rewriting them', contract: 'C-16', expect: 'pass',
    run: () => {
      const issues = [
        ...admission.admitResourceRef('bad1', { kind: 'agent', path: '../outside/x.md' }),
        ...admission.admitResourceRef('bad2', { kind: 'agent', path: 'lib/con/prn.md' }),
        ...admission.admitResources({
          a: { kind: 'agent', path: 'lib/agents/Reviewer.md' },
          b: { kind: 'agent', path: 'lib/agents/reviewer.md' },
        }),
        ...admission.admitResources({
          u1: { kind: 'prompt', path: 'lib/prompts/cafe\u0301.md' },
          u2: { kind: 'prompt', path: 'lib/prompts/caf\u00e9.md' },
        }),
        ...admission.admitSnapshotPaths(['ok/relative.txt', 'escape/../x.txt']),
      ]
      const codes = issues.map(i => i.code)
      return codes.includes('path-escape') && codes.includes('reserved-path') && codes.includes('case-conflict')
        && codes.includes('unicode-conflict')
    },
  })

  cases.push({
    id: 'T03-R4', title: 'T03: package resource resolution stays inside the blueprint root', contract: 'C-03', expect: 'pass',
    run: async () => {
      const fixture = fixtureRoots()
      try {
        mkdirSync(join(fixture.blueprintRoot, 'lib', 'agents'), { recursive: true })
        writeFileSync(join(fixture.blueprintRoot, 'lib', 'agents', 'reviewer.md'), 'prompt')
        const ok = await res.resolveResource('agent', { kind: 'agent', path: 'lib/agents/reviewer.md' }, ctxFor(fixture))
        let rejected = false
        try {
          await res.resolveResource('bad', { kind: 'agent', path: '../escape.md' }, ctxFor(fixture))
        } catch (error) {
          rejected = error?.code === 'RESOURCE_UNAVAILABLE' && String(error.message).includes('escapes')
        }
        return ok.kind === 'package-file' && rejected
      } finally {
        cleanup(fixture.root)
      }
    },
  })

  return cases
}
