/** Panel, editor, resource and control fragments; DOM installation remains in styles.ts. */
export const editorAffordanceCss = `
.bp-workspace .bp-node{display:flex;flex-direction:column}
.bp-workspace .bp-node-title{position:relative;flex-shrink:0}
.bp-workspace .bp-node-grip{position:absolute;top:8px;left:50%;transform:translateX(-50%);height:12px;color:var(--bp-muted);opacity:.65;pointer-events:none}
.bp-workspace .bp-node-grip svg{width:20px;height:12px;stroke-width:3}
.bp-workspace .bp-node-title:hover .bp-node-grip{color:var(--bp-accent);opacity:1}
.bp-workspace .bp-node[data-bp-pinned=true] .bp-node-grip{visibility:hidden}
.bp-workspace .bp-node .bp-control-ports{margin-top:auto}
.bp-workspace .react-flow__node-blueprint{cursor:default}
.bp-workspace .react-flow__node-blueprint.dragging .bp-node-title{cursor:grabbing}
.bp-workspace .react-flow__resize-control{z-index:6}
.bp-workspace .bp-node .react-flow__handle{z-index:7}
.bp-workspace .react-flow__resize-control.line{border-color:transparent}
.bp-workspace .react-flow__resize-control.line:hover{border-color:var(--bp-accent)}
.bp-workspace .react-flow__resize-control.line:before{content:'';position:absolute;inset:-5px}
.bp-workspace .bp-palette-entry[draggable=true]{cursor:grab}
.bp-workspace .bp-palette-entry[draggable=true]:active{cursor:grabbing}
.bp-workspace .bp-palette-hint{font-size:10px;margin:0 0 10px}
.bp-workspace .bp-canvas[data-bp-palette-over=true]:after{content:'';position:absolute;inset:2px;border:2px dashed var(--bp-accent);border-radius:8px;pointer-events:none;z-index:8}
.bp-workspace .bp-body{position:relative}
.bp-workspace .bp-library{flex-basis:224px}
.bp-workspace .bp-inspector{flex-basis:300px}
.bp-workspace .bp-sidebar-rail{position:relative;flex:0 0 24px;display:flex;align-items:center;justify-content:center;z-index:10;background:var(--bp-bg)}
.bp-workspace .bp-sidebar-toggle{position:relative;width:24px;min-width:24px;height:64px;padding:0;display:flex;align-items:center;justify-content:center;color:var(--bp-muted);background:var(--bp-raised);border:1px solid color-mix(in srgb,var(--bp-muted) 20%,transparent);border-radius:8px;box-shadow:0 2px 8px #00000008}
.bp-workspace .bp-sidebar-toggle:before{content:'';position:absolute;inset:0 -8px}
.bp-workspace .bp-sidebar-toggle:hover{color:var(--bp-accent);background:color-mix(in srgb,var(--bp-accent) 10%,var(--bp-raised))}
.bp-workspace .bp-sidebar-toggle svg{width:16px;height:16px}
@container bp-workspace (max-width:780px){
  .bp-workspace .bp-library,.bp-workspace .bp-inspector{position:absolute;top:0;bottom:0;width:min(300px,calc(100% - 72px));z-index:9;background:var(--bp-bg);box-shadow:0 4px 16px #00000018;padding:12px}
  .bp-workspace .bp-library{left:24px}.bp-workspace .bp-inspector{right:24px}
}
`

