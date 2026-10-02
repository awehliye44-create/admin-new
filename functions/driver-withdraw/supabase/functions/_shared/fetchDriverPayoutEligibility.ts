/**
 * I/O: load DWL + trip + Payment Sessions (+ optional DES) and compute
 * canonical get_driver_payout_eligibility result.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { computeLedgerWalletBalancePence, computeCashCommissionOutstanding } from "./onecabFinanceLedger.ts";
import {
  DEFAULT_PAYOUT_CLEARING_DELAY_HOURS,
  PAYOUT_ELIGIBLE_LEDGER_TYPES,
  aggregateDriverPayoutEligibility,
  deriveTripFrStatusForPayoutEligibility,
  type DriverPayoutEligibilityResult,
  type LedgerEligibilityEvidence,
} from "./driverPayoutEligibilitySSOT.ts";
import { payoutItemStatusReleasesLedgerAllocation } from "./payoutAllocationEligibilitySSOT.ts";

export type { DriverPayoutEligibilityResult };

export type FetchDriverPayoutEligibilityContext = {
  eligibility: DriverPayoutEligibilityResult;
  global_payouts_enabled: boolean;
  payout_operational_paused: boolean;
  provider_verified_active_destination: boolean;
  driver_approved: boolean;
  driver_suspended: boolean;
  legacy_payouts_enabled: boolean | null;
  active_destination_last4: string | null;
  fee_pence: number;
};

/**
 * Driver Withdraw GET quote requires a 4-digit masked account for authorization.
 * Prefer destination_last4 (canonical on save/verify) and fall back to account_last4
 * for rows written before both columns were kept in sync (MK0007 / MK-260926).
 */
export function resolveActiveDestinationLast4(dest: {
  account_last4?: string | null;
  destination_last4?: string | null;
} | null | undefined): string | null {
  if (!dest) return null;
  for (const raw of [dest.destination_last4, dest.account_last4]) {
    const digits = String(raw ?? "").replace(/\D/g, "").slice(-4);
    if (digits.length === 4) return digits;
  }
  return null;
}

