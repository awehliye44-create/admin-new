/**
 * FR — customer receivable position (read-only, all-time).
 *
 * One place that answers: what is still owed, what has been recovered on later
 * bookings, which captured shortfalls have no receivable yet, and what was
 * formally written off. Pre-ledger shortfalls are shown separately and never
 * become new customer debt.
 *
 * Never merged into wallet / payout variance. Recovered amounts are customer
 * debt collection — not driver earnings, not commissionable fare.
 */

import { isWithinReceivablesLedger } from "./shortfallReceivableSafety.ts";

export type ReceivablePositionReceivableRow = {
  id: string;
  source_trip_id: string | null;
  status: string;
  original_amount_pence: number | null;
  outstanding_amount_pence: number | null;
};

export type ReceivablePositionExceptionRow = {
  id: string;
  trip_id: string;
  status: string;
  shortfall_pence: number | null;
  receivable_id?: string | null;
};

export type ReceivablePositionShortfallSessionRow = {
  trip_id: string | null;
  status?: string | null;
  provider_state?: string | null;
  created_at?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type ReceivablePositionAlertRow = {
  fingerprint?: string | null;
  status?: string | null;
  related_trip_id?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type CustomerReceivablePosition = {
  outstanding_pence: number;
  outstanding_count: number;
  manual_review_pence: number;
  manual_review_count: number;
  recovered_pence: number;
  recovered_count: number;
  unresolved_shortfall_pence: number;
  unresolved_shortfall_count: number;
  unresolved_shortfall_trip_ids: string[];
  written_off_pence: number;
  written_off_count: number;
  legacy_pre_ledger_shortfall_pence: number;
  legacy_pre_ledger_shortfall_count: number;
  exceptions_ledger_available: boolean;
  not_driver_earnings: true;
  not_commissionable_fare: true;
};

function pence(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

const OUTSTANDING_STATUSES = new Set(["OPEN", "RESERVED"]);

function isCancelledSession(row: ReceivablePositionShortfallSessionRow): boolean {
  const st = String(row.status ?? "").toUpperCase();
  const ps = String(row.provider_state ?? "").toUpperCase();
  return st === "CANCELLED" || ps === "CANCELLED";
}

/** An unresolved shortfall must not be presented as a balanced reconciliation. */
export function unresolvedShortfallBlocksBalanced(
  position: { unresolved_shortfall_count: number } | null | undefined,
): boolean {
  return (position?.unresolved_shortfall_count ?? 0) > 0;
}

export function buildCustomerReceivablePosition(args: {
  receivables: ReceivablePositionReceivableRow[];
  exceptions: ReceivablePositionExceptionRow[] | null;
  shortfallSessions: ReceivablePositionShortfallSessionRow[];
  alerts?: ReceivablePositionAlertRow[] | null;
}): CustomerReceivablePosition {
  const pos: CustomerReceivablePosition = {
    outstanding_pence: 0,
    outstanding_count: 0,
    manual_review_pence: 0,
    manual_review_count: 0,
    recovered_pence: 0,
    recovered_count: 0,
    unresolved_shortfall_pence: 0,
    unresolved_shortfall_count: 0,
    unresolved_shortfall_trip_ids: [],
    written_off_pence: 0,
    written_off_count: 0,
    legacy_pre_ledger_shortfall_pence: 0,
    legacy_pre_ledger_shortfall_count: 0,
    exceptions_ledger_available: args.exceptions != null,
    not_driver_earnings: true,
    not_commissionable_fare: true,
  };

  const receivableTrips = new Set<string>();
  const waivedTrips = new Set<string>();
  for (const r of args.receivables ?? []) {
    const status = String(r.status ?? "").toUpperCase();
    const original = pence(r.original_amount_pence);
    const outstanding = pence(r.outstanding_amount_pence);
    if (r.source_trip_id) receivableTrips.add(String(r.source_trip_id));

    if (status === "WAIVED") {
      if (r.source_trip_id) waivedTrips.add(String(r.source_trip_id));
      pos.written_off_pence += original;
      pos.written_off_count += 1;
      continue;
    }
    if (OUTSTANDING_STATUSES.has(status)) {
      pos.outstanding_pence += outstanding;
      pos.outstanding_count += 1;
    } else if (status === "MANUAL_REVIEW") {
      pos.manual_review_pence += outstanding;
      pos.manual_review_count += 1;
    }
    const recovered = Math.max(0, original - outstanding);
    if (recovered > 0) {
      pos.recovered_pence += recovered;
      pos.recovered_count += 1;
    }
  }

  const exceptionTrips = new Set<string>();
  const unresolvedTrips = new Set<string>();
  for (const e of args.exceptions ?? []) {
    const status = String(e.status ?? "").toUpperCase();
    const tripId = String(e.trip_id ?? "");
    if (tripId) exceptionTrips.add(tripId);
    if (status === "OPEN" && !receivableTrips.has(tripId)) {
      pos.unresolved_shortfall_pence += pence(e.shortfall_pence);
      pos.unresolved_shortfall_count += 1;
      unresolvedTrips.add(tripId);
    } else if (status === "WRITTEN_OFF" && !waivedTrips.has(tripId)) {
      pos.written_off_pence += pence(e.shortfall_pence);
      pos.written_off_count += 1;
    }
  }

  const seenSessionTrips = new Set<string>();
  for (const s of args.shortfallSessions ?? []) {
    const tripId = String(s.trip_id ?? "");
    const marker = pence(s.metadata?.shortfall_pence);
    if (!tripId || marker <= 0 || isCancelledSession(s) || seenSessionTrips.has(tripId)) continue;
    seenSessionTrips.add(tripId);
    if (receivableTrips.has(tripId) || exceptionTrips.has(tripId)) continue;
    if (isWithinReceivablesLedger(s.created_at ?? null)) {
      pos.unresolved_shortfall_pence += marker;
      pos.unresolved_shortfall_count += 1;
      unresolvedTrips.add(tripId);
    } else {
      pos.legacy_pre_ledger_shortfall_pence += marker;
      pos.legacy_pre_ledger_shortfall_count += 1;
    }
  }

  for (const alert of args.alerts ?? []) {
    const tripId = String(alert.related_trip_id ?? "");
    const fingerprint = String(alert.fingerprint ?? "");
    const status = String(alert.status ?? "").toLowerCase();
    if (!tripId || status !== "open" || !fingerprint.startsWith("finance:shortfall_unrecorded:")) continue;
    if (receivableTrips.has(tripId) || exceptionTrips.has(tripId) || unresolvedTrips.has(tripId)) continue;
    const marker = pence(alert.metadata?.shortfall_pence);
    if (marker <= 0) continue;
    pos.unresolved_shortfall_pence += marker;
    pos.unresolved_shortfall_count += 1;
    unresolvedTrips.add(tripId);
  }

  pos.unresolved_shortfall_trip_ids = [...unresolvedTrips].sort();
  return pos;
}
