export const compositionCss = `
.bp-child-composition,.bp-child-preview { min-width:0; display:grid; gap:10px; }
.bp-child-composition h3,.bp-child-preview h3 { margin:0; text-wrap:balance; }
.bp-child-pin,.bp-child-preview code { overflow-wrap:anywhere; font-variant-numeric:tabular-nums; }
.bp-child-interface { border-collapse:collapse; width:100%; text-align:left; font-size:12px; }
.bp-child-interface caption { text-align:left; font-weight:600; padding:8px 0; }
.bp-child-interface th,.bp-child-interface td { padding:6px; overflow-wrap:anywhere; }
.bp-child-interface tbody tr { box-shadow:0 -1px 0 color-mix(in srgb,currentColor 12%,transparent); }
.bp-child-actions { display:flex; flex-wrap:wrap; gap:8px; }
.bp-child-actions button,.bp-child-preview>button,.bp-child-conflicts { min-height:40px; }
.bp-child-conflicts { display:flex; align-items:center; gap:8px; }
.bp-child-preview-graph { height:300px; min-width:0; border-radius:8px; overflow:hidden; }
.bp-child-preview .react-flow__node { color:inherit; background:var(--bp-raised); }
.bp-child-preview li small { display:block; overflow-wrap:anywhere; }
.bp-flow-breadcrumb { display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding:8px 12px; }
.bp-flow-breadcrumb button { min-height:40px; }
.bp-workspace.bp-runtime-preview { position:fixed; inset:0; margin:auto; display:block; width:min(1000px,calc(100vw - 40px)); max-height:calc(100vh - 40px); height:fit-content; overflow:auto; padding:20px; border:0; border-radius:16px; background:var(--bp-bg,#171a21); color:var(--bp-text,#eceef4); box-shadow:0 16px 64px #0006; }
.bp-runtime-preview::backdrop { background:#0006; }
.bp-runtime-preview button { min-height:40px; }
.bp-runtime-preview li { display:flex; align-items:center; flex-wrap:wrap; gap:8px; }
.bp-runtime-preview .react-flow__node { color:inherit; background:var(--bp-raised); }
.bp-workspace.bp-managed-composer { height:auto; box-sizing:border-box; padding:14px; display:grid; gap:10px; width:100%; border-radius:12px; background:var(--bp-raised); box-shadow:0 2px 12px #0002; }
.bp-managed-composer p { margin:0; text-wrap:pretty; }
.bp-managed-composer textarea { width:100%; box-sizing:border-box; min-height:88px; resize:vertical; padding:10px; border-radius:8px; color:inherit; background:transparent; font:inherit; }
.bp-managed-actions { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.bp-managed-actions button { min-height:40px; }
.bp-managed-actions label { display:inline-flex; align-items:center; gap:6px; min-height:40px; }
.bp-managed-actions input[type=radio] { width:auto; min-height:0; margin:0; }
`
