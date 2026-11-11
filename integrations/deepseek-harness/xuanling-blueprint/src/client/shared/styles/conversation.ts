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

/* Run ribbon: one 28 px DSH picker, the connection caption and quiet actions.
   The durable Run id lives in the picker title; the visible row stays a single
   line so the control matches the host's own model/workspace pickers. */
.bp-conversation .bp-conversation-toolbar{flex:none;display:flex;align-items:center;gap:8px;flex-wrap:nowrap;min-height:44px;padding:8px 16px;background:transparent;box-shadow:inset 0 -.5px 0 var(--dsw-alias-border-l3,#0000001f);z-index:2}
.bp-conversation.is-unbound .bp-conversation-toolbar{display:none}
.bp-conversation .bp-select.bp-conversation-run{flex:0 1 auto;width:max-content;min-width:0;max-width:min(340px,46%)}
.bp-conversation .bp-select.bp-conversation-run > button.bp-select-trigger{position:relative;height:28px;min-height:28px;gap:4px;padding:0 4px 0 8px;border:0;border-radius:8px;background:transparent;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,var(--bp-text));box-shadow:none;transition:background-color var(--ds-transition-duration-fast,.12s) var(--ds-ease-in-out,ease)}
.bp-conversation .bp-select.bp-conversation-run > button.bp-select-trigger:hover:not(:disabled),.bp-conversation .bp-select.bp-conversation-run > button.bp-select-trigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,var(--bp-text) 6%,transparent));box-shadow:none}
.bp-conversation .bp-select.bp-conversation-run > button.bp-select-trigger:disabled{opacity:.4}
.bp-conversation .bp-conversation-run .bp-select-value{display:flex;flex:1 1 auto;align-items:center;min-width:0}
.bp-conversation .bp-run-trigger{display:flex;align-items:center;gap:6px;min-width:0;width:100%;text-align:left}
.bp-conversation .bp-run-trigger-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:20px;font-weight:500;letter-spacing:.005em;color:var(--dsw-alias-label-primary,var(--bp-text))}
.bp-conversation .bp-run-trigger-dot{flex:none;width:5px;height:5px;border-radius:50%;background:color-mix(in srgb,var(--dsw-alias-label-tertiary,var(--bp-muted)) 75%,transparent)}
.bp-conversation .bp-run-trigger-dot[data-bp-run-state=running],.bp-conversation .bp-run-trigger-dot[data-bp-run-state=queued],.bp-conversation .bp-run-trigger-dot[data-bp-run-state=cancelling]{background:var(--dsw-alias-state-business-primary,var(--bp-accent))}
.bp-conversation .bp-run-trigger-dot[data-bp-run-state=waiting_input],.bp-conversation .bp-run-trigger-dot[data-bp-run-state=recovery_required]{background:var(--bp-warn,#bd944c)}
.bp-conversation .bp-run-trigger-dot[data-bp-run-state=failed],.bp-conversation .bp-run-trigger-dot[data-bp-run-state=timed_out]{background:var(--bp-danger,#c46b6b)}
.bp-conversation .bp-run-trigger-dot[data-bp-run-state=succeeded]{background:var(--bp-kind-agent-task)}
.bp-conversation .bp-run-trigger-state{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.bp-conversation .bp-toolbar-actions{display:flex;align-items:center;gap:2px;margin-left:auto;min-width:0;padding:0;background:none;box-shadow:none}
.bp-conversation .bp-toolbar-divider{flex:none;width:1px;height:16px;margin:0 4px;background:var(--dsw-alias-border-l3,#ffffff17)}
.bp-conversation .bp-toolbar-actions button.bp-conversation-archive{position:relative;display:inline-flex;align-items:center;justify-content:center;flex:none;width:auto;height:28px;min-height:28px;padding:0 9px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,var(--bp-muted));font:inherit;font-size:12px;line-height:18px;cursor:pointer;transition:background-color var(--ds-transition-duration-fast,.12s) var(--ds-ease-in-out,ease),color var(--ds-transition-duration-fast,.12s) var(--ds-ease-in-out,ease),transform var(--ds-transition-duration-fast,.12s) var(--ds-ease-in-out,ease)}
.bp-conversation .bp-toolbar-actions button.bp-conversation-archive::after{content:'';position:absolute;inset:-6px -3px;border-radius:10px}
.bp-conversation .bp-toolbar-actions button.bp-conversation-archive:active:not(:disabled){transform:scale(.96)}
.bp-conversation .bp-toolbar-actions button.bp-conversation-archive:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-label-primary,var(--bp-text)) 6%,transparent);color:var(--dsw-alias-label-secondary,var(--bp-muted))}
.bp-conversation .bp-toolbar-actions button.bp-conversation-archive.is-confirming{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c4473a) 10%,transparent);color:var(--dsw-alias-state-error-primary,#c4473a)}
.bp-conversation .bp-toolbar-actions button.bp-icon-button{position:relative;display:inline-flex;align-items:center;justify-content:center;width:28px;min-width:28px;height:28px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,var(--bp-muted));transition:background-color var(--ds-transition-duration-fast,.12s) var(--ds-ease-in-out,ease),color var(--ds-transition-duration-fast,.12s) var(--ds-ease-in-out,ease),transform var(--ds-transition-duration-fast,.12s) var(--ds-ease-in-out,ease)}
.bp-conversation .bp-toolbar-actions button.bp-icon-button::after{content:'';position:absolute;inset:-6px;border-radius:10px}
.bp-conversation .bp-toolbar-actions button.bp-icon-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,var(--bp-text) 8%,var(--bp-raised)));color:var(--dsw-alias-label-primary,var(--bp-text))}
.bp-conversation .bp-toolbar-actions button.bp-icon-button:active:not(:disabled){transform:scale(.96)}
.bp-conversation .bp-toolbar-actions button.bp-icon-button:disabled{opacity:.35;cursor:default}
.bp-conversation .bp-toolbar-actions button.bp-icon-button svg{width:16px;height:16px}
@media(prefers-reduced-motion:reduce){.bp-conversation .bp-toolbar-actions button{transition:none}.bp-conversation .bp-toolbar-actions button:active:not(:disabled){transform:none}}

