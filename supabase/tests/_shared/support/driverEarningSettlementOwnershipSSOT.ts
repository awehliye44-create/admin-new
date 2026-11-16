/**
 * driver_earning_settlement ownership — Phase 0c decision B.
 *
 * Role: AUDIT / LIFECYCLE COMPANION (not canonical entitlement owner).
 *
 * Canonical entitlement sources:
 *   - Settlement result / trip stamp (driver_net_pence, capture_amount_pence)
 *   - Payment Session capture + provider fee evidence
 *   - computeAuthoritativeSettlement / terminalOutcomeEntitlementSSOT
 *   - driver_wallet_ledger typed credits (TRIP_EARNING_NET, DRIVER_COMPENSATION_CREDIT)
 *
 * driver_earning_settlement:
 *   - NOT required for payout eligibility (driverPayoutEligibilitySSOT reads wallet + PS)
 *   - MAY be absent on legacy or repair rows without blocking payout
 *   - Companion audit when present; missing row is a monitoring exception, not entitlement loss
 *   - Must never be the sole writer of driver_net or wallet amounts
 */
export const DRIVER_EARNING_SETTLEMENT_ROLE = "AUDIT_COMPANION" as const;

export type DriverEarningSettlementRole = typeof DRIVER_EARNING_SETTLEMENT_ROLE;

export function isDriverEarningSettlementRequiredForPayout(): boolean {
  return false;
}

export function missingDriverEarningSettlementSeverity(): "monitoring_exception" {
  return "monitoring_exception";
}
