/** Styles for the Connectors page; colors come from the DSH design tokens. */
export const STYLES = `
.dsh-connectors { display: flex; flex-direction: column; gap: 16px; width: 100%; }
.dsh-connectors-intro { margin: 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
.dsh-connectors-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.dsh-connectors-search { flex: 1; max-width: 320px; }
.dsh-connectors-add { position: relative; flex: none; }
.dsh-connectors-menu {
  position: absolute; right: 0; top: calc(100% + 4px); z-index: 10; min-width: 240px; padding: 4px;
  display: flex; flex-direction: column; border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l2); box-shadow: var(--dsw-elevation-prominent);
}
.dsh-connectors-menu button {
  display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 8px 10px; border: none;
  border-radius: var(--dsw-radius-sm); background: transparent; color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 13px; text-align: left; cursor: pointer;
}
.dsh-connectors-menu button:hover, .dsh-connectors-menu button:focus-visible { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-connectors-mask { display: block; width: 16px; height: 16px; background: currentColor; mask-size: contain; mask-repeat: no-repeat; mask-position: center; -webkit-mask-size: contain; -webkit-mask-repeat: no-repeat; -webkit-mask-position: center; }
.dsh-connectors-tags { display: inline-flex; flex-wrap: wrap; gap: 4px; }
.dsh-connectors-link { font-size: 12px; color: var(--dsw-alias-label-secondary); text-decoration: underline; padding: 2px 0; }
.dsh-connectors-form { display: flex; flex-direction: column; gap: 12px; }
.dsh-connectors-package { margin-top: 12px; }
.dsh-connectors-warning { margin: 8px 0 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.dsh-connectors-gate { margin-top: 12px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); }
.dsh-connectors-gate p { margin: 0 0 4px; }
.dsh-connectors-gate ul { margin: 0; padding-left: 18px; max-height: 160px; overflow: auto; }
.dsh-connectors-table { width: 100%; table-layout: fixed; border-collapse: collapse; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary); }
.dsh-connectors-table th {
  padding: 8px; text-align: left; font-weight: 500; font-size: 12px;
  color: var(--dsw-alias-label-tertiary); border-bottom: 1px solid var(--dsw-alias-border-l2);
}
.dsh-connectors-table td { padding: 12px 8px; overflow: hidden; vertical-align: middle; border-bottom: 1px solid var(--dsw-alias-border-l2); }
.dsh-connectors-table tr:last-child td { border-bottom: none; }
.dsh-connectors-table col.dsh-connectors-col-type { width: 60px; }
.dsh-connectors-table col.dsh-connectors-col-status { width: 150px; }
.dsh-connectors-table col.dsh-connectors-col-auth { width: 108px; }
.dsh-connectors-table col.dsh-connectors-col-actions { width: 104px; }
.dsh-connectors-table th:last-child, .dsh-connectors-table td:last-child { text-align: right; }
.dsh-connectors-name { display: flex; align-items: center; gap: 10px; min-width: 0; }
.dsh-connectors-logo {
  flex: none; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px;
  border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
}
.dsh-connectors-title { font-weight: 500; overflow-wrap: anywhere; }
.dsh-connectors-name > span:last-child { min-width: 0; }
.dsh-connectors-name .dsh-connectors-sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-connectors-sub { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.dsh-connectors-status { display: flex; align-items: flex-start; gap: 8px; }
.dsh-connectors-status > :first-child { margin-top: 5px; }
.dsh-connectors-status-text { display: flex; flex-direction: column; min-width: 0; }
.dsh-connectors-status-detail { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
.dsh-connectors-status-error {
  font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); overflow-wrap: break-word;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.dsh-connectors-actions { display: inline-flex; flex-direction: column; align-items: flex-end; gap: 4px; }
.dsh-connectors-empty { padding: 24px 12px; text-align: center; color: var(--dsw-alias-label-tertiary); }
.dsh-connectors-note { margin: 0 0 12px; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
.dsh-connectors-note a { color: inherit; text-decoration: underline; }
.dsh-connectors-field { display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dsh-connectors-error { margin: 8px 0 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); }
.dsh-connectors-danger:not(:disabled) { color: var(--dsw-alias-state-error-primary); }
@media (max-width: 640px) {
  .dsh-connectors-table th:nth-child(2), .dsh-connectors-table td:nth-child(2),
  .dsh-connectors-table th:nth-child(3), .dsh-connectors-table td:nth-child(3),
  .dsh-connectors-table col.dsh-connectors-col-type, .dsh-connectors-table col.dsh-connectors-col-auth { display: none; }
}
`
