/**
 * Same-order Revolut incremental authorisation — eligibility, limits, keys.
 * Does not call Revolut; callers use incrementRevolutOrderAuthorisation after checks.
 *
 * Provider rules (Merchant incremental authorisation):
 * - max 10 increments per order
 * - sum of increases ≤ 5× initial authorised amount
 * - sequential processing only
 * - amount body = NEW TOTAL (not delta)
 */

import type { RevolutOrder } from "./revolutOrders.ts";
import { revolutProviderAuthorisedTotalPence } from "./revolutOrders.ts";

export const REVOLUT_MAX_INCREMENTS_PER_ORDER = 10;
export const REVOLUT_MAX_INCREMENT_MULTIPLIER = 5;

export const INCREMENT_FEATURE_FLAG = "revolut_same_order_increment_enabled";

export type IncrementEligibilityReason =
  | "eligible"
  | "not_authorised"
  | "wrong_capture_mode"
  | "wrong_authorisation_type"
  | "unsupported_payment_method"
  | "already_captured"
  | "cancelled_or_failed"
  | "unknown_state"
  | "limit_count_exceeded"
  | "limit_amount_exceeded"
  | "target_not_above_current"
  | "missing_order";

export type IncrementEligibility = {
  eligible: boolean;
  reason: IncrementEligibilityReason;
  providerConfirmedTotalPence: number;
  initialAuthorisedPence: number;
  maxTargetTotalPence: number;
  incrementCount: number;
  paymentMethodType: string | null;
};

export function buildRevolutIncrementBusinessKey(args: {
  paymentSessionId: string;
  providerOrderId: string;
  targetTotalAuthorisedPence: number;
}): string {
  return [
    "revolut_increment",
    String(args.paymentSessionId).trim(),
    String(args.providerOrderId).trim(),
    String(Math.round(Number(args.targetTotalAuthorisedPence))),
  ].join(":");
}

export function buildCaptureBusinessKey(args: {
  paymentSessionId: string;
  providerOrderId: string;
  finalFarePence: number;
}): string {
  return [
    "capture",
    String(args.paymentSessionId).trim(),
    String(args.providerOrderId).trim(),
    String(Math.round(Number(args.finalFarePence))),
  ].join(":");
}

export function requiredIncrementPence(
  newRequiredTotalPence: number,
  providerConfirmedAuthorisedTotalPence: number,
): number {
  const need = Math.max(0, Math.round(Number(newRequiredTotalPence)));
  const have = Math.max(0, Math.round(Number(providerConfirmedAuthorisedTotalPence)));
  return Math.max(0, need - have);
}

export function remainingAuthorisedCapacityPence(args: {
  totalAuthorisedAmountPence: number;
  capturedAmountPence?: number | null;
  releasedAmountPence?: number | null;
}): number {
  const total = Math.max(0, Math.round(Number(args.totalAuthorisedAmountPence)));
  const captured = Math.max(0, Math.round(Number(args.capturedAmountPence ?? 0)));
  const released = Math.max(0, Math.round(Number(args.releasedAmountPence ?? 0)));
  return Math.max(0, total - captured - released);
}

function paymentMethodTypeFromOrder(order: RevolutOrder): string | null {
  const payments = Array.isArray(order.payments) ? order.payments : [];
  for (const p of payments) {
    const t = String(p?.payment_method?.type ?? "").trim().toLowerCase();
    if (t) return t;
  }
  return null;
}

/**
 * Card-backed methods eligible for Revolut incremental authorisation.
 * Revolut Pay A2A / Pay by Bank are not supported (provider docs).
 */
export function isRevolutIncrementEligiblePaymentMethod(
  methodType: string | null | undefined,
): boolean | "unknown" {
  const t = String(methodType ?? "").trim().toLowerCase();
  if (!t) return "unknown";
  if (
    t === "card" ||
    t === "apple_pay" ||
    t === "applepay" ||
    t === "google_pay" ||
    t === "googlepay"
  ) {
    return true;
  }
  if (
    t === "revolut_pay" ||
    t === "revolutpay" ||
    t === "pay_by_bank" ||
    t === "open_banking" ||
    t === "cash"
  ) {
    return false;
  }
  return "unknown";
}

export function countProviderIncrements(order: RevolutOrder): number {
  const list = Array.isArray(order.incremental_authorisations)
    ? order.incremental_authorisations
    : [];
  return list.length;
}

