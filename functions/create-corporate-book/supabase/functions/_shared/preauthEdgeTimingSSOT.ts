/**
 * Observability-only create-preauth Edge timing.
 * Never changes payment / Revolut semantics — only stamps flat ms fields on responses.
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

  const api: PreauthEdgeTiming = {
    t0,
    markAuthStart: () => {
      if (authStart == null) authStart = Date.now();
    },
    markAuthEnd: () => {
      if (authEnd == null) authEnd = Date.now();
    },
    markDbLookupStart: () => {
      if (dbStart == null) dbStart = Date.now();
    },
    markDbLookupEnd: () => {
      if (dbEnd == null) dbEnd = Date.now();
    },
    markValidationStart: () => {
      if (valStart == null) valStart = Date.now();
    },
    markValidationEnd: () => {
      if (valEnd == null) valEnd = Date.now();
    },
    markRevolutRequestStart: () => {
      if (revReqStart == null) revReqStart = Date.now();
    },
    markRevolutRequestEnd: () => {
      if (revReqEnd == null) revReqEnd = Date.now();
    },
    markRevolutResponseStart: () => {
      if (revResStart == null) revResStart = Date.now();
    },
    markRevolutResponseEnd: () => {
      if (revResEnd == null) revResEnd = Date.now();
    },
    markPersistStart: () => {
      if (persistStart == null) persistStart = Date.now();
    },
    markPersistEnd: () => {
      if (persistEnd == null) persistEnd = Date.now();
    },
    markResponseBuildStart: () => {
      if (responseBuildStart == null) responseBuildStart = Date.now();
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
      const response_build_end = now;
      return {
        edge_receive_to_auth_ms: delta(t0, authStart ?? authEnd),
        edge_auth_ms: delta(authStart, authEnd),
        edge_db_lookup_ms: delta(dbStart, dbEnd),
        edge_validation_ms: delta(valStart, valEnd),
        edge_revolut_request_ms,
        edge_revolut_response_ms,
        edge_persist_ms: delta(persistStart, persistEnd),
        edge_response_build_ms: delta(responseBuildStart, response_build_end),
        edge_total_ms,
        edge_preauth_server_ms: edge_total_ms,
        edge_preauth_revolut_ms,
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
