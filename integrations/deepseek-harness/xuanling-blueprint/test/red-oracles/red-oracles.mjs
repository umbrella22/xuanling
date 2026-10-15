// N-RED suite (W1.2): red oracles for the registered minimal service. Every
// business method must return the exact typed failure
// `blueprint/capability-unavailable` through the real public service entry —
// these are the W1 "named unimplemented result" oracles that later
// implementation waves replace with behavior assertions (plan §10.2: red
// evidence proves the oracle works, never a feature green).
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'

export async function getCases(helpers) {
  const { packageRoot } = helpers
  const libIndex = join(packageRoot, 'lib', 'index.js')
  const { Context } = await import('@deepseek-ai/cordis')
  const mod = await import(libIndex)
  const service = new mod.default(new Context())

  const cases = []

  // Positive seam (not red): ping proves the service is live and bound.
  cases.push({
    id: 'R0',
    title: 'ping is live on the registered service (positive seam)',
    contract: 'C-01',
    expect: 'pass',
    run: async () => (await service.ping()).status === 'ok'
  })

  // Every wire method now has an implementation (W4.3/W5). The red collector
  // keeps its calibration contract by asserting each method's typed rejection
  // for MALFORMED input instead of capability-unavailable.
  const malformed = [
    {
      id: 'R1',
      contract: 'C-07',
      method: 'decide',
      args: { runId: 'missing-run', decisionId: 'd', action: 'approve', runtimeRoot: mkdtempSync('/tmp/bp-red-') },
      expectCode: 'blueprint/run-not-found'
    },
    {
      id: 'R2',
      contract: 'C-11',
      method: 'exportDefinition',
      args: { blueprintId: 'x', rootDir: '/nonexistent-root', runtimeRoot: mkdtempSync('/tmp/bp-red-') },
      expectCode: 'blueprint/export-failed'
    },
    { id: 'R3', contract: 'C-11', method: 'importDefinition', args: { archivePath: '/nonexistent-archive.tgz' }, expectCode: 'blueprint/import-failed' }
  ]
  for (const seed of malformed) {
    cases.push({
      id: seed.id,
      title: `${seed.method} rejects malformed input with typed ${seed.expectCode}`,
      contract: seed.contract,
      expect: 'red',
      redCode: seed.expectCode,
      run: async () => {
        const args = { ...seed.args }
        delete args.expectCode
        const value = await service[seed.method](args)
        const error = new Error(`method resolved with ${JSON.stringify(value)}`)
        error.code = 'unexpected/green'
        throw error
      }
    })
  }

  return cases
}
