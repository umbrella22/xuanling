/** Canvas and graph presentation fragments; order is part of the visual contract. */
export const presentationCss =
  '\n/* Presentation-only additions; vendor CSS and executable-node geometry above stay intact. */\n.bp-workspace .bp-palette-entry{display:grid;gap:2px;border-radius:3px;text-align:left;box-shadow:inset 2px 0 0 var(--bp-accent)}\n.bp-palette-entry strong{font-weight:600}.bp-palette-entry small{color:var(--bp-muted);line-height:1.4}\n.bp-workspace .react-flow__node-presentationGroup{pointer-events:none;background:transparent;border:0;border-radius:4px}\n.bp-group-frame{height:100%;width:100%;border:1px solid color-mix(in srgb,var(--bp-muted) 45%,transparent);border-radius:4px;background:color-mix(in srgb,var(--bp-muted) 5%,transparent);pointer-events:none}\n.bp-group-header{display:flex;align-items:center;gap:8px;height:44px;padding:2px 12px;color:var(--bp-muted);border-bottom:1px solid color-mix(in srgb,var(--bp-muted) 20%,transparent);white-space:nowrap}\n.bp-group-header strong{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;color:var(--bp-text);font-size:12px}.bp-group-header span{font-size:11px;flex-shrink:0}.bp-group-header button{pointer-events:auto;margin-left:auto;min-height:40px;font-size:11px;background:var(--bp-bg)}\n.bp-workspace .bp-minimap-group{display:none}.bp-run-revision{font-family:ui-monospace,monospace;font-size:11px;color:var(--bp-muted)}\n.bp-overlay-notice{border-left:2px solid var(--bp-muted);padding-left:8px;color:var(--bp-muted)}\n.bp-node-inspector fieldset{min-width:0;margin:10px 0;padding:8px;border:1px solid color-mix(in srgb,var(--bp-muted) 25%,transparent)}\n.bp-node-inspector legend{color:var(--bp-muted);font-size:11px}.bp-resource-bindings label{display:flex;align-items:center;gap:6px;min-height:40px;overflow-wrap:anywhere}.bp-resource-bindings input{min-height:0}\n.bp-node-inspector .bp-port-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto;gap:4px;padding:4px 0;white-space:normal}\n.bp-port-editor label{display:grid;gap:3px;color:var(--bp-muted);font-size:10px}.bp-port-editor input{width:100%;min-width:0;color:var(--bp-text)}\n.bp-port-editor button{font-size:10px;padding:4px}.bp-node-inspector details label{display:grid;gap:4px;margin:10px 0;color:var(--bp-muted)}\n.bp-node-inspector textarea{width:100%;font-family:ui-monospace,monospace;line-height:1.4;resize:vertical;color:var(--bp-text)}\n'

export const interactionCss = `
.bp-workspace{position:relative}
.bp-interaction-overlay{position:absolute;z-index:20;min-width:220px;max-width:min(360px,100%);max-height:100%;overflow:auto;overscroll-behavior:contain;padding:8px;background:var(--bp-raised);color:var(--bp-text);border:1px solid color-mix(in srgb,var(--bp-muted) 35%,transparent);border-radius:8px;box-shadow:0 6px 24px #00000030;scrollbar-width:thin}
.bp-interaction-overlay header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px}
.bp-interaction-overlay header button{min-width:40px;padding:4px}
.bp-interaction-overlay form{display:grid;gap:8px}.bp-interaction-overlay input:not([type=checkbox]),.bp-interaction-overlay select{width:100%}
.bp-context-menu{display:grid;gap:2px}.bp-context-menu button{text-align:left;border-color:transparent;white-space:normal}
.bp-context-menu button:hover:not(:disabled),.bp-context-menu button:focus-visible,.bp-node-search [aria-selected=true]{background:color-mix(in srgb,var(--bp-accent) 16%,var(--bp-raised))}
.bp-node-search [role=listbox]{display:grid;gap:4px;margin-top:8px}.bp-node-search [role=option]{text-align:left}
.bp-shortcuts dl{margin:0}.bp-shortcuts dl>div{padding:6px 0;border-bottom:1px solid color-mix(in srgb,var(--bp-muted) 20%,transparent)}.bp-shortcuts dd{margin:2px 0 0;color:var(--bp-muted)}
.bp-workspace .bp-group-header{pointer-events:auto;cursor:grab;touch-action:none}.bp-group-header:focus-visible{outline:2px solid var(--bp-accent);outline-offset:2px}
.bp-node[data-bp-pinned=true] .bp-node-title{cursor:default}
/* Collapse hides captions without unmounting or relocating declared handles. */
.bp-node[data-bp-collapsed=true] .bp-node-summary,.bp-node[data-bp-collapsed=true] .bp-node-note,.bp-node[data-bp-collapsed=true] .bp-port-row>span{visibility:hidden}
.bp-node[data-bp-color=blue] .bp-node-title{box-shadow:inset 3px 0 0 var(--bp-accent)}
.bp-node[data-bp-color=green] .bp-node-title{box-shadow:inset 3px 0 0 #4a9e7a}.bp-node[data-bp-color=amber] .bp-node-title{box-shadow:inset 3px 0 0 #bd944c}
.bp-node[data-bp-color=red] .bp-node-title{box-shadow:inset 3px 0 0 #c46b6b}.bp-node[data-bp-color=purple] .bp-node-title{box-shadow:inset 3px 0 0 #9b7bbc}
.bp-workspace .bp-reroute{fill:var(--bp-raised);stroke:var(--bp-accent);stroke-width:2;pointer-events:all;cursor:move;touch-action:none}
.bp-reroute:focus-visible{outline:none;stroke-width:4}.bp-workspace .react-flow__resize-control.handle{width:12px;height:12px;border-radius:3px;touch-action:none}
.bp-workspace .bp-inspector-guard{border:0;margin:0;padding:0;min-width:0}
`

