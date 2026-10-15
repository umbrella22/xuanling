import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const quote = name => (name.startsWith('@') ? `'${name}'` : name)
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function readPnpmLock(packageRoot) {
  return readFileSync(join(packageRoot, 'pnpm-lock.yaml'), 'utf8')
}

/**
 * Read only the root importer contract we need in package tests. The lock is
 * intentionally treated as a lockfile, rather than parsed as an arbitrary
 * YAML document, so the tests do not add a runtime dependency just to inspect
 * pnpm's stable importer shape.
 */
export function hasPnpmImporterDependency(lock, section, name, specifier) {
  const pattern = new RegExp(`^      ${escapeRegExp(quote(name))}:\\n` + `        specifier: ${escapeRegExp(specifier)}\\n` + `        version:`, 'm')
  const sectionStart = lock.indexOf(`    ${section}:\n`)
  if (sectionStart < 0) return false
  // The importer dependency entries are six-space-indented; package and
  // snapshot sections use two-space keys, so the root section can safely run
  // to EOF without matching a later package record.
  return pattern.test(lock.slice(sectionStart))
}
