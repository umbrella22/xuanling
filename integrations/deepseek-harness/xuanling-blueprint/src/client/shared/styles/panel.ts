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
.bp-workspace :is(.bp-library,.bp-inspector,.bp-interaction-overlay,.bp-resource-dialog) textarea::placeholder{color:var(--dsw-alias-label-tertiary,var(--bp-muted));opacity:1}
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
.bp-workspace .bp-inspector .bp-port-remove:hover:not(:disabled){color:var(--bp-danger,#c46b6b)}
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
.bp-workspace .bp-select-list [role=option]{display:flex;align-items:center;gap:12px;min-height:40px;box-sizing:border-box;padding:8px 10px;border-radius:var(--dsw-radius-md,12px);cursor:pointer;font-size:14px;line-height:22px}
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

const windowChromeCss = `
/* Window chrome: only the macOS desktop preload marks html[data-platform=darwin],
   and only there does the frame publish --dsh-frame-top-clearance for the strip
   that holds the traffic lights and the window drag. A plain browser document
   resolves the fallback, so the toolbar keeps its ordinary 8px top rhythm and
   gains no space. The toolbar row carries data-window-drag: DSH's ui-web base
   CSS owns the single -webkit-app-region drag rule and keeps interactive
   descendants clickable, so this file only owns the reserved band. */
[data-platform=darwin] .bp-workspace .bp-toolbar{padding-top:calc(8px + var(--dsh-frame-top-clearance,0px))}
`

const libraryCascadeCss = `
/* Library cascade: level-one library picker with a quiet, text-first status chip. */
.bp-workspace .bp-library-cascade{display:flex;align-items:flex-end;gap:10px;flex:0 1 360px;min-width:0}
.bp-workspace .bp-library-level{display:grid;grid-template-columns:minmax(0,1fr);gap:4px;flex:1 1 220px;min-width:0}
.bp-workspace .bp-library-level-label{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary,var(--bp-muted));font-size:12px;font-weight:500;line-height:16px}
.bp-workspace .bp-library-level .bp-select{width:100%;min-width:0}
.bp-workspace .bp-library-cascade .bp-select>button.bp-select-trigger{min-height:32px;height:32px;padding:0 10px;gap:8px;border-radius:var(--dsw-radius-md,12px);font-size:13px;line-height:18px}
.bp-workspace .bp-library-level .bp-select-value{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.bp-workspace .bp-library-level .bp-select-chevron{color:var(--dsw-alias-label-tertiary,var(--bp-muted));font-size:14px;line-height:1}
.bp-workspace .bp-library-status{display:inline-flex;align-items:center;gap:6px;flex:0 1 auto;min-width:0;max-width:180px;height:30px;padding:0 9px;overflow:hidden;white-space:nowrap;border:0.5px solid var(--dsw-alias-border-l4,color-mix(in srgb,var(--bp-muted) 24%,transparent));border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-1,var(--bp-raised));color:var(--dsw-alias-label-secondary,var(--bp-muted));font-size:12px;line-height:16px;transition:color var(--ds-transition-duration-fast,.1s) var(--ds-ease-in-out,ease),border-color var(--ds-transition-duration-fast,.1s) var(--ds-ease-in-out,ease),opacity var(--ds-transition-duration-fast,.1s) var(--ds-ease-in-out,ease)}
.bp-workspace .bp-library-status-text{min-width:0;overflow:hidden;text-overflow:ellipsis}
.bp-workspace .bp-library-status-count{flex:none;color:var(--dsw-alias-label-tertiary,var(--bp-muted));font-variant-numeric:tabular-nums}
.bp-workspace .bp-library-status-count::before{content:'·';margin-right:4px;opacity:.7}
.bp-workspace .bp-library-status-mark{display:grid;place-items:center;flex:none;width:8px;height:8px}
.bp-workspace .bp-library-status-mark::before{content:'';display:block;box-sizing:border-box;width:6px;height:6px;border-radius:50%;background:currentColor}
.bp-workspace .bp-library-status.is-ready .bp-library-status-mark{color:var(--dsw-alias-state-business-primary,var(--bp-accent))}
.bp-workspace .bp-library-status.is-empty .bp-library-status-mark{color:var(--dsw-alias-label-secondary,var(--bp-muted))}
.bp-workspace .bp-library-status.is-empty .bp-library-status-mark::before{border:1px solid currentColor;background:transparent}
.bp-workspace .bp-library-status.is-absent .bp-library-status-mark{color:var(--dsw-alias-label-tertiary,var(--bp-muted))}
.bp-workspace .bp-library-status.is-absent .bp-library-status-mark::before{width:6px;height:2px;border-radius:1px;background:currentColor}
.bp-workspace .bp-library-status.is-unavailable{color:var(--dsw-alias-state-error-primary,var(--bp-danger,#c46b6b));border-color:color-mix(in srgb,currentColor 35%,transparent)}
.bp-workspace .bp-library-status.is-unavailable .bp-library-status-mark{color:currentColor}
.bp-workspace .bp-library-status.is-unavailable .bp-library-status-mark::before{content:'!';width:auto;height:auto;border:0;background:none;font-size:10px;font-weight:700;line-height:1}
.bp-workspace .bp-library-cascade[data-bp-library-cascade=loading] .bp-library-status{opacity:.7}
@container bp-workspace (max-width:1080px){.bp-workspace .bp-toolbar{flex-wrap:wrap}.bp-workspace .bp-library-cascade{flex:1 1 100%;order:-1}.bp-workspace .bp-library-level{flex:0 1 360px}}
@container bp-workspace (max-width:780px){.bp-workspace .bp-library-cascade{flex-wrap:wrap;gap:8px}.bp-workspace .bp-library-level{flex-basis:100%}.bp-workspace .bp-library-status{max-width:100%}}
@media(prefers-reduced-motion:reduce){.bp-workspace .bp-library-status{transition:none}}
`

export const panelPolishCss = `
/* Chrome polish (final cascade): one label rhythm, one enclosure language, and
   state colours that stay semantic under every host theme. These selectors only
   refine spacing, radius, hierarchy and state; the host-control primitives above
   keep owning hit targets, focus rings and reduced-motion fallbacks. */
.bp-workspace h2{font-size:11px;font-weight:600;letter-spacing:.06em;line-height:16px;color:var(--bp-muted);margin:16px 0 8px}
.bp-workspace .bp-library>:first-child:is(h2),.bp-workspace .bp-inspector>h2,.bp-workspace .bp-resource-heading h2{margin-top:0;margin-bottom:0}
.bp-workspace .bp-library,.bp-workspace .bp-inspector{padding:14px}
.bp-workspace .bp-palette-hint{font-size:11px;line-height:16px;margin:0 0 10px}
.bp-workspace .bp-help{line-height:1.6}
.bp-workspace .bp-inspector>.bp-help{margin:0 0 12px;padding:2px 0 10px;font-size:12px}
.bp-workspace .bp-inspector .bp-node-id{font-size:11px;line-height:16px;letter-spacing:.01em;color:var(--bp-muted);margin:4px 0 10px}
.bp-workspace .bp-library-cascade{align-items:center;gap:8px;flex:0 1 auto;min-width:0}
.bp-workspace .bp-library-level{position:relative;display:flex;align-items:center;flex:0 1 200px;min-width:132px;gap:0}
.bp-workspace .bp-library-level-label{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.bp-workspace .bp-library-cascade .bp-select>button.bp-select-trigger{min-height:40px;height:40px;padding:0 12px;gap:8px;border-radius:var(--dsw-radius-md,12px);font-size:13px;line-height:18px}
.bp-workspace .bp-library-level .bp-select-chevron{font-size:13px}
.bp-workspace .bp-library-status{height:28px;max-width:172px;padding:0 10px;gap:7px;border-radius:var(--dsw-radius-md,12px);font-size:11px;line-height:15px}
.bp-workspace .bp-blueprint-picker{flex:1 1 220px}
.bp-workspace .bp-toolbar-group{padding:2px;border-radius:var(--dsw-radius-md,12px);background:transparent;box-shadow:none}
.bp-workspace .bp-toolbar-group[data-bp-toolbar-group=mode]{background:color-mix(in srgb,var(--bp-bg) 52%,var(--bp-raised));box-shadow:inset 0 1px 2px #00000026,inset 0 0 0 .5px color-mix(in srgb,var(--bp-muted) 26%,transparent)}
.bp-workspace .bp-toolbar-group button.bp-icon-button{border-radius:calc(var(--dsw-radius-md,12px) - 2px);transition:background-color var(--ds-transition-duration-fast,.12s) var(--ds-ease-in-out,ease),color var(--ds-transition-duration-fast,.12s) var(--ds-ease-in-out,ease),transform var(--ds-transition-duration-fast,.12s) var(--ds-ease-in-out,ease)}
.bp-workspace .bp-toolbar button.bp-icon-button[aria-pressed=true]{background:color-mix(in srgb,var(--bp-text) 14%,var(--bp-raised));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--bp-muted) 55%,transparent)}
.bp-workspace .bp-revision{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 9px;border-radius:999px;background:color-mix(in srgb,var(--bp-muted) 9%,transparent);box-shadow:inset 0 0 0 .5px color-mix(in srgb,var(--bp-muted) 24%,transparent);color:var(--bp-muted);font-size:11px;line-height:16px;white-space:nowrap}
.bp-workspace .bp-revision:before{content:'';flex:none;width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.7}
.bp-workspace .bp-revision[data-bp-dirty=true]{color:var(--bp-warn,#bd944c);background:color-mix(in srgb,var(--bp-warn,#bd944c) 12%,transparent)}
.bp-workspace .bp-toolbar{padding:8px 14px}
.bp-workspace .bp-library-actions>summary{font-size:11px;letter-spacing:.04em;color:var(--bp-muted);transition:color var(--ds-transition-duration-fast,.12s) var(--ds-ease-in-out,ease)}
.bp-workspace .bp-library-actions>summary:hover{color:var(--bp-text)}
.bp-workspace .bp-library>input[data-bp-palette-search]{background:color-mix(in srgb,var(--bp-raised) 55%,transparent);border:0;box-shadow:inset 0 0 0 .5px color-mix(in srgb,var(--bp-muted) 24%,transparent);font-size:12px}
.bp-workspace .bp-library>input[data-bp-palette-search]:focus{box-shadow:inset 0 0 0 1px var(--dsw-alias-state-business-primary,var(--bp-accent))}
.bp-workspace .bp-palette-anchor{margin-bottom:2px}
.bp-workspace .bp-palette-entry{gap:10px;padding:0 8px;border-radius:var(--dsw-radius-sm,8px);color:var(--bp-text);transition:background-color var(--ds-transition-duration-fast,.12s) var(--ds-ease-in-out,ease),color var(--ds-transition-duration-fast,.12s) var(--ds-ease-in-out,ease),transform var(--ds-transition-duration-fast,.12s) var(--ds-ease-in-out,ease)}
.bp-workspace .bp-palette-entry svg{flex:none;width:16px;height:16px;color:var(--bp-muted);transition:color var(--ds-transition-duration-fast,.12s) var(--ds-ease-in-out,ease)}
.bp-workspace .bp-palette-entry:hover:not(:disabled) svg{color:var(--bp-accent)}
.bp-workspace .bp-palette-entry:active:not(:disabled){transform:scale(.96)}
.bp-workspace .bp-sidebar-toggle{border:0;border-radius:999px;box-shadow:inset 0 0 0 .5px color-mix(in srgb,var(--bp-muted) 26%,transparent),0 2px 8px #0000001a;transition:color var(--ds-transition-duration-fast,.12s) var(--ds-ease-in-out,ease),background-color var(--ds-transition-duration-fast,.12s) var(--ds-ease-in-out,ease),transform var(--ds-transition-duration-fast,.12s) var(--ds-ease-in-out,ease)}
.bp-workspace .bp-sidebar-toggle:active{transform:translateX(1px)}
.bp-workspace .bp-resource-heading{margin:18px 0 8px}
.bp-workspace .bp-resource-heading button.bp-resource-add{position:relative;width:28px;min-width:28px;height:28px;min-height:28px;border:0;border-radius:50%;background:transparent;color:var(--bp-muted);font-size:18px;line-height:1;box-shadow:none;transition:color var(--ds-transition-duration-fast,.12s) var(--ds-ease-in-out,ease),background-color var(--ds-transition-duration-fast,.12s) var(--ds-ease-in-out,ease)}
.bp-workspace .bp-resource-heading button.bp-resource-add:before{content:'';position:absolute;inset:-6px;border-radius:50%}
.bp-workspace .bp-library button.bp-resource-toggle{padding:6px 4px;margin-inline:-4px;border-radius:6px;letter-spacing:.05em;color:var(--bp-muted)}
.bp-workspace .bp-library button.bp-resource-toggle:hover:not(:disabled){background:color-mix(in srgb,var(--bp-text) 5%,transparent);color:var(--bp-text)}
.bp-workspace .bp-library button.bp-resource-row{margin:6px 0;padding:10px 12px;min-height:74px;border:0;border-radius:var(--dsw-radius-md,12px);background:color-mix(in srgb,var(--bp-raised) 86%,var(--bp-bg));box-shadow:inset 0 0 0 .5px color-mix(in srgb,var(--bp-muted) 26%,transparent),0 1px 2px #0000000f;transition:background-color var(--ds-transition-duration-fast,.12s) var(--ds-ease-in-out,ease),box-shadow var(--ds-transition-duration-fast,.12s) var(--ds-ease-in-out,ease)}
.bp-workspace .bp-library button.bp-resource-row:hover:not(:disabled){background:color-mix(in srgb,var(--bp-accent) 7%,var(--bp-raised));box-shadow:inset 0 0 0 .5px color-mix(in srgb,var(--bp-accent) 50%,transparent),0 3px 10px #0000001a}
.bp-workspace .bp-library button.bp-resource-row:active:not(:disabled){box-shadow:inset 0 0 0 .5px color-mix(in srgb,var(--bp-accent) 65%,transparent),0 2px 6px #0000001f}
.bp-workspace .bp-resource-row .bp-resource-description{color:var(--bp-muted)}
.bp-workspace .bp-resource-row .bp-resource-meta{font-size:11px;line-height:16px;letter-spacing:.02em}
.bp-workspace .bp-resource-row .bp-resource-status{display:inline-flex;align-items:center;justify-self:end;gap:5px;font-size:11px;line-height:16px;white-space:nowrap;color:var(--bp-muted)}
.bp-workspace .bp-resource-row .bp-resource-status:before{content:'';flex:none;width:5px;height:5px;margin:0;border-radius:50%;background:currentColor;opacity:.9}
.bp-workspace .bp-resource-row[data-bp-availability=available] .bp-resource-status{color:var(--dsw-alias-state-business-primary,var(--bp-accent))}
.bp-workspace .bp-resource-row[data-bp-availability=unavailable] .bp-resource-status{color:var(--dsw-alias-state-error-primary,#c46b6b)}
.bp-workspace .bp-inspector>[data-bp-disclosure]{border-top:0;box-shadow:inset 0 .5px 0 color-mix(in srgb,var(--bp-muted) 22%,transparent);margin-top:10px;padding-top:2px}
.bp-workspace .bp-inspector [data-bp-disclosure-toggle]{display:grid;grid-template-columns:14px minmax(0,1fr);align-items:center;column-gap:8px;row-gap:2px;min-height:44px;padding:8px 0;list-style:none;overflow-wrap:anywhere}
.bp-workspace .bp-inspector [data-bp-disclosure-toggle]::-webkit-details-marker{display:none}
.bp-workspace .bp-inspector [data-bp-disclosure-toggle]:before{content:'';grid-column:1;grid-row:1;width:0;height:0;border-block:4px solid transparent;border-inline-start:5.5px solid currentColor;color:var(--bp-muted);transform-origin:1px 50%;transition:transform var(--ds-transition-duration-fast,.12s) var(--ds-ease-in-out,ease)}
.bp-workspace .bp-inspector details[open]>[data-bp-disclosure-toggle]:before{transform:rotate(90deg)}
.bp-workspace .bp-inspector [data-bp-disclosure-toggle]>:not(:first-child){grid-column:2}
.bp-workspace .bp-inspector [data-bp-disclosure-toggle] strong{font-size:11px;line-height:16px;letter-spacing:.04em;color:var(--bp-muted)}
.bp-workspace .bp-inspector [data-bp-disclosure-toggle] span{font-size:12px;line-height:18px;margin-left:0}
.bp-workspace .bp-inspector [data-bp-disclosure-toggle] small{font-size:11px;line-height:16px;margin-left:0}
.bp-workspace .bp-inspector .bp-node-inspector fieldset{border:0;border-radius:var(--dsw-radius-lg,16px);padding:8px 10px 10px;box-shadow:inset 0 0 0 .5px color-mix(in srgb,var(--bp-muted) 24%,transparent);background:color-mix(in srgb,var(--bp-raised) 45%,transparent)}
.bp-workspace .bp-inspector .bp-node-inspector legend{padding:0 6px;font-size:11px;letter-spacing:.04em;color:var(--bp-muted)}
.bp-workspace .bp-json-footer{font-size:11px}
.bp-workspace .bp-interaction-overlay{border:0;border-radius:var(--dsw-radius-lg,16px);box-shadow:inset 0 0 0 .5px color-mix(in srgb,var(--bp-muted) 30%,transparent),0 12px 32px #00000038,0 2px 6px #0000001f}
.bp-workspace .bp-tooltip{border-radius:var(--dsw-radius-sm,8px);box-shadow:inset 0 0 0 .5px color-mix(in srgb,var(--bp-muted) 30%,transparent),0 8px 24px #00000030}
.bp-workspace .bp-status{display:flex;align-items:center;min-height:28px;padding:5px 14px;font-size:11px;line-height:16px;color:var(--bp-muted);box-shadow:inset 0 .5px 0 color-mix(in srgb,var(--bp-muted) 20%,transparent)}
.bp-workspace .bp-status[data-bp-status-key=status.error]{color:var(--bp-danger,#c46b6b)}
.bp-workspace{--bp-danger:var(--dsw-alias-state-error-primary,#c46b6b);--bp-warn:var(--dsw-alias-state-warn-primary,#bd944c)}
.bp-workspace .bp-tooltip kbd,.bp-workspace .bp-menu-item kbd{font-size:11px;line-height:14px}
.bp-workspace .bp-library,.bp-workspace .bp-inspector{scrollbar-color:color-mix(in srgb,var(--bp-muted) 35%,transparent) transparent}
.bp-workspace .bp-resource-category p.bp-help{color:var(--dsw-alias-label-tertiary,var(--bp-muted));text-align:center;padding:6px 0}
.bp-workspace .bp-resource-dialog{border:0;box-shadow:inset 0 0 0 .5px color-mix(in srgb,var(--bp-muted) 28%,transparent),0 16px 48px #00000038}
.bp-workspace .bp-select-list{border:0;box-shadow:inset 0 0 0 .5px color-mix(in srgb,var(--bp-muted) 28%,transparent),0 12px 32px #00000033}
.bp-workspace .bp-confirm-backdrop,.bp-workspace .bp-resource-backdrop{background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.24));backdrop-filter:var(--dsw-mask-blur,none)}
.bp-workspace .bp-confirm-dialog{border-radius:var(--dsw-radius-xl,20px);box-shadow:inset 0 0 0 .5px color-mix(in srgb,var(--bp-muted) 26%,transparent),0 16px 48px #00000038}
@container bp-workspace (max-width:1080px){
  .bp-workspace .bp-library-level{flex:1 1 260px;gap:8px}
  .bp-workspace .bp-library-level-label{position:static;width:auto;height:auto;margin:0;padding:0;overflow:visible;clip:auto;white-space:nowrap;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,var(--bp-muted))}
}
@media(prefers-reduced-motion:reduce){
  .bp-workspace .bp-toolbar-group button.bp-icon-button,.bp-workspace .bp-library-actions>summary,.bp-workspace .bp-palette-entry,.bp-workspace .bp-palette-entry svg,.bp-workspace .bp-sidebar-toggle,.bp-workspace .bp-resource-heading button.bp-resource-add,.bp-workspace .bp-library button.bp-resource-row,.bp-workspace .bp-inspector [data-bp-disclosure-toggle]:before{transition:none}
  .bp-workspace .bp-sidebar-toggle:active,.bp-workspace .bp-library button.bp-resource-row:active:not(:disabled),.bp-workspace .bp-palette-entry:active:not(:disabled){transform:none}
}
`

export const panelCss =
  editorAffordanceCss +
  jsonEditorCss +
  nodeContentCss +
  windowChromeCss +
  hostControlsCss +
  resourceLibraryCss +
  styledControlsCss +
  libraryCascadeCss +
  panelPolishCss
