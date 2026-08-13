/**
 * Hold release SSOT for terminal trips (Slice A recovery).
 * Revolut-only — Stripe hold paths removed. Preserves get-active-trip / expire callers.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  releaseRevolutPreauthForTrip,
  resolveRevolutOrderIdFromTrip,
} from "./revolutPreauthReleaseSSOT.ts";
import { loadPaymentSession } from "./paymentSessionSSOT.ts";

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
    return {
      ok: false,
      released: false,
      skipped: true,
      status: "skipped",
      reason: "missing_trip_id",
    };
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
