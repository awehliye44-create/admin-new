/**
 * I/O: load DWL + trip + Payment Sessions (+ optional DES) and compute
 * canonical get_driver_payout_eligibility result.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { computeLedgerWalletBalancePence, computeCashCommissionOutstanding } from "./onecabFinanceLedger.ts";
import {
  PAYOUT_ELIGIBLE_LEDGER_TYPES,
  aggregateDriverPayoutEligibility,
  deriveTripFrStatusForPayoutEligibility,
  type DriverPayoutEligibilityResult,
  type LedgerEligibilityEvidence,
} from "../../../shared/driverPayoutEligibilitySSOT.ts";

export type { DriverPayoutEligibilityResult };

export async function fetchDriverPayoutEligibility(
  supabase: SupabaseClient,
  args: {
    driver_id: string;
    service_area_id?: string | null;
    as_of?: string | null;
  },
): Promise<DriverPayoutEligibilityResult> {
  void args.service_area_id;
  void args.as_of;

  const [
    driverRes,
    ledgerRes,
    earlyCashoutsRes,
  ] = await Promise.all([
    supabase
      .from("drivers")
      .select("id, payouts_enabled")
      .eq("id", args.driver_id)
      .maybeSingle(),
    supabase
      .from("driver_wallet_ledger")
      .select("id, type, amount_pence, related_trip_id, created_at")
      .eq("driver_id", args.driver_id),
    supabase
      .from("driver_early_cashouts")
      .select("status, requested_cashout_pence")
      .eq("driver_id", args.driver_id)
      .in("status", ["pending", "processing", "transfer_created"]),
  ]);

  const ledger = ledgerRes.data ?? [];
  const live = computeLedgerWalletBalancePence(ledger);
  const debt = computeCashCommissionOutstanding(ledger);
  const inFlight = (earlyCashoutsRes.data ?? []).reduce(
    (s, r) => s + Math.max(0, Number(r.requested_cashout_pence ?? 0)),
    0,
  );

  const earningRows = ledger.filter((r) =>
    PAYOUT_ELIGIBLE_LEDGER_TYPES.has(String(r.type ?? "").toUpperCase())
    && Number(r.amount_pence ?? 0) > 0
  );

  const tripIds = [...new Set(
    earningRows.map((r) => String(r.related_trip_id ?? "")).filter(Boolean),
  )];
  const ledgerIds = earningRows.map((r) => String(r.id));

  const tripById = new Map<string, Record<string, unknown>>();
  const sessionByTripId = new Map<string, Record<string, unknown>>();
  const sessionById = new Map<string, Record<string, unknown>>();
  const desByLedgerId = new Map<string, Record<string, unknown>>();
  const allocatedByLedgerId = new Map<string, number>();

  if (tripIds.length > 0 || ledgerIds.length > 0) {
    const [tripsRes, sessionsByTripRes, desRes, allocRes] = await Promise.all([
      tripIds.length > 0
        ? supabase
          .from("trips")
          .select(
            "id, payment_session_id, driver_net_pence, tip_pence, tip_amount_pence, payment_status, payment_method, payment_provider, completed_at, settlement_formula_version",
          )
          .in("id", tripIds)
        : Promise.resolve({ data: [] as Record<string, unknown>[] }),
      tripIds.length > 0
        ? supabase
          .from("payment_sessions")
          .select(
            "id, trip_id, captured_amount_pence, refunded_amount_pence, status, captured_at",
          )
          .in("trip_id", tripIds)
        : Promise.resolve({ data: [] as Record<string, unknown>[] }),
      ledgerIds.length > 0
        ? supabase
          .from("driver_earning_settlement")
          .select(
            "id, ledger_entry_id, trip_id, settlement_status, settlement_lifecycle_status, eligible_for_payout, allocated_to_payout, allocated_amount_pence, paid_in_batch_id, paid_in_payout_item_id",
          )
          .in("ledger_entry_id", ledgerIds)
        : Promise.resolve({ data: [] as Record<string, unknown>[] }),
      ledgerIds.length > 0
        ? supabase
          .from("payout_item_ledger_allocations")
          .select("ledger_entry_id, amount_pence")
          .in("ledger_entry_id", ledgerIds)
        : Promise.resolve({ data: [] as Record<string, unknown>[] }),
    ]);

    for (const t of tripsRes.data ?? []) {
      tripById.set(String(t.id), t as Record<string, unknown>);
    }

    const sessionIdsFromTrips = [...new Set(
      [...tripById.values()]
        .map((t) => String(t.payment_session_id ?? ""))
        .filter(Boolean),
    )];

    if (sessionIdsFromTrips.length > 0) {
      const { data: sessionsById } = await supabase
        .from("payment_sessions")
        .select("id, trip_id, captured_amount_pence, refunded_amount_pence, status, captured_at")
        .in("id", sessionIdsFromTrips);
      for (const s of sessionsById ?? []) {
        sessionById.set(String(s.id), s as Record<string, unknown>);
      }
    }

    for (const s of sessionsByTripRes.data ?? []) {
      const tripId = String(s.trip_id ?? "");
      if (!tripId) continue;
      const existing = sessionByTripId.get(tripId);
      const existingCap = Number(existing?.captured_amount_pence ?? 0);
      const nextCap = Number(s.captured_amount_pence ?? 0);
      if (!existing || nextCap > existingCap) {
        sessionByTripId.set(tripId, s as Record<string, unknown>);
      }
    }

    for (const d of desRes.data ?? []) {
      desByLedgerId.set(String(d.ledger_entry_id), d as Record<string, unknown>);
    }

    for (const a of allocRes.data ?? []) {
      const lid = String(a.ledger_entry_id);
      allocatedByLedgerId.set(
        lid,
        (allocatedByLedgerId.get(lid) ?? 0) + Math.max(0, Number(a.amount_pence ?? 0)),
      );
    }
  }

  const entries: LedgerEligibilityEvidence[] = earningRows.map((row) => {
    const tripId = row.related_trip_id ? String(row.related_trip_id) : null;
    const trip = tripId ? tripById.get(tripId) : undefined;
    const psId = trip?.payment_session_id ? String(trip.payment_session_id) : null;
    const session = (psId && sessionById.get(psId))
      || (tripId ? sessionByTripId.get(tripId) : undefined);
    const des = desByLedgerId.get(String(row.id));
    const allocFromPila = allocatedByLedgerId.get(String(row.id)) ?? 0;
    const allocFromDes = Math.max(0, Number(des?.allocated_amount_pence ?? 0));
    const allocated = Math.max(allocFromPila, allocFromDes);
    const lifecycle = String(des?.settlement_lifecycle_status ?? "").toUpperCase();
    const capturedRaw = session?.captured_amount_pence;
    const captured = capturedRaw == null ? null : Number(capturedRaw);
    const refunded = Number(session?.refunded_amount_pence ?? 0);
    const sessionStatus = String(session?.status ?? "").toLowerCase();

    const capturedPence = captured != null && Number.isFinite(captured) && captured > 0
      ? Math.round(captured)
      : null;
    const canonicalNet = trip?.driver_net_pence == null
      ? null
      : Math.max(0, Number(trip.driver_net_pence));

    return {
      ledger_entry_id: String(row.id),
      trip_id: tripId,
      ledger_type: String(row.type ?? ""),
      amount_pence: Math.max(0, Number(row.amount_pence ?? 0)),
      trip_exists: Boolean(trip),
      payment_session_id: psId || (session?.id ? String(session.id) : null),
      captured_amount_pence: capturedPence,
      canonical_driver_net_pence: canonicalNet,
      canonical_tip_pence: Math.max(
        0,
        Number(trip?.tip_pence ?? trip?.tip_amount_pence ?? 0),
      ),
      fr_trip_status: deriveTripFrStatusForPayoutEligibility({
        canonical_driver_net_pence: canonicalNet,
        captured_amount_pence: capturedPence,
        settlement_formula_version: trip?.settlement_formula_version
          ? String(trip.settlement_formula_version)
          : null,
        completed_at: trip?.completed_at ? String(trip.completed_at) : null,
        trip_payment_status: trip?.payment_status ? String(trip.payment_status) : null,
      }),
      refunded_amount_pence: refunded > 0 || sessionStatus.includes("refund")
        ? Math.max(refunded, 1)
        : 0,
      chargeback_hold: sessionStatus.includes("chargeback") || sessionStatus.includes("dispute"),
      allocated_to_payout: des?.allocated_to_payout === true || allocated >= Math.max(0, Number(row.amount_pence ?? 0)),
      allocated_amount_pence: allocated,
      paid_in_batch_id: (des?.paid_in_batch_id as string | null) ?? null,
      payout_processing: lifecycle === "INCLUDED_IN_PAYOUT" && !des?.paid_in_payout_item_id,
      des_present: Boolean(des),
      des_eligible_for_payout: des?.eligible_for_payout === true,
    };
  });

  const payoutsEnabled = driverRes.data?.payouts_enabled !== false;

  return aggregateDriverPayoutEligibility({
    live_balance_pence: live,
    outstanding_debt_pence: debt,
    in_flight_cashout_pence: inFlight,
    payouts_enabled: payoutsEnabled,
    payout_provider_available: true,
    // Revolut manual bank: account is valid when payouts are enabled (no Connect required).
    account_verified: payoutsEnabled ? true : false,
    entries,
  });
}
