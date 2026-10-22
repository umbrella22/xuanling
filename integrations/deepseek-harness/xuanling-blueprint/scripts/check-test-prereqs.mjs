#!/usr/bin/env node
// Fail fast, with the fix, when the full test suite's environment is missing.
//
// The suite exercises the built bundle (`lib/`), the isolated probe harness at
// `<repo>/test/blueprint` (which owns Playwright) and Playwright's `msedge`
// channel. Without them dozens of unrelated-looking failures appear instead of
// one actionable message. CI prepares all three before `pnpm test`.
//
// Set BP_TEST_SKIP_PREREQS=1 to bypass, e.g. when running a known subset.

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.env.BP_TEST_SKIP_PREREQS === '1') process.exit(0)

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = resolve(PACKAGE_ROOT, '..', '..', '..')
const HARNESS = join(REPO_ROOT, 'test', 'blueprint')
const problems = []

const missingBundles = ['lib/index.js', 'lib/client.js', 'lib/typert.host.js'].filter(file => !existsSync(join(PACKAGE_ROOT, file)))
if (missingBundles.length) problems.push(`built bundle missing (${missingBundles.join(', ')}): run \`pnpm run build\``)

let playwright = false
try {
  createRequire(join(HARNESS, 'package.json')).resolve('playwright')
  playwright = true
} catch {
  problems.push(`Playwright not installed in the test harness: run \`pnpm install --frozen-lockfile\` in ${HARNESS}`)
}

function edgeCandidates() {
  if (process.platform === 'darwin') return ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
  if (process.platform === 'win32')
    return [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']]
      .filter(base => base !== undefined)
      .map(base => join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
  return ['/opt/microsoft/msedge/msedge']
}
if (!edgeCandidates().some(path => existsSync(path)))
  problems.push(
    playwright
      ? `Microsoft Edge (Playwright channel "msedge") not found: run \`npx playwright install msedge\` in ${HARNESS}`
      : 'Microsoft Edge (Playwright channel "msedge") not found: install the harness first, then run `npx playwright install msedge` there'
  )

if (problems.length) {
  console.error('Blueprint test prerequisites are missing:')
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error('Set BP_TEST_SKIP_PREREQS=1 to run anyway.')
  process.exit(1)
}