export const jsonEditorCss = `
.bp-workspace .bp-json-editor{display:block;min-width:0;width:100%;border:1px solid color-mix(in srgb,var(--bp-muted) 30%,transparent);border-radius:6px;background:var(--bp-bg);overflow:hidden;color:var(--bp-text);font-size:12px}
.bp-workspace .bp-json-editor:focus-within{border-color:var(--bp-accent);box-shadow:0 0 0 1px var(--bp-accent)}
.bp-workspace .bp-json-editor .cm-editor{background:transparent;outline:none}
.bp-workspace .bp-json-editor .cm-scroller{max-height:320px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;line-height:1.5;overscroll-behavior:contain}
.bp-workspace .bp-json-editor .cm-content{padding:8px 0;caret-color:var(--bp-text)}
.bp-workspace .bp-json-editor .cm-gutters{background:var(--bp-raised);color:var(--bp-muted);border:0;font-variant-numeric:tabular-nums}
.bp-workspace .bp-json-editor .cm-cursor{border-left-color:var(--bp-text)}
.bp-workspace .bp-json-editor .cm-selectionBackground,.bp-workspace .bp-json-editor .cm-focused .cm-selectionBackground{background:color-mix(in srgb,var(--bp-accent) 25%,transparent)!important}
.bp-workspace .bp-json-editor .cm-matchingBracket{background:color-mix(in srgb,var(--bp-accent) 25%,transparent)}
.bp-workspace .bp-json-footer{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 6px 0 8px;border-top:1px solid color-mix(in srgb,var(--bp-muted) 20%,transparent);font-size:10px;color:var(--bp-muted)}
.bp-workspace .bp-json-footer span{min-width:0;overflow-wrap:anywhere}
.bp-workspace .bp-json-footer button{min-height:32px;padding:4px 8px;border:0;background:transparent;font-size:11px;flex:none}
.bp-workspace .bp-json-error{text-decoration:underline wavy var(--bp-danger,#c46b6b);text-underline-offset:3px}
.bp-workspace .bp-json-footer [data-bp-json-valid=false]{color:var(--bp-danger,#c46b6b)}
`

