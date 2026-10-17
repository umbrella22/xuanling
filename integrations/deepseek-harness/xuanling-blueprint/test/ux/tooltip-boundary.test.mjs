import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
const source = name => readFileSync(new URL(`../../src/client/${name}`, import.meta.url), 'utf8')
test('W2.3 tooltip and compact markup live in seat-preserving TSX views, browser effects stay in adapter', () => {
  assert.doesNotMatch(source('shared/controls/tooltips.ts'), /return React.createElement/)
  assert.doesNotMatch(source('features/compact/logic/compact-chrome.ts'), /return h\(/)
  for (const name of ['shared/controls/tooltip-view.tsx', 'features/compact/ui/compact-chrome-view.tsx']) {
    const view = source(name)
    assert.match(view, /@jsxRuntime classic/)
    assert.match(view, /@jsx React.createElement/)
    assert.doesNotMatch(view, /addEventListener|removeEventListener|ResizeObserver|getBoundingClientRect|document\.|window\.|useEffect/)
  }
  assert.match(source('adapters/browser/tooltip-browser-effects.ts'), /observer.disconnect\(\)/)
})
