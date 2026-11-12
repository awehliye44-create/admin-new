/**
 * Payment-first booking: load + validate consumed server_fare_quotes and stamp
 * airport / commissionable split onto the trip insert payload.
 *
 * Used by create-trip-after-payment (and mirrored in finalize_paid_booking_session
 * SQL). Never trusts client-supplied airport amounts.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  applyAuthoritativeAirportSplitToTripData,
  decideDispatchAfterFareEnrich,
  resolveAuthoritativeAirportSplitFromServerFareQuote,
  type AuthoritativeAirportSplitOk,
  type AuthoritativeAirportSplitResult,
  type ServerFareQuoteAirportAuthority,
} from "./airportChargeFareSplitSSOT.ts";
import {
  SERVER_FARE_ARTIFACT_SELECT_WITH_EVIDENCE,
  isUuid,
} from "./serverFareAuthoritySSOT.ts";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function resolveServerFareQuoteIdFromSession(input: {
  sessionFareSnapshot?: Record<string, unknown> | null;
  sessionMetadata?: Record<string, unknown> | null;
  bookingPaymentQuoteId?: string | null;
}): string | null {
  const snap = asRecord(input.sessionFareSnapshot);
  const meta = asRecord(input.sessionMetadata);
  const candidates = [
    snap?.server_fare_quote_id,
    meta?.server_fare_quote_id,
    input.bookingPaymentQuoteId,
  ];
  for (const c of candidates) {
    const id = String(c ?? "").trim();
    if (isUuid(id)) return id;
  }
  return null;
}

export async function loadServerFareQuoteAirportAuthority(
  supabase: SupabaseClient,
  serverFareQuoteId: string,
): Promise<ServerFareQuoteAirportAuthority | null> {
  if (!isUuid(serverFareQuoteId)) return null;
  const { data, error } = await supabase
    .from("server_fare_quotes")
    .select(SERVER_FARE_ARTIFACT_SELECT_WITH_EVIDENCE)
    .eq("id", serverFareQuoteId)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as Record<string, unknown>;
  return {
    id: String(row.id),
    user_id: String(row.user_id ?? ""),
    vehicle_type_id: String(row.vehicle_type_id ?? ""),
    service_area_id: String(row.service_area_id ?? ""),
    route_key: row.route_key != null ? String(row.route_key) : null,
    gross_fare_pence: Math.round(Number(row.gross_fare_pence) || 0),
    airport_charge_pence: Math.round(Number(row.airport_charge_pence) || 0),
    pricing_evidence: asRecord(row.pricing_evidence),
    pricing_mode: row.pricing_mode != null ? String(row.pricing_mode) : null,
    fare_source: row.fare_source != null ? String(row.fare_source) : null,
  };
}

/**
 * Resolve booking_payment_quotes.server_fare_quote_id for a consumed session /
 * client_action, then load the artifact.
 */
