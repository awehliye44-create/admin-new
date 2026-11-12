/**
 * Phase 3 — Automatic Scheduled Jobs marketplace publication.
 *
 * Create still stamps admin_held + null scheduled_broadcast_at (Hard Rule #1 create).
 * After payment-confirmed trip creation + fare enrich gates pass, publish via the
 * existing Make Available patch (scheduled_status=scheduled, broadcast_at=now).
 *
 * Reuses scheduledAdminReleaseSSOT + scheduled-dispatch STEP 0 jobs executor.
 * No parallel dispatch engine.
 */

import {
  buildMakeAvailableScheduledJobsPatch,
  buildPendingReleasePatch,
  type PendingReleaseKind,
} from "./scheduledAdminReleaseSSOT.ts";

export const SCHEDULED_MARKETPLACE_AUTO_PUBLISH_VIA = {
  post_commit: "post_commit_auto_publish",
  recovery_sweep: "auto_publish_recovery_sweep",
  pending_jobs_at: "pending_jobs_at",
  cancel_rematch: "cancel_confirmed_rematch",
} as const;

export type ScheduledMarketplaceAutoPublishVia =
  (typeof SCHEDULED_MARKETPLACE_AUTO_PUBLISH_VIA)[keyof typeof SCHEDULED_MARKETPLACE_AUTO_PUBLISH_VIA];

/** Booking sources that are routine customer/system creates (auto-publish). */
export const ROUTINE_AUTO_PUBLISH_BOOKING_SOURCES = [
  "customer_app",
  "customer_native",
  "customer_web",
  "choose_ride",
  "guest",
  "guest_web",
  "corporate_portal",
  "corporate",
  "whatsapp",
  "ctap",
  "create_trip_after_payment",
  "hub",
  "web",
  "booking_form",
] as const;

/** Manual / operator creates — do not auto-publish; Admin decides Assign/Make Available. */
export const EXCEPTIONAL_MANUAL_BOOKING_SOURCES = [
  "admin_manual",
  "manual_trip",
  "admin",
] as const;

export type ScheduledMarketplaceHoldClass =
  | "terminal_or_live"
  | "payment_gate_blocked"
  | "airport_pricing_hold"
  | "other_broadcast_disabled"
  | "exceptional_pending_release"
  | "manual_admin_hold"
  | "preconfirmed"
  | "already_published"
  | "routine_admin_held"
  | "legacy_unpublished"
  | "not_scheduled";

export type ScheduledMarketplaceAutoPublishBlockReason =
  | "not_scheduled_mode"
  | "terminal"
  | "already_published"
  | "already_assigned"
  | "payment_gate_blocked_status"
  | "airport_pricing_hold"
  | "exceptional_pending_release"
  | "manual_admin_hold"
  | "missing_service_area"
  | "missing_vehicle_type"
  | "ok";

export type ScheduledMarketplaceTripSnapshot = {
  id?: string | null;
  dispatch_mode?: string | null;
  status?: string | null;
  scheduled_status?: string | null;
  scheduled_at?: string | null;
  scheduled_broadcast_at?: string | null;
  scheduled_convert_at?: string | null;
  driver_id?: string | null;
  confirmed_driver_id?: string | null;
  broadcast_enabled?: boolean | null;
  airport_charge_pence?: number | null;
  pending_release_kind?: string | null;
  pending_release_at?: string | null;
  booking_source?: string | null;
  service_area_id?: string | null;
  vehicle_type_id?: string | null;
  vehicle_type?: string | null;
  completed_at?: string | null;
  cancelled_at?: string | null;
};

const TERMINAL_STATUSES = new Set([
  "completed",
  "cancelled",
  "customer_cancelled",
  "driver_cancelled",
  "no_show",
  "expired",
  "expired_no_driver",
]);

const LIVE_STATUSES = new Set([
  "en_route_to_pickup",
  "arrived",
  "arrived_at_pickup",
  "in_progress",
  "passenger_on_board",
  "on_trip",
]);

