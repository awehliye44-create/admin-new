/**
 * Scheduled card capture-deadline coverage SSOT.
 *
 * Required: Revolut capture_deadline >= expected journey completion + 6h safety margin.
 * Never invent a universal Revolut authorisation TTL — use provider deadline only.
 */

import {
  SCHEDULED_CAPTURE_COVERAGE_SAFETY_MARGIN_MINUTES,
  computeRequiredCaptureCoverageUntilMs,
} from "./scheduledAdvanceWindowSSOT.ts";

export { SCHEDULED_CAPTURE_COVERAGE_SAFETY_MARGIN_MINUTES, computeRequiredCaptureCoverageUntilMs };

export type CaptureDeadlineSource =
  | "provider_create"
  | "provider_retrieve"
  | "provider_webhook"
  | "provider_increment"
  | "backfill"
  | "unknown";

export type CaptureCoverageVerdict =
  | "covered"
  | "insufficient"
  | "deadline_missing"
  | "invalid_deadline"
  | "session_invalid";

export type CaptureCoverageEvaluation = {
  verdict: CaptureCoverageVerdict;
  covered: boolean;
  definitive: boolean;
  requiredUntilIso: string | null;
  captureDeadlineIso: string | null;
  reason: string;
  code: string;
};

export type PaymentSessionCaptureFields = {
  status?: string | null;
  provider_state?: string | null;
  released_at?: string | null;
  captured_at?: string | null;
  capture_deadline?: string | null;
  capture_deadline_at?: string | null;
  provider_order_id?: string | null;
  payment_intent_id?: string | null;
  trip_id?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type CaptureDeadlineMergeResult = {
  captureDeadlineIso: string | null;
  changed: boolean;
  source: CaptureDeadlineSource;
  /** Caller should retrieve Revolut order before deciding. */
  needsAuthoritativeRetrieve: boolean;
  observedAtIso: string | null;
  reason: string;
};

const TERMINAL_OR_INVALID_SESSION = new Set([
  "cancelled",
  "failed",
  "released",
  "payment_orphaned",
  "orphan_authorisation",
  "RECOVERY_CANCELLED",
  "RECOVERY_DECLINED",
  "RECOVERY_EXPIRED",
]);

export function parseCaptureDeadlineIso(
  raw: string | null | undefined,
): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function parseObservedAtMs(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const ms = Date.parse(String(raw).trim());
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Merge provider capture_deadline into persisted value.
 *
 * Rules:
 * - Never overwrite a valid persisted deadline with NULL when the provider omits the field.
 * - Prefer the freshest authoritative observation for the same order/session (observedAt).
 * - A confirmed shorter deadline from a fresher observation MUST take effect.
 * - Reject out-of-order / stale observations (older observedAt) even if their deadline is longer.
 * - If deadlines conflict and freshness cannot be established → needsAuthoritativeRetrieve.
 */
export function mergeCaptureDeadlinePersistence(input: {
  existingDeadlineIso: string | null | undefined;
  existingObservedAtIso?: string | null | undefined;
  providerDeadlineRaw: string | null | undefined;
  providerObservedAtIso?: string | null | undefined;
  source: CaptureDeadlineSource;
}): CaptureDeadlineMergeResult {
  const existing = parseCaptureDeadlineIso(input.existingDeadlineIso);
  const incoming = parseCaptureDeadlineIso(input.providerDeadlineRaw);
  const existingObservedMs = parseObservedAtMs(input.existingObservedAtIso);
  const incomingObservedMs = parseObservedAtMs(input.providerObservedAtIso);
  const incomingObservedIso =
    incomingObservedMs != null ? new Date(incomingObservedMs).toISOString() : null;

  if (!incoming) {
    return {
      captureDeadlineIso: existing,
      changed: false,
      source: existing ? input.source : input.source,
      needsAuthoritativeRetrieve: false,
      observedAtIso: input.existingObservedAtIso
        ? parseCaptureDeadlineIso(input.existingObservedAtIso) ??
          (existingObservedMs != null ? new Date(existingObservedMs).toISOString() : null)
        : null,
      reason: "provider_omitted_deadline_preserved_existing",
    };
  }

  if (existing === incoming) {
    return {
      captureDeadlineIso: existing,
      changed: false,
      source: input.source,
      needsAuthoritativeRetrieve: false,
      observedAtIso: incomingObservedIso ??
        (existingObservedMs != null ? new Date(existingObservedMs).toISOString() : null),
      reason: "unchanged",
    };
  }

  // Fresher observation wins — including legitimate deadline reductions.
  if (incomingObservedMs != null && existingObservedMs != null) {
    if (incomingObservedMs < existingObservedMs) {
      return {
        captureDeadlineIso: existing,
        changed: false,
        source: input.source,
        needsAuthoritativeRetrieve: false,
        observedAtIso: new Date(existingObservedMs).toISOString(),
        reason: "rejected_stale_observation",
      };
    }
    return {
      captureDeadlineIso: incoming,
      changed: true,
      source: input.source,
      needsAuthoritativeRetrieve: false,
      observedAtIso: incomingObservedIso,
      reason: incomingMsLess(existing, incoming)
        ? "authoritative_deadline_shortened"
        : "authoritative_deadline_extended_or_replaced",
    };
  }

  // Only incoming has freshness → apply (authoritative retrieve/webhook with clock).
  if (incomingObservedMs != null && existingObservedMs == null) {
    return {
      captureDeadlineIso: incoming,
      changed: true,
      source: input.source,
      needsAuthoritativeRetrieve: false,
      observedAtIso: incomingObservedIso,
      reason: incomingMsLess(existing, incoming)
        ? "authoritative_deadline_shortened"
        : "authoritative_deadline_applied",
    };
  }

  // Neither side has freshness and values conflict → do not guess max/min; retrieve.
  if (existing && existing !== incoming) {
    return {
      captureDeadlineIso: existing,
      changed: false,
      source: input.source,
      needsAuthoritativeRetrieve: true,
      observedAtIso: existingObservedMs != null
        ? new Date(existingObservedMs).toISOString()
        : null,
      reason: "conflicting_deadlines_freshness_unknown",
    };
  }

  return {
    captureDeadlineIso: incoming,
    changed: true,
    source: input.source,
    needsAuthoritativeRetrieve: false,
    observedAtIso: incomingObservedIso,
    reason: "initial_deadline_applied",
  };
}

function incomingMsLess(
  existing: string | null,
  incoming: string,
): boolean {
  if (!existing) return false;
  const a = Date.parse(existing);
  const b = Date.parse(incoming);
  return Number.isFinite(a) && Number.isFinite(b) && b < a;
}

export function isPaymentSessionAuthorisationUsable(
  session: PaymentSessionCaptureFields,
  expectedTripId?: string | null,
): { ok: true } | { ok: false; reason: string; code: string } {
  const status = String(session.status ?? "");
  if (TERMINAL_OR_INVALID_SESSION.has(status)) {
    return { ok: false, reason: `Payment session status is ${status}`, code: "SESSION_STATUS_INVALID" };
  }
  if (COALESCE_TRUE(session.metadata?.never_capture) || COALESCE_TRUE(session.metadata?.orphaned)) {
    return { ok: false, reason: "Payment session is orphaned/superseded", code: "SESSION_ORPHANED" };
  }
  if (session.released_at && !session.captured_at) {
    return { ok: false, reason: "Authorisation hold was released", code: "HOLD_RELEASED" };
  }
  if (
    expectedTripId &&
    session.trip_id &&
    String(session.trip_id) !== String(expectedTripId)
  ) {
    return {
      ok: false,
      reason: "Payment session is bound to a different trip",
      code: "SESSION_TRIP_MISMATCH",
    };
  }
  return { ok: true };
}

function COALESCE_TRUE(v: unknown): boolean {
  return v === true || v === "true" || v === 1 || v === "1";
}

/**
 * Evaluate whether capture_deadline covers required horizon.
 * definitive=false only when deadline is missing (caller may retrieve from Revolut).
 */
export function evaluateCaptureDeadlineCoverage(input: {
  scheduledAtIso: string;
  estimatedDurationMinutes?: number | null;
  captureDeadlineIso: string | null | undefined;
  safetyMarginMinutes?: number;
  session?: PaymentSessionCaptureFields | null;
  expectedTripId?: string | null;
  requireAuthorisedProviderState?: boolean;
}): CaptureCoverageEvaluation {
  if (input.session) {
    const usable = isPaymentSessionAuthorisationUsable(input.session, input.expectedTripId);
    if (!usable.ok) {
      return {
        verdict: "session_invalid",
        covered: false,
        definitive: true,
        requiredUntilIso: null,
        captureDeadlineIso: parseCaptureDeadlineIso(input.captureDeadlineIso),
        reason: usable.reason,
        code: usable.code,
      };
    }
    if (input.requireAuthorisedProviderState !== false) {
      const ps = String(input.session.provider_state ?? "").toUpperCase();
      if (ps && !["AUTHORISED", "AUTHORIZED", "COMPLETED"].includes(ps)) {
        return {
          verdict: "session_invalid",
          covered: false,
          definitive: true,
          requiredUntilIso: null,
          captureDeadlineIso: parseCaptureDeadlineIso(input.captureDeadlineIso),
          reason: `Provider state is ${input.session.provider_state}`,
          code: "PROVIDER_STATE_NOT_AUTHORISED",
        };
      }
    }
  }

  const requiredUntilMs = computeRequiredCaptureCoverageUntilMs({
    scheduledAtIso: input.scheduledAtIso,
    estimatedDurationMinutes: input.estimatedDurationMinutes,
    safetyMarginMinutes: input.safetyMarginMinutes,
  });
  if (requiredUntilMs == null) {
    return {
      verdict: "invalid_deadline",
      covered: false,
      definitive: true,
      requiredUntilIso: null,
      captureDeadlineIso: parseCaptureDeadlineIso(input.captureDeadlineIso),
      reason: "Pickup time is invalid",
      code: "INVALID_SCHEDULED_AT",
    };
  }

  const requiredUntilIso = new Date(requiredUntilMs).toISOString();
  const deadlineIso = parseCaptureDeadlineIso(input.captureDeadlineIso);
  if (!deadlineIso) {
    return {
      verdict: "deadline_missing",
      covered: false,
      definitive: false,
      requiredUntilIso,
      captureDeadlineIso: null,
      reason: "Capture deadline is missing from the payment authorisation",
      code: "CAPTURE_DEADLINE_MISSING",
    };
  }

  const deadlineMs = Date.parse(deadlineIso);
  if (!Number.isFinite(deadlineMs)) {
    return {
      verdict: "invalid_deadline",
      covered: false,
      definitive: true,
      requiredUntilIso,
      captureDeadlineIso: deadlineIso,
      reason: "Capture deadline is invalid",
      code: "CAPTURE_DEADLINE_INVALID",
    };
  }

  if (deadlineMs < requiredUntilMs) {
    return {
      verdict: "insufficient",
      covered: false,
      definitive: true,
      requiredUntilIso,
      captureDeadlineIso: deadlineIso,
      reason:
        "Card authorisation cannot be captured through the expected journey completion plus safety margin",
      code: "CAPTURE_DEADLINE_INSUFFICIENT",
    };
  }

  return {
    verdict: "covered",
    covered: true,
    definitive: true,
    requiredUntilIso,
    captureDeadlineIso: deadlineIso,
    reason: "Capture deadline covers required horizon",
    code: "CAPTURE_DEADLINE_OK",
  };
}

/** Card-like payment methods that require capture-deadline coverage for scheduled trips. */
export function isCardFundedPaymentMethod(method: string | null | undefined): boolean {
  const m = String(method ?? "").trim().toUpperCase();
  return m === "CARD" || m === "APPLE_PAY" || m === "GOOGLE_PAY" || m === "REVOLUT";
}