/* Breadcrumb: quiet 28 px chips aligned to the ribbon gutter. */
.bp-conversation .bp-flow-breadcrumb{flex:none;display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:8px 16px 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,var(--bp-muted))}
.bp-conversation .bp-flow-breadcrumb button{height:28px;min-height:28px;padding:0 8px;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer}
.bp-conversation .bp-flow-breadcrumb button:hover{background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,var(--bp-text) 6%,transparent));color:var(--dsw-alias-label-primary,var(--bp-text))}
.bp-conversation .bp-flow-breadcrumb span[aria-current=page]{color:var(--dsw-alias-label-primary,var(--bp-text));font-weight:500;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}

/* The Run status sentence is ambient; when the empty state or editor owns the copy it becomes screen-reader only. */
.bp-conversation .bp-conversation-status{margin:0;padding:0;min-width:0;flex:0 1 auto;color:var(--dsw-alias-label-tertiary,var(--bp-muted));font-size:11px;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-wrap:pretty}
.bp-conversation .bp-conversation-status::before{content:'';display:inline-block;width:5px;height:5px;margin-inline-end:6px;border-radius:50%;background:color-mix(in srgb,var(--bp-kind-agent-task) 80%,transparent);vertical-align:1px}
.bp-conversation[data-bp-connection=loading] .bp-conversation-status::before{background:color-mix(in srgb,var(--dsw-alias-label-tertiary,var(--bp-muted)) 70%,transparent)}
.bp-conversation[data-bp-connection=stale] .bp-conversation-status::before{background:var(--bp-warn,#bd944c)}
.bp-conversation[data-bp-connection=unavailable] .bp-conversation-status::before{background:var(--bp-danger,#c46b6b)}
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
/* The embedded panel is content, not window chrome: suppress the host drag mark
   with higher specificity than html[data-platform=darwin] [data-window-drag]. */
html[data-platform=darwin] .bp-workspace.bp-conversation .bp-conversation-editor-body [data-window-drag]{-webkit-app-region:no-drag}
html[data-platform=darwin] .bp-workspace.bp-conversation .bp-conversation-editor-body .bp-editor-toolbar{box-sizing:border-box;height:auto;min-height:48px;padding:6px 12px;-webkit-app-region:no-drag}

/* Bound Run: flat canvas plus a compact attempts column. */
.bp-conversation-body{display:flex;flex:1 1 auto;min-width:0;min-height:0;height:0;gap:12px;padding:12px 16px 16px;overflow:hidden}
.bp-conversation-canvas{position:relative;flex:1;min-width:0;min-height:0;height:100%;background:var(--dsw-alias-bg-layer-1,var(--bp-bg));border-radius:var(--dsw-radius-md,12px);overflow:hidden;box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l4,#0000001a)}
/* Read-only node readout: a 56 px header (title, kind, state chip) over dense
   26 px port captions. Handles stay visible as facts, not as wiring targets. */
.bp-conversation .bp-node{width:100%;height:auto;border-radius:10px;cursor:pointer}
.bp-conversation .bp-node-title{position:relative;display:flex;flex-direction:row;align-items:flex-start;justify-content:space-between;gap:10px;min-height:0;padding:10px 12px 9px 14px;border-radius:10px 10px 0 0;cursor:inherit}
.bp-conversation .bp-node-title::before{content:'';position:absolute;left:0;top:0;bottom:0;width:2px;border-radius:10px 0 0 0;background:var(--bp-kind,var(--bp-muted));opacity:.85}
.bp-conversation .bp-node[data-bp-color]:not([data-bp-color=default]) .bp-node-title::before{display:none}
.bp-conversation .bp-node-heading{display:grid;gap:1px;min-width:0}
.bp-conversation .bp-node-title strong{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:18px;font-weight:600;letter-spacing:.005em;color:var(--dsw-alias-label-primary,var(--bp-text))}
.bp-conversation .bp-node-title .bp-kind{display:inline-flex;align-items:center;gap:4px;min-width:0;font-size:11px;line-height:15px;letter-spacing:.03em;color:color-mix(in srgb,var(--bp-kind,var(--bp-muted)) 74%,var(--dsw-alias-label-secondary,var(--bp-muted)))}
.bp-conversation .bp-node-title .bp-kind::before{content:'';flex:none;width:4px;height:4px;border-radius:50%;background:currentColor;opacity:.9}
.bp-conversation .bp-port-columns{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-top:1px solid color-mix(in srgb,var(--bp-kind,var(--bp-muted)) 18%,transparent)}
.bp-conversation .bp-port-columns>div{max-width:50%}
.bp-conversation .bp-port-row{position:relative;display:flex;align-items:center;min-height:26px;padding:0 14px;color:var(--dsw-alias-label-secondary,var(--bp-muted));font-size:11px;line-height:15px;letter-spacing:.01em;white-space:nowrap}
.bp-conversation .bp-port-out{justify-content:flex-end}
.bp-conversation .bp-node .react-flow__handle{width:8px;height:8px;min-width:8px;min-height:8px;border:2px solid var(--bp-raised);background:color-mix(in srgb,var(--bp-kind,var(--bp-muted)) 72%,var(--bp-text))}
.bp-conversation .bp-node .bp-handle-control{border-radius:2px;background:color-mix(in srgb,var(--bp-kind,var(--bp-muted)) 48%,var(--bp-muted))}
.bp-conversation .bp-group-header{cursor:default;pointer-events:none}
.bp-conversation [data-bp-focus=true].bp-node{outline:1px solid var(--bp-accent);outline-offset:3px}

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

/* Archify runtime visuals: semantic kind palette, state chips, edge semantics.
   Each hue is mixed with the host label token, so the same declaration stays
   legible on the dark and the light host surface without color-scheme tricks.
   Marker colors stay hex constants on the TS projection (SVG paint). */
.bp-conversation{--bp-accent:var(--dsw-alias-state-business-primary,#7aaaff);--bp-kind-input:color-mix(in srgb,#7f90a6 78%,var(--bp-text));--bp-kind-agent-task:color-mix(in srgb,#2f9e6f 78%,var(--bp-text));--bp-kind-output:color-mix(in srgb,#1f8fa6 78%,var(--bp-text));--bp-kind-blueprint-call:color-mix(in srgb,#d97742 78%,var(--bp-text));--bp-kind-condition:color-mix(in srgb,#c58a1e 78%,var(--bp-text));--bp-kind-human-decision:color-mix(in srgb,#d1506b 78%,var(--bp-text));--bp-kind-join:color-mix(in srgb,#8b7bd8 78%,var(--bp-text))}
.bp-conversation .bp-node[data-bp-kind=input]{--bp-kind:var(--bp-kind-input)}
.bp-conversation .bp-node[data-bp-kind=output]{--bp-kind:var(--bp-kind-output)}
.bp-conversation .bp-node[data-bp-kind=agentTask]{--bp-kind:var(--bp-kind-agent-task)}
.bp-conversation .bp-node[data-bp-kind=blueprintCall]{--bp-kind:var(--bp-kind-blueprint-call)}
.bp-conversation .bp-node[data-bp-kind=condition]{--bp-kind:var(--bp-kind-condition)}
.bp-conversation .bp-node[data-bp-kind=humanDecision]{--bp-kind:var(--bp-kind-human-decision)}
.bp-conversation .bp-node[data-bp-kind=join]{--bp-kind:var(--bp-kind-join)}
.bp-conversation .bp-node[data-bp-kind]{border-radius:10px;background:color-mix(in srgb,var(--bp-kind,var(--bp-muted)) 9%,var(--bp-raised));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--bp-kind,var(--bp-muted)) 30%,transparent),0 1px 2px #00000030,0 12px 28px -18px #00000080}
.bp-conversation .bp-node[data-bp-kind] .bp-kind{letter-spacing:.03em}
.bp-conversation .bp-node[data-bp-raw-state=running],.bp-conversation .bp-node[data-bp-raw-state=preparing]{box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--bp-accent) 60%,transparent),0 0 0 3px color-mix(in srgb,var(--bp-accent) 10%,transparent),0 0 18px -6px color-mix(in srgb,var(--bp-accent) 40%,transparent)}
.bp-conversation .bp-node[data-bp-raw-state=failed],.bp-conversation .bp-node[data-bp-raw-state=timed_out]{--bp-kind:var(--bp-danger,#c46b6b);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--bp-danger,#c46b6b) 55%,transparent),0 0 16px -8px color-mix(in srgb,var(--bp-danger,#c46b6b) 40%,transparent)}
.bp-conversation .bp-node.bp-node-selected{box-shadow:inset 0 0 0 1.5px color-mix(in srgb,var(--bp-accent) 72%,transparent),0 0 0 4px color-mix(in srgb,var(--bp-accent) 12%,transparent),0 12px 28px -16px #00000080}
.bp-conversation .bp-state-badge{display:inline-flex;flex:none;align-items:center;gap:4px;max-width:62%;height:20px;padding:0 7px;border-radius:6px;overflow:hidden;text-overflow:ellipsis;font-size:10.5px;line-height:20px;font-weight:500;font-variant-numeric:tabular-nums;white-space:nowrap;background:color-mix(in srgb,var(--dsw-alias-label-primary,var(--bp-text)) 8%,transparent);color:var(--dsw-alias-label-secondary,var(--bp-muted))}
.bp-conversation .bp-state-badge[data-bp-state-badge=running],.bp-conversation .bp-state-badge[data-bp-state-badge=preparing]{background:color-mix(in srgb,var(--bp-accent) 13%,transparent);color:var(--bp-accent)}
.bp-conversation .bp-state-badge[data-bp-state-badge=succeeded]{background:color-mix(in srgb,var(--bp-kind-agent-task) 13%,transparent);color:var(--bp-kind-agent-task)}
.bp-conversation .bp-state-badge[data-bp-state-badge=failed],.bp-conversation .bp-state-badge[data-bp-state-badge=timed_out]{background:color-mix(in srgb,var(--bp-danger,#c46b6b) 13%,transparent);color:var(--bp-danger,#c46b6b)}
.bp-conversation .bp-state-badge[data-bp-state-badge=waiting_input],.bp-conversation .bp-state-badge[data-bp-state-badge=recovery_required]{background:color-mix(in srgb,var(--bp-warn,#bd944c) 14%,transparent);color:var(--bp-warn,#bd944c)}
.bp-conversation .bp-pulse-dot{position:static;flex:none;width:5px;height:5px;border-radius:50%;background:currentColor;animation:bp-pulse-dot 2s ease-in-out infinite}
@keyframes bp-pulse-dot{0%,100%{opacity:.35;transform:scale(.85)}50%{opacity:1;transform:scale(1.1)}}
.bp-conversation .bp-member-elapsed{margin-left:6px;padding:1px 6px;border-radius:999px;background:color-mix(in srgb,var(--bp-muted) 10%,transparent);color:var(--bp-muted);font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:10px;line-height:14px;font-variant-numeric:tabular-nums}
.bp-conversation .bp-edge-traversed .react-flow__edge-path{stroke:var(--bp-kind-agent-task);stroke-width:1.8;animation:none}
.bp-conversation .bp-edge-motion .react-flow__edge-path{stroke:var(--bp-accent);stroke-width:2;stroke-dasharray:6 6;animation:bp-edge-trace 1.2s linear infinite}
@keyframes bp-edge-trace{to{stroke-dashoffset:-12}}
.bp-conversation .react-flow__edge-path{stroke:color-mix(in srgb,var(--bp-muted) 75%,transparent);stroke-width:1.4}
.bp-conversation .bp-edge-control .react-flow__edge-path{stroke:color-mix(in srgb,var(--bp-muted) 60%,transparent);stroke-width:1.2}
.bp-conversation .bp-edge-control.bp-edge-motion .react-flow__edge-path{stroke:var(--bp-accent);stroke-width:2;stroke-dasharray:6 6;animation:bp-edge-trace 1.2s linear infinite}
.bp-conversation-canvas{background-image:radial-gradient(circle,color-mix(in srgb,var(--bp-muted) 14%,transparent) 1px,transparent 1px),radial-gradient(ellipse at 50% 46%,color-mix(in srgb,var(--bp-text) 3.5%,transparent),transparent 88%);background-size:24px 24px,100% 100%}
.bp-conversation .react-flow__attribution{opacity:.4}
.bp-conversation .react-flow__attribution:hover{opacity:.75}
.bp-conversation .react-flow__minimap{border-radius:10px;opacity:.85;box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l3,#ffffff17),0 10px 28px -14px #000000a6;transition:opacity var(--ds-transition-duration-fast,.12s) var(--ds-ease-in-out,ease)}
.bp-conversation .react-flow__minimap:hover{opacity:1}
.bp-conversation .react-flow__minimap-mask{stroke:color-mix(in srgb,var(--bp-muted) 40%,transparent);stroke-width:1}
@media(prefers-reduced-motion:reduce){.bp-conversation .bp-pulse-dot{animation:none;opacity:.9}.bp-conversation .bp-edge-motion .react-flow__edge-path{animation:none;stroke-dasharray:none}}
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
  .bp-conversation-body{flex-direction:column}
  .bp-conversation-canvas{flex:1;min-height:0;height:auto;width:100%}
}
/* Runtime overlays: legend status card, attempt picker popover, team stage
   card. All float above the canvas and never enter the node measurement box. */
.bp-conversation-legend{position:absolute;z-index:8;top:12px;left:12px;display:flex;align-items:center;gap:2px;flex-wrap:wrap;max-width:calc(100% - 24px);padding:4px 6px;border-radius:10px;background:color-mix(in srgb,var(--bp-bg) 84%,transparent);box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l3,#ffffff17),0 10px 28px -14px #00000066;backdrop-filter:blur(10px) saturate(120%)}
.bp-conversation .bp-run-revision{display:inline-flex;align-items:center;gap:5px;flex:none;height:26px;margin-inline-end:4px;padding:0 8px 0 7px;border-radius:6px;background:color-mix(in srgb,var(--dsw-alias-label-primary,var(--bp-text)) 5%,transparent);font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:10.5px;line-height:16px;letter-spacing:.02em;color:var(--dsw-alias-label-secondary,var(--bp-muted));white-space:nowrap}
.bp-conversation .bp-run-revision-label{font-family:inherit;font-size:9px;line-height:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,var(--bp-muted));opacity:.85}
.bp-conversation .bp-legend-chip{display:inline-flex;align-items:center;gap:6px;height:26px;min-height:26px;padding:0 8px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,var(--bp-muted));font:inherit;font-size:11px;line-height:16px;cursor:pointer;font-variant-numeric:tabular-nums;transition:background-color var(--ds-transition-duration-fast,.12s) var(--ds-ease-in-out,ease),color var(--ds-transition-duration-fast,.12s) var(--ds-ease-in-out,ease)}
.bp-conversation .bp-legend-chip:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,var(--bp-text) 6%,transparent));color:var(--dsw-alias-label-primary,var(--bp-text))}
.bp-conversation .bp-legend-chip::before{content:'';flex:none;width:5px;height:5px;border-radius:50%;background:currentColor}
.bp-conversation .bp-legend-chip.is-running{color:var(--bp-accent)}
.bp-conversation .bp-legend-chip.is-failed{color:var(--bp-danger,#c46b6b)}
.bp-conversation .bp-legend-chip.is-waiting{color:var(--bp-warn,#bd944c)}
.bp-conversation .bp-legend-count{display:inline-flex;align-items:center;justify-content:center;min-width:17px;height:17px;padding:0 4px;border-radius:5px;background:color-mix(in srgb,currentColor 14%,transparent);font-size:10px;line-height:12px;font-weight:500}
.bp-conversation .bp-legend-chip[data-bp-legend-count="0"]{opacity:.45}
.bp-conversation .bp-legend-chip[data-bp-legend-count="0"]:hover{opacity:.8}
.bp-attempt-picker{position:absolute;z-index:12;top:calc(100% + 6px);left:0;min-width:220px;max-width:min(320px,100%);display:none;grid;gap:2px;padding:6px;border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-1,var(--bp-raised));color:var(--bp-text);box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l4,#80808028),0 6px 24px #00000040}
.bp-attempt-picker.is-open{display:grid}
.bp-attempt-choice{display:grid;gap:4px;padding:6px 8px;border-radius:var(--dsw-radius-sm,8px)}
.bp-attempt-choice:hover{background:color-mix(in srgb,var(--bp-text) 6%,transparent)}
.bp-attempt-choice>button{min-height:28px;height:28px;padding:0 8px;text-align:left;background:transparent;border:0;box-shadow:none;font:inherit;font-size:12px;line-height:17px;overflow-wrap:anywhere;white-space:normal;cursor:pointer;color:inherit}
.bp-attempt-choice>button:hover:not(:disabled){background:color-mix(in srgb,var(--bp-text) 8%,transparent)}
.bp-attempt-choice [data-bp-open-attempt],.bp-attempt-choice [data-bp-open-child]{min-height:24px;height:24px;padding:0 8px;background:transparent;border:0;box-shadow:none;font:inherit;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,var(--bp-muted));cursor:pointer;justify-self:start}
.bp-attempt-choice [data-bp-open-attempt]:hover:not(:disabled),.bp-attempt-choice [data-bp-open-child]:hover:not(:disabled){color:var(--dsw-alias-label-primary,var(--bp-text))}
.bp-attempt-picker [data-bp-picker-legacy]{opacity:.55;cursor:default;display:block;width:100%;text-align:left;border:0;background:transparent;font:inherit;font-size:12px;line-height:17px;overflow-wrap:anywhere;white-space:normal}
.bp-attempt-picker [data-bp-picker-legacy] small{display:block;margin-top:2px;color:var(--bp-muted);font-size:11px;line-height:15px}
.bp-attempt-failure{position:absolute;z-index:11;bottom:calc(100% + 6px);left:0;max-width:min(320px,100%);display:grid;gap:6px;padding:8px 10px;border-radius:var(--dsw-radius-sm,8px);background:color-mix(in srgb,var(--bp-warn,#bd944c) 8%,var(--dsw-alias-bg-layer-1,var(--bp-raised)));box-shadow:inset 0 0 0 .5px color-mix(in srgb,var(--bp-warn,#bd944c) 35%,transparent);font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,var(--bp-muted))}
.bp-attempt-failure p{margin:0;overflow-wrap:anywhere}
.bp-attempt-failure [data-bp-open-attempt],.bp-attempt-failure [data-bp-source-chat]{min-height:26px;height:26px;padding:0 8px;background:transparent;border:0;box-shadow:none;font:inherit;font-size:11px;line-height:16px;color:var(--dsw-alias-label-primary,var(--bp-text));cursor:pointer;justify-self:start}
.bp-attempt-failure [data-bp-open-attempt]:hover:not(:disabled),.bp-attempt-failure [data-bp-source-chat]:hover:not(:disabled){background:color-mix(in srgb,var(--bp-text) 6%,transparent)}
.bp-attempt-failure [data-bp-open-attempt]:disabled{opacity:.4;cursor:default}
.bp-node>.bp-help{position:absolute;z-index:11;bottom:calc(100% + 4px);left:0;margin:0;padding:4px 8px;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-1,var(--bp-raised));box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l4,#80808028);font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,var(--bp-muted));overflow-wrap:anywhere}
.bp-conversation-team-card{position:absolute;z-index:8;top:52px;right:12px;max-width:min(360px,calc(100% - 24px));max-height:calc(100% - 72px);overflow:auto;border:0;border-radius:var(--dsw-radius-md,12px);background:color-mix(in srgb,var(--bp-bg) 86%,transparent);box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l4,#80808028),0 8px 24px #00000030;backdrop-filter:blur(8px);font-size:12px}
.bp-conversation-team-card>summary{cursor:pointer;min-height:32px;display:flex;align-items:center;padding:4px 12px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,var(--bp-muted));list-style:none;user-select:none}
.bp-conversation-team-card>summary::-webkit-details-marker{display:none}
@media(prefers-reduced-motion:reduce){
  .bp-conversation .bp-button,.bp-conversation .bp-conversation-plan{transition:none}
}
`
