#!/usr/bin/env node
// W0.3 store/recovery probe (plan dsh-blueprint-plugin-v1): proves the public
// storage stack (@deepseek-ai/dsh-storage + json/sqlite backend +
// dsh-storage-domain) outside any DSH workspace, on an isolated temp root:
//   W1  domain open/put/update/get/delete + durable reopen in a fresh context
//   W2  single-open enforcement (concurrent open of the same domain)
//   W3  KvTable.update runs the reducer synchronously (pure sync RMW contract)
//   W4  version-mismatch on reopen (format evolution fail-closed)
//   W5  global slot persistence
//   W6  cross-process behavior of each backend (two writers, no coordination)
//       — evidence for the coordinator's own single-writer lease design.
// Exits non-zero when a required assertion fails; writes a JSON report.

import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..', '..')
const IS_CHILD = process.argv.includes('--child')
const CHILD_BACKEND = process.argv[process.argv.indexOf('--child-backend') + 1]
const CHILD_DIR = process.argv[process.argv.indexOf('--child-dir') + 1]
const CHILD_DOMAIN = process.argv[process.argv.indexOf('--child-domain') + 1] ?? 'blueprint_probe'

const report = {
  probe: 'w0.3-store-recovery',
  plan_id: 'dsh-blueprint-plugin-v1',
  started_at: new Date().toISOString(),
  assertions: [],
  cases: {},
}

function assert(id, description, passed, detail) {
  report.assertions.push({ id, description, passed, detail: detail === undefined ? null : detail })
  process.stdout.write(`[store-probe] ${passed ? 'PASS' : 'FAIL'} ${id}: ${description}${detail !== undefined ? ` — ${JSON.stringify(detail)?.slice(0, 260)}` : ''}\n`)
  return passed
}

async function buildStack(backend, root, dbPath) {
  const { Context } = await import('@deepseek-ai/cordis')
  const Storage = (await import('@deepseek-ai/dsh-storage')).default
  const domainMod = await import('@deepseek-ai/dsh-storage-domain')
  const backendMod = backend === 'json'
    ? await import('@deepseek-ai/dsh-storage-json')
    : await import('@deepseek-ai/dsh-storage-sqlite')
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(backendMod, backend === 'json' ? { root } : { path: dbPath })
  await ctx.plugin(domainMod, { backend })
  return { ctx, defineDomain: domainMod.defineDomain, domainTable: domainMod.domainTable }
}

function specFor(defineDomain, domainTable, z, version = 1) {
  return defineDomain({
    name: 'blueprint_probe',
    version,
    tables: {
      runs: domainTable(z.object({ id: z.string(), status: z.string(), seq: z.number() })),
    },
    global: {
      schema: z.object({ startedAt: z.number() }),
      initial: { startedAt: 0 },
    },
  })
}

