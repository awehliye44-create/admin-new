/** Offline test/audit-only helpers; not part of Edge uploads. */
/**
 * #111B — Terminal-fee financial policy SSOT (allocation + Wallet category).
 *
 * Canonical driver net for chargeable terminal fees:
 *   provider-confirmed capture − ACTUAL provider processing fee
 *   ONECAB commission = 0
 *
 * CANCELLED_WITH_FEE / OTHER_CANCELLATION_FEE historically used
 * capture − commission (provider fee platform-owned). #111C: owner-approved
 * PROSPECTIVE unification onto capture − ACTUAL provider fee / commission 0,
 * effective TERMINAL_FEE_UNIFIED_POLICY_CUTOVER_ISO. Pre-cutover rows keep the
 * historical formula and are never reinterpreted or retro-credited.
 *
 * Lock: terminalFeePolicySSOT.lock.test.ts
 */

import type { TerminalOutcomeKind } from "../../../functions/_shared/terminalOutcomeKindSSOT.ts";
import { TerminalEarningCategory, TERMINAL_EARNING_CATEGORY } from "../../../functions/_shared/terminalFeePolicySSOT.ts";


/**
 * Backward-compatible category resolution for historical TEN rows that lack
 * metadata.earning_category. Prefer metadata; then outcome; then description.
 */
export function resolveTerminalEarningCategoryFromEvidence(args: {
  metadata?: Record<string, unknown> | null;
  description?: string | null;
  financialOutcome?: string | null;
  tripStatus?: string | null;
}): TerminalEarningCategory {
  const raw = args.metadata?.earning_category;
  if (typeof raw === "string") {
    const key = raw.trim().toLowerCase();
    if (
      key === TERMINAL_EARNING_CATEGORY.NO_SHOW ||
      key === TERMINAL_EARNING_CATEGORY.ARRIVAL_CANCELLATION ||
      key === TERMINAL_EARNING_CATEGORY.LATE_CANCELLATION ||
      key === TERMINAL_EARNING_CATEGORY.OTHER_CANCELLATION ||
      key === TERMINAL_EARNING_CATEGORY.NORMAL_TRIP
    ) {
      return key as TerminalEarningCategory;
    }
  }

  const outcome = String(args.financialOutcome ?? "").toUpperCase();
  const status = String(args.tripStatus ?? "").toLowerCase();
  if (outcome === "NO_SHOW" || status === "no_show") {
    return TERMINAL_EARNING_CATEGORY.NO_SHOW;
  }
  if (outcome === "ARRIVAL_CANCELLATION") {
    return TERMINAL_EARNING_CATEGORY.ARRIVAL_CANCELLATION;
  }
  if (outcome === "LATE_PASSENGER_CANCELLATION") {
    return TERMINAL_EARNING_CATEGORY.LATE_CANCELLATION;
  }
  if (outcome === "CANCELLED_WITH_FEE") {
    return TERMINAL_EARNING_CATEGORY.OTHER_CANCELLATION;
  }

  const note = String(args.description ?? "");
  if (/no[\s-]?show/i.test(note)) return TERMINAL_EARNING_CATEGORY.NO_SHOW;
  if (/arrival\s+cancellation/i.test(note)) {
    return TERMINAL_EARNING_CATEGORY.ARRIVAL_CANCELLATION;
  }
  if (/late\s+passenger\s+cancellation/i.test(note)) {
    return TERMINAL_EARNING_CATEGORY.LATE_CANCELLATION;
  }
  if (/cancellation\s+compensation/i.test(note)) {
    return TERMINAL_EARNING_CATEGORY.OTHER_CANCELLATION;
  }

  return TERMINAL_EARNING_CATEGORY.NORMAL_TRIP;
}

export * from "../../../functions/_shared/terminalFeePolicySSOT.ts";
