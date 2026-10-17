import { createRequire } from 'node:module'

// Use the installed host loader's declared semver implementation and its
// includePrerelease policy; no separate parser or new dependency is needed.
const harnessRequire = createRequire(new URL('../package.json', import.meta.url))
const hostRequire = createRequire(harnessRequire.resolve('@deepseek-ai/dsh-app-boot/package.json'))
const semver = hostRequire('semver')
export const DSH_COMPATIBILITY_RANGE = '>=0.2.1-alpha.5'

export function supportsDshVersion(version) {
  return typeof version === 'string' && version === version.trim()
    && semver.valid(version) !== null
    && semver.satisfies(version, DSH_COMPATIBILITY_RANGE, { includePrerelease: true })
}
