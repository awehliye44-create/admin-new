/**
 * #111B — Terminal-fee financial policy SSOT (allocation + Wallet category).
 *
 * Canonical driver net for chargeable terminal fees:
 *   provider-confirmed capture − ACTUAL provider processing fee
 *   ONECAB commission = 0
 *
 * CANCELLED_WITH_FEE / OTHER_CANCELLATION_FEE historically used
 * capture − commission (provider fee platform-owned). Unifying that category
 * onto capture − provider fee / commission 0 is a prospective owner-approved
 * policy change — see TERMINAL_FEE_SETTLE_CANCELLED_WITH_FEE.
 *
 * Lock: terminalFeePolicySSOT.lock.test.ts
 */

import type { TerminalOutcomeKind } from "./terminalOutcomeKindSSOT.ts";

/**
 * Owner gate. Must stay false until the CANCELLED_WITH_FEE allocation change
 * is explicitly approved. When false, OTHER_CANCELLATION_FEE captures may
 * still run via dispose, but wallet resume / TEN posting for that outcome
 * remains off (historical behaviour).
 */
export const TERMINAL_FEE_SETTLE_CANCELLED_WITH_FEE = false as const;

/** Durable Wallet / Earnings classification for TRIP_EARNING_NET rows. */
export type TerminalEarningCategory =
  | "normal_trip_earning"
  | "no_show_earning"
  | "arrival_cancellation_earning"
  | "late_cancellation_earning"
  | "other_cancellation_earning";

export const TERMINAL_EARNING_CATEGORY = {
  NORMAL_TRIP: "normal_trip_earning",
  NO_SHOW: "no_show_earning",
  ARRIVAL_CANCELLATION: "arrival_cancellation_earning",
  LATE_CANCELLATION: "late_cancellation_earning",
  OTHER_CANCELLATION: "other_cancellation_earning",
} as const satisfies Record<string, TerminalEarningCategory>;

export function earningCategoryForTerminalOutcome(
  outcome: TerminalOutcomeKind | "OTHER_CANCELLATION",
): TerminalEarningCategory {
  switch (outcome) {
    case "NO_SHOW":
      return TERMINAL_EARNING_CATEGORY.NO_SHOW;
    case "ARRIVAL_CANCELLATION":
      return TERMINAL_EARNING_CATEGORY.ARRIVAL_CANCELLATION;
    case "LATE_PASSENGER_CANCELLATION":
      return TERMINAL_EARNING_CATEGORY.LATE_CANCELLATION;
    case "OTHER_CANCELLATION":
      return TERMINAL_EARNING_CATEGORY.OTHER_CANCELLATION;
    default:
      return TERMINAL_EARNING_CATEGORY.NORMAL_TRIP;
  }
}

export function terminalFeeLedgerDescription(args: {
  outcome: TerminalOutcomeKind | "OTHER_CANCELLATION";
  currency: string;
  amountPence: number;
}): string {
  const cs = args.currency.toUpperCase();
  const major = (Math.max(0, Math.round(args.amountPence)) / 100).toFixed(2);
  switch (args.outcome) {
    case "NO_SHOW":
      return `No-show compensation (ONECAB) — ${cs} ${major}`;
    case "ARRIVAL_CANCELLATION":
      return `Arrival cancellation compensation — ${cs} ${major}`;
    case "LATE_PASSENGER_CANCELLATION":
      return `Late passenger cancellation compensation — ${cs} ${major}`;
    case "OTHER_CANCELLATION":
      return `Cancellation compensation (ONECAB) — ${cs} ${major}`;
    default:
      return `Terminal fee compensation (ONECAB) — ${cs} ${major}`;
  }
}

/**
 * Whether cancel-trip feeType "cancellation" (OTHER_CANCELLATION_FEE /
 * CANCELLED_WITH_FEE) should enter the terminal-fee resume / TEN path.
 * Gated — do not flip without owner approval of the allocation change.
 */
export function shouldSettleCancelledWithFeeAsTerminalTen(): boolean {
  // Gate is `as const` false until owner approval; keep a boolean return for callers.
  return Boolean(TERMINAL_FEE_SETTLE_CANCELLED_WITH_FEE);
}

/** Build ledger metadata for new terminal-fee TEN rows (primary classifier). */
export function buildTerminalFeeLedgerMetadata(args: {
  outcome: TerminalOutcomeKind | "OTHER_CANCELLATION";
  capturedPence: number;
  providerFeePence: number;
  entitlementPence: number;
  formulaVersion: string;
}): Record<string, unknown> {
  return {
    earning_category: earningCategoryForTerminalOutcome(args.outcome),
    terminal_outcome: args.outcome,
    captured_pence: Math.max(0, Math.round(args.capturedPence)),
    provider_fee_pence: Math.max(0, Math.round(args.providerFeePence)),
    commission_pence: 0,
    entitlement_pence: Math.max(0, Math.round(args.entitlementPence)),
    formula_version: args.formulaVersion,
    policy: "terminal_fee_capture_minus_actual_provider_fee_v1",
  };
}

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
