/**
 * Pure evaluators for the extra financial-ssot-monitor scans (offer / airport /
 * waiting / assignment invariants). NOT a new SSOT: every amount comes from the
 * existing resolvers —
 *   committedBookingOfferFareSSOT.ts  (committed payable + driver net stamp)
 *   airportChargeFareSplitSSOT.ts     (airport + commission split)
 * This file only compares persisted rows against them and emits rows for the
 * existing `financial_ssot_mismatches` table (onConflict trip_id,stage,field_name).
 *
 * Read-only. No payment / capture / Revolut policy lives here.
 */
import {
  driverNetFromCustomerTotal,
  prePromotionCustomerPence,
  resolveGlobalOfferPromotionPence,
  resolvePersistedAirportChargePence,
} from "./airportChargeFareSplitSSOT.ts";
import {
  type CommittedOfferFareTrip,
  resolveCommittedOfferGross,
  stampOfferDriverNetFromCommittedFare,
} from "./committedBookingOfferFareSSOT.ts";

/** ±1p everywhere (rounding of the commission split). */
export const MONITOR_TOLERANCE_PENCE = 1;

export const MONITOR_ASSIGNMENT_STATUSES = ["assigned", "en_route", "arrived", "in_progress"] as const;

export type MonitorMismatchRow = {
  trip_id: string;
  trip_code: string | null;
  stage: string;
  field_name: string;
  expected_pence: number;
  actual_pence: number;
  details: Record<string, unknown>;
};

export type MonitorOfferRow = {
  id: string;
  trip_id: string;
  status: string;
  is_stacked?: boolean | null;
  created_at?: string | null;
  effective_commission_percent?: number | null;
  offered_driver_net_pence?: number | null;
  offer_snapshot?: Record<string, unknown> | null;
};

export type MonitorTripRow = CommittedOfferFareTrip & {
  id: string;
  trip_code?: string | null;
  status?: string | null;
};

function nonNeg(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function snapshotOf(offer: MonitorOfferRow): Record<string, unknown> {
  const s = offer.offer_snapshot;
  return s && typeof s === "object" && !Array.isArray(s) ? s : {};
}

function firstPositive(snap: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const n = nonNeg(snap[key]);
    if (n > 0) return n;
  }
  return 0;
}

export function snapshotBasePence(snap: Record<string, unknown>): number {
  return firstPositive(snap, ["baseFarePence", "base_fare_pence", "final_trip_fare_pence"]);
}

export function snapshotAirportPence(snap: Record<string, unknown>): number {
  return firstPositive(snap, ["airport_charge_pence", "airportChargePence"]);
}

function newestFirst(offers: MonitorOfferRow[]): MonitorOfferRow[] {
  return [...offers].sort((a, b) =>
    String(b.created_at ?? "").localeCompare(String(a.created_at ?? ""))
  );
}

function row(
  trip: MonitorTripRow,
  stage: string,
  field: string,
  expected: number,
  actual: number,
  details: Record<string, unknown>,
): MonitorMismatchRow {
  return {
    trip_id: String(trip.id),
    trip_code: trip.trip_code ?? null,
    stage,
    field_name: field,
    expected_pence: expected,
    actual_pence: actual,
    details: { trip_status: trip.status ?? null, ...details },
  };
}

/**
 * Scans 1-3 for ONE trip and its pending/accepted offers.
 *  - offer_vs_committed       base fare + driver net vs committed payable x commission
 *  - airport_component_missing trip has airport, newest offer snapshot has no airport (MK-007)
 *  - driver_net_vs_breakdown  airport present: net != commissionable-after-commission + airport
 */
