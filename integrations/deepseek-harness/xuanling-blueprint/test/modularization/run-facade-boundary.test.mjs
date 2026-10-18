import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const plugin = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const service = join(plugin, 'src/index.ts')
const facade = join(plugin, 'src/service/run-read-service.ts')

test('W4.1 Run read facade owns query, lifecycle and session projection wiring', () => {
  assert.ok(existsSync(facade), 'RUN_FACADE_MISSING: Run read/use-case collaborator has not been extracted')
  const source = readFileSync(service, 'utf8')
  assert.match(source, /from ['"]\.\/service\/run-read-service\.ts['"]/, 'RUN_FACADE_IMPORT_MISSING')
  assert.match(source, /private readonly runReads\b/, 'RUN_FACADE_INSTANCE_MISSING')
  for (const method of ['queryRuns', 'inspectSession', 'setArchived']) {
    assert.match(source, new RegExp(`this\\.runReads\\(handle\\)\\.${method}\\(`), `RUN_FACADE_ROUTE_MISSING:${method}`)
  }
  assert.doesNotMatch(source, /async queryRuns\([^)]*\)[\\s\\S]*?handle\.query\.page\(/, 'RUN_QUERY_STILL_CENTRALIZED')
  assert.doesNotMatch(source, /async inspectSession\([^)]*\)[\\s\\S]*?pageWithRecords\(/, 'RUN_SESSION_PROJECTION_STILL_CENTRALIZED')
})
