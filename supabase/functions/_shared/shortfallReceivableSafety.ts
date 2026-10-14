/**
 * Partial-capture shortfall safety net.
 *
 * After a declined increment the customer receivable SSOT owns the shortfall
 * (recovered on the next booking). If that receivable cannot be saved, the
 * shortfall must still be durable and visible to finance:
 *
 *   receivable (idempotent, retried once)
 *     → finance_shortfall_exceptions row (separate RPC / transaction)
 *       → ops_alerts escalation (separate table) + structured log
 *
 * The payment session `metadata.shortfall_pence` marker written before this
 * runs is the last-resort evidence Financial Reconciliation detects.
 *
 * Never touches TEN, commission, payout, Revolut increment or capture.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { recordReceivableAfterDeclinedIncrement } from "./customerReceivableLifecycle.ts";
import { planCreateReceivableFromDeclinedIncrement } from "./customerReceivableSSOT.ts";
import { mutatePaymentSession } from "./paymentSessionMutationCore.ts";

export const SHORTFALL_EXCEPTION_STATUS = {
  OPEN: "OPEN",
  RESOLVED_RECEIVABLE_RECORDED: "RESOLVED_RECEIVABLE_RECORDED",
  WRITTEN_OFF: "WRITTEN_OFF",
} as const;

export const SHORTFALL_SAFETY_STATE = {
  NOT_REQUIRED: "NOT_REQUIRED",
  RECEIVABLE_RECORDED: "RECEIVABLE_RECORDED",
  EXCEPTION_RECORDED: "EXCEPTION_RECORDED",
  ESCALATED_UNRECORDED: "ESCALATED_UNRECORDED",
} as const;

export type ShortfallSafetyState =
  (typeof SHORTFALL_SAFETY_STATE)[keyof typeof SHORTFALL_SAFETY_STATE];

/** Structured log tag operators can alert on when every durable write failed. */
export const SHORTFALL_ESCALATION_LOG_TAG = "FINANCE_ESCALATION_SHORTFALL_UNRECORDED";

export const MAX_RECEIVABLE_ATTEMPTS = 2;

export function buildShortfallExceptionIdempotencyKey(tripId: string): string {
  return `shortfall_exception:trip:${tripId}:declined_waiting_v1`;
}

export function buildShortfallEscalationFingerprint(tripId: string): string {
  return `finance:shortfall_unrecorded:${tripId}`;
}

/**
 * First trips covered by the customer receivables ledger (MK-260923-012/017 backfill).
 * Earlier shortfalls were settled by driver adjustments and must never become new customer debt.
 */
export const CUSTOMER_RECEIVABLES_LEDGER_START_ISO = "2026-09-23T00:00:00.000Z";

export function isWithinReceivablesLedger(createdAt: unknown): boolean {
  const ms = Date.parse(String(createdAt ?? ""));
  return Number.isFinite(ms) && ms >= Date.parse(CUSTOMER_RECEIVABLES_LEDGER_START_ISO);
}

/** Shortfall persisted on the payment session by the partial-capture path (0 when absent). */
export function shortfallPenceFromSessionMarker(
  session: { metadata?: unknown } | null | undefined,
): number {
  const meta = session?.metadata;
  if (!meta || typeof meta !== "object") return 0;
  return pence((meta as Record<string, unknown>).shortfall_pence);
}

export type ShortfallSafetyInput = {
  trip_id: string;
  trip_code?: string | null;
  payment_session_id?: string | null;
  provider_order_id?: string | null;
  customer_id?: string | null;
  expected_fare_pence: number;
  captured_pence: number;
  shortfall_pence: number;
  currency?: string | null;
  pickup_waiting_charge_pence?: number | null;
  provider_state?: string | null;
  /** Which caller path detected the shortfall (partial_capture, zero_capture, already_captured_retry). */
  source: string;
};

export type ShortfallSafetyOutcome = {
  state: ShortfallSafetyState;
  manual_review: boolean;
  shortfall_pence: number;
  receivable_id: string | null;
  receivable_created: boolean;
  exception_id: string | null;
  exception_created: boolean;
  escalated: boolean;
  receivable_attempts: number;
  errors: string[];
};

