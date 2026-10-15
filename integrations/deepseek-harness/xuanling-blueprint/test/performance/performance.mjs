// The runner pointer is registered by main. This module never substitutes a
// standalone React mount or a synthetic sample for real DSH/Edge measurement.
import { runCanvasSuite } from '../../../../../test/blueprint/capabilities/canvas-suite.mjs'
export async function getCases(helpers) {
  return [
    {
      id: 'PERF1',
      title: 'W3: actual 200-node/300-edge/20-resource canvas loads <=2000ms; 20 trusted pan/zoom paint p95 <=100ms',
      contract: 'C-09/C-11',
      expect: 'pass',
      run: () => runCanvasSuite(helpers, 'performance')
    }
  ]
}
