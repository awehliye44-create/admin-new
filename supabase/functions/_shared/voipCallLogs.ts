import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { RoomServiceClient } from "npm:livekit-server-sdk@2.9.1";

export const VOIP_END_REASON = {
  MAX_DURATION: "CALL_DURATION_LIMIT_REACHED",
  PARTICIPANT_LEFT: "CALL_COMPLETED",
  CLIENT_ENDED: "CLIENT_ENDED",
  ROOM_DELETED: "ROOM_DELETED",
  SUPERSEDED: "SUPERSEDED",
} as const;

export async function startVoipCallLog(
  client: SupabaseClient,
  row: {
    trip_id: string;
    service_area_id: string | null;
    driver_id: string | null;
    customer_id: string | null;
  },
): Promise<string | null> {
  const now = new Date().toISOString();

  await client
    .from("voip_call_logs")
    .update({
      status: "disconnected",
      ended_at: now,
      end_reason: VOIP_END_REASON.SUPERSEDED,
    })
    .eq("trip_id", row.trip_id)
    .eq("status", "active")
    .is("ended_at", null);

  const { data, error } = await client
    .from("voip_call_logs")
    .insert({
      trip_id: row.trip_id,
      service_area_id: row.service_area_id,
      driver_id: row.driver_id,
      customer_id: row.customer_id,
      status: "active",
      provider: "livekit",
      started_at: now,
    })
    .select("id")
    .single();

  if (error || !data) {
    console.error("[voipCallLogs] insert failed", error);
    return null;
  }

  return data.id;
}

export async function finalizeVoipCallLog(
  client: SupabaseClient,
  logId: string,
  patch: {
    duration_seconds: number;
    end_reason: string;
    status?: string;
  },
) {
  const { data: existing } = await client
    .from("voip_call_logs")
    .select("id, status, started_at")
    .eq("id", logId)
    .maybeSingle();

  if (!existing || existing.status !== "active") return;

  await client
    .from("voip_call_logs")
    .update({
      ended_at: new Date().toISOString(),
      duration_seconds: patch.duration_seconds,
      end_reason: patch.end_reason,
      status: patch.status ?? (
        patch.end_reason === VOIP_END_REASON.PARTICIPANT_LEFT ||
          patch.end_reason === VOIP_END_REASON.CLIENT_ENDED
          ? "completed"
          : "disconnected"
      ),
    })
    .eq("id", logId);
}

export function scheduleVoipMaxDurationEnforcement(
  client: SupabaseClient,
  opts: {
    logId: string;
    roomName: string;
    maxSeconds: number;
    livekitUrl: string;
    livekitApiKey: string;
    livekitApiSecret: string;
  },
) {
  const task = async () => {
    await new Promise((resolve) => setTimeout(resolve, opts.maxSeconds * 1000));

    const { data: log } = await client
      .from("voip_call_logs")
      .select("id, status, started_at")
      .eq("id", opts.logId)
      .maybeSingle();

    if (!log || log.status !== "active") return;

    try {
      const roomClient = new RoomServiceClient(
        opts.livekitUrl,
        opts.livekitApiKey,
        opts.livekitApiSecret,
      );
      await roomClient.deleteRoom(opts.roomName);
    } catch (error) {
      console.warn("[voipCallLogs] deleteRoom failed", error);
    }

    const startedMs = new Date(log.started_at).getTime();
    const duration = Math.min(
      opts.maxSeconds,
      Math.max(0, Math.floor((Date.now() - startedMs) / 1000)),
    );

    await finalizeVoipCallLog(client, opts.logId, {
      duration_seconds: duration,
      end_reason: VOIP_END_REASON.MAX_DURATION,
      status: "disconnected",
    });
  };

  // @ts-ignore Supabase edge runtime
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
    // @ts-ignore
    EdgeRuntime.waitUntil(task());
  } else {
    task().catch((error) => console.error("[voipCallLogs] enforcement error", error));
  }
}
