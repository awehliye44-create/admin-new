/**
 * Booking trip finalization entry point — the ONE caller-side wrapper around
 * public.finalize_paid_booking_session. All trip-creation business rules live in
 * that RPC; revolut-webhook, create-preauth-payment-intent and
 * confirm-revolut-payment only decide WHEN to invoke it.
 *
 * Direct finalize (create-preauth / confirm) runs only after a provider read in the
 * same request proved the order AUTHORISED with authorised total >= the session hold.
 * It never writes payment state on failure — the webhook / CTAP paths stay the fallback.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { revolutProviderAuthorisedTotalPence, type RevolutOrder } from "./revolutOrders.ts";
import { isRevolutBookingPreauthHoldState } from "./revolutPaymentConfirmation.ts";

/**
 * provider_state_verified_by values written only when the caller has just read the
 * Revolut order as AUTHORISED with authorised total covering the full session hold.
 * create-trip-after-payment may trust these (fresh) without a second provider GET.
 */
export const PROVIDER_READ_AUTHORISED_VERIFIERS = [
  "create_preauth_provider_read",
  "confirm_provider_read",
] as const;
export type ProviderReadAuthorisedVerifier = typeof PROVIDER_READ_AUTHORISED_VERIFIERS[number];

export function isProviderReadAuthorisedVerifier(value: unknown): value is ProviderReadAuthorisedVerifier {
  return (PROVIDER_READ_AUTHORISED_VERIFIERS as readonly string[]).includes(String(value ?? ""));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

/**
 * Never auto-finalise superseded / orphaned / already-trip sessions.
 * Shared verbatim by revolut-webhook and direct finalize.
 */
export function classifyAutoFinalizeSession(session: {
  trip_id?: unknown;
  status?: unknown;
  metadata?: unknown;
}): { eligible: boolean; alreadyOrphaned: boolean } {
  const sessionStatus = String(session.status ?? "").toLowerCase();
  const meta = asRecord(session.metadata);
  const alreadyOrphaned =
    sessionStatus === "payment_orphaned" ||
    sessionStatus === "orphan_authorisation" ||
    meta.orphan_reason === "CUSTOMER_ALREADY_HAS_ACTIVE_TRIP" ||
    meta.never_capture === true;
  const eligible =
    !session.trip_id &&
    !alreadyOrphaned &&
    !["cancelled", "failed", "released"].includes(sessionStatus);
  return { eligible, alreadyOrphaned };
}

/** True when a provider-read Revolut order is AUTHORISED and covers the full hold (fare + buffer). */
export function providerOrderCoversHold(
  order: RevolutOrder | null | undefined,
  requiredHoldPence: number,
): boolean {
  if (!order || !isRevolutBookingPreauthHoldState(order.state)) return false;
  const required = Math.round(Number(requiredHoldPence));
  if (!Number.isFinite(required) || required <= 0) return false;
  return revolutProviderAuthorisedTotalPence(order) >= required;
}

/** The single invocation of the finalize RPC. */
export async function invokeFinalizePaidBookingSession(
  supabase: SupabaseClient,
  paymentSessionId: string,
): Promise<{ data: string | null; error: { message: string } | null }> {
  const { data, error } = await supabase.rpc("finalize_paid_booking_session", {
    p_payment_session_id: paymentSessionId,
  });
  return {
    data: typeof data === "string" ? data : null,
    error: error ? { message: String(error.message ?? error) } : null,
  };
}

export type SameBookingTripIdentity = {
  id?: unknown;
  client_action_id?: unknown;
  payment_session_id?: unknown;
  payment_provider?: unknown;
  provider_order_id?: unknown;
  passenger_id?: unknown;
};

export type SameBookingSessionIdentity = {
  id?: unknown;
  client_action_id?: unknown;
  payment_provider?: unknown;
  provider_order_id?: unknown;
  customer_id?: unknown;
};

/**
 * Mirrors the RPC's same-booking adoption rule: every canonical identifier must match.
 * A trip that matches only some identifiers is a different booking.
 */
export function isSameBookingTrip(
  trip: SameBookingTripIdentity | null | undefined,
  session: SameBookingSessionIdentity | null | undefined,
): boolean {
  if (!trip || !session) return false;
  const eq = (a: unknown, b: unknown) =>
    a != null && b != null && String(a).trim() !== "" && String(a) === String(b);
  return (
    eq(trip.payment_session_id, session.id) &&
    eq(trip.client_action_id, session.client_action_id) &&
    eq(trip.payment_provider, session.payment_provider) &&
    eq(trip.provider_order_id, session.provider_order_id) &&
    eq(trip.passenger_id, session.customer_id)
  );
}

/**
 * Webhook guard for CUSTOMER_ALREADY_HAS_ACTIVE_TRIP:<id>. When <id> is this same booking,
 * link it (if not yet linked) and report it — the caller must then never orphan or cancel.
 * Returns the trip id for the same booking (even if the link write failed), else null.
 */
export async function linkSameBookingTripIfMatch(
  supabase: SupabaseClient,
  session: SameBookingSessionIdentity & { id: string },
  tripId: string,
  nowIso: string,
  log: (msg: string, details?: unknown) => void = (msg, details) => console.warn(msg, details ?? {}),
): Promise<string | null> {
  const { data: trip, error: tripErr } = await supabase
    .from("trips")
    .select("id, client_action_id, payment_session_id, payment_provider, provider_order_id, passenger_id")
    .eq("id", tripId)
    .maybeSingle();
  if (tripErr || !isSameBookingTrip(trip as SameBookingTripIdentity | null, session)) return null;
  const { error: linkErr } = await supabase
    .from("payment_sessions")
    .update({ trip_id: tripId, status: "trip_created", updated_at: nowIso })
    .eq("id", session.id)
    .is("trip_id", null);
  if (linkErr) {
    log("[same-booking] session link failed — trip kept, no orphan/cancel", {
      session_id: session.id,
      trip_id: tripId,
      error: linkErr.message,
    });
  }
  return tripId;
}

export type DirectFinalizeResult =
  | { finalized: true; tripId: string; tripCode: string | null; via: "rpc" | "existing"; ms: number }
  | { finalized: false; reason: string; ms: number };

const DIRECT_FINALIZE_SESSION_COLUMNS =
  "id, trip_id, status, metadata, purpose, provider_state, provider_order_id, client_action_id, user_id, customer_id, payment_provider, authorised_amount_pence";

/**
 * Create the trip in the same request that proved AUTHORISED. Never throws and never
 * mutates payment state when it declines or the RPC fails.
 */
export async function directFinalizeAfterProviderAuthorised(
  supabase: SupabaseClient,
  args: {
    clientActionId: string | null | undefined;
    providerOrderId: string;
    order: RevolutOrder | null | undefined;
    userId: string | null | undefined;
    logStep?: (step: string, details?: unknown) => void;
  },
): Promise<DirectFinalizeResult> {
  const started = Date.now();
  const done = (reason: string): DirectFinalizeResult => {
    const result = { finalized: false as const, reason, ms: Date.now() - started };
    args.logStep?.("DIRECT_FINALIZE_SKIPPED", {
      reason,
      provider_order_id: args.providerOrderId,
      client_action_id: args.clientActionId ?? null,
      ms: result.ms,
    });
    return result;
  };
  try {
    const clientActionId = String(args.clientActionId ?? "").trim();
    if (!clientActionId) return done("no_client_action_id");
    if (!args.userId) return done("no_user");
    const order = args.order;
    if (!order || order.id !== args.providerOrderId) return done("order_mismatch");
    if (!isRevolutBookingPreauthHoldState(order.state)) return done("order_not_authorised");
    const orderCai = order.metadata?.client_action_id;
    if (orderCai && orderCai !== clientActionId) return done("order_client_action_mismatch");

    const { data: session, error: sessionErr } = await supabase
      .from("payment_sessions")
      .select(DIRECT_FINALIZE_SESSION_COLUMNS)
      .eq("client_action_id", clientActionId)
      .maybeSingle();
    if (sessionErr || !session) return done("session_missing");
    const s = session as Record<string, unknown>;
    if (String(s.purpose ?? "RIDE_BOOKING") !== "RIDE_BOOKING") return done("session_not_ride_booking");
    if (String(s.provider_order_id ?? "") !== args.providerOrderId) return done("session_order_mismatch");
    if (String(s.user_id ?? "") !== String(args.userId)) return done("session_user_mismatch");
    if (String(s.provider_state ?? "").toUpperCase() !== "AUTHORISED") return done("session_not_authorised");
    if (!providerOrderCoversHold(order, Number(s.authorised_amount_pence ?? 0))) {
      return done("provider_amount_below_hold");
    }

    const loadTripCode = async (tripId: string) => {
      const { data: trip } = await supabase
        .from("trips")
        .select("id, trip_code")
        .eq("id", tripId)
        .maybeSingle();
      return (trip as { trip_code?: string | null } | null)?.trip_code ?? null;
    };

    if (s.trip_id) {
      const tripId = String(s.trip_id);
      const tripCode = await loadTripCode(tripId);
      const ms = Date.now() - started;
      args.logStep?.("DIRECT_FINALIZE_EXISTING", { trip_id: tripId, provider_order_id: args.providerOrderId, ms });
      return { finalized: true, tripId, tripCode, via: "existing", ms };
    }
    if (!classifyAutoFinalizeSession(s).eligible) return done("session_not_eligible");

    const { data: tripId, error } = await invokeFinalizePaidBookingSession(supabase, String(s.id));
    if (error || !tripId) {
      // Message carries no payment data; never act on it here (webhook/CTAP own recovery).
      return done(`rpc_error:${String(error?.message ?? "no_trip").slice(0, 120)}`);
    }
    const tripCode = await loadTripCode(tripId);
    const ms = Date.now() - started;
    args.logStep?.("DIRECT_FINALIZE_OK", { trip_id: tripId, provider_order_id: args.providerOrderId, ms });
    return { finalized: true, tripId, tripCode, via: "rpc", ms };
  } catch (err) {
    return done(`exception:${String(err instanceof Error ? err.message : err).slice(0, 120)}`);
  }
}

/** Response fields for a finalized trip (additive; older Customer builds ignore them). */
export function directFinalizeResponseFields(result: DirectFinalizeResult | null): Record<string, unknown> {
  if (!result) return {};
  if (!result.finalized) {
    return { trip_finalized: false, direct_finalize_ms: result.ms };
  }
  return {
    trip_finalized: true,
    ride_id: result.tripId,
    trip_code: result.tripCode,
    trip_reference: result.tripCode,
    direct_finalize_ms: result.ms,
  };
}
