/**
 * Phase 0b — validated Payment Session transition facade.
 * All provider-state and lifecycle mutations route through mutatePaymentSession (core).
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  mutatePaymentSession,
  type PaymentSessionMutationSource,
} from "./paymentSessionMutationCore.ts";
import {
  markPaymentSessionCaptured,
  markPaymentSessionProviderFee,
  markPaymentSessionStatus,
  loadPaymentSession,
} from "./paymentSessionSSOT.ts";

export type PaymentSessionTransitionSource = PaymentSessionMutationSource;

const ALLOWED_PROVIDER_STATES = new Set([
  "AUTHORISED",
  "AUTHORIZED",
  "COMPLETED",
  "CAPTURED",
  "CANCELLED",
  "CANCELED",
  "REFUNDED",
  "FAILED",
  "PENDING",
  "PROCESSING",
]);

function normalizeProviderState(value: unknown): string | null {
  const s = String(value ?? "").trim().toUpperCase();
  return s || null;
}

/** Generic validated patch — initiators call this instead of direct payment_sessions.update. */
export async function transitionPaymentSession(
  supabase: SupabaseClient,
  args: {
    sessionId?: string | null;
    clientActionId?: string | null;
    providerOrderId?: string | null;
    patch: Record<string, unknown>;
    source: PaymentSessionTransitionSource;
    expectStatus?: string | null;
    expectFinancialOperationState?: string | null;
  },
): Promise<{ ok: boolean; error?: string }> {
  const patch = { ...args.patch };
  if (patch.provider_state != null) {
    const normalized = normalizeProviderState(patch.provider_state);
    if (normalized && !ALLOWED_PROVIDER_STATES.has(normalized)) {
      return { ok: false, error: `forbidden_provider_state:${normalized}` };
    }
    patch.provider_state = normalized;
    patch.provider_state_verified_at = patch.provider_state_verified_at
      ?? new Date().toISOString();
    patch.provider_state_verified_by = patch.provider_state_verified_by ?? args.source;
  }
  if (patch.metadata && typeof patch.metadata === "object") {
    patch.metadata = {
      ...(patch.metadata as Record<string, unknown>),
      transition_source: args.source,
    };
  }

  return mutatePaymentSession(
    supabase,
    {
      sessionId: args.sessionId,
      clientActionId: args.clientActionId,
      providerOrderId: args.providerOrderId,
      expectStatus: args.expectStatus,
      expectFinancialOperationState: args.expectFinancialOperationState,
    },
    patch,
    args.source,
  );
}

/** Provider-state patch with validation. */
export async function transitionPaymentSessionProviderState(
  supabase: SupabaseClient,
  args: {
    sessionId?: string | null;
    clientActionId?: string | null;
    providerOrderId?: string | null;
    providerState: string;
    source: PaymentSessionTransitionSource;
    extra?: Record<string, unknown>;
  },
): Promise<{ ok: boolean; error?: string }> {
  return transitionPaymentSession(supabase, {
    sessionId: args.sessionId,
    clientActionId: args.clientActionId,
    providerOrderId: args.providerOrderId,
    source: args.source,
    patch: {
      provider_state: args.providerState,
      ...(args.extra ?? {}),
    },
  });
}

/** Fee backfill on an already-captured session. */
export async function transitionPaymentSessionFeeBackfill(
  supabase: SupabaseClient,
  args: {
    clientActionId?: string | null;
    providerOrderId?: string | null;
    sessionId?: string | null;
    providerFeePence: number | null;
    retrieveSucceeded?: boolean;
    source?: PaymentSessionTransitionSource;
  },
): Promise<void> {
  await markPaymentSessionProviderFee(supabase, {
    clientActionId: args.clientActionId,
    providerOrderId: args.providerOrderId,
    sessionId: args.sessionId,
    providerFeePence: args.providerFeePence,
    retrieveSucceeded: args.retrieveSucceeded,
  });
}

export {
  markPaymentSessionCaptured,
  markPaymentSessionStatus,
  loadPaymentSession,
  mutatePaymentSession,
};
