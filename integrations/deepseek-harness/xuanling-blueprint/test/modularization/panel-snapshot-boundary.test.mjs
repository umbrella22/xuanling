import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { checkModularization } from '../../scripts/check-modularization.mjs'
const plugin = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const panel = 'src/client/features/authoring/ui/panel/panel-controller.tsx'
const composition = 'src/client/features/authoring/ui/panel/panel-composition.tsx'
const hook = 'src/client/features/authoring/logic/workspace/panel-workspace-store.ts'
const check = root => checkModularization({ root, boundary: 'panel-snapshot' })
function mutate(file, change, expected) {
  const root = mkdtempSync(join(tmpdir(), 'bp-panel-snapshot-'))
  try {
    cpSync(join(plugin, 'src'), join(root, 'src'), { recursive: true })
    cpSync(join(plugin, 'package.json'), join(root, 'package.json'))
    symlinkSync(join(plugin, 'node_modules'), join(root, 'node_modules'), 'dir')
    const path = join(root, file)
    writeFileSync(path, change(readFileSync(path, 'utf8')))
    const result = check(root)
    assert.equal(result.ok, false, JSON.stringify(result))
    assert.equal(result.code, expected, JSON.stringify(result))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
test('actual Panel factory consumes its external snapshot and Workspace presentation', () => {
  const result = check(plugin)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(check(plugin), result)
  for (const entry of result.evidence) assert.ok(entry.line > 0 && entry.line <= readFileSync(join(plugin, entry.path), 'utf8').split('\n').length)
})
test('unwired and empty hooks cannot satisfy actual Panel subscription', () => {
  mutate(
    composition,
    source => source.replace('usePanelWorkspaceStore(workspace, React)', 'unusedPanelWorkspaceStore(workspace, React)'),
    'PANEL_SNAPSHOT_NOT_CONSUMED'
  )
  mutate(hook, () => 'export function usePanelWorkspaceStore() { return {} }', 'PANEL_SNAPSHOT_NOT_CONSUMED')
})
test('real subscription readers and server snapshot are required', () => {
  mutate(hook, source => source.replace('workspace.subscribe,', '() => () => {},'), 'PANEL_SNAPSHOT_SUBSCRIPTION_MISSING')
  mutate(hook, source => source.replace('workspace.getSnapshot)', '() => null)'), 'PANEL_SNAPSHOT_SUBSCRIPTION_MISSING')
})
test('presenter imports and unused projection cannot replace actual snapshot display consumption', () => {
  mutate(panel, source => source.replace('presentWorkspace(workspaceSnapshot)', 'unusedPresenter(workspaceSnapshot)'), 'PANEL_SNAPSHOT_PROJECTION_MISSING')
  mutate(panel, source => source.replace('presentWorkspace(workspaceSnapshot)', 'presentWorkspace(workspace.getSnapshot())'), 'PANEL_SNAPSHOT_NOT_CONSUMED')
  mutate(panel, source => source.replaceAll('workspaceView.', 'unusedWorkspaceView.'), 'PANEL_SNAPSHOT_PROJECTION_MISSING')
})
test('old Workspace tick subscription remains rejected while local tick use is permitted', () => {
  mutate(
    panel,
    source => source.replace('const workspaceView =', 'workspace.subscribe(() => setTick(n => n + 1)); const workspaceView ='),
    'PANEL_SNAPSHOT_TICK_SUBSCRIPTION'
  )
})
test('source failures retain distinct classifications', () => {
  mutate(hook, source => `${source}\nexport function {`, 'SOURCE_PARSE_ERROR')
  mutate(hook, source => `${source}\nimport './missing-panel-store.ts'`, 'SOURCE_UNAVAILABLE')
})
