import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { workflowHost } from './public-host-fixture.mjs'
import { echoDefinition, parentDefinition, save, check } from './child-fixtures.mjs'
import { readZip, writeZip } from '../../src/portability/zip.ts'
import { importBlueprint } from '../../src/portability/import.ts'
import { managedBrowser } from './browser-fixture.mjs'
import { selectStyledOption } from '../../../../../test/blueprint/capabilities/styled-control-entry.mjs'
import { authoringGuide } from '../../src/definition/authoring.ts'
import { loadDefinitionPackage } from '../../src/definition/persist.ts'
import { exportBlueprint } from '../../src/portability/export.ts'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const prefix = 'lib/blueprint-dependencies/'
// Recompute the transport manifest so rejection proves the pinned package
// contract, rather than only the ZIP integrity checksum.
function repack(entries) {
  const manifest = JSON.parse(entries.find(e => e.name === 'portability.json').data)
  manifest.files = Object.fromEntries(
    entries
      .filter(e => e.name !== 'portability.json')
      .map(e => [e.name, hash(e.data)])
      .sort(([a], [b]) => a.localeCompare(b))
  )
  manifest.closureDigest = hash(
    Object.entries(manifest.files)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([p, d]) => `${p}\0${d}\n`)
      .join('')
  )
  return writeZip(entries.map(e => (e.name === 'portability.json' ? { ...e, data: Buffer.from(JSON.stringify(manifest)) } : e)))
}
async function source(t) {
  const h = await workflowHost(t, { preset: 'danger-full-access' })
  const definition = echoDefinition('leaf')
  definition.resources.note = { kind: 'prompt', path: 'lib/note.txt' }
  const root = h.service.blueprintRoot('leaf')
  mkdirSync(join(root, 'lib'), { recursive: true })
  writeFileSync(join(root, 'lib/note.txt'), 'EXACT_PORTABLE_LEAF_BYTES')
  const leaf = await save(h.service, definition)
  const child = await save(h.service, parentDefinition(leaf, 'child'))
  const parent = await save(h.service, parentDefinition(child))
  const exported = await h.service.exportDefinition({ blueprintId: 'parent' })
  return { h, leaf, child, parent, exported, archive: Buffer.from(exported.archiveBase64, 'base64') }
}

test('export/import carries the full fixed child closure and runs without installing or rebinding same-name children', async t => {
  const { h, child, parent, archive, exported } = await source(t)
  const entries = readZip(archive)
  assert.equal(entries.filter(e => e.name.startsWith(prefix) && e.name.endsWith('/blueprint.json')).length, 2, 'export must include both pinned dependencies')
  assert.ok(entries.some(e => e.name.startsWith(prefix) && e.data.toString() === 'EXACT_PORTABLE_LEAF_BYTES'))
  const dst = await workflowHost(t, { preset: 'danger-full-access' })
  const collision = echoDefinition('child')
  collision.name = 'Unrelated local child'
  const local = await save(dst.service, collision)
  await dst.service.importDefinition({ blueprintId: 'parent', archiveBase64: exported.archiveBase64 })
  const imported = await dst.service.loadDefinition({ blueprintId: 'parent' })
  assert.equal((await check(dst.service, imported)).canStart, true)
  const started = await dst.service.startRun({
    blueprintId: 'parent',
    expectedRevision: imported.documentRevision,
    inputJson: '{"value":"portable"}',
    requestId: 'portable'
  })
  const runtime = await dst.service.configuredRuntime()
  await runtime.jobs.get(started.runId)
  const record = await runtime.store.get(started.runId)
  assert.equal(record.state, 'succeeded')
  assert.equal(record.attempts.find(a => a.nodeId === 'out').result.outcome.value.value, 'portable')
  assert.equal((await runtime.store.listRunIds()).length, 3)
  assert.equal((await dst.service.loadDefinition({ blueprintId: 'child' })).documentRevision, local.documentRevision)
  assert.equal(existsSync(dst.service.blueprintRoot('leaf')), false)
  assert.equal((await h.service.loadDefinition({ blueprintId: 'parent' })).documentRevision, parent.documentRevision)
  assert.equal((await h.service.loadDefinition({ blueprintId: 'child' })).documentRevision, child.documentRevision)
  const second = await dst.service.exportDefinition({ blueprintId: 'parent' })
  assert.equal(second.closureDigest, exported.closureDigest, 'portable re-export preserves exact definitions and resources')
})

test('an unresolved child blocks export instead of producing a broken portable archive', async t => {
  const h = await workflowHost(t)
  await save(h.service, parentDefinition({ blueprintId: 'missing', documentRevision: 'f'.repeat(64) }))
  await assert.rejects(h.service.exportDefinition({ blueprintId: 'parent' }), { code: 'blueprint/export-failed' })
})

