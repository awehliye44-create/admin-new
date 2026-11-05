/**
 * MK-261105-002 — handle lost payment authorisation on a live trip.
 * Pre-start: cancel the booking (no fee).
 * After trip started: keep journey active, block further mods, flag support
 * recovery, allow driver completion with payment unresolved.
 * Acknowledgement / push must never delay this path.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { revokePendingOffersForTerminalTrip } from "./tripTerminalDispatch.ts";
import { disposeTerminalTripPayment } from "./terminalTripPaymentDisposition.ts";
import { upsertCustomerPaymentFailureNotice } from "./customerPaymentFailureNoticeSSOT.ts";
import { notifyCustomerTripLifecycle } from "./customerTripLifecycleNotify.ts";
import {
  isStartedTripStatus,
  lostAuthCustomerCopyForTripStatus,
  MID_TRIP_AUTH_LOST_FLAG,
} from "./modificationHoldLivenessSSOT.ts";

const TERMINAL = new Set([
  "cancelled",
  "canceled",
  "completed",
  "no_show",
  "failed",
  "expired",
  "discarded",
]);

const VALID_PROVIDER = new Set(["AUTHORISED", "AUTHORIZED", "COMPLETED"]);

export type LostAuthCancelResult = {
  ok: boolean;
  action:
    | "cancelled"
    | "flagged_recovery"
    | "already_terminal"
    | "superseded"
    | "not_current_auth"
    | "skipped"
    | "failed";
  trip_id: string;
  reason?: string;
};

function norm(v: unknown): string {
  return String(v ?? "").trim();
}

export function isCurrentTripPaymentAuthorisation(args: {
  tripPaymentSessionId?: string | null;
  tripProviderOrderId?: string | null;
  cancelledSessionId?: string | null;
  cancelledProviderOrderId?: string | null;
}): boolean {
  const tripSession = norm(args.tripPaymentSessionId);
  const cancelledSession = norm(args.cancelledSessionId);
  if (tripSession && cancelledSession && tripSession === cancelledSession) return true;

  const tripOrder = norm(args.tripProviderOrderId);
  const cancelledOrder = norm(args.cancelledProviderOrderId);
  if (tripOrder && cancelledOrder && tripOrder === cancelledOrder) return true;

  return false;
}

export async function tripHasNewerValidAuthorisation(
  supabase: SupabaseClient,
  args: {
    tripId: string;
    excludeSessionId?: string | null;
    excludeProviderOrderId?: string | null;
  },
): Promise<boolean> {
  const { data: rows } = await supabase
    .from("payment_sessions")
    .select("id, provider_order_id, provider_state, status, hold_release_state")
    .eq("trip_id", args.tripId)
    .eq("purpose", "RIDE_BOOKING")
    .limit(20);

  for (const row of rows ?? []) {
    const id = norm(row.id);
    const orderId = norm(row.provider_order_id);
    if (args.excludeSessionId && id === norm(args.excludeSessionId)) continue;
    if (args.excludeProviderOrderId && orderId === norm(args.excludeProviderOrderId)) continue;
    const provider = String(row.provider_state ?? "").toUpperCase();
    const status = String(row.status ?? "").toLowerCase();
    const hold = String(row.hold_release_state ?? "").toLowerCase();
    if (!VALID_PROVIDER.has(provider)) continue;
    if (["cancelled", "canceled", "failed", "expired", "abandoned", "payment_orphaned", "released"].includes(status)) {
      continue;
    }
    if (hold === "released" || hold === "releasing") continue;
    return true;
  }
  return false;
}

async function expireOpenTripChangeRequests(
  supabase: SupabaseClient,
  tripId: string,
  nowIso: string,
): Promise<void> {
  await supabase
    .from("trip_change_requests")
    .update({
      status: "expired",
      payment_status: "failed",
      rejection_reason: "mid_trip_payment_auth_lost",
      updated_at: nowIso,
    })
    .eq("trip_id", tripId)
    .in("status", [
      "payment_required",
      "payment_pending",
      "payment_confirmed",
      "pending_driver_approval",
      "approved",
    ]);
}

async function flagStartedTripForPaymentRecovery(
  supabase: SupabaseClient,
  args: {
    trip: Record<string, unknown>;
    tripId: string;
    paymentSessionId?: string | null;
    providerOrderId?: string | null;
    source: string;
    nowIso: string;
  },
): Promise<LostAuthCancelResult> {
  const { trip, tripId, nowIso } = args;
  const existingMeta = trip.metadata && typeof trip.metadata === "object"
    ? trip.metadata as Record<string, unknown>
    : {};

  const { data: updated, error: updErr } = await supabase
    .from("trips")
    .update({
      payment_status: "recovery_required",
      payment_hold_status: "payment_shortfall",
      payment_coverage_status: "recovery_required",
      metadata: {
        ...existingMeta,
        [MID_TRIP_AUTH_LOST_FLAG]: true,
        mid_trip_payment_auth_lost_at: nowIso,
        mid_trip_payment_auth_lost_source: args.source,
      },
      updated_at: nowIso,
    })
    .eq("id", tripId)
    .is("cancelled_at", null)
    .not("status", "in", "(cancelled,canceled,completed,no_show,failed,expired,discarded)")
    .select("id")
    .maybeSingle();

  if (updErr) {
    return { ok: false, action: "failed", trip_id: tripId, reason: updErr.message };
  }
  if (!updated?.id) {
    return { ok: true, action: "already_terminal", trip_id: tripId };
  }

  await expireOpenTripChangeRequests(supabase, tripId, nowIso);

  try {
    await supabase.from("ops_alerts").insert({
      fingerprint: `mid_trip_payment_auth_lost:${tripId}`,
      category: "payment",
      severity: "critical",
      status: "open",
      source: "system",
      app: "backend",
      title: "Mid-trip payment hold lost — support recovery required",
      description:
        "The Revolut pre-authorisation was lost after the trip started. "
        + "Journey stays active; further trip changes are blocked; driver may complete; "
        + "payment remains unresolved for support recovery.",
      related_trip_id: tripId,
      related_entity_type: "payment_session",
      related_entity_id: args.paymentSessionId ?? (trip.payment_session_id as string | null) ?? null,
      metadata: {
        provider_order_id: args.providerOrderId ?? trip.provider_order_id ?? null,
        payment_session_id: args.paymentSessionId ?? trip.payment_session_id ?? null,
        source: args.source,
        trip_status: trip.status ?? null,
        [MID_TRIP_AUTH_LOST_FLAG]: true,
      },
    });
  } catch (err) {
    console.warn("[lostPaymentAuthorisation] ops_alert insert failed", err);
  }

  await supabase.from("admin_payment_audit").insert({
    action: "trip_flagged_payment_auth_lost_mid_trip",
    provider: "revolut",
    provider_payment_id: args.providerOrderId ?? trip.provider_order_id ?? null,
    trip_id: tripId,
    metadata: {
      source: args.source,
      payment_session_id: args.paymentSessionId ?? null,
      trip_status: trip.status ?? null,
      payment_status: "recovery_required",
      payment_hold_status: "payment_shortfall",
      journey_kept_active: true,
      modifications_blocked: true,
      completion_allowed_unresolved: true,
    },
  }).then(({ error }) => {
    if (error) console.warn("[lostPaymentAuthorisation] audit insert failed", error.message);
  });

  return { ok: true, action: "flagged_recovery", trip_id: tripId };
}

export async function cancelTripForLostPaymentAuthorisation(
  supabase: SupabaseClient,
  args: {
    tripId: string;
    providerOrderId?: string | null;
    paymentSessionId?: string | null;
    source: string;
  },
): Promise<LostAuthCancelResult> {
  const tripId = norm(args.tripId);
  if (!tripId) {
    return { ok: false, action: "failed", trip_id: "", reason: "missing_trip_id" };
  }

  const { data: trip, error: tripErr } = await supabase
    .from("trips")
    .select(
      "id, status, passenger_id, payment_session_id, provider_order_id, payment_status, payment_hold_status, cancelled_at, financial_model, metadata",
    )
    .eq("id", tripId)
    .maybeSingle();

  if (tripErr || !trip) {
    return {
      ok: false,
      action: "failed",
      trip_id: tripId,
      reason: tripErr?.message ?? "trip_not_found",
    };
  }

  const status = String(trip.status ?? "").toLowerCase();
  if (TERMINAL.has(status) || trip.cancelled_at) {
    return { ok: true, action: "already_terminal", trip_id: tripId };
  }

  if (
    !isCurrentTripPaymentAuthorisation({
      tripPaymentSessionId: trip.payment_session_id as string | null,
      tripProviderOrderId: trip.provider_order_id as string | null,
      cancelledSessionId: args.paymentSessionId,
      cancelledProviderOrderId: args.providerOrderId,
    })
  ) {
    return { ok: true, action: "not_current_auth", trip_id: tripId };
  }

  if (args.paymentSessionId) {
    const { data: lostSession } = await supabase
      .from("payment_sessions")
      .select("id, provider_state, status, hold_release_state")
      .eq("id", args.paymentSessionId)
      .maybeSingle();
    const provider = String(lostSession?.provider_state ?? "").toUpperCase();
    const sessionStatus = String(lostSession?.status ?? "").toLowerCase();
    const hold = String(lostSession?.hold_release_state ?? "").toLowerCase();
    const authLost =
      ["CANCELLED", "CANCELED", "FAILED", "DECLINED", "EXPIRED"].includes(provider)
      || hold === "released"
      || ["cancelled", "canceled", "failed", "released", "payment_orphaned"].includes(sessionStatus);
    if (!authLost) {
      return { ok: true, action: "skipped", trip_id: tripId, reason: "session_still_authorised" };
    }
  }

  if (
    await tripHasNewerValidAuthorisation(supabase, {
      tripId,
      excludeSessionId: args.paymentSessionId,
      excludeProviderOrderId: args.providerOrderId,
    })
  ) {
    return { ok: true, action: "superseded", trip_id: tripId };
  }

  const nowIso = new Date().toISOString();

  // After trip started: keep journey, block mods, flag support — do not cancel.
  if (isStartedTripStatus(status)) {
    return await flagStartedTripForPaymentRecovery(supabase, {
      trip: trip as Record<string, unknown>,
      tripId,
      paymentSessionId: args.paymentSessionId,
      providerOrderId: args.providerOrderId,
      source: args.source,
      nowIso,
    });
  }

  await revokePendingOffersForTerminalTrip(
    supabase as never,
    tripId,
    "payment_auth_cancelled",
  );
  await supabase
    .from("ride_offers")
    .update({
      status: "revoked",
      revoked_reason: "payment_auth_cancelled",
      updated_at: nowIso,
    })
    .eq("trip_id", tripId)
    .in("status", ["pending", "countered", "accepted"]);

  const { data: updated, error: updErr } = await supabase
    .from("trips")
    .update({
      status: "cancelled",
      cancelled_at: nowIso,
      cancelled_by: "system",
      cancellation_reason: "payment_failure",
      cancellation_fee_pence: 0,
      financial_outcome: "CANCELLED_NO_FEE",
      payment_status: "canceled",
      payment_hold_status: "released",
      driver_id: null,
      confirmed_driver_id: null,
      updated_at: nowIso,
    })
    .eq("id", tripId)
    .is("cancelled_at", null)
    .not("status", "in", "(cancelled,canceled,completed,no_show,failed,expired,discarded)")
    .select("id")
    .maybeSingle();

  if (updErr) {
    return { ok: false, action: "failed", trip_id: tripId, reason: updErr.message };
  }
  if (!updated?.id) {
    return { ok: true, action: "already_terminal", trip_id: tripId };
  }

  try {
    await disposeTerminalTripPayment(supabase, {
      tripId,
      reason: "payment_auth_cancelled",
      feePence: 0,
      forceFeePenceOverride: true,
    });
  } catch (err) {
    console.warn("[lostPaymentAuthorisation] dispose failed", {
      tripId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const lostCopy = lostAuthCustomerCopyForTripStatus(status);
  const passengerId = trip.passenger_id ? String(trip.passenger_id) : null;
  if (passengerId) {
    await upsertCustomerPaymentFailureNotice(supabase, {
      passengerId,
      kind: lostCopy.kind,
      tripId,
      clientActionId: null,
      paymentSessionId: args.paymentSessionId ?? (trip.payment_session_id as string | null),
      providerOrderId: args.providerOrderId ?? (trip.provider_order_id as string | null),
      title: lostCopy.title,
      message: lostCopy.message,
    }).catch((err: unknown) => {
      console.warn("[lostPaymentAuthorisation] notice upsert failed", err);
    });

    const { data: customer } = await supabase
      .from("customers")
      .select("user_id")
      .eq("id", passengerId)
      .maybeSingle();
    const userId = customer?.user_id ? String(customer.user_id) : null;
    if (userId) {
      void notifyCustomerTripLifecycle(supabase, {
        tripId,
        userId,
        event: "payment_failed",
        title: lostCopy.title,
        body: lostCopy.message,
        notificationId: `payment_auth_lost-${tripId}`,
      }).catch((err: unknown) => {
        console.warn("[lostPaymentAuthorisation] push failed", err);
      });
    }
  }

  await supabase.from("admin_payment_audit").insert({
    action: "trip_cancelled_payment_auth_lost",
    provider: "revolut",
    provider_payment_id: args.providerOrderId ?? trip.provider_order_id ?? null,
    trip_id: tripId,
    metadata: {
      source: args.source,
      payment_session_id: args.paymentSessionId ?? null,
      cancellation_reason: "payment_failure",
      trip_status_at_cancel: status,
      financial_outcome: "CANCELLED_NO_FEE",
    },
  }).then(({ error }) => {
    if (error) console.warn("[lostPaymentAuthorisation] audit insert failed", error.message);
  });

  return { ok: true, action: "cancelled", trip_id: tripId };
}
