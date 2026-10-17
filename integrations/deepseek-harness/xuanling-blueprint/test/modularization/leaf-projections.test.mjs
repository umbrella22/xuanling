import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { parseAst } from 'vite/rolldown/parseAst'
import { renderToStaticMarkup } from 'react-dom/server'
import { projectAttemptDiagnostics, renderAttemptDiagnostics } from '../../src/client/shared/diagnostics/diagnostics.ts'
import { en, zh } from '../../src/client/shared/i18n/locales.ts'

const plugin = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
function exportedModule(path, symbol) {
  const ast = parseAst(readFileSync(path, 'utf8'), { lang: 'ts', sourceType: 'module' }, path)
  for (const entry of ast.body) {
    if (entry.type !== 'ExportNamedDeclaration') continue
    if (entry.declaration?.id?.name === symbol) return { path, ast }
    const specifier = entry.specifiers?.find(item => item.exported.name === symbol)
    if (specifier && entry.source) return exportedModule(resolve(dirname(path), entry.source.value), specifier.local.name)
  }
  assert.fail(`Public diagnostics projection cannot be resolved: ${symbol}`)
}

test('diagnostic projection public export resolves to a module without React, DOM or rendering dependencies', () => {
  const entry = exportedModule(resolve(plugin, 'src/client/shared/diagnostics/diagnostics.ts'), 'projectAttemptDiagnostics')
  const visited = new Set()
  const inspect = ({ path, ast }) => {
    if (visited.has(path)) return
    visited.add(path)
    for (const node of ast.body) {
      if (!node.source || node.importKind === 'type' || node.exportKind === 'type') continue
      if (node.specifiers?.length && node.specifiers.every(item => item.importKind === 'type' || item.exportKind === 'type')) continue
      const dependency = node.source.value
      assert.doesNotMatch(dependency, /^(react|react-dom|@xyflow)(\/|$)|(?:panel|workspace|remote|view)\.(ts|tsx)$/, 'DIAGNOSTICS_MODEL_DEPENDS_ON_VIEW')
      if (!dependency.startsWith('.')) continue
      const target = resolve(dirname(path), dependency)
      inspect({ path: target, ast: parseAst(readFileSync(target, 'utf8'), { lang: 'ts', sourceType: 'module' }, target) })
    }
  }
  inspect(entry)
})

test('diagnostics preserve display values, order and zero issue count across locales without exposing malformed raw fields', () => {
  const digest = 'a'.repeat(64)
  const value = {
    status: 'available',
    input: { type: 'null', bytes: 0, sha256: digest },
    resourceDigests: { '名称 <one>': digest },
    tools: { effectiveNames: ['tool.<raw>', 'tool.二'], denials: [] },
    acceptance: { code: 'valid', issueCount: 0 }
  }
  const before = structuredClone(value)
  for (const dict of [en, zh]) {
    const t = key => dict[key]
    const html = renderToStaticMarkup(renderAttemptDiagnostics(value, t))
    const keys = [...html.matchAll(/data-bp-diagnostic="([^"]+)"/g)].map(match => match[1])
    assert.deepEqual(keys, ['input', 'resources', 'model', 'tools', 'denials', 'acceptance'])
    for (const text of [`null · 0 bytes · ${digest}`, '名称 &lt;one&gt;', 'tool.&lt;raw&gt;', 'tool.二', 'valid · 0', dict['diagnostics.noModel']])
      assert.ok(html.includes(text), text)
    for (const malformed of [undefined, null, [], { ...value, rawBody: 'PRIVATE_DIAGNOSTIC_CANARY' }, { ...value, tools: { effectiveNames: [false] } }]) {
      assert.equal(
        renderToStaticMarkup(renderAttemptDiagnostics(malformed, t)),
        `<section data-bp-diagnostics="unavailable"><h4>${dict['diagnostics.title']}</h4><p>${dict['diagnostics.unavailable']}</p></section>`
      )
    }
  }
  const projected = projectAttemptDiagnostics(value)
  projected.tools.effectiveNames.push('consumer-only')
  assert.deepEqual(value, before)
})
