/**
 * Shared “eligible for new-work invitations” SSOT (MK-261105-002 / MK0009).
 *
 * Applies to:
 * - Scheduled marketplace invites (SCHEDULED_RIDE_REQUEST) — offline OK
 * - Instant / rematch / stacked NEW_RIDE_OFFER create+push — online/presence
 *   still required by rideOfferDriverEligibility (not this module)
 *
 * Never rely only on cached drivers.documents_approved — live Europe/London
 * document eligibility is authoritative for invitations to new work.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  evaluateDriverDocumentState,
  type DriverDocumentEligibilityResult,
  type DriverDocumentState,
} from "./driverDocumentEligibility.ts";

export type NewWorkInvitationDenyReason =
  | "driver_not_found"
  | "not_approved"
  | "driver_status_not_active"
  | "driver_suspended"
  | "driver_deleted"
  | "driver_disabled"
  | "documents_not_approved"
  | "documents_expired"
  | "documents_missing"
  | "documents_rejected"
  | "documents_pending_review"
  | "service_area_not_assigned"
  | "document_rules_not_configured"
  | "marketplace_not_open"
  | "trip_already_assigned"
  | "trip_terminal"
  | "trip_not_found";

export type NewWorkInvitationAccountSnapshot = {
  approval_status?: string | null;
  driver_status?: string | null;
  deleted_at?: string | null;
};

export type NewWorkInvitationAccountResult =
  | { ok: true }
  | { ok: false; reason: NewWorkInvitationDenyReason };

export type NewWorkInvitationEligibilityResult =
  | { ok: true; document_state: DriverDocumentState }
  | { ok: false; reason: NewWorkInvitationDenyReason; document_state?: DriverDocumentState };

export type ScheduledMarketplaceBookingSnapshot = {
  id?: string | null;
  dispatch_mode?: string | null;
  scheduled_status?: string | null;
  status?: string | null;
  scheduled_at?: string | null;
  scheduled_broadcast_at?: string | null;
  driver_id?: string | null;
  confirmed_driver_id?: string | null;
};

const TERMINAL_TRIP_STATUSES = new Set([
  "completed",
  "cancelled",
  "canceled",
  "customer_cancelled",
  "driver_cancelled",
  "no_show",
  "expired",
  "expired_no_driver",
  "en_route_to_pickup",
  "in_progress",
  "arrived",
  "arrived_at_pickup",
]);

const OPEN_MARKETPLACE_SCHEDULED_STATUSES = new Set([
  "scheduled",
  "pending",
  "broadcasting",
  "awaiting_confirmation",
  "dispatching",
]);

function norm(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

/** Account / status gates — no online/presence (marketplace may invite offline). */
export function evaluateNewWorkInvitationAccountEligibility(
  driver: NewWorkInvitationAccountSnapshot | null | undefined,
): NewWorkInvitationAccountResult {
  if (!driver) return { ok: false, reason: "driver_not_found" };

  if (driver.deleted_at) {
    return { ok: false, reason: "driver_deleted" };
  }

  const approval = norm(driver.approval_status);
  if (approval === "suspended") {
    return { ok: false, reason: "driver_suspended" };
  }
  if (approval === "rejected" || approval === "declined" || approval === "disabled") {
    return { ok: false, reason: "driver_disabled" };
  }
  if (approval !== "approved") {
    return { ok: false, reason: "not_approved" };
  }

  const status = norm(driver.driver_status);
  if (status === "deleted" || status === "soft_deleted") {
    return { ok: false, reason: "driver_deleted" };
  }
  if (status === "suspended") {
    return { ok: false, reason: "driver_suspended" };
  }
  if (status === "disabled" || status === "inactive" || status === "blocked") {
    return { ok: false, reason: "driver_disabled" };
  }
  if (status !== "active") {
    return { ok: false, reason: "driver_status_not_active" };
  }

  return { ok: true };
}

export function mapDocumentStateToNewWorkDenyReason(
  docs: Pick<DriverDocumentEligibilityResult, "allowed" | "document_state" | "blocked_reasons" | "code">,
): NewWorkInvitationDenyReason | null {
  if (docs.allowed) return null;

  const code = String(docs.code ?? "").toUpperCase();
  if (code === "DRIVER_SERVICE_AREA_NOT_ASSIGNED") {
    return "service_area_not_assigned";
  }
  if (code === "SERVICE_AREA_DOCUMENT_RULES_NOT_CONFIGURED") {
    return "document_rules_not_configured";
  }

  switch (docs.document_state) {
    case "documents_expired":
      return "documents_expired";
    case "documents_missing":
      return "documents_missing";
    case "documents_rejected":
      return "documents_rejected";
    case "documents_pending_review":
    case "documents_uploaded":
      return "documents_pending_review";
    default:
      return "documents_not_approved";
  }
}

export function evaluateNewWorkInvitationEligibilityFromParts(args: {
  account: NewWorkInvitationAccountSnapshot | null | undefined;
  documents: DriverDocumentEligibilityResult;
}): NewWorkInvitationEligibilityResult {
  const account = evaluateNewWorkInvitationAccountEligibility(args.account);
  if (!account.ok) {
    return { ok: false, reason: account.reason };
  }
  const docDeny = mapDocumentStateToNewWorkDenyReason(args.documents);
  if (docDeny) {
    return {
      ok: false,
      reason: docDeny,
      document_state: args.documents.document_state,
    };
  }
  return { ok: true, document_state: args.documents.document_state };
}

