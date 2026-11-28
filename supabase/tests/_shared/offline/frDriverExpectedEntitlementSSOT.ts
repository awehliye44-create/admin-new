/** Offline test/audit-only helpers; not part of Edge uploads. */
/**
 * FR Drivers tab — canonical expected driver entitlement (read-only).
 *
 * Never use raw trips.driver_net_pence alone for terminal-fee outcomes.
 * Canonical ARRIVAL_CANCELLATION / NO_SHOW / LATE_PASSENGER_CANCELLATION:
 * captured − ACTUAL provider fee, commission 0 (terminal settlement posting).
 * CANCELLED_WITH_FEE: rows earned on/after TERMINAL_FEE_UNIFIED_POLICY_CUTOVER_ISO
 * (#111C) use the canonical formula; earlier rows keep capture − commission
 * (provider fee platform-owned) and are never reinterpreted.
 */

import { TERMINAL_FEE_TRIP_STATUSES } from "../../../functions/_shared/driverCreditMonitoringSSOT.ts";

import { isCapturedAtRestampSuspect } from "../../../functions/_shared/paymentSessionCaptureTimestampSSOT.ts";

import { resolveTerminalEntitledDriverId } from "../../../functions/_shared/terminalOutcomeKindSSOT.ts";

import { isUnifiedTerminalFeePolicyActive } from "../../../functions/_shared/terminalFeePolicySSOT.ts";
import { FrDriverEntitlementTripInput, resolveFrTripFinancialPeriodOrigin } from "../../../functions/_shared/frDriverExpectedEntitlementSSOT.ts";


export function resolveFrTripFinancialSettledAt(
  trip: Pick<
    FrDriverEntitlementTripInput,
    | "financial_settled_at"
    | "settlement_settled_at"
    | "settlement_capture_time"
    | "captured_at"
    | "completed_at"
    | "ledger_created_at"
    | "first_captured_at"
    | "trip_status"
    | "financial_outcome"
  >,
): string | null {
  return resolveFrTripFinancialPeriodOrigin(trip).period_origin;
}

export * from "../../../functions/_shared/frDriverExpectedEntitlementSSOT.ts";
