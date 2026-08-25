/**
 * Step 9.3B — one-time MK-260817-008 TEN recovery from accepted-offer evidence (609p).
 * Never updates trips / Payment Sessions / stamps. Delete after verification.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { creditCapturedCardTripLedger } from "./onecabFinanceLedger.ts";
import { sessionLooksCaptured } from "./missingTripEarningNetDetectSSOT.ts";

export const MK008_TRIP_ID = "3b48b86c-9ebf-407e-bb8b-a51ad2e75edc";
export const MK008_TRIP_CODE = "MK-260817-008";
export const MK008_DRIVER_ID = "cd8bae4c-3827-4b90-98c6-10be70eb0e52";
export const MK008_OFFER_ID = "f28e4e06-b1f8-487a-9ae9-3e70178b2133";
export const MK008_APPROVED_PENCE = 609;
export const CONFIRM_EXECUTE_PHRASE = "CREDIT_MK008_ACCEPTED_OFFER_EARNINGS_609P";

export const LIVE_EXECUTION_DISABLED = "LIVE_EXECUTION_DISABLED";
export const ALLOWLIST_VIOLATION = "ALLOWLIST_VIOLATION";
export const RECOVERY_PRECONDITION_FAILED = "RECOVERY_PRECONDITION_FAILED";

export function isApprovedLiveExecute(body: Record<string, unknown>): boolean {
  return body.dry_run === false && body.confirm_execute === CONFIRM_EXECUTE_PHRASE;
}

export function isLiveExecutionRequest(body: Record<string, unknown>): boolean {
  if (isApprovedLiveExecute(body)) return false;
  if (body.dry_run === false) return true;
  if (body.confirm != null || body.confirm_execute != null) return true;
  if (body.execute === true || body.credit === true || body.insert_ten === true) return true;
  return false;
}

export function gateExactMk008TripId(tripIds: unknown):
  | { ok: true; trip_id: string }
  | { ok: false; error: typeof ALLOWLIST_VIOLATION; message: string } {
  if (!Array.isArray(tripIds) || tripIds.length !== 1) {
    return { ok: false, error: ALLOWLIST_VIOLATION, message: "trip_ids must be exactly [MK-008 UUID]" };
  }
  const id = String(tripIds[0] ?? "");
  if (id !== MK008_TRIP_ID) {
    return { ok: false, error: ALLOWLIST_VIOLATION, message: "only MK-260817-008 UUID is allow-listed" };
  }
  return { ok: true, trip_id: id };
}

async function readTenRows(supabase: SupabaseClient, tripId: string) {
  const { data, error } = await supabase
    .from("driver_wallet_ledger")
    .select("id, driver_id, amount_pence, created_at")
    .eq("related_trip_id", tripId)
    .eq("type", "TRIP_EARNING_NET");
  if (error) throw error;
  return (data ?? []).map((r) => ({
    id: String(r.id),
    driver_id: String(r.driver_id),
    amount_pence: Math.round(Number(r.amount_pence) || 0),
    created_at: String(r.created_at),
  }));
}

/** Re-read immutable evidence; never writes trips/PS. */
export async function evaluateMk008DryRun(supabase: SupabaseClient): Promise<
  | {
    ok: true;
    trip_id: string;
    trip_code: string;
    driver_id: string;
    classification: "DRY_RUN_ELIGIBLE";
    entitlement_pence: number;
    offer_id: string;
    economic_earned_at: string;
    existing_ten_count: number;
    provider_operation_required: false;
    settlement_recalculation_required: false;
    trip_stamp_mutation: "NONE";
    payment_session_mutation: "NONE";
  }
  | { ok: false; error: string; message: string }
