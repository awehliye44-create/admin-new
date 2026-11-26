/**
 * P6 M3 — which SUBMITTED payout batch kinds the provider-status reconcile may touch.
 *
 * Reconcile is GET-only (Revolut transaction status) → idempotent
 * finalize_driver_payout_completion. It NEVER calls /pay and never resends an
 * ambiguous payout.
 *
 * Provider TERMINAL FAILURE is only auto-applied for EARLY_CASHOUT:
 * fail_submitted_early_cashout releases the gross reservation, FAILS the item and
 * FAILS THE WHOLE BATCH (one item per early cash-out batch). A weekly batch carries
 * many drivers' items, so that RPC is unsafe and rejects non-EARLY_CASHOUT
 * (NOT_EARLY_CASHOUT). Weekly terminal failures are REPORT-AND-LEAVE: the item
 * stays SUBMITTED, the reservation stays ACTIVE, ops resolve via the weekly
 * occurrence orchestrator / admin payout repair.
 *
 * SQL mirror: public.claim_reconcile_payout_items (migration
 * 20270302092000_p6_m3_weekly_payout_reconcile_claim.sql).
 */

export const EARLY_CASHOUT_BATCH_KIND = "EARLY_CASHOUT";

export const WEEKLY_PAYOUT_BATCH_KINDS = ["WEEKLY_SCHEDULED", "WEEKLY_MONDAY"] as const;

/** Kinds the scheduled poller claims and reconciles (GET-only). */
export const POLLER_RECONCILE_BATCH_KINDS: readonly string[] = [
  EARLY_CASHOUT_BATCH_KIND,
  ...WEEKLY_PAYOUT_BATCH_KINDS,
];

/** Default for every other caller (driver-withdraw edge): Driver Withdraw only. */
export const DEFAULT_RECONCILE_BATCH_KINDS: readonly string[] = [EARLY_CASHOUT_BATCH_KIND];

export function isWeeklyPayoutBatchKind(kind: string | null | undefined): boolean {
  return (WEEKLY_PAYOUT_BATCH_KINDS as readonly string[]).includes(String(kind ?? ""));
}

/** Only EARLY_CASHOUT may auto-fail + release on a provider terminal failure. */
export function payoutKindAllowsAutoFailRelease(kind: string | null | undefined): boolean {
  return String(kind ?? "") === EARLY_CASHOUT_BATCH_KIND;
}

export const WEEKLY_TERMINAL_FAILURE_REPORT_ONLY_ERROR =
  "WEEKLY_PROVIDER_TERMINAL_FAILURE_REPORT_ONLY";