export const compactCss = `
/* Compact chrome only: host colors, current graph geometry and motion remain authoritative. */
.bp-workspace{min-width:0;overflow:hidden;container:bp-workspace / inline-size}
.bp-toolbar{flex-wrap:nowrap;flex-shrink:0;gap:6px;min-width:0}
.bp-blueprint-picker{flex:1 1 160px;min-width:100px;max-width:360px}
.bp-blueprint-picker select{width:100%;text-overflow:ellipsis}
.bp-toolbar-actions{display:flex;align-items:center;gap:4px;flex-shrink:0;margin-left:auto}
.bp-workspace .bp-icon-anchor{display:inline-flex;flex:0 0 40px;width:40px;height:40px;border-radius:4px}
.bp-workspace .bp-icon-button{display:flex;align-items:center;justify-content:center;width:40px;min-width:40px;height:40px;padding:0;border-color:transparent}
.bp-workspace .bp-icon-button[aria-pressed=true]{background:color-mix(in srgb,var(--bp-accent) 18%,var(--bp-raised));box-shadow:inset 0 0 0 1px var(--bp-accent)}
.bp-workspace .bp-icon-button:hover:not(:disabled){background:color-mix(in srgb,var(--bp-muted) 15%,var(--bp-raised))}
.bp-workspace .bp-run-button:not(:disabled){color:var(--bp-bg);background:var(--bp-accent)}
.bp-workspace .bp-run-button:hover:not(:disabled){background:color-mix(in srgb,var(--bp-accent) 85%,var(--bp-text))}
.bp-icon-anchor:focus-visible,.bp-palette-anchor:focus-visible,.bp-workspace summary:focus-visible{outline:2px solid var(--bp-accent);outline-offset:-2px}
.bp-body{min-width:0;overflow:hidden}.bp-library,.bp-inspector{min-width:0}
.bp-palette-anchor{display:block;width:100%;margin-bottom:4px;border-radius:4px}
.bp-workspace .bp-palette-entry{display:flex;align-items:center;gap:8px;width:100%;min-height:40px;box-shadow:none;border-color:transparent;text-align:left}
.bp-palette-entry strong{min-width:0;overflow-wrap:anywhere}.bp-palette-entry svg,.bp-menu-item svg{flex-shrink:0}
.bp-tooltip{position:absolute;z-index:30;max-width:min(320px,100%);max-height:100%;overflow:hidden;pointer-events:none;display:grid;gap:4px;padding:8px 10px;border-radius:6px;background:var(--bp-raised);color:var(--bp-text);box-shadow:0 0 0 1px color-mix(in srgb,var(--bp-muted) 30%,transparent),0 6px 20px #00000030;overflow-wrap:anywhere}
.bp-tooltip kbd,.bp-menu-item kbd{font:inherit;font-size:10px;color:var(--bp-muted)}
.bp-tooltip small,.bp-menu-label small{display:block;color:var(--bp-muted);font-size:11px;white-space:normal;overflow-wrap:anywhere}
.bp-interaction-overlay{min-width:min(240px,100%);max-width:min(360px,100%);max-height:100%}
.bp-context-menu,.bp-more-menu{display:grid;gap:2px}
.bp-workspace .bp-menu-item{display:flex;align-items:center;gap:8px;text-align:left;width:100%;min-height:40px;border-color:transparent;white-space:normal}
.bp-menu-label{flex:1;min-width:0;overflow-wrap:anywhere}.bp-menu-item kbd{flex:0 1 auto;max-width:100px;text-align:right;white-space:normal}
.bp-workspace .bp-menu-item:disabled{opacity:1;color:var(--bp-muted);cursor:default}
.bp-menu-item:hover:not(:disabled),.bp-menu-item:focus-visible{background:color-mix(in srgb,var(--bp-accent) 16%,var(--bp-raised))}
.bp-submenu{display:grid;gap:2px;padding:4px;margin:2px 0 4px 12px;border-radius:4px;box-shadow:inset 2px 0 0 color-mix(in srgb,var(--bp-accent) 50%,transparent)}
.bp-inspector>[data-bp-disclosure]{border-top:1px solid color-mix(in srgb,var(--bp-muted) 25%,transparent);margin-top:8px}
.bp-workspace [data-bp-disclosure-toggle]{padding:8px 0;min-height:40px}
[data-bp-disclosure-toggle] strong{font-size:11px;color:var(--bp-muted)}
[data-bp-disclosure-toggle] span,[data-bp-disclosure-toggle] small{display:block;margin-left:14px;overflow-wrap:anywhere}
[data-bp-summary-state=failed],[data-bp-summary-state=timed_out],[data-bp-summary-state=blocked]{color:var(--dsw-alias-error-primary,#c46b6b)}
[data-bp-summary-state=waiting_input],[data-bp-summary-state=recovery_required]{color:var(--dsw-alias-warning-primary,#bd944c)}
@container bp-workspace (max-width:780px){.bp-toolbar{flex-wrap:wrap}.bp-blueprint-picker{max-width:none}.bp-toolbar-actions{margin-left:0;flex-wrap:wrap}.bp-library{flex-basis:25%;padding:8px}.bp-inspector{flex-basis:30%;padding:8px}.bp-canvas{min-width:0}}
@container bp-workspace (max-width:480px){.bp-toolbar-actions{width:100%}.bp-library{flex-basis:28%}.bp-inspector{flex-basis:34%}.bp-revision{max-width:90px;overflow-wrap:anywhere}}
`