for (const damage of ['missing', 'modified', 'wrong-id']) {
  test(`import rejects ${damage} child before creating the destination even with a valid transport digest`, async t => {
    const { h, archive } = await source(t)
    const entries = readZip(archive)
    // Supply canonical dependency bytes independently of the export feature,
    // so old import must fail this assertion for accepting an invalid closure.
    for (const id of ['leaf', 'child']) {
      const snapshot = loadDefinitionPackage(h.service.blueprintRoot(id))
      const base = `${prefix}${snapshot.document.documentRevision}/`
      if (!entries.some(e => e.name === `${base}blueprint.json`)) {
        entries.push({ name: `${base}blueprint.json`, data: Buffer.from(snapshot.document.definitionJson) })
        for (const [name, data] of snapshot.files) entries.push({ name: base + name, data })
      }
    }
    const nested = entries.find(e => e.name.startsWith(prefix) && e.name.endsWith('/blueprint.json'))
    assert.ok(nested, 'closure bytes must exist before exercising the import oracle')
    let changed = entries
    if (damage === 'missing') changed = entries.filter(e => !e.name.startsWith(nested.name.slice(0, -'blueprint.json'.length)))
    else {
      const doc = JSON.parse(nested.data)
      doc[damage === 'wrong-id' ? 'id' : 'name'] = 'changed-after-pin'
      nested.data = Buffer.from(JSON.stringify(doc))
    }
    const destination = join(h.root, 'not-created', damage)
    assert.throws(() => importBlueprint(repack(changed), destination), { code: 'PORTABILITY_CONFLICT' })
    assert.equal(existsSync(join(h.root, 'not-created')), false)
  })
}

test('imported bundled pins remain inspectable through the production composition UI without a global child', async t => {
  const { exported } = await source(t)
  const dst = await workflowHost(t)
  await dst.service.importDefinition({ blueprintId: 'parent', archiveBase64: exported.archiveBase64 })
  const parent = await dst.service.loadDefinition({ blueprintId: 'parent' })
  const pin = JSON.parse(parent.definitionJson).graph.nodes.find(n => n.kind === 'blueprintCall').blueprintRef
  const view = await dst.service.inspectBlueprintReference({ ...pin, ownerBlueprintId: 'parent' })
  assert.equal(view.documentRevision, pin.documentRevision)
  assert.deepEqual(view.inputs, { value: 'string' })
  const { page, errors } = await managedBrowser(t, 'composition-ui.fixture.ts', dst.service)
  await selectStyledOption(page, page.locator('[data-bp-select="blueprint"]'), 'parent')
  await page.locator('.react-flow__node[data-id="call"] .bp-node-title').click()
  await page.locator(`[data-bp-child-candidate="${pin.documentRevision}"]`).waitFor()
  await page.locator('[data-bp-child-preview]').click()
  await page.locator('[data-bp-child-preview-graph]').waitFor()
  await page.locator('[data-bp-child-preview-back]').click()
  assert.equal(await page.locator('[data-bp-child-apply]').isDisabled(), true)
  assert.deepEqual(errors, [])
})

test('generated Agent examples explicitly opt into managed completion and describe fixed child calls', () => {
  const guide = authoringGuide()
  assert.ok(guide.executableNodeKinds.includes('blueprintCall'))
  assert.equal(guide.example.definition.graph.nodes.find(n => n.kind === 'agentTask').interaction, 'managed')
  assert.match(guide.instructions, /documentRevision/)
  assert.match(guide.example.files[0].text, /structured_output/)
})

