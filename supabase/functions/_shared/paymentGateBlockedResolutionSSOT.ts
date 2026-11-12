/**
 * payment_gate_blocked resolution SSOT (Phase 1).
 *
 * Definitive coverage failure before Start Trip → cancel via cancellation SSOT +
 * guarded hold release. Temporary provider errors → keep blocked, bounded retry.
 * Never revive cancelled/expired. Never auto-cancel in-progress journeys.
 * Never duplicate refunds / releases / notifications for already-terminal rows.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { assertPaymentGate, PaymentGateError } from "./paymentGate.ts";
import { releaseHoldForPaymentSession } from "./holdReleaseSSOT.ts";
import { ensureScheduledCaptureCoverage } from "./scheduledBookingPaymentCoverageSSOT.ts";
import { isCardFundedPaymentMethod } from "./scheduledCaptureCoverageSSOT.ts";
import { resolveRevolutMerchantContext } from "./revolutMerchantContext.ts";

const IN_PROGRESS = new Set([
  "IN_PROGRESS",
  "IN_TRIP",
  "STARTED",
  "ARRIVED",
  "WAITING",
  "ON_TRIP",
]);

const TERMINAL = new Set([
  "COMPLETED",
  "CANCELLED",
  "CANCELED",
  "NO_SHOW",
  "EXPIRED",
]);

/** Bounded unresolved window for temporary provider/network failures (cron sweeps). */
export const PAYMENT_GATE_BLOCKED_RESOLUTION_DEADLINE_MS = 30 * 60_000;

export type PaymentGateBlockedResolution =
  | { action: "noop_terminal_normalised"; tripId: string }
  | { action: "noop_in_progress"; tripId: string }
  | { action: "cleared"; tripId: string }
  | { action: "blocked_temporary"; tripId: string; reason: string }
  | {
      action: "cancelled_definitive";
      tripId: string;
      reason: string;
      holdReleaseAttempted: boolean;
    }
  | { action: "error"; tripId: string; reason: string };

export async function resolvePaymentGateBlockedTrip(
  supabase: SupabaseClient,
  tripId: string,
  opts?: { dryRun?: boolean },
): Promise<PaymentGateBlockedResolution> {
  const { data: trip, error } = await supabase
    .from("trips")
    .select(
      "id, status, scheduled_status, started_at, completed_at, cancelled_at, payment_method, payment_session_id, provider_order_id, scheduled_at, estimated_duration_minutes, is_scheduled, passenger_id, driver_id, updated_at",
    )
    .eq("id", tripId)
    .maybeSingle();

  if (error || !trip) {
    return { action: "error", tripId, reason: error?.message ?? "trip_not_found" };
  }

  const status = String(trip.status ?? "").toUpperCase();
  if (
    trip.completed_at ||
    trip.cancelled_at ||
    TERMINAL.has(status)
  ) {
    if (!opts?.dryRun && String(trip.scheduled_status) === "payment_gate_blocked") {
      await supabase
        .from("trips")
        .update({
          scheduled_status: status === "COMPLETED" ? "completed" : "cancelled",
          updated_at: new Date().toISOString(),
        })
        .eq("id", tripId)
        .eq("scheduled_status", "payment_gate_blocked");
    }
    return { action: "noop_terminal_normalised", tripId };
  }

  if (trip.started_at || IN_PROGRESS.has(status)) {
    return { action: "noop_in_progress", tripId };
  }

  // Re-check amount + coverage via existing payment gate first.
  try {
    await assertPaymentGate(supabase, tripId);
    if (!opts?.dryRun) {
      await supabase
        .from("trips")
        .update({
          scheduled_status: "scheduled",
          updated_at: new Date().toISOString(),
        })
        .eq("id", tripId)
        .eq("scheduled_status", "payment_gate_blocked");
    }
    return { action: "cleared", tripId };
  } catch (e) {
    const msg = e instanceof PaymentGateError ? e.message : String((e as Error)?.message ?? e);
    const definitiveInsufficient =
      msg.includes("CAPTURE_DEADLINE_INSUFFICIENT") ||
      msg.includes("PAYMENT_AUTHORISATION_INSUFFICIENT") ||
      msg.includes("session orphaned") ||
      msg.includes("HOLD_RELEASED") ||
      msg.includes("provider_state=");

    if (!definitiveInsufficient && isCardFundedPaymentMethod(trip.payment_method)) {
      // Attempt retrieve-backed coverage if deadline missing.
      if (trip.payment_session_id && trip.provider_order_id && trip.scheduled_at) {
        try {
          const merchant = await resolveRevolutMerchantContext(supabase, "live");
          const { data: session } = await supabase
            .from("payment_sessions")
            .select("*")
            .eq("id", trip.payment_session_id)
            .maybeSingle();
          const coverage = await ensureScheduledCaptureCoverage({
            supabase,
            scheduledAtIso: String(trip.scheduled_at),
            estimatedDurationMinutes: Number(trip.estimated_duration_minutes ?? 30),
            paymentMethod: trip.payment_method,
            session: {
              id: session?.id,
              status: session?.status,
              provider_state: session?.provider_state,
              released_at: session?.released_at,
              captured_at: session?.captured_at,
              capture_deadline: session?.capture_deadline,
              provider_order_id: session?.provider_order_id ?? trip.provider_order_id,
              trip_id: session?.trip_id ?? tripId,
              metadata: (session?.metadata as Record<string, unknown> | null) ?? null,
            },
            expectedTripId: tripId,
            revolut: {
              environment: merchant.environment,
              secretKey: merchant.secretKey,
              orderId: String(trip.provider_order_id),
            },
          });
          if (coverage.ok) {
            if (!opts?.dryRun) {
              await supabase
                .from("trips")
                .update({
                  scheduled_status: "scheduled",
                  updated_at: new Date().toISOString(),
                })
                .eq("id", tripId)
                .eq("scheduled_status", "payment_gate_blocked");
            }
            return { action: "cleared", tripId };
          }
          if (!coverage.definitive) {
            const blockedAtMs = Date.parse(String(trip.updated_at ?? ""));
            if (
              Number.isFinite(blockedAtMs) &&
              Date.now() - blockedAtMs >= PAYMENT_GATE_BLOCKED_RESOLUTION_DEADLINE_MS
            ) {
              return await cancelDefinitivePaymentGateBlocked(
                supabase,
                trip,
                `temporary_unresolved:${coverage.code}`,
                opts?.dryRun,
              );
            }
            return {
              action: "blocked_temporary",
              tripId,
              reason: coverage.code,
            };
          }
          // definitive coverage failure → cancel below
          return await cancelDefinitivePaymentGateBlocked(supabase, trip, coverage.code, opts?.dryRun);
        } catch (retrieveErr) {
          return {
            action: "blocked_temporary",
            tripId,
            reason: retrieveErr instanceof Error ? retrieveErr.message : String(retrieveErr),
          };
        }
      }
      return { action: "blocked_temporary", tripId, reason: msg };
    }

    return await cancelDefinitivePaymentGateBlocked(supabase, trip, msg, opts?.dryRun);
  }
}

