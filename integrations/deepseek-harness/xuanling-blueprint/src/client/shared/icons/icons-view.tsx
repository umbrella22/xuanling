/** @jsxRuntime classic */
/** @jsx React.createElement */
import type React from 'react'
import { iconProjection } from './icon-model.ts'
type ReactSeat = typeof React

/** A single markup boundary, rendered with the caller's existing host seat. */
export function blueprintIcon(React: ReactSeat, name: string): React.ReactElement {
  const icon = iconProjection(name)
  return (
    <svg
      viewBox="0 0 24 24"
      width={20}
      height={20}
      fill="none"
      stroke="currentColor"
      strokeWidth={icon.strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={true}
      focusable={false}
      data-bp-icon={name}
    >
      <path d={icon.path} />
    </svg>
  )
}