/** Stage C2 context: eligibility balances + effective payout gates (legacy flag diagnostic only). */
export async function fetchDriverPayoutEligibilityContext(
  supabase: SupabaseClient,
  args: {
    driver_id: string;
    service_area_id?: string | null;
    as_of?: string | null;
  },
): Promise<FetchDriverPayoutEligibilityContext> {
  void args.service_area_id;
  void args.as_of;

  const [
    driverRes,
    ledgerRes,
    earlyCashoutsRes,
    destinationRes,
    settingsRes,
  ] = await Promise.all([
    supabase
      .from("drivers")
      .select("id, payouts_enabled, payout_operational_paused, approval_status, driver_status")
      .eq("id", args.driver_id)
      .maybeSingle(),
    supabase
      .from("driver_wallet_ledger")
      .select("id, type, amount_pence, related_trip_id, created_at, metadata")
      .eq("driver_id", args.driver_id),
    supabase
      .from("driver_early_cashouts")
      .select("status, requested_cashout_pence")
      .eq("driver_id", args.driver_id)
      .in("status", ["pending", "processing", "transfer_created"]),
    supabase
      .from("driver_payout_destinations")
      .select(
        "id, is_active, archived_at, verification_status, provider_link_status, provider_counterparty_id, provider_recipient_account_id, account_last4, destination_last4",
      )
      .eq("driver_id", args.driver_id)
      .eq("is_active", true)
      .is("archived_at", null)
      .order("updated_at", { ascending: false })
      .limit(1),
    supabase
      .from("admin_settings")
      .select("setting_key, setting_value")
      .in("setting_key", ["payouts_enabled", "payout_clearing_delay_hours", "early_cashout_fee_pence"]),
  ]);

  const ledger = ledgerRes.data ?? [];
  const live = computeLedgerWalletBalancePence(ledger);
  const debt = computeCashCommissionOutstanding(ledger);
  const inFlight = (earlyCashoutsRes.data ?? []).reduce(
    (s, r) => s + Math.max(0, Number(r.requested_cashout_pence ?? 0)),
    0,
  );
  let reservedPayout = 0;
  try {
    const { data: reservedRaw } = await supabase.rpc(
      "driver_wallet_active_reservation_pence",
      { p_driver_id: args.driver_id },
    );
    reservedPayout = Math.max(0, Number(reservedRaw ?? 0));
  } catch {
    reservedPayout = 0;
  }

  const earningRows = ledger.filter((r) => {
    const type = String(r.type ?? "").toUpperCase();
    const amount = Number(r.amount_pence ?? 0);
    if (type === "ADMIN_WALLET_CREDIT" && amount > 0) return true;
    return PAYOUT_ELIGIBLE_LEDGER_TYPES.has(type) && amount > 0;
  });

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
            "id, payment_session_id, driver_net_pence, tip_pence, tip_amount_pence, payment_status, payment_method, payment_provider, status, cancelled_at, completed_at, settlement_formula_version, payment_collection_model, financial_model, provider_available_on",
          )
          .in("id", tripIds)
        : Promise.resolve({ data: [] as Record<string, unknown>[] }),
      tripIds.length > 0
        ? supabase
          .from("payment_sessions")
          .select(
            "id, trip_id, captured_amount_pence, refunded_amount_pence, status, captured_at, provider_state, payment_method, metadata",
          )
          .in("trip_id", tripIds)
        : Promise.resolve({ data: [] as Record<string, unknown>[] }),
      ledgerIds.length > 0
        ? supabase
          .from("driver_earning_settlement")
          .select(
            "id, ledger_entry_id, trip_id, settlement_status, settlement_lifecycle_status, eligible_for_payout, allocated_to_payout, allocated_amount_pence, paid_in_batch_id, paid_in_payout_item_id, settled_at, provider_available_on, capture_time",
          )
          .in("ledger_entry_id", ledgerIds)
        : Promise.resolve({ data: [] as Record<string, unknown>[] }),
      ledgerIds.length > 0
        ? supabase
          .from("payout_item_ledger_allocations")
          .select("ledger_entry_id, amount_pence, payout_item_id")
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
        .select("id, trip_id, captured_amount_pence, refunded_amount_pence, status, captured_at, provider_state, payment_method, metadata")
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

    const allocItemIds = [...new Set(
      (allocRes.data ?? [])
        .map((a) => String((a as { payout_item_id?: string | null }).payout_item_id ?? ""))
        .filter(Boolean),
    )];
    const allocItemById = new Map<string, { status?: string; execution_status?: string | null }>();
    if (allocItemIds.length > 0) {
      const { data: allocItems } = await supabase
        .from("payout_items")
        .select("id, status, execution_status")
        .in("id", allocItemIds);
      for (const it of allocItems ?? []) {
        allocItemById.set(String(it.id), it as { status?: string; execution_status?: string | null });
      }
    }

    for (const a of allocRes.data ?? []) {
      const itemId = String((a as { payout_item_id?: string | null }).payout_item_id ?? "");
      const item = itemId ? allocItemById.get(itemId) : null;
      if (item && payoutItemStatusReleasesLedgerAllocation(item.status, item.execution_status)) {
        continue;
      }
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
    const ledgerType = String(row.type ?? "").toUpperCase();
    const rowMetadata = (row as { metadata?: Record<string, unknown> | null }).metadata;
    const adminWalletPayoutEligible = ledgerType === "ADMIN_WALLET_CREDIT"
      ? rowMetadata?.payout_eligible !== false
      : null;
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

    const sessionMeta = session?.metadata && typeof session.metadata === "object"
      ? session.metadata as Record<string, unknown>
      : null;
    const firstCapturedAt = sessionMeta?.first_captured_at
      ? String(sessionMeta.first_captured_at)
      : null;

    return {
      ledger_entry_id: String(row.id),
      trip_id: tripId,
      ledger_type: ledgerType,
      amount_pence: Math.max(0, Number(row.amount_pence ?? 0)),
      admin_wallet_payout_eligible: adminWalletPayoutEligible,
      trip_exists: Boolean(trip),
      trip_status: trip?.status ? String(trip.status) : null,
      trip_cancelled: Boolean(trip?.cancelled_at),
      completed_at: trip?.completed_at ? String(trip.completed_at) : null,
      session_status: session?.status ? String(session.status) : null,
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
      allocated_to_payout: des?.allocated_to_payout === true
        || allocated >= Math.max(0, Number(row.amount_pence ?? 0)),
      allocated_amount_pence: allocated,
      paid_in_batch_id: (des?.paid_in_batch_id as string | null) ?? null,
      paid_in_payout_item_id: (des?.paid_in_payout_item_id as string | null) ?? null,
      payout_processing: lifecycle === "INCLUDED_IN_PAYOUT" && !des?.paid_in_payout_item_id,
      des_present: Boolean(des),
      des_eligible_for_payout: des?.eligible_for_payout === true,
      payment_collection_model: trip?.payment_collection_model
        ? String(trip.payment_collection_model)
        : null,
      financial_model: trip?.financial_model ? String(trip.financial_model) : null,
      payment_method: trip?.payment_method
        ? String(trip.payment_method)
        : (session?.payment_method ? String(session.payment_method) : null),
      provider_available_on: (des?.provider_available_on as string | null)
        ?? (trip?.provider_available_on as string | null)
        ?? null,
      settled_at: (des?.settled_at as string | null) ?? null,
      des_settlement_status: des?.settlement_status ? String(des.settlement_status) : null,
      provider_state: session?.provider_state ? String(session.provider_state) : null,
      captured_at: (session?.captured_at as string | null) ?? null,
      first_captured_at: firstCapturedAt,
      capture_time: (des?.capture_time as string | null) ?? null,
      trip_completed_at: trip?.completed_at ? String(trip.completed_at) : null,
      earning_credited_at: (row as { created_at?: string | null }).created_at ?? null,
    };
  });

  const settingsMap = new Map<string, unknown>();
  for (const row of settingsRes.data ?? []) {
    settingsMap.set(String(row.setting_key), row.setting_value);
  }

  const globalPayoutsRaw = settingsMap.get("payouts_enabled");
  const globalPayoutsEnabled = String(globalPayoutsRaw ?? "true").toLowerCase() !== "false"
    && globalPayoutsRaw !== false;

  let clearingDelayHours = DEFAULT_PAYOUT_CLEARING_DELAY_HOURS;
  const delayRaw = settingsMap.get("payout_clearing_delay_hours");
  const parsedDelay = typeof delayRaw === "number"
    ? delayRaw
    : Number(String(delayRaw ?? "").replace(/^"+|"+$/g, ""));
  if (Number.isFinite(parsedDelay) && parsedDelay >= 0) {
    clearingDelayHours = parsedDelay;
  }

  const dest = Array.isArray(destinationRes.data) ? destinationRes.data[0] : null;
  const link = String(dest?.provider_link_status ?? dest?.verification_status ?? "").toUpperCase();
  const accountVerified = Boolean(
    dest
    && dest.is_active !== false
    && !dest.archived_at
    && link === "PROVIDER_VERIFIED"
    && dest.provider_counterparty_id
    && dest.provider_recipient_account_id,
  );

  const operationalPaused = driverRes.data?.payout_operational_paused === true;
  // Deprecated diagnostic — never a gate.
  const legacyPayoutsEnabled = driverRes.data?.payouts_enabled !== false;

  const approval = String(driverRes.data?.approval_status ?? "").toLowerCase();
  const driverApproved = approval === "approved" || approval === "active";
  const status = String(driverRes.data?.driver_status ?? "").toLowerCase();
  const driverSuspended = ["disabled", "deleted", "suspended", "banned", "blocked", "inactive"]
    .includes(status);

  const feeRaw = settingsMap.get("early_cashout_fee_pence");
  const feePence = Math.max(
    0,
    Math.round(
      typeof feeRaw === "number"
        ? feeRaw
        : Number(String(feeRaw ?? "50").replace(/^"+|"+$/g, "")) || 50,
    ),
  );

  const eligibility = aggregateDriverPayoutEligibility({
    live_balance_pence: live,
    outstanding_debt_pence: debt,
    in_flight_cashout_pence: inFlight,
    reserved_payout_pence: reservedPayout,
    payout_operational_paused: operationalPaused,
    payouts_enabled: legacyPayoutsEnabled,
    payout_provider_available: true,
    account_verified: accountVerified,
    clearing_policy: { clearing_delay_hours: clearingDelayHours },
    entries,
  });

  return {
    eligibility,
    global_payouts_enabled: globalPayoutsEnabled,
    payout_operational_paused: operationalPaused,
    provider_verified_active_destination: accountVerified,
    driver_approved: driverApproved,
    driver_suspended: driverSuspended,
    legacy_payouts_enabled: driverRes.data?.payouts_enabled ?? null,
    active_destination_last4: resolveActiveDestinationLast4(dest),
    fee_pence: feePence,
  };
}

export async function fetchDriverPayoutEligibility(
  supabase: SupabaseClient,
  args: {
    driver_id: string;
    service_area_id?: string | null;
    as_of?: string | null;
  },
): Promise<DriverPayoutEligibilityResult> {
  const ctx = await fetchDriverPayoutEligibilityContext(supabase, args);
  return ctx.eligibility;
}
