/** Styles for the AWS page; colors come from the DSH design tokens. */
export const STYLES = `
.dsh-aws { display: flex; flex-direction: column; gap: 16px; width: 100%; }
.dsh-aws-intro { margin: 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
.dsh-aws-search { max-width: 320px; }
.dsh-aws-card { display: flex; flex-direction: column; gap: 12px; padding: 16px; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md); }
.dsh-aws-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.dsh-aws-title { margin: 0; font-size: 14px; line-height: 20px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dsh-aws-sub { margin: 2px 0 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.dsh-aws-meta { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.dsh-aws-hint { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); margin: 0; }
.dsh-aws-note { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); font-style: italic; }
.dsh-aws-group-switch { flex: none; display: inline-flex; align-items: center; gap: 10px; }
.dsh-aws-servers { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.dsh-aws-server { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 12px 0; border-top: 1px solid var(--dsw-alias-border-l2); }
.dsh-aws-server-main { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dsh-aws-server-name { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 13px; line-height: 20px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.dsh-aws-server-actions { flex: none; display: inline-flex; align-items: center; gap: 8px; }
.dsh-aws-status { display: inline-flex; align-items: flex-start; gap: 8px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.dsh-aws-status > :first-child { margin-top: 5px; }
.dsh-aws-status-text { display: flex; flex-direction: column; min-width: 0; }
.dsh-aws-status-error {
  color: var(--dsw-alias-state-error-primary); overflow-wrap: anywhere;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
}
.dsh-aws-link { font-size: 12px; color: var(--dsw-alias-label-secondary); text-decoration: underline; }
.dsh-aws-link-button { align-self: flex-start; padding: 0; border: none; background: none; cursor: pointer; font: inherit; font-size: 12px; }
.dsh-aws-account { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 12px; }
.dsh-aws-account .dsh-aws-field { flex: 1; min-width: 160px; }
.dsh-aws-field { display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dsh-aws-form { display: flex; flex-direction: column; gap: 12px; }
.dsh-aws-fieldset { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm); }
.dsh-aws-fieldset legend { padding: 0 4px; font-size: 12px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.dsh-aws-select, .dsh-aws-textarea {
  font: inherit; font-size: 13px; padding: 6px 8px; border-radius: var(--dsw-radius-sm);
  border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1, transparent); color: var(--dsw-alias-label-primary);
}
.dsh-aws-textarea { font-family: var(--dsw-font-mono, ui-monospace, monospace); resize: vertical; }
.dsh-aws-banner { display: flex; flex-direction: column; gap: 8px; padding: 12px 16px; border-radius: var(--dsw-radius-md); border: 1px solid var(--dsw-alias-border-l2); font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
.dsh-aws-banner p { margin: 0; }
.dsh-aws-banner code { font-family: var(--dsw-font-mono, ui-monospace, monospace); font-size: 12px; user-select: all; overflow-wrap: anywhere; }
.dsh-aws-banner-warning { border-color: var(--dsw-alias-state-error-primary); }
.dsh-aws-empty { margin: 0; padding: 24px 12px; text-align: center; color: var(--dsw-alias-label-tertiary); }
.dsh-aws-error { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); }
@media (max-width: 640px) {
  .dsh-aws-server { flex-direction: column; }
  .dsh-aws-server-actions { align-self: flex-end; }
}
`
