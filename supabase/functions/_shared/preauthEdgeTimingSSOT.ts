/**
 * Observability-only create-preauth Edge timing.
 * Never changes payment / Revolut semantics — only stamps flat ms fields on responses.
 *
 * Phase-2 stage names (aliases kept for Book→Finding client ingest):
 *   preauth_auth_ms, preauth_context_ms, preauth_quote_ms, preauth_config_ms,
 *   preauth_existing_session_ms, preauth_provider_prepare_ms,
 *   preauth_provider_request_ms, preauth_provider_response_ms,
 *   preauth_persist_ms, preauth_response_build_ms, preauth_edge_total_ms
 */

export type PreauthEdgeTimingFlat = {
  edge_receive_to_auth_ms: number | null;
  edge_auth_ms: number | null;
  edge_db_lookup_ms: number | null;
  edge_validation_ms: number | null;
  edge_revolut_request_ms: number | null;
  edge_revolut_response_ms: number | null;
  edge_persist_ms: number | null;
  edge_response_build_ms: number | null;
  edge_total_ms: number;
  /** Compat aliases for Customer Book→Finding telemetry. */
  edge_preauth_server_ms: number;
  edge_preauth_revolut_ms: number | null;
  /** Phase-2 named stages (null when not stamped). */
  preauth_auth_ms: number | null;
  preauth_context_ms: number | null;
  preauth_quote_ms: number | null;
  preauth_config_ms: number | null;
  preauth_existing_session_ms: number | null;
  preauth_provider_prepare_ms: number | null;
  preauth_provider_request_ms: number | null;
  preauth_provider_response_ms: number | null;
  preauth_persist_ms: number | null;
  preauth_response_build_ms: number | null;
  preauth_edge_total_ms: number;
  /** Whether live estimate-fare was skipped because an opaque quote was used. */
  preauth_skipped_live_fare_quote?: boolean | null;
  booking_milestones: {
    hold_start_ms: number;
    hold_authorised_ms: number;
    hold_duration_ms: number;
  };
};

export type PreauthEdgeTiming = {
  readonly t0: number;
  markAuthStart: () => void;
  markAuthEnd: () => void;
  markContextStart: () => void;
  markContextEnd: () => void;
  markQuoteStart: () => void;
  markQuoteEnd: () => void;
  markConfigStart: () => void;
  markConfigEnd: () => void;
  markExistingSessionStart: () => void;
  markExistingSessionEnd: () => void;
  markProviderPrepareStart: () => void;
  markProviderPrepareEnd: () => void;
  markDbLookupStart: () => void;
  markDbLookupEnd: () => void;
  markValidationStart: () => void;
  markValidationEnd: () => void;
  markRevolutRequestStart: () => void;
  markRevolutRequestEnd: () => void;
  markRevolutResponseStart: () => void;
  markRevolutResponseEnd: () => void;
  markPersistStart: () => void;
  markPersistEnd: () => void;
  markResponseBuildStart: () => void;
  setSkippedLiveFareQuote: (skipped: boolean) => void;
  toFlatFields: () => PreauthEdgeTimingFlat;
  attachToBody: <T extends Record<string, unknown>>(body: T) => T & PreauthEdgeTimingFlat;
};

function delta(a: number | null, b: number | null): number | null {
  if (a == null || b == null) return null;
  return Math.max(0, Math.round(b - a));
}

