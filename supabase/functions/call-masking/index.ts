import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  handleCORSPreflight,
  successResponse,
  errorResponse,
  validationErrorResponse,
  isValidUUID,
} from "../_shared/security.ts";
import {
  CALLABLE_TRIP_STATUSES,
  DISCONNECT_REASON,
  IMMEDIATE_MASKING_EXPIRY_STATUSES,
  isCallableTripStatus,
  TERMINAL_TRIP_STATUSES,
} from "../_shared/callMaskingConfig.ts";
import {
  createCallLog,
  finalizeCallLog,
  logCallEvent,
  mapMsg91ReportToDisconnectReason,
} from "../_shared/callMaskingLogs.ts";
import { opsLog } from "../_shared/opsLog.ts";
import {
  normalizePhoneE164Digits,
  phonesMatch,
  pickInboundMaskingSession,
  resolveCallRoute,
  toE164,
} from "../_shared/callMaskingPhones.ts";
import {
  assertCallMaskingAllowed,
  DEFAULT_MAX_CALL_DURATION_SECONDS,
  isTripDriverParticipant,
  loadTripCommunicationRuntimeContext,
} from "../_shared/serviceAreaCommunicationLookup.ts";

const MSG91_API_URL = "https://control.msg91.com/api/v5/voice/call/ctc";
const MSG91_HANGUP_URLS = [
  "https://control.msg91.com/api/v5/voice/call/hangup",
  "https://control.msg91.com/api/v5/voice/hangup",
  "https://control.msg91.com/api/v5/voice/call/disconnect",
];

const CALLABLE_STATUSES = CALLABLE_TRIP_STATUSES;

type SessionRow = {
  id: string;
  trip_id: string;
  caller_id: string | null;
  expires_at: string | null;
  msg91_request_id?: string | null;
  status: string;
  driver_id: string;
  customer_id: string | null;
  driver_phone: string;
  customer_phone: string;
};

type TripRow = {
  id: string;
  confirmed_driver_id: string | null;
  passenger_id: string | null;
  passenger_phone: string | null;
  status: string;
  completed_at: string | null;
  service_area_id: string | null;
};

function sessionPayload(
  session: {
    id: string;
    caller_id: string | null;
    expires_at: string | null;
    msg91_request_id?: string | null;
  } | null,
  virtualNumber: string,
) {
  if (!session) return null;
  const masked = session.caller_id ?? virtualNumber;
  return {
    id: session.id,
    masked_number: masked,
    caller_id: masked,
    msg91_virtual_number: masked,
    msg91_session_id: session.msg91_request_id ?? null,
    expires_at: session.expires_at,
  };
}

function isServiceRoleRequest(authHeader: string | null): boolean {
  if (!authHeader?.startsWith("Bearer ")) return false;
  const token = authHeader.slice(7);
  try {
    const payload = JSON.parse(atob(token.split(".")[1] ?? ""));
    return payload?.role === "service_role";
  } catch {
    return false;
  }
}

function msg91ErrorMessage(body: Record<string, unknown>): string {
  const errors = body.errors;
  if (errors && typeof errors === "object") {
    const parts: string[] = [];
    for (const [field, value] of Object.entries(errors as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        parts.push(`${field}: ${value.join(", ")}`);
      } else if (typeof value === "string") {
        parts.push(`${field}: ${value}`);
      }
    }
    if (parts.length) return parts.join("; ");
  }

  const candidates = [body.message, body.error, body.msg, body.description, body.reason];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "Failed to initiate masked call";
}

function isSessionValidForTrip(session: SessionRow, trip: TripRow): boolean {
  if (session.status !== "active") return false;
  return isCallableTripStatus(trip.status);
}

function canInitiateCall(trip: TripRow, session: SessionRow | null): boolean {
  if (!session || session.status !== "active") return false;
  return isCallableTripStatus(trip.status);
}

/**
 * MSG91 v5 CTC: ring caller first, bridge destinationB after answer.
 * max_call_duration requests a 4-minute cap (honoured when supported by MSG91 account).
 */
function buildMsg91Payload(
  cleanCallerId: string,
  cleanCaller: string,
  cleanDestination: string,
  callLogId: string,
  maxCallDurationSec: number,
) {
  return {
    caller_id: cleanCallerId,
    destinationA: cleanCaller,
    destination: cleanCaller,
    destinationB: [cleanDestination],
    max_call_duration: maxCallDurationSec,
    CRQID: `onecab:${callLogId}`,
  };
}

type HangupAttempt = {
  url: string;
  payload: Record<string, string>;
  status: number;
  ok: boolean;
  body: string;
};

async function hangupMsg91CallDetailed(
  authKey: string,
  uuid: string,
): Promise<{ ok: boolean; attempts: HangupAttempt[] }> {
  const attempts: HangupAttempt[] = [];
  const payloads: Record<string, string>[] = [
    { uuid, request_id: uuid, id: uuid },
    { call_id: uuid },
    { requestId: uuid },
  ];

  for (const url of MSG91_HANGUP_URLS) {
    for (const payload of payloads) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            authkey: authKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });
        const body = await response.text();
        const attempt = {
          url,
          payload,
          status: response.status,
          ok: response.ok,
          body: body.slice(0, 500),
        };
        attempts.push(attempt);
        if (response.ok) {
          console.log("[call-masking] MSG91 hangup ok", attempt);
          return { ok: true, attempts };
        }
        console.warn("[call-masking] MSG91 hangup rejected", attempt);
      } catch (err) {
        attempts.push({
          url,
          payload,
          status: 0,
          ok: false,
          body: String(err),
        });
      }
    }
  }

  return { ok: false, attempts };
}

