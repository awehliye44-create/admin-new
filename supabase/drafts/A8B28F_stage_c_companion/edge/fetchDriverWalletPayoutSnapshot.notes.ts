/**
 * A8B28F Stage C companion DRAFT — fetchDriverWalletPayoutSnapshot.ts notes
 *
 * Replace:
 *   payout_blocked: walletBalance < 0 || driver?.payouts_enabled === false
 * With:
 *   payout_blocked: walletBalance < 0 || driver?.payout_operational_paused === true
 *   (withdraw/provider blocks stay separate via accountVerified / eligibility)
 *
 * Replace verificationStatus restricted branch from payouts_enabled=false:
 *   if (OP) → "paused" / restricted-operational
 *   else if (!providerVerified) → pending/failed from destination statuses
 *   else → verified
 *
 * Replace Revolut accountVerified fallback:
 *   BEFORE: verificationStatus === "verified" || (revolut && payouts_enabled !== false)
 *   AFTER:  verificationStatus === "verified" || (revolut && providerDestinationVerified)
 *
 * Select drivers: add payout_operational_paused; payouts_enabled optional display-only.
 *
 * Do not change FR reconciliation math besides accountVerified boolean source.
 */

export const SNAPSHOT_PATCH = {
  driverSelectAdd: 'payout_operational_paused',
  payoutBlocked:
    'walletBalance < 0 || driver?.payout_operational_paused === true',
  accountVerified:
    'verificationStatus === "verified" || providerDestinationVerified === true',
} as const;