export const hostControlsCss = `
/* Host controls: DSH primitives, scoped outside the graph. */
.bp-workspace .bp-toolbar{gap:12px;padding:8px 12px;box-shadow:0 0.5px 0 var(--dsw-alias-border-l4,color-mix(in srgb,var(--bp-muted) 25%,transparent))}
.bp-workspace .bp-blueprint-picker{min-width:120px}
.bp-workspace .bp-toolbar-actions{gap:8px}
.bp-workspace .bp-toolbar-group{display:flex;align-items:center;gap:2px;flex-shrink:0;padding:2px;border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-1,var(--bp-raised));box-shadow:inset 0 0 0 0.5px var(--dsw-alias-border-l4,color-mix(in srgb,var(--bp-muted) 25%,transparent))}
.bp-workspace :is(.bp-toolbar,.bp-library,.bp-inspector,.bp-interaction-overlay,.bp-resource-dialog) button,
.bp-workspace :is(.bp-toolbar,.bp-library,.bp-inspector,.bp-interaction-overlay,.bp-resource-dialog) input:not([type=checkbox]),
.bp-workspace :is(.bp-toolbar,.bp-library,.bp-inspector,.bp-interaction-overlay,.bp-resource-dialog) textarea,
.bp-workspace :is(.bp-toolbar,.bp-library,.bp-inspector,.bp-interaction-overlay,.bp-resource-dialog) select{
  min-height:40px;padding:8px 12px;border:0.5px solid var(--dsw-alias-border-l4,color-mix(in srgb,var(--bp-muted) 30%,transparent));
  border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-1,var(--bp-raised));color:var(--dsw-alias-label-primary,var(--bp-text));
  font-family:inherit;font-size:14px;line-height:22px;
  transition:background-color var(--ds-transition-duration-fast,.1s) var(--ds-ease-in-out,ease),border-color var(--ds-transition-duration-fast,.1s) var(--ds-ease-in-out,ease),box-shadow var(--ds-transition-duration-fast,.1s) var(--ds-ease-in-out,ease)
}
.bp-workspace :is(.bp-toolbar,.bp-library,.bp-inspector,.bp-interaction-overlay,.bp-resource-dialog) button{display:inline-flex;align-items:center;justify-content:center;gap:6px;border-color:var(--dsw-alias-border-l3,color-mix(in srgb,var(--bp-muted) 30%,transparent));background:transparent;cursor:pointer}
.bp-workspace :is(.bp-library,.bp-inspector,.bp-interaction-overlay,.bp-resource-dialog) input:not([type=checkbox]),
.bp-workspace :is(.bp-library,.bp-inspector,.bp-interaction-overlay,.bp-resource-dialog) textarea,
.bp-workspace :is(.bp-toolbar,.bp-library,.bp-inspector,.bp-interaction-overlay,.bp-resource-dialog) select{width:100%;min-width:0}
.bp-workspace :is(.bp-library,.bp-inspector,.bp-interaction-overlay,.bp-resource-dialog) textarea{font-family:var(--ds-font-family-code,ui-monospace,monospace);line-height:1.5;resize:vertical;tab-size:2}
.bp-workspace :is(.bp-library,.bp-inspector,.bp-interaction-overlay,.bp-resource-dialog) pre{font-family:var(--ds-font-family-code,ui-monospace,monospace)}
.bp-workspace :is(.bp-library,.bp-inspector,.bp-interaction-overlay,.bp-resource-dialog) input::placeholder,
.bp-workspace :is(.bp-library,.bp-inspector,.bp-interaction-overlay,.bp-resource-dialog) textarea::placeholder{color:var(--dsw-alias-label-dimmed,var(--bp-muted));opacity:1}
.bp-workspace :is(.bp-toolbar,.bp-library,.bp-inspector,.bp-interaction-overlay,.bp-resource-dialog) input:not([type=checkbox]):hover:not(:disabled),
.bp-workspace :is(.bp-toolbar,.bp-library,.bp-inspector,.bp-interaction-overlay,.bp-resource-dialog) textarea:hover:not(:disabled),
.bp-workspace :is(.bp-toolbar,.bp-library,.bp-inspector,.bp-interaction-overlay,.bp-resource-dialog) select:hover:not(:disabled){border-color:var(--dsw-alias-border-l3,color-mix(in srgb,var(--bp-muted) 45%,transparent))}
.bp-workspace :is(.bp-toolbar,.bp-library,.bp-inspector,.bp-interaction-overlay,.bp-resource-dialog) input:not([type=checkbox]):focus,
.bp-workspace :is(.bp-toolbar,.bp-library,.bp-inspector,.bp-interaction-overlay,.bp-resource-dialog) textarea:focus,
.bp-workspace :is(.bp-toolbar,.bp-library,.bp-inspector,.bp-interaction-overlay,.bp-resource-dialog) select:focus{border-color:var(--dsw-alias-state-business-primary,var(--bp-accent))}
.bp-workspace :is(.bp-toolbar,.bp-library,.bp-inspector,.bp-interaction-overlay,.bp-resource-dialog) :is(button,input,textarea,select,summary):focus-visible,
.bp-workspace :is(.bp-icon-anchor,.bp-palette-anchor):focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,var(--bp-accent)));outline-offset:2px}
/* Two small strokes paint a token-colored chevron; the select remains native. */
.bp-workspace :is(.bp-toolbar,.bp-library,.bp-inspector,.bp-interaction-overlay,.bp-resource-dialog) select{
  appearance:none;-webkit-appearance:none;padding-right:36px;
  background-image:linear-gradient(45deg,transparent 50%,var(--dsw-alias-label-tertiary,var(--bp-muted)) 50%),linear-gradient(135deg,var(--dsw-alias-label-tertiary,var(--bp-muted)) 50%,transparent 50%);
  background-position:calc(100% - 17px) 50%,calc(100% - 12px) 50%;background-size:5px 5px,5px 5px;background-repeat:no-repeat
}
.bp-workspace :is(.bp-toolbar,.bp-library,.bp-inspector,.bp-interaction-overlay,.bp-resource-dialog) select option{background:var(--dsw-alias-bg-layer-1,var(--bp-raised));color:var(--dsw-alias-label-primary,var(--bp-text))}
.bp-workspace :is(.bp-toolbar,.bp-library,.bp-inspector,.bp-interaction-overlay,.bp-resource-dialog) button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,var(--bp-muted) 15%,var(--bp-raised)))}
.bp-workspace :is(.bp-toolbar,.bp-library,.bp-inspector,.bp-interaction-overlay,.bp-resource-dialog) button:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active,color-mix(in srgb,var(--bp-muted) 25%,var(--bp-raised)))}
.bp-workspace :is(.bp-toolbar,.bp-library,.bp-inspector,.bp-interaction-overlay,.bp-resource-dialog) button:disabled{opacity:.4;cursor:not-allowed;transform:none}
.bp-workspace :is(.bp-toolbar,.bp-library,.bp-inspector,.bp-interaction-overlay,.bp-resource-dialog) input:not([type=checkbox]):disabled,
.bp-workspace :is(.bp-toolbar,.bp-library,.bp-inspector,.bp-interaction-overlay,.bp-resource-dialog) textarea:disabled,
.bp-workspace :is(.bp-toolbar,.bp-library,.bp-inspector,.bp-interaction-overlay,.bp-resource-dialog) select:disabled{opacity:.4;cursor:not-allowed}
.bp-workspace :is(.bp-library,.bp-inspector,.bp-interaction-overlay,.bp-resource-dialog) input:not([type=checkbox]):read-only,
.bp-workspace :is(.bp-library,.bp-inspector,.bp-interaction-overlay,.bp-resource-dialog) textarea:read-only{background:var(--dsw-alias-bg-layer-2,var(--bp-raised));color:var(--dsw-alias-label-secondary,var(--bp-muted))}
.bp-workspace :is(.bp-toolbar,.bp-library,.bp-interaction-overlay,.bp-resource-dialog) button:is(.bp-icon-button,.bp-palette-entry,.bp-menu-item){border-color:transparent;border-radius:var(--dsw-radius-sm,8px);font-size:12px;background:transparent;justify-content:flex-start}
.bp-workspace .bp-toolbar button.bp-icon-button{width:40px;min-width:40px;height:40px;padding:0;justify-content:center}
.bp-workspace :is(.bp-icon-anchor,.bp-palette-anchor){border-radius:var(--dsw-radius-sm,8px)}
.bp-workspace .bp-toolbar button.bp-icon-button[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-active,color-mix(in srgb,var(--bp-muted) 20%,var(--bp-raised)));box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l3,color-mix(in srgb,var(--bp-muted) 45%,transparent))}
.bp-workspace .bp-toolbar button.bp-run-button:not(:disabled){background:var(--dsw-alias-button-primary-fill,var(--bp-accent));color:var(--dsw-alias-label-primary-foreground,var(--bp-bg))}
.bp-workspace .bp-toolbar button.bp-run-button:hover:not(:disabled),
.bp-workspace .bp-toolbar button.bp-run-button:active:not(:disabled){background:var(--dsw-alias-button-primary-hover,color-mix(in srgb,var(--bp-accent) 85%,var(--bp-text)))}
.bp-workspace .bp-library>input{margin-bottom:8px}
.bp-workspace :is(.bp-library,.bp-inspector,.bp-interaction-overlay,.bp-resource-dialog) .bp-field{gap:6px;margin:12px 0}
.bp-workspace :is(.bp-library,.bp-inspector) form{gap:8px}
.bp-workspace .bp-inspector .bp-node-inspector fieldset{padding:12px;margin:12px 0;border:0.5px solid var(--dsw-alias-border-l4,color-mix(in srgb,var(--bp-muted) 25%,transparent));border-radius:var(--dsw-radius-md,12px)}
.bp-workspace .bp-inspector .bp-node-inspector legend{padding:0 6px;color:var(--dsw-alias-label-secondary,var(--bp-muted))}
.bp-workspace .bp-inspector .bp-port-editor button{padding:4px 8px;font-size:12px;border-radius:var(--dsw-radius-sm,8px)}
.bp-workspace .bp-inspector .bp-node-inspector .bp-port-row{grid-template-columns:minmax(0,1fr) minmax(0,1fr) 40px;align-items:end;gap:8px;padding:4px 0 8px}
.bp-workspace .bp-inspector .bp-port-editor label{min-width:0;gap:6px;font-size:11px}
.bp-workspace .bp-inspector .bp-port-editor input:not([type=checkbox]){padding:8px;font-size:13px}
.bp-workspace .bp-inspector .bp-port-editor .bp-port-remove{width:40px;height:40px;min-height:40px;padding:0;flex-shrink:0}
.bp-workspace .bp-inspector .bp-port-remove:hover:not(:disabled){color:var(--dsw-alias-error-primary,#c46b6b)}
.bp-workspace .bp-inspector .bp-port-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:4px}
.bp-workspace .bp-inspector .bp-port-actions button{flex:1 1 auto;white-space:nowrap}
.bp-workspace .bp-inspector .bp-node-id{font-family:ui-monospace,monospace;font-size:10px;color:var(--bp-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin:4px 0 12px}
.bp-workspace .bp-inspector .bp-binding-empty{margin:0;font-size:11px}
.bp-workspace .bp-inspector .bp-node-inspector>label,.bp-workspace .bp-inspector [data-bp-condition]>label{display:grid;gap:6px;margin:12px 0}
.bp-workspace .bp-inspector .bp-model-fields{display:grid;gap:8px;min-width:0}
.bp-workspace .bp-inspector .bp-model-fields .bp-field{display:grid;min-width:0;margin:4px 0}
.bp-workspace .bp-inspector .bp-model-route select,.bp-workspace .bp-inspector .bp-model-fields input:not([type=checkbox]){width:100%;min-width:0}
.bp-workspace .bp-interaction-overlay .bp-context-menu button{justify-content:flex-start;border-color:transparent;border-radius:var(--dsw-radius-sm,8px)}
.bp-workspace .bp-interaction-overlay .bp-menu-item:disabled{opacity:1;color:var(--dsw-alias-label-dimmed,var(--bp-muted))}
.bp-workspace .bp-interaction-overlay.bp-node-search [aria-selected=true]{background:var(--dsw-alias-interactive-bg-active,color-mix(in srgb,var(--bp-muted) 20%,var(--bp-raised)))}
.bp-workspace .bp-submenu{padding:4px;margin-top:4px;border-radius:var(--dsw-radius-sm,8px);box-shadow:inset 2px 0 0 var(--dsw-alias-border-l3,color-mix(in srgb,var(--bp-muted) 45%,transparent))}
@container bp-workspace (max-width:780px){.bp-workspace .bp-toolbar{gap:8px}.bp-workspace .bp-toolbar-actions{gap:6px}}
@media(prefers-reduced-motion:reduce){
  .bp-workspace :is(.bp-toolbar,.bp-library,.bp-inspector,.bp-interaction-overlay,.bp-resource-dialog) :is(button,input,textarea,select){transition:none}
  .bp-workspace :is(.bp-toolbar,.bp-library,.bp-inspector,.bp-interaction-overlay,.bp-resource-dialog) button:active{transform:none}
}
`

