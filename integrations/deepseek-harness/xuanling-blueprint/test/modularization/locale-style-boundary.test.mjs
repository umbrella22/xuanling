import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { checkModularization } from '../../scripts/check-modularization.mjs'

const plugin = resolve(import.meta.dirname, '../..')

function sourceCopy(action) {
  const root = mkdtempSync(join(tmpdir(), 'bp-locale-style-boundary-'))
  try {
    cpSync(join(plugin, 'src'), join(root, 'src'), { recursive: true })
    cpSync(join(plugin, 'package.json'), join(root, 'package.json'))
    symlinkSync(join(plugin, 'node_modules'), join(root, 'node_modules'), 'dir')
    return action(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('W2.7 locale and style boundaries resolve canonical namespace owners', () => {
  const locale = checkModularization({ root: plugin, boundary: 'locale' })
  assert.equal(locale.ok, true, JSON.stringify(locale))
  assert.equal(locale.code, 'BOUNDARY_EXTRACTED', JSON.stringify(locale))
  for (const namespace of ['conversation', 'commands', 'interaction', 'resources', 'inspector', 'document'])
    assert.ok(
      locale.evidence.some(entry => entry.path.endsWith(`/${namespace}.ts`) || entry.path === `./${namespace}.ts`),
      namespace
    )

  const styles = checkModularization({ root: plugin, boundary: 'styles' })
  assert.equal(styles.ok, true, JSON.stringify(styles))
  assert.equal(styles.code, 'BOUNDARY_EXTRACTED', JSON.stringify(styles))
  for (const fragment of ['base.ts', 'canvas.ts', 'panel.ts', 'conversation.ts'])
    assert.ok(
      styles.evidence.some(entry => entry.path.endsWith(`/styles/${fragment}`)),
      fragment
    )
})

test('locale namespace mutations report key parity separately from parse and import failures', () => {
  sourceCopy(root => {
    const path = join(root, 'src/client/shared/i18n/conversation.ts')
    const source = readFileSync(path, 'utf8')
    const en = source.indexOf('export const en =')
    writeFileSync(path, `${source.slice(0, en)}${source.slice(en).replace(/  'conversation\.edgeReadonly':[^\n]*,\n/, '')}`)
    assert.equal(checkModularization({ root, boundary: 'locale' }).code, 'LOCALE_KEY_MISMATCH')

    const registry = join(root, 'src/client/shared/i18n/locales.ts')
    const registrySource = readFileSync(registry, 'utf8')
    writeFileSync(registry, `const = invalid syntax\n${registrySource}`)
    assert.equal(checkModularization({ root, boundary: 'locale' }).code, 'SOURCE_PARSE_ERROR')
    writeFileSync(registry, `import './missing-locale-namespace.ts'\n${registrySource}`)
    assert.equal(checkModularization({ root, boundary: 'locale' }).code, 'SOURCE_UNAVAILABLE')
  })
})

test('style fragment mutations report centralized and conversation wiring failures', () => {
  sourceCopy(root => {
    const registry = join(root, 'src/client/shared/styles/styles.ts')
    const source = readFileSync(registry, 'utf8')
    writeFileSync(registry, source.replace("import { canvasCss } from './canvas.ts'\n", ''))
    assert.equal(checkModularization({ root, boundary: 'styles' }).code, 'STYLE_FRAGMENT_CENTRALIZED')

    writeFileSync(registry, source)
    const feature = join(root, 'src/client/features/conversation/ui/conversation-styles.ts')
    const featureSource = readFileSync(feature, 'utf8')
    writeFileSync(feature, featureSource.replace("import { conversationCss } from '../../../shared/styles/conversation.ts'\n", ''))
    assert.equal(checkModularization({ root, boundary: 'styles' }).code, 'STYLE_CONVERSATION_WIRING_MISSING')
  })
})

test('locale runtime dictionaries retain exact key parity after namespace assembly', async () => {
  const { zh, en } = await import('../../src/client/shared/i18n/locales.ts')
  assert.equal(Object.keys(zh).length, 451)
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  for (const key of Object.keys(zh)) assert.equal(typeof zh[key], 'string', key)
  for (const key of Object.keys(en)) assert.equal(typeof en[key], 'string', key)
})
