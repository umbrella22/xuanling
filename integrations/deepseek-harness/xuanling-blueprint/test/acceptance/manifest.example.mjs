// Safe bootstrap ONLY: every entry is explicitly not-run. No passed receipts
// are generated, and no credential, profile, build or historical scan occurs.
import { EVIDENCE_SCHEMA_VERSION, REQUIRED_GATES } from './evidence-manifest.mjs'

export function createNotRunEvidenceManifest({ planId, evidenceFingerprint }) {
  return {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    plan_id: planId,
    evidence_fingerprint: evidenceFingerprint,
    gates: REQUIRED_GATES.map(({ id, suite, scope, minimum_repeat }) => ({
      id,
      suite,
      scope,
      minimum_repeat,
      status: 'not-run',
      reason_code: 'EVIDENCE_NOT_COLLECTED',
      path: null,
      sha256: null
    }))
  }
}
