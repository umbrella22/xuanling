/** W1 runtime regression uses the existing artifact; it never builds or probes a profile. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')
for (const [script, reportName] of [
  ['artifact-loader.mjs', 'w1.1-artifact-loader-report.json'],
  ['artifact-slot-lifecycle.mjs', 'w1.2-artifact-slot-lifecycle-report.json']
]) {
  test(`production source/artifact runtime oracle: ${script}`, () => {
    const reportDir = mkdtempSync(join(tmpdir(), 'bp-artifact-runtime-'))
    try {
      const result = spawnSync(
        process.execPath,
        [
          '--experimental-transform-types',
          '--import',
          join(repository, 'integrations/deepseek-harness/xuanling-blueprint/scripts/test-tsx-register.mjs'),
          join(repository, 'test/blueprint/capabilities', script),
          '--report-dir',
          reportDir
        ],
        { cwd: repository, encoding: 'utf8' }
      )
      assert.equal(result.error, undefined)
      assert.equal(result.signal, null)
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
      const report = JSON.parse(readFileSync(join(reportDir, reportName), 'utf8'))
      assert.equal(report.passed, true)
      assert.equal(report.classification.real_host_gate, 'not-run')
      assert.ok(report.red.every(entry => entry.match))
      const artifact = report.green.artifactLifecycle.renderedSlots
      const source = report.green.sourceLifecycle?.renderedSlots ?? report.green.source.renderedSlots
      for (const rendered of [artifact, source]) {
        assert.deepEqual(rendered.map(entry => entry.name).sort(), ['conversation.view', 'main', 'sidebar.panellist'])
        assert.ok(rendered.every(entry => entry.rendered && entry.bytes > 0))
      }
      if (script === 'artifact-slot-lifecycle.mjs') {
        const embedded = report.red.find(entry => entry.label === 'production artifact embeds second React while retaining shared require')
        assert.equal(embedded?.observedCode, 'ARTIFACT_REACT_IDENTITY_MISMATCH')
      }
    } finally {
      rmSync(reportDir, { recursive: true, force: true })
    }
  })
}