export async function loadConsumedServerFareQuoteForPaymentSession(
  supabase: SupabaseClient,
  input: {
    paymentSessionId?: string | null;
    clientActionId?: string | null;
    sessionFareSnapshot?: Record<string, unknown> | null;
    sessionMetadata?: Record<string, unknown> | null;
  },
): Promise<ServerFareQuoteAirportAuthority | null> {
  const directId = resolveServerFareQuoteIdFromSession({
    sessionFareSnapshot: input.sessionFareSnapshot,
    sessionMetadata: input.sessionMetadata,
  });
  if (directId) {
    const direct = await loadServerFareQuoteAirportAuthority(supabase, directId);
    if (direct) return direct;
  }

  const sessionId = String(input.paymentSessionId ?? "").trim();
  const clientActionId = String(input.clientActionId ?? "").trim();
  if (sessionId && isUuid(sessionId)) {
    const { data } = await supabase
      .from("booking_payment_quotes")
      .select("server_fare_quote_id")
      .eq("consumed_payment_session_id", sessionId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const qid = String((data as { server_fare_quote_id?: string } | null)?.server_fare_quote_id ?? "")
      .trim();
    if (isUuid(qid)) {
      const viaSession = await loadServerFareQuoteAirportAuthority(supabase, qid);
      if (viaSession) return viaSession;
    }
  }
  if (clientActionId && isUuid(clientActionId)) {
    const { data } = await supabase
      .from("booking_payment_quotes")
      .select("server_fare_quote_id")
      .eq("client_action_id", clientActionId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const qid = String((data as { server_fare_quote_id?: string } | null)?.server_fare_quote_id ?? "")
      .trim();
    if (isUuid(qid)) {
      return await loadServerFareQuoteAirportAuthority(supabase, qid);
    }
  }
  return null;
}

export async function resolveAuthoritativeAirportSplitForBooking(
  supabase: SupabaseClient,
  input: {
    paymentSessionId?: string | null;
    clientActionId?: string | null;
    sessionFareSnapshot?: Record<string, unknown> | null;
    sessionMetadata?: Record<string, unknown> | null;
    userId: string;
    vehicleTypeId: string;
    serviceAreaId: string;
    payablePence: number;
    routeKey?: string | null;
  },
): Promise<AuthoritativeAirportSplitResult> {
  const quote = await loadConsumedServerFareQuoteForPaymentSession(supabase, input);
  return resolveAuthoritativeAirportSplitFromServerFareQuote({
    quote,
    userId: input.userId,
    vehicleTypeId: input.vehicleTypeId,
    serviceAreaId: input.serviceAreaId,
    payablePence: input.payablePence,
    routeKey: input.routeKey,
  });
}

export type AirportPersistReadiness = {
  split: AuthoritativeAirportSplitOk | null;
  /** Quote reported a positive airport that must be on the trip before dispatch. */
  requiredAirportPence: number;
  holdBroadcast: boolean;
  allowDispatch: boolean;
  reason: string;
};

/**
 * Decide whether trip insert may proceed to dispatch/publish with the resolved
 * split. Fail closed when a positive quote airport cannot be stamped.
 */
export function evaluateAirportPersistReadiness(
  result: AuthoritativeAirportSplitResult,
): AirportPersistReadiness {
  if (result.ok) {
    if (!result.requiresAirportPersist) {
      return {
        split: result,
        requiredAirportPence: 0,
        holdBroadcast: false,
        allowDispatch: true,
        reason: "airport_absent",
      };
    }
    const gate = decideDispatchAfterFareEnrich({
      quoteAirportPence: result.airportChargePence,
      persistedAirportPence: result.airportChargePence,
      updateFailed: false,
    });
    return {
      split: result,
      requiredAirportPence: result.airportChargePence,
      holdBroadcast: gate.holdBroadcast,
      allowDispatch: gate.allowDispatch,
      reason: gate.reason,
    };
  }

  const required = Math.max(0, Math.round(Number(result.quoteAirportPence) || 0));
  if (required <= 0 && result.code === "QUOTE_MISSING") {
    // No consumed server fare quote — legacy / non-opaque path; enrich may still run.
    return {
      split: null,
      requiredAirportPence: 0,
      holdBroadcast: false,
      allowDispatch: true,
      reason: "quote_missing_fail_open",
    };
  }
  if (required <= 0) {
    return {
      split: null,
      requiredAirportPence: 0,
      holdBroadcast: false,
      allowDispatch: true,
      reason: result.code.toLowerCase(),
    };
  }
  return {
    split: null,
    requiredAirportPence: required,
    holdBroadcast: true,
    allowDispatch: false,
    reason: result.code.toLowerCase(),
  };
}

export function stampTripInsertAirportAuthority(
  tripData: Record<string, unknown>,
  readiness: AirportPersistReadiness,
): void {
  if (readiness.split) {
    applyAuthoritativeAirportSplitToTripData(tripData, readiness.split);
  }
  if (readiness.holdBroadcast) {
    tripData.broadcast_enabled = false;
    tripData.scheduled_hold_reason = "airport_pricing";
  }
}

export { applyAuthoritativeAirportSplitToTripData };
