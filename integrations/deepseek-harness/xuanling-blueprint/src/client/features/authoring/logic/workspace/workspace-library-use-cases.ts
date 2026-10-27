/** Library cascade observations (C-01). Missing Host capability degrades only
 * the selector, never the editor: the selected library still drives writes. */
import type { HostLink, LibraryRef, LibrarySummary } from '../../../../adapters/host/remote.ts'

export interface WorkspaceLibraryContext {
  readonly host: Pick<HostLink, 'listBlueprintLibraries'> | undefined
  assertActive(): void
  nextReadGeneration(): number
  readGeneration(): number
  navigationGeneration(): number
  isDisposed(): boolean
  current(): LibraryRef
  applyLibraries(libraries: LibrarySummary[], selected: LibraryRef | undefined, state: 'current' | 'unavailable'): void
  emit(): void
}

export async function refreshWorkspaceLibraries(context: WorkspaceLibraryContext): Promise<void> {
  context.assertActive()
  const read = context.nextReadGeneration()
  const navigation = context.navigationGeneration()
  if (!context.host?.listBlueprintLibraries) {
    if (read === context.readGeneration()) context.applyLibraries([], undefined, 'unavailable')
    context.emit()
    return
  }
  if (context.isDisposed()) return
  try {
    const value = await context.host.listBlueprintLibraries()
    if (read !== context.readGeneration() || navigation !== context.navigationGeneration()) return
    context.applyLibraries(value.libraries, value.defaultLibrary ?? context.current(), 'current')
  } catch {
    if (read !== context.readGeneration() || navigation !== context.navigationGeneration()) return
    context.applyLibraries([], undefined, 'unavailable')
  }
  context.emit()
}
