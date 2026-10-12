/** Export/import manifest (C-11): the transport-side closure record. It
 * carries file digests for integrity, the required host bindings for a
 * run-time preflight, and the export-time semantic revision for provenance.
 * It never carries machine paths, credentials, run records, or snapshots. */
export interface PortabilityManifest {
  schemaVersion: 1
  blueprintId: string
  /** Semantic revision at export time (content-addressed). */
  semanticRevision: string
  /** Every packaged file (path → sha256), excluding this manifest. */
  files: Record<string, string>
  /** MCP binding roles the imported blueprint needs at run time. */
  requiredBindings: string[]
  /** Declared external run dependencies (not bundled). */
  runDependencies: string[]
  /** Digest over the sorted (path, digest) pairs — the closure identity. */
  closureDigest: string
  exportedAt: string
}