type RecordReceivable = typeof recordReceivableAfterDeclinedIncrement;

export type ShortfallSafetyDeps = {
  recordReceivable?: RecordReceivable;
  log?: (tag: string, payload: Record<string, unknown>) => void;
};

export type ShortfallMarkerCommit = {
  committed: boolean;
  sessionId: string | null;
  error?: string;
};

export type ShortfallRecoveryCandidate = {
  tripId: string;
  sessionId: string | null;
  providerOrderId: string | null;
  customerId: string | null;
  expectedFarePence: number;
  capturedPence: number;
  shortfallPence: number;
  currency: string;
  createdAt: string | null;
  source: "session_marker" | "uncommitted_marker_alert";
};

function pence(v: unknown): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function errText(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message?: unknown }).message ?? "");
  }
  return String(err ?? "");
}

function outcome(
  state: ShortfallSafetyState,
  shortfall: number,
  patch: Partial<ShortfallSafetyOutcome>,
): ShortfallSafetyOutcome {
  return {
    state,
    manual_review: state === SHORTFALL_SAFETY_STATE.EXCEPTION_RECORDED
      || state === SHORTFALL_SAFETY_STATE.ESCALATED_UNRECORDED,
    shortfall_pence: shortfall,
    receivable_id: null,
    receivable_created: false,
    exception_id: null,
    exception_created: false,
    escalated: false,
    receivable_attempts: 0,
    errors: [],
    ...patch,
  };
}

async function resolveOpenException(
  supabase: SupabaseClient,
  tripId: string,
  receivableId: string,
): Promise<string | null> {
  try {
    const { error } = await supabase.rpc("finance_resolve_shortfall_exception_receivable", {
      p_trip_id: tripId,
      p_receivable_id: receivableId,
    });
    return error ? errText(error) : null;
  } catch (err) {
    return errText(err);
  }
}

async function recordException(
  supabase: SupabaseClient,
  input: ShortfallSafetyInput,
  shortfall: number,
  failurePhase: string,
  failureMessage: string,
): Promise<{ ok: true; id: string; created: boolean } | { ok: false; error: string }> {
  try {
    const { data, error } = await supabase.rpc("finance_record_shortfall_exception", {
      p_idempotency_key: buildShortfallExceptionIdempotencyKey(input.trip_id),
      p_trip_id: input.trip_id,
      p_payment_session_id: input.payment_session_id ?? null,
      p_provider_order_id: input.provider_order_id ?? null,
      p_customer_id: input.customer_id ?? null,
      p_currency: (input.currency ?? "gbp").toLowerCase(),
      p_expected_fare_pence: pence(input.expected_fare_pence),
      p_captured_pence: Math.max(0, Math.round(Number(input.captured_pence) || 0)),
      p_shortfall_pence: shortfall,
      p_failure_phase: failurePhase,
      p_failure_message: failureMessage,
      p_metadata: {
        source: input.source,
        trip_code: input.trip_code ?? null,
        provider_state: input.provider_state ?? null,
        pickup_waiting_charge_pence: pence(input.pickup_waiting_charge_pence),
        money_moved: false,
        ten_repair_forbidden: true,
      },
    });
    if (error) return { ok: false, error: errText(error) };
    const row = data as { ok?: boolean; exception_id?: string; created?: boolean } | null;
    if (!row?.ok || !row.exception_id) {
      return { ok: false, error: "finance_record_shortfall_exception returned no exception_id" };
    }
    return { ok: true, id: String(row.exception_id), created: row.created === true };
  } catch (err) {
    return { ok: false, error: errText(err) };
  }
}

