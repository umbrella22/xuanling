/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
import type React from 'react'
type ReactSeat = typeof React
import { StyledSelect } from '../../../../shared/controls/styled-controls.ts'
import type { ContextCommand, CanvasCommand, CommandDisabledReason } from '../../../../shared/controls/command-policy.ts'
import type { BuiltinNodeKind } from '../../logic/graph/node-catalog.ts'
import type { BlueprintLocaleProps } from '../../../../shared/i18n/locales.ts'
import type { XY } from '../../../../../definition/types.ts'
import { blueprintIcon } from '../../../../shared/icons/icons.ts'
import { groupContextCommands, commandIcon, menuShortcut } from '../../presenters/menu-model.ts'
import type { MenuAction } from '../../presenters/menu-model.ts'
import { shortcutHelp } from '../../logic/overlays/overlay-session.ts'
import type { OverlaySessionState, OverlaySessionIntent } from '../../logic/overlays/overlay-session.ts'
export type OverlayMenuAction = Omit<MenuAction, 'onSelect'>
export type OverlayMarkupIntent =
  | OverlaySessionIntent
  | { type: 'command'; command: CanvasCommand }
  | { type: 'action'; action: string }
  | { type: 'add'; kind: BuiltinNodeKind }
  | { type: 'rename'; value: string }
  | { type: 'import-submit' }
