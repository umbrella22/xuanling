// N-SECURITY suite (plan §10.2), scoped. Scope 'resources' carries the
// resource admission oracle (T16) and validates the shipped example blueprint
// (a complete, side-effect-free fixture) against the real codec/validator.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export async function getCases(helpers) {
  const scope = helpers.scope ?? 'all'
  const cases = []

  if (scope === 'resources' || scope === 'all') {
    const admission = await import(join(helpers.packageRoot, 'lib', 'resource-admission.js'))
    const def = await import(join(helpers.packageRoot, 'lib', 'definition.js'))

    cases.push({
      id: 'T16-S1',
      title: 'T16: resource admission rejects hostile refs without rewriting them',
      contract: 'C-16',
      expect: 'pass',
      run: () => {
        const issues = [
          ...admission.admitResourceRef('bad1', { kind: 'agent', path: '../outside/x.md' }),
          ...admission.admitResourceRef('bad2', { kind: 'agent', path: 'lib/con/prn.md' }),
          ...admission.admitResources({
            a: { kind: 'agent', path: 'lib/agents/Reviewer.md' },
            b: { kind: 'agent', path: 'lib/agents/reviewer.md' }
          })
        ]
        const codes = issues.map(i => i.code)
        return { ok: codes.includes('path-escape') && codes.includes('reserved-path') && codes.includes('case-conflict'), detail: JSON.stringify(codes) }
      }
    })

    const examplePath = join(helpers.packageRoot, 'examples', 'code-review', 'blueprint.json')
    cases.push({
      id: 'T16-S2',
      title: 'T16: the shipped example blueprint is valid and admission-clean (no secrets, no escapes)',
      contract: 'C-02',
      expect: 'pass',
      run: () => {
        if (!existsSync(examplePath)) throw new Error(`example blueprint missing: ${examplePath}`)
        const text = readFileSync(examplePath, 'utf8')
        const definition = def.decodeDefinition(text)
        def.validateDefinition(definition)
        const issues = admission.admitResources(definition.resources)
        if (issues.length > 0) throw new Error(`example blueprint admission issues: ${JSON.stringify(issues)}`)
        const canary = helpers.scanForSecrets(text)
        if (canary.length > 0) throw new Error(`example blueprint carries secret canaries: ${canary.join(', ')}`)
        return true
      }
    })
  }

  if (scope === 'host' || scope === 'all') {
    const { builtScriptPolicyCases } = await import('../host/script-policy.mjs')
    const adapter = await import(join(helpers.packageRoot, 'lib', 'tool-adapter.js'))
    cases.push({
      id: 'T16-H1',
      title: 'T16: effective tool allowlist is the strict intersection (host policy ∩ blueprint ∩ node)',
      contract: 'C-16',
      expect: 'pass',
      run: () => {
        const all = adapter.effectiveToolAllowlist(null, ['t1', 't2', 't3'], null)
        const policyNarrow = adapter.effectiveToolAllowlist(['t2', 't3', 't4'], ['t1', 't2', 't3'], null)
        const nodeNarrow = adapter.effectiveToolAllowlist(null, ['t1', 't2', 't3'], ['t1'])
        const denied = adapter.effectiveToolAllowlist([], ['t1'], null)
        return (
          JSON.stringify(all) === '["t1","t2","t3"]' &&
          JSON.stringify(policyNarrow) === '["t2","t3"]' &&
          JSON.stringify(nodeNarrow) === '["t1"]' &&
          denied.length === 0
        )
      }
    })
    const scripts = await builtScriptPolicyCases(helpers.packageRoot)
    cases.push({
      id: 'T16-H2',
      title: 'T16: hostile script content is data — host tools.execute settles failed/timeout and never retries',
      contract: 'C-16',
      expect: 'pass',
      run: async () => {
        for (const id of ['HOST-SCRIPT-FAILED', 'HOST-SCRIPT-INTERNAL-TIMEOUT']) {
          const result = await scripts.find(c => c.id === id).run()
          if (result.ok !== true) return false
        }
        return true
      }
    })
    cases.push(...scripts)
  }

  if (scope === 'portability' || scope === 'all') {
    const port = await import(join(helpers.packageRoot, 'lib', 'portability.js'))
    cases.push({
      id: 'T16-P1',
      title: 'T16: hostile archives are rejected by the validator before any extraction',
      contract: 'C-16',
      expect: 'pass',
      run: () => {
        // Build a tiny valid zip, then corrupt each structural invariant.
        const entries = [
          { name: 'blueprint.json', data: Buffer.from('{}') },
          { name: 'portability.json', data: Buffer.from('{}') }
        ]
        const good = port.writeZip(entries)
        const verdicts = []
        const tryRead = buf => {
          try {
            port.readZip(buf)
            return 'accepted'
          } catch (error) {
            return error?.code
          }
        }
        verdicts.push(tryRead(good.slice(0, good.length - 5))) // truncated
        verdicts.push(tryRead(port.writeZip([{ name: '../x', data: Buffer.from('x') }])))
        verdicts.push(
          tryRead(
            port.writeZip([
              { name: 'a', data: Buffer.from('x') },
              { name: 'a', data: Buffer.from('y') }
            ])
          )
        )
        const bomb = port.writeZip([{ name: 'bomb', data: Buffer.alloc(1024) }])
        try {
          port.readZip(bomb, { maxEntries: 10, maxTotalUncompressed: 100, maxNameLength: 100 })
          verdicts.push('accepted')
        } catch (error) {
          verdicts.push(error?.code)
        }
        return verdicts.every(v => v === 'ARCHIVE_UNSAFE')
      }
    })
  }

  if (scope === 'ui' || scope === 'all') {
    const model = await import(join(helpers.packageRoot, 'lib', 'client-model.js'))
    cases.push({
      id: 'T16-U1',
      title: 'T16: run/stream projections surface no secret-bearing raw payloads and no fabricated success',
      contract: 'C-16',
      expect: 'pass',
      run: () => {
        const m = new model.BlueprintClientModel()
        m.applySnapshot({ runId: 'r1', state: 'running', seq: 1, definitionRevision: 'rev', attempts: [], logTail: [] })
        m.applyEvent({ seq: 2, kind: 'provider-note', detail: { authorization: 'Bearer BP_SECRET_CANARY' } })
        const serialized = JSON.stringify(m.view)
        const leaked = helpers.scanForSecrets(serialized)
        const stateHonest = m.view.state === 'running'
        return leaked.length === 0 && stateHonest
      }
    })
  }

  if (cases.length === 0) {
    throw new Error(`security: scope "${scope}" has no registered cases yet`)
  }
  return cases
}
