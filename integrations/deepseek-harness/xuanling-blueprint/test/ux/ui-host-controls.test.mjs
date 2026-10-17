// Actual stylesheet installer and parsed control rules. Computed styles, native
// select keyboard input and four-theme visual acceptance remain main-owned.
import assert from 'node:assert/strict'
import test from 'node:test'
import postcss from 'postcss'
import { installCanvasStyles } from '../../src/client/shared/styles/styles.ts'

const marker = '/* Host controls: DSH primitives, scoped outside the graph. */'
function installedStyles() {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document'),
    elements = []
  globalThis.document = {
    getElementById: id => elements.find(element => element.id === id),
    createElement: type => ({ type }),
    head: { appendChild: element => elements.push(element) }
  }
  try {
    installCanvasStyles()
    installCanvasStyles()
    assert.equal(elements.length, 1, 'STYLE_INSTALLER_MUST_REMAIN_IDEMPOTENT')
    assert.equal(elements[0].id, 'xuanling-blueprint-canvas-css')
    return elements[0].textContent
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'document', descriptor)
    else delete globalThis.document
  }
}
const installed = installedStyles()
function rules() {
  assert.ok(installed.includes(marker), 'HOST_CONTROLS_SCOPED_CASCADE_MISSING')
  return postcss.parse(installed.slice(installed.indexOf(marker)))
}
const matching = (css, predicate) => {
  const found = []
  css.walkRules(rule => {
    if (predicate(rule.selector)) found.push(rule)
  })
  assert.ok(found.length, 'HOST_CONTROLS_RULE_MISSING')
  return found
}
const declaration = (css, predicate, prop) =>
  matching(css, predicate).flatMap(rule => rule.nodes.filter(node => node.type === 'decl' && node.prop === prop).map(node => node.value))

test('host controls C02 installer is idempotent and every appended control rule stays outside Flow', () => {
  assert.equal(installedStyles(), installed)
  const css = rules()
  css.walkRules(rule => {
    assert.ok(
      rule.selectors.every(part => part.trim().startsWith('.bp-workspace')),
      rule.selector
    )
    assert.doesNotMatch(rule.selector, /react-flow|\.bp-node(?![\w-])|\.bp-canvas(?![\w-])|\.bp-group|\.bp-reroute|:root|\bbody\b|\bhtml\b/)
  })
  css.walkDecls(node => {
    if (node.prop.startsWith('transition')) assert.doesNotMatch(node.value, /\ball\b/)
  })
})
test('host controls C03 checkbox inputs avoid text-control sizing and reduced motion disables control transitions', () => {
  const css = rules()
  const sizing = new Set(['width', 'min-width', 'max-width', 'height', 'min-height', 'max-height', 'padding', 'border-radius'])
  let textInputRules = 0
  css.walkRules(rule => {
    if (!rule.nodes.some(node => node.type === 'decl' && sizing.has(node.prop))) return
    for (const selector of rule.selectors) {
      if (!/\binput\b/.test(selector)) continue
      textInputRules++
      assert.doesNotMatch(selector.replaceAll('input:not([type=checkbox])', ''), /\binput\b/, `CHECKBOX_MUST_NOT_MATCH_TEXT_SIZING:${selector}`)
    }
  })
  assert.ok(textInputRules > 0, 'CHECKBOX_BOUNDARY_MUST_EXERCISE_TEXT_INPUT_RULES')
  const media = css.nodes.find(node => node.type === 'atrule' && node.name === 'media' && node.params === '(prefers-reduced-motion:reduce)')
  assert.ok(media)
  assert.ok(declaration(media, () => true, 'transition').includes('none'))
  assert.ok(declaration(media, s => s.includes('button:active'), 'transform').includes('none'))
})
