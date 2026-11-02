export const compositionCss = `
/* Child-run composition and read-only previews inside the authoring Inspector. */
.bp-child-composition,.bp-child-preview{min-width:0;display:grid;gap:12px}
.bp-child-composition h3,.bp-child-preview h3{margin:0;font-size:13px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary,var(--bp-text));text-wrap:balance}
.bp-child-composition p,.bp-child-preview p{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,var(--bp-muted));text-wrap:pretty}
.bp-child-pin,.bp-child-preview code{overflow-wrap:anywhere;font-variant-numeric:tabular-nums;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,var(--bp-muted))}
.bp-child-interface{border-collapse:collapse;width:100%;text-align:left;font-size:12px;line-height:18px}
.bp-child-interface caption{text-align:left;font-weight:600;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,var(--bp-muted));padding:4px 0 8px}
.bp-child-interface th,.bp-child-interface td{padding:6px 8px;overflow-wrap:anywhere;vertical-align:top}
.bp-child-interface th{font-size:11px;font-weight:600;line-height:16px;color:var(--dsw-alias-label-secondary,var(--bp-muted))}
.bp-child-interface tbody tr{box-shadow:inset 0 .5px 0 var(--dsw-alias-border-l4,color-mix(in srgb,currentColor 12%,transparent))}
.bp-child-actions{display:flex;flex-wrap:wrap;gap:8px}
.bp-child-actions button,.bp-child-preview>button,.bp-child-conflicts button{display:inline-flex;align-items:center;justify-content:center;height:32px;min-height:32px;padding:0 12px;border:0;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-1,var(--bp-raised));color:var(--dsw-alias-label-primary,var(--bp-text));font:inherit;font-size:13px;line-height:18px;cursor:pointer;box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l4,#0000001f)}
.bp-child-actions button:hover:not(:disabled),.bp-child-preview>button:hover:not(:disabled),.bp-child-conflicts button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,color-mix(in srgb,var(--bp-text) 5%,var(--bp-raised)))}
.bp-child-actions button:disabled,.bp-child-preview>button:disabled,.bp-child-conflicts button:disabled{opacity:.5;cursor:default}
.bp-child-conflicts{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 10px;border-radius:var(--dsw-radius-sm,8px);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#bd944c) 8%,transparent);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,var(--bp-muted))}
.bp-child-preview-graph{height:280px;min-width:0;border-radius:var(--dsw-radius-md,12px);overflow:hidden;box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l4,#0000001a)}
.bp-child-preview .react-flow__node{color:inherit;background:var(--bp-raised)}
.bp-child-preview li small{display:block;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary,var(--bp-muted));font-size:11px;line-height:16px}

/* Breadcrumbs shared by the child composition, recovery previews and the conversation view. */
.bp-flow-breadcrumb{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:4px 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,var(--bp-muted))}
.bp-flow-breadcrumb button{height:24px;min-height:24px;padding:0 8px;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer}
.bp-flow-breadcrumb button:hover{background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,var(--bp-text) 6%,transparent));color:var(--dsw-alias-label-primary,var(--bp-text))}
.bp-flow-breadcrumb span[aria-current=page]{color:var(--dsw-alias-label-primary,var(--bp-text));font-weight:500;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}

/* Run hierarchy preview: a DSH dialog, not a bare page. */
.bp-workspace.bp-runtime-preview{position:fixed;inset:0;margin:auto;display:grid;align-content:start;gap:12px;width:min(880px,calc(100vw - 48px));max-height:calc(100vh - 48px);height:fit-content;overflow:auto;padding:0 0 24px;border:0;border-radius:var(--dsw-radius-panel,var(--dsw-radius-xl,20px));background:var(--dsw-alias-bg-layer-2,var(--bp-raised));color:var(--dsw-alias-label-primary,var(--bp-text));box-shadow:var(--dsw-elevation-prominent,inset 0 0 0 .5px #00000026,0 24px 64px #0000004d)}
.bp-runtime-preview::backdrop{background:var(--dsw-alias-bg-mask-1,#0000003d)}
.bp-runtime-preview-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:20px 24px 12px;box-shadow:inset 0 -.5px 0 var(--dsw-alias-border-l2,#00000014)}
.bp-runtime-preview-title{display:grid;gap:2px;min-width:0}
.bp-runtime-preview-title strong{font-size:16px;font-weight:500;line-height:24px;color:var(--dsw-alias-label-primary,var(--bp-text))}
.bp-runtime-preview-title .bp-help{margin:0}
.bp-runtime-preview [data-bp-preview-close]{flex:none;display:inline-flex;align-items:center;height:28px;min-height:28px;margin:0;padding:0 10px;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-secondary,var(--bp-muted));font:inherit;font-size:12px;line-height:18px;cursor:pointer}
.bp-runtime-preview [data-bp-preview-close]:hover{background:var(--dsw-alias-bg-layer-2,color-mix(in srgb,var(--bp-text) 5%,var(--bp-raised)))}
.bp-runtime-preview .bp-help{margin:0 24px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,var(--bp-muted))}
.bp-runtime-preview .bp-child-pin{display:block;margin:0 24px;color:var(--dsw-alias-label-tertiary,var(--bp-muted))}
.bp-runtime-preview [role=status]{margin:12px 24px 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,var(--bp-muted))}
.bp-runtime-preview>button:not([data-bp-preview-close]){justify-self:start;display:inline-flex;align-items:center;height:28px;min-height:28px;margin:8px 24px 0;padding:0 10px;border:0;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-1,var(--bp-raised));color:var(--dsw-alias-label-primary,var(--bp-text));font:inherit;font-size:12px;line-height:18px;cursor:pointer;box-shadow:0 0 0 .5px var(--dsw-alias-border-l3,#00000026)}
.bp-runtime-preview section{display:grid;gap:12px;min-width:0;margin:12px 24px 0}
.bp-runtime-attempts{list-style:none;margin:0;padding:0;display:grid;gap:6px}
.bp-runtime-attempts>li{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;min-width:0;padding:8px 10px;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-1,var(--bp-raised));box-shadow:0 0 0 .5px var(--dsw-alias-border-l4,#0000001a);font-size:12px;line-height:18px}
.bp-runtime-attempts>li>span{min-width:0;overflow-wrap:anywhere}
.bp-runtime-attempts button{display:inline-flex;align-items:center;height:28px;min-height:28px;padding:0 10px;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-secondary,var(--bp-muted));font:inherit;font-size:12px;line-height:18px;cursor:pointer}
.bp-runtime-attempts button:hover{background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,var(--bp-text) 6%,transparent));color:var(--dsw-alias-label-primary,var(--bp-text))}
.bp-runtime-preview li{display:flex;align-items:center;flex-wrap:wrap;gap:8px}
.bp-runtime-preview .react-flow__node{color:inherit;background:var(--bp-raised)}

/* Managed node composer: a DSH-like composer card injected under a node chat. */
.bp-workspace.bp-managed-composer{height:auto;box-sizing:border-box;width:100%;display:grid;gap:10px;margin:0 0 8px;padding:12px 14px;border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-1,var(--bp-raised));color:var(--dsw-alias-label-primary,var(--bp-text));box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l4,#0000001f)}
.bp-managed-composer strong{font-size:12px;font-weight:600;line-height:18px}
.bp-managed-composer p,.bp-managed-composer [role=status]{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,var(--bp-muted));text-wrap:pretty}
.bp-managed-composer label{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,var(--bp-muted))}
.bp-managed-composer textarea{width:100%;box-sizing:border-box;min-height:72px;max-height:180px;resize:vertical;padding:8px 10px;border:0;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-base,var(--bp-bg));color:var(--dsw-alias-label-primary,var(--bp-text));box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l4,#0000001f);font:inherit;font-size:13px;line-height:20px}
.bp-managed-composer textarea:focus{outline:none;box-shadow:inset 0 0 0 1px var(--dsw-alias-state-business-primary,var(--bp-accent))}
.bp-managed-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.bp-managed-actions label{display:inline-flex;align-items:center;gap:6px;height:32px;min-height:32px;padding:0 10px;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-base,var(--bp-bg));box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l4,#0000001f);cursor:pointer;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,var(--bp-muted))}
.bp-managed-actions label:has(input:checked){color:var(--dsw-alias-label-primary,var(--bp-text));box-shadow:inset 0 0 0 1px var(--dsw-alias-state-business-primary,var(--bp-accent))}
.bp-managed-actions input[type=radio]{width:auto;min-height:0;margin:0;accent-color:var(--dsw-alias-state-business-primary,var(--bp-accent))}
.bp-managed-actions button{display:inline-flex;align-items:center;justify-content:center;height:36px;min-height:36px;padding:0 14px;border:0;border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-button-primary-fill,var(--bp-accent));color:var(--dsw-alias-label-primary-foreground,#fff);font:inherit;font-size:14px;line-height:22px;font-weight:500;cursor:pointer}
.bp-managed-actions button:disabled{opacity:.5;cursor:default}
.bp-managed-actions button[data-bp-managed-retry]{background:var(--dsw-alias-bg-layer-1,var(--bp-raised));color:var(--dsw-alias-label-primary,var(--bp-text));box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l4,#0000001f)}
.bp-managed-composer [data-bp-managed-closed]{color:var(--dsw-alias-state-warn-primary,#bd944c)}
@container bp-workspace (max-width:480px){.bp-child-interface th,.bp-child-interface td{padding:6px}.bp-managed-actions{width:100%}.bp-managed-actions button{margin-left:auto}}
`
