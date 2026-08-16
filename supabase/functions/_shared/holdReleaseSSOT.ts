/**
 * Hold release SSOT for terminal trips (Slice A recovery).
 * Revolut-only hold release. Preserves get-active-trip / expire callers.
 *
 * Session-only release (authorised + no trip) is required when create-trip-after-payment
 * never starts — CTAP's in-function reverse cannot run, and the 5-min trip sweep
 * previously ignored trip_id IS NULL.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  handleRevolutPaymentInvariantViolation,
  releaseRevolutPreauthForTrip,
  resolveRevolutOrderIdFromTrip,
} from "./revolutPreauthReleaseSSOT.ts";
import {
  finalizeBookingAfterPaymentFromSession,
  loadPaymentSession,
  markPaymentSessionReleased,
} from "./paymentSessionSSOT.ts";
import {
  cancelRevolutOrder,
  retrieveRevolutOrder,
} from "./revolutOrders.ts";
import { resolveRevolutMerchantContext } from "./revolutMerchantContext.ts";
export {
  FORCE_SESSION_RELEASE_REASONS,
  sessionAgeMs,
  shouldForceAuthorisedSessionRelease,
  TRIPLESS_AUTHORISED_HOLD_SWEEP_MIN_AGE_MS,
} from "./holdReleasePure.ts";

const CANCELABLE_HOLD_STATES = new Set(["AUTHORISED", "AUTHORIZED", "PROCESSING", "PENDING"]);

const TERMINAL_TRIP_STATUSES = new Set([
  "completed",
  "cancelled",
  "customer_cancelled",
  "driver_cancelled",
  "expired",
  "no_show",
]);

export type HoldReleaseResult = {
  ok: boolean;
  released: boolean;
  skipped?: boolean;
  status: string;
  reason?: string;
  error?: string;
  idempotent?: boolean;
  fee_captured_pence?: number;
};

function sessionAlreadyTerminal(session: Record<string, unknown> | null | undefined): boolean {
  if (!session) return false;
  if (session.released_at || session.captured_at) return true;
  const hold = String(session.hold_release_state ?? "").toLowerCase();
  return hold === "released" || hold === "captured";
}

/**
 * Canonical release for terminal trips (and forced session-only release).
 * Used by get-active-trip when search exhausts / trip expires.
 */
export async function releaseHoldOnTripTerminal(
  supabase: SupabaseClient,
  args: {
    tripId?: string | null;
    terminalReason: string;
    source: string;
    idempotencyKey: string;
    forceRelease?: boolean;
    providerOrderId?: string | null;
    clientActionId?: string | null;
    feePence?: number;
  },
): Promise<HoldReleaseResult> {
  const tripId = args.tripId?.trim() || null;
  let trip: Record<string, unknown> | null = null;

  if (tripId) {
    const { data } = await supabase
      .from("trips")
      .select(
        "id, status, trip_code, payment_provider, provider_order_id, payment_hold_status, payment_status, passenger_id",
      )
      .eq("id", tripId)
      .maybeSingle();
    trip = (data as Record<string, unknown> | null) ?? null;
    if (!trip) {
      return { ok: false, released: false, skipped: true, status: "trip_not_found", reason: "trip_not_found" };
    }
    const tripStatus = String(trip.status ?? "").toLowerCase();
    if (tripStatus === "completed") {
      return {
        ok: true,
        released: false,
        skipped: true,
        status: "trip_completed_no_release",
        reason: "capture_only_after_completion",
        idempotent: true,
      };
    }
    const holdStatus = String(trip.payment_hold_status ?? "").toLowerCase();
    if (holdStatus === "captured" || holdStatus === "released") {
      return { ok: true, released: false, skipped: true, status: holdStatus, idempotent: true };
    }
    if (!args.forceRelease && !TERMINAL_TRIP_STATUSES.has(tripStatus)) {
      return {
        ok: true,
        released: false,
        skipped: true,
        status: "trip_still_active",
        reason: `trip_status_${tripStatus}`,
      };
    }
  }

  const providerOrderId =
    args.providerOrderId?.trim()
    || (trip ? resolveRevolutOrderIdFromTrip(trip) : null)
    || null;

  const session = await loadPaymentSession(supabase, {
    providerOrderId,
    clientActionId: args.clientActionId,
  }).catch(() => null);

  if (sessionAlreadyTerminal(session as Record<string, unknown> | null)) {
    return {
      ok: true,
      released: false,
      skipped: true,
      status: String((session as any)?.released_at ? "released" : "captured"),
      idempotent: true,
    };
  }

  if (!providerOrderId) {
    return {
      ok: false,
      released: false,
      skipped: true,
      status: "skipped",
      reason: "missing_provider_order_id",
    };
  }

  if (!tripId) {
    return releaseHoldForPaymentSession(supabase, {
      providerOrderId,
      clientActionId: args.clientActionId,
      terminalReason: args.terminalReason,
      source: args.source,
      idempotencyKey: args.idempotencyKey,
      session: session as Record<string, unknown> | null,
    });
  }

  const revolutResult = await releaseRevolutPreauthForTrip(supabase, {
    tripId,
    providerOrderId,
    reason: args.terminalReason,
    stage: args.source,
    feePence: args.feePence ?? 0,
    clientActionId: args.clientActionId ?? (session as any)?.client_action_id ?? null,
    idempotencyKey: args.idempotencyKey,
    holdTerminalReason: args.terminalReason,
  });

  if (revolutResult.released) {
    return {
      ok: true,
      released: true,
      skipped: false,
      status: revolutResult.status,
      fee_captured_pence: revolutResult.fee_captured_pence,
    };
  }

  return {
    ok: false,
    released: false,
    skipped: false,
    status: revolutResult.status,
    error: revolutResult.error ?? revolutResult.status,
  };
}

