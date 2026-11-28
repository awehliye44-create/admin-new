/**
 * #92L / #97 — Admin tips_enabled toggle vs tip-window lifecycle SSOT.
 *
 * Admin retains full control to enable/disable tipping for a service area.
 * Completion stamps the tip window from tips_enabled AT COMPLETE TIME only.
 * An already-open window is never invalidated by a later Admin toggle.
 */

export const TIP_WINDOW_ADMIN_TOGGLE_POLICY = {
  /** Completion reads tips_enabled once and stamps the window when eligible. */
  stampAtCompleteFromTipsEnabled: true,
  /** An open stamped window survives Admin toggling tips OFF. */
  openWindowSurvivesTipsDisabled: true,
  /** Do not invent a tip window for past completed trips when tips turn ON. */
  noRetroactiveWindowAfterComplete: true,
  /** Do not reopen a captured order for tipping. */
  neverReopenCapturedOrderForTip: true,
} as const;

/**
 * Whether a newly completed trip may open a tip window given Admin tip setting.
 * Mid-trip toggle ON applies to this completion; toggle OFF after stamp is ignored.
 */
export function mayOpenTipWindowForCompletion(args: {
  tipsEnabledAtComplete: boolean;
}): boolean {
  return args.tipsEnabledAtComplete === true;
}

/**
 * Whether an already-open tip window remains active after Admin tip toggle.
 * Toggle OFF must not close or invalidate the window.
 */
export function openTipWindowRemainsActiveAfterAdminToggle(args: {
  tipWindowOpenedAt: string | null | undefined;
  tipWindowClosedAt: string | null | undefined;
  tipWindowExpiresAt: string | null | undefined;
  tipsEnabledNow: boolean;
  nowMs?: number;
}): boolean {
  void args.tipsEnabledNow; // intentionally unused — open window is authoritative
  if (!args.tipWindowOpenedAt || args.tipWindowClosedAt) return false;
  const expires = args.tipWindowExpiresAt
    ? new Date(args.tipWindowExpiresAt).getTime()
    : NaN;
  if (!Number.isFinite(expires)) return false;
  return expires > (args.nowMs ?? Date.now());
}