export function createPreauthEdgeTiming(startedAtMs = Date.now()): PreauthEdgeTiming {
  const t0 = startedAtMs;
  let authStart: number | null = null;
  let authEnd: number | null = null;
  let contextStart: number | null = null;
  let contextEnd: number | null = null;
  let quoteStart: number | null = null;
  let quoteEnd: number | null = null;
  let configStart: number | null = null;
  let configEnd: number | null = null;
  let existingSessionStart: number | null = null;
  let existingSessionEnd: number | null = null;
  let providerPrepareStart: number | null = null;
  let providerPrepareEnd: number | null = null;
  let dbStart: number | null = null;
  let dbEnd: number | null = null;
  let valStart: number | null = null;
  let valEnd: number | null = null;
  let revReqStart: number | null = null;
  let revReqEnd: number | null = null;
  let revResStart: number | null = null;
  let revResEnd: number | null = null;
  let persistStart: number | null = null;
  let persistEnd: number | null = null;
  let responseBuildStart: number | null = null;
  let skippedLiveFareQuote: boolean | null = null;

  const stampOnce = (current: number | null, set: (n: number) => void) => {
    if (current == null) set(Date.now());
  };

  const api: PreauthEdgeTiming = {
    t0,
    markAuthStart: () => stampOnce(authStart, (n) => { authStart = n; }),
    markAuthEnd: () => stampOnce(authEnd, (n) => { authEnd = n; }),
    markContextStart: () => stampOnce(contextStart, (n) => { contextStart = n; }),
    markContextEnd: () => stampOnce(contextEnd, (n) => { contextEnd = n; }),
    markQuoteStart: () => stampOnce(quoteStart, (n) => { quoteStart = n; }),
    markQuoteEnd: () => stampOnce(quoteEnd, (n) => { quoteEnd = n; }),
    markConfigStart: () => stampOnce(configStart, (n) => { configStart = n; }),
    markConfigEnd: () => stampOnce(configEnd, (n) => { configEnd = n; }),
    markExistingSessionStart: () =>
      stampOnce(existingSessionStart, (n) => { existingSessionStart = n; }),
    markExistingSessionEnd: () =>
      stampOnce(existingSessionEnd, (n) => { existingSessionEnd = n; }),
    markProviderPrepareStart: () =>
      stampOnce(providerPrepareStart, (n) => { providerPrepareStart = n; }),
    markProviderPrepareEnd: () =>
      stampOnce(providerPrepareEnd, (n) => { providerPrepareEnd = n; }),
    markDbLookupStart: () => stampOnce(dbStart, (n) => { dbStart = n; }),
    markDbLookupEnd: () => stampOnce(dbEnd, (n) => { dbEnd = n; }),
    markValidationStart: () => stampOnce(valStart, (n) => { valStart = n; }),
    markValidationEnd: () => stampOnce(valEnd, (n) => { valEnd = n; }),
    markRevolutRequestStart: () => stampOnce(revReqStart, (n) => { revReqStart = n; }),
    markRevolutRequestEnd: () => stampOnce(revReqEnd, (n) => { revReqEnd = n; }),
    markRevolutResponseStart: () => stampOnce(revResStart, (n) => { revResStart = n; }),
    markRevolutResponseEnd: () => stampOnce(revResEnd, (n) => { revResEnd = n; }),
    markPersistStart: () => stampOnce(persistStart, (n) => { persistStart = n; }),
    markPersistEnd: () => stampOnce(persistEnd, (n) => { persistEnd = n; }),
    markResponseBuildStart: () =>
      stampOnce(responseBuildStart, (n) => { responseBuildStart = n; }),
    setSkippedLiveFareQuote: (skipped) => {
      skippedLiveFareQuote = skipped;
    },
    toFlatFields: () => {
      const now = Date.now();
      const edge_total_ms = Math.max(0, Math.round(now - t0));
      const edge_revolut_request_ms = delta(revReqStart, revReqEnd);
      const edge_revolut_response_ms = delta(revResStart, revResEnd);
      const revolutParts = [edge_revolut_request_ms, edge_revolut_response_ms].filter(
        (n): n is number => typeof n === "number",
      );
      const edge_preauth_revolut_ms = revolutParts.length
        ? revolutParts.reduce((a, b) => a + b, 0)
        : null;
      const edge_auth_ms = delta(authStart, authEnd);
      const edge_persist_ms = delta(persistStart, persistEnd);
      const edge_response_build_ms = delta(responseBuildStart, now);
      return {
        edge_receive_to_auth_ms: delta(t0, authStart ?? authEnd),
        edge_auth_ms,
        edge_db_lookup_ms: delta(dbStart, dbEnd),
        edge_validation_ms: delta(valStart, valEnd),
        edge_revolut_request_ms,
        edge_revolut_response_ms,
        edge_persist_ms,
        edge_response_build_ms,
        edge_total_ms,
        edge_preauth_server_ms: edge_total_ms,
        edge_preauth_revolut_ms,
        preauth_auth_ms: edge_auth_ms,
        preauth_context_ms: delta(contextStart, contextEnd),
        preauth_quote_ms: delta(quoteStart, quoteEnd),
        preauth_config_ms: delta(configStart, configEnd),
        preauth_existing_session_ms: delta(existingSessionStart, existingSessionEnd),
        preauth_provider_prepare_ms: delta(providerPrepareStart, providerPrepareEnd),
        preauth_provider_request_ms: edge_revolut_request_ms,
        preauth_provider_response_ms: edge_revolut_response_ms,
        preauth_persist_ms: edge_persist_ms,
        preauth_response_build_ms: edge_response_build_ms,
        preauth_edge_total_ms: edge_total_ms,
        preauth_skipped_live_fare_quote: skippedLiveFareQuote,
        booking_milestones: {
          hold_start_ms: t0,
          hold_authorised_ms: now,
          hold_duration_ms: edge_total_ms,
        },
      };
    },
    attachToBody: <T extends Record<string, unknown>>(body: T) => {
      api.markResponseBuildStart();
      const flat = api.toFlatFields();
      const existingMilestones =
        body.booking_milestones && typeof body.booking_milestones === "object"
          ? (body.booking_milestones as Record<string, unknown>)
          : {};
      return {
        ...body,
        ...flat,
        booking_milestones: {
          ...existingMilestones,
          ...flat.booking_milestones,
        },
      };
    },
  };
  return api;
}

export function jsonResponseWithPreauthTiming(
  body: Record<string, unknown>,
  corsHeaders: Record<string, string>,
  status: number,
  timing: PreauthEdgeTiming | null | undefined,
): Response {
  const payload = timing ? timing.attachToBody(body) : body;
  return new Response(JSON.stringify(payload), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
    status,
  });
}