export interface OverlayMarkupProps {
  overlay: { kind: 'context-menu' | 'node-search' | 'rename' | 'shortcuts' | 'import' | 'more-menu' }
  position: XY
  state: OverlaySessionState
  elementRef: React.RefObject<HTMLDivElement | null>
  t: BlueprintLocaleProps['t']
  commands: ContextCommand[]
  moreActions?: OverlayMenuAction[] | undefined
  presentationState?: { allPinned: boolean; allCollapsed: boolean } | undefined
  importDisabledReason?: CommandDisabledReason | null | undefined
  importTargets: Array<{ blueprintId: string; name: string; nonempty: boolean }>
  importDisabled: boolean
  hasFile: boolean
  candidates: readonly { kind: BuiltinNodeKind; titleKey: Parameters<BlueprintLocaleProps['t']>[0] }[]
  onIntent: (intent: OverlayMarkupIntent) => void
  onClose: () => void
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void
  onFileChange: (event: React.ChangeEvent<HTMLInputElement>) => void
}
export function interactionOverlaysView(React: ReactSeat, props: OverlayMarkupProps): React.ReactElement {
  const { overlay, position, t, onIntent, onClose, onKeyDown: keyDown, elementRef: ref, hasFile, candidates } = props
  const { query, active, name, targetId, confirmed, submenu } = props.state
  const index = Math.min(active, Math.max(0, candidates.length - 1))
  const isMenu = overlay.kind === 'context-menu' || overlay.kind === 'more-menu'
  const grouped = groupContextCommands(props.commands)
  const renderCommand = (item: ContextCommand, level = 'root'): React.ReactElement => {
    const label =
      item.command === 'toggle-pin'
        ? t(props.presentationState?.allPinned ? 'compact.unpin' : 'compact.pin')
        : item.command === 'toggle-collapse'
          ? t(props.presentationState?.allCollapsed ? 'compact.expand' : 'compact.collapse')
          : t(item.labelKey)
    const shortcut = menuShortcut[item.command]
    return (
      <button
        type="button"
        role="menuitem"
        key={item.command}
        className="bp-menu-item"
        data-bp-menu-level={level}
        data-bp-menu-command={item.command}
        data-bp-action={item.command === 'group' ? 'group-selection' : item.command === 'delete' ? 'delete-selection' : undefined}
        disabled={!item.enabled}
        aria-disabled={!item.enabled}
        aria-label={label}
        onClick={() => {
          if (item.enabled) onIntent({ type: 'command', command: item.command })
        }}
      >
        {blueprintIcon(React, commandIcon(item.command))}
        <span className="bp-menu-label">
          {label}
          {item.disabledReason && <small data-bp-disabled-reason={item.command}>{t(`interaction.disabled.${item.disabledReason}`)}</small>}
        </span>
        {shortcut && <kbd>{shortcut}</kbd>}
      </button>
    )
  }
  const renderAction = (item: OverlayMenuAction): React.ReactElement => (
    <button
      type="button"
      role="menuitem"
      key={item.action}
      className="bp-menu-item"
      data-bp-menu-level={item.group}
      data-bp-action={item.action}
      disabled={!item.enabled}
      aria-disabled={!item.enabled}
      aria-pressed={item.pressed}
      aria-label={t(item.labelKey)}
      onClick={() => {
        if (item.enabled) onIntent({ type: 'action', action: item.action })
      }}
    >
      {blueprintIcon(React, item.icon)}
      <span className="bp-menu-label">
        {t(item.labelKey)}
        {item.reason && <small data-bp-disabled-reason={item.action}>{item.reason}</small>}
      </span>
      {item.shortcut && <kbd>{item.shortcut}</kbd>}
    </button>
  )
  const renderGroup = (group: 'files' | 'view' | 'tools' | 'appearance' | 'layout', children: React.ReactElement[]): React.ReactElement => (
    <div key={group} className="bp-menu-group">
      <button
        type="button"
        role="menuitem"
        className="bp-menu-item"
        data-bp-menu-level="root"
        data-bp-menu-group={group}
        aria-haspopup="menu"
        aria-expanded={submenu === group}
        aria-controls={`bp-submenu-${group}`}
        onClick={() => onIntent({ type: 'submenu', submenu: group })}
      >
        {blueprintIcon(React, group)}
        <span className="bp-menu-label">{t(`compact.${group}`)}</span>
        {blueprintIcon(React, 'chevron')}
      </button>
      {submenu === group && (
        <div role="menu" className="bp-submenu" id={`bp-submenu-${group}`} aria-label={t(`compact.${group}`)} data-bp-submenu={group}>
          {children}
        </div>
      )}
    </div>
  )
  const dialog = !isMenu
  return (
    <div
      ref={ref}
      className={`bp-interaction-overlay bp-${overlay.kind} nodrag nopan nowheel`}
      style={{ left: position.x, top: position.y }}
      data-bp-overlay={overlay.kind}
      role={dialog ? 'dialog' : 'menu'}
      aria-label={t(`interaction.${overlay.kind}`)}
      onKeyDown={keyDown}
      onContextMenu={event => {
        event.preventDefault()
        event.stopPropagation()
      }}
    >
      {dialog && (
        <header>
          <strong>{t(`interaction.${overlay.kind}`)}</strong>
          <button type="button" onClick={onClose} aria-label={t('interaction.close')}>
            ×
          </button>
        </header>
      )}
      {overlay.kind === 'context-menu' && (
        <>
          {grouped.primary.map(item => renderCommand(item))}
          {grouped.appearance.length > 0 &&
            renderGroup(
              'appearance',
              grouped.appearance.map(item => renderCommand(item, 'appearance'))
            )}
          {grouped.layout.length > 0 &&
            renderGroup(
              'layout',
              grouped.layout.map(item => renderCommand(item, 'layout'))
            )}
        </>
      )}
      {overlay.kind === 'more-menu' &&
        (['files', 'view', 'tools'] as const).map(group =>
          renderGroup(group, (props.moreActions ?? []).filter(item => item.group === group).map(renderAction))
        )}
      {overlay.kind === 'node-search' && (
        <>
          <input
            data-bp-search-input={true}
            value={query}
            placeholder={t('palette.placeholder')}
            role="combobox"
            aria-label={t('palette.search')}
            aria-autocomplete="list"
            aria-controls="bp-search-results"
            aria-expanded={true}
            aria-activedescendant={candidates[index] ? `bp-search-${candidates[index]!.kind}` : undefined}
            onChange={event => onIntent({ type: 'query', query: event.currentTarget.value })}
          />
          <div role="listbox" id="bp-search-results">
            {candidates.map((item, i) => (
              <button
                type="button"
                role="option"
                key={item.kind}
                id={`bp-search-${item.kind}`}
                data-bp-search-kind={item.kind}
                aria-selected={i === index}
                onClick={() => onIntent({ type: 'add', kind: item.kind })}
                onMouseEnter={() => onIntent({ type: 'active', active: i })}
              >
                {t(item.titleKey)}
              </button>
            ))}
          </div>
          {!candidates.length && <p>{t('palette.noMatches')}</p>}
        </>
      )}
      {overlay.kind === 'rename' && (
        <form
          onSubmit={event => {
            event.preventDefault()
            onIntent({ type: 'rename', value: name })
          }}
        >
          <input
            data-bp-rename-field={true}
            value={name}
            aria-label={t('command.rename')}
            onChange={event => onIntent({ type: 'rename-buffer', name: event.currentTarget.value })}
          />
          <button type="submit" data-bp-action="rename-apply">
            {t('interaction.apply')}
          </button>
        </form>
      )}
      {overlay.kind === 'shortcuts' && (
        <dl>
          {shortcutHelp.map(([chord, key]) => (
            <div key={chord}>
              <dt>
                <kbd>{chord}</kbd>
              </dt>
              <dd>{t(`interaction.help.${key}`)}</dd>
            </div>
          ))}
        </dl>
      )}
      {overlay.kind === 'import' && (
        <form
          onSubmit={event => {
            event.preventDefault()
            onIntent({ type: 'import-submit' })
          }}
        >
          <p>{t('interaction.importHelp')}</p>
          {props.importDisabledReason && <p role="status">{t(`interaction.disabled.${props.importDisabledReason}`)}</p>}
          <StyledSelect
            React={React}
            data-bp-import-target={true}
            value={targetId}
            aria-label={t('library.configuredBlueprint')}
            onChange={event => onIntent({ type: 'target', targetId: event.currentTarget.value })}
          >
            <option value="" disabled>
              {t('library.chooseId')}
            </option>
            {props.importTargets.map(item => (
              <option key={item.blueprintId} value={item.blueprintId} disabled={item.nonempty}>
                {`${item.name} · ${item.blueprintId}${item.nonempty ? ` · ${t('interaction.nonempty')}` : ''}`}
              </option>
            ))}
          </StyledSelect>
          <input type="file" accept=".zip,application/zip" data-bp-import-file={true} aria-label={t('interaction.chooseFile')} onChange={props.onFileChange} />
          <label className="bp-checkbox">
            <input
              type="checkbox"
              checked={confirmed}
              data-bp-import-confirm={true}
              onChange={event => onIntent({ type: 'confirm-import', confirmed: event.currentTarget.checked })}
            />
            {t('interaction.confirmId', { id: targetId })}
          </label>
          <button type="submit" data-bp-action="import-apply" disabled={props.importDisabled || !confirmed || !hasFile || !targetId}>
            {t('interaction.apply')}
          </button>
        </form>
      )}
    </div>
  )
}
