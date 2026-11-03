/**
 * Make Available → Scheduled Jobs marketplace alert.
 * List-only (not NRO). Fan-out to drivers in the trip service area via
 * send-driver-notification (authoritative device only inside that edge).
 */

export type ScheduledMarketplaceNotifyTrip = {
  id: string;
  service_area_id?: string | null;
  pickup_address?: string | null;
  scheduled_at?: string | null;
  trip_code?: string | null;
  trip_number?: string | null;
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

/**
 * Notify eligible drivers that a scheduled job is on the Requested tab.
 * Never creates ride_offers / NRO.
 */
export async function notifyScheduledMarketplaceOpen(
  supabase: AnySupabase,
  trip: ScheduledMarketplaceNotifyTrip,
): Promise<{ notified: number; driverIds: string[] }> {
  const serviceAreaId = trip.service_area_id ? String(trip.service_area_id).trim() : "";
  if (!serviceAreaId) {
    return { notified: 0, driverIds: [] };
  }

  const { data: primaryRows, error: primaryErr } = await supabase
    .from("drivers")
    .select("id")
    .eq("service_area_id", serviceAreaId)
    .eq("approval_status", "approved")
    .limit(SCHEDULED_MARKETPLACE_NOTIFY_DRIVER_CAP);

  if (primaryErr) {
    console.warn("[scheduledMarketplaceNotify] primary drivers query failed:", primaryErr);
  }

  const { data: junctionRows, error: junctionErr } = await supabase
    .from("driver_service_areas")
    .select("driver_id")
    .eq("service_area_id", serviceAreaId)
    .limit(SCHEDULED_MARKETPLACE_NOTIFY_DRIVER_CAP);

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

  const driverIds = [...ids].slice(0, SCHEDULED_MARKETPLACE_NOTIFY_DRIVER_CAP);
  if (driverIds.length === 0) {
    return { notified: 0, driverIds: [] };
  }

  const push = buildScheduledMarketplacePushPayload(trip);
  let notified = 0;
  for (const driverId of driverIds) {
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

  return { notified, driverIds };
}