/**
 * Evaluate whether the retrieved provider order can accept a same-order increment
 * to targetTotalAuthorisedPence (new cumulative total).
 */
export function evaluateRevolutIncrementEligibility(args: {
  order: RevolutOrder | null | undefined;
  targetTotalAuthorisedPence: number;
  /** Initial hold at booking (local SSOT); used for 5× limit if provider omits history. */
  initialAuthorisedPence?: number | null;
  /** Confirmed+pending increment rows already recorded locally. */
  localIncrementCount?: number | null;
}): IncrementEligibility {
  const order = args.order;
  if (!order?.id) {
    return {
      eligible: false,
      reason: "missing_order",
      providerConfirmedTotalPence: 0,
      initialAuthorisedPence: 0,
      maxTargetTotalPence: 0,
      incrementCount: 0,
      paymentMethodType: null,
    };
  }

  const state = String(order.state ?? "").toUpperCase();
  const providerTotal = revolutProviderAuthorisedTotalPence(order);
  const initial = Math.max(
    0,
    Math.round(Number(args.initialAuthorisedPence ?? providerTotal)),
  );
  const maxTarget = initial * REVOLUT_MAX_INCREMENT_MULTIPLIER;
  const incrementCount = Math.max(
    countProviderIncrements(order),
    Math.round(Number(args.localIncrementCount ?? 0)),
  );
  const method = paymentMethodTypeFromOrder(order);
  const target = Math.round(Number(args.targetTotalAuthorisedPence));

  const base = {
    providerConfirmedTotalPence: providerTotal,
    initialAuthorisedPence: initial,
    maxTargetTotalPence: maxTarget,
    incrementCount,
    paymentMethodType: method,
  };

  if (state === "COMPLETED" || state === "CAPTURED") {
    return { eligible: false, reason: "already_captured", ...base };
  }
  if (state === "CANCELLED" || state === "CANCELED" || state === "FAILED" || state === "REFUNDED") {
    return { eligible: false, reason: "cancelled_or_failed", ...base };
  }
  if (state !== "AUTHORISED" && state !== "AUTHORIZED") {
    if (state === "PROCESSING" || state === "PENDING" || !state) {
      return { eligible: false, reason: "unknown_state", ...base };
    }
    return { eligible: false, reason: "not_authorised", ...base };
  }

  const captureMode = String(order.capture_mode ?? "").toLowerCase();
  if (captureMode && captureMode !== "manual") {
    return { eligible: false, reason: "wrong_capture_mode", ...base };
  }

  const authType = String(order.authorisation_type ?? "").toLowerCase();
  // Missing authorisation_type on older orders → unsupported for increment (fail closed).
  if (authType !== "pre_authorisation" && authType !== "pre_authorization") {
    return { eligible: false, reason: "wrong_authorisation_type", ...base };
  }

  const methodOk = isRevolutIncrementEligiblePaymentMethod(method);
  if (methodOk === false) {
    return { eligible: false, reason: "unsupported_payment_method", ...base };
  }
  if (methodOk === "unknown") {
    // Fail closed when provider does not classify the method.
    return { eligible: false, reason: "unsupported_payment_method", ...base };
  }

  if (!Number.isFinite(target) || target <= providerTotal) {
    return { eligible: false, reason: "target_not_above_current", ...base };
  }

  if (incrementCount >= REVOLUT_MAX_INCREMENTS_PER_ORDER) {
    return { eligible: false, reason: "limit_count_exceeded", ...base };
  }

  // Sum of increases ≤ 5× initial → total authorised ≤ initial + 5×initial = 6×?
  // Revolut docs: "Sum of all increment amounts cannot exceed 5x the initial amount"
  // and "initial amount £100 allows up to £500 in total increments" → max total = 5× initial.
  if (target > maxTarget) {
    return { eligible: false, reason: "limit_amount_exceeded", ...base };
  }

  return { eligible: true, reason: "eligible", ...base };
}

export function planSameOrderIncrement(args: {
  requiredTotalPence: number;
  providerConfirmedTotalPence: number;
}): { kind: "not_required" } | { kind: "increment"; targetTotalPence: number; deltaPence: number } {
  const required = Math.max(0, Math.round(Number(args.requiredTotalPence)));
  const have = Math.max(0, Math.round(Number(args.providerConfirmedTotalPence)));
  if (required <= have) return { kind: "not_required" };
  return {
    kind: "increment",
    targetTotalPence: required,
    deltaPence: required - have,
  };
}