async function raiseOpsAlert(
  supabase: SupabaseClient,
  input: ShortfallSafetyInput,
  shortfall: number,
  severity: "warning" | "critical",
  errors: string[],
): Promise<boolean> {
  const unrecorded = severity === "critical";
  try {
    const { error } = await supabase.from("ops_alerts").insert({
      fingerprint: buildShortfallEscalationFingerprint(input.trip_id),
      category: "payment",
      severity,
      status: "open",
      source: "system",
      app: "backend",
      title: unrecorded
        ? `Unrecorded customer shortfall ${shortfall}p — finance action required`
        : `Customer shortfall ${shortfall}p held as finance exception`,
      description: unrecorded
        ? "Partial capture shortfall has no customer receivable and no finance exception. Payment session marker is the only record."
        : "Customer receivable could not be saved. A finance shortfall exception was recorded instead.",
      related_trip_id: input.trip_id,
      related_entity_type: "payment_session",
      related_entity_id: input.payment_session_id ?? null,
      metadata: {
        trip_code: input.trip_code ?? null,
        payment_session_id: input.payment_session_id ?? null,
        provider_order_id: input.provider_order_id ?? null,
        expected_fare_pence: pence(input.expected_fare_pence),
        captured_pence: Math.max(0, Math.round(Number(input.captured_pence) || 0)),
        shortfall_pence: shortfall,
        source: input.source,
        customer_id: input.customer_id ?? null,
        errors,
        money_moved: false,
      },
    });
    // 23505: an open alert with this fingerprint already exists — still escalated.
    return !error || error.code === "23505";
  } catch {
    return false;
  }
}

/**
 * Commit the payment-session shortfall marker and read it back.
 * A swallowed update or a zero-row update is not committed.
 * Does not create a receivable and does not call Revolut.
 */
export async function commitShortfallSessionMarker(
  supabase: SupabaseClient,
  args: {
    sessionId?: string | null;
    providerOrderId?: string | null;
    tripId: string;
    shortfallPence: number;
    expectedFarePence?: number | null;
    capturedPence?: number | null;
    reason: string;
  },
): Promise<ShortfallMarkerCommit> {
  const shortfall = pence(args.shortfallPence);
  if (!args.tripId || shortfall <= 0) {
    return { committed: false, sessionId: null, error: "missing_trip_or_shortfall" };
  }

  let sessionId = String(args.sessionId ?? "").trim() || null;
  let metadata: Record<string, unknown> = {};
  try {
    let query = supabase.from("payment_sessions").select("id, metadata, trip_id");
    query = sessionId
      ? query.eq("id", sessionId)
      : query.eq("provider_order_id", String(args.providerOrderId ?? ""));
    const { data, error } = await query.limit(1).maybeSingle();
    if (error) return { committed: false, sessionId, error: errText(error) };
    const row = data as { id?: string; metadata?: unknown; trip_id?: string } | null;
    if (!row?.id) return { committed: false, sessionId, error: "session_not_found" };
    sessionId = String(row.id);
    if (row.trip_id && String(row.trip_id) !== args.tripId) {
      return { committed: false, sessionId, error: "session_trip_mismatch" };
    }
    if (row.metadata && typeof row.metadata === "object") {
      metadata = { ...(row.metadata as Record<string, unknown>) };
    }
  } catch (err) {
    return { committed: false, sessionId, error: errText(err) };
  }

  metadata.shortfall_pence = shortfall;
  metadata.shortfall_marker_trip_id = args.tripId;
  metadata.shortfall_expected_fare_pence = pence(args.expectedFarePence);
  metadata.shortfall_captured_pence = Math.max(0, Math.round(Number(args.capturedPence) || 0));
  const write = await mutatePaymentSession(supabase, { sessionId }, {
    trip_id: args.tripId,
    failure_reason: args.reason,
    status: "payment_shortfall",
    metadata,
  }, "ssot");
  if (!write.ok) {
    return { committed: false, sessionId, error: write.error ?? "marker_update_failed" };
  }

  try {
    const { data, error } = await supabase
      .from("payment_sessions")
      .select("id, metadata")
      .eq("id", sessionId)
      .maybeSingle();
    if (error) return { committed: false, sessionId, error: errText(error) };
    const seen = shortfallPenceFromSessionMarker(data as { metadata?: unknown } | null);
    if (seen !== shortfall) {
      return { committed: false, sessionId, error: "marker_readback_mismatch" };
    }
    return { committed: true, sessionId };
  } catch (err) {
    return { committed: false, sessionId, error: errText(err) };
  }
}

