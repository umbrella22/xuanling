/**
 * Resource admission (C-16/C-03, W2.3 scope resources): pure checks applied
 * before any snapshot or dispatch. Refs and snapshot paths are data; a
 * rejected ref never reaches execution. Admission detects conflicts and
 * reports them — it never renames, rewrites, or normalizes identities away.
 */
import type { ResourceRef } from '../definition/types.ts'

export interface AdmissionIssue {
  code: 'path-escape' | 'reserved-path' | 'case-conflict' | 'unicode-conflict' | 'invalid-identity'
  message: string
  refId?: string
  path?: string
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
// eslint-disable-next-line no-control-regex -- NUL/control bytes must be detected, not matched casually
const ILLEGAL_CHARS = /[<>:"|?*\u0000-\u001f]/

function checkPathSegments(refId: string, path: string, issues: AdmissionIssue[]): void {
  if (path.includes('\u0000')) {
    issues.push({ code: 'path-escape', message: 'path contains NUL', refId, path })
    return
  }
  if (path.split('/').includes('..') || path.startsWith('/') || /^[a-zA-Z]:/.test(path)) {
    issues.push({ code: 'path-escape', message: `path escapes the package: ${path}`, refId, path })
    return
  }
  for (const segment of path.split('/')) {
    if (WINDOWS_RESERVED.test(segment)) {
      issues.push({ code: 'reserved-path', message: `segment "${segment}" is a Windows reserved device name`, refId, path })
    }
    if (ILLEGAL_CHARS.test(segment)) {
      issues.push({ code: 'reserved-path', message: `segment "${segment}" carries characters illegal on common platforms`, refId, path })
    }
  }
}

/** Admit one resource reference. Shape rules were already enforced by the
 * definition validator; admission adds cross-platform portability checks. */
export function admitResourceRef(refId: string, ref: ResourceRef): AdmissionIssue[] {
  const issues: AdmissionIssue[] = []
  if (ref.path !== undefined) {
    checkPathSegments(refId, ref.path, issues)
  }
  if (ref.source?.kind === 'shared') {
    checkPathSegments(refId, ref.source.path, issues)
    if (ref.source.rootId.length === 0) {
      issues.push({ code: 'invalid-identity', message: 'shared source requires a non-empty rootId', refId })
    }
  }
  return issues
}

/** Admit every resource of a definition; returns all issues across refs. */
export function admitResources(resources: Record<string, ResourceRef>): AdmissionIssue[] {
  const issues: AdmissionIssue[] = []
  for (const [refId, ref] of Object.entries(resources)) {
    issues.push(...admitResourceRef(refId, ref))
  }
  // Case/Unicode collision detection across package paths: two distinct refs
  // whose paths collide under case-folding or NFC/NFD normalization are
  // reported (never silently merged or renamed).
  const paths = Object.entries(resources)
    .filter(([, ref]) => typeof ref.path === 'string')
    .map(([refId, ref]) => ({ refId, path: ref.path as string }))
  const seen = new Map<string, { refId: string; path: string }>()
  const normalize = (p: string): string => p.normalize('NFC').toLowerCase()
  for (const { refId, path } of paths) {
    const key = normalize(path)
    const prior = seen.get(key)
    if (prior !== undefined) {
      const caseOnly = prior.path.toLowerCase() === path.toLowerCase()
      issues.push({
        code: caseOnly ? 'case-conflict' : 'unicode-conflict',
        message: `paths of "${prior.refId}" and "${refId}" collide under ${caseOnly ? 'case' : 'Unicode'} folding: ${path}`,
        refId,
        path,
      })
    } else {
      seen.set(key, { refId, path })
    }
  }
  return issues
}

/** Snapshot paths go through the same escape/reserved checks. */
export function admitSnapshotPaths(paths: string[]): AdmissionIssue[] {
  const issues: AdmissionIssue[] = []
  for (const path of paths) {
    checkPathSegments('snapshot', path, issues)
  }
  return issues
}
