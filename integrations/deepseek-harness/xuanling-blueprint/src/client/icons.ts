import type React from 'react'
type ReactSeat = typeof React
/** Independent line artwork, rendered by the existing host React seat. */
const paths: Record<string, string> = {
  undo: 'M9 4 4 9l5 5M4 9h9a6 6 0 0 1 6 6', redo: 'm15 4 5 5-5 5m5-5h-9a6 6 0 0 0-6 6',
  save: 'M5 3h12l3 3v15H4V3h1m3 0v6h8V3M8 21v-8h8v8', run: 'm8 4 12 8-12 8Z', cancel: 'M6 6h12v12H6Z',
  pan: 'M9 12V5a2 2 0 0 1 4 0v7m0-5a2 2 0 0 1 4 0v5m0-2a2 2 0 0 1 4 0v6c0 4-3 6-6 6h-3l-6-7a2 2 0 0 1 3-2l2 2V8',
  select: 'm5 3 14 10-7 1-3 7Z', library: 'M3 4h18v16H3ZM9 4v16m-3-12h0m0 4h0', inspector: 'M3 4h18v16H3Zm12 0v16',
  more: 'M5 12h.01M12 12h.01M19 12h.01', files: 'M3 7h7l2-3h9v16H3Z', view: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Zm10-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
  tools: 'm14 3-3 5 5 5 5-3a7 7 0 0 1-8 9l-7 3-4-4 7-7a7 7 0 0 1 5-8',
  appearance: 'M12 3a9 9 0 1 0 0 18h2a2 2 0 0 0 0-4h-1a2 2 0 0 1 0-4h4a4 4 0 0 0 4-4c0-4-5-6-9-6ZM7 8h.01m5-2h.01m5 3h.01',
  layout: 'M3 4h7v6H3Zm11 10h7v6h-7ZM3 15h7M17 4v6', node: 'M5 5h14v14H5ZM1 9h4m-4 6h4m14-6h4m-4 6h4',
  input: 'M4 4h16v16H4Zm-3 8h12m-4-4 4 4-4 4', output: 'M4 4h16v16H4Zm7 8h12m-4-4 4 4-4 4',
  condition: 'm12 2 10 10-10 10L2 12Zm0 5v6m0 3h.01', join: 'M3 4v4l9 4 9-4V4M12 12v9',
  copy: 'M8 8h13v13H8ZM3 16V3h13', cut: 'M9 9 20 3M9 15l11 6M6 6a3 3 0 1 0 0 6 3 3 0 0 0 0-6m0 6a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
  delete: 'M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7', pin: 'm9 3 10 10-5 1-4 4-4-4 4-4Zm1 15-6 4',
  collapse: 'M4 5h16v14H4Zm4 7h8', expand: 'M4 5h16v14H4Zm4 7h8m-4-4v8', chevron: 'm9 5 7 7-7 7',
  check: 'm5 12 4 4L19 6', refresh: 'M20 8a9 9 0 0 0-15-3L3 8m0-5v5h5m-4 8a9 9 0 0 0 15 3l2-3m0 5v-5h-5',
  'chevron-left': 'm15 5-7 7 7 7',
  grip: 'M6 9h.01M12 9h.01M18 9h.01M6 15h.01M12 15h.01M18 15h.01',
  import: 'M4 15v6h16v-6M12 3v12m-5-5 5 5 5-5', export: 'M4 15v6h16v-6M12 15V3m-5 5 5-5 5 5',
  keyboard: 'M2 5h20v14H2Zm4 4h.01m4 0h.01m4 0h.01m4 0h.01M6 13h.01m4 0h.01m4 0h.01m4 0h.01M8 16h8',
  minimap: 'M3 4h18v16H3Zm3 3h6v5H6Zm9 7h3v3h-3', motion: 'M3 12h3l3-8 6 16 3-8h3',
}
export function blueprintIcon(React: ReactSeat, name: string): React.ReactElement {
  return React.createElement('svg', { viewBox: '0 0 24 24', width: 20, height: 20, fill: 'none', stroke: 'currentColor', strokeWidth: name === 'more' ? 3 : 1.6,
    strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false, 'data-bp-icon': name }, React.createElement('path', { d: paths[name] ?? paths.node }))
}
