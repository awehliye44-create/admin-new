/**
 * A8B28F Stage C companion DRAFT — fetchDriverPayoutEligibility.ts patches.
 *
 * Replace drivers select + aggregate args:
 */

export const FETCH_DRIVER_PAYOUT_ELIGIBILITY_PATCH = {
  driverSelect:
    'id, payout_operational_paused, approval_status, driver_status',
  // REMOVE reliance on payouts_enabled

  asyncSteps: [
    'Load active destination; account_verified = provider_link_status PROVIDER_VERIFIED + counterparty + recipient refs (exclude MANUAL_VERIFIED)',
    'OR call RPC driver_has_provider_verified_payout_destination(driver_id) if exposed to service role',
    'Pass payout_operational_paused into aggregate',
    'Pass account_verified from PD — NEVER from payouts_enabled',
  ],

  aggregateCall: `{
    live_balance_pence: live,
    outstanding_debt_pence: debt,
    in_flight_cashout_pence: inFlight,
    reserved_payout_pence: reservedPayout,
    payout_operational_paused: driverRes.data?.payout_operational_paused === true,
    payout_provider_available: true,
    account_verified: providerVerifiedActiveDestination,
    clearing_policy: { clearing_delay_hours: clearingDelayHours },
    entries,
  }`,

  // Delete this buggy line on deploy:
  deleteLines: [
    'account_verified: payoutsEnabled ? true : false',
    'payouts_enabled: payoutsEnabled',
  ],
} as const;
