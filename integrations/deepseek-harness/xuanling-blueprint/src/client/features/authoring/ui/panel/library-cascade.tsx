/**
 * Two-level library cascade (C-01/C-13).
 *
 * Level one is the profile-global library plus every Host-registered
 * workspace. Level two is the selected library's assets and is rendered by the
 * existing blueprint picker. This component only renders projections; selection
 * and persistence stay in `BlueprintWorkspace`.
 */
import type React from 'react'
import { StyledSelect } from '../../../../shared/controls/styled-controls.ts'
import type { LibraryRef, LibrarySummary } from '../../../../adapters/host/remote.ts'
import { libraryKey } from '../../../../../definition/library-ref.ts'
import { sameLibrary } from '../../logic/workspace/workspace-controller.ts'

export type LibraryLabelKey = 'library.selectLibrary' | 'library.global' | 'library.ready' | 'library.empty' | 'library.absent' | 'library.unavailable'

export interface LibraryCascadeViewProps {
  React: typeof React
  t: (key: LibraryLabelKey, params?: Record<string, string>) => string
  disabled: boolean
  selected: LibraryRef
  status: 'absent' | 'empty' | 'ready' | 'unavailable'
  state: 'loading' | 'current' | 'unavailable'
  libraries: LibrarySummary[]
  onSelect: (library: LibraryRef) => void
}

/** Keep the asset count on the title's last wrapped line; the trigger ellipsizes it. */
const libraryOptionText = (title: string, count: number): string => (count ? `${title}\u00a0·\u00a0${count}` : title)

const STATUS_KEY: Record<LibrarySummary['status'], LibraryLabelKey> = {
  absent: 'library.absent',
  empty: 'library.empty',
  ready: 'library.ready',
  unavailable: 'library.unavailable'
}
const statusKey = (status: LibrarySummary['status']): LibraryLabelKey => STATUS_KEY[status]

/** One labeled level with a status chip. The blueprint picker beside it is the
 * second level and keeps the existing accessible combobox contract. */
export function LibraryCascadeView({ React, t, disabled, selected, status, state, libraries, onSelect }: LibraryCascadeViewProps): React.ReactElement {
  const globalLibrary = libraries.find(entry => entry.library.kind === 'global')
  const workspaces = libraries.filter(entry => entry.library.kind === 'workspace')
  const current = libraries.find(entry => sameLibrary(entry.library, selected))
  const currentStatus: LibrarySummary['status'] = state === 'unavailable' ? 'unavailable' : (current?.status ?? status)
  const workspaceCount = workspaces.filter(entry => entry.status === 'ready' || entry.status === 'empty').length
  const statusText = t(statusKey(currentStatus))
  const statusDetail = `${workspaceCount}/${workspaces.length}`
  const statusLabel = currentStatus === 'ready' ? `${statusText} · ${statusDetail}` : statusText
  return React.createElement(
    'div',
    {
      className: 'bp-library-cascade',
      'data-bp-library-cascade': String(state),
      'aria-busy': state === 'loading' ? 'true' : undefined
    },
    React.createElement(
      'label',
      { className: 'bp-library-level' },
      React.createElement('span', { className: 'bp-library-level-label' }, t('library.selectLibrary')),
      React.createElement(
        StyledSelect,
        {
          React,
          'data-bp-select': 'library',
          'aria-label': t('library.selectLibrary'),
          disabled,
          value: libraryKey(selected),
          onChange: (event: React.ChangeEvent<HTMLSelectElement>) => {
            const value = event.target.value
            onSelect(value === 'global' ? { kind: 'global' } : { kind: 'workspace', workspaceId: value.slice('workspace:'.length) })
          }
        },
        React.createElement('option', { value: 'global', key: 'global' }, libraryOptionText(t('library.global'), globalLibrary?.assets.length ?? 0)),
        workspaces.map(entry =>
          React.createElement(
            'option',
            { value: libraryKey(entry.library), key: libraryKey(entry.library) },
            libraryOptionText(entry.title, entry.assets.length)
          )
        )
      )
    ),
    React.createElement(
      'span',
      {
        className: `bp-library-status is-${currentStatus}`,
        'data-bp-library-status': currentStatus,
        role: 'status',
        title: statusLabel,
        'aria-label': statusLabel
      },
      React.createElement('span', { className: 'bp-library-status-mark', 'aria-hidden': 'true' }),
      React.createElement('span', { className: 'bp-library-status-text' }, statusText),
      currentStatus === 'ready' && React.createElement('span', { className: 'bp-library-status-count', 'aria-hidden': 'true' }, statusDetail)
    )
  )
}
