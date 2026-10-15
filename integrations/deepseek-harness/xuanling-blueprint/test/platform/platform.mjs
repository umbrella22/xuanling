// N-PLATFORM suite (W7.2): runs the platform-relevant contracts on the REAL
// current OS and records the platform identity. On this machine (macOS
// arm64) that is real evidence; Linux/Windows evidence requires their own
// runners and is tracked as an explicit not-run gap (never inferred from
// macOS). The suite fails loudly on an unrecognized platform instead of
// silently passing.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function getCases(helpers) {
  const { packageRoot } = helpers
  const persistence = await import(join(packageRoot, 'lib', 'persistence.js'))
  const portability = await import(join(packageRoot, 'lib', 'portability.js'))
  const cases = []

  cases.push({
    id: 'PL1',
    title: 'T18: platform identity recorded (no cross-platform inference)',
    contract: 'C-18',
    expect: 'pass',
    run: () => {
      const known = ['darwin', 'linux', 'win32']
      if (!known.includes(process.platform)) throw new Error(`unrecognized platform ${process.platform}`)
      return { ok: true, platform: process.platform, arch: process.arch, node: process.version, tmp: tmpdir() }
    }
  })

  cases.push({
    id: 'PL2',
    title: 'T03/T04: shared-skill resolution and snapshot work on the real OS filesystem without creating links',
    contract: 'C-03',
    expect: 'pass',
    run: async () => {
      const res = await import(join(packageRoot, 'lib', 'resources.js'))
      const root = mkdtempSync(join(tmpdir(), 'bp-plat-'))
      try {
        const skillsRoot = join(root, 'skills')
        mkdirSync(join(skillsRoot, 'sample', 'scripts'), { recursive: true })
        writeFileSync(join(skillsRoot, 'sample', 'SKILL.md'), '---\nname: sample\n---\nPLATFORM-CONTENT\n')
        writeFileSync(join(skillsRoot, 'sample', 'scripts', 'helper.sh'), 'echo hi\n')
        const resolution = await res.resolveResource(
          'skill',
          { kind: 'skill', source: { kind: 'shared', rootId: 'r', path: 'sample' } },
          { blueprintRoot: root, roots: [{ rootId: 'r', rootPath: skillsRoot }] }
        )
        const snapshot = res.snapshotDirectory(resolution.skillDir, { kind: 'shared-skill', rootId: 'r', skillDir: resolution.skillDir, skillName: 'sample' })
        const noLinks = (function walk(dir) {
          return readdirSync(dir, { withFileTypes: true }).every(e => !e.isSymbolicLink() && (!e.isDirectory() || walk(join(dir, e.name))))
        })(root)
        return snapshot.files.length === 2 && noLinks
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  })

  cases.push({
    id: 'PL3',
    title: 'T15: durable store + atomic definition save + restore on the real OS (fs semantics, atomic rename)',
    contract: 'C-15',
    expect: 'pass',
    run: async () => {
      const def = await import(join(packageRoot, 'lib', 'definition.js'))
      const root = mkdtempSync(join(tmpdir(), 'bp-plat-'))
      try {
        mkdirSync(join(root, 'bp', 'lib', 'agents'), { recursive: true })
        writeFileSync(join(root, 'bp', 'lib', 'agents', 'a.md'), 'agent\n')
        writeFileSync(
          join(root, 'bp', 'blueprint.json'),
          JSON.stringify({
            schemaVersion: 1,
            id: 'plat',
            name: 'plat',
            resources: { a: { kind: 'agent', path: 'lib/agents/a.md' } },
            graph: { nodes: [{ id: 'n', kind: 'input', outputs: { x: 'string' } }], edges: [] }
          })
        )
        const first = def.loadDefinition(join(root, 'bp'))
        const saved = def.saveDefinition(join(root, 'bp'), first.definition)
        const reopened = def.loadDefinition(join(root, 'bp'))
        // Durable store roundtrip on this OS.
        mkdirSync(join(root, 'runtime', 'store'), { recursive: true })
        const opened = await persistence.openBlueprintDomain({ backend: 'json', path: join(root, 'runtime', 'store') })
        const store = new persistence.RunStore(opened.domain)
        const created = await store.createRun({ scope: 'p', requestId: 'r1', payloadFingerprint: 'fp' }, saved.revision.semantic, '{}', 'input')
        await store.settleTerminal(created.runId, 'succeeded')
        await opened.close()
        const backup = persistence.createBackup(join(root, 'runtime'))
        const restored = persistence.restoreBackup(backup.archive, join(root, 'restored'))
        return reopened.revision.semantic === saved.revision.semantic && restored.resumed === false
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  })

  cases.push({
    id: 'PL4',
    title: 'T11/T18: portable archive roundtrip on the real OS (paths, separators, case handling)',
    contract: 'C-11',
    expect: 'pass',
    run: () => {
      const root = mkdtempSync(join(tmpdir(), 'bp-plat-'))
      try {
        mkdirSync(join(root, 'bp', 'lib', 'agents'), { recursive: true })
        mkdirSync(join(root, 'skills', 'sample'), { recursive: true })
        writeFileSync(join(root, 'skills', 'sample', 'SKILL.md'), 'SKILL\n')
        writeFileSync(join(root, 'bp', 'lib', 'agents', 'a.md'), 'agent\n')
        writeFileSync(
          join(root, 'bp', 'blueprint.json'),
          JSON.stringify({
            schemaVersion: 1,
            id: 'plat2',
            name: 'plat2',
            resources: {
              a: { kind: 'agent', path: 'lib/agents/a.md' },
              s: { kind: 'skill', source: { kind: 'shared', rootId: 'r', path: 'sample' } }
            },
            graph: { nodes: [{ id: 'n', kind: 'input', outputs: { x: 'string' } }], edges: [] }
          })
        )
        const exported = portability.exportBlueprint(join(root, 'bp'), { roots: [{ rootId: 'r', rootPath: join(root, 'skills') }] })
        rmSync(join(root, 'skills'), { recursive: true, force: true })
        const target = join(root, 'imported')
        const imported = portability.importBlueprint(exported.archive, target)
        const skillFile = readFileSync(join(target, 'lib', 'skills', 's', 'SKILL.md'), 'utf8')
        return imported.manifest.closureDigest === exported.manifest.closureDigest && skillFile.includes('SKILL')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  })

  return cases
}