function lower(v: unknown): string {
  return String(v ?? "").trim().toLowerCase();
}

function isBlank(v: unknown): boolean {
  return v == null || String(v).trim() === "";
}

export function isRoutineAutoPublishBookingSource(source: string | null | undefined): boolean {
  const s = lower(source);
  if (!s) return true; // CTAP often omits source — treat as routine
  if ((EXCEPTIONAL_MANUAL_BOOKING_SOURCES as readonly string[]).includes(s)) return false;
  if ((ROUTINE_AUTO_PUBLISH_BOOKING_SOURCES as readonly string[]).includes(s)) return true;
  // Unknown sources: fail closed for recovery sweep (Admin review); CTAP post-commit still publishes.
  return false;
}

export function isExceptionalManualBookingSource(source: string | null | undefined): boolean {
  return (EXCEPTIONAL_MANUAL_BOOKING_SOURCES as readonly string[]).includes(lower(source));
}

export function isScheduledMarketplaceAlreadyPublished(trip: ScheduledMarketplaceTripSnapshot): boolean {
  const sched = lower(trip.scheduled_status);
  if (sched === "admin_held") return false;
  const at = trip.scheduled_broadcast_at ? Date.parse(String(trip.scheduled_broadcast_at)) : NaN;
  if (!Number.isFinite(at)) return false;
  return sched === "scheduled" || sched === "pending" || sched === "broadcasting" ||
    sched === "awaiting_confirmation" || sched === "dispatching";
}

/**
 * Dry-run / ops classification — first matching class wins.
 * Mirror of docs Phase 3 hold taxonomy (H0–H9).
 */
export function classifyScheduledMarketplaceHold(
  trip: ScheduledMarketplaceTripSnapshot,
  nowMs: number = Date.now(),
): {
  class: ScheduledMarketplaceHoldClass;
  proposedAction: "skip" | "auto_publish" | "review" | "already_ok";
  reason: string;
} {
  const status = lower(trip.status);
  const sched = lower(trip.scheduled_status);
  const mode = lower(trip.dispatch_mode);

  if (mode && mode !== "scheduled" && !trip.scheduled_at) {
    return { class: "not_scheduled", proposedAction: "skip", reason: "not_scheduled" };
  }
  if (
    trip.completed_at ||
    trip.cancelled_at ||
    TERMINAL_STATUSES.has(status) ||
    sched === "cancelled" ||
    sched === "expired" ||
    sched === "no_driver_found" ||
    sched === "converted_to_instant" ||
    (!isBlank(trip.driver_id) && LIVE_STATUSES.has(status))
  ) {
    return { class: "terminal_or_live", proposedAction: "skip", reason: "terminal_or_live" };
  }
  if (sched === "payment_gate_blocked") {
    return {
      class: "payment_gate_blocked",
      proposedAction: "skip",
      reason: "payment_or_capture_coverage",
    };
  }
  if (trip.broadcast_enabled === false && Number(trip.airport_charge_pence ?? 0) > 0) {
    return {
      class: "airport_pricing_hold",
      proposedAction: "skip",
      reason: "airport_fare_persist_hold",
    };
  }
  if (trip.broadcast_enabled === false) {
    return {
      class: "other_broadcast_disabled",
      proposedAction: "review",
      reason: "broadcast_enabled_false",
    };
  }
  const pendingKind = lower(trip.pending_release_kind);
  if (pendingKind === "assign" || pendingKind === "broadcast" || pendingKind === "jobs") {
    const at = trip.pending_release_at ? Date.parse(String(trip.pending_release_at)) : NaN;
    if (Number.isFinite(at)) {
      return {
        class: "exceptional_pending_release",
        proposedAction: "skip",
        reason: `pending_${pendingKind}_at_${trip.pending_release_at}`,
      };
    }
  }
  if (!isBlank(trip.confirmed_driver_id) && isBlank(trip.driver_id)) {
    return { class: "preconfirmed", proposedAction: "skip", reason: "already_assigned_preconfirm" };
  }
  if (isScheduledMarketplaceAlreadyPublished(trip) && Number.isFinite(
    trip.scheduled_broadcast_at ? Date.parse(String(trip.scheduled_broadcast_at)) : NaN,
  ) && (trip.scheduled_broadcast_at ? Date.parse(String(trip.scheduled_broadcast_at)) : Infinity) <= nowMs) {
    return { class: "already_published", proposedAction: "already_ok", reason: "marketplace_open" };
  }
  if (isExceptionalManualBookingSource(trip.booking_source)) {
    return {
      class: "manual_admin_hold",
      proposedAction: "review",
      reason: "admin_manual_booking_source",
    };
  }
  if (sched === "admin_held" && isBlank(trip.scheduled_broadcast_at) && isBlank(trip.driver_id) &&
    isBlank(trip.confirmed_driver_id)) {
    return {
      class: "routine_admin_held",
      proposedAction: "auto_publish",
      reason: "routine_create_held",
    };
  }
  if (
    (sched === "scheduled" || sched === "pending" || sched === "") &&
    isBlank(trip.scheduled_broadcast_at) &&
    isBlank(trip.driver_id) &&
    isBlank(trip.confirmed_driver_id)
  ) {
    return {
      class: "legacy_unpublished",
      proposedAction: "auto_publish",
      reason: "legacy_null_broadcast_at",
    };
  }
  return { class: "already_published", proposedAction: "already_ok", reason: "no_hold" };
}

