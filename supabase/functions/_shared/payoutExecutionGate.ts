/**
 * Phase 3D.1 — Admin payout execution safety gate.
 * Live Stripe transfers / payout batches require ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED=true.
 * Verification runs must pass dry_run or verification_mode and exit before any DB writes.
 */

export function isAdminStripePayoutExecutionEnabled(): boolean {
  return Deno.env.get("ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED") === "true";
}

/** Read-only simulation — no batches, items, ledger debits, or Stripe mutations. */
export function isPayoutVerificationMode(body: Record<string, unknown>): boolean {
  return body.dry_run === true || body.verification_mode === true;
}

export const PAYOUT_EXECUTION_DISABLED_CODE = "ADMIN_PAYOUT_EXECUTION_DISABLED";
export const PAYOUT_EXECUTION_DISABLED_MESSAGE =
  "Stripe payout execution disabled. Set ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED=true after Ahmed approval.";

export const PAYOUT_VERIFICATION_MODE_MESSAGE =
  "Verification mode — no batches, payout items, ledger debits, or Stripe calls were made.";
