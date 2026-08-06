/**
 * Backend rate limits for trip communication start attempts.
 * Limits used (authoritative, not client-enforced):
 * - one active call per trip (unique constraints + adapter)
 * - idempotent repeated start (idempotency key)
 * - cooldown after terminal miss/fail/cancel: 30 seconds
 * - max start attempts per trip per rolling window: 20 / 60 minutes
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { TRIP_COMMUNICATION_ERROR } from "../../../shared/tripCommunicationSsot.ts";

export const TRIP_CALL_RATE_LIMITS = {
  /** Seconds after a failed/missed/cancelled terminal call before a new start is allowed. */
  cooldownAfterTerminalSeconds: 30,
  /** Max VoIP+masking start attempts (created sessions/logs) per trip in the window. */
  maxAttemptsPerWindow: 20,
  /** Rolling window length in seconds. */
  attemptWindowSeconds: 60 * 60,
} as const;

const COOLDOWN_END_STATUSES = new Set([
  "failed",
  "missed",
  "declined",
  "cancelled",
  "timed_out",
  "disconnected",
]);

export type CallRateLimitResult =
  | { ok: true }
  | {
    ok: false;
    errorCode: typeof TRIP_COMMUNICATION_ERROR.RATE_LIMITED;
    message: string;
  };

/**
 * Enforce cooldown + attempt-window limits before creating a new call session.
 * Idempotent reuse of an existing active session must skip this check.
 */
export async function assertTripCallStartAllowed(
  client: SupabaseClient,
  tripId: string,
): Promise<CallRateLimitResult> {
  const nowMs = Date.now();
  const cooldownCutoff = new Date(
    nowMs - TRIP_CALL_RATE_LIMITS.cooldownAfterTerminalSeconds * 1000,
  ).toISOString();
  const windowCutoff = new Date(
    nowMs - TRIP_CALL_RATE_LIMITS.attemptWindowSeconds * 1000,
  ).toISOString();

  const { data: recentVoipTerminal } = await client
    .from("voip_call_logs")
    .select("id, status, ended_at")
    .eq("trip_id", tripId)
    .not("ended_at", "is", null)
    .gte("ended_at", cooldownCutoff)
    .order("ended_at", { ascending: false })
    .limit(5);

  for (const row of recentVoipTerminal ?? []) {
    if (COOLDOWN_END_STATUSES.has(String(row.status))) {
      return {
        ok: false,
        errorCode: TRIP_COMMUNICATION_ERROR.RATE_LIMITED,
        message: "Please wait before starting another call",
      };
    }
  }

  const { data: recentMaskingTerminal } = await client
    .from("call_masking_call_logs")
    .select("id, status, call_end, disconnect_reason")
    .eq("booking_id", tripId)
    .not("call_end", "is", null)
    .gte("call_end", cooldownCutoff)
    .order("call_end", { ascending: false })
    .limit(5);

  for (const row of recentMaskingTerminal ?? []) {
    const reason = String(row.disconnect_reason ?? "").toUpperCase();
    if (
      COOLDOWN_END_STATUSES.has(String(row.status)) ||
      reason.includes("NO_ANSWER") ||
      reason.includes("FAILED") ||
      reason.includes("CANCEL") ||
      reason.includes("BUSY") ||
      reason.includes("DURATION")
    ) {
      return {
        ok: false,
        errorCode: TRIP_COMMUNICATION_ERROR.RATE_LIMITED,
        message: "Please wait before starting another call",
      };
    }
  }

  const { count: voipAttempts } = await client
    .from("voip_call_logs")
    .select("id", { count: "exact", head: true })
    .eq("trip_id", tripId)
    .gte("started_at", windowCutoff);

  const { count: maskingAttempts } = await client
    .from("call_masking_call_logs")
    .select("id", { count: "exact", head: true })
    .eq("booking_id", tripId)
    .gte("call_start", windowCutoff);

  const attempts = (voipAttempts ?? 0) + (maskingAttempts ?? 0);
  if (attempts >= TRIP_CALL_RATE_LIMITS.maxAttemptsPerWindow) {
    return {
      ok: false,
      errorCode: TRIP_COMMUNICATION_ERROR.RATE_LIMITED,
      message: "Call attempt limit reached for this trip",
    };
  }

  return { ok: true };
}
