/**
 * Foreground Scheduled Jobs live sync — Realtime Broadcast (no passenger PII).
 *
 * Channel: scheduled-marketplace:{serviceAreaId}
 * Event:   scheduled_marketplace_changed
 *
 * Drivers subscribe per service area and soft-refresh the authoritative
 * list_driver_own_scheduled_jobs RPC. Payload is invalidate-only.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";

export const SCHEDULED_MARKETPLACE_REALTIME_EVENT = "scheduled_marketplace_changed";

export type ScheduledMarketplaceRealtimeReason =
  | "published"
  | "accepted"
  | "cancelled"
  | "converted"
  | "expired"
  | "eligibility";

export function scheduledMarketplaceRealtimeChannel(serviceAreaId: string): string {
  return `scheduled-marketplace:${String(serviceAreaId).trim()}`;
}

export function buildScheduledMarketplaceRealtimePayload(input: {
  tripId: string;
  serviceAreaId: string;
  reason: ScheduledMarketplaceRealtimeReason;
}): Record<string, string> {
  return {
    trip_id: String(input.tripId),
    service_area_id: String(input.serviceAreaId),
    reason: input.reason,
  };
}

/**
 * Best-effort broadcast. Failures must never block publish / accept / cancel.
 */
export async function broadcastScheduledMarketplaceChanged(
  supabase: SupabaseClient | { channel: SupabaseClient["channel"]; removeChannel: SupabaseClient["removeChannel"] },
  input: {
    tripId: string;
    serviceAreaId: string | null | undefined;
    reason: ScheduledMarketplaceRealtimeReason;
  },
): Promise<boolean> {
  const serviceAreaId = String(input.serviceAreaId ?? "").trim();
  const tripId = String(input.tripId ?? "").trim();
  if (!serviceAreaId || !tripId) return false;

  const channelName = scheduledMarketplaceRealtimeChannel(serviceAreaId);
  const payload = buildScheduledMarketplaceRealtimePayload({
    tripId,
    serviceAreaId,
    reason: input.reason,
  });
  // Private topic — clients must set config.private=true; Realtime RLS scopes
  // receive to drivers assigned to this service area.
  const channel = supabase.channel(channelName, {
    config: { private: true },
  });

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };

    const timeout = setTimeout(() => {
      console.warn("[scheduledMarketplaceRealtime] subscribe timeout", channelName);
      void supabase.removeChannel(channel);
      finish(false);
    }, 3000);

    channel.subscribe((status) => {
      if (status !== "SUBSCRIBED") return;
      clearTimeout(timeout);
      void channel
        .send({
          type: "broadcast",
          event: SCHEDULED_MARKETPLACE_REALTIME_EVENT,
          payload,
        })
        .then(() => {
          console.log("[scheduledMarketplaceRealtime] sent", {
            channel: channelName,
            reason: input.reason,
            trip_suffix: tripId.slice(-4),
          });
          finish(true);
        })
        .catch((e) => {
          console.warn("[scheduledMarketplaceRealtime] send failed:", e);
          finish(false);
        })
        .finally(() => {
          void supabase.removeChannel(channel);
        });
    });
  });
}
