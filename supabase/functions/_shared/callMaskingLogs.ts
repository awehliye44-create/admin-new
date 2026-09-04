import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { DISCONNECT_REASON, MAX_CALL_DURATION_SEC } from "./callMaskingConfig.ts";

export type CallLogContext = {
  booking_id: string;
  session_id: string;
  caller: string;
  destination: string;
  session_id_msg91?: string | null;
  call_start?: string;
  call_end?: string | null;
  disconnect_reason?: string | null;
  msg91_uuid?: string | null;
  duration_seconds?: number | null;
};

export function logCallEvent(event: string, ctx: CallLogContext) {
  console.log(`[call-masking] ${event}`, JSON.stringify(ctx));
}

export async function createCallLog(
  client: SupabaseClient,
  row: {
    session_id: string;
    booking_id: string;
    caller_e164: string;
    destination_e164: string;
    msg91_request_id?: string | null;
  },
): Promise<{ id: string } | null> {
  const callStart = new Date().toISOString();
  const expiresAt = new Date(
    Date.parse(callStart) + MAX_CALL_DURATION_SEC * 1000,
  ).toISOString();
  const { data, error } = await client
    .from("call_masking_call_logs")
    .insert({
      session_id: row.session_id,
      booking_id: row.booking_id,
      caller_e164: row.caller_e164,
      destination_e164: row.destination_e164,
      msg91_request_id: row.msg91_request_id ?? null,
      call_start: callStart,
      expires_at: expiresAt,
      status: "active",
    })
    .select("id")
    .single();

  if (error || !data) {
    console.error("[call-masking] call log insert error:", error);
    return null;
  }

  logCallEvent("call_start", {
    booking_id: row.booking_id,
    session_id: row.session_id,
    caller: row.caller_e164,
    destination: row.destination_e164,
    session_id_msg91: row.msg91_request_id ?? null,
    call_start: callStart,
    call_end: null,
    disconnect_reason: null,
  });

  return data;
}

export async function finalizeCallLog(
  client: SupabaseClient,
  logId: string,
  patch: {
    call_end: string;
    duration_seconds?: number | null;
    disconnect_reason: string;
    msg91_uuid?: string | null;
    msg91_request_id?: string | null;
    status?: string;
  },
) {
  const { data: existing } = await client
    .from("call_masking_call_logs")
    .select("booking_id, session_id, caller_e164, destination_e164, call_start, msg91_request_id")
    .eq("id", logId)
    .maybeSingle();

  const { error } = await client
    .from("call_masking_call_logs")
    .update({
      call_end: patch.call_end,
      duration_seconds: patch.duration_seconds ?? null,
      disconnect_reason: patch.disconnect_reason,
      msg91_uuid: patch.msg91_uuid ?? null,
      msg91_request_id: patch.msg91_request_id ?? undefined,
      status: patch.status ?? "disconnected",
    })
    .eq("id", logId);

  if (error) {
    console.error("[call-masking] call log finalize error:", error);
    return;
  }

  if (existing) {
    logCallEvent("call_end", {
      booking_id: existing.booking_id,
      session_id: existing.session_id,
      caller: existing.caller_e164,
      destination: existing.destination_e164,
      session_id_msg91: patch.msg91_request_id ?? existing.msg91_request_id,
      call_start: existing.call_start,
      call_end: patch.call_end,
      disconnect_reason: patch.disconnect_reason,
      msg91_uuid: patch.msg91_uuid ?? null,
      duration_seconds: patch.duration_seconds ?? null,
    });
  }
}

export function mapMsg91ReportToDisconnectReason(
  status: string | undefined,
  failureReason: string | undefined,
  durationSec: number,
): string {
  if (durationSec >= MAX_CALL_DURATION_SEC) {
    return DISCONNECT_REASON.CALL_DURATION_LIMIT_REACHED;
  }
  const normalized = (status ?? "").toLowerCase();
  const failure = (failureReason ?? "").toLowerCase();
  if (normalized.includes("busy") || failure.includes("busy")) {
    return DISCONNECT_REASON.CALL_BUSY;
  }
  if (normalized.includes("no") && normalized.includes("answer")) {
    return DISCONNECT_REASON.CALL_NO_ANSWER;
  }
  if (normalized.includes("fail") || failure) {
    return DISCONNECT_REASON.CALL_FAILED;
  }
  if (normalized.includes("cancel")) {
    return DISCONNECT_REASON.CALL_CANCELLED;
  }
  return DISCONNECT_REASON.CALL_COMPLETED;
}