/**
 * Pure eligibility for automatic Make Available (Requested tab publication).
 * Payment gate is checked by the caller via assertPaymentGate (async).
 */
export function evaluateScheduledMarketplaceAutoPublishEligibility(
  trip: ScheduledMarketplaceTripSnapshot,
  opts: {
    nowMs?: number;
    /** Post-commit CTAP path publishes even when booking_source is unknown. */
    allowUnknownBookingSource?: boolean;
    requireServiceArea?: boolean;
    requireVehicleType?: boolean;
  } = {},
): { ok: boolean; reason: ScheduledMarketplaceAutoPublishBlockReason } {
  const nowMs = opts.nowMs ?? Date.now();
  const mode = lower(trip.dispatch_mode);
  if (mode && mode !== "scheduled") {
    return { ok: false, reason: "not_scheduled_mode" };
  }
  const status = lower(trip.status);
  const sched = lower(trip.scheduled_status);
  if (
    trip.completed_at ||
    trip.cancelled_at ||
    TERMINAL_STATUSES.has(status) ||
    LIVE_STATUSES.has(status) ||
    sched === "cancelled" ||
    sched === "converted_to_instant" ||
    sched === "no_driver_found"
  ) {
    return { ok: false, reason: "terminal" };
  }
  if (sched === "payment_gate_blocked") {
    return { ok: false, reason: "payment_gate_blocked_status" };
  }
  if (!isBlank(trip.driver_id) || !isBlank(trip.confirmed_driver_id)) {
    return { ok: false, reason: "already_assigned" };
  }
  if (isScheduledMarketplaceAlreadyPublished(trip)) {
    const at = trip.scheduled_broadcast_at ? Date.parse(String(trip.scheduled_broadcast_at)) : NaN;
    if (Number.isFinite(at) && at <= nowMs) {
      return { ok: false, reason: "already_published" };
    }
  }
  if (trip.broadcast_enabled === false) {
    return { ok: false, reason: "airport_pricing_hold" };
  }
  const pendingKind = lower(trip.pending_release_kind);
  // Explicit Assign At / Broadcast At must not be overridden.
  // pending jobs At is itself the publish mechanism — allow executor to run it.
  if (pendingKind === "assign" || pendingKind === "broadcast") {
    return { ok: false, reason: "exceptional_pending_release" };
  }
  if (
    !opts.allowUnknownBookingSource &&
    !isRoutineAutoPublishBookingSource(trip.booking_source)
  ) {
    return { ok: false, reason: "manual_admin_hold" };
  }
  if (opts.requireServiceArea !== false && isBlank(trip.service_area_id)) {
    return { ok: false, reason: "missing_service_area" };
  }
  if (opts.requireVehicleType) {
    if (isBlank(trip.vehicle_type_id) && isBlank(trip.vehicle_type)) {
      return { ok: false, reason: "missing_vehicle_type" };
    }
  }
  return { ok: true, reason: "ok" };
}

