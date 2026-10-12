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

const ALLOWED: Record<RunState, readonly RunState[]> = {
  queued: ['running', 'cancelled'],
  running: ['waiting_input', 'cancelling', 'succeeded', 'failed', 'timed_out', 'recovery_required'],
  waiting_input: ['running', 'cancelling', 'recovery_required'],
  cancelling: ['cancelled', 'failed', 'timed_out', 'succeeded', 'recovery_required'],
  recovery_required: ['succeeded', 'failed', 'cancelled', 'timed_out'],
  succeeded: [],
  failed: [],
  cancelled: [],
  timed_out: [],
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
