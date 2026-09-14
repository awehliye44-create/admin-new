/**
 * A8B28F Stage C companion DRAFT — surgical changes for driverPayoutEligibilitySSOT.ts
 *
 * DO NOT replace the whole file — merge these semantics into aggregateDriverPayoutEligibility.
 *
 * 1) Input: add payout_operational_paused?; keep payouts_enabled deprecated/ignored for gates.
 * 2) Replace LEG short-circuit with OP short-circuit (same avail=0 / pending=live presentation).
 * 3) account_verified === false: DO NOT zero Available.
 *    Continue clearing math; mark withdraw blocked via primary_hold_reason ACCOUNT_UNVERIFIED
 *    only when available would otherwise be withdrawable (or always set hold reason if unverified
 *    after computing balances — preferred: compute balances first, then overlay withdraw block).
 *
 * Preferred Stage C algorithm:
 *   - If OP paused → return avail=0, pending=live, primary=ADMIN_HOLD (unchanged math path short-circuit)
 *   - Else run clearing loop as today (incl. DRIVER_COLLECTED exclusion unchanged)
 *   - If account_verified === false → keep computed available/pending; set
 *       primary_hold_reason = ACCOUNT_UNVERIFIED (withdraw gate for Admin/Edge)
 *     Do NOT move available into pending.
 *   - Ignore input.payouts_enabled for short-circuit / account_verified inference.
 */

export const STAGE_C_COMPANION_ELIGIBILITY_SSOT_PATCH = {
  replaceShortCircuitFrom: 'if (input.payouts_enabled === false)',
  replaceShortCircuitTo: 'if (input.payout_operational_paused === true)',
  accountUnverifiedMustNotZeroAvailable: true,
  ignoreLegacyPayoutsEnabled: true,
  clearingMathUnchanged: true,
  driverCollectedExclusionUnchanged: true,
} as const;

/** Minimal type delta for callers. */
export type AggregateDriverPayoutEligibilityInputStageC = {
  live_balance_pence: number;
  outstanding_debt_pence?: number;
  in_flight_cashout_pence?: number;
  reserved_payout_pence?: number;
  /** @deprecated ignored for gates after companion deploy */
  payouts_enabled?: boolean | null;
  payout_operational_paused?: boolean | null;
  payout_provider_available?: boolean | null;
  account_verified?: boolean | null;
};