/**
 * Trigger prevent_authorised_session_client_cancel uses OLD.provider_state.
 * Flip provider_state first (no status change), then mark released/cancelled.
 */
async function persistTriplessSessionReleased(
  supabase: SupabaseClient,
  args: {
    sessionId: string | null;
    providerOrderId: string;
    clientActionId: string | null;
    terminalReason: string;
    idempotencyKey: string;
    authorisedPence: number;
    providerState: string;
  },
): Promise<{ ok: boolean; error?: string }> {
  const now = new Date().toISOString();
  if (args.sessionId) {
    const { error: flipErr } = await supabase
      .from("payment_sessions")
      .update({
        provider_state: args.providerState,
        provider_state_verified_at: now,
        provider_state_verified_by: "holdReleaseSSOT",
        updated_at: now,
      })
      .eq("id", args.sessionId);
    if (flipErr) return { ok: false, error: flipErr.message };
  }

  await markPaymentSessionReleased(supabase, {
    providerOrderId: args.providerOrderId,
    clientActionId: args.clientActionId,
    reason: args.terminalReason,
    holdTerminalReason: args.terminalReason,
    providerReleaseReference: args.providerOrderId,
    idempotencyKey: args.idempotencyKey,
    releasedAmountPence: args.authorisedPence > 0 ? args.authorisedPence : null,
    releasedAt: now,
  });
  return { ok: true };
}

/**
 * Cancel an AUTHORISED Revolut order that never became a trip.
 * Never captures. COMPLETED-without-trip refunds via the invariant path.
 */
