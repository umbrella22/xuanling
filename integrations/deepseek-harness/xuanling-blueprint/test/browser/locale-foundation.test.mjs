// W2 dictionary/type foundation only. Mounted panel propagation remains W3/W4.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { hasPnpmImporterDependency, readPnpmLock } from '../package/pnpm-lock.mjs'
import { fileURLToPath } from 'node:url'
import { RUN_STATES, ATTEMPT_STATES } from '../../src/persistence/records.ts'
import { defaultAriaLabelConfig } from '@xyflow/system'
import { BLUEPRINT_LOCALE, en, zh } from '../../src/client/locales.ts'
import { BUILTIN_NODE_CATALOG, nodeDisplayTitle, nodeKindTitle } from '../../src/client/node-catalog.ts'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const parameters = template => [...template.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort()
const translate =
  dict =>
  (key, params = {}) =>
    (dict[key] ?? key).replace(/\{(\w+)\}/g, (token, name) => (Object.hasOwn(params, name) ? String(params[name]) : token))

test('C-01 product dictionaries have identical nonempty zh/en keys and interpolation contracts', () => {
  assert.equal(BLUEPRINT_LOCALE, 'xuanlingBlueprint')
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort(), 'NO_MISSING_OR_EXTRA_LOCALE_KEY')
  for (const key of Object.keys(zh)) {
    assert.equal(typeof en[key], 'string', key)
    assert.ok(en[key].trim().length > 0 && zh[key].trim().length > 0, `EMPTY_TRANSLATION:${key}`)
    assert.deepEqual(parameters(zh[key]), parameters(en[key]), `PLACEHOLDER_PARITY:${key}`)
  }
})

