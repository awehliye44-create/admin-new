/**
 * Persist provider-confirmed terminal hold states into payment_sessions + orphan_payments.
 * Used by Revolut webhooks and admin provider refresh. Idempotent; never deletes rows;
 * never infers released_amount_pence from authorised_amount_pence.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  mapRevolutProviderHoldState,
  providerTerminalReason,
  type CanonicalProviderHoldState,
} from "../../../shared/paymentHoldClassificationSSOT.ts";
import {
  buildReleasedSessionPatch,
  extractConfirmedCaptureAmountPence,
  extractConfirmedReleaseAmountPence,
  extractEventTimestamp,
  extractProviderCaptureId,
  hasTerminalIdempotencyKey,
  shouldPersistFailedAsTerminal,
} from "../../../shared/paymentHoldProviderTerminalPure.ts";
import {
  extractConfirmedRefundAmountPence,
  extractProviderRefundId,
  isRefundTerminalNotRelease,
} from "../../../shared/paymentSessionRefundFeeSSOT.ts";
import {
  markPaymentSessionReleased,
  upsertPaymentSessionRefund,
} from "./paymentSessionSSOT.ts";
import { persistConfirmedProviderCapture } from "./persistConfirmedProviderCapture.ts";
import { extractProviderFeePence } from "../../../shared/paymentCaptureEvidenceSSOT.ts";

export type PersistProviderTerminalResult = {
  applied: boolean;
  already_resolved: boolean;
  provider_state: CanonicalProviderHoldState;
  payment_session_id: string | null;
  orphan_closed: number;
  reason: string | null;
};

async function loadSessionByProviderOrder(
  supabase: SupabaseClient,
  paymentProvider: string,
  providerOrderId: string,
): Promise<Record<string, unknown> | null> {
  const { data } = await supabase
    .from("payment_sessions")
    .select("*")
    .eq("payment_provider", paymentProvider)
    .eq("provider_order_id", providerOrderId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as Record<string, unknown> | null) ?? null;
}

/**
 * Close companion orphan_payments for the same provider + order.
 * Sets reversal_status=resolved; preserves failure_reason.
 */
export async function closeCompanionOrphanPayments(
  supabase: SupabaseClient,
  args: {
    paymentProvider: string;
    providerOrderId: string;
    resolutionReason: string;
    resolvedAt?: string;
    source: string;
  },
): Promise<number> {
  const now = args.resolvedAt ?? new Date().toISOString();
  const { data: orphans } = await supabase
    .from("orphan_payments")
    .select("id, reversal_status, resolved_at, metadata, failure_reason")
    .eq("payment_provider", args.paymentProvider)
    .eq("provider_order_id", args.providerOrderId)
    .in("reversal_status", ["pending", "failed"]);

  let closed = 0;
  for (const orphan of orphans ?? []) {
    if (orphan.resolved_at && String(orphan.reversal_status) === "resolved") continue;
    const metadata = orphan.metadata && typeof orphan.metadata === "object"
      ? { ...(orphan.metadata as Record<string, unknown>) }
      : {};
    metadata.resolution_reason = args.resolutionReason;
    metadata.resolution_source = args.source;

    const { error } = await supabase.from("orphan_payments").update({
      reversal_status: "resolved",
      resolved_at: now,
      resolution_reason: args.resolutionReason,
      updated_at: now,
      metadata,
    }).eq("id", orphan.id);

    if (!error) closed += 1;
  }

  return closed;
}