async function caseLifecycle(backend) {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const root = mkdtempSync(join(tmpdir(), `bp-store-${backend}-`))
  const dbPath = join(root, 'data.db')
  const z = (await import('zod')).z
  const { ctx, defineDomain, domainTable } = await buildStack(backend, root, dbPath)
  const spec = specFor(defineDomain, domainTable, z)
  const domain = await ctx.storageDomain.open(spec)
  const table = domain.table('runs')

  // basic put/get
  await table.put('r1', { id: 'r1', status: 'running', seq: 1 })
  const r1 = await table.get('r1')
  const putGet = r1?.id === 'r1' && r1?.seq === 1

  // update RMW
  const updateResult = await table.update('r1', (old) => ({ ...old, status: 'succeeded', seq: old.seq + 1 }))
  const afterUpdate = await table.get('r1')
  const updateOk = afterUpdate?.status === 'succeeded' && afterUpdate?.seq === 2
    && (updateResult === undefined || (updateResult?.status === 'succeeded'))

  // update on missing record: observed contract — the domain layer rejects
  // (throws) instead of silently creating; record the exact behavior.
  let missingBehavior = null
  try {
    await table.update('nope', () => ({ id: 'x', status: 'y', seq: 0 }))
    missingBehavior = { throws: false }
  } catch (error) {
    missingBehavior = { throws: true, message: String(error?.message ?? error).slice(0, 160), code: error?.code ?? error?.name }
  }

  // sync reducer contract: marker set inside the callback is visible when update resolves
  let syncMarker = false
  await table.update('r1', (old) => { syncMarker = true; return old })
  const updateSync = syncMarker === true

  // single-open: opening the same spec again in the same stack must fail typed
  let secondOpen = null
  try {
    await ctx.storageDomain.open(spec)
    secondOpen = { error: null }
  } catch (error) {
    secondOpen = { error: String(error?.message ?? error), code: error?.code ?? error?.name }
  }

  // global slot
  await domain.global.set({ startedAt: 12345 })
  const globalRead = await domain.global.get()
  const globalOk = globalRead?.startedAt === 12345

  await domain.close()
  await ctx.destroy?.()
  if (ctx.stop) await ctx.stop()

  // W6a: durability — fresh process tree context, same medium
  const z2 = (await import('zod')).z
  const { ctx: ctx2, defineDomain: dd2, domainTable: dt2 } = await buildStack(backend, root, dbPath)
  const domain2 = await ctx2.storageDomain.open(specFor(dd2, dt2, z2))
  const reopened = await domain2.table('runs').get('r1')
  const globalReopened = await domain2.global.get()
  const durabilityOk = reopened?.status === 'succeeded' && reopened?.seq === 2 && globalReopened?.startedAt === 12345
  await domain2.close()

  // W6b: version mismatch — reopen the same medium with version 2 and no
  // compatibility declaration; must reject typed (fail closed).
  let mismatch = null
  try {
    const domainV2 = await ctx2.storageDomain.open(specFor(dd2, dt2, z2, 2))
    await domainV2.close()
    mismatch = { error: null }
  } catch (error) {
    mismatch = { error: String(error?.message ?? error).slice(0, 200), code: error?.code ?? error?.name }
  }
  if (ctx2.stop) await ctx2.stop()

  // W6c: cross-process — child process opens the same medium and writes r2
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child', '--child-backend', backend, '--child-dir', root, '--child-domain', 'blueprint_probe'], {
    encoding: 'utf8', timeout: 60_000,
  })
  const childOk = child.status === 0
  // parent reopens and looks for the child's record
  const z3 = (await import('zod')).z
  const { ctx: ctx3, defineDomain: dd3, domainTable: dt3 } = await buildStack(backend, root, dbPath)
  const domain3 = await ctx3.storageDomain.open(specFor(dd3, dt3, z3))
  const childRecord = await domain3.table('runs').get('r2')
  const crossProcessVisible = childRecord?.id === 'r2'
  // parent then overwrites r2 with a different seq (last-writer-wins evidence)
  await domain3.table('runs').put('r2', { id: 'r2', status: 'parent-rewrite', seq: 99 })
  const clobbered = await domain3.table('runs').get('r2')
  await domain3.close()
  if (ctx3.stop) await ctx3.stop()

  report.cases[backend] = {
    root,
    putGet,
    updateOk,
    missingBehavior,
    updateSync,
    secondOpen,
    globalOk,
    durabilityOk,
    mismatch,
    child: { ok: childOk, stdout: child.stdout?.slice(-500), stderr: child.stderr?.slice(-500) },
    crossProcessVisible,
    lastWriterWins: clobbered?.status === 'parent-rewrite',
  }

  assert(`${backend}/put-get`, 'put then get round-trips the record', putGet, r1)
  assert(`${backend}/update-rmw`, 'update applies read-modify-write', updateOk, afterUpdate)
  assert(`${backend}/update-sync`, 'update reducer runs synchronously', updateSync, null)
  assert(`${backend}/single-open`, 'second open of the same domain fails typed', secondOpen?.error !== null, secondOpen)
  assert(`${backend}/global`, 'global slot set/get works', globalOk, globalRead)
  assert(`${backend}/durability`, 'fresh context reopens and reads committed records (json: fresh reader)', durabilityOk, { reopened, globalReopened })
  assert(`${backend}/version-mismatch`, 'reopen with bumped version and no compat rejects typed', mismatch?.error !== null, mismatch)
  assert(`${backend}/cross-process`, 'child process write becomes visible to a fresh parent reader', crossProcessVisible, { childRecord, childOk })
  assert(`${backend}/last-writer-wins`, 'parent rewrite after child write clobbers (no cross-process coordination)', clobbered?.status === 'parent-rewrite', clobbered)

  if (backend === 'json') rmSync(root, { recursive: true, force: true })
}

async function childMain() {
  const z = (await import('zod')).z
  const { ctx, defineDomain, domainTable } = await buildStack(CHILD_BACKEND, CHILD_DIR, join(CHILD_DIR, 'data.db'))
  const spec = specFor(defineDomain, domainTable, z)
  const domain = await ctx.storageDomain.open(spec)
  await domain.table('runs').put('r2', { id: 'r2', status: 'child-write', seq: 2 })
  await domain.close()
  if (ctx.stop) await ctx.stop()
  process.exit(0)
}

async function main() {
  if (IS_CHILD) {
    await childMain()
    return
  }
  report.environment = { node: process.version, platform: `${process.platform}/${process.arch}` }
  let requiredOk = true
  for (const backend of ['json', 'sqlite']) {
    try {
      await caseLifecycle(backend)
    } catch (error) {
      requiredOk = false
      report.cases[backend] = { fatal: String(error?.stack ?? error) }
      assert(`${backend}/fatal`, `${backend} case completed without fatal error`, false, String(error?.message ?? error))
    }
  }
  report.finished_at = new Date().toISOString()
  report.passed = requiredOk && report.assertions.every(a => a.passed)
  const reportDir = join(REPO, 'docs', 'validation', 'blueprint', 'current', 'w0')
  mkdirSync(reportDir, { recursive: true })
  writeFileSync(join(reportDir, 'w0.3-store-probe-report.json'), JSON.stringify(report, null, 2))
  process.stdout.write(`[store-probe] report written; probe ${report.passed ? 'PASSED' : 'FAILED'} (${report.assertions.filter(a => a.passed).length}/${report.assertions.length})\n`)
  process.exit(report.passed ? 0 : 1)
}

main().catch((error) => {
  process.stdout.write(`[store-probe] fatal: ${error?.stack ?? error}\n`)
  process.exit(1)
})
