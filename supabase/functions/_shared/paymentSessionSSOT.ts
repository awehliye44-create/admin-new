/**
 * Payment session SSOT — persisted booking attempt before checkout.
 * Webhook + create-trip-after-payment finalize through one session row.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  mutatePaymentSession,
} from "./paymentSessionMutationCore.ts";
import {
  fromDbPaymentSessionStatus,
  isAuthorisedHoldSessionStatus,
  isBlockedForTripCreateSessionStatus,
  toDbPaymentSessionStatus,
  type RevolutPaymentSessionStatus,
} from "../../../shared/revolutPaymentHoldSSOT.ts";
import {
  buildResidualReleaseIdempotencyKey,
  classifyPostCaptureResidualReleaseEvidence,
  hasResidualReleaseIdempotencyKey,
  shouldSkipResidualReleasePersist,
} from "../../../shared/paymentSessionReleaseEvidenceSSOT.ts";
import { extractConfirmedReleaseAmountPence } from "../../../shared/paymentHoldProviderTerminalPure.ts";
import {
  ADDITIONAL_AUTH_SOURCE,
  ADDITIONAL_AUTH_STATUS,
  buildAdditionalAuthIdempotencyKey,
  replacementTotalAuthorisedPence,
  type AdditionalAuthChildStatus,
} from "../../../shared/paymentSessionAdditionalAuthSSOT.ts";
import {
  classifyFeeStatus,
  sumRefundChildrenPence,
  FEE_STATUS,
} from "../../../shared/paymentSessionRefundFeeSSOT.ts";

export type PaymentSessionStatus =
  | RevolutPaymentSessionStatus
  | "pending_payment"
  | "payment_authorised"
  | "payment_orphaned"
  | "cancelled";

export const PAYMENT_ORPHANED_CUSTOMER_MESSAGE =
  "Payment received. We're recovering your booking.";

async function patchPaymentSession(
  supabase: SupabaseClient,
  filter: { clientActionId?: string | null; providerOrderId?: string | null; sessionId?: string | null },
  patch: Record<string, unknown>,
): Promise<void> {
  const { error } = await mutatePaymentSession(supabase, filter, patch, "ssot");
  if (error) {
    console.warn("[paymentSessionSSOT] patch failed", error, patch);
  }
}

export async function markPaymentSessionStatus(
  supabase: SupabaseClient,
  status: RevolutPaymentSessionStatus,
  filter: { clientActionId?: string | null; providerOrderId?: string | null; sessionId?: string | null },
  extra?: Record<string, unknown>,
): Promise<void> {
  await patchPaymentSession(supabase, filter, {
    status: toDbPaymentSessionStatus(status),
    ...extra,
  });
}

export type UpsertPaymentSessionInput = {
  clientActionId: string;
  userId: string;
  customerId?: string | null;
  serviceAreaId: string;
  paymentProvider?: string;
  providerOrderId?: string | null;
  /** Required NOT NULL on payment_sessions — defaults to preauth_<clientActionId>. */
  idempotencyKey?: string | null;
  authorisedAmountPence?: number | null;
  estimatedTotalPence?: number | null;
  bufferPence?: number | null;
  fareSnapshot?: Record<string, unknown>;
  bookingSnapshot?: Record<string, unknown>;
  platformPaymentMethodId?: string | null;
  paymentMethod?: string | null;
  metadata?: Record<string, unknown>;
};