export const resourceLibraryCss = `
.bp-workspace .bp-resource-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:14px 0 8px}
.bp-workspace .bp-resource-heading h2{margin:0;min-width:0}
.bp-workspace .bp-resource-heading button.bp-resource-add{width:28px;min-width:28px;height:28px;min-height:28px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--bp-muted);font-size:20px;font-weight:400;line-height:1;box-shadow:none}
.bp-workspace .bp-resource-heading button.bp-resource-add:is(:hover,:active):not(:disabled){color:var(--bp-text);background:color-mix(in srgb,var(--bp-accent) 12%,transparent)}
.bp-workspace .bp-resource-heading button.bp-resource-add:focus-visible{outline:2px solid var(--bp-accent);outline-offset:2px}
.bp-workspace .bp-tooltip[data-bp-tooltip^="resource-"]{max-width:min(480px,calc(100% - 16px));white-space:pre-wrap}
.bp-workspace .bp-resource-category{margin-top:14px}
.bp-workspace .bp-resource-category>h3{margin:0 0 6px}
.bp-workspace .bp-library button.bp-resource-toggle{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;min-height:40px;margin:0;padding:4px 0;border:0;border-radius:4px;background:transparent;color:var(--bp-muted);font-size:11px;font-weight:600;letter-spacing:.04em;text-align:left;box-shadow:none}
.bp-workspace .bp-resource-toggle span{min-width:0;overflow-wrap:anywhere}.bp-workspace .bp-resource-toggle svg{flex-shrink:0;transition:transform .12s ease}.bp-workspace .bp-resource-toggle svg[data-bp-expanded=true]{transform:rotate(90deg)}
.bp-workspace .bp-resource-category>[hidden]{display:none}
@media(prefers-reduced-motion:reduce){.bp-workspace .bp-resource-toggle svg{transition:none}}
.bp-workspace .bp-library button.bp-resource-row{display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-rows:auto auto auto;grid-template-areas:"title title" "description description" "meta status";align-items:start;justify-content:stretch;gap:2px 8px;width:100%;min-width:0;min-height:72px;margin:6px 0;padding:9px 10px;text-align:left;border:0.5px solid var(--dsw-alias-border-l4,color-mix(in srgb,var(--bp-muted) 24%,transparent));border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-1,var(--bp-raised));box-shadow:none}
.bp-workspace .bp-library button.bp-resource-row:hover:not(:disabled){border-color:var(--dsw-alias-border-l3,color-mix(in srgb,var(--bp-accent) 55%,transparent));background:color-mix(in srgb,var(--bp-accent) 7%,var(--bp-raised))}
.bp-workspace .bp-resource-row:focus-visible{outline:2px solid var(--bp-accent);outline-offset:1px}
.bp-workspace .bp-resource-row .bp-resource-title{grid-area:title;display:block;min-width:0;overflow:hidden;color:var(--bp-text);font-size:13px;font-weight:600;line-height:18px;white-space:nowrap;text-overflow:ellipsis}
.bp-workspace .bp-resource-row .bp-resource-description{grid-area:description;display:block;min-width:0;overflow:hidden;color:var(--bp-muted);font-size:12px;line-height:18px;white-space:nowrap;text-overflow:ellipsis}
.bp-workspace .bp-resource-row .bp-resource-meta{grid-area:meta;display:block;min-width:0;overflow:hidden;color:var(--bp-muted);font-size:10px;line-height:14px;white-space:nowrap;text-overflow:ellipsis}
.bp-workspace .bp-resource-row .bp-resource-status{grid-area:status;align-self:center;color:var(--bp-muted);font-size:10px;line-height:14px;text-align:right;white-space:normal}
.bp-workspace .bp-resource-row .bp-resource-status::before{content:'·';margin-right:4px;color:var(--bp-accent)}
.bp-workspace .bp-resource-backdrop{position:absolute;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;padding:16px;background:#0002}
.bp-workspace .bp-resource-dialog{width:min(720px,100%);max-width:100%;container:bp-resource-dialog / inline-size;max-height:100%;min-height:0;overflow:auto;overscroll-behavior:contain;padding:20px;border:1px solid color-mix(in srgb,var(--bp-muted) 24%,transparent);border-radius:var(--dsw-radius-lg,16px);background:var(--bp-raised);box-shadow:0 12px 36px #0003}
.bp-workspace .bp-resource-dialog h2{margin:0 0 16px;font-size:16px;line-height:24px}
.bp-workspace .bp-resource-dialog .bp-field{display:grid;min-width:0}
.bp-workspace .bp-resource-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;align-items:start}
.bp-workspace .bp-resource-dialog .bp-resource-fields .bp-field{margin:0}
.bp-workspace .bp-resource-dialog :is(.bp-resource-identity,.bp-resource-configuration){display:grid;grid-template-columns:auto minmax(0,1fr);gap:6px 12px;font-size:12px}
.bp-workspace .bp-resource-dialog dt{color:var(--bp-muted)}
.bp-workspace .bp-resource-dialog dd{margin:0;overflow-wrap:anywhere}
.bp-workspace .bp-resource-dialog-actions{position:sticky;bottom:-20px;display:flex;justify-content:flex-end;gap:8px;margin-top:16px;padding:12px 0 0;background:var(--bp-raised)}
@container bp-resource-dialog (max-width:520px){.bp-workspace .bp-resource-fields{grid-template-columns:minmax(0,1fr)}.bp-workspace .bp-resource-dialog :is(.bp-resource-identity,.bp-resource-configuration){grid-template-columns:minmax(0,1fr);gap:4px 0}.bp-workspace .bp-resource-dialog dd{margin-bottom:8px}}
`

