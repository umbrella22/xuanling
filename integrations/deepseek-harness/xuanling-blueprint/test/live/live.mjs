// C-11: importing a plugin or booting a host is never a live journey.
import { VerificationNotRunError } from '../../scripts/verify.mjs'
import { configuration, runIsolatedJourney } from './journey.mjs'

export async function getCases(helpers) {
  return [{
    id: 'L1', title: 'C-11: isolated DSH Run executes scoped Agent and forwards real nonce output',
    contract: 'C-11', expect: 'pass',
    run: async () => {
      const config = configuration(process.env, VerificationNotRunError)
      return await runIsolatedJourney(helpers, config)
    },
  }]
}
