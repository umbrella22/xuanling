/** Conversation-only geometry; feature lifecycle owns DOM installation. */
export const conversationCss = `
.bp-team-stage{display:flex;flex-direction:column;gap:8px;min-width:0;padding-bottom:12px;border-bottom:1px solid var(--bp-border)}
.bp-team-heading{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.bp-team-state{font-size:11px;color:var(--bp-text)}
.bp-team-stage code{font-size:11px;overflow-wrap:anywhere;white-space:normal}
.bp-team-facts{margin:0;display:grid;gap:6px}
.bp-team-facts dt{font-size:11px;color:var(--bp-muted)}
.bp-team-facts dd{margin:2px 0 0;color:var(--bp-text);min-width:0}
.bp-team-evidence summary{cursor:pointer;font-size:12px}
.bp-team-evidence[open]{display:flex;flex-direction:column;gap:8px}
.bp-team-evidence ul{margin:0;padding-left:18px;font-size:11px}
.bp-team-stale{margin:0;font-size:11px;color:var(--bp-muted)}
.bp-workspace.bp-conversation{height:calc(var(--dsh-conversation-viewport-height,100dvh) - var(--dsh-composer-height,0px));max-height:calc(var(--dsh-conversation-viewport-height,100dvh) - var(--dsh-composer-height,0px));min-height:0;width:100%;display:flex;flex-direction:column;overflow:hidden;color:var(--dsw-alias-label-primary,var(--bp-text));font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}
.bp-conversation .bp-toolbar{flex-wrap:wrap;gap:8px;flex:none}
.bp-conversation .bp-conversation-run{flex:1 1 180px;min-width:0;max-width:100%;min-height:40px}
.bp-conversation .bp-toolbar-actions{gap:4px;margin-left:auto;flex-wrap:wrap}
.bp-conversation-status{margin:0;padding:8px 12px;color:var(--dsw-alias-label-secondary,var(--bp-muted));font-size:12px;overflow-wrap:anywhere;text-wrap:pretty}
.bp-conversation-body{display:flex;flex:1 1 auto;min-width:0;min-height:0;height:0;gap:8px;overflow:hidden}
.bp-conversation-canvas{position:relative;flex:1;min-width:0;min-height:0;height:100%;background:var(--dsw-alias-bg-layer-1,var(--bp-bg));border-radius:var(--dsw-radius-md,12px);overflow:hidden}
.bp-conversation .bp-node{width:100%;height:auto}
.bp-conversation .bp-node-title{cursor:default}
.bp-conversation .bp-group-header{cursor:default;pointer-events:none}
.bp-conversation [data-bp-focus=true].bp-node{outline:1px solid var(--bp-accent);outline-offset:3px}
.bp-conversation-attempts{display:flex;flex-direction:column;gap:8px;width:clamp(160px,26%,240px);min-width:0;min-height:0;height:100%;max-height:100%;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;padding:8px;color:var(--dsw-alias-label-secondary,var(--bp-muted));scrollbar-width:thin}
.bp-conversation-attempts .bp-run-revision{min-width:0;overflow-wrap:anywhere;white-space:normal;flex-shrink:0}
.bp-conversation-attempt{display:flex;flex-direction:column;gap:4px;min-width:0;flex-shrink:0}
.bp-conversation-attempts button{min-width:40px;min-height:40px;text-align:left;white-space:normal;overflow-wrap:anywhere;padding:8px;flex-shrink:0;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-2,var(--bp-raised));color:var(--dsw-alias-label-primary,var(--bp-text));border:0.5px solid var(--dsw-alias-border-l4,#80808030)}
.bp-conversation-attempts button[aria-pressed=true]{box-shadow:inset 0 0 0 1px var(--bp-accent)}
.bp-conversation-attempts button[data-bp-focus=true]{border-inline-start:2px solid var(--bp-accent)}
.bp-conversation-attempts button small{display:block;color:var(--dsw-alias-label-secondary,var(--bp-muted));font-size:11px}
.bp-team-activity{display:flex;flex-direction:column;gap:6px;padding-block:8px;border-block:1px solid var(--dsw-alias-border-l4,#80808030)}
.bp-team-member{display:flex;flex-direction:column;gap:2px;overflow-wrap:anywhere;font-size:12px}
.bp-team-member small,.bp-member-activity{color:var(--dsw-alias-label-secondary,var(--bp-muted));font-size:11px;line-height:1.5}
.bp-member-activity{padding:2px 8px;overflow-wrap:anywhere}
.bp-conversation-empty{padding:32px 16px;color:var(--dsw-alias-label-secondary,var(--bp-muted));text-wrap:pretty}
.bp-conversation-plans{display:flex;flex-direction:column;gap:8px;padding:12px;margin:0 12px 8px;background:var(--dsw-alias-bg-layer-1,var(--bp-raised));border-radius:var(--dsw-radius-md,12px);border:1px solid var(--dsw-alias-border-l4,#80808030);min-width:0}
.bp-conversation-plans-title{margin:0;font-size:13px;line-height:1.4;color:var(--dsw-alias-label-primary,var(--bp-text));letter-spacing:.01em}
.bp-conversation-plans-help{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary,var(--bp-muted))}
.bp-conversation-plan-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px;min-width:0}
.bp-conversation-plan{display:flex;gap:12px;align-items:flex-start;min-width:0;padding:10px 12px;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-2,var(--bp-bg));border-inline-start:2px solid var(--dsw-alias-border-l3,#80808040)}
.bp-conversation-plan.is-saved{border-inline-start-color:var(--dsw-alias-state-business-primary,var(--bp-accent))}
.bp-conversation-plan.is-blocked{border-inline-start-color:var(--dsw-alias-state-error-primary,#c4473a)}
.bp-conversation-plan.is-running,.bp-conversation-plan.is-starting{border-inline-start-color:var(--dsw-alias-state-business-primary,var(--bp-accent))}
.bp-conversation-plan-main{display:flex;flex-direction:column;gap:3px;flex:1 1 auto;min-width:0}
.bp-conversation-plan-name{font-size:13px;font-weight:600;line-height:1.35;color:var(--dsw-alias-label-primary,var(--bp-text));overflow-wrap:anywhere}
.bp-conversation-plan-meta{font-size:11px;line-height:1.4;color:var(--dsw-alias-label-secondary,var(--bp-muted));overflow-wrap:anywhere}
.bp-conversation-plan-identity{display:flex;gap:8px;flex-wrap:wrap;font-size:10px;color:var(--dsw-alias-label-secondary,var(--bp-muted));min-width:0}
.bp-conversation-plan-identity code{font-family:var(--ds-font-family-code,ui-monospace,monospace);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.bp-conversation-plan-actions{display:flex;gap:6px;flex:0 0 auto;align-items:center}
.bp-conversation-plan-actions button{min-height:32px;padding:5px 12px;border-radius:var(--dsw-radius-sm,8px);border:1px solid var(--dsw-alias-border-l3,#80808040);background:var(--dsw-alias-bg-layer-1,var(--bp-raised));color:var(--dsw-alias-label-primary,var(--bp-text));font-size:12px;line-height:1.2;cursor:pointer;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bp-conversation-plan-actions button[data-bp-plan-run]{background:var(--dsw-alias-button-primary-bg,var(--bp-accent));border-color:transparent;color:var(--dsw-alias-button-primary-label,var(--bp-bg));font-weight:600}
.bp-conversation-plan-actions button:disabled{opacity:.55;cursor:default}
.bp-conversation-plan-actions button:focus-visible{outline:2px solid var(--bp-accent);outline-offset:2px}
.bp-conversation-plan-error{margin:0;font-size:11px;color:var(--dsw-alias-state-error-primary,#c4473a);overflow-wrap:anywhere}
@container bp-workspace (max-width:480px){.bp-conversation-plan{flex-direction:column;gap:8px}.bp-conversation-plan-actions{align-self:stretch}.bp-conversation-plan-actions button{flex:1 1 auto;max-width:none}}
.bp-conversation :is(button,select):focus-visible{outline:2px solid var(--bp-accent);outline-offset:2px}
@container bp-workspace (max-width:540px){.bp-conversation-body{flex-direction:column}.bp-conversation-attempts{width:auto;height:auto;max-height:30%;flex:0 1 30%}.bp-conversation .bp-toolbar-actions{margin-left:0}.bp-conversation-canvas{flex:1;min-height:0;height:auto;width:100%}}
@media(prefers-reduced-motion:reduce){.bp-conversation .bp-node-emphasis{animation:none;opacity:0}}
`
