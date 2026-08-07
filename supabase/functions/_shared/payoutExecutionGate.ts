/**
 * Admin payout execution safety gate.
 * Revolut / manual bank Monday batches are the only payout paths and do not require
 * an execution env flag — live unlock is owned by LIVE_PAYOUT_EXECUTION_ENABLED
 * (see shared/revolutBusinessOAuthSSOT.ts).
 * Verification runs must pass dry_run or verification_mode and exit before any DB writes.
 */

/** Read-only simulation — no batches, items, ledger debits, or provider mutations. */
export function isPayoutVerificationMode(body: Record<string, unknown>): boolean {
  return body.dry_run === true || body.verification_mode === true;
}

export const PAYOUT_EXECUTION_DISABLED_CODE = "ADMIN_PAYOUT_EXECUTION_DISABLED";
export const PAYOUT_EXECUTION_DISABLED_MESSAGE =
  "Automated payout execution disabled. Revolut/manual bank settlement does not require an execution flag; set LIVE_PAYOUT_EXECUTION_ENABLED=true only for owner-approved automated transfers.";

export const PAYOUT_VERIFICATION_MODE_MESSAGE =
  "Verification mode — no batches, payout items, ledger debits, or provider calls were made.";
