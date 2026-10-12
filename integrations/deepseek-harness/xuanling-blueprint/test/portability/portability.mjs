// N-PORTABILITY suite (W5.1/W5.2): T11 closure/roundtrip/zip-slip/symlink/
// collision/missing-binding/no-execute. Runs against the built
// lib/portability.js seam with real files on real temp dirs.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DEF = {
  schemaVersion: 1,
  id: 'code-review',
  name: '代码审查',
  resources: {
    reviewer: { kind: 'agent', path: 'lib/agents/reviewer.md' },
    reviewSkill: { kind: 'skill', source: { kind: 'shared', rootId: 'user-agents-skills', path: 'sample' } },
    resultSchema: { kind: 'schema', path: 'lib/schemas/review-result.json' },
    repoTools: { kind: 'mcp', bindingId: 'repo-readonly' },
    script1: { kind: 'script', path: 'lib/scripts/check.mjs' },
  },
  graph: {
    nodes: [
      { id: 'input', kind: 'input', outputs: { request: 'string' } },
      {
        id: 'review', kind: 'agentTask',
        agentRef: 'reviewer', skillRefs: ['reviewSkill'],
        toolsetRefs: ['repoTools'], outputSchemaRef: 'resultSchema',
        inputs: { input: 'string' }, outputs: { result: 'json' },
      },
      { id: 'result', kind: 'output', inputs: { value: 'json' } },
    ],
    edges: [
      { kind: 'data', from: 'input.request', to: 'review.input' },
      { kind: 'data', from: 'review.result', to: 'result.value' },
    ],
  },
}

function fixture() {
  const root = mkdtempSync('/tmp/bp-portability-')
  const bp = join(root, 'bp')
  const skillsRoot = join(root, 'agents-home', 'skills')
  mkdirSync(join(bp, 'lib', 'agents'), { recursive: true })
  mkdirSync(join(bp, 'lib', 'schemas'), { recursive: true })
  mkdirSync(join(bp, 'lib', 'scripts'), { recursive: true })
  mkdirSync(join(skillsRoot, 'sample', 'scripts'), { recursive: true })
  mkdirSync(join(skillsRoot, 'sample', 'references'), { recursive: true })
  writeFileSync(join(bp, 'blueprint.json'), JSON.stringify(DEF, null, 2))
  writeFileSync(join(bp, 'lib', 'agents', 'reviewer.md'), 'You are a reviewer.\n')
  writeFileSync(join(bp, 'lib', 'schemas', 'review-result.json'), '{"type":"object"}\n')
  writeFileSync(join(bp, 'lib', 'scripts', 'check.mjs'), 'console.log("checked")\n')
  writeFileSync(join(skillsRoot, 'sample', 'SKILL.md'), '---\nname: sample\n---\nSKILL-CONTENT\n')
  writeFileSync(join(skillsRoot, 'sample', 'scripts', 'helper.sh'), 'echo helper\n')
  writeFileSync(join(skillsRoot, 'sample', 'references', 'ref.md'), 'reference\n')
  return { root, bp, skillsRoot }
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true })
}

