/**
 * #89D — Authoritative preauth schedule-overlap gate.
 *
 * Payment-first booking must refuse a NEW Revolut authorisation when the
 * passenger already has an overlapping scheduled/active trip. Overlap used to
 * run only in create-trip-after-payment, which left orphan AUTHORISED holds
 * (MK-261124-002 second order / SCHEDULED_TRIP_OVERLAP class).
 *
 * Idempotent retries (same client_action_id / same trip) are handled by
 * revolutPreauth session reuse BEFORE a new provider order — this gate only
 * blocks conflicting NEW booking intents.
 *
 * Does not cancel or release money. Does not contact Revolut.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  findPassengerScheduleOverlap,
  type PassengerOverlapTrip,
} from "./passengerScheduleOverlapSSOT.ts";
import { PASSENGER_OVERLAP_TERMINAL_STATUS_POSTGREST_LIST } from "./passengerBookingOverlapLifecycleSSOT.ts";

export const PREAUTH_BOOKING_TIME_CONFLICT = "BOOKING_TIME_CONFLICT" as const;

/** Customer-facing booking conflict — never payment/auth wording. */
export const BOOKING_TIME_CONFLICT_CUSTOMER_TITLE = "Booking time conflict";
export const BOOKING_TIME_CONFLICT_CUSTOMER_MESSAGE =
  "You already have an active booking that overlaps with this journey. Please choose another pickup time or manage your existing booking.";

export type PreauthOverlapGateResult =
  | { ok: true }
  | {
    ok: false;
    code: typeof PREAUTH_BOOKING_TIME_CONFLICT | "BOOKING_TIME_CONFLICT_CHECK_FAILED";
    conflicting_trip_id?: string;
    conflicting_time?: string;
    message: string;
  };

/** Extract candidate schedule from preauth body / booking_snapshot. */
export function resolvePreauthCandidateSchedule(body: Record<string, unknown>): {
  candidateScheduledAt: string | null;
  candidateIsImmediate: boolean;
  candidateDurationMinutes: number;
} {
  const snap = body.booking_snapshot && typeof body.booking_snapshot === "object"
    ? body.booking_snapshot as Record<string, unknown>
    : null;
  const scheduledRaw = body.scheduled_at
    ?? snap?.scheduled_at
    ?? snap?.scheduledAt
    ?? null;
  const scheduledAt = typeof scheduledRaw === "string" && scheduledRaw.trim()
    ? scheduledRaw.trim()
    : null;
  const isScheduledFlag = body.is_scheduled === true
    || body.is_scheduled === "true"
    || snap?.is_scheduled === true
    || snap?.is_scheduled === "true"
    || Boolean(scheduledAt);
  const durationRaw = body.estimated_duration
    ?? body.estimated_duration_minutes
    ?? snap?.estimated_duration_minutes
    ?? snap?.estimated_duration
    ?? 30;
  const candidateDurationMinutes = Math.max(1, Number(durationRaw) || 30);
  if (!isScheduledFlag || !scheduledAt) {
    return {
      candidateScheduledAt: null,
      candidateIsImmediate: true,
      candidateDurationMinutes,
    };
  }
  return {
    candidateScheduledAt: scheduledAt,
    candidateIsImmediate: false,
    candidateDurationMinutes,
  };
}

/**
 * Fail closed before Revolut order create when passenger schedule conflicts.
 * excludeTripId: legacy trip_id path re-authorising the same trip.
 *
 * trips.passenger_id is customers.id (CTAP SSOT), not auth.users id.
 */
export async function assertPassengerClearForNewPreauth(
  supabase: SupabaseClient,
  args: {
    passengerUserId: string;
    /** Prefer customers.id when already resolved on the quote path. */
    customerId?: string | null;
    body: Record<string, unknown>;
    excludeTripId?: string | null;
  },
): Promise<PreauthOverlapGateResult> {
  const schedule = resolvePreauthCandidateSchedule(args.body);

  let customerId = args.customerId ? String(args.customerId).trim() : "";
  if (!customerId) {
    const { data: customer, error: custErr } = await supabase
      .from("customers")
      .select("id")
      .eq("user_id", args.passengerUserId)
      .maybeSingle();
    if (custErr) {
      return {
        ok: false,
        code: "BOOKING_TIME_CONFLICT_CHECK_FAILED",
        message: "Unable to check booking time conflict",
      };
    }
    customerId = customer?.id ? String(customer.id) : "";
  }

  // Prefer customers.id; also include auth user id for any legacy rows.
  const passengerKeys = [customerId, args.passengerUserId].filter(Boolean);
  if (passengerKeys.length === 0) {
    return { ok: true };
  }

  // BR3 — authoritative DB filter: terminal lifecycle rows never enter overlap.
  const { data, error } = await supabase
    .from("trips")
    .select(
      "id, scheduled_at, estimated_duration_minutes, status, passenger_id, created_at, is_scheduled",
    )
    .in("passenger_id", passengerKeys)
    .not("status", "in", PASSENGER_OVERLAP_TERMINAL_STATUS_POSTGREST_LIST)
    .limit(200);

  if (error) {
    return {
      ok: false,
      code: "BOOKING_TIME_CONFLICT_CHECK_FAILED",
      message: "Unable to check booking time conflict",
    };
  }

  const existing = (Array.isArray(data) ? data : []) as PassengerOverlapTrip[];
  const overlap = findPassengerScheduleOverlap({
    candidateScheduledAt: schedule.candidateScheduledAt,
    candidateIsImmediate: schedule.candidateIsImmediate,
    candidateDurationMinutes: schedule.candidateDurationMinutes,
    existing,
    excludeTripId: args.excludeTripId ?? null,
  });

  if (!overlap.has_conflict) return { ok: true };

  return {
    ok: false,
    code: PREAUTH_BOOKING_TIME_CONFLICT,
    conflicting_trip_id: overlap.conflicting_trip_id,
    conflicting_time: overlap.conflicting_time,
    message: BOOKING_TIME_CONFLICT_CUSTOMER_MESSAGE,
  };
}

export function preauthOverlapConflictResponse(
  gate: Extract<PreauthOverlapGateResult, { ok: false }>,
  corsHeaders: Record<string, string>,
): Response {
  const status = gate.code === "BOOKING_TIME_CONFLICT_CHECK_FAILED" ? 500 : 409;
  const isConflict = gate.code === PREAUTH_BOOKING_TIME_CONFLICT;
  return new Response(
    JSON.stringify({
      error: isConflict ? BOOKING_TIME_CONFLICT_CUSTOMER_MESSAGE : gate.message,
      error_code: gate.code,
      code: gate.code,
      title: isConflict ? BOOKING_TIME_CONFLICT_CUSTOMER_TITLE : undefined,
      charge_state: "no_charge",
      booking_conflict: isConflict,
      conflicting_trip_id: gate.conflicting_trip_id ?? null,
      conflicting_time: gate.conflicting_time ?? null,
    }),
    {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
}