export async function releaseHoldForPaymentSession(
  supabase: SupabaseClient,
  args: {
    providerOrderId?: string | null;
    clientActionId?: string | null;
    terminalReason: string;
    source: string;
    idempotencyKey: string;
    session?: Record<string, unknown> | null;
  },
): Promise<HoldReleaseResult> {
  const session = args.session
    ?? await loadPaymentSession(supabase, {
      providerOrderId: args.providerOrderId,
      clientActionId: args.clientActionId,
    }).catch(() => null);

  if (sessionAlreadyTerminal(session)) {
    return {
      ok: true,
      released: false,
      skipped: true,
      status: String(session?.released_at ? "released" : "captured"),
      idempotent: true,
    };
  }

  const tripId = session?.trip_id ? String(session.trip_id) : null;
  if (tripId) {
    return releaseHoldOnTripTerminal(supabase, {
      tripId,
      terminalReason: args.terminalReason,
      source: args.source,
      idempotencyKey: args.idempotencyKey,
      forceRelease: true,
      providerOrderId: args.providerOrderId,
      clientActionId: args.clientActionId,
    });
  }

  const providerOrderId =
    args.providerOrderId?.trim()
    || (session?.provider_order_id ? String(session.provider_order_id) : "")
    || "";
  if (!providerOrderId) {
    return {
      ok: false,
      released: false,
      skipped: true,
      status: "skipped",
      reason: "missing_provider_order_id",
    };
  }

  const sessionId = session?.id ? String(session.id) : null;
  if (sessionId) {
    const attempts = Number(session?.release_attempt_count ?? 0) + 1;
    await supabase.from("payment_sessions").update({
      release_attempt_count: attempts,
      updated_at: new Date().toISOString(),
    }).eq("id", sessionId);
  }

  try {
    const merchant = await resolveRevolutMerchantContext(supabase, "live");
    const order = await retrieveRevolutOrder(
      merchant.environment,
      merchant.secretKey,
      providerOrderId,
    );
    const state = String(order.state ?? "").toUpperCase();
    const authorisedPence = Math.max(0, Number(order.amount ?? session?.authorised_amount_pence ?? 0));

    if (state === "COMPLETED") {
      await handleRevolutPaymentInvariantViolation(supabase, {
        providerOrderId,
        tripId: null,
        clientActionId: args.clientActionId ?? (session?.client_action_id as string | null) ?? null,
        stage: args.source,
        reason: "capture_before_trip_creation",
        orderAmountPence: authorisedPence,
      });
      const persist = await persistTriplessSessionReleased(supabase, {
        sessionId,
        providerOrderId,
        clientActionId: args.clientActionId ?? (session?.client_action_id as string | null) ?? null,
        terminalReason: args.terminalReason,
        idempotencyKey: args.idempotencyKey,
        authorisedPence,
        providerState: "REFUNDED",
      });
      if (!persist.ok) {
        return { ok: false, released: true, skipped: false, status: "local_persist_failed", error: persist.error };
      }
      return { ok: true, released: true, skipped: false, status: "refunded_wrong_capture" };
    }

    if (state === "CANCELLED" || state === "FAILED") {
      const persist = await persistTriplessSessionReleased(supabase, {
        sessionId,
        providerOrderId,
        clientActionId: args.clientActionId ?? (session?.client_action_id as string | null) ?? null,
        terminalReason: args.terminalReason,
        idempotencyKey: args.idempotencyKey,
        authorisedPence,
        providerState: state,
      });
      if (!persist.ok) {
        return { ok: false, released: false, skipped: false, status: "local_persist_failed", error: persist.error };
      }
      return { ok: true, released: false, skipped: true, status: "released", idempotent: true };
    }

    if (!CANCELABLE_HOLD_STATES.has(state)) {
      return {
        ok: false,
        released: false,
        skipped: false,
        status: state.toLowerCase() || "not_cancelable",
        error: `order_not_cancelable:${state || "unknown"}`,
      };
    }

    await cancelRevolutOrder(merchant.environment, merchant.secretKey, providerOrderId);
    const persist = await persistTriplessSessionReleased(supabase, {
      sessionId,
      providerOrderId,
      clientActionId: args.clientActionId ?? (session?.client_action_id as string | null) ?? null,
      terminalReason: args.terminalReason,
      idempotencyKey: args.idempotencyKey,
      authorisedPence,
      providerState: "CANCELLED",
    });
    if (!persist.ok) {
      return { ok: false, released: true, skipped: false, status: "local_persist_failed", error: persist.error };
    }
    await supabase.from("admin_payment_audit").insert({
      action: "revolut_session_hold_released",
      provider: "revolut",
      provider_payment_id: providerOrderId,
      metadata: {
        stage: args.source,
        reason: args.terminalReason,
        provider_state: "CANCELLED",
        capture_mode: "none",
      },
    }).then(({ error }) => {
      if (error) console.warn("[holdReleaseSSOT] session release audit failed", error.message);
    });
    return { ok: true, released: true, skipped: false, status: "released" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (sessionId) {
      await supabase.from("payment_sessions").update({
        release_failure_reason: message,
        updated_at: new Date().toISOString(),
      }).eq("id", sessionId);
    }
    return { ok: false, released: false, skipped: false, status: "failed", error: message };
  }
}

/** Admin: try to create the trip from an authorised session snapshot (never captures). */
export async function attemptHoldRecoveryOnce(
  supabase: SupabaseClient,
  session: Record<string, unknown>,
  args: {
    supabaseUrl: string;
    serviceRoleKey: string;
    source: string;
  },
): Promise<HoldReleaseResult> {
  const sessionId = session.id ? String(session.id) : "";
  const orderId = String(session.provider_order_id ?? "");
  if (sessionId) {
    await supabase.from("payment_sessions").update({
      recovery_attempt_count: Number(session.recovery_attempt_count ?? 0) + 1,
      updated_at: new Date().toISOString(),
    }).eq("id", sessionId);
  }
  if (!orderId) {
    return { ok: false, released: false, status: "missing_provider_order_id" };
  }
  const finalize = await finalizeBookingAfterPaymentFromSession(supabase, {
    providerOrderId: orderId,
    clientActionId: (session.client_action_id as string | null) ?? null,
    supabaseUrl: args.supabaseUrl,
    serviceRoleKey: args.serviceRoleKey,
  });
  if (finalize.tripId) {
    return { ok: true, released: false, status: "linked", reason: finalize.tripId };
  }
  return {
    ok: false,
    released: false,
    status: "recovery_failed",
    error: finalize.error ?? "recovery_failed",
  };
}