/** Durable escalation when the marker itself cannot be committed. No receivable, no charge. */
export async function escalateUncommittedShortfallMarker(
  supabase: SupabaseClient,
  input: ShortfallSafetyInput,
  error: string,
  deps: ShortfallSafetyDeps = {},
): Promise<ShortfallSafetyOutcome> {
  const log = deps.log ?? ((tag, payload) => console.error(`[shortfallSafety] ${tag}`, JSON.stringify(payload)));
  const shortfall = pence(input.shortfall_pence);
  const errors = [`marker_uncommitted: ${error}`];
  const escalated = await raiseOpsAlert(supabase, input, shortfall, "critical", errors);
  log(SHORTFALL_ESCALATION_LOG_TAG, {
    trip_id: input.trip_id,
    trip_code: input.trip_code ?? null,
    payment_session_id: input.payment_session_id ?? null,
    provider_order_id: input.provider_order_id ?? null,
    expected_fare_pence: pence(input.expected_fare_pence),
    captured_pence: Math.max(0, Math.round(Number(input.captured_pence) || 0)),
    shortfall_pence: shortfall,
    marker_committed: false,
    ops_alert_written: escalated,
    errors,
  });
  return outcome(SHORTFALL_SAFETY_STATE.ESCALATED_UNRECORDED, shortfall, {
    escalated,
    errors,
  });
}

/**
 * Marker commit (retried once) is confirmed by read-back before any receivable write.
 * If the marker cannot be committed, receivable is not attempted; an ops alert is the durable record.
 */
export async function recordShortfallAfterConfirmedMarker(
  supabase: SupabaseClient,
  input: ShortfallSafetyInput,
  marker: { sessionId?: string | null; providerOrderId?: string | null; reason: string },
  deps: ShortfallSafetyDeps = {},
): Promise<ShortfallSafetyOutcome & { marker_committed: boolean }> {
  let lastError = "marker_not_attempted";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const committed = await commitShortfallSessionMarker(supabase, {
      sessionId: marker.sessionId ?? input.payment_session_id,
      providerOrderId: marker.providerOrderId ?? input.provider_order_id,
      tripId: input.trip_id,
      shortfallPence: input.shortfall_pence,
      expectedFarePence: input.expected_fare_pence,
      capturedPence: input.captured_pence,
      reason: marker.reason,
    });
    if (committed.committed) {
      const safety = await ensureShortfallReceivableOrException(supabase, {
        ...input,
        payment_session_id: committed.sessionId ?? input.payment_session_id,
      }, deps);
      return { ...safety, marker_committed: true };
    }
    lastError = committed.error ?? "marker_uncommitted";
  }
  const escalated = await escalateUncommittedShortfallMarker(supabase, input, lastError, deps);
  return { ...escalated, marker_committed: false };
}

function candidateFromMarker(args: {
  tripId: string;
  sessionId: string | null;
  providerOrderId: string | null;
  shortfallPence: number;
  capturedPence: number;
  expectedFarePence: number;
  currency: string | null;
  createdAt: string | null;
  source: ShortfallRecoveryCandidate["source"];
  customerId?: string | null;
}): ShortfallRecoveryCandidate {
  return {
    tripId: args.tripId,
    sessionId: args.sessionId,
    providerOrderId: args.providerOrderId,
    customerId: args.customerId ?? null,
    expectedFarePence: args.expectedFarePence > 0 ? args.expectedFarePence : args.capturedPence + args.shortfallPence,
    capturedPence: Math.max(0, Math.round(args.capturedPence)),
    shortfallPence: args.shortfallPence,
    currency: (args.currency ?? "gbp").toLowerCase(),
    createdAt: args.createdAt,
    source: args.source,
  };
}

