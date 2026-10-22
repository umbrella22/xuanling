/**
 * Content-free TeamStage recovery semantics shared by durable Run facts and
 * browser views. A TeamStage whose native effects are settled no longer blocks
 * a human recovery resolution; any other state (including its own
 * `recovery_required`) may still have unknown native Team effects, so the Host
 * rejects resolution until the native Team is cleaned up.
 *
 * The set stays module-private: callers only need the predicate, and no caller
 * can mutate the settled-state policy at runtime.
 */
const SETTLED_TEAM_STAGE_STATES: ReadonlySet<string> = new Set(['succeeded', 'failed', 'cancelled', 'timed_out'])

export function teamStageBlocksRecovery(teamStageState: string | undefined): boolean {
  return teamStageState !== undefined && !SETTLED_TEAM_STAGE_STATES.has(teamStageState)
}
