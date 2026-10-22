/** Read the Host's effective preset identity, never infer Full from `never`.
 * Auto can share that policy while still requiring its native reviewer. */
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'

export function workflowReviewMode(ctx: Context, session: Session): 'full' | 'auto' | 'approval' {
  const presets = ctx.get('permissionPresets' as never) as unknown as { current(session: Session): string } | undefined
  try {
    const current = presets?.current(session)
    if (current === 'danger-full-access') return 'full'
    if (current === 'auto') return 'auto'
  } catch {
    // An unavailable policy reader cannot confer execution authority.
  }
  return 'approval'
}
