/** Conversation-only geometry; feature lifecycle owns DOM installation. */
export const conversationCss = `
/* TeamStage facts: a compact definition list inside the read-only Run view. */
.bp-team-stage{display:grid;gap:8px;min-width:0;padding:10px 10px 12px;border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-1,var(--bp-raised));box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l4,#80808028)}
.bp-team-heading{display:flex;align-items:baseline;justify-content:space-between;gap:8px;min-width:0}
.bp-team-heading strong{font-size:12px;font-weight:500;line-height:18px;color:var(--dsw-alias-label-primary,var(--bp-text))}
.bp-team-state{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,var(--bp-muted));white-space:nowrap}
.bp-team-stage code{font-size:11px;line-height:16px;overflow-wrap:anywhere;white-space:normal;color:var(--dsw-alias-label-secondary,var(--bp-muted))}
.bp-team-facts{margin:0;display:grid;gap:6px;min-width:0}
.bp-team-facts>div{display:grid;gap:1px;min-width:0}
.bp-team-facts dt{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,var(--bp-muted))}
.bp-team-facts dd{margin:0;font-size:12px;line-height:17px;color:var(--dsw-alias-label-primary,var(--bp-text));min-width:0}
.bp-team-evidence summary{cursor:pointer;min-height:32px;display:flex;align-items:center;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,var(--bp-muted))}
.bp-team-evidence[open]{display:flex;flex-direction:column;gap:8px}
.bp-team-evidence ul{margin:0;padding-left:16px;font-size:11px;line-height:16px}
.bp-team-stale{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,var(--bp-muted))}
.bp-team-activity{display:grid;gap:6px;padding-block:8px;border-block:.5px solid var(--dsw-alias-border-l4,#80808028)}
.bp-team-activity>strong{font-size:11px;font-weight:500;line-height:16px;color:var(--dsw-alias-label-secondary,var(--bp-muted));letter-spacing:.02em}
.bp-team-member{display:grid;gap:1px;min-width:0;padding:6px 8px;border-radius:var(--dsw-radius-sm,8px);font-size:12px;line-height:17px;overflow-wrap:anywhere}
.bp-team-member:hover{background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,var(--bp-text) 5%,transparent))}
.bp-team-member small,.bp-member-activity{color:var(--dsw-alias-label-secondary,var(--bp-muted));font-size:11px;line-height:15px}
.bp-team-member code{font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary,var(--bp-muted));overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.bp-team-member button{justify-self:start;margin-top:2px;height:28px;min-height:28px;padding:0 10px;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-secondary,var(--bp-muted));font:inherit;font-size:12px;line-height:18px;cursor:pointer}
.bp-team-member button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,var(--bp-text) 6%,transparent));color:var(--dsw-alias-label-primary,var(--bp-text))}
.bp-team-member button:disabled{opacity:.4;cursor:default}
.bp-member-activity{padding:0 8px;overflow-wrap:anywhere}

/* Conversation root: DSH content surface, not a nested card. */
.bp-workspace.bp-conversation{height:calc(var(--dsh-conversation-viewport-height,100dvh) - var(--dsh-composer-height,0px));max-height:calc(var(--dsh-conversation-viewport-height,100dvh) - var(--dsh-composer-height,0px));min-height:0;width:100%;display:flex;flex-direction:column;overflow:hidden;background:var(--dsw-alias-bg-base,var(--bp-bg));color:var(--dsw-alias-label-primary,var(--bp-text));font-size:13px;line-height:1.5;font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}
.bp-conversation :is(h3,p,ul,li){margin:0;padding:0}

/* Run toolbar: one composer-style selector plus quiet 28 px icon actions; hidden while no Run is attached. */
.bp-conversation .bp-conversation-toolbar{flex:none;display:flex;align-items:center;gap:8px;flex-wrap:nowrap;padding:10px 24px;background:transparent;box-shadow:inset 0 -.5px 0 var(--dsw-alias-border-l3,#0000001f);z-index:2}
.bp-conversation.is-unbound .bp-conversation-toolbar{display:none}
.bp-conversation .bp-conversation-run{flex:0 1 560px;min-width:180px;max-width:min(560px,100%)}
.bp-conversation .bp-conversation-run .bp-select-trigger{height:36px;min-height:36px;padding:0 14px;border:0;border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-module-platform,var(--bp-raised));font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary,var(--bp-text));box-shadow:none}
.bp-conversation .bp-toolbar-actions{display:flex;align-items:center;gap:2px;margin-left:auto;padding:0;background:none;box-shadow:none}
.bp-conversation .bp-toolbar-actions .bp-icon-button{width:28px;min-width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-secondary,var(--bp-muted))}
.bp-conversation .bp-toolbar-actions .bp-icon-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,var(--bp-text) 8%,var(--bp-raised)));color:var(--dsw-alias-label-primary,var(--bp-text))}
.bp-conversation .bp-toolbar-actions .bp-icon-button:disabled{opacity:.4;cursor:default}
.bp-conversation .bp-toolbar-actions .bp-icon-button svg{width:16px;height:16px}

/* Breadcrumb: quiet 28 px chips. */
.bp-conversation .bp-flow-breadcrumb{flex:none;display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:8px 24px 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,var(--bp-muted))}
.bp-conversation .bp-flow-breadcrumb button{height:28px;min-height:28px;padding:0 8px;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer}
.bp-conversation .bp-flow-breadcrumb button:hover{background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,var(--bp-text) 6%,transparent));color:var(--dsw-alias-label-primary,var(--bp-text))}
.bp-conversation .bp-flow-breadcrumb span[aria-current=page]{color:var(--dsw-alias-label-primary,var(--bp-text));font-weight:500;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}

/* The Run status sentence is ambient; when the empty state or editor owns the copy it becomes screen-reader only. */
.bp-conversation-status{margin:0;padding:8px 24px 0;color:var(--dsw-alias-label-secondary,var(--bp-muted));font-size:12px;line-height:18px;overflow-wrap:anywhere;text-wrap:pretty}
.bp-conversation.is-unbound .bp-conversation-status,.bp-conversation.is-editing .bp-conversation-status{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}

/* DSH control grammar: 36 px md buttons, 28 px sm buttons, no press-scale on text buttons. */
.bp-conversation .bp-button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:36px;min-height:36px;padding:0 14px;border:0;border-radius:var(--dsw-radius-md,12px);background:transparent;color:var(--dsw-alias-label-primary,var(--bp-text));font:inherit;font-size:14px;line-height:22px;font-weight:400;white-space:nowrap;cursor:pointer;transition:background-color var(--ds-transition-duration-fast,.12s) var(--ds-ease-in-out,ease),box-shadow var(--ds-transition-duration-fast,.12s) var(--ds-ease-in-out,ease),color var(--ds-transition-duration-fast,.12s) var(--ds-ease-in-out,ease)}
.bp-conversation .bp-button:disabled{opacity:.4;cursor:default}
.bp-conversation .bp-button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,var(--bp-accent));outline-offset:2px}
.bp-conversation .bp-button-sm{height:28px;min-height:28px;padding:0 10px;border-radius:var(--dsw-radius-sm,8px);font-size:12px;line-height:18px}
.bp-conversation .bp-button-secondary{background:var(--dsw-alias-bg-layer-1,var(--bp-raised));box-shadow:0 0 0 .5px var(--dsw-alias-border-l3,#00000026)}
.bp-conversation .bp-button-secondary:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,var(--bp-text) 6%,var(--bp-raised)))}
.bp-conversation .bp-button-quiet{padding:0 10px;color:var(--dsw-alias-label-secondary,var(--bp-muted))}
.bp-conversation .bp-button-quiet:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,var(--bp-text) 6%,transparent));color:var(--dsw-alias-label-primary,var(--bp-text))}
.bp-conversation .bp-button-primary{background:var(--dsw-alias-button-primary-fill,var(--bp-accent));color:var(--dsw-alias-label-primary-foreground,#fff);font-weight:500;box-shadow:none}
.bp-conversation .bp-button-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,color-mix(in srgb,var(--bp-accent) 85%,var(--bp-text)))}

/* Scrollable plan content column. */
.bp-conversation-scroll{flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin}
.bp-conversation.is-bound .bp-conversation-scroll{flex:0 1 auto;max-height:44vh}

/* Saved plans: section header + DSH-style rows, no oversized outer card. */
.bp-conversation-plans{display:flex;flex-direction:column;gap:16px;box-sizing:border-box;width:100%;max-width:min(calc(100% - 32px),960px);margin:0 auto;padding:28px 24px 32px;min-width:0}
.bp-conversation-section-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;min-width:0}
.bp-conversation-section-copy{display:grid;gap:4px;min-width:0}
.bp-conversation-plans-title{margin:0;font-size:13px;font-weight:500;line-height:20px;letter-spacing:.01em;color:var(--dsw-alias-label-primary,var(--bp-text))}
.bp-conversation-plans-help{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,var(--bp-muted));overflow-wrap:anywhere;text-wrap:pretty}
.bp-conversation-plan-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px;min-width:0}
.bp-conversation .bp-conversation-plan{display:grid;gap:14px;min-width:0;padding:24px 28px;border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-1,var(--bp-raised));box-shadow:0 0 0 .5px var(--dsw-alias-border-l2,#0000001a);transition:background-color var(--ds-transition-duration-fast,.12s) var(--ds-ease-in-out,ease),box-shadow var(--ds-transition-duration-fast,.12s) var(--ds-ease-in-out,ease)}
.bp-conversation-plan:hover{box-shadow:0 0 0 .5px var(--dsw-alias-border-l3,#00000026)}
.bp-conversation-plan-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;min-width:0}
.bp-conversation-plan-title{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}
.bp-conversation-plan-name{font-size:13px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary,var(--bp-text));overflow-wrap:anywhere}
.bp-conversation-plan-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,var(--bp-muted))}
.bp-conversation-plan-status{display:inline-flex;align-items:center;gap:6px;height:20px;padding:0 8px;border-radius:999px;font-size:11px;line-height:16px;font-weight:500;color:var(--dsw-alias-label-secondary,var(--bp-muted));background:var(--dsw-alias-bg-module-platform,color-mix(in srgb,var(--bp-muted) 12%,transparent));white-space:nowrap}
.bp-conversation-plan-status-dot{flex:none;width:5px;height:5px;border-radius:50%;background:currentColor;opacity:.85}
.bp-conversation-plan-status.is-running,.bp-conversation-plan-status.is-starting{color:var(--dsw-alias-state-business-primary,var(--bp-accent));background:color-mix(in srgb,var(--dsw-alias-state-business-primary,var(--bp-accent)) 10%,transparent)}
.bp-conversation-plan-status.is-blocked{color:var(--dsw-alias-state-error-primary,#c4473a);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c4473a) 10%,transparent)}
.bp-conversation-plan-meta-dot{flex:none;width:2px;height:2px;border-radius:50%;background:currentColor;opacity:.45}
.bp-conversation-plan-identity{min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,var(--bp-muted))}
.bp-conversation-plan-actions{display:flex;align-items:center;gap:4px;flex:none;min-width:0;flex-wrap:wrap;justify-content:flex-end}
.bp-conversation-plan-open{display:inline-flex;max-width:240px;min-width:0;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px}
.bp-conversation-plan-open-label{min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bp-conversation-plan-input{margin:0;padding-top:12px;box-shadow:inset 0 .5px 0 var(--dsw-alias-border-l2,#00000014)}
.bp-conversation-plan-input>summary{display:flex;align-items:center;gap:6px;height:24px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,var(--bp-muted));list-style:none;cursor:pointer;user-select:none}
.bp-conversation-plan-input>summary::-webkit-details-marker{display:none}
.bp-conversation-plan-input>summary::before{content:'';flex:none;width:5px;height:5px;margin-inline-end:2px;border-inline-end:1px solid currentColor;border-block-end:1px solid currentColor;transform:rotate(-45deg);transition:transform var(--ds-transition-duration-fast,.12s) var(--ds-ease-in-out,ease)}
.bp-conversation-plan-input[open]>summary::before{transform:rotate(45deg)}
.bp-conversation-plan-input>summary:hover{color:var(--dsw-alias-label-secondary,var(--bp-muted))}
.bp-conversation-plan-input[open]>summary{margin-bottom:8px}
.bp-conversation-plan-field{display:grid;gap:6px;min-width:0;margin:0}
.bp-conversation-plan-field>span{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,var(--bp-muted))}
.bp-conversation-plan-field textarea{width:100%;min-height:60px;max-height:160px;resize:vertical;padding:8px 10px;border:0;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-base,var(--bp-bg));color:var(--dsw-alias-label-primary,var(--bp-text));box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l4,#0000001f);font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:12px;line-height:18px;tab-size:2}
.bp-conversation-plan-field textarea:focus{outline:none;box-shadow:inset 0 0 0 1px var(--dsw-alias-state-business-primary,var(--bp-accent))}
.bp-conversation-plan-run-button{flex:none;justify-self:end}
.bp-conversation-plan-error{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary,#c4473a);overflow-wrap:anywhere}

/* Empty state: one bare glyph, one sentence, one primary action. */
.bp-conversation-empty{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;box-sizing:border-box;width:100%;max-width:520px;margin:0 auto;padding:48px 24px;text-align:center;color:var(--dsw-alias-label-tertiary,var(--bp-muted));font-size:13px;line-height:20px;text-wrap:balance}
.bp-conversation-empty-icon{order:-1;flex:none;color:var(--dsw-alias-label-caption,var(--bp-muted));margin-bottom:4px}
.bp-conversation-empty-icon svg{width:30px;height:30px}
.bp-conversation-empty .bp-button-primary{order:1;margin-top:4px}
.bp-conversation-empty .bp-button-quiet{order:2;margin-top:-4px}

/* Embedded authoring panel: flush content, not a card around another workspace. */
.bp-conversation-editor{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;margin:0;padding:0;border-radius:0;background:transparent;box-shadow:none;overflow:visible}
.bp-conversation-editor-head{flex:none;display:flex;align-items:center;gap:8px;min-height:40px;padding:4px 24px;box-shadow:inset 0 -.5px 0 var(--dsw-alias-border-l2,#00000014)}
.bp-conversation-editor-body{flex:1 1 auto;min-height:0;overflow:hidden}
.bp-conversation-editor-body>.bp-workspace{height:100%}
.bp-conversation-editor-body .bp-toolbar{padding-top:8px;-webkit-app-region:no-drag}
.bp-conversation-editor-body [data-window-drag]{-webkit-app-region:no-drag}

/* Bound Run: flat canvas plus a compact attempts column. */
.bp-conversation-body{display:flex;flex:1 1 auto;min-width:0;min-height:0;height:0;gap:12px;padding:12px 16px 16px;overflow:hidden}
.bp-conversation-canvas{position:relative;flex:1;min-width:0;min-height:0;height:100%;background:var(--dsw-alias-bg-layer-1,var(--bp-bg));border-radius:var(--dsw-radius-md,12px);overflow:hidden;box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l4,#0000001a)}
.bp-conversation .bp-node{width:100%;height:auto}
.bp-conversation .bp-node-title{cursor:default}
.bp-conversation .bp-group-header{cursor:default;pointer-events:none}
.bp-conversation [data-bp-focus=true].bp-node{outline:1px solid var(--bp-accent);outline-offset:3px}
.bp-conversation-attempts{display:flex;flex-direction:column;gap:6px;width:clamp(200px,22%,280px);min-width:0;min-height:0;height:100%;max-height:100%;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;padding:2px;color:var(--dsw-alias-label-secondary,var(--bp-muted));scrollbar-width:thin;font-size:12px;line-height:18px}
.bp-conversation-attempts>strong{font-size:11px;font-weight:500;line-height:16px;letter-spacing:.04em;color:var(--dsw-alias-label-secondary,var(--bp-muted));padding:4px 4px 0}
.bp-conversation-attempts .bp-run-revision{min-width:0;padding:0 4px;overflow-wrap:anywhere;white-space:normal;flex-shrink:0;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary,var(--bp-muted))}
.bp-conversation-attempt{display:flex;flex-direction:column;gap:2px;min-width:0;flex-shrink:0}
.bp-conversation-attempts button{min-width:0;min-height:36px;text-align:left;white-space:normal;overflow-wrap:anywhere;padding:6px 10px;flex-shrink:0;border:0;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-1,var(--bp-raised));color:var(--dsw-alias-label-primary,var(--bp-text));font:inherit;font-size:12px;line-height:17px;cursor:pointer;box-shadow:0 0 0 .5px var(--dsw-alias-border-l4,#0000001a);transition:background-color var(--ds-transition-duration-fast,.12s) var(--ds-ease-in-out,ease),box-shadow var(--ds-transition-duration-fast,.12s) var(--ds-ease-in-out,ease)}
.bp-conversation-attempts button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,color-mix(in srgb,var(--bp-text) 5%,var(--bp-raised)))}
.bp-conversation-attempts button[aria-pressed=true]{box-shadow:inset 0 0 0 1px var(--dsw-alias-state-business-primary,var(--bp-accent))}
.bp-conversation-attempts button[data-bp-focus=true]{box-shadow:inset 2px 0 0 var(--dsw-alias-state-business-primary,var(--bp-accent)),0 0 0 .5px var(--dsw-alias-border-l4,#00000014)}
.bp-conversation-attempts button:disabled{opacity:.4;cursor:default}
.bp-conversation-attempts button small{display:block;margin-top:2px;color:var(--dsw-alias-label-tertiary,var(--bp-muted));font-size:11px;line-height:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bp-conversation-attempt .bp-help{margin:0;padding:0 4px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,var(--bp-muted))}
.bp-conversation-attempt [data-bp-failure-explanation]{margin:0;padding:8px 10px;border-radius:var(--dsw-radius-sm,8px);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#bd944c) 8%,transparent);font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,var(--bp-muted))}
.bp-conversation-attempts :is([data-bp-open-child],[data-bp-open-attempt],[data-bp-source-chat]){min-height:28px;height:28px;padding:0 10px;background:transparent;box-shadow:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,var(--bp-muted))}
.bp-conversation-attempts :is([data-bp-open-child],[data-bp-open-attempt],[data-bp-source-chat]):hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,var(--bp-text) 6%,transparent));color:var(--dsw-alias-label-primary,var(--bp-text))}
.bp-conversation-attempts :is([data-bp-open-child],[data-bp-open-attempt],[data-bp-source-chat]) small{display:none}

/* Recovery, load-more and archive controls. */
.bp-conversation-recovery{flex:none;display:grid;gap:10px;margin:0 24px 12px;padding:12px 14px;border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-1,var(--bp-raised));box-shadow:0 0 0 .5px var(--dsw-alias-border-l2,#00000014);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,var(--bp-muted))}
.bp-conversation-recovery strong{font-size:13px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary,var(--bp-text))}
.bp-conversation-recovery .bp-help{margin:0;font-size:12px;line-height:18px}
.bp-conversation-recovery .bp-field{gap:6px;margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,var(--bp-muted))}
.bp-conversation-recovery textarea{width:100%;min-height:64px;resize:vertical;padding:8px 10px;border:0;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-base,var(--bp-bg));color:var(--dsw-alias-label-primary,var(--bp-text));box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l4,#0000001f);font:inherit;font-size:12px;line-height:18px}
.bp-conversation-recovery textarea:focus{outline:none;box-shadow:inset 0 0 0 1px var(--dsw-alias-state-business-primary,var(--bp-accent))}
.bp-conversation-recovery button{justify-self:end;height:28px;min-height:28px;padding:0 10px;border:0;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-1,var(--bp-raised));color:var(--dsw-alias-label-primary,var(--bp-text));font:inherit;font-size:12px;line-height:18px;cursor:pointer;box-shadow:0 0 0 .5px var(--dsw-alias-border-l3,#00000026)}
.bp-conversation-recovery button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,var(--bp-text) 6%,var(--bp-raised)))}
.bp-conversation-recovery button:disabled{opacity:.4;cursor:default}
.bp-conversation-recovery [data-bp-action=recovery-failed]{background:transparent;box-shadow:0 0 0 .5px color-mix(in srgb,var(--dsw-alias-state-error-primary,#c4473a) 45%,transparent);color:var(--dsw-alias-state-error-primary,#c4473a)}
.bp-conversation-recovery [data-bp-action=recovery-failed]:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c4473a) 8%,transparent)}
.bp-conversation .bp-conversation-load-more{display:inline-flex;align-items:center;justify-content:center;align-self:center;margin:8px auto;height:28px;min-height:28px;padding:0 10px;border:0;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-1,var(--bp-raised));color:var(--dsw-alias-label-secondary,var(--bp-muted));font:inherit;font-size:12px;line-height:18px;cursor:pointer;box-shadow:0 0 0 .5px var(--dsw-alias-border-l4,#0000001f)}
.bp-conversation .bp-conversation-load-more:hover:not(:disabled){color:var(--dsw-alias-label-primary,var(--bp-text));background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,var(--bp-text) 5%,var(--bp-raised)))}
.bp-conversation .bp-conversation-load-more:disabled{opacity:.4;cursor:default}

.bp-conversation :is(button,select,textarea):focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,var(--bp-accent));outline-offset:2px}
@container bp-workspace (max-width:720px){
  .bp-conversation .bp-conversation-toolbar{padding:8px 12px}
  .bp-conversation .bp-conversation-run{flex:1 1 100%}
  .bp-conversation .bp-toolbar-actions{margin-left:0;justify-content:flex-end;width:100%}
  .bp-conversation-plans{max-width:100%;padding:16px 12px 20px}
  .bp-conversation-plan-head{flex-direction:column;align-items:stretch}
  .bp-conversation .bp-conversation-plan{padding:20px 22px}
  .bp-conversation-plan-actions{justify-content:flex-end}
  .bp-conversation-empty{padding:32px 16px}
  .bp-conversation-editor-head{padding:4px 12px}
  .bp-conversation-recovery{margin:0 12px 10px}
  .bp-conversation-body{gap:8px;padding:8px 12px 12px}
  .bp-conversation-attempts{width:auto;max-height:32%;order:-1;flex:0 1 32%;height:auto}
  .bp-conversation-body{flex-direction:column}
  .bp-conversation-canvas{flex:1;min-height:0;height:auto;width:100%}
}
@media(prefers-reduced-motion:reduce){
  .bp-conversation .bp-button,.bp-conversation .bp-conversation-plan,.bp-conversation .bp-conversation-attempts button{transition:none}
}
`