export const styledControlsCss = `
/* Select list stays in the DOM and enters the top layer to escape modal clipping. */
.bp-workspace .bp-select{min-width:0;width:100%}.bp-workspace .bp-select > button.bp-select-trigger{display:flex;width:100%;min-width:0;justify-content:space-between;text-align:left;gap:12px;background:var(--dsw-alias-bg-layer-1,var(--bp-raised))}
.bp-workspace .bp-select-value{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bp-workspace .bp-select-chevron{flex-shrink:0;color:var(--bp-muted);font-size:18px;line-height:1}
.bp-workspace .bp-select-trigger[aria-expanded=true]{box-shadow:0 0 0 2px color-mix(in srgb,var(--bp-accent) 35%,transparent)}
.bp-workspace .bp-select-list{position:fixed;inset:auto;margin:0;padding:5px;z-index:100;box-sizing:border-box;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;border:1px solid var(--dsw-alias-border-l3,color-mix(in srgb,var(--bp-muted) 30%,transparent));border-radius:var(--dsw-radius-lg,16px);background:var(--dsw-alias-bg-layer-2,var(--bp-raised));color:var(--bp-text);box-shadow:0 6px 24px #00000025,0 2px 6px #00000012;font:inherit}
.bp-workspace .bp-select-list [role=option]{display:flex;align-items:center;gap:12px;min-height:40px;box-sizing:border-box;padding:8px 10px;border-radius:var(--dsw-radius-md,11px);cursor:pointer;font-size:14px;line-height:22px}
.bp-workspace .bp-select-option-label{flex:1;min-width:0;overflow-wrap:anywhere}.bp-workspace .bp-select-check{width:16px;flex-shrink:0;color:var(--bp-accent)}
.bp-workspace .bp-select-list [data-bp-active=true]:not([aria-disabled=true]){background:color-mix(in srgb,var(--bp-accent) 13%,var(--bp-raised))}
.bp-workspace .bp-select-list [aria-selected=true]{font-weight:600}.bp-workspace .bp-select-list [aria-disabled=true]{color:var(--bp-muted);opacity:.55;cursor:default}
.bp-workspace .bp-confirm-backdrop{position:absolute;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:24px;background:#00000040;backdrop-filter:blur(3px)}
.bp-workspace .bp-confirm-dialog{width:min(440px,100%);max-height:100%;overflow:auto;padding:24px;background:var(--dsw-alias-bg-layer-2,var(--bp-raised));color:var(--bp-text);border-radius:var(--dsw-radius-xl,20px);box-shadow:0 12px 48px #00000030,0 0 0 1px color-mix(in srgb,var(--bp-muted) 25%,transparent);outline:none}
.bp-workspace .bp-confirm-dialog h2{font-size:18px;letter-spacing:normal;color:var(--bp-text);margin:0 0 12px;text-wrap:balance}.bp-workspace .bp-confirm-dialog p{font-size:14px;line-height:1.6;color:var(--bp-muted);margin:0}
.bp-workspace .bp-confirm-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:24px}.bp-workspace .bp-confirm-actions button{min-height:40px;padding:8px 16px;border-radius:var(--dsw-radius-md,12px)}.bp-workspace [data-bp-confirm-accept]{background:var(--bp-accent);color:var(--bp-bg);border-color:transparent}
`

const nodeContentCss =
  '.bp-workspace .bp-node{height:auto}.bp-workspace .bp-node [data-bp-node-content]{width:100%;display:flow-root}.bp-workspace .bp-node .bp-port-columns>div{flex:1;min-width:0}.bp-workspace .bp-node .bp-port-row{white-space:normal;overflow-wrap:anywhere}.bp-workspace .bp-node-title,.bp-workspace .bp-node-summary,.bp-workspace .bp-node-state,.bp-workspace .bp-node-note{overflow-wrap:anywhere;white-space:normal}'

export const panelCss = editorAffordanceCss + jsonEditorCss + nodeContentCss + hostControlsCss + resourceLibraryCss + styledControlsCss
