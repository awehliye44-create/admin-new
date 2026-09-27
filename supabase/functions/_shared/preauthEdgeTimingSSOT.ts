/**
 * Observability-only create-preauth Edge timing.
 * Never changes payment / Revolut semantics — only stamps flat ms fields on responses.
 *
 * Phase 1: residual instrumentation for Apple Pay (~1.6s unaccounted historically).
 * Parallel-aware: edge_accounted_wall_ms is critical-path wall, not naive stage sum;
 * edge_unaccounted_ms = edge_total_ms - edge_accounted_wall_ms.
 */

export type PreauthEdgeTimingFlat = {
  edge_receive_to_auth_ms: number | null;
  edge_auth_ms: number | null;
  edge_eligibility_ms: number | null;
  edge_fare_quote_ms: number | null;
  edge_customer_lookup_ms: number | null;
  edge_offer_resolve_ms: number | null;
  edge_financial_model_ms: number | null;
  edge_gateway_ms: number | null;
  edge_buffer_ms: number | null;
  edge_currency_ms: number | null;
  edge_db_lookup_ms: number | null;
  edge_validation_ms: number | null;
  edge_payment_session_ms: number | null;
  edge_ledger_ms: number | null;
  edge_receivable_ms: number | null;
  edge_revolut_request_ms: number | null;
  edge_revolut_response_ms: number | null;
  edge_persist_ms: number | null;
  edge_response_build_ms: number | null;
  /** Critical-path wall of measured ops (parallel-aware, not naive sum). */
  edge_accounted_wall_ms: number | null;
  edge_unaccounted_ms: number | null;
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
  markEligibilityStart: () => void;
  markEligibilityEnd: () => void;
  markFareQuoteStart: () => void;
  markFareQuoteEnd: () => void;
  markCustomerLookupStart: () => void;
  markCustomerLookupEnd: () => void;
  markOfferResolveStart: () => void;
  markOfferResolveEnd: () => void;
  markFinancialModelStart: () => void;
  markFinancialModelEnd: () => void;
  markGatewayStart: () => void;
  markGatewayEnd: () => void;
  markBufferStart: () => void;
  markBufferEnd: () => void;
  markCurrencyStart: () => void;
  markCurrencyEnd: () => void;
  markDbLookupStart: () => void;
  markDbLookupEnd: () => void;
  markValidationStart: () => void;
  markValidationEnd: () => void;
  markPaymentSessionStart: () => void;
  markPaymentSessionEnd: () => void;
  markLedgerStart: () => void;
  markLedgerEnd: () => void;
  markReceivableStart: () => void;
  markReceivableEnd: () => void;
  markRevolutRequestStart: () => void;
  markRevolutRequestEnd: () => void;
  markRevolutResponseStart: () => void;
  markRevolutResponseEnd: () => void;
  markPersistStart: () => void;
  markPersistEnd: () => void;
  markResponseBuildStart: () => void;
  /** Record a parallel group wall (start/end absolute ms from epoch). */
  recordParallelGroupWall: (startMs: number, endMs: number) => void;
  stampMeasured: (
    kind: "fareQuote" | "customerLookup" | "financialModel" | "gateway",
    startMs: number,
    endMs: number,
  ) => void;
  recordDiagnostic: (key: string, value: number | string | boolean | null) => void;
  toFlatFields: () => PreauthEdgeTimingFlat;
  attachToBody: <T extends Record<string, unknown>>(body: T) => T & PreauthEdgeTimingFlat;
};

function delta(a: number | null, b: number | null): number | null {
  if (a == null || b == null) return null;
  return Math.max(0, Math.round(b - a));
}

type Span = { start: number | null; end: number | null };

function spanMs(s: Span): number | null {
  return delta(s.start, s.end);
}

/**
 * Merge overlapping [start,end] intervals into critical-path wall duration.
 */
