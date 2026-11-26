/**
 * P6 M1 — bounded retry for sweep-revolut-stale-holds via payment_sessions.metadata.
 *
 * Pattern mirrors reconcile-submitted-driver-withdrawals `computeNextRetrySeconds`
 * (exponential, hard-capped). Rows are never abandoned: past
 * SWEEP_MAX_ATTEMPTS_BEFORE_ESCALATION the cadence stays at the cap and the row is
 * reported as `sweep_escalated` in the watchdog.
 *
 * Capture safety: a row whose last attempt ended with an ambiguous fee capture
 * (`sweep_capture_ambiguous`) is RECONCILE-ONLY — GET the Revolut order and never
 * hand it back to the disposer (which could POST a capture) while the provider
 * still reports an open order, until the escalation hatch below.
 */

export const SWEEP_BACKOFF_BASE_SECONDS = 300;
export const SWEEP_MAX_BACKOFF_SECONDS = 6 * 60 * 60;
export const SWEEP_MAX_ATTEMPTS_BEFORE_ESCALATION = 10;
/**
 * After this many reconcile-only passes with the provider order still open, the
 * row is handed back to the canonical disposer. The disposer's guarded capture is
 * GET-first with a persisted idempotency key — never a blind POST.
 */
export const SWEEP_RECONCILE_ONLY_MAX_ATTEMPTS = 4;

export const SWEEP_META_NEXT_AT = "sweep_next_at";
export const SWEEP_META_ATTEMPTS = "sweep_attempts";
export const SWEEP_META_LAST_OUTCOME = "sweep_last_outcome";
export const SWEEP_META_CAPTURE_AMBIGUOUS = "sweep_capture_ambiguous";

/** SQL RPC that atomically merges the sweep_* keys into payment_sessions.metadata. */
export const SWEEP_STAMP_RPC = "stamp_payment_session_sweep_retry";

/** attempt: 0-based count of prior attempts. */
export function computeSweepNextRetrySeconds(attempt: number): number {
  const a = Math.max(0, Math.floor(Number(attempt) || 0));
  return Math.min(SWEEP_BACKOFF_BASE_SECONDS * Math.pow(2, a), SWEEP_MAX_BACKOFF_SECONDS);
}

export type SweepRetryMeta = {
  attempts: number;
  nextAtMs: number | null;
  captureAmbiguous: boolean;
  lastOutcome: string | null;
};

export function parseSweepRetryMeta(metadata: unknown): SweepRetryMeta {
  const meta = metadata && typeof metadata === "object"
    ? metadata as Record<string, unknown>
    : {};
  const attempts = Math.max(0, Math.floor(Number(meta[SWEEP_META_ATTEMPTS]) || 0));
  const rawNext = meta[SWEEP_META_NEXT_AT];
  const nextAtMs = typeof rawNext === "string" ? Date.parse(rawNext) : NaN;
  return {
    attempts,
    nextAtMs: Number.isFinite(nextAtMs) ? nextAtMs : null,
    captureAmbiguous: meta[SWEEP_META_CAPTURE_AMBIGUOUS] === true,
    lastOutcome: typeof meta[SWEEP_META_LAST_OUTCOME] === "string"
      ? String(meta[SWEEP_META_LAST_OUTCOME])
      : null,
  };
}

/** Mirror of the SQL WHERE (defence in depth when a row slips through the filter). */
export function isSweepDeferred(metadata: unknown, nowMs: number): boolean {
  const { nextAtMs } = parseSweepRetryMeta(metadata);
  return nextAtMs != null && nextAtMs > nowMs;
}

export function isSweepEscalated(attempts: number): boolean {
  return Math.max(0, Math.floor(Number(attempts) || 0)) >= SWEEP_MAX_ATTEMPTS_BEFORE_ESCALATION;
}

export function buildSweepRetryStamp(args: {
  priorAttempts: number;
  nowMs: number;
  outcome: string;
  captureAmbiguous: boolean;
}): {
  attempts: number;
  nextAtIso: string;
  outcome: string;
  captureAmbiguous: boolean;
} {
  const prior = Math.max(0, Math.floor(Number(args.priorAttempts) || 0));
  const delaySeconds = computeSweepNextRetrySeconds(prior);
  return {
    attempts: prior + 1,
    nextAtIso: new Date(args.nowMs + delaySeconds * 1000).toISOString(),
    outcome: String(args.outcome).slice(0, 80),
    captureAmbiguous: args.captureAmbiguous === true,
  };
}

const NON_AMBIGUOUS_PENDING_MESSAGES = new Set([
  "disposition_already_in_progress",
  "fee_capture_requires_payment_session",
]);

/**
 * True when the disposer's PENDING outcome may follow a fee-capture request that
 * reached (or may have reached) Revolut — the next pass must GET before anything else.
 */
export function isAmbiguousFeeCaptureOutcome(result: {
  outcome?: string | null;
  message?: string | null;
  decision?: { provider_action?: string | null } | null;
}): boolean {
  if (String(result.outcome ?? "") !== "PROVIDER_PENDING_RECONCILIATION") return false;
  if (result.decision?.provider_action !== "partial_capture_fee") return false;
  const msg = String(result.message ?? "");
  return !NON_AMBIGUOUS_PENDING_MESSAGES.has(msg);
}

const SUCCESS_OUTCOMES = new Set([
  "RELEASED_AND_RECONCILED",
  "ALREADY_RELEASED_RECONCILED",
  "FEE_CAPTURED_AND_REMAINDER_RELEASED",
]);

/** Outcomes that resolve the hold — nothing to retry. Everything else is backed off. */
export function isSweepResolvedOutcome(outcome: string | null | undefined): boolean {
  return SUCCESS_OUTCOMES.has(String(outcome ?? ""));
}

export type SweepReconcileOnlyDecision =
  | { action: "dispose"; reason: "not_reconcile_only" | "provider_terminal" | "escalation_hatch" }
  | { action: "defer"; reason: "provider_open_reconcile_only" };

/** Provider states where nothing is left to capture/release — the disposer only reconciles locally. */
const SETTLED_PROVIDER_STATES = new Set([
  "COMPLETED",
  "CAPTURED",
  "CANCELLED",
  "CANCELED",
  "FAILED",
  "EXPIRED",
  "REFUNDED",
]);

/**
 * Pure decision after the read-only GET for a reconcile-only row.
 * `defer` means: no disposer call, therefore no capture POST this pass.
 */
export function decideSweepReconcileOnly(args: {
  captureAmbiguous: boolean;
  attempts: number;
  providerState: string | null;
}): SweepReconcileOnlyDecision {
  if (!args.captureAmbiguous) return { action: "dispose", reason: "not_reconcile_only" };
  const state = String(args.providerState ?? "").trim().toUpperCase();
  // Unknown / empty / still-open provider state never counts as settled.
  if (SETTLED_PROVIDER_STATES.has(state)) {
    return { action: "dispose", reason: "provider_terminal" };
  }
  if (args.attempts >= SWEEP_RECONCILE_ONLY_MAX_ATTEMPTS) {
    return { action: "dispose", reason: "escalation_hatch" };
  }
  return { action: "defer", reason: "provider_open_reconcile_only" };
}
