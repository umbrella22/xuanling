/**
 * Run/Attempt state machine (C-08/§8.2): terminal states are immutable;
 * `recovery_required` is a durable NON-terminal — the system stops
 * dispatching affected work and only explicit reconciliation moves it to a
 * known terminal or a new attempt. `partial_success` does not exist in the
 * v1 success set; skipped paths were never executed.
 */
import { TERMINAL_RUN_STATES, type RunState } from '../persistence/records.ts'

export class IllegalTransitionError extends Error {
  override readonly name = 'IllegalTransitionError'
  readonly code = 'ILLEGAL_TRANSITION'
  constructor(from: RunState | string, to: RunState | string) {
    super(`illegal run state transition ${String(from)} -> ${String(to)}`)
  }
}

/** The operator reviewed an older cut than the one now durable. */
export class RecoveryStaleError extends Error {
  override readonly name = 'RecoveryStaleError'
  readonly code = 'RECOVERY_STALE'
  constructor(
    readonly runId: string,
    readonly expectedSeq: number,
    readonly actualSeq: number
  ) {
    super(`run ${runId} changed since review (expected seq ${expectedSeq}, actual ${actualSeq})`)
  }
}

const ALLOWED: Record<RunState, readonly RunState[]> = {
  // Admission may settle before the scheduler gets a chance to dispatch
  // (for example a resource freeze failure or a structurally empty graph).
  // Those terminal outcomes are explicit, durable paths rather than an
  // invitation for arbitrary queued-state mutation.
  // A queued TeamStage may already own a durable cancellation cutoff before
  // the scheduler has dispatched the graph.  That path must remain explicit;
  // queued human input is still rejected because waiting_input requires a
  // committed Attempt and its execution intent.
  queued: ['running', 'cancelling', 'cancelled', 'succeeded', 'failed', 'timed_out', 'recovery_required'],
  // A known cancellation may be settled directly once the scheduler has
  // drained its active effects.  Unknown or in-flight cancellation still
  // uses the explicit `cancelling` state.
  running: ['waiting_input', 'cancelling', 'cancelled', 'succeeded', 'failed', 'timed_out', 'recovery_required'],
  // A human decision has no in-flight external effect. Cancelling it can
  // therefore settle directly to the known terminal state without opening an
  // unknown-effect window.
  waiting_input: ['running', 'cancelling', 'cancelled', 'recovery_required'],
  cancelling: ['cancelled', 'failed', 'timed_out', 'succeeded', 'recovery_required'],
  recovery_required: ['succeeded', 'failed', 'cancelled', 'timed_out'],
  succeeded: [],
  failed: [],
  cancelled: [],
  timed_out: []
}

export function canTransitionRun(from: RunState, to: RunState): boolean {
  if (from === to) return true
  if (TERMINAL_RUN_STATES.includes(from)) return false
  return ALLOWED[from].includes(to)
}

export function transitionRun(from: RunState, to: RunState): RunState {
  if (!canTransitionRun(from, to)) throw new IllegalTransitionError(from, to)
  return to
}

export function isTerminal(state: RunState): boolean {
  return TERMINAL_RUN_STATES.includes(state)
}
