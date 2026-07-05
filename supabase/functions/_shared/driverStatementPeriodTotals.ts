/** Per-driver statement period totals — SSOT aggregation for Statement Runs (no client reduce). */

import { PAYOUT_DEBIT_LEDGER_TYPES } from "./financeBackendAuditV1.ts";

export type DriverStatementPeriodTotal = {
  driver_id: string;
  gross_earnings_pence: number;
  commission_pence: number;
  driver_net_pence: number;
  completed_trips: number;
  no_show_trips: number;
  late_cancel_trips: number;
  bonuses_pence: number;
  penalties_pence: number;
  adjustments_pence: number;
  cash_collected_pence: number;
  net_earnings_pence: number;
  /** Sum of successful payout ledger debits in period (Stripe Connect evidence). */
  payouts_received_pence: number;
};

type AuditRowLike = {
  driver_id?: string | null;
  trip_id?: string | null;
  trip_status?: string | null;
  status?: string | null;
  financial_outcome?: string | null;
  gross_fare_pence?: number | null;
  onecab_gross_commission_pence?: number | null;
  driver_net_pence?: number | null;
};

type LedgerRowLike = {
  driver_id: string;
  type: string;
  amount_pence: number;
};

const PAYOUT_DEBIT_TYPES = new Set<string>(PAYOUT_DEBIT_LEDGER_TYPES);

function classifyTripOutcome(row: AuditRowLike): "completed" | "no_show" | "late_cancel" | "other" {
  const outcome = String(row.financial_outcome ?? "").toUpperCase();
  const status = String(row.trip_status ?? row.status ?? "").toLowerCase();
  if (outcome === "NO_SHOW" || status === "no_show") return "no_show";
  if (outcome === "LATE_PASSENGER_CANCELLATION") return "late_cancel";
  if (outcome === "COMPLETED" || status === "completed") return "completed";
  return "other";
}

export function buildDriverStatementPeriodTotals(
  auditRows: AuditRowLike[],
  ledgerRows: LedgerRowLike[],
  driverIdsFilter?: Set<string>,
): DriverStatementPeriodTotal[] {
  const byDriver = new Map<
    string,
    { gross: number; commission: number; net: number; completed: number; noShow: number; lateCancel: number }
  >();

  for (const row of auditRows) {
    const did = row.driver_id?.trim();
    if (!did) continue;
    if (driverIdsFilter && !driverIdsFilter.has(did)) continue;

    const agg = byDriver.get(did) ?? {
      gross: 0,
      commission: 0,
      net: 0,
      completed: 0,
      noShow: 0,
      lateCancel: 0,
    };
    agg.gross += Number(row.gross_fare_pence ?? 0);
    agg.commission += Number(row.onecab_gross_commission_pence ?? 0);
    if (row.driver_net_pence != null) {
      agg.net += Number(row.driver_net_pence);
    }
    if (row.trip_id) {
      switch (classifyTripOutcome(row)) {
        case "completed":
          agg.completed += 1;
          break;
        case "no_show":
          agg.noShow += 1;
          break;
        case "late_cancel":
          agg.lateCancel += 1;
          break;
      }
    }
    byDriver.set(did, agg);
  }

  const ledgerByDriver = new Map<
    string,
    { bonuses: number; penalties: number; adjustments: number; payoutsReceived: number }
  >();
  for (const entry of ledgerRows) {
    if (driverIdsFilter && !driverIdsFilter.has(entry.driver_id)) continue;
    const agg = ledgerByDriver.get(entry.driver_id) ?? {
      bonuses: 0,
      penalties: 0,
      adjustments: 0,
      payoutsReceived: 0,
    };
    const amt = Number(entry.amount_pence ?? 0);
    switch (entry.type) {
      case "BONUS":
        agg.bonuses += amt;
        break;
      case "ADJUSTMENT":
      case "REFUND_DEBIT":
        agg.adjustments += amt;
        break;
      case "PENALTY":
      case "DEDUCTION":
        agg.penalties += Math.abs(amt);
        break;
      default:
        if (PAYOUT_DEBIT_TYPES.has(entry.type)) {
          agg.payoutsReceived += Math.abs(amt);
        }
        break;
    }
    ledgerByDriver.set(entry.driver_id, agg);
  }

  const allDriverIds = new Set<string>([...byDriver.keys(), ...ledgerByDriver.keys()]);
  if (driverIdsFilter) {
    for (const id of driverIdsFilter) allDriverIds.add(id);
  }

  const results: DriverStatementPeriodTotal[] = [];
  for (const driverId of allDriverIds) {
    const audit = byDriver.get(driverId);
    const ledger = ledgerByDriver.get(driverId);
    const gross = audit?.gross ?? 0;
    const commission = audit?.commission ?? 0;
    const driverNet = audit?.net ?? 0;
    const bonuses = ledger?.bonuses ?? 0;
    const penalties = ledger?.penalties ?? 0;
    const adjustments = ledger?.adjustments ?? 0;
    const cashCollected = 0;
    const payoutsReceived = ledger?.payoutsReceived ?? 0;

    if (
      gross === 0 && commission === 0 && driverNet === 0
      && bonuses === 0 && penalties === 0 && adjustments === 0
      && payoutsReceived === 0
      && (audit?.completed ?? 0) === 0 && (audit?.noShow ?? 0) === 0 && (audit?.lateCancel ?? 0) === 0
    ) {
      continue;
    }

    results.push({
      driver_id: driverId,
      gross_earnings_pence: gross,
      commission_pence: commission,
      driver_net_pence: driverNet,
      completed_trips: audit?.completed ?? 0,
      no_show_trips: audit?.noShow ?? 0,
      late_cancel_trips: audit?.lateCancel ?? 0,
      bonuses_pence: bonuses,
      penalties_pence: penalties,
      adjustments_pence: adjustments,
      cash_collected_pence: cashCollected,
      net_earnings_pence: driverNet + bonuses - penalties + adjustments,
      payouts_received_pence: payoutsReceived,
    });
  }

  return results;
}
