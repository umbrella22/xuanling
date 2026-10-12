// Real DSH boot-graph browser gate. The shared helper launches an isolated
// profile and rejects failed processes, missing cases and historical reports.
import { runCanvasSuite } from '../../../../../test/blueprint/capabilities/canvas-suite.mjs'
export async function getCases(helpers) {
  return [{ id: 'B1', title: 'C-08/C-09: actual DSH canvas pointer/keyboard, CAS, run, refresh and blueprint isolation',
    contract: 'C-08/C-09', expect: 'pass', run: () => runCanvasSuite(helpers, 'browser') }]
}
