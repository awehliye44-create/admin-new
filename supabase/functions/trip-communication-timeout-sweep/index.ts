/**
 * Provider-neutral timeout sweep for VoIP + call-masking sessions.
 * Auth: cron secret or service role (assertCronOrServiceRoleAuth).
 */
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { assertCronOrServiceRoleAuth } from "../_shared/cronEdgeAuth.ts";
import { sweepExpiredVoipSessions, VOIP_END_REASON } from "../_shared/voipCallLogs.ts";
import { TRIP_COMMUNICATION_MAX_DURATION_SECONDS } from "../../../shared/tripCommunicationSsot.ts";
import { capDurationSeconds } from "../_shared/tripCallSession.ts";

const MSG91_HANGUP_URLS = [
  "https://control.msg91.com/api/v5/voice/call/hangup",
  "https://control.msg91.com/api/v5/voice/hangup",
  "https://control.msg91.com/api/v5/voice/call/disconnect",
];

async function hangupMsg91Call(opts: {
  authKey: string;
  uuid?: string | null;
  requestId?: string | null;
}): Promise<boolean> {
  const payloads: Record<string, string>[] = [];
  if (opts.uuid) {
    payloads.push({ uuid: opts.uuid, request_id: opts.uuid, id: opts.uuid });
  }
  if (opts.requestId) {
    payloads.push({ call_id: opts.requestId, requestId: opts.requestId });
  }
  if (!payloads.length) return false;

  for (const url of MSG91_HANGUP_URLS) {
    for (const payload of payloads) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            authkey: opts.authKey,
          },
          body: JSON.stringify(payload),
        });
        if (res.ok) return true;
      } catch {
        // try next
      }
    }
  }
  return false;
}

async function sweepExpiredMaskingSessions(
  client: ReturnType<typeof createClient>,
  limit = 20,
): Promise<{ scanned: number; terminated: number }> {
  const authKey = Deno.env.get("MSG91_AUTH_KEY")?.trim();
  const nowIso = new Date().toISOString();

  const { data: rows } = await client
    .from("call_masking_call_logs")
    .select(
      "id, booking_id, call_start, connected_at, expires_at, msg91_uuid, msg91_request_id, termination_attempted_at, session_id",
    )
    .eq("status", "active")
    .is("call_end", null)
    .lte("expires_at", nowIso)
    .order("expires_at", { ascending: true })
    .limit(limit);

  let terminated = 0;
  for (const row of rows ?? []) {
    if (!row.termination_attempted_at) {
      await client
        .from("call_masking_call_logs")
        .update({ termination_attempted_at: new Date().toISOString() })
        .eq("id", row.id)
        .is("termination_attempted_at", null);
    }

    if (authKey) {
      await hangupMsg91Call({
        authKey,
        uuid: row.msg91_uuid,
        requestId: row.msg91_request_id,
      });
    }

    const baseMs = new Date(row.connected_at ?? row.call_start ?? Date.now()).getTime();
    const duration = capDurationSeconds(
      Math.floor((Date.now() - baseMs) / 1000),
      TRIP_COMMUNICATION_MAX_DURATION_SECONDS,
    );

    const { data: updated } = await client
      .from("call_masking_call_logs")
      .update({
        status: "timed_out",
        call_end: new Date().toISOString(),
        duration_seconds: duration,
        disconnect_reason: VOIP_END_REASON.MAX_DURATION,
      })
      .eq("id", row.id)
      .eq("status", "active")
      .is("call_end", null)
      .select("id")
      .maybeSingle();

    if (updated?.id) {
      terminated += 1;
      try {
        const { sendCallEndedPush } = await import("../_shared/incomingCallPush.ts");
        let driverId: string | null = null;
        let customerUserId: string | null = null;
        if (row.session_id) {
          const { data: session } = await client
            .from("call_masking_sessions")
            .select("driver_id, customer_id, customer_phone")
            .eq("id", row.session_id)
            .maybeSingle();
          driverId = session?.driver_id ?? null;
          if (session?.customer_id) {
            const { data: cust } = await client
              .from("customers")
              .select("user_id")
              .or(`id.eq.${session.customer_id},user_id.eq.${session.customer_id}`)
              .limit(1)
              .maybeSingle();
            customerUserId = cust?.user_id ?? String(session.customer_id);
          }
        }
        await sendCallEndedPush(client, {
          tripId: String(row.booking_id ?? ""),
          callId: row.id,
          method: "call_masking",
          endReason: VOIP_END_REASON.MAX_DURATION,
          driverId,
          customerUserId,
        });
      } catch {
        // ignore
      }
    }
  }

  return { scanned: rows?.length ?? 0, terminated };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers":
          "authorization, x-client-info, apikey, content-type, x-onecab-cron-secret",
      },
    });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "METHOD_NOT_ALLOWED" }), { status: 405 });
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const auth = await assertCronOrServiceRoleAuth(req, body);
  if (!auth.ok) return auth.response;

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const client = createClient(supabaseUrl, serviceKey);

  const livekitUrl = Deno.env.get("LIVEKIT_URL") ?? "";
  const livekitApiKey = Deno.env.get("LIVEKIT_API_KEY") ?? "";
  const livekitApiSecret = Deno.env.get("LIVEKIT_API_SECRET") ?? "";

  const voip = livekitUrl && livekitApiKey && livekitApiSecret
    ? await sweepExpiredVoipSessions(client, {
      livekitUrl,
      livekitApiKey,
      livekitApiSecret,
      limit: 20,
    })
    : { scanned: 0, terminated: 0 };

  const masking = await sweepExpiredMaskingSessions(client, 20);

  return new Response(
    JSON.stringify({
      ok: true,
      max_duration_seconds: TRIP_COMMUNICATION_MAX_DURATION_SECONDS,
      voip,
      call_masking: masking,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});
