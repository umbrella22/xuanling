/** Explicit test-only registration; production and browser bundles do not import it. */
import { register } from 'node:module'
register('./test-tsx-loader.mjs', import.meta.url)