export function evaluateOfferInvariants(
  trip: MonitorTripRow,
  offersIn: MonitorOfferRow[],
): MonitorMismatchRow[] {
  const out: MonitorMismatchRow[] = [];
  const seen = new Set<string>();
  const push = (r: MonitorMismatchRow) => {
    const key = `${r.stage}|${r.field_name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(r);
  };

  // Stacked pending/accepted offers use the same committed-fare contract as
  // non-stacked (FO001/FO002). Accepted offers on a trip with a folded
  // modification legitimately lag the (later) committed payable.
  const offers = newestFirst(
    offersIn.filter((o) =>
      (o.status === "pending" || o.status === "accepted") &&
      !(o.status === "accepted" && Number(trip.customer_modification_charge_pence ?? 0) !== 0)
    ),
  );
  if (offers.length === 0) return out;

  const resolved = resolveCommittedOfferGross(trip);
  const tripAirport = resolvePersistedAirportChargePence({
    airport_charge_pence: trip.airport_charge_pence,
    fare_breakdown: trip.fare_breakdown,
    fare_snapshot_json: trip.fare_snapshot_json,
  });
  const other = nonNeg(trip.other_pass_through_charges_pence);
  // global_offer is ONECAB-funded: commission base = payable + locked promotion (MK-007 6820).
  const promotion = resolveGlobalOfferPromotionPence(trip as unknown as Record<string, unknown>);

  for (const offer of offers) {
    const snap = snapshotOf(offer);
    const base = snapshotBasePence(snap);
    const actualNet = nonNeg(offer.offered_driver_net_pence);
    const pct = offer.effective_commission_percent;
    const pctOk = pct != null && Number.isFinite(Number(pct)) && Number(pct) >= 0;
    const snapAirport = snapshotAirportPence(snap);
    const airport = tripAirport > 0 ? tripAirport : snapAirport;
    const common = { offer_id: offer.id, offer_status: offer.status };

    // 1. offer_vs_committed (only when the payable is genuinely committed)
    if (resolved.committed && resolved.pence > 0) {
      if (base > 0 && Math.abs(base - resolved.pence) > MONITOR_TOLERANCE_PENCE) {
        push(row(trip, "offer_vs_committed", "base_fare_pence", resolved.pence, base, {
          ...common,
          committed_source: resolved.source,
        }));
      }
      if (pctOk && actualNet > 0) {
        const stamp = stampOfferDriverNetFromCommittedFare({
          trip,
          commissionPercent: Number(pct),
          airportPence: airport,
        });
        if (stamp.ok && Math.abs(actualNet - stamp.driverNetPence) > MONITOR_TOLERANCE_PENCE) {
          push(row(trip, "offer_vs_committed", "driver_net_pence", stamp.driverNetPence, actualNet, {
            ...common,
            committed_source: resolved.source,
            commission_percent: Number(pct),
          }));
        }
      }
    }

    // 3. driver_net_vs_breakdown (airport present; the offer's own base + airport)
    if (airport > 0 && pctOk && actualNet > 0) {
      const payableBase = base > 0 ? base : resolved.pence;
      const gross = prePromotionCustomerPence(payableBase, promotion);
      if (gross > 0) {
        const airportClamped = Math.min(airport, gross);
        const expected = driverNetFromCustomerTotal({
          customerPence: gross,
          airportPence: airportClamped,
          otherPassThroughPence: Math.min(other, Math.max(0, gross - airportClamped)),
          commissionPercent: Number(pct),
        }).driverNetPence;
        if (expected > 0 && Math.abs(actualNet - expected) > MONITOR_TOLERANCE_PENCE) {
          push(row(trip, "driver_net_vs_breakdown", "offered_driver_net_pence", expected, actualNet, {
            ...common,
            airport_pence: airportClamped,
            commission_percent: Number(pct),
            locked_promotion_pence: promotion,
          }));
        }
      }
    }
  }

  // 2. airport_component_missing (newest offer only)
  const latest = offers[0];
  if (tripAirport > 0) {
    const snap = snapshotOf(latest);
    const state = String(snap.airport_charge_state ?? "");
    if (snapshotAirportPence(snap) <= 0 && state !== "present") {
      push(row(trip, "airport_component_missing", "offer_snapshot_airport_charge_pence", tripAirport, 0, {
        offer_id: latest.id,
        offer_status: latest.status,
        airport_charge_state: state || null,
      }));
    }
  }

  return out;
}

export type MonitorWaitingSegmentRow = {
  trip_id: string;
  location_type?: string | null;
  stop_id?: string | null;
  ended_at?: string | null;
};

/** Scan 4: more than one OPEN segment per authoritative waiting session. */
export function evaluateOverlappingWaitingOpen(
  segments: MonitorWaitingSegmentRow[],
  tripCodes: Map<string, string | null> = new Map(),
): MonitorMismatchRow[] {
  const counts = new Map<string, { trip_id: string; session: string; count: number }>();
  for (const seg of segments) {
    if (seg.ended_at != null) continue;
    const isStop = seg.location_type === "stop";
    const session = isStop ? `stop:${seg.stop_id ?? "none"}` : "pickup";
    const key = `${seg.trip_id}|${session}`;
    const cur = counts.get(key) ?? { trip_id: seg.trip_id, session, count: 0 };
    cur.count += 1;
    counts.set(key, cur);
  }
  const out: MonitorMismatchRow[] = [];
  for (const c of counts.values()) {
    if (c.count <= 1) continue;
    out.push({
      trip_id: c.trip_id,
      trip_code: tripCodes.get(c.trip_id) ?? null,
      stage: "overlapping_waiting_open",
      field_name: `open_segments:${c.session}`,
      expected_pence: 1,
      actual_pence: c.count,
      details: { session: c.session, open_segment_count: c.count },
    });
  }
  return out;
}

export type MonitorAssignmentTripRow = {
  id: string;
  trip_code?: string | null;
  status?: string | null;
  driver_id?: string | null;
  confirmed_driver_id?: string | null;
};

/** Scan 5: confirmed_driver_id IS DISTINCT FROM driver_id on a live assigned trip. */
export function evaluateInvalidAssignmentOwnership(
  trips: MonitorAssignmentTripRow[],
): MonitorMismatchRow[] {
  const live = new Set<string>(MONITOR_ASSIGNMENT_STATUSES);
  const out: MonitorMismatchRow[] = [];
  for (const t of trips) {
    if (!live.has(String(t.status ?? ""))) continue;
    const a = t.confirmed_driver_id ?? null;
    const b = t.driver_id ?? null;
    if (a === b) continue;
    out.push({
      trip_id: String(t.id),
      trip_code: t.trip_code ?? null,
      stage: "invalid_assignment_ownership",
      field_name: "confirmed_driver_id_vs_driver_id",
      expected_pence: 0,
      actual_pence: 0,
      details: {
        trip_status: t.status ?? null,
        confirmed_driver_id_present: a != null,
        driver_id_present: b != null,
      },
    });
  }
  return out;
}