test('shared child resources are materialized and repinned bottom-up without editing source files', async t => {
  const h = await workflowHost(t)
  const skillRoot = join(h.root, 'source-skills')
  mkdirSync(join(skillRoot, 'review', 'references'), { recursive: true })
  writeFileSync(join(skillRoot, 'review', 'SKILL.md'), '---\nname: review\ndescription: Review fixture\n---\n# Review\n')
  writeFileSync(join(skillRoot, 'review', 'references', 'rules.txt'), 'PORTABLE_SHARED_RULES')
  h.service.config.skillRoots = [{ rootId: 'shared', rootPath: skillRoot }]
  const definition = echoDefinition('leaf')
  definition.resources.review = { kind: 'skill', source: { kind: 'shared', rootId: 'shared', path: 'review' } }
  const leaf = await save(h.service, definition)
  const child = await save(h.service, parentDefinition(leaf, 'child'))
  const parent = await save(h.service, parentDefinition(child))
  const before = readFileSync(join(h.service.blueprintRoot('leaf'), 'blueprint.json'))
  const exported = await h.service.exportDefinition({ blueprintId: 'parent' })
  const entries = readZip(Buffer.from(exported.archiveBase64, 'base64'))
  const packagedRoot = JSON.parse(entries.find(e => e.name === 'blueprint.json').data)
  const childPin = packagedRoot.graph.nodes.find(n => n.blueprintRef).blueprintRef
  assert.notEqual(childPin.documentRevision, child.documentRevision)
  const packagedChild = JSON.parse(entries.find(e => e.name === `${prefix}${childPin.documentRevision}/blueprint.json`).data)
  const leafPin = packagedChild.graph.nodes.find(n => n.blueprintRef).blueprintRef
  assert.notEqual(leafPin.documentRevision, leaf.documentRevision)
  const packagedLeaf = JSON.parse(entries.find(e => e.name === `${prefix}${leafPin.documentRevision}/blueprint.json`).data)
  assert.deepEqual(packagedLeaf.resources.review, { kind: 'skill', path: 'lib/skills/review' })
  assert.equal(
    entries.find(e => e.name === `${prefix}${leafPin.documentRevision}/lib/skills/review/references/rules.txt`).data.toString(),
    'PORTABLE_SHARED_RULES'
  )
  assert.ok(readFileSync(join(h.service.blueprintRoot('leaf'), 'blueprint.json')).equals(before))
  assert.equal((await h.service.loadDefinition({ blueprintId: 'parent' })).documentRevision, parent.documentRevision)
  const dst = await workflowHost(t)
  await dst.service.importDefinition({ blueprintId: 'parent', archiveBase64: exported.archiveBase64 })
  assert.equal((await check(dst.service, await dst.service.loadDefinition({ blueprintId: 'parent' }))).canStart, true)
  assert.equal((await dst.service.exportDefinition({ blueprintId: 'parent' })).closureDigest, exported.closureDigest)
  assert.throws(
    () =>
      exportBlueprint(h.service.blueprintRoot('parent'), {
        roots: h.service.config.skillRoots,
        loadReference: ref => h.service.documents.loadRevisionPackage(ref.blueprintId, h.service.blueprintRoot(ref.blueprintId), ref.documentRevision),
        scanForSecrets: text => (text.includes('PORTABLE_SHARED_RULES') ? ['fixture-canary'] : [])
      }),
    { code: 'SENSITIVE_EXPORT_BLOCKED' }
  )
})

test('an imported package can be called from another parent and its descendants remain portable', async t => {
  const { exported } = await source(t)
  const dst = await workflowHost(t)
  await dst.service.importDefinition({ blueprintId: 'parent', archiveBase64: exported.archiveBase64 })
  const imported = await dst.service.loadDefinition({ blueprintId: 'parent' })
  const wrapper = await save(dst.service, parentDefinition(imported, 'wrapper'))
  assert.equal((await check(dst.service, wrapper)).canStart, true)
  const outer = await dst.service.exportDefinition({ blueprintId: 'wrapper' })
  const third = await workflowHost(t)
  await third.service.importDefinition({ blueprintId: 'wrapper', archiveBase64: outer.archiveBase64 })
  assert.equal((await check(third.service, await third.service.loadDefinition({ blueprintId: 'wrapper' }))).canStart, true)
  assert.equal((await third.service.listDefinitions()).definitions.length, 1)
})

test('a corrupt bundled pin cannot fall back to an identical local child or start a Run', async t => {
  const { exported, child, h } = await source(t)
  const entries = readZip(Buffer.from(exported.archiveBase64, 'base64'))
  const root = h.service.blueprintRoot('damaged')
  mkdirSync(root, { recursive: true })
  for (const entry of entries.filter(e => e.name !== 'portability.json')) {
    const file = join(root, entry.name)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, entry.data)
  }
  const parent = JSON.parse(readFileSync(join(root, 'blueprint.json')))
  parent.id = 'damaged'
  writeFileSync(join(root, 'blueprint.json'), JSON.stringify(parent))
  const path = join(root, prefix, child.documentRevision, 'blueprint.json')
  const changed = JSON.parse(readFileSync(path))
  changed.name = 'Corrupted bundle'
  writeFileSync(path, JSON.stringify(changed))
  const document = await h.service.loadDefinition({ blueprintId: 'damaged' })
  assert.equal((await check(h.service, document)).canStart, false)
  await assert.rejects(h.service.inspectBlueprintReference({ blueprintId: 'child', documentRevision: child.documentRevision, ownerBlueprintId: 'damaged' }), {
    code: 'blueprint/reference-unavailable'
  })
  await assert.rejects(
    h.service.startRun({ blueprintId: 'damaged', expectedRevision: document.documentRevision, inputJson: '{"value":"echo"}', requestId: 'damaged' }),
    { code: 'blueprint/preflight-blocked' }
  )
  assert.equal((await (await h.service.configuredRuntime()).store.listRunIds()).length, 0)
})
