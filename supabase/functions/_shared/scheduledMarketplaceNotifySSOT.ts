/**
 * Make Available → Scheduled Jobs marketplace alert.
 * List-only (not NRO). Fan-out to drivers in the trip service area via
 * send-driver-notification (authoritative device only inside that edge).
 *
 * MK-261105-002 / MK0009: recipients must pass shared new-work invitation
 * eligibility (live docs + active/approved). Offline drivers may still be
 * invited. Send path re-checks in send-driver-notification.
 */

import {
  evaluateDriverNewWorkInvitationEligibility,
  isScheduledMarketplaceBookingOpenForInvitation,
  newWorkInvitationSuppressionLogFields,
  type NewWorkInvitationDenyReason,
} from "./newWorkInvitationEligibilitySSOT.ts";

export type ScheduledMarketplaceNotifyTrip = {
  id: string;
  service_area_id?: string | null;
  pickup_address?: string | null;
  scheduled_at?: string | null;
  trip_code?: string | null;
  trip_number?: string | null;
  dispatch_mode?: string | null;
  scheduled_status?: string | null;
  status?: string | null;
  scheduled_broadcast_at?: string | null;
  driver_id?: string | null;
  confirmed_driver_id?: string | null;
};

type AnySupabase = {
  from: (table: string) => any;
  functions: { invoke: (name: string, opts: { body: Record<string, unknown> }) => Promise<unknown> };
};

/** Cap fan-out per publish — avoids accidental mass spam. */
export const SCHEDULED_MARKETPLACE_NOTIFY_DRIVER_CAP = 80;

export function buildScheduledMarketplacePushPayload(trip: ScheduledMarketplaceNotifyTrip): {
  type: string;
  title: string;
  body: string;
  data: Record<string, string>;
} {
  const pickup = String(trip.pickup_address ?? "").trim() || "pickup";
  const when = trip.scheduled_at
    ? new Date(trip.scheduled_at).toLocaleString("en-GB", {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Europe/London",
    })
    : "scheduled time";
  const code = String(trip.trip_code ?? trip.trip_number ?? "").trim();
  return {
    type: "SCHEDULED_RIDE_REQUEST",
    title: "Scheduled ride available",
    body: code
      ? `${code} · Open Scheduled Jobs to Accept · ${pickup} · ${when}`
      : `Open Scheduled Jobs to Accept · ${pickup} · ${when}`,
    data: {
      type: "scheduled_ride_request",
      trip_id: trip.id,
      open_scheduled_jobs: "true",
      pickup_address: pickup,
      scheduled_at: String(trip.scheduled_at ?? ""),
    },
  };
}

async function filterEligibleMarketplaceRecipients(
  supabase: AnySupabase,
  candidateIds: string[],
): Promise<{ eligibleIds: string[]; suppressed: Array<{ driverId: string; reason: NewWorkInvitationDenyReason }> }> {
  const eligibleIds: string[] = [];
  const suppressed: Array<{ driverId: string; reason: NewWorkInvitationDenyReason }> = [];

  for (const driverId of candidateIds) {
    const gate = await evaluateDriverNewWorkInvitationEligibility(supabase, driverId);
    if (!gate.ok) {
      suppressed.push({ driverId, reason: gate.reason });
      console.warn(
        "[scheduledMarketplaceNotify] recipient_suppressed",
        newWorkInvitationSuppressionLogFields({
          layer: "marketplace_recipient_select",
          reason: gate.reason,
          driverId,
        }),
      );
      continue;
    }
    eligibleIds.push(driverId);
  }

  return { eligibleIds, suppressed };
}

/**
 * Notify eligible drivers that a scheduled job is on the Requested tab.
 * Never creates ride_offers / NRO.
 */
export async function notifyScheduledMarketplaceOpen(
  supabase: AnySupabase,
  trip: ScheduledMarketplaceNotifyTrip,
): Promise<{ notified: number; driverIds: string[]; suppressed: number }> {
  const booking = isScheduledMarketplaceBookingOpenForInvitation(trip);
  if (!booking.open) {
    console.warn(
      "[scheduledMarketplaceNotify] booking_not_open",
      newWorkInvitationSuppressionLogFields({
        layer: "marketplace_booking_gate",
        reason: booking.reason,
        tripId: trip.id,
      }),
    );
    return { notified: 0, driverIds: [], suppressed: 0 };
  }

  const serviceAreaId = trip.service_area_id ? String(trip.service_area_id).trim() : "";
  if (!serviceAreaId) {
    return { notified: 0, driverIds: [], suppressed: 0 };
  }

  // Broad candidate pool — eligibility applied after union (primary + junction).
  // Do not filter only on approval_status here; shared gate is authoritative.
  const { data: primaryRows, error: primaryErr } = await supabase
    .from("drivers")
    .select("id")
    .eq("service_area_id", serviceAreaId)
    .limit(SCHEDULED_MARKETPLACE_NOTIFY_DRIVER_CAP * 2);

  if (primaryErr) {
    console.warn("[scheduledMarketplaceNotify] primary drivers query failed:", primaryErr);
  }

  const { data: junctionRows, error: junctionErr } = await supabase
    .from("driver_service_areas")
    .select("driver_id")
    .eq("service_area_id", serviceAreaId)
    .limit(SCHEDULED_MARKETPLACE_NOTIFY_DRIVER_CAP * 2);

  if (junctionErr) {
    console.warn("[scheduledMarketplaceNotify] junction drivers query failed:", junctionErr);
  }

  const ids = new Set<string>();
  for (const row of primaryRows ?? []) {
    const id = String((row as { id?: string }).id ?? "").trim();
    if (id) ids.add(id);
  }
  for (const row of junctionRows ?? []) {
    const id = String((row as { driver_id?: string }).driver_id ?? "").trim();
    if (id) ids.add(id);
  }

  const candidateIds = [...ids].slice(0, SCHEDULED_MARKETPLACE_NOTIFY_DRIVER_CAP * 2);
  const { eligibleIds, suppressed } = await filterEligibleMarketplaceRecipients(
    supabase,
    candidateIds,
  );
  const driverIds = eligibleIds.slice(0, SCHEDULED_MARKETPLACE_NOTIFY_DRIVER_CAP);
  if (driverIds.length === 0) {
    return { notified: 0, driverIds: [], suppressed: suppressed.length };
  }

  const push = buildScheduledMarketplacePushPayload(trip);
  let notified = 0;
  for (const driverId of driverIds) {
    // Immediate pre-send recheck (eligibility may change after selection).
    const recheck = await evaluateDriverNewWorkInvitationEligibility(supabase, driverId);
    if (!recheck.ok) {
      console.warn(
        "[scheduledMarketplaceNotify] pre_send_suppressed",
        newWorkInvitationSuppressionLogFields({
          layer: "marketplace_pre_send",
          reason: recheck.reason,
          driverId,
          tripId: trip.id,
        }),
      );
      continue;
    }

    try {
      const result = await supabase.functions.invoke("send-driver-notification", {
        body: {
          driverId,
          type: push.type,
          title: push.title,
          body: push.body,
          data: push.data,
        },
      }) as { error?: unknown } | null | undefined;
      if (result && typeof result === "object" && result.error) {
        console.warn(
          "[scheduledMarketplaceNotify] push rejected:",
          driverId.slice(-4),
          result.error,
        );
        continue;
      }
      notified += 1;
    } catch (err) {
      console.warn("[scheduledMarketplaceNotify] push failed:", driverId.slice(-4), err);
    }
  }

  return { notified, driverIds, suppressed: suppressed.length };
}
