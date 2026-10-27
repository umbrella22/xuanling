/** Resource observations do not alter definition resources or their grants. */
import type { HostLink, HostResourceCatalogEntry, LibraryRef } from '../../../../adapters/host/remote.ts'

export interface WorkspaceResourceContext {
  readonly host: Pick<HostLink, 'listResources'> | undefined
  assertActive(): void
  nextReadGeneration(): number
  readGeneration(): number
  navigationGeneration(): number
  isDisposed(): boolean
  selection(): { library: LibraryRef; workspaceId?: string } | undefined
  setCatalogState(state: 'loading' | 'current' | 'unavailable', entries?: HostResourceCatalogEntry[]): void
  emit(): void
}

export async function refreshWorkspaceResources(context: WorkspaceResourceContext): Promise<void> {
  context.assertActive()
  const readGeneration = context.nextReadGeneration()
  const navigationGeneration = context.navigationGeneration()
  if (!context.host?.listResources) {
    if (readGeneration === context.readGeneration()) context.setCatalogState('unavailable')
    context.emit()
    return
  }
  context.setCatalogState('loading')
  context.emit()
  if (context.isDisposed()) return
  try {
    const { resources } = await context.host.listResources(context.selection())
    if (readGeneration !== context.readGeneration() || navigationGeneration !== context.navigationGeneration()) return
    context.setCatalogState('current', resources)
  } catch {
    if (readGeneration !== context.readGeneration() || navigationGeneration !== context.navigationGeneration()) return
    context.setCatalogState('unavailable', [])
  }
  context.emit()
}
