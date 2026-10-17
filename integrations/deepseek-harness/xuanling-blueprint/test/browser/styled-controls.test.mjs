import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createBlueprintPanel } from '../../src/client/features/authoring/ui/panel/panel-composition.tsx'
import { en } from '../../src/client/shared/i18n/locales.ts'

const t = (key, params = {}) => en[key].replace(/\{([^}]+)\}/g, (_, name) => String(params[name] ?? `{${name}}`))
test('production panel uses a styled combobox and no native confirmation entrypoints', () => {
  const Panel = createBlueprintPanel({ hostLink: undefined, storage: undefined })
  const html = renderToStaticMarkup(React.createElement(Panel, { t }))
  assert.doesNotMatch(html, /<select\b/, 'Blueprint library must expose the themed combobox rather than a native select')
  assert.match(html, /role="combobox"/)
  const source = readFileSync(new URL('../../src/client/features/authoring/ui/panel/panel-composition.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /window\.confirm\(/, 'switch/new/delete must use the in-app confirmation')
})
