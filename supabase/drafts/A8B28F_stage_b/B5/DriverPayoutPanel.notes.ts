/**
 * A8B28F Stage B5 DRAFT — DriverPayoutPanel changes (copy guidance).
 *
 * 1) Remove / hide the Manual Verify button and toast that mentions MANUAL_VERIFIED.
 * 2) Keep Reject / Disable only if product still wants operational disable.
 * 3) Keep Provider Sync as separately authorized (admin-sync-driver-payout-provider-linkage).
 * 4) Show provider verification separately from operational pause:
 *    - provider_link_status / PROVIDER_VERIFIED
 *    - drivers.payout_operational_paused (select in panel query)
 * 5) Never call admin-verify with action=verify.
 * 6) Never say "Admin must verify".
 *
 * Example verify button removal:
 *   // DELETE: <Button onClick={() => adminAction.mutate("verify")}>Verify</Button>
 *
 * Example pause control (after B1):
 *   await adminSetDriverPayoutOperationalPause({ driverId, paused: true, reason })
 */

export const B5_DRIVER_PAYOUT_PANEL_RULES = {
  forbidManualVerify: true,
  forbidManualVerifiedToast: true,
  showProviderVerificationSeparately: true,
  showOperationalPauseSeparately: true,
  pauseViaRpcOnly: true,
} as const;