async function hangupMsg91Call(authKey: string, uuid: string): Promise<boolean> {
  const result = await hangupMsg91CallDetailed(authKey, uuid);
  return result.ok;
}

function scheduleCallDurationLimit(
  serviceClient: ReturnType<typeof createClient>,
  authKey: string,
  logId: string,
  msg91Uuid: string | null,
  maxCallDurationSec: number,
) {
  const waitMs = maxCallDurationSec * 1000;
  const task = async () => {
    await new Promise((resolve) => setTimeout(resolve, waitMs));

    const { data: log } = await serviceClient
      .from("call_masking_call_logs")
      .select("id, status, msg91_uuid, msg91_request_id, booking_id, session_id, caller_e164, destination_e164, call_start")
      .eq("id", logId)
      .maybeSingle();

    if (!log || log.status !== "active") return;

    const uuid = msg91Uuid ?? log.msg91_uuid ?? log.msg91_request_id;
    if (uuid) {
      await hangupMsg91Call(authKey, uuid);
    }

    const callEnd = new Date().toISOString();
    await finalizeCallLog(serviceClient, logId, {
      call_end: callEnd,
      duration_seconds: maxCallDurationSec,
      disconnect_reason: DISCONNECT_REASON.CALL_DURATION_LIMIT_REACHED,
      msg91_uuid: uuid,
      status: "disconnected",
    });
  };

  // @ts-ignore Supabase edge runtime
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
    // @ts-ignore
    EdgeRuntime.waitUntil(task());
  } else {
    task().catch((err) => console.error("[call-masking] duration limit task error", err));
  }
}

/** When user manually dials the virtual number, MSG91 route-inbound fires — record + cap duration. */
async function ensureInboundCallLog(
  serviceClient: ReturnType<typeof createClient>,
  authKey: string,
  sessionId: string,
  tripId: string,
  route: { caller: string; destination: string },
  maxCallDurationSec: number,
  msg91Uuid?: string | null,
): Promise<string | null> {
  const { data: existing } = await serviceClient
    .from("call_masking_call_logs")
    .select("id, msg91_uuid, msg91_request_id, status")
    .eq("session_id", sessionId)
    .eq("status", "active")
    .maybeSingle();

  if (existing?.id) {
    const uuid = msg91Uuid ?? existing.msg91_uuid ?? existing.msg91_request_id;
    if (msg91Uuid && !existing.msg91_uuid) {
      await serviceClient
        .from("call_masking_call_logs")
        .update({ msg91_uuid: msg91Uuid, msg91_request_id: msg91Uuid })
        .eq("id", existing.id);
    }
    scheduleCallDurationLimit(serviceClient, authKey, existing.id, uuid ?? null, maxCallDurationSec);
    return existing.id;
  }

  const callLog = await createCallLog(serviceClient, {
    session_id: sessionId,
    booking_id: tripId,
    caller_e164: route.caller,
    destination_e164: route.destination,
    msg91_request_id: msg91Uuid ?? null,
  });

  if (!callLog) return null;

  if (msg91Uuid) {
    await serviceClient
      .from("call_masking_call_logs")
      .update({ msg91_uuid: msg91Uuid, msg91_request_id: msg91Uuid })
      .eq("id", callLog.id);
  }

  scheduleCallDurationLimit(serviceClient, authKey, callLog.id, msg91Uuid ?? null, maxCallDurationSec);
  return callLog.id;
}

