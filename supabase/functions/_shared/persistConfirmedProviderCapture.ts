/**
 * Atomic capture evidence persistence helpers (edge) — session + payments + trip mirror.
 * Never deletes. Never invents £0. Idempotent on provider capture identity + amount.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  confirmedPositiveCapturePence,
  extractProviderFeePence,
  isValidConfirmedCapturePence,
  resolveCaptureAmountToPersist,
  shouldRepairCaptureEvidence,
} from "../../../shared/paymentCaptureEvidenceSSOT.ts";
import {
  buildTripPaymentProjectionAfterCapture,
  resolveCanonicalCustomerPayablePence,
} from "../../../shared/paymentSessionsCaptureConfirmationSSOT.ts";
import { extractConfirmedCaptureAmountPence, extractProviderCaptureId } from "../../../shared/paymentHoldProviderTerminalPure.ts";
import { markPaymentSessionCaptured } from "./paymentSessionSSOT.ts";

export type PersistConfirmedCaptureArgs = {
  supabase: SupabaseClient;
  tripId: string;
  clientActionId?: string | null;
  providerOrderId: string;
  providerPayload?: Record<string, unknown> | null;
  providerState?: string | null;
  localCapturedAmountPence?: number | null;
  captureAmountPence?: number | null;
  capturedAt?: string | null;
  providerCaptureId?: string | null;
  providerFeePence?: number | null;
  verifiedBy?: string;
  source?: string;
};

export type PersistConfirmedCaptureResult = {
  applied: boolean;
  reason: string;
  captured_amount_pence: number | null;
  provider_fee_pence: number | null;
  classification: string;
};

export async function persistConfirmedProviderCapture(
  args: PersistConfirmedCaptureArgs,
): Promise<PersistConfirmedCaptureResult> {
  const orderId = String(args.providerOrderId ?? "").trim();
  const tripId = String(args.tripId ?? "").trim();
  if (!orderId || !tripId) {
    return {
      applied: false,
      reason: "missing_identity",
      captured_amount_pence: null,
      provider_fee_pence: null,
      classification: "CAPTURE_AMOUNT_MISSING",
    };
  }

  const providerAmt = confirmedPositiveCapturePence(args.captureAmountPence)
    ?? extractConfirmedCaptureAmountPence(args.providerPayload, args.providerState);
  const resolved = resolveCaptureAmountToPersist({
    localCapturedAmountPence: args.localCapturedAmountPence,
    providerCapturedAmountPence: providerAmt,
  });
  const amount = resolved.amount_pence;
  if (!isValidConfirmedCapturePence(amount)) {
    return {
      applied: false,
      reason: "no_valid_provider_capture_amount",
      captured_amount_pence: null,
      provider_fee_pence: null,
      classification: args.localCapturedAmountPence != null
        && Number(args.localCapturedAmountPence) <= 0
        ? "CAPTURE_ZERO_INVALID"
        : "CAPTURE_AMOUNT_MISSING",
    };
  }

  const needsWrite = shouldRepairCaptureEvidence({
    providerCapturedAmountPence: amount,
    localCapturedAmountPence: args.localCapturedAmountPence,
  }) || resolved.used_provider;

  const fee = confirmedPositiveCapturePence(args.providerFeePence)
    ?? extractProviderFeePence(args.providerPayload);
  const captureId = args.providerCaptureId
    ?? extractProviderCaptureId(args.providerPayload);
  const capturedAt = args.capturedAt ?? new Date().toISOString();
  const verifiedBy = args.verifiedBy ?? args.source ?? "capture_persist";
  const now = new Date().toISOString();

  if (!needsWrite) {
    // Still allow fee backfill when capture already matches.
    if (fee != null) {
      await args.supabase.from("payment_sessions").update({
        provider_processing_fee_pence: fee,
        fee_status: "ACTUAL",
        provider_state: "CAPTURED",
        provider_state_verified_at: now,
        provider_state_verified_by: verifiedBy,
        updated_at: now,
        metadata: {
          capture_persist_source: args.source ?? "persistConfirmedProviderCapture",
          capture_idempotent: true,
        },
      }).eq("provider_order_id", orderId);
    }
    return {
      applied: false,
      reason: "idempotent_already_persisted",
      captured_amount_pence: amount,
      provider_fee_pence: fee,
      classification: "CAPTURE_COMPLETE",
    };
  }

  await markPaymentSessionCaptured(args.supabase, {
    clientActionId: args.clientActionId ?? null,
    providerOrderId: orderId,
    tripId,
    captureAmountPence: amount,
    capturedAt,
    providerCaptureId: captureId,
  });

  await args.supabase.from("payment_sessions").update({
    provider_state: "CAPTURED",
    provider_state_verified_at: now,
    provider_state_verified_by: verifiedBy,
    provider_processing_fee_pence: fee,
    fee_status: fee != null ? "ACTUAL" : "PENDING",
    provider_capture_id: captureId,
    hold_terminal_reason: "PROVIDER_CAPTURED",
    metadata: {
      capture_amount_pence: amount,
      provider_state: "CAPTURED",
      provider_state_verified_at: now,
      provider_state_verified_by: verifiedBy,
      capture_persist_source: args.source ?? "persistConfirmedProviderCapture",
      ...(fee != null ? { provider_fee_pence: fee } : {}),
    },
    updated_at: now,
  }).eq("provider_order_id", orderId);

  const { data: tripRow } = await args.supabase
    .from("trips")
    .select(
      "final_customer_fare_pence, final_fare_pence, no_show_charge_pence, cancellation_fee_pence, outstanding_balance_pence, estimated_total_pence, authorised_amount_pence, payment_provider, payment_method",
    )
    .eq("id", tripId)
    .maybeSingle();

  const payable = resolveCanonicalCustomerPayablePence({
    finalCustomerFarePence: tripRow?.final_customer_fare_pence == null
      ? null
      : Number(tripRow.final_customer_fare_pence),
    finalFarePence: tripRow?.final_fare_pence == null ? null : Number(tripRow.final_fare_pence),
    noShowChargePence: tripRow?.no_show_charge_pence == null
      ? null
      : Number(tripRow.no_show_charge_pence),
    cancellationFeePence: tripRow?.cancellation_fee_pence == null
      ? null
      : Number(tripRow.cancellation_fee_pence),
    outstandingBalancePence: tripRow?.outstanding_balance_pence == null
      ? null
      : Number(tripRow.outstanding_balance_pence),
    estimatedTotalPence: tripRow?.estimated_total_pence == null
      ? null
      : Number(tripRow.estimated_total_pence),
  });

  const tripProjection = buildTripPaymentProjectionAfterCapture({
    canonicalPayablePence: payable.payable_pence,
    totalAuthorisedPence: tripRow?.authorised_amount_pence == null
      ? null
      : Number(tripRow.authorised_amount_pence),
    totalCapturedPence: amount,
    paymentProvider: (tripRow?.payment_provider as string | null) ?? "revolut",
    paymentMethod: (tripRow?.payment_method as string | null) ?? null,
  });

  await args.supabase.from("trips").update({
    payment_status: tripProjection.payment_status,
    payment_hold_status: "captured",
    capture_amount_pence: tripProjection.capture_amount_pence,
    outstanding_balance_pence: tripProjection.outstanding_balance_pence,
    payment_coverage_status: tripProjection.payment_coverage_status,
    provider_charge_id: captureId ?? orderId,
    provider_fee_pence: fee,
    updated_at: now,
  }).eq("id", tripId);

  // payments uses stripe_payment_intent_id as Revolut order id (legacy column).
  const paymentPatch: Record<string, unknown> = {
    status: "captured",
    captured_amount_pence: amount,
    provider_status: "COMPLETED",
    payment_provider: "revolut",
    updated_at: now,
  };
  if (captureId) paymentPatch.provider_payment_id = captureId;
  if (fee != null) paymentPatch.provider_fee_pence = fee;

  const { data: existingPay } = await args.supabase
    .from("payments")
    .select("id, captured_amount_pence")
    .eq("trip_id", tripId)
    .eq("stripe_payment_intent_id", orderId)
    .maybeSingle();

  if (existingPay?.id) {
    const existingCap = confirmedPositiveCapturePence(existingPay.captured_amount_pence);
    if (existingCap !== amount) {
      await args.supabase.from("payments").update(paymentPatch).eq("id", existingPay.id);
    } else if (fee != null) {
      await args.supabase.from("payments").update({
        provider_fee_pence: fee,
        updated_at: now,
      }).eq("id", existingPay.id);
    }
  }
  // Do not invent a new payments row here — session + trip are canonical for this repair path.

  await args.supabase.from("admin_payment_audit").insert({
    action: "persist_confirmed_provider_capture",
    provider: "revolut",
    provider_payment_id: orderId,
    trip_id: tripId,
    amount_pence_before: args.localCapturedAmountPence ?? null,
    amount_pence_after: amount,
    delta_pence: amount - Math.max(0, Number(args.localCapturedAmountPence ?? 0)),
    metadata: {
      source: args.source ?? "persistConfirmedProviderCapture",
      provider_capture_id: captureId,
      provider_fee_pence: fee,
      idempotency_key: `capture:${orderId}:${amount}`,
    },
  });

  return {
    applied: true,
    reason: "persisted",
    captured_amount_pence: amount,
    provider_fee_pence: fee,
    classification: "CAPTURE_COMPLETE",
  };
}
