/**
 * MK-261105-002 — cancel a live ride when its current payment authorisation is
 * definitively lost and there is no newer valid replacement.
 * Acknowledgement / push must never delay this path.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { revokePendingOffersForTerminalTrip } from "./tripTerminalDispatch.ts";
import { disposeTerminalTripPayment } from "./terminalTripPaymentDisposition.ts";
import { upsertCustomerPaymentFailureNotice } from "./customerPaymentFailureNoticeSSOT.ts";
import { notifyCustomerTripLifecycle } from "./customerTripLifecycleNotify.ts";
import { lostAuthCustomerCopyForTripStatus } from "./modificationHoldLivenessSSOT.ts";

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
      "id, status, passenger_id, payment_session_id, provider_order_id, payment_status, payment_hold_status, cancelled_at, financial_model",
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

  // Confirm the referenced session is actually lost — do not cancel on a
  // regressive CANCELLED webhook that left provider_state AUTHORISED.
  if (args.paymentSessionId) {
    const { data: lostSession } = await supabase
      .from("payment_sessions")
      .select("id, provider_state, status, hold_release_state")
      .eq("id", args.paymentSessionId)
      .maybeSingle();
    const provider = String(lostSession?.provider_state ?? "").toUpperCase();
    const status = String(lostSession?.status ?? "").toLowerCase();
    const hold = String(lostSession?.hold_release_state ?? "").toLowerCase();
    const authLost =
      ["CANCELLED", "CANCELED", "FAILED", "DECLINED", "EXPIRED"].includes(provider)
      || hold === "released"
      || ["cancelled", "canceled", "failed", "released", "payment_orphaned"].includes(status);
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

  // Revoke outstanding offers immediately — before/parallel to trip cancel.
  await revokePendingOffersForTerminalTrip(
    supabase as never,
    tripId,
    "payment_auth_cancelled",
  );
  // Also revoke countered/accepted like cancel-trip.
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

  // Copy reflects actual trip status (booking vs live trip).
  // FLAG: in-progress currently cancels with CANCELLED_NO_FEE — waiting-time /
  // cancel-fee policy for mid-trip lost-auth needs a separate product decision.
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
      // Heads-up only — never blocks cancel.
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
      in_progress_cancel_policy_needs_decision:
        lostCopy.inProgressCancelPolicyNeedsDecision,
      financial_outcome: "CANCELLED_NO_FEE",
    },
  }).then(({ error }) => {
    if (error) console.warn("[lostPaymentAuthorisation] audit insert failed", error.message);
  });

  return { ok: true, action: "cancelled", trip_id: tripId };
}