export const motionCss = `
/* Runtime projections decorate the existing geometry; no layout or handle motion. */
.bp-node{position:relative}
.bp-node[data-bp-relation=anchor]{outline:2px solid var(--bp-accent);outline-offset:3px}
.bp-node[data-bp-relation=neighbor]{outline:1px solid color-mix(in srgb,var(--bp-accent) 65%,transparent);outline-offset:3px}
.bp-node[data-bp-raw-state=running] .bp-node-state,.bp-node[data-bp-raw-state=preparing] .bp-node-state{color:var(--bp-accent)}
.bp-node[data-bp-raw-state=failed] .bp-node-state,.bp-node[data-bp-raw-state=timed_out] .bp-node-state{color:var(--dsw-alias-error-primary,#c46b6b)}
.bp-node[data-bp-raw-state=waiting_input] .bp-node-state,.bp-node[data-bp-raw-state=recovery_required] .bp-node-state{color:var(--dsw-alias-warning-primary,#bd944c)}
.bp-node-emphasis{position:absolute;inset:0;border-radius:inherit;box-shadow:inset 0 0 0 2px var(--bp-accent),0 0 12px color-mix(in srgb,var(--bp-accent) 35%,transparent);pointer-events:none;animation:bp-node-emphasis 1.8s ease-in-out infinite}
.bp-workspace [data-bp-related=true]>.react-flow__edge-path{stroke:var(--bp-accent);stroke-width:3}
/* One round zero-length dash on a normalized path: offset 0 -> -1 travels source -> target. */
.bp-workspace .bp-directed-light{fill:none;stroke:var(--bp-text);stroke-width:5;pointer-events:none;animation:bp-directed-light 1.8s linear infinite}
@media(prefers-reduced-motion:reduce){.bp-node-emphasis,.bp-workspace .bp-directed-light{animation:none;opacity:0}}
@keyframes bp-directed-light{0%{stroke-dashoffset:0;opacity:0}5%{opacity:1}95%{opacity:1}100%{stroke-dashoffset:-1;opacity:0}}
@keyframes bp-node-emphasis{0%,100%{opacity:.2}50%{opacity:.8}}
`

export const collisionControlsCss = `
.bp-canvas{position:relative}.bp-layout-apply,.bp-layout-error{position:absolute;z-index:8;top:12px;left:12px;max-width:calc(100% - 24px);background:var(--bp-bg);border:1px solid var(--bp-muted);border-radius:4px}
.bp-layout-apply{min-height:40px}.bp-layout-error{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:8px}.bp-layout-error button{min-height:40px}
`

export const canvasCss = collisionControlsCss + presentationCss + interactionCss + compactCss + motionCss
