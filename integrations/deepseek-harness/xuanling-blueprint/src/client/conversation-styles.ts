/** Conversation-only geometry; existing global workspace controls and canvas budgets stay intact. */
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
.bp-conversation :is(button,select):focus-visible{outline:2px solid var(--bp-accent);outline-offset:2px}
@container bp-workspace (max-width:540px){.bp-conversation-body{flex-direction:column}.bp-conversation-attempts{width:auto;height:auto;max-height:30%;flex:0 1 30%}.bp-conversation .bp-toolbar-actions{margin-left:0}.bp-conversation-canvas{flex:1;min-height:0;height:auto;width:100%}}
@media(prefers-reduced-motion:reduce){.bp-conversation .bp-node-emphasis{animation:none;opacity:0}}
`

export function installConversationStyles(): void {
  if (typeof document === 'undefined' || document.getElementById('xuanling-blueprint-conversation-css')) return
  const style = document.createElement('style')
  style.id = 'xuanling-blueprint-conversation-css'
  style.textContent = conversationCss
  document.head.appendChild(style)
}
