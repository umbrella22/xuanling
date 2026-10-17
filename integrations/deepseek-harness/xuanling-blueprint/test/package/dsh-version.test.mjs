import assert from 'node:assert/strict'
import test from 'node:test'
import { supportsDshVersion, DSH_COMPATIBILITY_RANGE } from '../../../../../test/blueprint/capabilities/dsh-version.mjs'

test('DSH compatibility floor includes later prereleases with numeric semver ordering', () => {
  assert.equal(DSH_COMPATIBILITY_RANGE, '>=0.2.1-alpha.5')
  for (const version of ['0.2.1-alpha.5', '0.2.1-alpha.6', '0.2.1-alpha.10', '0.2.1-rc.1', '0.2.1', '0.2.2-alpha.1', '0.3.0', '1.0.0']) {
    assert.equal(supportsDshVersion(version), true, version)
  }
  for (const version of ['0.2.0-rc.2', '0.2.1-alpha.4', '0.2.1-alpha.01', '0.2', 'garbage', '', ' 0.2.1-alpha.5 ', null, undefined, 5]) {
    assert.equal(supportsDshVersion(version), false, String(version))
  }
})