export async function persistProviderTerminalHoldState(
  supabase: SupabaseClient,
  args: {
    paymentProvider?: string;
    providerOrderId: string;
    providerStateRaw: string | null | undefined;
    source: "revolut_webhook" | "admin_refresh" | "hold_attention_backfill";
    providerPayload?: Record<string, unknown> | null;
    eventTimestamp?: string | null;
    idempotencyKey?: string | null;
  },
): Promise<PersistProviderTerminalResult> {
  const paymentProvider = args.paymentProvider ?? "revolut";
  const providerState = mapRevolutProviderHoldState(args.providerStateRaw);
  const terminalReason = providerTerminalReason(providerState);
  const orderId = String(args.providerOrderId ?? "").trim();
  const verifiedBy = args.source === "admin_refresh" ? "admin_refresh" : args.source;

  if (!orderId) {
    return {
      applied: false,
      already_resolved: false,
      provider_state: providerState,
      payment_session_id: null,
      orphan_closed: 0,
      reason: "missing_provider_order_id",
    };
  }

  let persistable =
    providerState === "CANCELLED"
    || providerState === "REVERTED"
    || providerState === "CAPTURED"
    || providerState === "REFUNDED"
    || providerState === "FAILED";

  if (!persistable || !terminalReason) {
    return {
      applied: false,
      already_resolved: false,
      provider_state: providerState,
      payment_session_id: null,
      orphan_closed: 0,
      reason: "not_terminal_persistable",
    };
  }

  const session = await loadSessionByProviderOrder(supabase, paymentProvider, orderId);
  const sessionId = session?.id ? String(session.id) : null;
  const releasedAtExisting = session?.released_at ? String(session.released_at) : null;
  const capturedAtExisting = session?.captured_at ? String(session.captured_at) : null;
  const existingTerminal = session?.hold_terminal_reason
    ? String(session.hold_terminal_reason)
    : null;

  if (providerState === "FAILED") {
    const ok = shouldPersistFailedAsTerminal({
      providerStateRaw: args.providerStateRaw,
      sessionCapturedAt: capturedAtExisting,
      sessionReleasedAt: releasedAtExisting,
    });
    if (!ok) {
      return {
        applied: false,
        already_resolved: Boolean(capturedAtExisting),
        provider_state: providerState,
        payment_session_id: sessionId,
        orphan_closed: 0,
        reason: "failed_not_terminal_hold_remains_or_captured",
      };
    }
  }

  const verifiedAt = new Date().toISOString();
  const eventAt = args.eventTimestamp?.trim()
    || extractEventTimestamp(args.providerPayload);
  const confirmedReleaseAmount = extractConfirmedReleaseAmountPence(args.providerPayload);
  const confirmedRefundAmount = extractConfirmedRefundAmountPence(args.providerPayload);
  const confirmedCaptureAmount = extractConfirmedCaptureAmountPence(
    args.providerPayload,
    providerState,
  );
  const providerCaptureId = extractProviderCaptureId(args.providerPayload);
  const sessionStatusExisting = session?.status ? String(session.status) : null;
  const capturedAmountExisting = session?.captured_amount_pence != null
    ? Number(session.captured_amount_pence)
    : null;

  const baseMetadata = session?.metadata && typeof session.metadata === "object"
    ? { ...(session.metadata as Record<string, unknown>) }
    : {};

  const refundNotRelease = isRefundTerminalNotRelease({
    providerCanonical: providerState,
    refundAmountPence: confirmedRefundAmount,
  });

  if (hasTerminalIdempotencyKey(baseMetadata, args.idempotencyKey)) {
    const orphanClosed = await closeCompanionOrphanPayments(supabase, {
      paymentProvider,
      providerOrderId: orderId,
      resolutionReason: terminalReason,
      resolvedAt: eventAt,
      source: args.source,
    });
    return {
      applied: false,
      already_resolved: true,
      provider_state: providerState,
      payment_session_id: sessionId,
      orphan_closed: orphanClosed,
      reason: "idempotent_replay",
    };
  }

  const captureNeedsRepair = providerState === "CAPTURED" && Boolean(sessionId) && (
    !capturedAtExisting
    || sessionStatusExisting === "completed_pending_capture"
    || sessionStatusExisting === "payment_authorised"
    || sessionStatusExisting === "authorised_hold"
    || (capturedAmountExisting == null && confirmedCaptureAmount != null)
  );

  if (
    (releasedAtExisting || capturedAtExisting)
    && existingTerminal === terminalReason
    && !captureNeedsRepair
  ) {
    if (sessionId) {
      await supabase.from("payment_sessions").update({
        provider_state: providerState,
        provider_state_verified_at: verifiedAt,
        provider_state_verified_by: verifiedBy,
        metadata: {
          ...baseMetadata,
          provider_state: providerState,
          provider_state_verified_at: verifiedAt,
          provider_state_verified_by: verifiedBy,
        },
        updated_at: verifiedAt,
      }).eq("id", sessionId);
    }
    const orphanClosed = await closeCompanionOrphanPayments(supabase, {
      paymentProvider,
      providerOrderId: orderId,
      resolutionReason: terminalReason,
      resolvedAt: eventAt,
      source: args.source,
    });
    return {
      applied: false,
      already_resolved: true,
      provider_state: providerState,
      payment_session_id: sessionId,
      orphan_closed: orphanClosed,
      reason: "already_resolved",
    };
  }

  if (providerState === "CAPTURED") {
    if (sessionId) {
      const tripId = session?.trip_id ? String(session.trip_id) : null;
      const captureAmount = confirmedCaptureAmount ?? capturedAmountExisting;
      const feePence = extractProviderFeePence(args.providerPayload);
      if (tripId && captureAmount != null) {
        await persistConfirmedProviderCapture({
          supabase,
          tripId,
          clientActionId: (session?.client_action_id as string | null) ?? null,
          providerOrderId: orderId,
          providerPayload: args.providerPayload ?? null,
          providerState,
          localCapturedAmountPence: capturedAmountExisting,
          captureAmountPence: captureAmount,
          capturedAt: capturedAtExisting ?? eventAt,
          providerCaptureId: providerCaptureId,
          providerFeePence: feePence,
          verifiedBy,
          source: args.source,
        });
        await supabase.from("payment_sessions").update({
          hold_terminal_reason: terminalReason,
          provider_state: providerState,
          provider_state_verified_at: verifiedAt,
          provider_state_verified_by: verifiedBy,
          fee_status: feePence != null ? "ACTUAL" : (session?.fee_status ?? "PENDING"),
          provider_processing_fee_pence: feePence ?? session?.provider_processing_fee_pence ?? null,
          provider_payment_id: providerCaptureId
            ?? (session?.provider_payment_id as string | null)
            ?? null,
          metadata: {
            ...baseMetadata,
            provider_state: providerState,
            provider_state_verified_at: verifiedAt,
            provider_state_verified_by: verifiedBy,
          },
          updated_at: verifiedAt,
        }).eq("id", sessionId);
      } else {
        // Provider verified CAPTURED but amount not yet known — persist status + timestamps.
        await supabase.from("payment_sessions").update({
          status: "captured",
          captured_at: capturedAtExisting ?? eventAt,
          hold_terminal_reason: terminalReason,
          release_failure_reason: null,
          hold_release_state: null,
          provider_state: providerState,
          provider_state_verified_at: verifiedAt,
          provider_state_verified_by: verifiedBy,
          provider_capture_id: providerCaptureId ?? session?.provider_capture_id ?? null,
          fee_status: feePence != null ? "ACTUAL" : (session?.fee_status ?? "PENDING"),
          provider_processing_fee_pence: feePence ?? session?.provider_processing_fee_pence ?? null,
          metadata: {
            ...baseMetadata,
            provider_state: providerState,
            provider_state_verified_at: verifiedAt,
            provider_state_verified_by: verifiedBy,
            capture_amount_pending: true,
          },
          updated_at: verifiedAt,
        }).eq("id", sessionId);
      }
    }
  } else if (refundNotRelease) {
    // Slice 3: REFUNDED with refund amount is refund evidence — not residual release.
    if (sessionId) {
      const extracted = extractProviderRefundId({
        eventData: args.providerPayload ?? null,
        providerRefundIdHint: typeof args.idempotencyKey === "string"
          && !String(args.idempotencyKey).startsWith("evt_")
          ? args.idempotencyKey
          : null,
      });
      if (extracted.provider_refund_id && confirmedRefundAmount != null) {
        await upsertPaymentSessionRefund(supabase, {
          paymentSessionId: sessionId,
          providerOrderId: orderId,
          providerRefundId: extracted.provider_refund_id,
          amountPence: confirmedRefundAmount,
          webhookEventId: extracted.webhook_event_id,
          metadata: {
            source: args.source,
            provider_state: providerState,
          },
        });
      } else {
        console.warn(
          "[paymentHoldProviderTerminal] REFUNDED without real provider_refund_id — amount not invented",
          { orderId, confirmedRefundAmount },
        );
      }
      await supabase.from("payment_sessions").update({
        provider_state: providerState,
        provider_state_verified_at: verifiedAt,
        provider_state_verified_by: verifiedBy,
        metadata: {
          ...baseMetadata,
          provider_state: providerState,
          provider_state_verified_at: verifiedAt,
          provider_state_verified_by: verifiedBy,
          refund_terminal_not_release: true,
        },
        updated_at: verifiedAt,
      }).eq("id", sessionId);
    }
  } else if (
    providerState === "CANCELLED"
    || providerState === "REVERTED"
    || providerState === "FAILED"
    || (providerState === "REFUNDED" && !refundNotRelease)
  ) {
    if (sessionId || session) {
      await markPaymentSessionReleased(supabase, {
        providerOrderId: orderId,
        clientActionId: (session?.client_action_id as string | null) ?? null,
        tripId: (session?.trip_id as string | null) ?? null,
        reason: terminalReason,
        holdTerminalReason: terminalReason,
        providerReleaseReference: orderId,
        idempotencyKey: args.idempotencyKey ?? undefined,
        releasedAt: releasedAtExisting ?? eventAt,
      });

      const patch = buildReleasedSessionPatch({
        holdTerminalReason: terminalReason,
        providerState,
        providerStateVerifiedBy: verifiedBy,
        verifiedAt,
        confirmedReleaseAmountPence: confirmedReleaseAmount,
        metadata: baseMetadata,
        idempotencyKey: args.idempotencyKey,
      });

      if (sessionId) {
        await supabase.from("payment_sessions").update(patch).eq("id", sessionId);
      } else {
        await supabase.from("payment_sessions").update(patch)
          .eq("payment_provider", paymentProvider)
          .eq("provider_order_id", orderId);
      }
    } else {
      // No session — still close companion orphans for this provider order.
    }
  }

  const orphanClosed = await closeCompanionOrphanPayments(supabase, {
    paymentProvider,
    providerOrderId: orderId,
    resolutionReason: terminalReason,
    resolvedAt: eventAt,
    source: args.source,
  });

  return {
    applied: true,
    already_resolved: Boolean(releasedAtExisting || capturedAtExisting),
    provider_state: providerState,
    payment_session_id: sessionId,
    orphan_closed: orphanClosed,
    reason: terminalReason,
  };
}

