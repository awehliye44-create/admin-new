/**
 * Admin payout execution safety gate.
 * Live automated provider transfers require ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED=true
 * (legacy env name — covers any automated Connect-style transfer).
 * Revolut / manual bank Monday batches do not require this flag.
 * Verification runs must pass dry_run or verification_mode and exit before any DB writes.
 */

export function isAdminStripePayoutExecutionEnabled(): boolean {
  return Deno.env.get("ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED") === "true";
}

/** Alias used by payoutRetryGuard. */
export function stripeExecutionEnabled(): boolean {
  return isAdminStripePayoutExecutionEnabled();
}

/** Read-only simulation — no batches, items, ledger debits, or provider mutations. */
export function isPayoutVerificationMode(body: Record<string, unknown>): boolean {
  return body.dry_run === true || body.verification_mode === true;
}

export const PAYOUT_EXECUTION_DISABLED_CODE = "ADMIN_PAYOUT_EXECUTION_DISABLED";
export const PAYOUT_EXECUTION_DISABLED_MESSAGE =
  "Automated payout execution disabled. Revolut/manual bank settlement does not require this flag; set ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED=true only for owner-approved legacy Connect transfers.";

export const PAYOUT_VERIFICATION_MODE_MESSAGE =
  "Verification mode — no batches, payout items, ledger debits, or provider calls were made.";
