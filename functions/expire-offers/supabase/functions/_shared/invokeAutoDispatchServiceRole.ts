/**
 * Trusted Edge-to-Edge invoke: expire-offers → auto-dispatch.
 *
 * supabase.functions.invoke() forwards the incoming request Authorization
 * (pg_cron expire_offers_sweep fallback JWT). auto-dispatch requireServiceRole
 * rejects anything that is not the exact SUPABASE_SERVICE_ROLE_KEY.
 *
 * This helper uses fetch() with an explicit service-role Bearer — the same
 * convention as other trusted ONECAB Edge-to-Edge calls in expire-offers.
 * Never log the token.
 */

import {
  dispatchRoundFromSequence,
  waveIndexFromSequence,
} from "./dispatch-settings.ts";

export const EXPIRE_OFFERS_AUTO_DISPATCH_SOURCE = "expire-offers";

export type AutoDispatchOutcomeKind =
  | "authentication_rejection"
  | "non_dispatchable"
  | "ttl_expired"
  | "no_candidates"
  | "successful_dispatch"
  | "idempotent_noop"
  | "invoke_error";

export type AutoDispatchServiceRoleBody = {
  trip_id: string;
  force_rebroadcast?: boolean;
  trigger_reason?: string;
  reason_for_next_wave?: string | null;
  declined_driver_id?: string;
};

export type DispatchTripContext = {
  tripId: string;
  publicTripId?: string | null;
  currentSequence?: number | null;
  ttlDeadline?: string | null;
};

export type InvokeAutoDispatchServiceRoleParams = {
  supabaseUrl: string;
  serviceRoleKey: string;
  body: AutoDispatchServiceRoleBody;
  source?: string;
  tripContext?: DispatchTripContext;
  fetchImpl?: typeof fetch;
};

export type InvokeAutoDispatchServiceRoleResult = {
  ok: boolean;
  httpStatus: number | null;
  outcome: AutoDispatchOutcomeKind;
  errorCode: string | null;
  responseBody: unknown;
  logPayload: Record<string, unknown>;
};

const AUTH_CODES = new Set(["UNAUTHORIZED", "SERVER_AUTH_MISCONFIGURED"]);
const TTL_CODES = new Set(["SEARCH_WINDOW_ENDED", "MAX_ROUNDS_EXCEEDED"]);
const NON_DISPATCHABLE_CODES = new Set([
  "NOT_FOUND",
  "CASH_TRIP_NOT_AUTHORIZED",
  "PICKUP_OUTSIDE_SERVICE_AREA",
  "VEHICLE_TYPE_MISSING",
  "TRIP_NOT_ELIGIBLE",
  "LOCKED_DRIVER_TRIP",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readErrorCode(body: unknown, httpStatus: number | null): string | null {
  const rec = asRecord(body);
  if (!rec) {
    if (httpStatus === 401 || httpStatus === 403) return "UNAUTHORIZED";
    return null;
  }
  const candidates = [rec.error, rec.code, rec.error_code, rec.message];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  if (httpStatus === 401 || httpStatus === 403) return "UNAUTHORIZED";
  return null;
}

function textIncludes(value: unknown, needle: string): boolean {
  return typeof value === "string" && value.toLowerCase().includes(needle);
}

export function redactSecrets(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [REDACTED]")
      .replace(/eyJ[A-Za-z0-9._\-]{20,}/g, "[REDACTED_JWT]");
  }
  if (Array.isArray(value)) return value.map(redactSecrets);
  const rec = asRecord(value);
  if (!rec) return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(rec)) {
    if (/authorization|apikey|service.?role|secret|token/i.test(key)) {
      out[key] = "[REDACTED]";
      continue;
    }
    out[key] = redactSecrets(inner);
  }
  return out;
}

export function classifyAutoDispatchResponse(params: {
  httpStatus: number | null;
  body: unknown;
}): AutoDispatchOutcomeKind {
  const { httpStatus, body } = params;
  const rec = asRecord(body);
  const errorCode = readErrorCode(body, httpStatus);
  const message = typeof rec?.message === "string" ? rec.message : "";
  const errorText = typeof rec?.error === "string" ? rec.error : "";
  const combined = `${errorCode ?? ""} ${message} ${errorText}`.toLowerCase();

  if (
    httpStatus === 401
    || httpStatus === 403
    || (errorCode != null && AUTH_CODES.has(errorCode))
    || combined.includes("service-role authorization required")
  ) {
    return "authentication_rejection";
  }

  if (
    (errorCode != null && TTL_CODES.has(errorCode))
    || combined.includes("search window ended")
    || combined.includes("customer search window ended")
  ) {
    return "ttl_expired";
  }

  if (
    (errorCode != null && NON_DISPATCHABLE_CODES.has(errorCode))
    || rec?.blocked_terminal_trip === true
    || rec?.dispatch_aborted === true && textIncludes(rec.error, "terminal")
    || combined.includes("not eligible for dispatch")
    || combined.includes("locked to a specific driver")
  ) {
    return "non_dispatchable";
  }

  if (httpStatus != null && httpStatus >= 400) {
    return "invoke_error";
  }

  const offersCreated = typeof rec?.offers_created === "number" ? rec.offers_created : null;
  if (
    combined.includes("no drivers")
    || combined.includes("no eligible")
    || offersCreated === 0 && combined.includes("waiting for next")
  ) {
    return "no_candidates";
  }

  if (
    combined.includes("already offered")
    || combined.includes("waves exhausted")
    || combined.includes("negotiation in progress")
    || rec?.message === "Trip already offered"
  ) {
    return "idempotent_noop";
  }

  if (httpStatus != null && httpStatus >= 200 && httpStatus < 300) {
    if (offersCreated != null && offersCreated > 0) return "successful_dispatch";
    if (rec?.success === false && rec?.error) return "non_dispatchable";
    if (offersCreated === 0) return "no_candidates";
    return "successful_dispatch";
  }

  return "invoke_error";
}

