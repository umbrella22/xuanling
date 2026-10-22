import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

/** Windows has no portable directory-handle fsync in Node. File fsync still
 * applies there; POSIX also persists namespace changes before acknowledging. */
export function fsyncDirectory(path: string): void {
  if (process.platform === 'win32') return
  const fd = openSync(path, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** Persist every newly created ancestor, including its entry in its parent. */
export function mkdirDurable(path: string): void {
  try {
    if (!statSync(path).isDirectory()) throw new Error('directory required')
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const parent = dirname(resolve(path))
  mkdirDurable(parent)
  try {
    mkdirSync(path, { mode: 0o700 })
  } catch (error) {
    // A concurrent creator won the race. Accept only a real directory; the
    // winner is responsible for persisting its own namespace change.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !lstatSync(path).isDirectory()) throw error
    return
  }
  fsyncDirectory(path)
  fsyncDirectory(parent)
}

/** Validate the physical storage boundary before reading or mutating it.
 * The caller anchors root to a trusted canonical directory. Missing suffixes
 * are permitted for creation; symlinks in the managed subtree are rejected. */
export function assertStoragePath(root: string, path: string): void {
  const rel = relative(resolve(root), resolve(path))
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('storage path escapes root')
  let cursor = resolve(root)
  for (const part of ['', ...rel.split(sep).filter(Boolean)]) {
    if (part) cursor = resolve(cursor, part)
    try {
      if (lstatSync(cursor).isSymbolicLink()) throw new Error('storage symlink rejected')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }
}
