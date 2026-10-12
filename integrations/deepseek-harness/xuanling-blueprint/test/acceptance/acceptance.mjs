// C-11: explicit, checkout-bound evidence ONLY. Never scan old reports or
// treat a top-level green flag, a synthetic calibration or a gap as passed.
import { evaluateEvidenceManifest } from './evidence-manifest.mjs'

export async function getCases(helpers) {
  return [{
    id: 'AC-MANIFEST', title: 'C-11: all fixed required gates have fresh, stable, contiguous behavioral evidence',
    contract: 'C-11', expect: 'pass',
    run: () => evaluateEvidenceManifest({
      planId: helpers.planId,
      evidenceFingerprint: helpers.evidenceFingerprint,
      evidenceManifestPath: helpers.evidenceManifestPath,
    }),
  }]
}
