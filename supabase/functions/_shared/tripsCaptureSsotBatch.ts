/**
 * Batch trip capture context — SSOT via mapTripToFinancialAuditRow (no client trip_finance reads).
 */
import {
  buildTripFinancialAuditContext,
  mapTripToFinancialAuditRow,
  type TripAuditSourceRow,
} from "./financeSettlementSummary.ts";
import { tripDriverNetPenceForAudit } from "./financeSettlementSummary.ts";

export type TripCaptureSsotRow = {
  trip_id: string;
  settlement_total_pence: number;
  capture_mismatch: boolean;
  captured_pence: number;
  ledger_trip_earning_net_pence: number | null;
};

const TRIP_CAPTURE_SSOT_SELECT = `
  id,
  trip_code,
  commission_pence,
  stripe_processing_fee_pence,
  onecab_net_pence,
  driver_net_pence,
  gross_fare_pence,
  final_fare_pence,
  commissionable_fare_pence,
  capture_amount_pence,
  outstanding_balance_pence,
  payment_coverage_status,
  refund_amount_pence,
  pickup_waiting_charge_pence,
  stop_waiting_charge_pence,
  airport_charge_pence,
  other_pass_through_charges_pence,
  tip_pence,
  tip_amount_pence,
  payment_method,
  payment_status,
  status,
  financial_outcome,
  stripe_payment_intent_id,
  stripe_charge_id,
  provider_status,
  driver_id,
  passenger_name,
  stripe_settlement_verified,
  driver_tier_commission_percent,
  commission_pct,
  completed_at
`;

export { TRIP_CAPTURE_SSOT_SELECT };

export function mapTripsToCaptureSsotRows(args: {
  trips: TripAuditSourceRow[];
  payments: Array<{
    trip_id: string | null;
    captured_amount_pence: number | null;
    status: string | null;
    provider_status?: string | null;
    stripe_payment_intent_id?: string | null;
    provider_available_on?: string | null;
    amount_pence?: number | null;
    fee_type?: string | null;
    metadata?: Record<string, unknown> | null;
  }>;
  payoutItems: Array<{
    trip_id: string | null;
    status: string;
    driver_amount_pence?: number | null;
    amount_pence?: number | null;
    batch_id?: string | null;
  }>;
  ledgerRows: Array<{
    related_trip_id: string | null;
    type: string;
    amount_pence: number;
    stripe_payout_id?: string | null;
    stripe_transfer_id?: string | null;
  }>;
}): TripCaptureSsotRow[] {
  const context = buildTripFinancialAuditContext({
    payments: args.payments,
    payoutItems: args.payoutItems,
    ledgerRows: args.ledgerRows,
  });

  const results: TripCaptureSsotRow[] = [];
  for (const trip of args.trips) {
    const audit = mapTripToFinancialAuditRow(trip, context);
    const ledger = context.ledgerByTripId.get(trip.id) ?? [];
    const driverNet = tripDriverNetPenceForAudit(trip, ledger);
    results.push({
      trip_id: trip.id,
      settlement_total_pence: audit.settlement_total_pence,
      capture_mismatch: audit.capture_mismatch,
      captured_pence: audit.captured_pence,
      ledger_trip_earning_net_pence: driverNet,
    });
  }
  return results;
}
