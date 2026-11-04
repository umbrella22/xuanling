// Contract for the DSH dialog shells that host the authoring panel's share/reuse
// body and the blueprint rename prompt. Static markup only; panel wiring and
// browser interactions stay with the main acceptance tests.
import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { en } from '../../src/client/shared/i18n/locales.ts'
import { LibraryReuseDialog, RenameBlueprintDialog } from '../../src/client/features/authoring/ui/panel/library-dialogs.tsx'

const t = key => en[key] ?? key
const render = element => renderToStaticMarkup(element)

test('library reuse dialog renders the DSH dialog grammar and all three sections', () => {
  const workspace = {
    host: { extractTemplate: () => {} },
    busy: false,
    blueprintId: null,
    library: { kind: 'global' },
    perform: () => {}
  }
  const markup = render(React.createElement(LibraryReuseDialog, { React, t, workspace, onClose: () => {} }))
  assert.match(markup, /^<div class="bp-dialog-backdrop">/)
  assert.match(markup, /role="dialog" aria-modal="true" aria-labelledby="bp-library-dialog-title"/)
  assert.match(markup, /class="bp-dialog" data-bp-library-dialog="true"/)
  assert.match(markup, /class="bp-dialog-head"/)
  assert.match(markup, new RegExp(`class="bp-dialog-title">${en['library.reuse']}<`))
  assert.match(markup, /class="bp-dialog-close" data-bp-dialog-close="true" aria-label="Cancel"/)
  assert.match(markup, /class="bp-dialog-content"/)
  assert.ok(markup.includes(en['library.shareHelp']))
  // The moved body keeps its own hooks and is grouped under locale-key headings.
  assert.equal((markup.match(/data-bp-library-actions="true"/g) ?? []).length, 1)
  const titles = markup.match(/class="bp-dialog-section-title"/g) ?? []
  assert.equal(titles.length, 3)
  for (const key of ['library.exportSection', 'library.templateSection', 'library.agentSection'])
    assert.ok(markup.includes(`class="bp-dialog-section-title">${en[key]}<`), key)
  assert.match(markup, /class="bp-dialog-section" data-bp-preparation-parameters="true"/)
  assert.match(markup, /class="bp-dialog-row"/)
  assert.match(markup, new RegExp(`class="bp-dialog-button bp-dialog-button-primary" disabled="">${en['library.prepareTemplate']}<`))
})

test('rename dialog prompts for the blueprint name and gates unchanged input', () => {
  const markup = render(React.createElement(RenameBlueprintDialog, { React, t, initialValue: 'Alpha', onCancel: () => {}, onConfirm: () => {} }))
  assert.match(markup, /class="bp-dialog-backdrop"/)
  assert.match(markup, /role="dialog" aria-modal="true" aria-labelledby="bp-rename-dialog-title"/)
  assert.match(markup, /class="bp-dialog bp-dialog-sm" data-bp-rename-dialog="true"/)
  assert.match(markup, new RegExp(`class="bp-dialog-title">${en['document.name']}<`))
  assert.match(markup, /class="bp-dialog-text" data-bp-rename-input="true" aria-label="Blueprint name"/)
  assert.match(markup, /data-bp-rename-cancel="true">Cancel</)
  const confirm = /data-bp-rename-confirm="true" disabled="">Confirm</.exec(markup)
  assert.ok(confirm, 'unchanged value keeps confirm disabled')

  const empty = render(React.createElement(RenameBlueprintDialog, { React, t, initialValue: '', onCancel: () => {}, onConfirm: () => {} }))
  assert.match(empty, /data-bp-rename-confirm="true" disabled="">Confirm</)
})
