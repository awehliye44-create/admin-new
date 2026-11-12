/**
 * Create-time / gate-time scheduled card capture-deadline coverage.
 * Payment authorisation → capture deadline verification → booking creation.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  evaluateCaptureDeadlineCoverage,
  isCardFundedPaymentMethod,
  type CaptureCoverageEvaluation,
  type PaymentSessionCaptureFields,
} from "./scheduledCaptureCoverageSSOT.ts";
import {
  extractCaptureDeadlineFromRevolutOrder,
  persistCaptureDeadlineFromOrder,
  persistCaptureDeadlineOnSession,
} from "./captureDeadlinePersistenceSSOT.ts";
import {
  retrieveRevolutOrder,
  type RevolutOrder,
} from "./revolutOrders.ts";
import type { ProviderEnvironment } from "./paymentProviders/types.ts";

export type CoverageEnsureResult =
  | { ok: true; evaluation: CaptureCoverageEvaluation; captureDeadlineIso: string }
  | {
      ok: false;
      definitive: boolean;
      evaluation: CaptureCoverageEvaluation;
      code: string;
      reason: string;
      customerMessage: string;
    };

const DEFAULT_RETRIEVE_ATTEMPTS = 3;
const RETRIEVE_BACKOFF_MS = [0, 250, 750];

export const CAPTURE_COVERAGE_CUSTOMER_MESSAGE =
  "We could not confirm card authorisation coverage for this scheduled pickup. No booking was created and any hold will be released.";

export const CAPTURE_COVERAGE_TEMPORARY_MESSAGE =
  "We could not verify card authorisation coverage right now. Please try again in a moment. No booking was created.";

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((r) => setTimeout(r, ms));
}

export async function retrieveCaptureDeadlineWithRetries(args: {
  environment: ProviderEnvironment;
  secretKey: string;
  orderId: string;
  attempts?: number;
}): Promise<
  | { ok: true; order: RevolutOrder; deadlineIso: string | null }
  | { ok: false; temporary: true; error: string }
> {
  const attempts = Math.max(1, args.attempts ?? DEFAULT_RETRIEVE_ATTEMPTS);
  let lastError = "retrieve_failed";
  for (let i = 0; i < attempts; i++) {
    await sleep(RETRIEVE_BACKOFF_MS[i] ?? 750);
    try {
      const order = await retrieveRevolutOrder(args.environment, args.secretKey, args.orderId);
      return {
        ok: true,
        order,
        deadlineIso: extractCaptureDeadlineFromRevolutOrder(order),
      };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  return { ok: false, temporary: true, error: lastError };
}

export async function ensureScheduledCaptureCoverage(input: {
  supabase: SupabaseClient;
  scheduledAtIso: string;
  estimatedDurationMinutes?: number | null;
  paymentMethod?: string | null;
  session: PaymentSessionCaptureFields & {
    id?: string | null;
    capture_deadline?: string | null;
  };
  expectedTripId?: string | null;
  /** When deadline missing — retrieve Revolut order. */
  revolut?: {
    environment: ProviderEnvironment;
    secretKey: string;
    orderId: string;
  } | null;
  /** Already-retrieved order (skip network if present). */
  knownOrder?: RevolutOrder | Record<string, unknown> | null;
}): Promise<CoverageEnsureResult> {
  if (!isCardFundedPaymentMethod(input.paymentMethod ?? "CARD")) {
    const passthrough = evaluateCaptureDeadlineCoverage({
      scheduledAtIso: input.scheduledAtIso,
      estimatedDurationMinutes: input.estimatedDurationMinutes,
      captureDeadlineIso: new Date(Date.now() + 365 * 24 * 3600_000).toISOString(),
      session: null,
      requireAuthorisedProviderState: false,
    });
    return {
      ok: true,
      evaluation: { ...passthrough, reason: "non_card_payment", code: "NON_CARD" },
      captureDeadlineIso: passthrough.captureDeadlineIso ?? "",
    };
  }

  let deadlineIso = input.session.capture_deadline ?? null;

  if (input.knownOrder) {
    const fromOrder = extractCaptureDeadlineFromRevolutOrder(input.knownOrder);
    if (fromOrder) {
      const persisted = await persistCaptureDeadlineFromOrder(input.supabase, {
        order: input.knownOrder,
        sessionId: input.session.id ?? null,
        providerOrderId: input.session.provider_order_id ?? null,
        source: "provider_retrieve",
      });
      deadlineIso = persisted.captureDeadlineIso ?? fromOrder;
    }
  }

  if (!deadlineIso && input.revolut?.orderId) {
    const retrieved = await retrieveCaptureDeadlineWithRetries({
      environment: input.revolut.environment,
      secretKey: input.revolut.secretKey,
      orderId: input.revolut.orderId,
    });
    if (!retrieved.ok) {
      const evaluation = evaluateCaptureDeadlineCoverage({
        scheduledAtIso: input.scheduledAtIso,
        estimatedDurationMinutes: input.estimatedDurationMinutes,
        captureDeadlineIso: null,
        session: input.session,
        expectedTripId: input.expectedTripId,
      });
      return {
        ok: false,
        definitive: false,
        evaluation,
        code: "CAPTURE_DEADLINE_RETRIEVE_TEMPORARY",
        reason: retrieved.error,
        customerMessage: CAPTURE_COVERAGE_TEMPORARY_MESSAGE,
      };
    }
    const persisted = await persistCaptureDeadlineFromOrder(input.supabase, {
      order: retrieved.order,
      sessionId: input.session.id ?? null,
      providerOrderId: input.revolut.orderId,
      source: "provider_retrieve",
    });
    deadlineIso = persisted.captureDeadlineIso ?? retrieved.deadlineIso;
  }

  if (deadlineIso && input.session.id) {
    await persistCaptureDeadlineOnSession(input.supabase, {
      sessionId: input.session.id,
      providerOrderId: input.session.provider_order_id ?? null,
      providerDeadlineRaw: deadlineIso,
      source: deadlineIso ? "provider_retrieve" : "unknown",
    });
  }

  const evaluation = evaluateCaptureDeadlineCoverage({
    scheduledAtIso: input.scheduledAtIso,
    estimatedDurationMinutes: input.estimatedDurationMinutes,
    captureDeadlineIso: deadlineIso,
    session: input.session,
    expectedTripId: input.expectedTripId,
  });

  if (evaluation.covered && evaluation.captureDeadlineIso) {
    return { ok: true, evaluation, captureDeadlineIso: evaluation.captureDeadlineIso };
  }

  if (!evaluation.definitive) {
    return {
      ok: false,
      definitive: false,
      evaluation,
      code: evaluation.code,
      reason: evaluation.reason,
      customerMessage: CAPTURE_COVERAGE_TEMPORARY_MESSAGE,
    };
  }

  return {
    ok: false,
    definitive: true,
    evaluation,
    code: evaluation.code,
    reason: evaluation.reason,
    customerMessage: CAPTURE_COVERAGE_CUSTOMER_MESSAGE,
  };
}