/**
 * Pure mirror of public.scheduled_marketplace_is_open for Edge send-time checks.
 * Does not reconstruct legacy NULL broadcast anchors (fail closed without stamp).
 */
export function isScheduledMarketplaceBookingOpenForInvitation(
  trip: ScheduledMarketplaceBookingSnapshot | null | undefined,
  nowMs: number = Date.now(),
): { open: true } | { open: false; reason: NewWorkInvitationDenyReason } {
  if (!trip) return { open: false, reason: "trip_not_found" };

  if (norm(trip.dispatch_mode) !== "scheduled") {
    return { open: false, reason: "marketplace_not_open" };
  }

  if (trip.driver_id || trip.confirmed_driver_id) {
    return { open: false, reason: "trip_already_assigned" };
  }

  const status = norm(trip.status);
  if (TERMINAL_TRIP_STATUSES.has(status)) {
    return { open: false, reason: "trip_terminal" };
  }

  const sched = norm(trip.scheduled_status);
  if (sched === "admin_held" || sched === "") {
    return { open: false, reason: "marketplace_not_open" };
  }
  if (!OPEN_MARKETPLACE_SCHEDULED_STATUSES.has(sched)) {
    return { open: false, reason: "marketplace_not_open" };
  }

  if (!trip.scheduled_at) {
    return { open: false, reason: "marketplace_not_open" };
  }
  const scheduledAtMs = Date.parse(String(trip.scheduled_at));
  if (!Number.isFinite(scheduledAtMs) || scheduledAtMs <= nowMs) {
    return { open: false, reason: "marketplace_not_open" };
  }

  if (!trip.scheduled_broadcast_at) {
    return { open: false, reason: "marketplace_not_open" };
  }
  const broadcastMs = Date.parse(String(trip.scheduled_broadcast_at));
  if (!Number.isFinite(broadcastMs) || broadcastMs > nowMs) {
    return { open: false, reason: "marketplace_not_open" };
  }

  return { open: true };
}

type SupabaseLike = {
  from: (table: string) => any;
  rpc?: (fn: string, args?: Record<string, unknown>) => any;
};

export async function evaluateDriverNewWorkInvitationEligibility(
  supabase: SupabaseLike,
  driverId: string,
): Promise<NewWorkInvitationEligibilityResult> {
  const id = String(driverId ?? "").trim();
  if (!id) return { ok: false, reason: "driver_not_found" };

  const { data: driver, error } = await supabase
    .from("drivers")
    .select("id, approval_status, driver_status, deleted_at")
    .eq("id", id)
    .maybeSingle();

  if (error || !driver) {
    return { ok: false, reason: "driver_not_found" };
  }

  const account = evaluateNewWorkInvitationAccountEligibility(driver);
  if (!account.ok) {
    return { ok: false, reason: account.reason };
  }

  // Live Europe/London eligibility (same SSOT family as go-online / accept).
  const documents = await evaluateDriverDocumentState(
    supabase as unknown as SupabaseClient,
    id,
  );
  return evaluateNewWorkInvitationEligibilityFromParts({ account: driver, documents });
}

export async function evaluateScheduledMarketplaceInviteSendGate(
  supabase: SupabaseLike,
  args: {
    driverId: string;
    tripId: string | null | undefined;
    nowMs?: number;
  },
): Promise<NewWorkInvitationEligibilityResult> {
  const nowMs = args.nowMs ?? Date.now();
  const tripId = String(args.tripId ?? "").trim();
  if (!tripId) {
    return { ok: false, reason: "trip_not_found" };
  }

  const { data: trip, error: tripErr } = await supabase
    .from("trips")
    .select(
      "id, dispatch_mode, scheduled_status, status, scheduled_at, scheduled_broadcast_at, driver_id, confirmed_driver_id",
    )
    .eq("id", tripId)
    .maybeSingle();

  if (tripErr || !trip) {
    return { ok: false, reason: "trip_not_found" };
  }

  const booking = isScheduledMarketplaceBookingOpenForInvitation(trip, nowMs);
  if (!booking.open) {
    return { ok: false, reason: booking.reason };
  }

  return evaluateDriverNewWorkInvitationEligibility(supabase, args.driverId);
}

/** Safe log fields only — never document filenames, phones, or tokens. */
export function newWorkInvitationSuppressionLogFields(args: {
  reason: NewWorkInvitationDenyReason;
  driverId?: string | null;
  tripId?: string | null;
  layer: string;
}): Record<string, string | undefined> {
  const driverId = args.driverId ? String(args.driverId) : "";
  const tripId = args.tripId ? String(args.tripId) : "";
  return {
    layer: args.layer,
    reason: args.reason,
    driver_suffix: driverId ? driverId.slice(-4) : undefined,
    trip_suffix: tripId ? tripId.slice(-4) : undefined,
  };
}
