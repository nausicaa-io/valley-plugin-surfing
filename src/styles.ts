const CSS = `
.web-page { display:flex; flex-direction:column; height:100%; background:var(--surface-color, var(--container-color)); }
.web-toolbar { display:flex; align-items:center; gap:8px; height:var(--app-bar-height); padding:0 calc(var(--plugin-actions-offset, 0px) + 10px) 0 calc(var(--plugin-navigation-offset, 0px) + 10px); background:var(--container-color-alt); border-bottom:1px solid var(--border-light); flex:0 0 auto; -webkit-app-region:no-drag; }
.web-nav-group { display:flex; align-items:center; gap:2px; flex:0 0 auto; }
.web-nav-btn { display:grid; place-items:center; width:28px; height:28px; padding:0; border:none; border-radius:6px; background:none; color:var(--text-secondary); cursor:pointer; }
.web-nav-btn:hover { background:var(--hover-bg); color:var(--text-color); }
.web-nav-btn svg { display:block; }
.web-address { flex:1; min-width:0; height:30px; padding:0 12px; border:1px solid var(--border-medium); border-radius:7px; background:var(--container-color-alt); color:var(--text-color); font-size:0.75rem; outline:none; }
.web-address:focus { border-color:var(--accent-color); }
.web-toolbar-profile { display:flex; align-items:center; gap:5px; flex:0 1 auto; max-width:150px; min-width:0; height:26px; padding:0 7px; border:1px solid var(--border-light); border-radius:999px; color:var(--text-secondary); font-size:0.6875rem; }
.web-toolbar-profile > span { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.web-toolbar-profile .web-profile-mark { width:16px; height:16px; font-size:11px; }
.web-toolbar-profile .web-profile-mark svg { width:14px; height:14px; }
.web-host { flex:1; min-height:0; position:relative; display:flex; }
.web-host webview, .web-host .web-guest { flex:1; width:100%; height:100%; border:0; }

/* Favorite star in the page toolbar (reuses .web-nav-btn sizing). */
.web-star.is-active { color:var(--accent-color); }
.web-star:disabled { opacity:.4; cursor:default; }
.web-star:disabled:hover { background:none; color:var(--text-secondary); }

.web-panel.panel-body { padding:0; display:flex; flex-direction:column; min-height:0; overflow-y:auto; }

/* ── Topbar: profile dropdown + open-a-site icon, one 37px row ──────────────── */
.web-topbar { display:flex; align-items:center; gap:var(--space-1); height:var(--app-bar-height); padding:0 5px; background:var(--container-color); border-bottom:1px solid var(--border-light); flex:0 0 auto; -webkit-app-region:no-drag; }
.web-profile-btn { display:flex; align-items:center; gap:var(--space-2); flex:1; min-width:0; height:26px; padding:0 6px; border:none; border-radius:var(--radius-sm); background:transparent; color:var(--text-color); font-size:0.75rem; cursor:pointer; -webkit-app-region:no-drag; }
.web-profile-btn:hover { background:var(--hover-bg); }
.web-profile-label { flex:1; min-width:0; text-align:left; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.web-profile-chevron { flex:0 0 auto; font-size:13px; color:var(--text-tertiary); }
.web-profile-mark { display:grid; place-items:center; flex:0 0 auto; width:20px; height:20px; color:var(--text-secondary); font-size:13px; font-weight:600; line-height:1; }
.web-profile-btn > .web-profile-mark svg { width:17px; height:17px; }
.web-profile-mark--plain { width:auto; height:auto; background:none; color:inherit; }
.web-icon-btn { display:flex; align-items:center; justify-content:center; flex:0 0 auto; width:26px; height:26px; padding:0; border:none; border-radius:var(--radius-sm); background:transparent; color:var(--text-tertiary); font-size:14px; cursor:pointer; -webkit-app-region:no-drag; }
.web-icon-btn:hover { background:var(--hover-bg); color:var(--title-color); }
.web-icon-btn.danger:hover { color:var(--negative-color); }

/* ── Favorites / Reading list / Timeline switcher (icon tabs) ───────────────── */
.web-list-tabs { display:flex; align-items:center; gap:var(--space-1); height:var(--app-bar-height); padding:0 5px; background:var(--container-color); border-bottom:1px solid var(--border-light); flex:0 0 auto; -webkit-app-region:no-drag; }
.web-list-tab { display:flex; align-items:center; justify-content:center; flex:0 0 auto; width:26px; height:26px; padding:0; border:none; border-radius:var(--radius-sm); background:transparent; color:var(--text-tertiary); cursor:pointer; }
.web-list-tab:hover { background:var(--hover-bg); color:var(--title-color); }
.web-list-tab.active { background:var(--hover-bg); color:var(--accent-color); }

.web-sec { display:flex; flex-direction:column; }
.web-sec-head { display:flex; align-items:center; justify-content:flex-end; gap:4px; padding:6px 6px 0; }
.web-link-btn:disabled { opacity:.4; cursor:default; }
.web-link-btn:disabled:hover { background:none; }

.web-group { display:flex; flex-direction:column; }
.web-group-label { display:flex; align-items:center; gap:8px; padding:11px 10px 5px; font-size:0.6875rem; font-weight:700; text-transform:uppercase; letter-spacing:.04em; color:var(--text-tertiary); }
.web-group-label::after { content:""; flex:1; height:1px; background:var(--border-light); }

.web-list { display:flex; flex-direction:column; padding:0 0 6px; }
.web-list-row { display:flex; align-items:center; gap:2px; border-bottom:1px solid var(--border-light); }
.web-list-row:hover { background:var(--hover-bg); }
.web-list-row:focus-within { background:var(--hover-bg); }
.web-list-open { display:flex; flex-direction:column; gap:2px; flex:1; min-width:0; padding:7px 10px; border:none; background:none; text-align:left; cursor:pointer; -webkit-app-region:no-drag; }
.web-list-title { font-size:0.75rem; color:var(--text-color); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.web-list-url { font-size:0.6875rem; color:var(--text-tertiary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.web-list-ts { color:var(--text-tertiary); }
.web-list-remove { flex:0 0 auto; width:22px; height:22px; margin-right:2px; padding:0; border:none; border-radius:5px; background:none; color:var(--text-tertiary); font-size:16px; line-height:1; cursor:pointer; opacity:0; -webkit-app-region:no-drag; }
.web-list-row:hover .web-list-remove, .web-list-row:focus-within .web-list-remove { opacity:1; }
.web-list-remove:hover { background:var(--container-color); color:var(--text-color); }

/* ── Settings (surfing.settings — General / Privacy & Ad-block / Profiles) ──────
   Layout only. Every control here is the settings kit's, on the shared
   shared control-token contract — a local frame would win the cascade (this sheet is
   injected after the bundle) and drift the page away from every other one. */
.web-settings { min-width:0; }
.web-embed-errors { margin:8px 0; padding:8px 10px; border:1px solid var(--negative-color); border-radius:7px; color:var(--negative-color); font-size:0.6875rem; overflow-wrap:anywhere; }
.web-adblock-rules { display:flex; flex-direction:column; align-items:stretch; gap:6px; width:min(520px, 65%); }
.web-adblock-rule { display:flex; align-items:center; gap:6px; }
.web-adblock-rule > :first-child { flex:1; min-width:0; }
.web-adblock-rules > button { align-self:flex-end; }
.web-profile-stats { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:6px; width:min(430px,65%); }
.web-profile-stats > span { display:flex; flex-direction:column; gap:2px; min-width:0; padding:7px 9px; border:1px solid var(--border-light); border-radius:7px; color:var(--text-secondary); font-size:0.6875rem; }
.web-profile-stats strong { color:var(--text-color); font-size:0.875rem; font-weight:600; }
.web-metadata-icon { display:flex; align-items:center; min-width:0; }
.web-metadata-icon img { width:24px; height:24px; flex:0 0 auto; border-radius:5px; object-fit:contain; }

@media (max-width:720px) {
  .web-toolbar-profile { max-width:96px; }
  .web-adblock-rules { width:100%; }
  .web-profile-stats { width:100%; }
}

/* Profiles is the shared settings list page (.settings-listpage-* / .settings-list-*
   in SettingsModal.css) — only the pieces that page has no class for live here. */
.web-profile-swatch { padding:0; border:none; cursor:pointer; -webkit-app-region:no-drag; }
.web-profile-swatch:hover { background:var(--border-light); color:var(--text-color); }
/* A profile's mark sizes to its well rather than to the 1em the sidebar gives it. */
.settings-list-glyph .web-profile-mark--plain { display:grid; place-items:center; font-size:inherit; }
.settings-list-glyph .web-profile-mark--plain svg { width:1.15em; height:1.15em; }
.web-profile-badge { flex:0 0 auto; padding:1px 7px; border:1px solid var(--border-light); border-radius:999px; color:var(--text-tertiary); font-size:0.6875rem; line-height:1.5; text-transform:lowercase; }
/* The detail page's identity header, matching Accounts'/Email's. */
.web-detail-identity { display:flex; align-items:center; gap:12px; padding:14px 0; }
.web-row-actions { display:flex; align-items:center; gap:var(--space-2); flex-shrink:0; }
.web-link-btn { padding:2px 6px; border:none; border-radius:5px; background:none; color:var(--accent-color); font-size:0.75rem; cursor:pointer; white-space:nowrap; -webkit-app-region:no-drag; }
.web-link-btn:hover { background:var(--hover-bg); }
.web-link-btn.danger { color:#e5484d; }

.web-empty { font-size:0.75rem; color:var(--text-secondary); padding:8px 6px; }
`

export function injectStyles(): () => void {
  const id = 'notes-web-styles'
  let el = document.getElementById(id) as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = id
    document.head.appendChild(el)
  }
  el.textContent = CSS
  return () => {
    if (document.getElementById(id) === el) el.remove()
  }
}