/** Record a non-terminal provider verification (AUTHORISED etc.) without changing lifecycle. */
export async function recordProviderStateVerification(
  supabase: SupabaseClient,
  args: {
    paymentProvider?: string;
    providerOrderId: string;
    providerStateRaw: string | null | undefined;
    source: "admin_refresh";
  },
): Promise<void> {
  const paymentProvider = args.paymentProvider ?? "revolut";
  const providerState = mapRevolutProviderHoldState(args.providerStateRaw);
  const session = await loadSessionByProviderOrder(
    supabase,
    paymentProvider,
    args.providerOrderId,
  );
  if (!session?.id) return;

  const verifiedAt = new Date().toISOString();
  const metadata = session.metadata && typeof session.metadata === "object"
    ? { ...(session.metadata as Record<string, unknown>) }
    : {};
  metadata.provider_state = providerState;
  metadata.provider_state_raw = String(args.providerStateRaw ?? "").toUpperCase();
  metadata.provider_state_verified_at = verifiedAt;
  metadata.provider_state_verified_by = args.source;

  await supabase.from("payment_sessions").update({
    provider_state: providerState,
    provider_state_verified_at: verifiedAt,
    provider_state_verified_by: args.source,
    metadata,
    updated_at: verifiedAt,
  }).eq("id", String(session.id));
}