export function buildScheduledMarketplaceAutoPublishPatch(nowIso: string): Record<string, unknown> {
  return buildMakeAvailableScheduledJobsPatch({ nowIso });
}

/** Bounded retry: stamp jobs pending at now so STEP 0 re-attempts publish. */
export function buildScheduledMarketplaceAutoPublishRetryPatch(nowIso: string): {
  pending_release_kind: PendingReleaseKind;
  pending_release_at: string;
  pending_release_driver_id: string | null;
} {
  return buildPendingReleasePatch({ kind: "jobs", executeAtIso: nowIso });
}

export type AutoPublishAttemptResult =
  | { published: true; via: ScheduledMarketplaceAutoPublishVia; tripId: string }
  | {
    published: false;
    via: ScheduledMarketplaceAutoPublishVia;
    tripId: string;
    reason: string;
    retryStamped?: boolean;
  };

type AnySupabase = {
  from: (table: string) => any;
};

/**
 * Idempotent CAS publish: admin_held|scheduled|pending → Make Available patch.
 * Caller must have already run assertPaymentGate when payment applies.
 */
export async function attemptScheduledMarketplaceAutoPublish(
  supabase: AnySupabase,
  input: {
    tripId: string;
    trip: ScheduledMarketplaceTripSnapshot;
    nowIso: string;
    via: ScheduledMarketplaceAutoPublishVia;
    allowUnknownBookingSource?: boolean;
    stampRetryOnFailure?: boolean;
  },
): Promise<AutoPublishAttemptResult> {
  const eligibility = evaluateScheduledMarketplaceAutoPublishEligibility(input.trip, {
    allowUnknownBookingSource: input.allowUnknownBookingSource,
  });
  if (!eligibility.ok) {
    return {
      published: false,
      via: input.via,
      tripId: input.tripId,
      reason: eligibility.reason,
    };
  }

  const { data: rows, error } = await supabase
    .from("trips")
    .update(buildScheduledMarketplaceAutoPublishPatch(input.nowIso))
    .eq("id", input.tripId)
    .is("completed_at", null)
    .is("driver_id", null)
    .is("confirmed_driver_id", null)
    .in("scheduled_status", ["admin_held", "scheduled", "pending"])
    .select("id");

  if (error) {
    let retryStamped = false;
    if (input.stampRetryOnFailure) {
      const { error: retryErr } = await supabase
        .from("trips")
        .update(buildScheduledMarketplaceAutoPublishRetryPatch(input.nowIso))
        .eq("id", input.tripId)
        .in("scheduled_status", ["admin_held", "scheduled", "pending"])
        .is("driver_id", null)
        .is("confirmed_driver_id", null)
        .is("pending_release_kind", null);
      retryStamped = !retryErr;
    }
    return {
      published: false,
      via: input.via,
      tripId: input.tripId,
      reason: error.message ?? "update_failed",
      retryStamped,
    };
  }

  if (!rows?.length) {
    // Already published or raced — treat as idempotent success if now open.
    const { data: current } = await supabase
      .from("trips")
      .select(
        "id, scheduled_status, scheduled_broadcast_at, driver_id, confirmed_driver_id, dispatch_mode, status, broadcast_enabled",
      )
      .eq("id", input.tripId)
      .maybeSingle();
    if (
      current &&
      isScheduledMarketplaceAlreadyPublished(current) &&
      isBlank(current.driver_id) &&
      isBlank(current.confirmed_driver_id)
    ) {
      return { published: true, via: input.via, tripId: input.tripId };
    }
    return {
      published: false,
      via: input.via,
      tripId: input.tripId,
      reason: "cas_no_match",
    };
  }

  return { published: true, via: input.via, tripId: input.tripId };
}