async function cancelDefinitivePaymentGateBlocked(
  supabase: SupabaseClient,
  trip: {
    id: string;
    provider_order_id?: string | null;
    payment_session_id?: string | null;
    passenger_id?: string | null;
    driver_id?: string | null;
  },
  reason: string,
  dryRun?: boolean,
): Promise<PaymentGateBlockedResolution> {
  if (dryRun) {
    return {
      action: "cancelled_definitive",
      tripId: trip.id,
      reason,
      holdReleaseAttempted: false,
    };
  }

  const now = new Date().toISOString();
  const { data: updated } = await supabase
    .from("trips")
    .update({
      status: "cancelled",
      scheduled_status: "cancelled",
      cancelled_at: now,
      cancellation_reason: `payment_gate_blocked:${reason}`.slice(0, 500),
      updated_at: now,
    })
    .eq("id", trip.id)
    .eq("scheduled_status", "payment_gate_blocked")
    .is("started_at", null)
    .is("completed_at", null)
    .select("id");

  if (!updated?.length) {
    return { action: "noop_terminal_normalised", tripId: trip.id };
  }

  let holdReleaseAttempted = false;
  if (trip.provider_order_id || trip.payment_session_id) {
    holdReleaseAttempted = true;
    await releaseHoldForPaymentSession(supabase, {
      providerOrderId: trip.provider_order_id ?? null,
      terminalReason: `payment_gate_blocked:${reason}`.slice(0, 200),
      source: "paymentGateBlockedResolution",
      idempotencyKey: `pgb_cancel_${trip.id}`,
    });
  }

  // Customer / driver notices — best-effort, idempotent keys.
  try {
    const { notifyCustomerTripLifecycle } = await import("./customerTripLifecycleNotify.ts");
    if (trip.passenger_id) {
      await notifyCustomerTripLifecycle(supabase, {
        passengerId: String(trip.passenger_id),
        tripId: trip.id,
        event: "trip_cancelled",
        title: "Booking cancelled",
        body: "Your scheduled ride was cancelled because card authorisation could not cover the journey.",
        notificationId: `payment_gate_blocked_cancel-${trip.id}`,
        path: "/account/rides",
      });
    }
  } catch {
    // non-fatal
  }

  return {
    action: "cancelled_definitive",
    tripId: trip.id,
    reason,
    holdReleaseAttempted,
  };
}