export function mergeIntervalWallMs(
  intervals: Array<{ start: number; end: number }>,
): number {
  const clean = intervals
    .filter((i) => Number.isFinite(i.start) && Number.isFinite(i.end) && i.end >= i.start)
    .map((i) => ({ start: i.start, end: i.end }))
    .sort((a, b) => a.start - b.start);
  if (clean.length === 0) return 0;
  let wall = 0;
  let curStart = clean[0]!.start;
  let curEnd = clean[0]!.end;
  for (let i = 1; i < clean.length; i++) {
    const n = clean[i]!;
    if (n.start <= curEnd) {
      curEnd = Math.max(curEnd, n.end);
    } else {
      wall += curEnd - curStart;
      curStart = n.start;
      curEnd = n.end;
    }
  }
  wall += curEnd - curStart;
  return Math.max(0, Math.round(wall));
}

export function createPreauthEdgeTiming(startedAtMs = Date.now()): PreauthEdgeTiming {
  const t0 = startedAtMs;
  const auth: Span = { start: null, end: null };
  const eligibility: Span = { start: null, end: null };
  const fareQuote: Span = { start: null, end: null };
  const customerLookup: Span = { start: null, end: null };
  const offerResolve: Span = { start: null, end: null };
  const financialModel: Span = { start: null, end: null };
  const gateway: Span = { start: null, end: null };
  const buffer: Span = { start: null, end: null };
  const currency: Span = { start: null, end: null };
  const db: Span = { start: null, end: null };
  const validation: Span = { start: null, end: null };
  const paymentSession: Span = { start: null, end: null };
  const ledger: Span = { start: null, end: null };
  const receivable: Span = { start: null, end: null };
  const revReq: Span = { start: null, end: null };
  const revRes: Span = { start: null, end: null };
  const persist: Span = { start: null, end: null };
  let responseBuildStart: number | null = null;
  const extraParallel: Array<{ start: number; end: number }> = [];
  const diagnostics: Record<string, number | string | boolean | null> = {};
  const spanByKind = {
    fareQuote,
    customerLookup,
    financialModel,
    gateway,
  } as const;

  const markStart = (s: Span) => {
    if (s.start == null) s.start = Date.now();
  };
  const markEnd = (s: Span) => {
    if (s.end == null) s.end = Date.now();
  };

  const api: PreauthEdgeTiming = {
    t0,
    markAuthStart: () => markStart(auth),
    markAuthEnd: () => markEnd(auth),
    markEligibilityStart: () => markStart(eligibility),
    markEligibilityEnd: () => markEnd(eligibility),
    markFareQuoteStart: () => markStart(fareQuote),
    markFareQuoteEnd: () => markEnd(fareQuote),
    markCustomerLookupStart: () => markStart(customerLookup),
    markCustomerLookupEnd: () => markEnd(customerLookup),
    markOfferResolveStart: () => markStart(offerResolve),
    markOfferResolveEnd: () => markEnd(offerResolve),
    markFinancialModelStart: () => markStart(financialModel),
    markFinancialModelEnd: () => markEnd(financialModel),
    markGatewayStart: () => markStart(gateway),
    markGatewayEnd: () => markEnd(gateway),
    markBufferStart: () => markStart(buffer),
    markBufferEnd: () => markEnd(buffer),
    markCurrencyStart: () => markStart(currency),
    markCurrencyEnd: () => markEnd(currency),
    markDbLookupStart: () => markStart(db),
    markDbLookupEnd: () => markEnd(db),
    markValidationStart: () => markStart(validation),
    markValidationEnd: () => markEnd(validation),
    markPaymentSessionStart: () => markStart(paymentSession),
    markPaymentSessionEnd: () => markEnd(paymentSession),
    markLedgerStart: () => markStart(ledger),
    markLedgerEnd: () => markEnd(ledger),
    markReceivableStart: () => markStart(receivable),
    markReceivableEnd: () => markEnd(receivable),
    markRevolutRequestStart: () => markStart(revReq),
    markRevolutRequestEnd: () => markEnd(revReq),
    markRevolutResponseStart: () => markStart(revRes),
    markRevolutResponseEnd: () => markEnd(revRes),
    markPersistStart: () => markStart(persist),
    markPersistEnd: () => markEnd(persist),
    markResponseBuildStart: () => {
      if (responseBuildStart == null) responseBuildStart = Date.now();
    },
    recordParallelGroupWall: (startMs, endMs) => {
      if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs) {
        extraParallel.push({ start: startMs, end: endMs });
      }
    },
    stampMeasured: (kind, startMs, endMs) => {
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return;
      const span = spanByKind[kind];
      span.start = startMs;
      span.end = endMs;
    },
    recordDiagnostic: (key, value) => {
      diagnostics[key] = value;
    },
    toFlatFields: () => {
      const now = Date.now();
      const edge_total_ms = Math.max(0, Math.round(now - t0));
      const edge_revolut_request_ms = spanMs(revReq);
      // Order create is one HTTP round trip. When no separate pay/response span
      // exists, report that same RTT as edge_revolut_response_ms (not a second wait).
      const edge_revolut_response_ms = spanMs(revRes) ?? edge_revolut_request_ms;
      const revolutIntervals: Array<{ start: number; end: number }> = [];
      if (revReq.start != null && revReq.end != null && revReq.end >= revReq.start) {
        revolutIntervals.push({ start: revReq.start, end: revReq.end });
      }
      if (revRes.start != null && revRes.end != null && revRes.end >= revRes.start) {
        revolutIntervals.push({ start: revRes.start, end: revRes.end });
      }
      const edge_preauth_revolut_ms = revolutIntervals.length
        ? mergeIntervalWallMs(revolutIntervals)
        : null;

      const spans: Span[] = [
        auth,
        eligibility,
        fareQuote,
        customerLookup,
        offerResolve,
        financialModel,
        gateway,
        buffer,
        currency,
        db,
        validation,
        paymentSession,
        ledger,
        receivable,
        revReq,
        revRes,
        persist,
        { start: responseBuildStart, end: now },
      ];
      const intervals: Array<{ start: number; end: number }> = [];
      for (const s of spans) {
        if (s.start != null && s.end != null && s.end >= s.start) {
          intervals.push({ start: s.start, end: s.end });
        }
      }
      intervals.push(...extraParallel);
      const edge_accounted_wall_ms = mergeIntervalWallMs(intervals);
      const edge_unaccounted_ms = Math.max(0, edge_total_ms - edge_accounted_wall_ms);

      return {
        edge_receive_to_auth_ms: delta(t0, auth.start ?? auth.end),
        edge_auth_ms: spanMs(auth),
        edge_eligibility_ms: spanMs(eligibility),
        edge_fare_quote_ms: spanMs(fareQuote),
        edge_customer_lookup_ms: spanMs(customerLookup),
        edge_offer_resolve_ms: spanMs(offerResolve),
        edge_financial_model_ms: spanMs(financialModel),
        edge_gateway_ms: spanMs(gateway),
        edge_buffer_ms: spanMs(buffer),
        edge_currency_ms: spanMs(currency),
        edge_db_lookup_ms: spanMs(db),
        edge_validation_ms: spanMs(validation),
        edge_payment_session_ms: spanMs(paymentSession),
        edge_ledger_ms: spanMs(ledger),
        edge_receivable_ms: spanMs(receivable),
        edge_revolut_request_ms,
        edge_revolut_response_ms,
        edge_persist_ms: spanMs(persist),
        edge_response_build_ms: delta(responseBuildStart, now),
        edge_accounted_wall_ms,
        edge_unaccounted_ms,
        edge_total_ms,
        edge_preauth_server_ms: edge_total_ms,
        edge_preauth_revolut_ms,
        ...diagnostics,
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
