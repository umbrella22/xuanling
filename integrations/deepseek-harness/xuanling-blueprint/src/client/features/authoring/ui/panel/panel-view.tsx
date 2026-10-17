/** @jsxRuntime classic */
/** @jsx React.createElement */
import type React from 'react'

type ReactSeat = typeof React

export interface PanelViewProps {
  rootProps: React.HTMLAttributes<HTMLDivElement> &
    Record<`data-${string}` | `aria-${string}`, string | boolean | undefined> & {
      ref?: React.Ref<HTMLDivElement>
    }
  children: React.ReactNode[]
}

/**
 * The outer Panel composition boundary.
 *
 * Keeping this shell props-only makes the boundary easy to inspect and keeps
 * browser effects, workspace state, and command authority in the Panel
 * controller. The injected React seat preserves the host's runtime identity.
 */
export function panelView(React: ReactSeat, props: PanelViewProps): React.ReactElement {
  return <div {...props.rootProps}>{props.children}</div>
}
