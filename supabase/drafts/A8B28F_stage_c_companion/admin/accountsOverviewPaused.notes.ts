/**
 * A8B28F Stage C companion DRAFT — Admin accounts overview / filters notes.
 *
 * adminPayoutLedgerAccountsOverviewSSOT.ts:
 *   pausedAccount = d.payout_operational_paused === true
 *   unverifiedAccount = !providerVerifiedActive
 *   Counts: paused vs unverified separated (do not lump LEG false into paused)
 *   nextBatchDrivers: available > 0 && !paused && providerVerified
 *
 * adminPayoutLedgerOverviewSSOT.ts:
 *   paused = OP true (not LEG)
 *
 * useAdminDriverOptions:
 *   payoutsEnabledOnly filter → exclude OP=true (optional also require PD)
 *
 * admin-driver-wallet-detail / admin-driver-settlements:
 *   canPayout / canEarlyCashout:
 *     available > 0 && !OP && globalPayouts && providerVerified
 *   (prefer RPC driver_effective_payout_allowed when callable from Edge service role)
 *
 * Display: show both columns OP + legacy until Stage D; badge copy:
 *   OP → "Operationally paused"
 *   !PD → "Destination unverified"
 *   NEVER map legacy false alone to "Paused" after companion deploy
 */

export const ACCOUNTS_OVERVIEW_PATCH = {
  pausedAccount: 'd.payout_operational_paused === true',
  unverifiedAccount: 'providerVerified !== true',
  canIncludeInNextBatch:
    'available > 0 && !pausedAccount && providerVerified === true',
} as const;
