import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const plugin = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bp-tsx-loader-'))
  writeFileSync(join(root, 'package.json'), '{"type":"module"}')
  symlinkSync(join(plugin, 'node_modules'), join(root, 'node_modules'), 'dir')
  writeFileSync(
    join(root, 'automatic.tsx'),
    `import React from 'react'
export function Hooked({ value }: { value: string }) {
  const [text] = React.useState(value)
  return <section data-probe="automatic">{text}</section>
}`
  )
  writeFileSync(
    join(root, 'classic.tsx'),
    `/** @jsxRuntime classic */
/** @jsx seat.createElement */
/** @jsxFrag seat.Fragment */
import type React from 'react'
export function classic(seat: typeof React) {
  return function Hooked() {
    const [text] = seat.useState('classic')
    return <><span data-probe="classic">{text}</span></>
  }
}`
  )
  writeFileSync(
    join(root, 'probe.mjs'),
    `import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Hooked } from './automatic.tsx'
import { classic } from './classic.tsx'
assert.equal(renderToStaticMarkup(React.createElement(Hooked, { value: 'shared-hooks' })), '<section data-probe="automatic">shared-hooks</section>')
let calls = 0
const seat = { ...React, createElement(...args) { calls++; return React.createElement(...args) } }
assert.equal(renderToStaticMarkup(React.createElement(classic(seat))), '<span data-probe="classic">classic</span>')
assert.ok(calls >= 2, 'classic pragma must use caller React seat for element and fragment')
console.log('REAL_JSX_HOOKS_SHARED_IDENTITY_CLASSIC_SEAT')`
  )
  return root
}
function run(root, registration) {
  return spawnSync(process.execPath, ['--experimental-transform-types', ...(registration ? ['--import', registration] : []), join(root, 'probe.mjs')], {
    cwd: root,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) }
  })
}

test('native transform-types refuses actual TSX before loader registration', () => {
  const root = fixture()
  try {
    const result = run(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /ERR_UNKNOWN_FILE_EXTENSION/)
    assert.match(result.stderr, /automatic\.tsx/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
for (const copied of [false, true]) {
  test(`registered loader renders real JSX/hooks and classic React seat${copied ? ' from isolated child copy' : ''}`, () => {
    const root = fixture()
    try {
      let registration = join(plugin, 'scripts/test-tsx-register.mjs')
      if (copied) {
        mkdirSync(join(root, 'scripts'))
        for (const name of ['test-tsx-register.mjs', 'test-tsx-loader.mjs']) cpSync(join(plugin, 'scripts', name), join(root, 'scripts', name))
        registration = join(root, 'scripts/test-tsx-register.mjs')
      }
      const result = run(root, registration)
      assert.equal(result.error, undefined)
      assert.equal(result.signal, null)
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /REAL_JSX_HOOKS_SHARED_IDENTITY_CLASSIC_SEAT/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}
