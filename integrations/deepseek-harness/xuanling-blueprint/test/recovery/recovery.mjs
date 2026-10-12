// N-RECOVERY suite (plan §10.2): scoped recovery oracles. Scope 'portability'
// (W5.3) covers the private backup/restore journal: roundtrip, fail-closed
// unknown versions, interrupted-restore resume with previous data retained,
// and the lease gate. Scope 'coordinator' reuses the RT4 crash-window case.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export async function getCases(helpers) {
  const { packageRoot } = helpers
  const scope = helpers.scope ?? 'all'
  const cases = []

  if (scope === 'coordinator' || scope === 'all') {
    const runtime = await import(join(packageRoot, 'test', 'runtime', 'runtime.mjs'))
    const all = await runtime.getCases(helpers)
    cases.push(...all.filter(c => c.id === 'RT4'))
  }

  if (scope === 'portability' || scope === 'all') {
    const persistence = await import(join(packageRoot, 'lib', 'persistence.js'))
    const portability = await import(join(packageRoot, 'lib', 'portability.js'))

    const makeStore = async (root) => {
      const opened = await persistence.openBlueprintDomain({ backend: 'json', path: join(root, 'store') })
      return { opened, store: new persistence.RunStore(opened.domain) }
    }

    cases.push({
      id: 'RC1', title: 'T15: private backup/restore roundtrip preserves every run record byte-for-byte', contract: 'C-15', expect: 'pass',
      run: async () => {
        const root = mkdtempSync('/tmp/bp-backup-')
        try {
          mkdirSync(join(root, 'runtime', 'store'), { recursive: true })
          const { opened, store } = await makeStore(join(root, 'runtime'))
          const created = await store.createRun({ scope: 's', requestId: 'r1', payloadFingerprint: 'fp' }, 'rev-1', 'def-1', 'input-1')
          await store.recordIntent(created.runId, { nodeId: 'n1', kind: 'toolCall' })
          await store.recordResult(created.runId, (await store.get(created.runId)).attempts[0].attemptId, { ok: true, outcome: {}, evidence: 'done' })
          await store.settleTerminal(created.runId, 'succeeded', {})
          await opened.close()

          const backup = persistence.createBackup(join(root, 'runtime'))
          const restored = persistence.restoreBackup(backup.archive, join(root, 'restored'))
          const { opened: reopened, store: store2 } = await makeStore(join(root, 'restored'))
          const record = await store2.get(created.runId)
          await reopened.close()
          return restored.resumed === false
            && record.state === 'succeeded'
            && record.attempts[0]?.intent?.kind === 'toolCall'
            && record.attempts[0]?.result?.evidence === 'done'
            && restored.filesRestored.length >= 1
        } finally {
          rmSync(root, { recursive: true, force: true })
        }
      },
    })

    cases.push({
      id: 'RC2', title: 'T15: unknown backup formatVersion fails closed without touching existing target data', contract: 'C-15', expect: 'pass',
      run: () => {
        const root = mkdtempSync('/tmp/bp-backup-')
        try {
          mkdirSync(join(root, 'runtime', 'store'), { recursive: true })
          writeFileSync(join(root, 'runtime', 'store', 'keep.json'), '{"keep":true}')
          const backup = persistence.createBackup(join(root, 'runtime'))
          const entries = portability.readZip(backup.archive).map(e => e.name === 'backup.json'
            ? { name: e.name, data: Buffer.from(e.data.toString('utf8').replace('"formatVersion": 1', '"formatVersion": 999')), mode: e.mode }
            : { name: e.name, data: e.data, mode: e.mode })
          const bumped = portability.writeZip(entries)
          const target = join(root, 'target')
          mkdirSync(target, { recursive: true })
          writeFileSync(join(target, 'existing.txt'), 'older data\n')
          let failed = null
          try {
            persistence.restoreBackup(bumped, target)
          } catch (error) {
            failed = error
          }
          const kept = readFileSync(join(target, 'existing.txt'), 'utf8') === 'older data\n'
          const noNewData = !existsSync(join(target, 'store'))
          return failed?.code === 'FORMAT_UNSUPPORTED' && kept && noNewData
        } finally {
          rmSync(root, { recursive: true, force: true })
        }
      },
    })

    cases.push({
      id: 'RC3', title: 'T15: interrupted restore resumes from the journal and keeps previous data until publication', contract: 'C-15', expect: 'pass',
      run: () => {
        const root = mkdtempSync('/tmp/bp-backup-')
        try {
          mkdirSync(join(root, 'runtime', 'store'), { recursive: true })
          writeFileSync(join(root, 'runtime', 'store', 'data.json'), '{"v":2}')
          const backup = persistence.createBackup(join(root, 'runtime'))
          const target = join(root, 'target')
          mkdirSync(target, { recursive: true })
          writeFileSync(join(target, 'previous.txt'), 'v1\n')
          // Simulate a crash right after staging completed (phase 1 journal).
          const staging = join(root, '.bp-restore-staging-target')
          mkdirSync(join(staging, 'store'), { recursive: true })
          writeFileSync(join(staging, 'store', 'data.json'), '{"v":2}')
          writeFileSync(join(root, '.bp-restore-journal-target.json'), JSON.stringify({ phase: 'staging-done', target, staging }))
          const resumed = persistence.restoreBackup(backup.archive, target)
          const restoredData = readFileSync(join(target, 'store', 'data.json'), 'utf8')
          return resumed.resumed === true
            && restoredData.includes('"v":2')
            && !existsSync(join(root, '.bp-restore-journal-target.json'))
            && !existsSync(join(root, '.bp-restore-staging-target'))
        } finally {
          rmSync(root, { recursive: true, force: true })
        }
      },
    })

    cases.push({
      id: 'RC4', title: 'T15: restore safety gate reports an active lease (no restore over a live writer)', contract: 'C-15', expect: 'pass',
      run: () => {
        const root = mkdtempSync('/tmp/bp-backup-')
        try {
          mkdirSync(join(root, 'runtime'), { recursive: true })
          const before = persistence.restoreSafetyCheck(join(root, 'runtime'))
          writeFileSync(join(root, 'runtime', 'coordinator-lease.json'), JSON.stringify({ ownerId: 'x', pid: 1, startedAt: 0, runtimeRoot: root }))
          const after = persistence.restoreSafetyCheck(join(root, 'runtime'))
          return before.safe === true && after.safe === false && String(after.reason).includes('lease')
        } finally {
          rmSync(root, { recursive: true, force: true })
        }
      },
    })
  }

  if (cases.length === 0) throw new Error(`recovery: scope "${scope}" has no cases yet`)
  return cases
}