export async function upsertPaymentSessionPending(
  supabase: SupabaseClient,
  input: UpsertPaymentSessionInput,
): Promise<{ sessionId: string | null; error?: string }> {
  // Production-proven format (MK-260813-003 / Customer SSOT): preauth_${clientActionId}
  const idempotencyKey =
    String(input.idempotencyKey ?? "").trim() ||
    `preauth_${input.clientActionId}`;
  const row = {
    client_action_id: input.clientActionId,
    user_id: input.userId,
    customer_id: input.customerId ?? null,
    service_area_id: input.serviceAreaId,
    payment_provider: input.paymentProvider ?? "revolut",
    provider_order_id: input.providerOrderId ?? null,
    idempotency_key: idempotencyKey,
    status: toDbPaymentSessionStatus("created"),
    authorised_amount_pence: input.authorisedAmountPence ?? null,
    estimated_total_pence: input.estimatedTotalPence ?? null,
    buffer_pence: input.bufferPence ?? null,
    fare_snapshot: input.fareSnapshot ?? {},
    booking_snapshot: input.bookingSnapshot ?? {},
    platform_payment_method_id: input.platformPaymentMethodId ?? null,
    payment_method: input.paymentMethod ?? null,
    metadata: input.metadata ?? {},
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from("payment_sessions")
    .upsert(row, { onConflict: "client_action_id" })
    .select("id")
    .maybeSingle();

  if (error) {
    console.warn("[paymentSessionSSOT] upsert pending failed", error.message);
    return { sessionId: null, error: error.message };
  }
  return { sessionId: (data?.id as string | undefined) ?? null };
}

export async function markPaymentSessionAuthorised(
  supabase: SupabaseClient,
  args: {
    providerOrderId: string;
    clientActionId?: string | null;
    providerPaymentId?: string | null;
    authorisedAt?: string;
  },
): Promise<void> {
  const now = args.authorisedAt ?? new Date().toISOString();
  const patch: Record<string, unknown> = {
    status: toDbPaymentSessionStatus("authorised_hold"),
    provider_order_id: args.providerOrderId,
    authorised_at: now,
    // Stamp provider_state so create-trip can trust the session without a
    // second Revolut retrieve when create-preauth just authorised the hold.
    provider_state: "AUTHORISED",
    provider_state_verified_at: now,
    provider_state_verified_by: "markPaymentSessionAuthorised",
    // Clear stale incompatible terminal reasons (e.g. REVOLUT_CANCELLED) after usable auth.
    failure_reason: null,
  };
  if (args.providerPaymentId) patch.provider_payment_id = args.providerPaymentId;

  await patchPaymentSession(supabase, {
    clientActionId: args.clientActionId,
    providerOrderId: args.providerOrderId,
  }, patch);

  const { emitHoldTelemetry } = await import("./holdTelemetrySSOT.ts");
  await emitHoldTelemetry(supabase, "HOLD_AUTHORISED", {
    providerOrderId: args.providerOrderId,
    clientActionId: args.clientActionId ?? null,
    source: "markPaymentSessionAuthorised",
  });
}

export async function markPaymentSessionAuthorising(
  supabase: SupabaseClient,
  args: { clientActionId?: string | null; providerOrderId?: string | null },
): Promise<void> {
  await markPaymentSessionStatus(supabase, "authorising", args);
}

/** Customer opened Revolut checkout — not a payment confirmation. */
export async function markPaymentSessionCheckoutOpen(
  supabase: SupabaseClient,
  args: { clientActionId?: string | null; providerOrderId?: string | null },
): Promise<void> {
  await markPaymentSessionStatus(supabase, "checkout_open", args);
}

export async function markPaymentSessionFailed(
  supabase: SupabaseClient,
  args: {
    clientActionId?: string | null;
    providerOrderId?: string | null;
    failureReason: string;
  },
): Promise<void> {
  await markPaymentSessionStatus(supabase, "failed", args, {
    failure_reason: args.failureReason,
  });
}

export async function markPaymentSessionAbandoned(
  supabase: SupabaseClient,
  args: {
    clientActionId?: string | null;
    providerOrderId?: string | null;
    reason: string;
  },
): Promise<void> {
  await markPaymentSessionStatus(supabase, "abandoned", args, {
    failure_reason: args.reason,
  });
}

export async function markPaymentSessionReleased(
  supabase: SupabaseClient,
  args: {
    clientActionId?: string | null;
    providerOrderId?: string | null;
    tripId?: string | null;
    reason?: string;
    holdTerminalReason?: string;
    providerReleaseReference?: string | null;
    idempotencyKey?: string;
    releasedAt?: string;
    /** Provider-confirmed only — never pass auth−capture arithmetic. */
    releasedAmountPence?: number | null;
    releaseEvidenceStatus?: string | null;
    releaseEvidenceSource?: string | null;
  },
): Promise<void> {
  const now = args.releasedAt ?? new Date().toISOString();
  const session = await loadPaymentSession(supabase, {
    clientActionId: args.clientActionId,
    providerOrderId: args.providerOrderId,
  });
  const metadata = session?.metadata && typeof session.metadata === "object"
    ? { ...(session.metadata as Record<string, unknown>) }
    : {};
  if (args.idempotencyKey) {
    const keys = Array.isArray(metadata.hold_release_idempotency_keys)
      ? (metadata.hold_release_idempotency_keys as string[])
      : [];
    if (!keys.includes(args.idempotencyKey)) {
      metadata.hold_release_idempotency_keys = [...keys, args.idempotencyKey];
    }
  }

  const patch: Record<string, unknown> = {
    failure_reason: args.reason ?? null,
    trip_id: args.tripId ?? undefined,
    released_at: now,
    hold_terminal_reason: args.holdTerminalReason ?? args.reason ?? null,
    provider_release_reference: args.providerReleaseReference ?? args.providerOrderId ?? null,
    release_failure_reason: null,
    hold_release_state: "released",
    metadata,
  };
  if (
    args.releasedAmountPence != null
    && Number.isFinite(Number(args.releasedAmountPence))
    && Number(args.releasedAmountPence) > 0
  ) {
    patch.released_amount_pence = Math.round(Number(args.releasedAmountPence));
  }
  if (args.releaseEvidenceStatus) {
    patch.release_evidence_status = args.releaseEvidenceStatus;
    patch.release_evidence_source = args.releaseEvidenceSource ?? null;
    patch.release_verified_at = now;
  }

  // prevent_authorised_session_client_cancel uses OLD.provider_state.
  // Flip AUTHORISED/COMPLETED first, then set status cancelled.
  const sessionId = session?.id ? String(session.id) : null;
  const oldState = String(session?.provider_state ?? "").toUpperCase();
  if (sessionId && (oldState === "AUTHORISED" || oldState === "AUTHORIZED" || oldState === "COMPLETED")) {
    await mutatePaymentSession(
      supabase,
      { sessionId },
      {
        provider_state: oldState === "COMPLETED" ? "REFUNDED" : "CANCELLED",
        provider_state_verified_at: now,
        provider_state_verified_by: "markPaymentSessionReleased",
      },
      "ssot",
    );
  }

  await markPaymentSessionStatus(supabase, "released", {
    sessionId,
    clientActionId: args.clientActionId,
    providerOrderId: args.providerOrderId,
  }, patch);
}

/**
 * Persist residual release evidence after partial capture.
 * Keeps payment_sessions.status = captured (does not flip to released/cancelled).
 * Never invents released_amount_pence from authorised − captured.
 */
export async function markPaymentSessionCaptureResidualRelease(
  supabase: SupabaseClient,
  args: {
    clientActionId?: string | null;
    providerOrderId?: string | null;
    sessionId?: string | null;
    tripId?: string | null;
    authorisedHoldPence: number;
    capturedAmountPence: number;
    providerPayload: Record<string, unknown> | null;
    retrieveSucceeded: boolean;
    evidenceSource: string;
    confirmedReleaseAmountPence?: number | null;
    providerReleaseReference?: string | null;
    verifiedAt?: string;
  },
): Promise<{
  applied: boolean;
  skipped: boolean;
  classification: ReturnType<typeof classifyPostCaptureResidualReleaseEvidence>;
}> {
  const explicit =
    args.confirmedReleaseAmountPence ??
    extractConfirmedReleaseAmountPence(args.providerPayload);

  const classification = classifyPostCaptureResidualReleaseEvidence({
    authorisedHoldPence: args.authorisedHoldPence,
    capturedAmountPence: args.capturedAmountPence,
    providerPayload: args.providerPayload,
    retrieveSucceeded: args.retrieveSucceeded,
    confirmedReleaseAmountPence: explicit,
  });

  const session = await loadPaymentSession(supabase, {
    clientActionId: args.clientActionId,
    providerOrderId: args.providerOrderId,
    sessionId: args.sessionId,
  });

  const existingMeta = session?.metadata && typeof session.metadata === "object"
    ? { ...(session.metadata as Record<string, unknown>) }
    : {};
  const idempotencyKey = buildResidualReleaseIdempotencyKey({
    providerOrderId: String(args.providerOrderId ?? session?.provider_order_id ?? "unknown"),
    capturedAmountPence: args.capturedAmountPence,
    releaseEvidenceStatus: classification.release_evidence_status,
  });

  if (
    shouldSkipResidualReleasePersist({
      existingEvidenceStatus: session?.release_evidence_status != null
        ? String(session.release_evidence_status)
        : null,
      existingReleasedAmountPence: session?.released_amount_pence != null
        ? Number(session.released_amount_pence)
        : null,
      nextEvidenceStatus: classification.release_evidence_status,
      nextReleasedAmountPence: classification.released_amount_pence,
      idempotencyAlreadyApplied: hasResidualReleaseIdempotencyKey(existingMeta, idempotencyKey),
    })
  ) {
    return { applied: false, skipped: true, classification };
  }

  const now = args.verifiedAt ?? new Date().toISOString();
  const metadata = { ...existingMeta };
  const keys = Array.isArray(metadata.residual_release_idempotency_keys)
    ? (metadata.residual_release_idempotency_keys as string[])
    : [];
  if (!keys.includes(idempotencyKey)) {
    metadata.residual_release_idempotency_keys = [...keys, idempotencyKey];
  }
  metadata.expected_release_pence = classification.expected_release_pence;
  metadata.release_evidence_reason = classification.reason;
  metadata.release_evidence_provider_state = classification.provider_state;
  if (args.providerPayload) {
    metadata.release_evidence_snapshot = {
      state: args.providerPayload.state ?? null,
      amount: args.providerPayload.amount ?? null,
      outstanding_amount: args.providerPayload.outstanding_amount ?? null,
      cancelled_amount: args.providerPayload.cancelled_amount
        ?? args.providerPayload.canceled_amount
        ?? null,
      verified_at: now,
      source: args.evidenceSource,
    };
  }

  const patch: Record<string, unknown> = {
    release_evidence_status: classification.release_evidence_status,
    release_evidence_source: args.evidenceSource,
    release_verified_at: now,
    metadata,
    updated_at: now,
  };

  if (classification.hold_release_state) {
    patch.hold_release_state = classification.hold_release_state;
  }
  if (classification.set_released_at) {
    patch.released_at = session?.released_at ?? now;
    patch.provider_release_reference =
      args.providerReleaseReference
      ?? args.providerOrderId
      ?? session?.provider_order_id
      ?? null;
    if (classification.release_evidence_status !== "FAILED") {
      patch.release_failure_reason = null;
    }
  }
  // Only write amount when provider-confirmed (CONFIRMED).
  if (classification.released_amount_pence != null) {
    patch.released_amount_pence = classification.released_amount_pence;
  }
  if (classification.provider_state) {
    patch.provider_state = classification.provider_state;
    patch.provider_state_verified_at = now;
    patch.provider_state_verified_by = args.evidenceSource;
  }
  if (args.tripId) {
    patch.trip_id = args.tripId;
  }

  // Keep status captured — do not call markPaymentSessionStatus("released").
  await patchPaymentSession(supabase, {
    clientActionId: args.clientActionId,
    providerOrderId: args.providerOrderId,
    sessionId: args.sessionId ?? (session?.id != null ? String(session.id) : null),
  }, patch);

  return { applied: true, skipped: false, classification };
}

export async function markPaymentSessionCaptured(
  supabase: SupabaseClient,
  args: {
    clientActionId?: string | null;
    providerOrderId?: string | null;
    tripId: string;
    captureAmountPence: number;
    capturedAt?: string;
    providerCaptureId?: string | null;
    /** Provider-confirmed total authorised after rehold/replacement. */
    totalAuthorisedAmountPence?: number | null;
    authorisedAmountPence?: number | null;
  },
): Promise<void> {
  const session = await loadPaymentSession(supabase, {
    clientActionId: args.clientActionId,
    providerOrderId: args.providerOrderId,
  });
  const metadata = session?.metadata && typeof session.metadata === "object"
    ? { ...(session.metadata as Record<string, unknown>) }
    : {};
  metadata.capture_amount_pence = args.captureAmountPence;

  const now = args.capturedAt ?? new Date().toISOString();
  const patch: Record<string, unknown> = {
    trip_id: args.tripId,
    captured_at: now,
    captured_amount_pence: args.captureAmountPence,
    hold_terminal_reason: "provider_captured",
    release_failure_reason: null,
    provider_state: "COMPLETED",
    provider_state_verified_at: now,
    provider_state_verified_by: "markPaymentSessionCaptured",
    metadata,
  };
  if (args.providerOrderId) {
    patch.provider_order_id = args.providerOrderId;
  }
  if (
    args.totalAuthorisedAmountPence != null
    && Number.isFinite(Number(args.totalAuthorisedAmountPence))
    && Number(args.totalAuthorisedAmountPence) > 0
  ) {
    const total = Math.round(Number(args.totalAuthorisedAmountPence));
    patch.total_authorised_amount_pence = total;
    patch.authorised_amount_pence = args.authorisedAmountPence != null
      ? Math.round(Number(args.authorisedAmountPence))
      : total;
  } else if (
    args.authorisedAmountPence != null
    && Number.isFinite(Number(args.authorisedAmountPence))
    && Number(args.authorisedAmountPence) > 0
  ) {
    patch.authorised_amount_pence = Math.round(Number(args.authorisedAmountPence));
  }
  if (session?.hold_release_state == null) {
    patch.hold_release_state = null;
  }
  if (args.providerCaptureId) {
    patch.provider_capture_id = args.providerCaptureId;
  }
  await markPaymentSessionStatus(supabase, "captured", args, patch);
}

export async function markPaymentSessionPaymentShortfall(
  supabase: SupabaseClient,
  args: {
    clientActionId?: string | null;
    providerOrderId?: string | null;
    tripId: string;
    shortfallPence: number;
    reason: string;
    /** Slice 2: prefer PAYMENT_RECOVERY_REQUIRED for failed additional collection. */
    asPaymentRecovery?: boolean;
  },
): Promise<void> {
  const session = await loadPaymentSession(supabase, {
    clientActionId: args.clientActionId,
    providerOrderId: args.providerOrderId,
  });
  const metadata = session?.metadata && typeof session.metadata === "object"
    ? { ...(session.metadata as Record<string, unknown>) }
    : {};
  metadata.shortfall_pence = args.shortfallPence;
  if (args.asPaymentRecovery) {
    metadata.additional_auth_status = ADDITIONAL_AUTH_STATUS.PAYMENT_RECOVERY_REQUIRED;
  }

  const status: RevolutPaymentSessionStatus = args.asPaymentRecovery
    ? "PAYMENT_RECOVERY_REQUIRED"
    : "payment_shortfall";

  await markPaymentSessionStatus(supabase, status, args, {
    trip_id: args.tripId,
    failure_reason: args.reason,
    metadata,
  });
}

/**
 * Idempotent upsert of a payment_session_authorisations child row.
 * Amounts must be provider-confirmed — never invent from fare arithmetic.
 */
export async function upsertPaymentSessionAuthorisation(
  supabase: SupabaseClient,
  args: {
    paymentSessionId: string;
    paymentProvider?: string;
    providerOrderId: string;
    providerAuthorisationId?: string | null;
    authorisedAmountPence: number;
    cumulativeTotalAuthorisedPence: number;
    providerState?: string | null;
    status: AdditionalAuthChildStatus;
    source: string;
    idempotencyKey: string;
    capturedAmountPence?: number | null;
    releasedAmountPence?: number | null;
    authorisedAt?: string;
    capturedAt?: string | null;
    releasedAt?: string | null;
    verifiedAt?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
  const amount = Math.round(Number(args.authorisedAmountPence));
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "authorised_amount_invalid" };
  }
  const cumulative = Math.max(0, Math.round(Number(args.cumulativeTotalAuthorisedPence)));
  const now = new Date().toISOString();
  const provider = args.paymentProvider ?? "revolut";
  const authId = args.providerAuthorisationId ?? args.providerOrderId;

  const { data: existingByKey } = await supabase
    .from("payment_session_authorisations")
    .select("id")
    .eq("idempotency_key", args.idempotencyKey)
    .maybeSingle();
  if (existingByKey?.id) {
    return { ok: true, skipped: true };
  }

  const row = {
    payment_session_id: args.paymentSessionId,
    payment_provider: provider,
    provider_order_id: args.providerOrderId,
    provider_authorisation_id: authId,
    provider_payment_id: null as string | null,
    authorised_amount_pence: amount,
    cumulative_total_authorised_pence: cumulative,
    captured_amount_pence: args.capturedAmountPence != null
      ? Math.round(Number(args.capturedAmountPence))
      : null,
    released_amount_pence: args.releasedAmountPence != null
      ? Math.round(Number(args.releasedAmountPence))
      : null,
    status: args.status,
    provider_state: args.providerState ?? null,
    authorised_at: args.authorisedAt ?? now,
    captured_at: args.capturedAt ?? null,
    released_at: args.releasedAt ?? null,
    verified_at: args.verifiedAt ?? now,
    idempotency_key: args.idempotencyKey,
    source: args.source,
    metadata: args.metadata ?? {},
  };

  const { error } = await supabase
    .from("payment_session_authorisations")
    .upsert(row, { onConflict: "payment_provider,provider_order_id" });

  if (error) {
    console.warn("[paymentSessionSSOT] authorisation upsert failed", error.message);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

/**
 * Persist replacement-hold additional authorisation trail and parent totals.
 * Does not credit wallet. Caller must capture before settlement.
 */
export async function markPaymentSessionAdditionalAuthorisationLifecycle(
  supabase: SupabaseClient,
  args: {
    clientActionId?: string | null;
    sessionId?: string | null;
    tripId: string;
    phase:
      | "REQUIRED"
      | "PENDING"
      | "CONFIRMED"
      | "CAPTURED"
      | "FAILED";
    previousProviderOrderId: string;
    previousAuthorisedPence: number;
    newProviderOrderId?: string | null;
    newProviderAuthorisedPence?: number | null;
    newProviderState?: string | null;
    captureAmountPence?: number | null;
    reason?: string | null;
    shortfallPence?: number | null;
  },
): Promise<{ sessionId: string | null }> {
  const session = await loadPaymentSession(supabase, {
    clientActionId: args.clientActionId,
    providerOrderId: args.previousProviderOrderId,
    sessionId: args.sessionId,
  });
  const sessionId = session?.id != null
    ? String(session.id)
    : (args.sessionId ?? null);
  if (!sessionId) return { sessionId: null };

  const metadata = session?.metadata && typeof session.metadata === "object"
    ? { ...(session.metadata as Record<string, unknown>) }
    : {};
  metadata.additional_auth_phase = args.phase;
  if (args.reason) metadata.additional_auth_reason = args.reason;

  if (args.phase === "REQUIRED") {
    await markPaymentSessionStatus(supabase, "ADDITIONAL_AUTHORISATION_REQUIRED", {
      sessionId,
      clientActionId: args.clientActionId,
    }, {
      trip_id: args.tripId,
      metadata,
    });
    return { sessionId };
  }

  if (args.phase === "PENDING") {
    await markPaymentSessionStatus(supabase, "ADDITIONAL_AUTHORISATION_PENDING", {
      sessionId,
      clientActionId: args.clientActionId,
    }, {
      trip_id: args.tripId,
      metadata,
    });
    return { sessionId };
  }

  if (args.phase === "FAILED") {
    const shortfall = args.shortfallPence != null
      ? Math.max(0, Math.round(Number(args.shortfallPence)))
      : 0;
    await markPaymentSessionPaymentShortfall(supabase, {
      clientActionId: args.clientActionId,
      providerOrderId: args.previousProviderOrderId,
      tripId: args.tripId,
      shortfallPence: shortfall,
      reason: args.reason ?? "additional_authorisation_failed",
      asPaymentRecovery: true,
    });
    if (args.previousAuthorisedPence > 0) {
      await upsertPaymentSessionAuthorisation(supabase, {
        paymentSessionId: sessionId,
        providerOrderId: args.previousProviderOrderId,
        authorisedAmountPence: Math.round(Number(args.previousAuthorisedPence)),
        cumulativeTotalAuthorisedPence: Math.round(Number(args.previousAuthorisedPence)),
        status: "failed",
        source: ADDITIONAL_AUTH_SOURCE.TRIP_COMPLETION_REHOLD,
        idempotencyKey: buildAdditionalAuthIdempotencyKey({
          paymentSessionId: sessionId,
          providerOrderId: args.previousProviderOrderId,
          phase: "failed",
        }),
        providerState: "FAILED",
        metadata: { reason: args.reason ?? null },
      });
    }
    return { sessionId };
  }

  const newOrderId = String(args.newProviderOrderId ?? "").trim();
  const newAuth = Math.round(Number(args.newProviderAuthorisedPence ?? 0));
  if (!newOrderId || newAuth <= 0) {
    return { sessionId };
  }

  const totalAuthorised = replacementTotalAuthorisedPence({
    newProviderAuthorisedPence: newAuth,
  });
  const now = new Date().toISOString();

  // Supersede previous hold (replacement semantics — amount is prior provider hold).
  if (args.previousAuthorisedPence > 0) {
    await upsertPaymentSessionAuthorisation(supabase, {
      paymentSessionId: sessionId,
      providerOrderId: args.previousProviderOrderId,
      authorisedAmountPence: Math.round(Number(args.previousAuthorisedPence)),
      cumulativeTotalAuthorisedPence: Math.round(Number(args.previousAuthorisedPence)),
      status: "superseded",
      source: ADDITIONAL_AUTH_SOURCE.TRIP_COMPLETION_REHOLD,
      idempotencyKey: buildAdditionalAuthIdempotencyKey({
        paymentSessionId: sessionId,
        providerOrderId: args.previousProviderOrderId,
        phase: "superseded",
      }),
      providerState: "CANCELLED",
      releasedAt: now,
      metadata: { replacement_order_id: newOrderId },
    });
  }

  if (args.phase === "CONFIRMED") {
    await upsertPaymentSessionAuthorisation(supabase, {
      paymentSessionId: sessionId,
      providerOrderId: newOrderId,
      authorisedAmountPence: newAuth,
      cumulativeTotalAuthorisedPence: totalAuthorised,
      status: "authorised",
      source: ADDITIONAL_AUTH_SOURCE.TRIP_COMPLETION_REHOLD,
      idempotencyKey: buildAdditionalAuthIdempotencyKey({
        paymentSessionId: sessionId,
        providerOrderId: newOrderId,
        phase: "authorised",
      }),
      providerState: args.newProviderState ?? "AUTHORISED",
      metadata: { previous_order_id: args.previousProviderOrderId },
    });
    await markPaymentSessionStatus(supabase, "ADDITIONAL_AUTHORISATION_CONFIRMED", {
      sessionId,
      clientActionId: args.clientActionId,
    }, {
      trip_id: args.tripId,
      provider_order_id: newOrderId,
      authorised_amount_pence: newAuth,
      total_authorised_amount_pence: totalAuthorised,
      metadata,
    });
    return { sessionId };
  }

  // CAPTURED phase
  const captureAmt = args.captureAmountPence != null
    ? Math.round(Number(args.captureAmountPence))
    : null;
  await upsertPaymentSessionAuthorisation(supabase, {
    paymentSessionId: sessionId,
    providerOrderId: newOrderId,
    authorisedAmountPence: newAuth,
    cumulativeTotalAuthorisedPence: totalAuthorised,
    status: "captured",
    source: ADDITIONAL_AUTH_SOURCE.TRIP_COMPLETION_REHOLD,
    idempotencyKey: buildAdditionalAuthIdempotencyKey({
      paymentSessionId: sessionId,
      providerOrderId: newOrderId,
      phase: "captured",
    }),
    providerState: args.newProviderState ?? "COMPLETED",
    capturedAmountPence: captureAmt,
    capturedAt: now,
    metadata: { previous_order_id: args.previousProviderOrderId },
  });

  return { sessionId };
}

export async function markPaymentSessionDispatching(
  supabase: SupabaseClient,
  args: { clientActionId: string; tripId: string },
): Promise<void> {
  await markPaymentSessionStatus(supabase, "dispatching", { clientActionId: args.clientActionId }, {
    trip_id: args.tripId,
  });
}

/**
 * Idempotent payment_session_refunds child upsert + recompute parent refunded_amount_pence.
 * provider_refund_id must be the real provider refund id (never webhook event id).
 */
export async function upsertPaymentSessionRefund(
  supabase: SupabaseClient,
  args: {
    paymentSessionId?: string | null;
    clientActionId?: string | null;
    providerOrderId?: string | null;
    paymentProvider?: string;
    providerRefundId: string;
    amountPence: number;
    currency?: string;
    providerPaymentId?: string | null;
    webhookEventId?: string | null;
    confirmedAt?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<{ ok: boolean; skipped?: boolean; refunded_amount_pence: number | null; error?: string }> {
  const providerRefundId = String(args.providerRefundId ?? "").trim();
  const amount = Math.round(Number(args.amountPence));
  if (!providerRefundId) {
    return { ok: false, refunded_amount_pence: null, error: "provider_refund_id_required" };
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, refunded_amount_pence: null, error: "amount_invalid" };
  }

  const session = await loadPaymentSession(supabase, {
    sessionId: args.paymentSessionId,
    clientActionId: args.clientActionId,
    providerOrderId: args.providerOrderId,
  });
  const sessionId = session?.id != null
    ? String(session.id)
    : (args.paymentSessionId ?? null);
  if (!sessionId) {
    return { ok: false, refunded_amount_pence: null, error: "payment_session_missing" };
  }

  const provider = args.paymentProvider ?? String(session?.payment_provider ?? "revolut");
  const now = args.confirmedAt ?? new Date().toISOString();

  const { data: existing } = await supabase
    .from("payment_session_refunds")
    .select("id")
    .eq("payment_provider", provider)
    .eq("provider_refund_id", providerRefundId)
    .maybeSingle();

  if (!existing?.id) {
    const { error } = await supabase.from("payment_session_refunds").insert({
      payment_session_id: sessionId,
      payment_provider: provider,
      provider_refund_id: providerRefundId,
      provider_payment_id: args.providerPaymentId ?? args.providerOrderId ?? null,
      amount_pence: amount,
      currency: (args.currency ?? "gbp").toLowerCase(),
      status: "confirmed",
      confirmed_at: now,
      webhook_event_id: args.webhookEventId ?? null,
      metadata: args.metadata ?? {},
    });
    if (error) {
      // Unique race — treat as idempotent skip then recompute.
      if (!String(error.message ?? "").toLowerCase().includes("duplicate")) {
        console.warn("[paymentSessionSSOT] refund insert failed", error.message);
        return { ok: false, refunded_amount_pence: null, error: error.message };
      }
    }
  }

  const recomputed = await recomputePaymentSessionRefundedAmount(supabase, sessionId);
  return {
    ok: true,
    skipped: Boolean(existing?.id),
    refunded_amount_pence: recomputed,
  };
}

export async function recomputePaymentSessionRefundedAmount(
  supabase: SupabaseClient,
  paymentSessionId: string,
): Promise<number | null> {
  const { data: rows } = await supabase
    .from("payment_session_refunds")
    .select("amount_pence, status, confirmed_at, provider_refund_id")
    .eq("payment_session_id", paymentSessionId)
    .order("confirmed_at", { ascending: true });

  const total = sumRefundChildrenPence(rows ?? []);
  const firstAt = (rows ?? []).find((r) => Number(r.amount_pence) > 0)?.confirmed_at ?? null;
  const latestRefundId = [...(rows ?? [])].reverse().find((r) => Number(r.amount_pence) > 0)
    ?.provider_refund_id ?? null;

  await patchPaymentSession(supabase, { sessionId: paymentSessionId }, {
    refunded_amount_pence: total,
    refunded_at: total != null ? (firstAt ?? new Date().toISOString()) : null,
    provider_refund_id: latestRefundId,
  });

  return total;
}

/** Persist provider-confirmed fee only — never invent £0. Never downgrade ACTUAL. */
export async function markPaymentSessionProviderFee(
  supabase: SupabaseClient,
  args: {
    clientActionId?: string | null;
    providerOrderId?: string | null;
    sessionId?: string | null;
    providerFeePence: number | null;
    retrieveSucceeded?: boolean;
  },
): Promise<void> {
  const session = await loadPaymentSession(supabase, {
    clientActionId: args.clientActionId,
    providerOrderId: args.providerOrderId,
    sessionId: args.sessionId,
  });
  const existingStatus = String(session?.fee_status ?? "").toUpperCase();
  const existingFee = session?.provider_processing_fee_pence != null
    ? Number(session.provider_processing_fee_pence)
    : null;
  if (
    existingStatus === FEE_STATUS.ACTUAL
    && existingFee != null
    && Number.isFinite(existingFee)
    && existingFee > 0
  ) {
    // Do not overwrite confirmed ACTUAL with PENDING/UNAVAILABLE from a sparse retrieve.
    if (args.providerFeePence == null || !Number.isFinite(Number(args.providerFeePence))) {
      return;
    }
  }

  const classified = classifyFeeStatus({
    providerFeePence: args.providerFeePence,
    retrieveSucceeded: args.retrieveSucceeded,
  });
  await patchPaymentSession(supabase, {
    clientActionId: args.clientActionId,
    providerOrderId: args.providerOrderId,
    sessionId: args.sessionId,
  }, {
    provider_processing_fee_pence: classified.provider_processing_fee_pence,
    fee_status: classified.fee_status,
  });
}

export async function markPaymentSessionCompletedPendingCapture(
  supabase: SupabaseClient,
  args: { clientActionId?: string | null; providerOrderId?: string | null; tripId: string },
): Promise<void> {
  await markPaymentSessionStatus(supabase, "completed_pending_capture", args, {
    trip_id: args.tripId,
  });
}

export async function assertPaymentSessionAuthorisedForTripCreate(
  supabase: SupabaseClient,
  clientActionId: string,
): Promise<{ ok: true; sessionId: string | null } | { ok: false; reason: string }> {
  const session = await loadPaymentSession(supabase, { clientActionId });
  return gatePaymentSessionForTripCreate(session);
}

/** Use a session already loaded on the hot path — avoids duplicate DB round-trips. */
export function gatePaymentSessionForTripCreate(
  session: Record<string, unknown> | null,
): { ok: true; sessionId: string | null; recoveryRetry?: boolean } | { ok: false; reason: string } {
  if (!session) {
    return { ok: false, reason: "payment_session_missing" };
  }
  const status = String(session.status ?? "");
  const canonical = fromDbPaymentSessionStatus(status);
  if (isBlockedForTripCreateSessionStatus(status)) {
    return { ok: false, reason: `payment_session_not_authorised:${canonical}` };
  }
  if (
    canonical === "orphan_authorisation"
    && !session.trip_id
  ) {
    return {
      ok: true,
      sessionId: (session.id as string | undefined) ?? null,
      recoveryRetry: true,
    };
  }
  if (!isAuthorisedHoldSessionStatus(status) && canonical !== "trip_created") {
    return { ok: false, reason: `payment_session_not_authorised:${status}` };
  }
  return { ok: true, sessionId: (session.id as string | undefined) ?? null };
}

export async function markPaymentSessionTripCreated(
  supabase: SupabaseClient,
  args: {
    clientActionId: string;
    tripId: string;
    providerOrderId?: string | null;
  },
): Promise<void> {
  await patchPaymentSession(supabase, { clientActionId: args.clientActionId }, {
    status: toDbPaymentSessionStatus("trip_created"),
    trip_id: args.tripId,
    provider_order_id: args.providerOrderId ?? undefined,
    // Usable authorised session linked to a trip must not retain terminal cancel pollution.
    failure_reason: null,
  });

  const { emitHoldTelemetry } = await import("./holdTelemetrySSOT.ts");
  await emitHoldTelemetry(supabase, "HOLD_LINKED_TO_TRIP", {
    tripId: args.tripId,
    clientActionId: args.clientActionId,
    providerOrderId: args.providerOrderId ?? null,
    source: "markPaymentSessionTripCreated",
  });
}

export async function markPaymentSessionOrphaned(
  supabase: SupabaseClient,
  args: {
    clientActionId?: string | null;
    providerOrderId: string;
    userId: string;
    customerId?: string | null;
    serviceAreaId?: string | null;
    authorisedAmountPence?: number | null;
    failureReason: string;
    failureStage: string;
    bookingSnapshot?: Record<string, unknown>;
  },
): Promise<void> {
  const now = new Date().toISOString();
  const sessionPatch = {
    status: toDbPaymentSessionStatus("orphan_authorisation"),
    failure_reason: args.failureReason,
  };

  if (args.clientActionId) {
    await patchPaymentSession(supabase, { clientActionId: args.clientActionId }, sessionPatch);
  } else {
    await patchPaymentSession(supabase, { providerOrderId: args.providerOrderId }, sessionPatch);
  }

  // orphan_payments upsert identity: provider_order_id (Revolut order id).
  await supabase.from("orphan_payments").upsert({
    user_id: args.userId,
    customer_id: args.customerId ?? null,
    amount_pence: args.authorisedAmountPence ?? 0,
    currency: "gbp",
    payment_status: "authorised",
    client_action_id: args.clientActionId ?? null,
    service_area_id: args.serviceAreaId ?? null,
    failure_reason: `${args.failureStage}: ${args.failureReason}`,
    reversal_status: "pending",
    payment_provider: "revolut",
    provider_order_id: args.providerOrderId,
    metadata: {
      provider: "revolut",
      booking_snapshot: args.bookingSnapshot ?? null,
      admin_actions: ["recover", "cancel", "refund"],
      reconciliation_source: "payment_session_orphaned",
    },
    updated_at: now,
  }, { onConflict: "provider_order_id" });

  await supabase.from("admin_payment_audit").insert({
    action: "payment_orphaned_booking_recovery",
    provider: "revolut",
    provider_payment_id: args.providerOrderId,
    metadata: {
      failure_stage: args.failureStage,
      failure_reason: args.failureReason,
      client_action_id: args.clientActionId ?? null,
      customer_id: args.customerId ?? null,
      service_area_id: args.serviceAreaId ?? null,
    },
  }).then(({ error }) => {
    if (error) console.warn("[paymentSessionSSOT] admin audit failed", error.message);
  });

  const { emitHoldTelemetry } = await import("./holdTelemetrySSOT.ts");
  await emitHoldTelemetry(supabase, "HOLD_ORPHAN_DETECTED", {
    providerOrderId: args.providerOrderId,
    clientActionId: args.clientActionId ?? null,
    customerId: args.customerId ?? null,
    source: args.failureStage,
    terminalReason: args.failureReason,
  });
}

export async function markCardSetupOrphaned(
  supabase: SupabaseClient,
  args: {
    providerOrderId: string;
    userId: string;
    customerId?: string | null;
    serviceAreaId?: string | null;
    clientActionId?: string | null;
    failureReason: string;
  },
): Promise<void> {
  const now = new Date().toISOString();
  await patchPaymentSession(supabase, { providerOrderId: args.providerOrderId }, {
    status: toDbPaymentSessionStatus("orphan_authorisation"),
    failure_reason: `card_setup_orphaned: ${args.failureReason}`,
  });

  // orphan_payments upsert identity: provider_order_id (Revolut order id).
  await supabase.from("orphan_payments").upsert({
    provider_order_id: args.providerOrderId,
    payment_provider: "revolut",
    user_id: args.userId,
    customer_id: args.customerId ?? null,
    amount_pence: 0,
    currency: "gbp",
    payment_status: "authorised",
    client_action_id: args.clientActionId ?? null,
    service_area_id: args.serviceAreaId ?? null,
    failure_reason: `card_setup_orphaned: ${args.failureReason}`,
    reversal_status: "pending",
    metadata: {
      provider: "revolut",
      purpose: "save_card",
    },
    updated_at: now,
  }, { onConflict: "provider_order_id" });
}

export async function loadPaymentSession(
  supabase: SupabaseClient,
  args: {
    clientActionId?: string | null;
    providerOrderId?: string | null;
    sessionId?: string | null;
  },
): Promise<Record<string, unknown> | null> {
  if (args.sessionId) {
    const { data } = await supabase
      .from("payment_sessions")
      .select("*")
      .eq("id", args.sessionId)
      .maybeSingle();
    if (data) return data as Record<string, unknown>;
  }
  if (args.clientActionId) {
    const { data } = await supabase
      .from("payment_sessions")
      .select("*")
      .eq("client_action_id", args.clientActionId)
      .maybeSingle();
    if (data) return data as Record<string, unknown>;
  }
  if (args.providerOrderId) {
    const { data } = await supabase
      .from("payment_sessions")
      .select("*")
      .eq("provider_order_id", args.providerOrderId)
      .maybeSingle();
    if (data) return data as Record<string, unknown>;
  }
  return null;
}

function bookingSnapshotReady(snapshot: unknown): boolean {
  if (!snapshot || typeof snapshot !== "object") return false;
  const s = snapshot as Record<string, unknown>;
  const pickup = s.pickup as Record<string, unknown> | undefined;
  const dropoff = s.dropoff as Record<string, unknown> | undefined;
  return Boolean(
    pickup?.address
    && dropoff?.address
    && s.service_area_id
    && s.client_action_id
    && s.payment_intent_id,
  );
}

/**
 * Webhook SSOT: when payment is authorised and session has a booking snapshot,
 * invoke create-trip-after-payment with internal service credentials.
 */
export async function finalizeBookingAfterPaymentFromSession(
  supabase: SupabaseClient,
  args: {
    providerOrderId: string;
    clientActionId?: string | null;
    supabaseUrl: string;
    serviceRoleKey: string;
  },
): Promise<{ attempted: boolean; tripId?: string; error?: string }> {
  const session = await loadPaymentSession(supabase, {
    clientActionId: args.clientActionId,
    providerOrderId: args.providerOrderId,
  });
  if (!session) return { attempted: false, error: "session_not_found" };

  const status = String(session.status ?? "");
  if (status === "trip_created" && session.trip_id) {
    return { attempted: false, tripId: String(session.trip_id) };
  }

  const sessionGate = gatePaymentSessionForTripCreate(session);
  if (!sessionGate.ok) {
    console.info("TRIP_CREATION_BLOCKED_PAYMENT_NOT_AUTHORIZED", {
      client_action_id: session.client_action_id,
      provider_order_id: args.providerOrderId,
      reason: sessionGate.reason,
      source: "finalizeBookingAfterPaymentFromSession",
    });
    return { attempted: false, error: sessionGate.reason };
  }

  const bookingSnapshot = session.booking_snapshot as Record<string, unknown> | undefined;
  if (!bookingSnapshotReady(bookingSnapshot)) {
    return { attempted: false, error: "booking_snapshot_incomplete" };
  }

  const userId = String(session.user_id ?? "");
  if (!userId) return { attempted: false, error: "missing_user_id" };

  const internalSecret = Deno.env.get("ONECAB_INTERNAL_FINALIZE_SECRET");
  if (!internalSecret) {
    console.warn("[paymentSessionSSOT] ONECAB_INTERNAL_FINALIZE_SECRET not set — webhook finalize skipped");
    return { attempted: false, error: "internal_finalize_not_configured" };
  }

  const readySnapshot = bookingSnapshot as Record<string, unknown>;

  const body = {
    ...readySnapshot,
    payment_intent_id: args.providerOrderId,
    client_action_id: readySnapshot.client_action_id ?? session.client_action_id,
    internal_user_id: userId,
  };

  try {
    const res = await fetch(`${args.supabaseUrl}/functions/v1/create-trip-after-payment`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${args.serviceRoleKey}`,
        "x-onecab-internal-finalize": internalSecret,
      },
      body: JSON.stringify(body),
    });
    const payload = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (!res.ok) {
      return {
        attempted: true,
        error: String(payload.error ?? payload.code ?? res.status),
      };
    }
    const tripId = (payload.ride_id ?? payload.trip_id) as string | undefined;
    return { attempted: true, tripId };
  } catch (err) {
    return {
      attempted: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