export function buildExpireOffersAutoDispatchLog(params: {
  tripContext?: DispatchTripContext;
  httpStatus: number | null;
  body: unknown;
  outcome: AutoDispatchOutcomeKind;
  source?: string;
  errorCode?: string | null;
}): Record<string, unknown> {
  const sequence = params.tripContext?.currentSequence ?? null;
  const safeSequence = typeof sequence === "number" && sequence > 0 ? sequence : null;
  return {
    invocation_source: params.source ?? EXPIRE_OFFERS_AUTO_DISPATCH_SOURCE,
    trip_id: params.tripContext?.tripId ?? null,
    public_trip_id: params.tripContext?.publicTripId ?? null,
    http_status: params.httpStatus,
    error_code: params.errorCode ?? readErrorCode(params.body, params.httpStatus),
    outcome: params.outcome,
    current_dispatch_sequence: safeSequence,
    current_dispatch_round: safeSequence != null ? dispatchRoundFromSequence(safeSequence) : null,
    current_dispatch_wave: safeSequence != null ? waveIndexFromSequence(safeSequence) : null,
    ttl_deadline: params.tripContext?.ttlDeadline ?? null,
    response_body: redactSecrets(params.body),
  };
}

export function serviceRoleInvokeHeaders(serviceRoleKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${serviceRoleKey}`,
    apikey: serviceRoleKey,
  };
}

export async function invokeAutoDispatchWithServiceRole(
  params: InvokeAutoDispatchServiceRoleParams,
): Promise<InvokeAutoDispatchServiceRoleResult> {
  const source = params.source ?? EXPIRE_OFFERS_AUTO_DISPATCH_SOURCE;
  const tripContext: DispatchTripContext = params.tripContext ?? {
    tripId: params.body.trip_id,
  };

  if (!params.serviceRoleKey) {
    const outcome: AutoDispatchOutcomeKind = "authentication_rejection";
    const responseBody = {
      success: false,
      error: "SERVER_AUTH_MISCONFIGURED",
      message: "Internal authentication is unavailable",
    };
    const logPayload = buildExpireOffersAutoDispatchLog({
      tripContext,
      httpStatus: 500,
      body: responseBody,
      outcome,
      source,
      errorCode: "SERVER_AUTH_MISCONFIGURED",
    });
    return {
      ok: false,
      httpStatus: 500,
      outcome,
      errorCode: "SERVER_AUTH_MISCONFIGURED",
      responseBody,
      logPayload,
    };
  }

  const url = `${params.supabaseUrl.replace(/\/$/, "")}/functions/v1/auto-dispatch`;
  const fetchImpl = params.fetchImpl ?? fetch;

  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: serviceRoleInvokeHeaders(params.serviceRoleKey),
      body: JSON.stringify(params.body),
    });

    let parsed: unknown = null;
    const rawText = await response.text();
    if (rawText) {
      try {
        parsed = JSON.parse(rawText);
      } catch {
        parsed = { raw: rawText.slice(0, 500) };
      }
    }

    const outcome = classifyAutoDispatchResponse({
      httpStatus: response.status,
      body: parsed,
    });
    const errorCode = readErrorCode(parsed, response.status);
    const logPayload = buildExpireOffersAutoDispatchLog({
      tripContext,
      httpStatus: response.status,
      body: parsed,
      outcome,
      source,
      errorCode,
    });

    return {
      ok: response.ok,
      httpStatus: response.status,
      outcome,
      errorCode,
      responseBody: parsed,
      logPayload,
    };
  } catch (error) {
    const responseBody = {
      success: false,
      error: "INVOKE_EXCEPTION",
      message: error instanceof Error ? error.message : String(error),
    };
    const outcome: AutoDispatchOutcomeKind = "invoke_error";
    const logPayload = buildExpireOffersAutoDispatchLog({
      tripContext,
      httpStatus: null,
      body: redactSecrets(responseBody),
      outcome,
      source,
      errorCode: "INVOKE_EXCEPTION",
    });
    return {
      ok: false,
      httpStatus: null,
      outcome,
      errorCode: "INVOKE_EXCEPTION",
      responseBody,
      logPayload,
    };
  }
}
