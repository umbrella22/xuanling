import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { parseAst } from 'vite/rolldown/parseAst'
import { blueprintIcon } from '../../src/client/shared/icons/icons.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const names =
  'undo redo save run cancel pan select library inspector more files view tools appearance layout node input output condition join copy cut delete pin collapse expand chevron check refresh chevron-left grip import export keyboard minimap motion unknown-icon'.split(
    ' '
  )

test('icon characterization preserves every existing path, SVG style and accessibility attribute', () => {
  const rendered = names.map(name => [name, renderToStaticMarkup(blueprintIcon(React, name))])
  assert.equal(createHash('sha256').update(JSON.stringify(rendered)).digest('hex'), '7de0b07e6b41564c0ab4fae2c39aeaadf500d529e311f9c1a9b387be38e4b8b5')
  const unknown = blueprintIcon(React, 'unknown-icon')
  assert.equal(unknown.props.children.props.d, blueprintIcon(React, 'node').props.children.props.d)
  assert.equal(unknown.props['data-bp-icon'], 'unknown-icon')
})

test('icon renderer uses only the supplied React seat for both elements', () => {
  const calls = []
  const seat = {
    createElement: (type, props, ...children) => {
      calls.push(type)
      return { type, props, children }
    }
  }
  const tree = blueprintIcon(seat, 'more')
  assert.deepEqual(calls, ['path', 'svg'])
  assert.equal(tree.props.strokeWidth, 3)
  assert.equal(tree.props['aria-hidden'], true)
  assert.equal(tree.children[0].type, 'path')
})

test('icon registry and markup no longer share the compatibility facade', async () => {
  const facade = readFileSync(resolve(root, 'src/client/shared/icons/icons.ts'), 'utf8')
  const ast = parseAst(facade, { lang: 'ts', sourceType: 'module' })
  assert.equal(
    ast.body.some(node => node.type === 'VariableDeclaration'),
    false,
    'ICONS_REGISTRY_STILL_CENTRALIZED'
  )
  assert.equal(facade.includes('createElement'), false, 'ICONS_MARKUP_STILL_CENTRALIZED')
  const source = readFileSync(resolve(root, 'src/client/shared/icons/icon-model.ts'), 'utf8')
  const modelAst = parseAst(source, { lang: 'ts', sourceType: 'module' })
  assert.equal(
    modelAst.body.some(node => node.type === 'ImportDeclaration'),
    false,
    'ICON_MODEL_HAS_DEPENDENCIES'
  )
  const { iconProjection } = await import('../../src/client/shared/icons/icon-model.ts')
  for (const name of names) {
    const model = iconProjection(name)
    const tree = blueprintIcon(React, name)
    assert.equal(model.path, tree.props.children.props.d)
    assert.equal(model.strokeWidth, tree.props.strokeWidth)
  }
})
