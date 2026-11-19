/**
 * Dynamic payment workflow SSOT — single PI per booking, idempotent auth/capture,
 * outstanding balance when final fare exceeds authorization.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import type { TripFareRow } from "./tripFareSSOT.ts";
import {
  resolveArrivalWaitingChargePence,
  resolveCustomerModificationChargePence,
  resolveStopWaitingChargePence,
} from "./tripFareSSOT.ts";

export type PaymentCoverageStatus =
  | "not_required"
  | "pending_authorization"
  | "authorized"
  | "authorization_insufficient"
  | "top_up_pending"
  | "fully_covered"
  | "capture_pending"
  | "captured"
  | "under_captured"
  | "capture_failed";

export type PaymentAuthOperation = "initial_auth" | "top_up" | "capture";

export type PaymentAuthLedgerStatus = "pending" | "succeeded" | "failed" | "skipped";

export type TripPaymentRow = TripFareRow & {
  id?: string;
  payment_method?: string | null;
  payment_intent_id?: string | null;
  provider_order_id?: string | null;
  authorised_amount_pence?: number | null;
  authorized_amount_pence?: number | null;
  total_authorized_amount_pence?: number | null;
  fare_revision_number?: number | null;
  idempotency_key?: string | null;
  client_action_id?: string | null;
  payment_coverage_status?: PaymentCoverageStatus | null;
  outstanding_balance_pence?: number | null;
  modification_status?: string | null;
  destination_change_charge_pence?: number | null;
  stop_modification_charge_pence?: number | null;
  payment_status?: string | null;
};

function nonNegInt(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n);
}

export function isCashPaymentMethod(paymentMethod: string | null | undefined): boolean {
  return (paymentMethod ?? "").trim().toLowerCase() === "cash";
}

export function buildPreauthIdempotencyKey(args: {
  tripId?: string | null;
  clientActionId?: string | null;
}): string {
  const suffix = args.tripId ?? args.clientActionId ?? crypto.randomUUID();
  return `preauth_${suffix}`;
}

export function buildCaptureIdempotencyKey(tripId: string, captureAmountPence: number): string {
  return `capture_${tripId}_${captureAmountPence}`;
}

export async function recordPaymentAuthorizationEvent(
  supabase: SupabaseClient,
  args: {
    tripId: string;
    fareRevisionNumber: number;
    operation: PaymentAuthOperation;
    idempotencyKey: string;
    providerOrderId?: string | null;
    amountPence: number;
    status: PaymentAuthLedgerStatus;
    errorMessage?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<{ duplicate: boolean }> {
  const metadata: Record<string, unknown> = {
    ...(args.metadata ?? {}),
  };
  if (args.providerOrderId) {
    metadata.provider_order_id = args.providerOrderId;
  }

  const { error } = await supabase.from("payment_authorization_ledger").insert({
    trip_id: args.tripId,
    fare_revision_number: args.fareRevisionNumber,
    operation: args.operation,
    idempotency_key: args.idempotencyKey,
    amount_pence: args.amountPence,
    status: args.status,
    error_message: args.errorMessage ?? null,
    metadata,
    updated_at: new Date().toISOString(),
  });

  if (error) {
    if (error.code === "23505") {
      return { duplicate: true };
    }
    throw error;
  }

  return { duplicate: false };
}

export async function markPaymentAuthorizationEvent(
  supabase: SupabaseClient,
  idempotencyKey: string,
  status: PaymentAuthLedgerStatus,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await supabase
    .from("payment_authorization_ledger")
    .update({
      status,
      metadata: metadata ?? {},
      updated_at: new Date().toISOString(),
    })
    .eq("idempotency_key", idempotencyKey);
}

export function buildTripPaymentSyncPatch(args: {
  paymentIntentId?: string | null;
  authorizedAmountPence?: number | null;
  totalAuthorizedAmountPence?: number | null;
  fareRevisionNumber?: number | null;
  idempotencyKey?: string | null;
  paymentCoverageStatus?: PaymentCoverageStatus | null;
  outstandingBalancePence?: number | null;
  captureAmountPence?: number | null;
}): Record<string, unknown> {
  const patch: Record<string, unknown> = {};

  if (args.paymentIntentId != null) {
    // Never write legacy payment-intent columns — Revolut SSOT uses provider_order_id /
    // payment_intent_id only.
    patch.payment_intent_id = args.paymentIntentId;
  }
  if (args.authorizedAmountPence != null) {
    patch.authorized_amount_pence = args.authorizedAmountPence;
    patch.authorised_amount_pence = args.authorizedAmountPence;
  }
  if (args.totalAuthorizedAmountPence != null) {
    patch.total_authorized_amount_pence = args.totalAuthorizedAmountPence;
  }
  if (args.fareRevisionNumber != null) {
    patch.fare_revision_number = args.fareRevisionNumber;
  }
  if (args.idempotencyKey != null) {
    patch.idempotency_key = args.idempotencyKey;
  }
  if (args.paymentCoverageStatus != null) {
    patch.payment_coverage_status = args.paymentCoverageStatus;
  }
  if (args.outstandingBalancePence != null) {
    patch.outstanding_balance_pence = args.outstandingBalancePence;
  }
  if (args.captureAmountPence != null) {
    patch.capture_amount_pence = args.captureAmountPence;
  }

  return patch;
}

