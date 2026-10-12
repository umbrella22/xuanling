/** Persistence barrel: domain bootstrap, records, lease, admission, store. */
export { openBlueprintDomain, type BlueprintDomainSpec, type DomainLike, type KvTableLike, type OpenedDomain } from './domain.ts'
export {
  recordsSchema, TERMINAL_RUN_STATES, TEAM_STAGE_STATES, TEAM_ACCEPTANCE_CODES,
  TEAM_STAGE_SCHEMA_VERSION, TEAM_OUTPUT_ACCEPTANCE_SCHEMA_VERSION, TEAM_EFFECT_STATES,
  teamStageRecordSchema, teamStageBindingSchema, teamMemberSnapshotSchema, teamEffectSnapshotSchema, teamOutputAcceptanceSchema,
  type AttemptRecord, type CommandRecord, type RunRecord, type RunState, type TransitionEvent,
  type TeamStageRecord, type TeamStageState, type TeamMemberSnapshot, type TeamEffectSnapshot, type TeamEffectState, type TeamOutputAcceptance,
  ATTEMPT_STATES, RUN_STATES,
} from './records.ts'
export { CoordinatorAlreadyActiveError, WriterLease, touchLease, type LeaseOptions, type LeasePayload } from './lease.ts'
export { CommandAdmission, CommandConflictError, DurabilityFailureError, newRunId, type AdmissionRequest, type AdmissionResult } from './command-admission.ts'
export { RunNotFoundError, RunStore, TerminalStateError, TeamStageConflictError, TeamTaskConflictError, TeamOutputRejectedError, type TeamStageBinding } from './run-store.ts'
export {
  createBackup,
  restoreBackup,
  restoreSafetyCheck,
  BackupIncompleteError,
  FormatUnsupportedError,
  RestoreInterruptedError,
  BACKUP_FORMAT_VERSION,
  type BackupManifest,
  type BackupResult,
  type RestoreResult,
} from './backup.ts'