async function callMsg91(
  authKey: string,
  callerId: string,
  callerPhone: string,
  destinationPhone: string,
  callLogId: string,
  maxCallDurationSec = DEFAULT_MAX_CALL_DURATION_SECONDS,
) {
  const cleanCaller = normalizePhoneE164Digits(callerPhone);
  const cleanDestination = normalizePhoneE164Digits(destinationPhone);
  const cleanCallerId = normalizePhoneE164Digits(callerId);

  if (cleanCaller.length < 8 || cleanDestination.length < 8) {
    return {
      ok: false as const,
      status: 400,
      body: { error: "INVALID_PHONE", message: "Phone numbers are too short for masked calling" },
    };
  }

  if (cleanCaller === cleanDestination) {
    return {
      ok: false as const,
      status: 400,
      body: {
        error: "SAME_PHONE",
        message: "Caller and destination resolve to the same number — cannot bridge",
      },
    };
  }

  const payload = buildMsg91Payload(
    cleanCallerId,
    cleanCaller,
    cleanDestination,
    callLogId,
    maxCallDurationSec,
  );
  console.log("[call-masking] MSG91 payload:", JSON.stringify({
    ...payload,
    destinationB: payload.destinationB,
  }));

  const response = await fetch(MSG91_API_URL, {
    method: "POST",
    headers: {
      authkey: authKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  let body: Record<string, unknown> = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }

  console.log("[call-masking] MSG91 response:", response.status, JSON.stringify(body));
  return { ok: response.ok, status: response.status, body };
}

async function expireDueSessions(serviceClient: ReturnType<typeof createClient>) {
  const { error } = await serviceClient.rpc("expire_due_call_masking_sessions");
  if (error) {
    console.warn("[call-masking] expire_due_call_masking_sessions rpc error:", error);
  }
}

/** Expire sessions for terminal trips and stale driver assignments (safety net). */
/** Finalize active logs past max duration (backup when EdgeRuntime.waitUntil does not run). */
async function sweepOverdueActiveCallLogs(
  serviceClient: ReturnType<typeof createClient>,
  authKey: string,
) {
  const cutoff = new Date(Date.now() - 7200 * 1000).toISOString();
  const { data: overdue, error } = await serviceClient
    .from("call_masking_call_logs")
    .select("id, msg91_uuid, msg91_request_id, call_start")
    .eq("status", "active")
    .lt("call_start", cutoff)
    .limit(50);

  if (error || !overdue?.length) return;

  for (const log of overdue) {
    const uuid = log.msg91_uuid ?? log.msg91_request_id;
    if (uuid) await hangupMsg91Call(authKey, uuid);

    const startedMs = new Date(log.call_start).getTime();
    const duration = Math.min(
      DEFAULT_MAX_CALL_DURATION_SECONDS,
      Math.max(0, Math.floor((Date.now() - startedMs) / 1000)),
    );

    await finalizeCallLog(serviceClient, log.id, {
      call_end: new Date().toISOString(),
      duration_seconds: duration,
      disconnect_reason: DISCONNECT_REASON.CALL_DURATION_LIMIT_REACHED,
      msg91_uuid: uuid,
      status: "disconnected",
    });
  }

  console.log("[call-masking] swept overdue active call logs", { count: overdue.length });
}

/** Hang up prior bridged calls for a session before starting a new CTC attempt. */
async function hangupActiveSessionCalls(
  serviceClient: ReturnType<typeof createClient>,
  authKey: string,
  sessionId: string,
) {
  const { data: active, error } = await serviceClient
    .from("call_masking_call_logs")
    .select("id, msg91_uuid, msg91_request_id, call_start")
    .eq("session_id", sessionId)
    .eq("status", "active");

  if (error || !active?.length) return;

  for (const log of active) {
    const uuid = log.msg91_uuid ?? log.msg91_request_id;
    if (uuid) await hangupMsg91Call(authKey, uuid);

    const startedMs = new Date(log.call_start).getTime();
    const duration = Math.max(0, Math.floor((Date.now() - startedMs) / 1000));

    await finalizeCallLog(serviceClient, log.id, {
      call_end: new Date().toISOString(),
      duration_seconds: duration,
      disconnect_reason: DISCONNECT_REASON.CALL_CANCELLED,
      msg91_uuid: uuid,
      status: "disconnected",
    });
  }

  console.log("[call-masking] hung up prior active session calls", {
    session_id: sessionId,
    count: active.length,
  });
}

async function expireStaleMaskingSessions(serviceClient: ReturnType<typeof createClient>) {
  const { data: activeSessions, error } = await serviceClient
    .from("call_masking_sessions")
    .select("id, trip_id, driver_id, status")
    .eq("status", "active")
    .limit(200);

  if (error || !activeSessions?.length) return;

  const tripIds = [...new Set(activeSessions.map((s) => s.trip_id))];
  const { data: trips } = await serviceClient
    .from("trips")
    .select("id, status, confirmed_driver_id")
    .in("id", tripIds);

  const tripById = new Map((trips ?? []).map((t) => [t.id, t]));
  const toExpire: string[] = [];

  for (const session of activeSessions) {
    const trip = tripById.get(session.trip_id);
    if (!trip) {
      toExpire.push(session.id);
      continue;
    }
    if (IMMEDIATE_MASKING_EXPIRY_STATUSES.has(trip.status)) {
      toExpire.push(session.id);
      continue;
    }
    if (trip.confirmed_driver_id && session.driver_id !== trip.confirmed_driver_id) {
      toExpire.push(session.id);
    }
  }

  if (!toExpire.length) return;

  const now = new Date().toISOString();
  const { error: expireError } = await serviceClient
    .from("call_masking_sessions")
    .update({ status: "expired", expires_at: now, updated_at: now })
    .in("id", toExpire);

  if (expireError) {
    console.warn("[call-masking] expireStaleMaskingSessions error:", expireError);
  } else {
    console.log("[call-masking] expired stale masking sessions", { count: toExpire.length });
  }
}

function verifyWebhookSecret(
  req: Request,
  body: Record<string, unknown>,
): boolean {
  const webhookSecret = Deno.env.get("MSG91_WEBHOOK_SECRET");
  const provided =
    req.headers.get("x-msg91-webhook-secret") ||
    (body.webhook_secret as string | undefined);
  return Boolean(webhookSecret && provided === webhookSecret);
}

async function handleCallReport(
  serviceClient: ReturnType<typeof createClient>,
  body: Record<string, unknown>,
) {
  const uuid = (body.uuid || body.request_id || body.requestId) as string | undefined;
  const crqid = (body.CRQID || body.crqid) as string | undefined;
  const durationRaw = body.duration ?? body.billingDuration;
  const durationSec = durationRaw != null ? Number(durationRaw) : 0;
  const status = (body.status as string) ?? "";
  const failureReason = (body.failureReason as string) ?? "";
  const endTime = (body.endTime as string) ?? new Date().toISOString();
  const startTime = (body.startTime as string) ?? null;

  let logId: string | null = null;
  if (crqid?.startsWith("onecab:")) {
    logId = crqid.slice("onecab:".length);
  }

  let logQuery = serviceClient
    .from("call_masking_call_logs")
    .select("id, booking_id, session_id, caller_e164, destination_e164, call_start, status, msg91_request_id");

  if (logId && isValidUUID(logId)) {
    logQuery = logQuery.eq("id", logId);
  } else if (uuid) {
    logQuery = logQuery.or(`msg91_uuid.eq.${uuid},msg91_request_id.eq.${uuid}`);
  } else {
    return errorResponse("NOT_FOUND", "No call log reference in webhook", 404);
  }

  const { data: log } = await logQuery.maybeSingle();
  if (!log) {
    return errorResponse("NOT_FOUND", "Call log not found", 404);
  }

  const disconnectReason = mapMsg91ReportToDisconnectReason(status, failureReason, durationSec);

  await finalizeCallLog(serviceClient, log.id, {
    call_end: endTime,
    duration_seconds: Number.isFinite(durationSec) ? durationSec : null,
    disconnect_reason: disconnectReason,
    msg91_uuid: uuid ?? null,
    status: disconnectReason === DISCONNECT_REASON.CALL_COMPLETED ? "completed" : "disconnected",
  });

  logCallEvent("call_report", {
    booking_id: log.booking_id,
    session_id: log.session_id,
    caller: log.caller_e164,
    destination: log.destination_e164,
    session_id_msg91: log.msg91_request_id,
    call_start: startTime ?? log.call_start,
    call_end: endTime,
    disconnect_reason: disconnectReason,
    msg91_uuid: uuid ?? null,
    duration_seconds: durationSec,
  });

  return successResponse({ success: true });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleCORSPreflight();

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const msg91AuthKey = Deno.env.get("MSG91_AUTH_KEY");
    const msg91CallerId = Deno.env.get("MSG91_CALLER_ID") ?? null;

    if (!msg91AuthKey) {
      console.error("[call-masking] MSG91_AUTH_KEY not configured");
      return errorResponse("CONFIG_ERROR", "Call masking service not configured", 500);
    }

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return errorResponse("PARSE_ERROR", "Invalid JSON", 400);
    }

    const authHeader = req.headers.get("Authorization");
    const serviceClient = createClient(supabaseUrl, supabaseServiceKey);
    await expireDueSessions(serviceClient);
    await expireStaleMaskingSessions(serviceClient);
    if (msg91AuthKey) {
      await sweepOverdueActiveCallLogs(serviceClient, msg91AuthKey);
    }

    if (body.action === "call-report") {
      if (!verifyWebhookSecret(req, body)) {
        return errorResponse("FORBIDDEN", "Invalid webhook secret", 403);
      }
      return await handleCallReport(serviceClient, body);
    }

    if (body.action === "route-inbound") {
      if (!verifyWebhookSecret(req, body)) {
        return errorResponse("FORBIDDEN", "Invalid webhook secret", 403);
      }

      const callerRaw = (body.source || body.caller_phone || body.number || "") as string;
      const virtualRaw = (body.callerId || body.caller_id || body.virtual_number || msg91CallerId || "") as string;

      if (!callerRaw?.trim()) {
        return validationErrorResponse({ caller_phone: "caller phone is required" });
      }

      const { data: sessions } = await serviceClient
        .from("call_masking_sessions")
        .select(
          "id, trip_id, driver_id, customer_id, driver_phone, customer_phone, caller_id, msg91_request_id, status, expires_at, updated_at",
        )
        .eq("status", "active")
        .order("updated_at", { ascending: false })
        .limit(50);

      const tripIds = [...new Set((sessions ?? []).map((s) => s.trip_id))];
      const { data: trips } = tripIds.length
        ? await serviceClient
          .from("trips")
          .select("id, status, completed_at, confirmed_driver_id, passenger_id, passenger_phone, service_area_id")
          .in("id", tripIds)
        : { data: [] as TripRow[] };

      const tripById = new Map((trips ?? []).map((t) => [t.id, t as TripRow]));
      const picked = pickInboundMaskingSession(
        callerRaw,
        virtualRaw,
        msg91CallerId,
        (sessions ?? []) as SessionRow[],
        tripById,
        (session, trip) => isSessionValidForTrip(session as SessionRow, trip as TripRow),
        CALLABLE_STATUSES,
      );

      if (!picked) {
        logCallEvent("route_inbound_miss", {
          booking_id: "unknown",
          session_id: "unknown",
          caller: toE164(callerRaw),
          destination: "",
        });
        return errorResponse("NOT_FOUND", "No active masking session for caller", 404);
      }

      const { session, route } = picked;
      const pickedTrip = tripById.get(session.trip_id);
      const inboundContext = pickedTrip
        ? await loadTripCommunicationRuntimeContext(serviceClient, pickedTrip)
        : {
          settings: null,
          maskingConfig: null,
          maxCallDurationSeconds: DEFAULT_MAX_CALL_DURATION_SECONDS,
          maskingCallerId: null,
          callMaskingEnabled: false,
          voipEnabled: false,
          configVersion: 1,
        };

      const inboundUuid = (body.uuid || body.request_id || body.requestId) as string | undefined;

      await ensureInboundCallLog(
        serviceClient,
        msg91AuthKey,
        session.id,
        session.trip_id,
        route,
        inboundContext.maxCallDurationSeconds,
        inboundUuid ?? null,
      );

      logCallEvent("route_inbound", {
        booking_id: session.trip_id,
        session_id: session.id,
        caller: route.caller,
        destination: route.destination,
        session_id_msg91: session.msg91_request_id,
      });

      return successResponse({
        destination: normalizePhoneE164Digits(route.destination),
        destinationB: normalizePhoneE164Digits(route.destination),
        connect_to: route.destination,
        max_call_duration: inboundContext.maxCallDurationSeconds,
      });
    }

    if (body.action === "force-hangup") {
      if (!isServiceRoleRequest(authHeader)) {
        return errorResponse("FORBIDDEN", "Force hangup requires service role", 403);
      }

      let msg91Uuid = (body.msg91_uuid || body.request_id || body.uuid) as string | undefined;
      let callLogId = body.call_log_id as string | undefined;
      const tripId = (body.trip_id || body.booking_id) as string | undefined;
      const tripCode = body.trip_code as string | undefined;

      if (!msg91Uuid && tripId && isValidUUID(tripId)) {
        const { data: log } = await serviceClient
          .from("call_masking_call_logs")
          .select("id, msg91_uuid, msg91_request_id, status")
          .eq("booking_id", tripId)
          .order("call_start", { ascending: false })
          .limit(1)
          .maybeSingle();
        callLogId = log?.id ?? callLogId;
        msg91Uuid = log?.msg91_uuid ?? log?.msg91_request_id ?? msg91Uuid;
      }

      if (!msg91Uuid && tripCode) {
        const { data: trip } = await serviceClient
          .from("trips")
          .select("id")
          .eq("trip_code", tripCode)
          .maybeSingle();
        if (trip?.id) {
          const { data: log } = await serviceClient
            .from("call_masking_call_logs")
            .select("id, msg91_uuid, msg91_request_id, status")
            .eq("booking_id", trip.id)
            .order("call_start", { ascending: false })
            .limit(1)
            .maybeSingle();
          callLogId = log?.id ?? callLogId;
          msg91Uuid = log?.msg91_uuid ?? log?.msg91_request_id ?? msg91Uuid;
        }
      }

      if (!msg91Uuid) {
        return errorResponse("NOT_FOUND", "No MSG91 call reference to hang up", 404);
      }

      const hangup = await hangupMsg91CallDetailed(msg91AuthKey, msg91Uuid);

      if (callLogId && isValidUUID(callLogId)) {
        const { data: log } = await serviceClient
          .from("call_masking_call_logs")
          .select("id, status, call_start")
          .eq("id", callLogId)
          .maybeSingle();

        if (log?.status === "active") {
          const startedMs = new Date(log.call_start).getTime();
          const duration = Math.max(0, Math.floor((Date.now() - startedMs) / 1000));
          await finalizeCallLog(serviceClient, callLogId, {
            call_end: new Date().toISOString(),
            duration_seconds: duration,
            disconnect_reason: hangup.ok
              ? DISCONNECT_REASON.CALL_DURATION_LIMIT_REACHED
              : DISCONNECT_REASON.CALL_FAILED,
            msg91_uuid: msg91Uuid,
            status: "disconnected",
          });
        }
      }

      logCallEvent("force_hangup", {
        booking_id: tripId ?? "unknown",
        session_id: "unknown",
        caller: "",
        destination: "",
        session_id_msg91: msg91Uuid,
        disconnect_reason: hangup.ok ? "FORCE_HANGUP_OK" : "FORCE_HANGUP_FAILED",
      });

      return successResponse({
        success: hangup.ok,
        msg91_uuid: msg91Uuid,
        call_log_id: callLogId ?? null,
        hangup,
      });
    }

    if (body.action === "probe-msg91") {
      if (!isServiceRoleRequest(authHeader)) {
        return errorResponse("FORBIDDEN", "Probe requires service role", 403);
      }

      const initiator = (body.initiator_phone as string) || "+447491376424";
      const recipient = (body.recipient_phone as string) || "+447401885585";
      const dryRun = body.dry_run !== false;

      if (dryRun) {
        return successResponse({
          dry_run: true,
          max_call_duration_sec: DEFAULT_MAX_CALL_DURATION_SECONDS,
          caller_id_e164: toE164(msg91CallerId),
          caller_e164: toE164(initiator),
          destination_e164: toE164(recipient),
          msg91_payload: buildMsg91Payload(
            normalizePhoneE164Digits(msg91CallerId),
            normalizePhoneE164Digits(initiator),
            normalizePhoneE164Digits(recipient),
            "00000000-0000-4000-8000-000000000000",
            DEFAULT_MAX_CALL_DURATION_SECONDS,
          ),
          api_url: MSG91_API_URL,
        });
      }

      const msg91 = await callMsg91(
        msg91AuthKey,
        msg91CallerId,
        initiator,
        recipient,
        "00000000-0000-4000-8000-000000000000",
      );
      return successResponse({
        dry_run: false,
        msg91_status: msg91.status,
        msg91_ok: msg91.ok,
        msg91_body: msg91.body,
      });
    }

    if (!authHeader?.startsWith("Bearer ")) {
      return errorResponse("UNAUTHORIZED", "Missing authorization", 401);
    }

    const token = authHeader.replace("Bearer ", "");
    const anonClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await anonClient.auth.getUser(token);
    if (authError || !user) {
      return errorResponse("UNAUTHORIZED", "Invalid token", 401);
    }
    const userId = user.id;

    const action = body.action as string;
    const tripId = (body.trip_id || body.booking_id) as string;

    if (!action || !tripId || !isValidUUID(tripId)) {
      return validationErrorResponse({
        action: "action is required",
        trip_id: "valid trip_id is required",
      });
    }

    const { data: trip } = await serviceClient
      .from("trips")
      .select("id, driver_id, confirmed_driver_id, passenger_id, passenger_phone, status, completed_at, service_area_id")
      .eq("id", tripId)
      .single();

    if (!trip) {
      return errorResponse("NOT_FOUND", "Trip not found", 404);
    }

    if (TERMINAL_TRIP_STATUSES.has(trip.status)) {
      return errorResponse("INVALID_STATE", "Cannot call — trip is no longer active", 400);
    }

    const { data: driver } = await serviceClient
      .from("drivers")
      .select("id, phone, user_id")
      .eq("user_id", userId)
      .maybeSingle();

    const { data: customer } = await serviceClient
      .from("customers")
      .select("id, phone")
      .eq("user_id", userId)
      .maybeSingle();

    const { data: passenger } = trip.passenger_id
      ? await serviceClient
        .from("customers")
        .select("id, phone")
        .or(`id.eq.${trip.passenger_id},user_id.eq.${trip.passenger_id}`)
        .maybeSingle()
      : { data: null };

    const isDriver = Boolean(driver && isTripDriverParticipant(trip, driver.id));
    const isCustomer = Boolean(
      customer && (trip.passenger_id === customer.id || trip.passenger_id === userId),
    );

    if (!isDriver && !isCustomer) {
      return errorResponse("FORBIDDEN", "Not authorized for this trip", 403);
    }

    const commContext = await loadTripCommunicationRuntimeContext(serviceClient, trip);
    const maskingBlocked = assertCallMaskingAllowed(commContext);
    if (maskingBlocked) {
      console.log("OUTBOUND_CALLER_ID_INVALID", JSON.stringify({
        event: "OUTBOUND_CALLER_ID_INVALID",
        trip_id: trip.id,
        service_area_id: trip.service_area_id,
        failure_reason: maskingBlocked,
      }));
      return errorResponse("FORBIDDEN", maskingBlocked, 403);
    }

    console.log("MASKED_CALL_REQUESTED", JSON.stringify({
      event: "MASKED_CALL_REQUESTED",
      trip_id: trip.id,
      service_area_id: trip.service_area_id,
      config_version: commContext.configVersion,
    }));

    const maskingVirtualE164 = toE164(commContext.maskingCallerId!);
    const maxCallDurationSec = commContext.maxCallDurationSeconds;

    const driverId = trip.confirmed_driver_id ?? trip.driver_id;
    if (!driverId) {
      return errorResponse("NO_DRIVER", "No driver assigned to this trip yet", 400);
    }

    const { data: assignedDriver } = await serviceClient
      .from("drivers")
      .select("id, phone")
      .eq("id", driverId)
      .single();

    const driverPhoneRaw = assignedDriver?.phone ?? driver?.phone ?? null;
    const customerPhoneRaw =
      trip.passenger_phone || passenger?.phone || (!isDriver ? customer?.phone : null) || null;
    const passengerCustomerId = passenger?.id ?? (isCustomer ? customer?.id ?? null : null);

    if (!driverPhoneRaw || !customerPhoneRaw) {
      return errorResponse(
        "MISSING_PHONE",
        "Phone numbers not available for this trip. Ask support to verify your profile phone.",
        400,
      );
    }

    const driverPhone = toE164(driverPhoneRaw);
    const customerPhone = toE164(customerPhoneRaw);
    const callerPhoneRaw = isDriver ? driverPhoneRaw : customerPhoneRaw;
    const callerPhoneE164 = toE164(callerPhoneRaw);

    const expireActiveSessionForTrip = async () => {
      await serviceClient
        .from("call_masking_sessions")
        .update({
          status: "expired",
          expires_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("trip_id", tripId)
        .eq("status", "active");
    };

    const sessionExpiresAt = (): string | null => {
      if (isCallableTripStatus(trip.status)) return null;
      if (trip.status === "completed") {
        const base = trip.completed_at ? new Date(trip.completed_at) : new Date();
        return new Date(base.getTime() + 10 * 60 * 1000).toISOString();
      }
      return null;
    };

    const upsertSession = async (msg91RequestId: string | null): Promise<string | null> => {
      const sessionRow = {
        trip_id: tripId,
        driver_id: driverId,
        customer_id: passengerCustomerId,
        driver_phone: driverPhone,
        customer_phone: customerPhone,
        msg91_request_id: msg91RequestId,
        caller_id: maskingVirtualE164,
        status: "active",
        expires_at: sessionExpiresAt(),
        updated_at: new Date().toISOString(),
      };

      const { data: existingSession } = await serviceClient
        .from("call_masking_sessions")
        .select("id, driver_id, customer_id, driver_phone, customer_phone")
        .eq("trip_id", tripId)
        .eq("status", "active")
        .maybeSingle();

      const partiesMatch = existingSession &&
        existingSession.driver_id === driverId &&
        phonesMatch(existingSession.driver_phone, driverPhone) &&
        phonesMatch(existingSession.customer_phone, customerPhone) &&
        (existingSession.customer_id === passengerCustomerId ||
          (!existingSession.customer_id && !passengerCustomerId));

      if (existingSession && existingSession.driver_id !== driverId) {
        console.log("[call-masking] Driver reassigned — expiring stale session", {
          booking_id: tripId,
          session_id: existingSession.id,
          session_driver_id: existingSession.driver_id,
          trip_driver_id: driverId,
        });
        await expireActiveSessionForTrip();
      }

      if (existingSession && !partiesMatch) {
        console.log("[call-masking] Stale session parties — expiring", {
          booking_id: tripId,
          session_id: existingSession.id,
        });
        await expireActiveSessionForTrip();
      }

      const { data: activeAfterExpire } = await serviceClient
        .from("call_masking_sessions")
        .select("id")
        .eq("trip_id", tripId)
        .eq("status", "active")
        .maybeSingle();

      const { data: written, error: writeError } = activeAfterExpire?.id
        ? await serviceClient
          .from("call_masking_sessions")
          .update(sessionRow)
          .eq("id", activeAfterExpire.id)
          .select("id")
          .single()
        : await serviceClient
          .from("call_masking_sessions")
          .insert(sessionRow)
          .select("id")
          .single();

      if (writeError) {
        console.error("[call-masking] DB session write error:", writeError);
        return activeAfterExpire?.id ?? null;
      }

      return written?.id ?? activeAfterExpire?.id ?? null;
    };

    if (action === "get-session") {
      const { data: session } = await serviceClient
        .from("call_masking_sessions")
        .select("id, trip_id, caller_id, status, expires_at, created_at, msg91_request_id")
        .eq("trip_id", tripId)
        .eq("status", "active")
        .maybeSingle();

      return successResponse({
        session: sessionPayload(session, maskingVirtualE164),
        masked_number: session ? (session.caller_id ?? maskingVirtualE164) : null,
        msg91_virtual_number: maskingVirtualE164,
        can_call: session ? canInitiateCall(trip as TripRow, session as SessionRow) : false,
        max_call_duration_sec: maxCallDurationSec,
      });
    }

    if (action === "create-session") {
      if (TERMINAL_TRIP_STATUSES.has(trip.status)) {
        return errorResponse("INVALID_STATE", "Cannot call — trip is no longer active", 400);
      }

      const { data: existing } = await serviceClient
        .from("call_masking_sessions")
        .select("id, caller_id, expires_at, driver_id, customer_id, driver_phone, customer_phone, msg91_request_id, status")
        .eq("trip_id", tripId)
        .eq("status", "active")
        .maybeSingle();

      const partiesMatch = existing &&
        existing.driver_id === driverId &&
        phonesMatch(existing.driver_phone, driverPhone) &&
        phonesMatch(existing.customer_phone, customerPhone);

      if (existing?.caller_id && partiesMatch && canInitiateCall(trip as TripRow, existing as SessionRow)) {
        logCallEvent("session_reuse", {
          booking_id: tripId,
          session_id: existing.id,
          caller: callerPhoneE164,
          destination: "",
          session_id_msg91: existing.msg91_request_id,
        });
        return successResponse({
          session: sessionPayload(existing, maskingVirtualE164),
          masked_number: existing.caller_id ?? maskingVirtualE164,
          msg91_virtual_number: maskingVirtualE164,
          max_call_duration_sec: maxCallDurationSec,
        });
      }

      if (existing && !partiesMatch) {
        await expireActiveSessionForTrip();
      }

      const sessionId = await upsertSession(null);
      const { data: created } = await serviceClient
        .from("call_masking_sessions")
        .select("id, caller_id, expires_at, msg91_request_id")
        .eq("trip_id", tripId)
        .eq("status", "active")
        .maybeSingle();

      if (!created?.id) {
        console.error("[call-masking] create-session persisted no active row", {
          booking_id: tripId,
          session_id: sessionId,
          trip_status: trip.status,
        });
        await opsLog(serviceClient, {
          level: "error",
          source: "call-masking",
          app: "backend",
          event_type: "call_masking_provider_failed",
          workflow_event_type: "call_masking_provider_failed",
          severity: "critical",
          trip_id: tripId,
          driver_id: trip.confirmed_driver_id,
          customer_id: trip.passenger_id,
          error_code: "SESSION_CREATE_FAILED",
          message: "Could not create call masking session",
          metadata: { trip_status: trip.status, session_id: sessionId },
        });
        return errorResponse(
          "SESSION_CREATE_FAILED",
          "Could not create call masking session. Please try again.",
          500,
        );
      }

      logCallEvent("session_created", {
        booking_id: tripId,
        session_id: sessionId ?? created.id,
        caller: callerPhoneE164,
        destination: "",
        session_id_msg91: created.msg91_request_id ?? null,
      });

      const session = sessionPayload(created, maskingVirtualE164);
      return successResponse({
        session,
        masked_number: session?.masked_number ?? maskingVirtualE164,
        msg91_virtual_number: maskingVirtualE164,
        max_call_duration_sec: maxCallDurationSec,
      });
    }

    if (action === "initiate-call") {
      const { data: session } = await serviceClient
        .from("call_masking_sessions")
        .select("id, status, expires_at, msg91_request_id")
        .eq("trip_id", tripId)
        .eq("status", "active")
        .maybeSingle();

      let sessionId = session?.id ?? null;
      if (!sessionId) {
        sessionId = await upsertSession(null);
      }

      if (
        !sessionId ||
        !canInitiateCall(
          trip as TripRow,
          (session ?? { status: "active", expires_at: sessionExpiresAt() }) as SessionRow,
        )
      ) {
        return errorResponse("INVALID_STATE", "Cannot call in current trip state", 400);
      }

      // Route by authenticated caller's phone: customer→driver or driver→customer.
      const route = resolveCallRoute(callerPhoneE164, driverPhone, customerPhone);
      if (!route) {
        return errorResponse(
          "ROUTE_ERROR",
          "Could not resolve call routing for this trip. Check profile phone numbers.",
          400,
        );
      }

      // MSG91 Click-to-Call: ring the caller first, then bridge the other party.
      // Manual dial + route-inbound is a fallback only when CTC is unavailable;
      // inbound webhooks require MSG91_WEBHOOK_SECRET to be configured.
      await hangupActiveSessionCalls(serviceClient, msg91AuthKey, sessionId);

      const callLog = await createCallLog(serviceClient, {
        session_id: sessionId,
        booking_id: tripId,
        caller_e164: route.caller,
        destination_e164: route.destination,
      });
      if (!callLog) {
        return errorResponse(
          "CALL_LOG_FAILED",
          "Could not start masked call. Please try again.",
          500,
        );
      }

      const msg91 = await callMsg91(
        msg91AuthKey,
        maskingVirtualE164,
        route.caller,
        route.destination,
        callLog.id,
        maxCallDurationSec,
      );

      if (!msg91.ok) {
        const detail = msg91ErrorMessage(msg91.body);
        console.error(
          "[call-masking] MSG91 rejected call:",
          msg91.status,
          JSON.stringify(msg91.body),
        );
        await finalizeCallLog(serviceClient, callLog.id, {
          call_end: new Date().toISOString(),
          duration_seconds: 0,
          disconnect_reason: DISCONNECT_REASON.CALL_FAILED,
          status: "disconnected",
        });
        await opsLog(serviceClient, {
          level: "error",
          source: "call-masking",
          app: "backend",
          event_type: "call_masking_provider_failed",
          workflow_event_type: "call_masking_provider_failed",
          severity: "critical",
          trip_id: tripId,
          driver_id: trip.confirmed_driver_id,
          customer_id: trip.passenger_id,
          error_code: "MSG91_ERROR",
          message: detail,
          metadata: {
            msg91_status: msg91.status,
            caller_role: route.callerRole,
          },
        });
        return errorResponse("MSG91_ERROR", detail, 502, msg91.body);
      }

      const msg91Data = msg91.body.data;
      const requestId = (
        msg91.body.request_id ||
        msg91.body.requestId ||
        msg91.body.uuid ||
        (typeof msg91Data === "object" && msg91Data && "id" in msg91Data
          ? (msg91Data as { id?: string }).id
          : null) ||
        null
      ) as string | null;

      await upsertSession(requestId);
      if (requestId) {
        await serviceClient
          .from("call_masking_call_logs")
          .update({ msg91_uuid: requestId, msg91_request_id: requestId })
          .eq("id", callLog.id);
      }
      scheduleCallDurationLimit(
        serviceClient,
        msg91AuthKey,
        callLog.id,
        requestId,
        maxCallDurationSec,
      );

      logCallEvent("ctc_initiated", {
        booking_id: tripId,
        session_id: sessionId,
        caller: route.caller,
        destination: route.destination,
        session_id_msg91: requestId,
      });

      console.log("MASKED_CALL_STARTED", JSON.stringify({
        event: "MASKED_CALL_STARTED",
        trip_id: trip.id,
        service_area_id: trip.service_area_id,
        driver_id: driverId,
        customer_id: trip.passenger_id,
        method: "call_masking",
        provider: "msg91",
        caller_role: route.callerRole,
        config_version: commContext.configVersion,
      }));

      return successResponse({
        success: true,
        manual_dial_only: false,
        message: "Masked call initiated. Answer your phone when it rings.",
        masked_number: maskingVirtualE164,
        caller_id_shown: maskingVirtualE164,
        msg91_virtual_number: maskingVirtualE164,
        msg91_request_id: requestId,
        max_call_duration_sec: maxCallDurationSec,
      });
    }

    if (action === "expire-session") {
      await expireActiveSessionForTrip();
      return successResponse({ success: true, message: "Session expired" });
    }

    return errorResponse("UNKNOWN_ACTION", `Unknown action: ${action}`, 400);
  } catch (error) {
    console.error("[call-masking] Error:", error);
    console.log("MASKED_CALL_FAILED", JSON.stringify({
      event: "MASKED_CALL_FAILED",
      failure_reason: error instanceof Error ? error.message : "unknown",
    }));
    return errorResponse("INTERNAL_ERROR", "Internal server error", 500);
  }
});
