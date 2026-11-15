/** Styles for the row button and dialog body; colors come from the DSH design tokens. */
export const STYLES = `
.dsh-session-delete-row {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  margin: -4px;
  border: none;
  border-radius: var(--dsw-radius-xs);
  padding: 0;
  background: transparent;
  cursor: pointer;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-session-delete-row:focus-visible { outline-offset: -2px; }
@media (hover: hover) {
  .dsh-session-delete-row:hover { color: var(--dsw-alias-state-error-primary); }
}
.dsh-session-delete-danger:not(:disabled) { color: var(--dsw-alias-state-error-primary); }
.dsh-session-delete-note { margin: 0 0 8px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.dsh-session-delete-error { margin: 0 0 8px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); }
.dsh-session-delete-kept { margin: 0 0 8px; padding-left: 18px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.dsh-session-delete-kept code { font-size: 11px; }
`