> {
  const { data: trip, error: tErr } = await supabase
    .from("trips")
    .select("id, trip_code, driver_id, financial_model, status, driver_net_pence, accepted_ride_offer_id")
    .eq("id", MK008_TRIP_ID)
    .maybeSingle();
  if (tErr || !trip) {
    return { ok: false, error: RECOVERY_PRECONDITION_FAILED, message: "trip missing" };
  }
  if (String(trip.trip_code) !== MK008_TRIP_CODE) {
    return { ok: false, error: RECOVERY_PRECONDITION_FAILED, message: "trip_code mismatch" };
  }
  if (String(trip.driver_id) !== MK008_DRIVER_ID) {
    return { ok: false, error: RECOVERY_PRECONDITION_FAILED, message: "driver mismatch" };
  }
  if (String(trip.financial_model) !== "PLATFORM_COLLECTED" || String(trip.status) !== "completed") {
    return { ok: false, error: RECOVERY_PRECONDITION_FAILED, message: "model/status" };
  }

  const { data: sessions, error: pErr } = await supabase
    .from("payment_sessions")
    .select(
      "id, status, provider_state, provider_order_id, provider_capture_id, captured_amount_pence, captured_at, financial_operation_state, released_amount_pence, refunded_amount_pence",
    )
    .eq("trip_id", MK008_TRIP_ID)
    .eq("purpose", "RIDE_BOOKING");
  if (pErr || !sessions || sessions.length !== 1) {
    return { ok: false, error: RECOVERY_PRECONDITION_FAILED, message: "need exactly one RIDE_BOOKING" };
  }
  const ps = sessions[0];
  if (!sessionLooksCaptured(ps as never)) {
    return { ok: false, error: RECOVERY_PRECONDITION_FAILED, message: "capture not verified" };
  }

  const { data: offer, error: oErr } = await supabase
    .from("ride_offers")
    .select("id, trip_id, driver_id, status, offered_driver_net_pence, offer_snapshot")
    .eq("id", MK008_OFFER_ID)
    .maybeSingle();
  if (oErr || !offer) {
    return { ok: false, error: RECOVERY_PRECONDITION_FAILED, message: "accepted offer missing" };
  }
  if (String(offer.trip_id) !== MK008_TRIP_ID || String(offer.driver_id) !== MK008_DRIVER_ID) {
    return { ok: false, error: RECOVERY_PRECONDITION_FAILED, message: "offer linkage" };
  }
  if (String(offer.status).toLowerCase() !== "accepted") {
    return { ok: false, error: RECOVERY_PRECONDITION_FAILED, message: "offer not accepted" };
  }
  const net = Math.round(Number(offer.offered_driver_net_pence) || 0);
  const snapNet = Math.round(Number((offer.offer_snapshot as { offered_driver_net_pence?: number } | null)?.offered_driver_net_pence) || 0);
  if (net !== MK008_APPROVED_PENCE || (snapNet > 0 && snapNet !== MK008_APPROVED_PENCE)) {
    return { ok: false, error: RECOVERY_PRECONDITION_FAILED, message: `offer net ${net}/${snapNet} != ${MK008_APPROVED_PENCE}` };
  }

  const tens = await readTenRows(supabase, MK008_TRIP_ID);
  if (tens.length > 0) {
    return { ok: false, error: RECOVERY_PRECONDITION_FAILED, message: `TEN already exists count=${tens.length}` };
  }

  return {
    ok: true,
    trip_id: MK008_TRIP_ID,
    trip_code: MK008_TRIP_CODE,
    driver_id: MK008_DRIVER_ID,
    classification: "DRY_RUN_ELIGIBLE",
    entitlement_pence: MK008_APPROVED_PENCE,
    offer_id: MK008_OFFER_ID,
    economic_earned_at: String(ps.captured_at),
    existing_ten_count: 0,
    provider_operation_required: false,
    settlement_recalculation_required: false,
    trip_stamp_mutation: "NONE",
    payment_session_mutation: "NONE",
  };
}

export async function creditMk008Once(supabase: SupabaseClient): Promise<{
  status: "CREDITED" | "ALREADY_CREDITED" | "CREDIT_FAILED" | "CREDIT_CONFLICT";
  credited_pence: number;
  ten_count: number;
  posting_created_at: string | null;
  economic_earned_at: string | null;
  error?: string;
}> {
  const dry = await evaluateMk008DryRun(supabase);
  if (!dry.ok) {
    const rows = await readTenRows(supabase, MK008_TRIP_ID).catch(() => []);
    if (
      rows.length === 1 &&
      rows[0].amount_pence === MK008_APPROVED_PENCE &&
      rows[0].driver_id === MK008_DRIVER_ID
    ) {
      return {
        status: "ALREADY_CREDITED",
        credited_pence: 0,
        ten_count: 1,
        posting_created_at: rows[0].created_at,
        economic_earned_at: null,
      };
    }
    if (rows.length >= 1) {
      return {
        status: "CREDIT_CONFLICT",
        credited_pence: 0,
        ten_count: rows.length,
        posting_created_at: rows[0]?.created_at ?? null,
        economic_earned_at: null,
        error: dry.message,
      };
    }
    return {
      status: "CREDIT_FAILED",
      credited_pence: 0,
      ten_count: 0,
      posting_created_at: null,
      economic_earned_at: null,
      error: dry.message,
    };
  }

  try {
    await creditCapturedCardTripLedger(supabase, {
      driverId: MK008_DRIVER_ID,
      tripId: MK008_TRIP_ID,
      driverNetPence: MK008_APPROVED_PENCE,
      tipPence: 0,
      currency: "GBP",
      paymentId: null,
    });
    const after = await readTenRows(supabase, MK008_TRIP_ID);
    if (
      after.length === 1 &&
      after[0].amount_pence === MK008_APPROVED_PENCE &&
      after[0].driver_id === MK008_DRIVER_ID
    ) {
      return {
        status: "CREDITED",
        credited_pence: MK008_APPROVED_PENCE,
        ten_count: 1,
        posting_created_at: after[0].created_at,
        economic_earned_at: dry.economic_earned_at,
      };
    }
    return {
      status: "CREDIT_CONFLICT",
      credited_pence: 0,
      ten_count: after.length,
      posting_created_at: after[0]?.created_at ?? null,
      economic_earned_at: dry.economic_earned_at,
      error: "post-credit readback mismatch",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: string })?.code;
    if (code === "23505" || /duplicate|unique/i.test(message)) {
      const rows = await readTenRows(supabase, MK008_TRIP_ID).catch(() => []);
      if (
        rows.length === 1 &&
        rows[0].amount_pence === MK008_APPROVED_PENCE &&
        rows[0].driver_id === MK008_DRIVER_ID
      ) {
        return {
          status: "ALREADY_CREDITED",
          credited_pence: 0,
          ten_count: 1,
          posting_created_at: rows[0].created_at,
          economic_earned_at: dry.economic_earned_at,
        };
      }
    }
    return {
      status: "CREDIT_FAILED",
      credited_pence: 0,
      ten_count: 0,
      posting_created_at: null,
      economic_earned_at: dry.economic_earned_at,
      error: message,
    };
  }
}
