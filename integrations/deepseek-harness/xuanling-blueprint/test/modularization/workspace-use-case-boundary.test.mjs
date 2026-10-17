import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { checkModularization } from '../../scripts/check-modularization.mjs'

const plugin = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const owner = 'src/client/features/authoring/logic/resources/workspace-resource-use-cases.ts'
const facade = 'src/client/features/authoring/logic/workspace/workspace-controller.ts'
const check = root => checkModularization({ root, boundary: 'workspace-use-cases', slice: 'resources' })
function copy(action) {
  const root = mkdtempSync(join(tmpdir(), 'bp-workspace-use-case-boundary-'))
  try {
    cpSync(join(plugin, 'src'), join(root, 'src'), { recursive: true })
    cpSync(join(plugin, 'package.json'), join(root, 'package.json'))
    symlinkSync(join(plugin, 'node_modules'), join(root, 'node_modules'), 'dir')
    return action(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
function mutate(file, change, code) {
  copy(root => {
    const path = join(root, file)
    writeFileSync(path, change(readFileSync(path, 'utf8')))
    const result = check(root)
    assert.equal(result.ok, false, JSON.stringify(result))
    assert.equal(result.code, code, JSON.stringify(result))
  })
}

test('resources slice resolves actual Workspace facade delegation and Host observation owner', () => {
  const result = check(plugin)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(check(plugin), result)
  for (const path of [facade, owner])
    assert.ok(
      result.evidence.some(entry => entry.path === path),
      path
    )
  for (const entry of result.evidence) assert.ok(entry.line > 0 && entry.line <= readFileSync(join(plugin, entry.path), 'utf8').split('\n').length)
  assert.equal(checkModularization({ root: plugin, boundary: 'workspace' }).ok, true, 'original W3 boundary stays independent')
  assert.equal(checkModularization({ root: plugin, boundary: 'workspace-use-cases' }).code, 'WORKSPACE_USE_CASE_SLICE_LOCKED')
  assert.equal(checkModularization({ root: plugin, boundary: 'workspace-use-cases', slice: 'run' }).ok, true)
})

test('unused resource import and a no-op extracted owner cannot satisfy actual delegation', () => {
  mutate(
    facade,
    source => source.replace('return refreshWorkspaceResources(', 'return Promise.resolve(); refreshWorkspaceResourcesUnused('),
    'WORKSPACE_RESOURCE_USE_CASE_WIRING_MISSING'
  )
  mutate(
    owner,
    source => source.replace(/export async function refreshWorkspaceResources[\s\S]*/, 'export async function refreshWorkspaceResources(context) { return }'),
    'WORKSPACE_RESOURCE_USE_CASE_CONTRACT_MISSING'
  )
})

test('reintroduced live Host read in actual resource facade is correctly classified as centralized', () => {
  mutate(
    facade,
    source => source.replace('return refreshWorkspaceResources(', 'this.host.listResources(); return refreshWorkspaceResources('),
    'WORKSPACE_RESOURCE_USE_CASE_STILL_CENTRALIZED'
  )
})

test('resource success and failure must each retain read and navigation settlement fences', () => {
  for (const field of ['readGeneration', 'navigationGeneration']) {
    for (const last of [false, true]) {
      mutate(
        owner,
        source => {
          const needle = `if (readGeneration !== context.readGeneration() || navigationGeneration !== context.navigationGeneration()) return`
          const index = last ? source.lastIndexOf(needle) : source.indexOf(needle)
          assert.ok(index >= 0)
          const replacement = needle.replace(`context.${field}()`, '0')
          return source.slice(0, index) + replacement + source.slice(index + needle.length)
        },
        'WORKSPACE_RESOURCE_SETTLEMENT_FENCE_MISSING'
      )
    }
  }
})

test('resource use case rejects runtime controller/framework imports and direct browser effects', () => {
  for (const dependency of ["import React from 'react'", "import { BlueprintWorkspace } from '../workspace/workspace-controller.ts'"])
    mutate(owner, source => `${source}\n${dependency}\n`, 'WORKSPACE_RESOURCE_USE_CASE_DEPENDENCY')
  mutate(owner, source => source.replace('context.assertActive()', 'document.title; context.assertActive()'), 'WORKSPACE_RESOURCE_USE_CASE_EFFECT')
})

test('missing and malformed source remain tool failures rather than structural red', () => {
  mutate(owner, source => `${source}\nimport './missing-resource-owner.ts'`, 'SOURCE_UNAVAILABLE')
  mutate(owner, source => `${source}\nexport function {`, 'SOURCE_PARSE_ERROR')
})

const navigationOwner = 'src/client/features/authoring/logic/workspace/workspace-document-navigation.ts'
const navigation = root => checkModularization({ root, boundary: 'workspace-use-cases', slice: 'navigation' })
function mutateNavigation(file, change, expected) {
  copy(root => {
    const path = join(root, file)
    writeFileSync(path, change(readFileSync(path, 'utf8')))
    const result = navigation(root)
    assert.equal(result.ok, false, JSON.stringify(result))
    assert.equal(result.code, expected, JSON.stringify(result))
  })
}
test('navigation slice resolves all three actual facade operations to distinct extracted callables', () => {
  const result = navigation(plugin)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(navigation(plugin), result)
  assert.equal(result.evidence.filter(entry => entry.path === facade).length, 3)
  assert.equal(result.evidence.filter(entry => entry.path === navigationOwner).length, 3)
})
test('navigation rejects unused imports, discarded delegation results and empty owners', () => {
  for (const symbol of ['newWorkspaceDraft', 'initializeWorkspace', 'loadWorkspaceDocument']) {
    mutateNavigation(
      facade,
      source => source.replace(`return ${symbol}(`, `return undefined; ${symbol}Unused(`),
      'WORKSPACE_NAVIGATION_USE_CASE_STILL_CENTRALIZED'
    )
    mutateNavigation(facade, source => source.replace(`return ${symbol}(`, `return undefined; ${symbol}(`), 'WORKSPACE_NAVIGATION_USE_CASE_WIRING_MISSING')
  }
  mutateNavigation(
    navigationOwner,
    () => 'export function newWorkspaceDraft() {}\nexport function initializeWorkspace() {}\nexport function loadWorkspaceDocument() {}',
    'WORKSPACE_NAVIGATION_USE_CASE_OWNER_MISSING'
  )
})
test('navigation return-only owners remain rejected', () => {
  mutateNavigation(
    navigationOwner,
    () =>
      'export function newWorkspaceDraft() { return undefined }\nexport function initializeWorkspace() { return undefined }\nexport function loadWorkspaceDocument() { return undefined }',
    'WORKSPACE_NAVIGATION_USE_CASE_OWNER_MISSING'
  )
})
test('navigation broken source and missing owner imports retain source failure classifications', () => {
  mutateNavigation(navigationOwner, source => `${source}\nexport function {`, 'SOURCE_PARSE_ERROR')
  mutateNavigation(navigationOwner, source => `${source}\nimport './missing-navigation-owner.ts'`, 'SOURCE_UNAVAILABLE')
  mutateNavigation(facade, source => source.replaceAll('newWorkspaceDraft', 'missingNavigationExport'), 'UNRESOLVED_BINDING')
})

const documentOwner = 'src/client/features/authoring/logic/workspace/workspace-document-writes.ts'
const documents = root => checkModularization({ root, boundary: 'workspace-use-cases', slice: 'documents' })
function mutateDocuments(file, change, expected) {
  copy(root => {
    const path = join(root, file)
    writeFileSync(path, change(readFileSync(path, 'utf8')))
    const result = documents(root)
    assert.equal(result.ok, false, JSON.stringify(result))
    assert.equal(result.code, expected, JSON.stringify(result))
  })
}
const documentSymbols = ['saveWorkspaceDocument', 'deleteWorkspaceDocument', 'exportWorkspaceArchive', 'importWorkspaceArchive']
test('documents slice resolves all four actual write facade operations to distinct owner callables', () => {
  const result = documents(plugin)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(documents(plugin), result)
  assert.equal(result.evidence.filter(entry => entry.path === facade).length, 4)
  assert.equal(result.evidence.filter(entry => entry.path === documentOwner).length, 4)
})
test('documents rejects unused imports, discarded delegation results and empty or return-only owners', () => {
  for (const symbol of documentSymbols) {
    mutateDocuments(
      facade,
      source => source.replace(`return ${symbol}(`, `return undefined; ${symbol}Unused(`),
      'WORKSPACE_DOCUMENT_USE_CASE_STILL_CENTRALIZED'
    )
    mutateDocuments(facade, source => source.replace(`return ${symbol}(`, `return undefined; ${symbol}(`), 'WORKSPACE_DOCUMENT_USE_CASE_WIRING_MISSING')
  }
  for (const body of ['', 'return undefined'])
    mutateDocuments(
      documentOwner,
      () => documentSymbols.map(symbol => `export function ${symbol}() { ${body} }`).join('\n'),
      'WORKSPACE_DOCUMENT_USE_CASE_OWNER_MISSING'
    )
})
test('documents source parse, missing dependency and missing export remain distinct source failures', () => {
  mutateDocuments(documentOwner, source => `${source}\nexport function {`, 'SOURCE_PARSE_ERROR')
  mutateDocuments(documentOwner, source => `${source}\nimport './missing-document-owner.ts'`, 'SOURCE_UNAVAILABLE')
  mutateDocuments(facade, source => source.replaceAll('saveWorkspaceDocument', 'missingDocumentExport'), 'UNRESOLVED_BINDING')
})

const runOwner = 'src/client/features/authoring/logic/run/workspace-run-use-cases.ts'
const run = root => checkModularization({ root, boundary: 'workspace-use-cases', slice: 'run' })
const runSymbols = ['checkWorkspaceRun', 'runWorkspace', 'inspectWorkspaceRun', 'cancelWorkspaceRun', 'decideWorkspaceRun']
function mutateRun(file, change, expected) {
  copy(root => {
    const path = join(root, file)
    writeFileSync(path, change(readFileSync(path, 'utf8')))
    const result = run(root)
    assert.equal(result.ok, false, JSON.stringify(result))
    assert.equal(result.code, expected, JSON.stringify(result))
  })
}
test('run slice resolves all five actual facade operations to distinct owner callables', () => {
  const result = run(plugin)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.evidence.filter(entry => entry.path === facade).length, 5)
  assert.equal(result.evidence.filter(entry => entry.path === runOwner).length, 5)
})
test('run slice rejects discarded delegation and empty owners', () => {
  for (const symbol of runSymbols) {
    mutateRun(facade, source => source.replace(`return ${symbol}(`, `return undefined; ${symbol}Unused(`), 'WORKSPACE_RUN_USE_CASE_STILL_CENTRALIZED')
    mutateRun(facade, source => source.replace(`return ${symbol}(`, `return undefined; ${symbol}(`), 'WORKSPACE_RUN_USE_CASE_WIRING_MISSING')
  }
  mutateRun(runOwner, () => runSymbols.map(symbol => `export function ${symbol}() {}`).join('\n'), 'WORKSPACE_RUN_USE_CASE_OWNER_MISSING')
})
