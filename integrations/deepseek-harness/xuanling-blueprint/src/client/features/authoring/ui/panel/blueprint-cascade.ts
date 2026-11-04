/** Cascade projection for the single searchable blueprint picker. Pure data: the panel owns the React seat. */
import type { LibraryRef, LibrarySummary } from '../../../../adapters/host/remote.ts'
import { libraryKey } from '../../../../../definition/library-ref.ts'
import { sameLibrary } from '../../logic/workspace/workspace-controller.ts'
import type { BlueprintLocaleProps } from '../../../../shared/i18n/locales.ts'

export const EMPTY_LIBRARY_PREFIX = 'library:'

export interface CascadeOption {
  value: string
  label: string
  group?: string
  disabled?: boolean
}
export interface CascadeTarget {
  library: LibraryRef
  blueprintId: string
}
export interface CascadeProjection {
  value: string
  libraryTitle: string
  selectedName: string
  options: CascadeOption[]
  resolve: (value: string) => CascadeTarget | null
}
export interface CascadeInput {
  t: BlueprintLocaleProps['t']
  library: LibraryRef
  libraries: LibrarySummary[]
  catalog: ReadonlyArray<{ blueprintId: string; name: string }>
  blueprintId: string | null
  definitionName?: string | undefined
  isNewDraft: boolean
}

interface CascadeLibrary {
  library: LibraryRef
  title: string
  ready: ReadonlyArray<{ blueprintId: string; name: string }>
}

/** One flat, workspace-grouped option list: selecting an option switches library when needed. */
export function blueprintCascadeProjection({ t, library, libraries, catalog, blueprintId, definitionName, isNewDraft }: CascadeInput): CascadeProjection {
  const ordered: CascadeLibrary[] =
    libraries.length === 0
      ? []
      : [...libraries]
          .sort((left, right) => {
            const rank = (entry: LibrarySummary) => (sameLibrary(entry.library, library) ? 0 : entry.library.kind === 'global' ? 1 : 2)
            return rank(left) - rank(right) || left.title.localeCompare(right.title)
          })
          .map(entry => ({
            library: entry.library,
            title: entry.library.kind === 'global' ? t('library.global') : entry.title,
            ready: entry.assets.filter(asset => asset.status === 'ready')
          }))
  const currentTitle =
    ordered.find(entry => sameLibrary(entry.library, library))?.title ?? (library.kind === 'global' ? t('library.global') : t('library.scope'))
  const options: CascadeOption[] = [{ value: '', label: t('library.chooseId'), disabled: true }]
  if (ordered.length === 0) {
    for (const entry of catalog) options.push({ value: entry.blueprintId, label: `${entry.name} · ${entry.blueprintId}` })
    if (blueprintId !== null && !catalog.some(entry => entry.blueprintId === blueprintId))
      options.push({ value: blueprintId, label: definitionName ?? blueprintId })
  } else {
    for (const entry of ordered) {
      const isCurrent = sameLibrary(entry.library, library)
      if (isCurrent && isNewDraft && blueprintId !== null && !entry.ready.some(item => item.blueprintId === blueprintId))
        options.push({ value: blueprintId, label: definitionName ?? t('document.newDraft'), group: entry.title })
      for (const item of entry.ready) options.push({ value: item.blueprintId, label: `${item.name} · ${item.blueprintId}`, group: entry.title })
      if (entry.ready.length === 0 && !isNewDraft)
        options.push({
          value: `${EMPTY_LIBRARY_PREFIX}${libraryKey(entry.library)}`,
          label: `${entry.title} · ${t('library.empty')}`,
          group: entry.title
        })
    }
  }
  const resolve = (value: string): CascadeTarget | null => {
    if (value.startsWith(EMPTY_LIBRARY_PREFIX)) {
      const key = value.slice(EMPTY_LIBRARY_PREFIX.length)
      const found = ordered.find(entry => libraryKey(entry.library) === key)?.library ?? libraries.find(entry => libraryKey(entry.library) === key)?.library
      return found ? { library: found, blueprintId: '' } : null
    }
    if (ordered.length === 0) return { library, blueprintId: value }
    const matches = ordered.flatMap(entry => entry.ready.map(item => ({ entry, item }))).filter(({ item }) => item.blueprintId === value)
    const preferred = matches.find(({ entry }) => sameLibrary(entry.library, library)) ?? matches[0]
    return preferred ? { library: preferred.entry.library, blueprintId: value } : { library, blueprintId: value }
  }
  const selectedName =
    definitionName ?? (isNewDraft ? t('document.newDraft') : catalog.find(entry => entry.blueprintId === blueprintId)?.name) ?? t('library.chooseId')
  return { value: blueprintId ?? '', libraryTitle: currentTitle, selectedName, options, resolve }
}
