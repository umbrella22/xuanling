/** Resources module barrel: resolution, snapshots, admission. */
export {
  ResourceAmbiguousError,
  ResourceUnavailableError,
  resolveResource,
  type ResolveContext,
  type ResourceResolution,
  type SkillProviderLike,
  type SkillRoot
} from './resolver.ts'
export {
  ResourceChangedDuringReadError,
  snapshotDirectory,
  snapshotFile,
  type ResourceSnapshot,
  type SnapshotFile,
  type SnapshotOptions
} from './snapshotter.ts'
