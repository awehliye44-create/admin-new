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

export function resolveBookingPaymentIntentId(trip: TripPaymentRow): string | null {
  return trip.payment_intent_id ?? trip.provider_order_id ?? null;
}

export function resolveBookingIdempotencyKey(trip: TripPaymentRow): string | null {
  return trip.idempotency_key ?? trip.client_action_id ?? null;
}

export function resolveTotalAuthorizedAmountPence(trip: TripPaymentRow): number {
  return (
    nonNegInt(trip.total_authorized_amount_pence)
    || nonNegInt(trip.authorized_amount_pence)
    || nonNegInt(trip.authorised_amount_pence)
  );
}

/** Fare lock bypass: destination changes, stops, waiting, long-distance, admin adjustments. */
export function shouldBypassFareLockForRecalc(trip: TripPaymentRow): boolean {
  if (!trip.fare_locked) return true;

  if (resolveCustomerModificationChargePence(trip) > 0) return true;
  if (nonNegInt(trip.destination_change_charge_pence) > 0) return true;
  if (nonNegInt(trip.stop_modification_charge_pence) > 0) return true;
  if (resolveArrivalWaitingChargePence(trip) > 0) return true;
  if (resolveStopWaitingChargePence(trip) > 0) return true;

  const modificationStatus = (trip.modification_status ?? "").trim().toLowerCase();
  if (modificationStatus === "confirmed" || modificationStatus === "approved") return true;

  const snapshot = trip.fare_snapshot_json;
  if (snapshot && typeof snapshot === "object") {
    const reason = String((snapshot as Record<string, unknown>).modification_reason ?? "").toLowerCase();
    if (
      reason.includes("destination")
      || reason.includes("add_stop")
      || reason.includes("long_distance")
      || reason.includes("admin")
    ) {
      return true;
    }
  }

  return false;
}

export function buildPreauthIdempotencyKey(args: {
  tripId?: string | null;
  clientActionId?: string | null;
}): string {
  const suffix = args.tripId ?? args.clientActionId ?? crypto.randomUUID();
  return `preauth_${suffix}`;
}

export function buildTopUpIdempotencyKey(tripId: string, fareRevisionNumber: number): string {
  return `topup_${tripId}_rev${fareRevisionNumber}`;
}

export function buildUpdateAuthIdempotencyKey(tripId: string, fareRevisionNumber: number): string {
  return `updateauth_${tripId}_rev${fareRevisionNumber}`;
}

export function buildCaptureIdempotencyKey(tripId: string, captureAmountPence: number): string {
  return `capture_${tripId}_${captureAmountPence}`;
}

export function computePaymentCoverageStatus(args: {
  paymentMethod?: string | null;
  finalPayablePence: number;
  totalAuthorizedPence: number;
  capturedPence?: number;
  outstandingBalancePence?: number;
  captureFailed?: boolean;
}): PaymentCoverageStatus {
  if (isCashPaymentMethod(args.paymentMethod)) return "not_required";
  if (args.captureFailed) return "capture_failed";

  const captured = nonNegInt(args.capturedPence);
  const outstanding = nonNegInt(args.outstandingBalancePence);
  const authorized = nonNegInt(args.totalAuthorizedPence);
  const payable = nonNegInt(args.finalPayablePence);

  if (captured > 0) {
    if (outstanding > 0) return "under_captured";
    return "captured";
  }

  if (authorized <= 0) return "pending_authorization";
  if (payable <= authorized) return "fully_covered";
  return "authorization_insufficient";
}

/** Trip/payment status after primary Stripe capture — never treat under-capture as fully paid. */
export function resolvePaymentStatusAfterCapture(args: {
  outstandingBalancePence: number;
}): { payment_status: string; payment_coverage_status: PaymentCoverageStatus } {
  if (nonNegInt(args.outstandingBalancePence) > 0) {
    return {
      payment_status: "partially_paid",
      payment_coverage_status: "under_captured",
    };
  }
  return {
    payment_status: "captured",
    payment_coverage_status: "captured",
  };
}

export function computeCapturePlan(args: {
  finalPayablePence: number;
  totalAuthorizedPence: number;
  walletAppliedPence?: number;
}): {
  walletAppliedPence: number;
  cardPayablePence: number;
  captureAmountPence: number;
  outstandingBalancePence: number;
} {
  const walletAppliedPence = nonNegInt(args.walletAppliedPence);
  const finalPayablePence = nonNegInt(args.finalPayablePence);
  const totalAuthorizedPence = nonNegInt(args.totalAuthorizedPence);
  const cardPayablePence = Math.max(0, finalPayablePence - walletAppliedPence);
  const captureAmountPence = Math.min(cardPayablePence, totalAuthorizedPence);
  const outstandingBalancePence = Math.max(0, cardPayablePence - captureAmountPence);

  return {
    walletAppliedPence,
    cardPayablePence,
    captureAmountPence,
    outstandingBalancePence,
  };
}

export async function hasAuthorizationForRevision(
  supabase: SupabaseClient,
  tripId: string,
  fareRevisionNumber: number,
  operation: PaymentAuthOperation = "top_up",
): Promise<boolean> {
  const { data, error } = await supabase
    .from("payment_authorization_ledger")
    .select("id, status, amount_pence")
    .eq("trip_id", tripId)
    .eq("fare_revision_number", fareRevisionNumber)
    .eq("operation", operation)
    .in("status", ["pending", "succeeded"])
    .limit(1)
    .maybeSingle();

  if (error) {
    console.warn("[dynamicPaymentWorkflow] ledger lookup failed", error.message);
    return false;
  }

  return Boolean(data);
}

export async function hasSucceededCapture(
  supabase: SupabaseClient,
  tripId: string,
  captureAmountPence: number,
): Promise<boolean> {
  const idempotencyKey = buildCaptureIdempotencyKey(tripId, captureAmountPence);
  const { data, error } = await supabase
    .from("payment_authorization_ledger")
    .select("id")
    .eq("trip_id", tripId)
    .eq("operation", "capture")
    .eq("idempotency_key", idempotencyKey)
    .eq("status", "succeeded")
    .maybeSingle();

  if (error) {
    console.warn("[dynamicPaymentWorkflow] capture ledger lookup failed", error.message);
    return false;
  }

  return Boolean(data);
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

export function nextFareRevisionNumber(trip: TripPaymentRow): number {
  return nonNegInt(trip.fare_revision_number) + 1;
}