test('C-01 typed namespace, standard props t and foundation descriptor coverage reject missing/extra/unknown keys', t => {
  const directory = mkdtempSync(resolve(tmpdir(), 'blueprint-locale-types-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const entry = resolve(directory, 'contract.ts')
  writeFileSync(
    entry,
    `
    import { en, zh } from ${JSON.stringify(resolve(packageRoot, 'src/client/locales.ts'))};
    import type { BlueprintLocaleProps, BlueprintLocaleKey } from ${JSON.stringify(resolve(packageRoot, 'src/client/locales.ts'))};
    import type { ViewMessageKey } from ${JSON.stringify(resolve(packageRoot, 'src/client/view-contract.ts'))};
    declare const props: BlueprintLocaleProps;
    props.t('panel.label');
    props.t('node.input.title');
    props.t('status.runAdmitted', { state: 'running' });
    // @ts-expect-error namespace must not become an untyped string translator
    props.t('not.a.blueprint.key');
    const foundation: Record<ViewMessageKey, string> = en;
    const dictionary: Record<BlueprintLocaleKey, string> = zh;
    // @ts-expect-error missing dictionary keys must be a compile error
    const incomplete: typeof dictionary = { 'panel.label': 'Wrong' };
    // @ts-expect-error extra dictionary keys must be a compile error
    const extra = { ...en, 'not.a.blueprint.key': 'Wrong' } satisfies typeof dictionary;
    void foundation; void incomplete; void extra;
  `
  )
  const result = spawnSync(
    resolve(packageRoot, 'node_modules/.bin/tsc'),
    [
      '--noEmit',
      '--skipLibCheck',
      '--strict',
      '--target',
      'es2023',
      '--lib',
      'es2023,dom',
      '--module',
      'esnext',
      '--moduleResolution',
      'bundler',
      '--allowImportingTsExtensions',
      entry
    ],
    { cwd: directory, encoding: 'utf8' }
  )
  assert.equal(result.status, 0, `LOCALE_TYPE_CONTRACT_FAILED:\n${result.stdout}\n${result.stderr}`)
})

test('C-02 catalog display translations leave user names and unknown kinds original', () => {
  for (const dict of [zh, en]) {
    const t = translate(dict)
    for (const node of BUILTIN_NODE_CATALOG) {
      assert.ok(Object.hasOwn(dict, node.titleKey), node.titleKey)
      assert.ok(Object.hasOwn(dict, node.descriptionKey), node.descriptionKey)
      assert.equal(nodeDisplayTitle({ kind: node.kind }, 1, t), `${dict[node.titleKey]} 2`)
    }
    const custom = '原名 / user title : {literal} '
    assert.equal(nodeDisplayTitle({ kind: 'agentTask', name: custom }, 0, t), custom)
    assert.equal(nodeDisplayTitle({ kind: 'input', name: '' }, 0, t), '', 'explicit empty user name is still user content')
    assert.equal(nodeKindTitle('future.kind/原样', t), 'future.kind/原样', 'no guessed localized label for unknown kind')
    const port = '用户.port/ raw : {x}'
    assert.equal(
      t('node.portAria', { nodeId: custom, port, direction: t('port.input'), kind: t('port.data') }),
      dict['node.portAria'].replace('{nodeId}', custom).replace('{direction}', dict['port.input']).replace('{kind}', dict['port.data']).replace('{port}', port)
    )
  }
})

test('C-01 every installed React Flow aria configuration seat has dictionary copy, including live-message parameters', () => {
  for (const key of Object.keys(defaultAriaLabelConfig)) {
    assert.ok(Object.hasOwn(zh, `flow.${key}`), `MISSING_REACT_FLOW_ARIA_KEY:${key}`)
    assert.ok(Object.hasOwn(en, `flow.${key}`), `MISSING_REACT_FLOW_ARIA_KEY:${key}`)
  }
  const t = translate(zh)
  assert.equal(t('flow.node.a11yDescription.ariaLiveMessage', { direction: t('flow.direction.left'), x: 12, y: -5 }), '节点向左移动。新位置：x 12，y -5')
})

test('C-01 every current durable Run and Attempt state has bilingual display copy; no speculative lifecycle states are introduced', () => {
  const known = [...new Set([...RUN_STATES, ...ATTEMPT_STATES])].sort()
  assert.deepEqual(
    Object.keys(zh)
      .filter(key => key.startsWith('state.'))
      .map(key => key.slice(6))
      .sort(),
    known
  )
  for (const state of known) assert.ok(Object.hasOwn(en, `state.${state}`), state)
})

test('C-01 locale/framework imports erase fully from the browser bootstrap runtime graph', () => {
  const locales = stripTypeScriptTypes(readFileSync(resolve(packageRoot, 'src/client/locales.ts'), 'utf8'), { mode: 'transform' })
  const bootstrap = stripTypeScriptTypes(readFileSync(resolve(packageRoot, 'src/client/index.ts'), 'utf8'), { mode: 'transform' })
  assert.equal(locales.includes('@deepseek-ai/dsh-client-ui-slots'), false, 'NAMESPACE_AUGMENTATION_IS_TYPE_ONLY')
  assert.equal(bootstrap.includes('@deepseek-ai/dsh-client-locale/client'), false, 'NO_SECOND_LOCALE_RUNTIME')
  const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'))
  const lock = readPnpmLock(packageRoot)
  for (const name of ['@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-slots']) {
    assert.equal(manifest.devDependencies[name], '0.2.1-alpha.4')
    assert.equal(manifest.dependencies?.[name], undefined, 'FRAMEWORK_TYPES_STAY_DEV_ONLY')
    assert.equal(hasPnpmImporterDependency(lock, 'devDependencies', name, manifest.devDependencies[name]), true)
  }
})

test('C-02 existing journey English status semantics remain exact; typed failure codes stay interpolation data', () => {
  assert.equal(en['panel.workspace'], 'Blueprint workspace')
  assert.equal(en['action.run'], 'Run')
  assert.equal(zh['action.run'], '运行')
  assert.equal(en['node.notRunning'], 'Not running')
  assert.equal(en['inspector.portTypesRequired'], 'Port types must be strings')
  assert.equal(en['inspector.editApplied'], 'Edit applied; host validates on Save.')
  assert.equal(en['inspector.invalidJsonRetained'], 'Invalid JSON; previous value retained.')
  assert.equal(en['canvas.noSpace'], 'No visible canvas space for a node. Pan/zoom or make room before adding.')
  assert.equal(en['canvas.measurementsPending'], 'Canvas measurements are not ready. Try adding after nodes render.')
  assert.equal(en['status.loading'], 'Loading configured library…')
  assert.equal(en['status.saved'], 'Saved host document.')
  assert.equal(en['status.loaded'], 'Loaded host document.')
  assert.equal(en['status.draftRestored'], 'Restored local document draft.')
  assert.equal(
    zh['status.recentRunUnavailable'],
    '无法保存最近的运行记录；持久运行仍保留在宿主。',
    'RUN_BINDING_WRITE_FAILURE_IS_NOT_A_READ_FAILURE_OR_LOST_DURABLE_RUN'
  )
  assert.equal(en['status.recentRunUnavailable'], 'Recent run binding unavailable; the durable run remains on the host.')
  assert.equal(translate(en)('status.runAdmitted', { state: 'running' }), 'Run admitted: running.')
  assert.equal(translate(en)('status.error', { code: 'blueprint/revision-conflict' }), 'Operation failed: blueprint/revision-conflict')
  assert.equal(zh['resource.noDescription'], '暂无简介')
  assert.equal(en['resource.noDescription'], 'No description')
})