/**
 * Recovery queue. Trips that already have a receivable are skipped, so a retry
 * cannot create a second debt or a second customer charge. No provider call.
 */
export function selectShortfallRecoveryCandidates(args: {
  sessions: Array<{
    id?: string | null;
    trip_id?: string | null;
    provider_order_id?: string | null;
    status?: string | null;
    provider_state?: string | null;
    created_at?: string | null;
    currency?: string | null;
    captured_amount_pence?: number | null;
    metadata?: unknown;
  }>;
  alerts?: Array<{
    fingerprint?: string | null;
    status?: string | null;
    related_trip_id?: string | null;
    metadata?: unknown;
  }>;
  receivableTripIds: Iterable<string>;
}): ShortfallRecoveryCandidate[] {
  const haveReceivable = new Set([...args.receivableTripIds].map(String));
  const chosen = new Map<string, ShortfallRecoveryCandidate>();

  for (const session of args.sessions ?? []) {
    const tripId = String(session.trip_id ?? "");
    const shortfall = shortfallPenceFromSessionMarker(session);
    const status = String(session.status ?? "").toUpperCase();
    const provider = String(session.provider_state ?? "").toUpperCase();
    if (!tripId || shortfall <= 0 || haveReceivable.has(tripId) || chosen.has(tripId)) continue;
    if (status === "CANCELLED" || provider === "CANCELLED") continue;
    if (!isWithinReceivablesLedger(session.created_at ?? null)) continue;
    const meta = session.metadata && typeof session.metadata === "object"
      ? session.metadata as Record<string, unknown>
      : {};
    const capturedFromMarker = Math.round(Number(meta.shortfall_captured_pence) || 0);
    chosen.set(tripId, candidateFromMarker({
      tripId,
      sessionId: session.id ? String(session.id) : null,
      providerOrderId: session.provider_order_id ? String(session.provider_order_id) : null,
      shortfallPence: shortfall,
      capturedPence: capturedFromMarker > 0
        ? capturedFromMarker
        : Math.round(Number(session.captured_amount_pence) || 0),
      expectedFarePence: pence(meta.shortfall_expected_fare_pence),
      currency: session.currency ?? null,
      createdAt: session.created_at ?? null,
      source: "session_marker",
    }));
  }

  for (const alert of args.alerts ?? []) {
    const tripId = String(alert.related_trip_id ?? "");
    const fingerprint = String(alert.fingerprint ?? "");
    const status = String(alert.status ?? "").toLowerCase();
    if (!tripId || status !== "open" || !fingerprint.startsWith("finance:shortfall_unrecorded:")) continue;
    if (haveReceivable.has(tripId) || chosen.has(tripId)) continue;
    const meta = alert.metadata && typeof alert.metadata === "object"
      ? alert.metadata as Record<string, unknown>
      : {};
    const shortfall = pence(meta.shortfall_pence);
    if (shortfall <= 0) continue;
    chosen.set(tripId, candidateFromMarker({
      tripId,
      sessionId: meta.payment_session_id ? String(meta.payment_session_id) : null,
      providerOrderId: meta.provider_order_id ? String(meta.provider_order_id) : null,
      shortfallPence: shortfall,
      capturedPence: Math.round(Number(meta.captured_pence) || 0),
      expectedFarePence: pence(meta.expected_fare_pence),
      currency: "gbp",
      createdAt: null,
      customerId: meta.customer_id ? String(meta.customer_id) : null,
      source: "uncommitted_marker_alert",
    }));
  }

  return [...chosen.values()];
}

/**
 * Idempotent: every write is keyed per trip, so retries and duplicate
 * callbacks converge on one receivable, one exception and one open alert.
 */
