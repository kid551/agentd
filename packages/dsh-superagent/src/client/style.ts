// Plain CSS on dsh theme tokens (`--dsw-alias-*`), so the board follows the
// light and dark themes. dsh asks plugin UI for CSS Modules + tokens, not
// Tailwind; class names carry an `sa-` prefix instead of module hashing.

export const CSS = `
.sa-page { padding: 24px 32px; overflow: auto; height: 100%; box-sizing: border-box; color: var(--dsw-alias-label-primary); }
.sa-toolbar { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
.sa-heading { font-size: 18px; font-weight: 600; margin: 0 auto 0 0; }
.sa-group { margin-top: 20px; }
.sa-group-title { font-size: 13px; font-weight: 500; color: var(--dsw-alias-label-tertiary); margin: 0 0 8px; }
.sa-card { --sa-tone: var(--dsw-alias-state-idle-primary); border: 1px solid var(--dsw-alias-border-l1); border-left: 3px solid var(--sa-tone); border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; background: var(--dsw-alias-bg-layer-1); }
.sa-card.sa-ended { opacity: .6; }
.sa-card-head { display: flex; align-items: baseline; gap: 8px; font-size: 13px; }
.sa-id { font-variant-numeric: tabular-nums; font-weight: 600; }
.sa-project { color: var(--dsw-alias-label-secondary); border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; padding: 0 6px; font-size: 12px; }
.sa-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sa-state { color: var(--sa-tone); font-size: 12px; }
.sa-tag { opacity: .7; font-size: 12px; }
.sa-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--sa-tone); flex: none; align-self: center; }
.sa-body { margin: 6px 0 0; font-size: 13px; line-height: 1.5; white-space: pre-wrap; color: var(--dsw-alias-label-secondary); max-height: 9em; overflow: hidden; }
.sa-meta { margin: 4px 0 0; font-size: 12px; color: var(--dsw-alias-label-caption); }
.sa-meta.sa-stale { color: var(--dsw-alias-state-warn-label); }
.sa-actions { display: flex; gap: 6px; margin-top: 8px; }
.sa-button { font: inherit; font-size: 12px; padding: 2px 10px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-primary); cursor: pointer; }
.sa-button:hover { background: var(--dsw-alias-bg-layer-2); }
.sa-button:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
.sa-alert, .sa-toast, .sa-empty { font-size: 13px; color: var(--dsw-alias-label-secondary); }
.sa-alert { color: var(--dsw-alias-state-error-primary); }
.sa-badge { --sa-tone: var(--dsw-alias-state-idle-primary); font-size: 11px; font-variant-numeric: tabular-nums; color: var(--sa-tone); }
.sa-hover { font-size: 12px; line-height: 1.5; }
.sa-hover-line { color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 320px; }
.sa-band { --sa-tone: var(--dsw-alias-state-idle-primary); display: flex; align-items: center; gap: 8px; font-size: 12px; padding: 4px 10px; margin: 0 0 6px; border-radius: 6px; border: 1px solid var(--sa-tone); color: var(--dsw-alias-label-primary); }
.sa-band-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.sa-warn { --sa-tone: var(--dsw-alias-state-warn-primary); }
.sa-success { --sa-tone: var(--dsw-alias-state-success-primary); }
.sa-error { --sa-tone: var(--dsw-alias-state-error-primary); }
.sa-business { --sa-tone: var(--dsw-alias-state-business-primary); }
.sa-idle { --sa-tone: var(--dsw-alias-state-idle-primary); }
@media (prefers-reduced-motion: reduce) { .sa-button { transition: none; } }
`
