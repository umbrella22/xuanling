/** Buffer decisions only; semantic field validation remains with Inspector/Workspace. */
export function initialJsonBuffer(value: string | undefined, defaultValue: string | undefined): string {
  return value ?? defaultValue ?? ''
}
export function formatJsonBuffer(text: string, composing: boolean, readOnly: boolean): { accepted: boolean; text: string } {
  if (composing || readOnly) return { accepted: false, text }
  try {
    return { accepted: true, text: JSON.stringify(JSON.parse(text), null, 2) }
  } catch {
    return { accepted: false, text }
  }
}
export function canSyncJsonBuffer(current: string, incoming: string | undefined, composing: boolean): incoming is string {
  return incoming !== undefined && !composing && current !== incoming
}