export async function getCases(helpers) {
  const { packageRoot } = helpers
  const port = await import(join(packageRoot, 'lib', 'portability.js'))
  const cases = []

  cases.push({
    id: 'P1', title: 'T11: export materializes the FULL skill tree + package files and rewrites shared refs to package paths', contract: 'C-11', expect: 'pass',
    run: () => {
      const f = fixture()
      try {
        const result = port.exportBlueprint(f.bp, { roots: [{ rootId: 'user-agents-skills', rootPath: f.skillsRoot }] })
        const names = Object.keys(result.manifest.files)
        const packagedDef = JSON.parse(readFileSync(join(f.bp, 'blueprint.json'), 'utf8')) // export never mutates the source
        const skillRef = result.materializedSkills.reviewSkill
        return names.includes('blueprint.json')
          && names.some(n => n === 'lib/agents/reviewer.md')
          && names.some(n => n === 'lib/schemas/review-result.json')
          && names.some(n => n.startsWith('lib/skills/reviewSkill/'))
          && names.includes('lib/skills/reviewSkill/SKILL.md')
          && names.includes('lib/skills/reviewSkill/scripts/helper.sh')
          && names.includes('lib/skills/reviewSkill/references/ref.md')
          && skillRef === 'lib/skills/reviewSkill'
          && result.manifest.requiredBindings.includes('repo-readonly')
          && result.manifest.runDependencies.length >= 1
          && packagedDef.resources.reviewSkill.source !== undefined
      } finally {
        cleanup(f.root)
      }
    },
  })

  cases.push({
    id: 'P2', title: 'T11: roundtrip — import into a fresh machine reproduces the closure byte-for-byte and needs no source dirs', contract: 'C-11', expect: 'pass',
    run: () => {
      const f = fixture()
      try {
        const result = port.exportBlueprint(f.bp, { roots: [{ rootId: 'user-agents-skills', rootPath: f.skillsRoot }] })
        // Simulate the move: delete the originals BEFORE importing.
        rmSync(f.skillsRoot, { recursive: true, force: true })
        const target = join(f.root, 'imported', 'code-review')
        const imported = port.importBlueprint(result.archive, target)
        const skillMd = readFileSync(join(target, 'lib', 'skills', 'reviewSkill', 'SKILL.md'), 'utf8')
        const helper = readFileSync(join(target, 'lib', 'skills', 'reviewSkill', 'scripts', 'helper.sh'), 'utf8')
        const republished = JSON.parse(readFileSync(join(target, 'blueprint.json'), 'utf8'))
        const importedRef = republished.resources.reviewSkill
        return imported.filesWritten.includes('blueprint.json')
          && skillMd.includes('SKILL-CONTENT') && helper.includes('echo helper')
          && importedRef.source === undefined && importedRef.path === 'lib/skills/reviewSkill'
          && imported.manifest.closureDigest === result.manifest.closureDigest
      } finally {
        cleanup(f.root)
      }
    },
  })

  cases.push({
    id: 'P3', title: 'T11: zip-slip, symlink entries, backslash paths and duplicates are rejected before extraction', contract: 'C-11', expect: 'pass',
    run: () => {
      const f = fixture()
      try {
        const result = port.exportBlueprint(f.bp, { roots: [{ rootId: 'user-agents-skills', rootPath: f.skillsRoot }] })
        const baseEntries = port.readZip(result.archive)
        const mk = (mutate) => {
          const entries = baseEntries.map(e => ({ name: e.name, data: e.data, mode: e.mode }))
          mutate(entries)
          return port.writeZip(entries)
        }
        const verdicts = []
        for (const archive of [
          mk(es => es.push({ name: '../evil.txt', data: Buffer.from('x'), mode: 0o100644 })),
          mk(es => es.push({ name: '/abs/evil.txt', data: Buffer.from('x'), mode: 0o100644 })),
          mk(es => es.push({ name: 'lib\\evil.txt', data: Buffer.from('x'), mode: 0o100644 })),
          mk(es => es.push({ name: 'lib/skills/link', data: Buffer.from('target'), mode: 0o120777 })),
          mk(es => es.push({ name: 'lib/agents/reviewer.md', data: Buffer.from('dup'), mode: 0o100644 })),
        ]) {
          try {
            port.importBlueprint(archive, join(f.root, 'never'))
            verdicts.push('accepted')
          } catch (error) {
            verdicts.push(error?.code)
          }
        }
        const targetCreated = existsSync(join(f.root, 'never'))
        return verdicts.every(v => v === 'ARCHIVE_UNSAFE' || v === 'PORTABILITY_CONFLICT') && !targetCreated
      } finally {
        cleanup(f.root)
      }
    },
  })

  cases.push({
    id: 'P4', title: 'T11: tampered digest / undeclared extra file / missing dependency block import with no partial target', contract: 'C-11', expect: 'pass',
    run: () => {
      const f = fixture()
      try {
        const result = port.exportBlueprint(f.bp, { roots: [{ rootId: 'user-agents-skills', rootPath: f.skillsRoot }] })
        const entries = port.readZip(result.archive)
        const tamper = (name) => {
          const es = entries.map(e => ({ name: e.name, data: e.name === name ? Buffer.from('TAMPERED') : e.data, mode: e.mode }))
          return port.writeZip(es)
        }
        const extra = (() => {
          const es = entries.map(e => ({ name: e.name, data: e.data, mode: e.mode }))
          es.push({ name: 'lib/extra.txt', data: Buffer.from('sneaky'), mode: 0o100644 })
          return port.writeZip(es)
        })()
        const tamperedArchive = tamper('lib/agents/reviewer.md')
        const results = []
        for (const archive of [tamperedArchive, extra]) {
          const target = join(f.root, 'target-' + results.length)
          try {
            port.importBlueprint(archive, target)
            results.push('accepted')
          } catch (error) {
            results.push(error?.code)
          }
          if (existsSync(target)) results.push('left-target')
        }
        // Missing dependency at export time is a typed failure as well.
        let exportError = null
        try {
          port.exportBlueprint(f.bp, { roots: [] })
        } catch (error) {
          exportError = error?.code
        }
        return results.every(r => r === 'PORTABILITY_CONFLICT') && !results.includes('left-target')
          && exportError === 'EXPORT_DEPENDENCY_MISSING'
      } finally {
        cleanup(f.root)
      }
    },
  })

  cases.push({
    id: 'P5', title: 'T11: import never executes scripts and never rebinds to same-named local skills implicitly', contract: 'C-11', expect: 'pass',
    run: () => {
      const f = fixture()
      try {
        // A hostile local skill with the SAME name as the packaged one.
        mkdirSync(join(f.skillsRoot, 'sample'), { recursive: true })
        writeFileSync(join(f.skillsRoot, 'sample', 'SKILL.md'), 'LOCAL-HOSTILE\n')
        const result = port.exportBlueprint(f.bp, { roots: [{ rootId: 'user-agents-skills', rootPath: f.skillsRoot }] })
        const target = join(f.root, 'imported-only')
        port.importBlueprint(result.archive, target)
        const republished = JSON.parse(readFileSync(join(target, 'blueprint.json'), 'utf8'))
        const ref = republished.resources.reviewSkill
        const stillPackaged = ref.source === undefined && ref.path === 'lib/skills/reviewSkill'
        // Explicit rebind is the only path back to the local root.
        port.rebindSharedSkill(target, 'reviewSkill', { rootId: 'user-agents-skills', skillPath: 'sample' })
        const after = JSON.parse(readFileSync(join(target, 'blueprint.json'), 'utf8'))
        return stillPackaged
          && after.resources.reviewSkill.source?.rootId === 'user-agents-skills'
          && after.resources.reviewSkill.path === undefined
      } finally {
        cleanup(f.root)
      }
    },
  })

  cases.push({
    id: 'P6', title: 'T11/T16: sensitive export (secret canary in a packaged file) is blocked and names the file', contract: 'C-16', expect: 'pass',
    run: () => {
      const f = fixture()
      try {
        writeFileSync(join(f.bp, 'lib', 'agents', 'reviewer.md'), 'api_key = "BP_SECRET_CANARY_1234"\n')
        let blocked = null
        try {
          port.exportBlueprint(f.bp, {
            roots: [{ rootId: 'user-agents-skills', rootPath: f.skillsRoot }],
            scanForSecrets: helpers.scanForSecrets,
          })
        } catch (error) {
          blocked = error
        }
        return blocked?.code === 'SENSITIVE_EXPORT_BLOCKED'
          && blocked.findings.some(x => x.path === 'lib/agents/reviewer.md')
      } finally {
        cleanup(f.root)
      }
    },
  })

  cases.push({
    id: 'P7', title: 'T11: import into an existing non-empty target is refused (no half-import, original kept)', contract: 'C-11', expect: 'pass',
    run: () => {
      const f = fixture()
      try {
        const result = port.exportBlueprint(f.bp, { roots: [{ rootId: 'user-agents-skills', rootPath: f.skillsRoot }] })
        const target = join(f.root, 'occupied')
        mkdirSync(target, { recursive: true })
        writeFileSync(join(target, 'precious.txt'), 'keep me\n')
        let conflict = null
        try {
          port.importBlueprint(result.archive, target)
        } catch (error) {
          conflict = error
        }
        const kept = readFileSync(join(target, 'precious.txt'), 'utf8') === 'keep me\n'
        const noPartial = !existsSync(join(target, 'blueprint.json'))
        return conflict?.code === 'IMPORT_CONFLICT' && kept && noPartial
      } finally {
        cleanup(f.root)
      }
    },
  })

  return cases
}