export async function ensureShortfallReceivableOrException(
  supabase: SupabaseClient,
  input: ShortfallSafetyInput,
  deps: ShortfallSafetyDeps = {},
): Promise<ShortfallSafetyOutcome> {
  const recordReceivable = deps.recordReceivable ?? recordReceivableAfterDeclinedIncrement;
  const log = deps.log ?? ((tag, payload) => console.error(`[shortfallSafety] ${tag}`, JSON.stringify(payload)));

  const receivableArgs = {
    customer_id: input.customer_id ?? null,
    source_trip_id: input.trip_id,
    source_payment_session_id: input.payment_session_id ?? null,
    final_fare_pence: input.expected_fare_pence,
    captured_pence: input.captured_pence,
    shortfall_pence: input.shortfall_pence,
    currency: input.currency ?? "gbp",
    pickup_waiting_charge_pence: input.pickup_waiting_charge_pence ?? null,
    provider_state: input.provider_state ?? null,
  };
  const plan = planCreateReceivableFromDeclinedIncrement(receivableArgs);
  const shortfall = plan.outstanding_amount_pence;

  if (!plan.should_create && plan.reject_reason !== "missing_customer_or_trip") {
    return outcome(SHORTFALL_SAFETY_STATE.NOT_REQUIRED, shortfall, {
      errors: plan.reject_reason ? [plan.reject_reason] : [],
    });
  }
  if (!input.trip_id || shortfall <= 0) {
    return outcome(SHORTFALL_SAFETY_STATE.NOT_REQUIRED, shortfall, {
      errors: ["missing_trip_or_shortfall"],
    });
  }

  const errors: string[] = [];
  let attempts = 0;
  let failurePhase = "RECEIVABLE_PERSISTENCE_UNAVAILABLE";

  if (plan.should_create) {
    while (attempts < MAX_RECEIVABLE_ATTEMPTS) {
      attempts += 1;
      let recv: Awaited<ReturnType<RecordReceivable>>;
      try {
        recv = await recordReceivable(supabase, receivableArgs);
      } catch (err) {
        errors.push(errText(err));
        continue;
      }
      if (recv.ok && recv.data.receivable_id) {
        const resolveErr = await resolveOpenException(supabase, input.trip_id, recv.data.receivable_id);
        if (resolveErr) errors.push(`resolve_exception: ${resolveErr}`);
        return outcome(SHORTFALL_SAFETY_STATE.RECEIVABLE_RECORDED, shortfall, {
          receivable_id: recv.data.receivable_id,
          receivable_created: recv.data.created,
          receivable_attempts: attempts,
          errors,
        });
      }
      errors.push(recv.ok ? "receivable_not_created" : recv.error.message);
    }
  } else {
    failurePhase = "MISSING_CUSTOMER";
    errors.push("missing_customer_or_trip");
  }

  const exception = await recordException(
    supabase,
    input,
    shortfall,
    failurePhase,
    errors.join(" | ").slice(0, 1000),
  );
  if (exception.ok) {
    const escalated = await raiseOpsAlert(supabase, input, shortfall, "warning", errors);
    log("SHORTFALL_EXCEPTION_RECORDED", {
      trip_id: input.trip_id,
      exception_id: exception.id,
      shortfall_pence: shortfall,
      escalated,
    });
    return outcome(SHORTFALL_SAFETY_STATE.EXCEPTION_RECORDED, shortfall, {
      exception_id: exception.id,
      exception_created: exception.created,
      escalated,
      receivable_attempts: attempts,
      errors,
    });
  }

  errors.push(`exception: ${exception.error}`);
  const escalated = await raiseOpsAlert(supabase, input, shortfall, "critical", errors);
  log(SHORTFALL_ESCALATION_LOG_TAG, {
    trip_id: input.trip_id,
    trip_code: input.trip_code ?? null,
    payment_session_id: input.payment_session_id ?? null,
    provider_order_id: input.provider_order_id ?? null,
    expected_fare_pence: pence(input.expected_fare_pence),
    captured_pence: Math.max(0, Math.round(Number(input.captured_pence) || 0)),
    shortfall_pence: shortfall,
    ops_alert_written: escalated,
    errors,
  });
  return outcome(SHORTFALL_SAFETY_STATE.ESCALATED_UNRECORDED, shortfall, {
    escalated,
    receivable_attempts: attempts,
    errors,
  });
}
