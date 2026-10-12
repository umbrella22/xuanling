import { readFileSync, writeFileSync, readdirSync, existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { ROOT, ensure, assertPhysicalPath } from './conversation-evidence.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const reference = join(ROOT, '../deepseek-harness')

export function validateInstalledDshTuple(tuple, rows, { requireIntegrity = false } = {}) {
  ensure(typeof tuple?.capability_channel === 'string' && /^[a-z][a-z0-9-]*$/.test(tuple.capability_channel) && typeof tuple.source_head === 'string'
    && typeof tuple.source_manifest_version === 'string' && tuple.packages, 'HOST_DSH_TUPLE_INVALID')
  ensure(rows.length > 0, 'HOST_DSH_TUPLE_EMPTY')
  for (const row of rows) {
    const expected = tuple.packages[row.name]
    ensure(expected && expected.version === row.version, 'HOST_DSH_VERSION_MISMATCH')
    if (requireIntegrity || row.integrity !== undefined) ensure(typeof row.integrity === 'string' && row.integrity.length > 0
      && expected.integrity === row.integrity, 'HOST_DSH_INTEGRITY_MISMATCH')
  }
}

export function installedDshInventory(root) {
  const lockPath = join(root, 'package-lock.json')
  if (existsSync(lockPath)) {
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
    return Object.entries(lock.packages).flatMap(([path, locked]) => {
      if (!/(?:^|\/)node_modules\/@deepseek-ai\/dsh[^/]*$/.test(path)) return []
      const bytes = readFileSync(join(root, path, 'package.json')), manifest = JSON.parse(bytes)
      ensure(manifest.version === locked.version, 'HOST_DSH_VERSION_MISMATCH')
      return [{ name: manifest.name, version: manifest.version, integrity: locked.integrity, path, manifest_sha256: hash(bytes) }]
    })
  }
  const scopes = [join(root, 'node_modules/@deepseek-ai')]
  const pnpm = join(root, 'node_modules/.pnpm')
  if (existsSync(pnpm)) for (const entry of readdirSync(pnpm, { withFileTypes: true })) {
    if (entry.isDirectory()) scopes.push(join(pnpm, entry.name, 'node_modules/@deepseek-ai'))
  }
  const manifests = new Set(), rows = []
  for (const scope of scopes) if (existsSync(scope)) for (const name of readdirSync(scope).filter(name => /^dsh(?:-|$)/.test(name))) {
    const path = realpathSync(join(scope, name, 'package.json'))
    if (manifests.has(path)) continue
    manifests.add(path)
    const bytes = readFileSync(path), manifest = JSON.parse(bytes)
    rows.push({ name: manifest.name, version: manifest.version, manifest_sha256: hash(bytes) })
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name))
}

export async function verifyLatestDshTuple(receiptPath, reportDir) {
  assertPhysicalPath(receiptPath)
  const expected = JSON.parse(readFileSync(receiptPath, 'utf8'))
  ensure(expected.status === 'passed' && expected.source_modified === false, 'HOST_DSH_TUPLE_INVALID')
  const tuple = expected.resolved_dsh_tuple
  const facts = { started_at: new Date().toISOString(), status: 'running', capability_channel: tuple.capability_channel,
    source_head: tuple.source_head, packages_checked: 0, key_read: false, provider_calls: 0 }
  const get = async url => {
    let response
    try { response = await fetch(url, { headers: { 'User-Agent': 'XuanLing-TeamStage-validation' }, signal: AbortSignal.timeout(20000) }) }
    catch { ensure(false, 'HOST_DSH_LATEST_UNAVAILABLE') }
    ensure(response.ok, 'HOST_DSH_LATEST_UNAVAILABLE')
    return response.json()
  }
  try {
    const names = Object.keys(tuple.packages), queue = [...names]
    const workers = await Promise.allSettled(Array.from({ length: 6 }, async () => {
      while (queue.length) {
        const name = queue.shift(), metadata = await get(`https://registry.npmjs.org/${encodeURIComponent(name)}/${tuple.capability_channel}`)
        validateInstalledDshTuple(tuple, [{ name, version: metadata.version, integrity: metadata.dist?.integrity }], { requireIntegrity: true })
        facts.packages_checked++
      }
    }))
    const failed = workers.find(worker => worker.status === 'rejected')
    if (failed) throw failed.reason
    const tags = await get('https://registry.npmjs.org/@deepseek-ai%2Fdsh')
    ensure(tags['dist-tags']?.[tuple.capability_channel] === tuple.packages['@deepseek-ai/dsh'].version, 'HOST_DSH_VERSION_MISMATCH')
    facts.registry_dist_tags = tags['dist-tags']
    const repo = await get('https://api.github.com/repos/deepseek-ai/deepseek-harness')
    const head = await get(`https://api.github.com/repos/deepseek-ai/deepseek-harness/commits/${repo.default_branch}`)
    ensure(head.sha === tuple.source_head, 'HOST_DSH_SOURCE_DRIFT')
    ensure(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: reference, encoding: 'utf8' }).trim() === head.sha, 'HOST_DSH_SOURCE_DRIFT')
    ensure(JSON.parse(readFileSync(join(reference, 'package.json'))).version === tuple.source_manifest_version, 'HOST_DSH_VERSION_MISMATCH')
    ensure(execFileSync('git', ['status', '--porcelain'], { cwd: reference, encoding: 'utf8' }).trim() === '', 'HOST_DSH_SOURCE_DIRTY')
    facts.profile_recipe_sha256 = {}
    for (const [path, digest] of Object.entries(tuple.profile_recipe_sha256 ?? {})) {
      const actual = hash(readFileSync(join(path.startsWith('packages/') ? reference : ROOT, path)))
      ensure(actual === digest, 'HOST_DSH_PROFILE_DRIFT')
      facts.profile_recipe_sha256[path] = actual
    }
    facts.inventory = [join(ROOT, 'test/blueprint'), join(ROOT, 'integrations/deepseek-harness/xuanling-blueprint')]
      .map(root => ({ root, packages: installedDshInventory(root) }))
    for (const row of facts.inventory) validateInstalledDshTuple(tuple, row.packages)
    facts.status = 'passed'
  } catch (error) { facts.status = 'blocked'; facts.failure = error.code ?? 'HOST_DSH_LATEST_UNAVAILABLE'; throw error }
  finally {
    facts.completed_at = new Date().toISOString()
    writeFileSync(join(reportDir, 'latest-check.json'), JSON.stringify(facts, null, 2) + '\n')
  }
  return tuple
}
