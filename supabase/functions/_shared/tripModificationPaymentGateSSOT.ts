/**
 * Trip-modification payment gate SSOT (MK-260915-002).
 *
 * Fare-increasing modifications must not mutate trip destination/stops/fare
 * until provider read-back proves authorised TOTAL covers the new payable.
 * Processing / pending / unknown never unlock apply.
 *
 * Pure helpers — no wallet, commission, payout, invoice, or capture writes.
 */

import {
  revolutProviderAuthorisedTotalPence,
  type RevolutOrder,
} from "./revolutOrders.ts";
import { findBankDeclineReason } from "./revolutCustomerError.ts";

export type ModificationPaymentGateDecision =
  | {
    phase: "PROVIDER_CONFIRMED";
    mayApply: true;
    paymentStatus: "confirmed";
    requestStatus: "payment_confirmed";
    authorisedTotalPence: number;
  }
  | {
    phase: "PAYMENT_PENDING";
    mayApply: false;
    paymentStatus: "pending";
    requestStatus: "payment_pending";
    authorisedTotalPence: number;
    reason:
      | "processing"
      | "unknown"
      | "timeout"
      | "network"
      | "customer_action_required";
  }
  | {
    phase: "PAYMENT_FAILED";
    mayApply: false;
    paymentStatus: "failed";
    requestStatus: "payment_failed";
    authorisedTotalPence: number;
    reason: "declined" | "insufficient" | "amount_mismatch" | "failed";
  };

/**
 * Modification-apply coverage — stricter than completion-capture MK-260815-020.
 * Processing/pending/initiated increment new_amount must NOT unlock trip mutation.
 * Only issuer-authorised totals (via revolutProviderAuthorisedTotalPence) unlock apply.
 */
export function classifyModificationApplyCoverage(
  order: RevolutOrder | null | undefined,
  targetTotalPence: number,
): { class: "confirmed" | "processing" | "insufficient" | "unknown"; authorisedTotalPence: number } {
  const target = Math.round(Number(targetTotalPence));
  if (!order) return { class: "unknown", authorisedTotalPence: 0 };

  const authorisedTotalPence = revolutProviderAuthorisedTotalPence(order);
  const increments = Array.isArray(order.incremental_authorisations)
    ? order.incremental_authorisations
    : [];
  const unsettled = increments.some((increment) => {
    const s = String(increment?.state ?? "").toLowerCase();
    return s === "processing" || s === "pending"
      || s === "initiated" || s === "requested" || s === "created"
      || s === "unknown";
  });
  const declined = increments.some((increment) => {
    const s = String(increment?.state ?? "").toLowerCase();
    return s === "declined" || s === "failed";
  });

  if (authorisedTotalPence >= target) {
    return { class: "confirmed", authorisedTotalPence };
  }

  if (unsettled) {
    return { class: "processing", authorisedTotalPence };
  }

  if (declined || authorisedTotalPence > 0) {
    return { class: "insufficient", authorisedTotalPence };
  }

  const state = String(order.state ?? "").toUpperCase();
  if (state === "PROCESSING" || state === "PENDING") {
    return { class: "processing", authorisedTotalPence };
  }

  return { class: "unknown", authorisedTotalPence };
}

/**
 * Provider-authoritative coverage for a fare-increasing modification.
 * Original order AUTHORISED alone is never enough when target exceeds current
 * authorised total — the increment itself must be settled (authorised state).
 */
export function decideModificationIncrementCoverage(args: {
  order: RevolutOrder | null | undefined;
  requiredPayablePence: number;
}): ModificationPaymentGateDecision {
  const required = Math.max(0, Math.round(Number(args.requiredPayablePence)));
  const coverage = classifyModificationApplyCoverage(args.order, required);

  if (coverage.class === "confirmed" && coverage.authorisedTotalPence >= required) {
    return {
      phase: "PROVIDER_CONFIRMED",
      mayApply: true,
      paymentStatus: "confirmed",
      requestStatus: "payment_confirmed",
      authorisedTotalPence: coverage.authorisedTotalPence,
    };
  }

  if (coverage.class === "processing") {
    return {
      phase: "PAYMENT_PENDING",
      mayApply: false,
      paymentStatus: "pending",
      requestStatus: "payment_pending",
      authorisedTotalPence: coverage.authorisedTotalPence,
      reason: "processing",
    };
  }

  if (coverage.class === "unknown") {
    return {
      phase: "PAYMENT_PENDING",
      mayApply: false,
      paymentStatus: "pending",
      requestStatus: "payment_pending",
      authorisedTotalPence: coverage.authorisedTotalPence,
      reason: "unknown",
    };
  }

  return {
    phase: "PAYMENT_FAILED",
    mayApply: false,
    paymentStatus: "failed",
    requestStatus: "payment_failed",
    authorisedTotalPence: coverage.authorisedTotalPence,
    reason: coverage.authorisedTotalPence > 0 && coverage.authorisedTotalPence < required
      ? "amount_mismatch"
      : "declined",
  };
}

/**
 * Definitive provider decline / below-target coverage.
 * Must be checked BEFORE reconciliation-pending so HTTP 409 decline bodies
 * never become payment_unknown / payment_pending (MK-260923-002).
 */
export function isDefinitivePreauthDecline(args: {
  paymentCoverageStatus?: string | null;
  errorCode?: string | null;
  warning?: string | null;
}): boolean {
  const coverage = String(args.paymentCoverageStatus ?? "").toLowerCase();
  const code = String(args.errorCode ?? "").toUpperCase();
  const warning = String(args.warning ?? "").toLowerCase();

  if (
    code === "AUTHORISED_TOTAL_BELOW_TARGET"
    || code.includes("AUTHORISED_TOTAL_BELOW")
    || code.includes("BELOW_TARGET")
    || code === "ADDITIONAL_AUTHORISATION_DECLINED"
    || code.includes("PAYMENT_DECLINED")
    || code.endsWith("_DECLINED")
    || code === "DECLINED"
  ) {
    return true;
  }
  if (
    coverage === "authorization_insufficient"
    || coverage.includes("authorisation_declined")
    || coverage.includes("authorization_declined")
    || coverage.includes("under_authorised")
    || coverage.includes("under_authorized")
  ) {
    return true;
  }
  if (
    warning.includes("authorised total remains below")
    || warning.includes("authorized total remains below")
    || warning.includes("declined")
  ) {
    return true;
  }
  return false;
}

/** Map update-preauth / executeSameOrderIncrement outcomes onto the gate. */
export function decideFromPreauthInvokeResult(args: {
  success: boolean;
  skipped?: boolean;
  paymentCoverageStatus?: string | null;
  authorisedAmountPence?: number | null;
  requiredPayablePence: number;
  errorCode?: string | null;
  warning?: string | null;
}): ModificationPaymentGateDecision {
  const required = Math.max(0, Math.round(Number(args.requiredPayablePence)));
  const authorised = Math.max(0, Math.round(Number(args.authorisedAmountPence ?? 0)));
  const coverage = String(args.paymentCoverageStatus ?? "").toLowerCase();
  const code = String(args.errorCode ?? "").toUpperCase();
  const warning = String(args.warning ?? "").toLowerCase();

  if (args.skipped === true && args.success) {
    // Never invent coverage. Skip mayApply only when hold already covers revised payable.
    // Positive-delta PLATFORM paths must not treat skipped as paid (MK-260916-030).
    if (authorised >= required && required > 0) {
      return {
        phase: "PROVIDER_CONFIRMED",
        mayApply: true,
        paymentStatus: "confirmed",
        requestStatus: "payment_confirmed",
        authorisedTotalPence: authorised,
      };
    }
    return {
      phase: "PAYMENT_FAILED",
      mayApply: false,
      paymentStatus: "failed",
      requestStatus: "payment_failed",
      authorisedTotalPence: authorised,
      reason: "amount_mismatch",
    };
  }

  // Revolut increment state `failed` is a technical/provider failure, not a decline.
  // Persist failures are internal (revolut-incremental-auth lock) — never a decline.
  if (
    code === "PROVIDER_INCREMENT_FAILED"
    || coverage === "authorization_provider_failed"
    || code === "INCREMENT_CONFIRM_PERSIST_FAILED"
    || code === "PERSIST_FAILED"
    || coverage === "authorization_persist_failed"
  ) {
    return {
      phase: "PAYMENT_FAILED",
      mayApply: false,
      paymentStatus: "failed",
      requestStatus: "payment_failed",
      authorisedTotalPence: authorised,
      reason: "failed",
    };
  }

  // MK-261105-002: issuer challenge / CUSTOMER_ACTION_REQUIRED is pending — never
  // a bank decline and never unlocks apply. Mid-trip challenge UI is unsupported;
  // callers leave the trip unchanged with clear copy.
  if (
    code === "CUSTOMER_ACTION_REQUIRED"
    || coverage === "authorization_action_required"
    || coverage.includes("action_required")
  ) {
    return {
      phase: "PAYMENT_PENDING",
      mayApply: false,
      paymentStatus: "pending",
      requestStatus: "payment_pending",
      authorisedTotalPence: authorised,
      reason: "customer_action_required",
    };
  }

  // DECLINED ≠ UNKNOWN. Definitive decline/below-target always fails closed.
  if (
    isDefinitivePreauthDecline({
      paymentCoverageStatus: args.paymentCoverageStatus,
      errorCode: args.errorCode,
      warning: args.warning,
    })
  ) {
    const insufficientFunds =
      code === "INSUFFICIENT_FUNDS"
      || code.endsWith("_INSUFFICIENT_FUNDS")
      || warning.includes("insufficient funds");
    return {
      phase: "PAYMENT_FAILED",
      mayApply: false,
      paymentStatus: "failed",
      requestStatus: "payment_failed",
      authorisedTotalPence: authorised,
      // Definitive issuer/provider decline → payment_declined (not amount_mismatch).
      reason: insufficientFunds ? "insufficient" : "declined",
    };
  }

  const pendingHint =
    coverage.includes("reconciliation_pending")
    || coverage.includes("processing")
    || code === "PROCESSING"
    || code === "AUTHORISATION_RECONCILIATION_PENDING"
    || warning.includes("processing")
    || warning.includes("ambiguous");

  if (pendingHint) {
    return {
      phase: "PAYMENT_PENDING",
      mayApply: false,
      paymentStatus: "pending",
      requestStatus: "payment_pending",
      authorisedTotalPence: authorised,
      reason: code.includes("TIMEOUT") || warning.includes("timeout")
        ? "timeout"
        : code.includes("NETWORK") || warning.includes("network")
        ? "network"
        : coverage.includes("processing") || code === "PROCESSING"
        ? "processing"
        : "unknown",
    };
  }

  if (
    args.success === true
    && authorised >= required
    && !coverage.includes("insufficient")
    && !coverage.includes("under_")
  ) {
    return {
      phase: "PROVIDER_CONFIRMED",
      mayApply: true,
      paymentStatus: "confirmed",
      requestStatus: "payment_confirmed",
      authorisedTotalPence: authorised,
    };
  }

  if (
    code.includes("INSUFFICIENT")
    || warning.includes("insufficient")
    || coverage.includes("insufficient")
  ) {
    return {
      phase: "PAYMENT_FAILED",
      mayApply: false,
      paymentStatus: "failed",
      requestStatus: "payment_failed",
      authorisedTotalPence: authorised,
      reason: "insufficient",
    };
  }

  if (authorised > 0 && authorised < required) {
    return {
      phase: "PAYMENT_FAILED",
      mayApply: false,
      paymentStatus: "failed",
      requestStatus: "payment_failed",
      authorisedTotalPence: authorised,
      reason: "amount_mismatch",
    };
  }

  return {
    phase: "PAYMENT_FAILED",
    mayApply: false,
    paymentStatus: "failed",
    requestStatus: "payment_failed",
    authorisedTotalPence: authorised,
    reason: "declined",
  };
}

export type ModificationPaymentFailureKind = "bank_declined" | "not_authorised" | "technical";

/**
 * Customer-facing class of a failed fare-increase authorisation.
 * Bank decline only with an issuer/card reason from Revolut (or an explicit
 * issuer code); technical/internal failures and bare "declined"/below-target
 * outcomes never get bank wording (unified-bank-decline-copy lock).
 */
export function classifyModificationPaymentFailure(args: {
  gate: ModificationPaymentGateDecision;
  declineReason?: string | null;
  errorCode?: string | null;
}): { kind: ModificationPaymentFailureKind; bankDeclineReason: string | null } {
  if (args.gate.phase !== "PAYMENT_FAILED" || args.gate.reason === "failed") {
    return { kind: "technical", bankDeclineReason: null };
  }
  const bankDeclineReason = findBankDeclineReason(args.declineReason, args.errorCode);
  if (bankDeclineReason) return { kind: "bank_declined", bankDeclineReason };
  return { kind: "not_authorised", bankDeclineReason: null };
}

/** Duplicate confirm of an already-applied request — return without re-adding delta. */
export function isAlreadyAppliedModification(status: string | null | undefined): boolean {
  const s = String(status ?? "").toLowerCase();
  return s === "applied" || s === "approved";
}

/** True when an invoke error body carries payment classification fields (not HTTP alone). */
export function invokeErrorBodyHasPaymentStructure(
  body: Record<string, unknown> | null | undefined,
): boolean {
  if (!body) return false;
  if (body.requires_revolut_checkout === true) return true;
  if (typeof body.error_code === "string" && body.error_code.trim()) return true;
  if (
    typeof body.payment_coverage_status === "string"
    && body.payment_coverage_status.trim()
  ) {
    return true;
  }
  if (typeof body.decline_reason === "string" && body.decline_reason.trim()) {
    return true;
  }
  return false;
}

/**
 * Authoritative PSA statuses that must never leave a modification gate as
 * PAYMENT_PENDING (Bug #28 / MK-261115-014).
 * HTTP status alone is not listed — only provider-persisted authorisation rows.
 */
export const TERMINAL_ADDITIONAL_AUTHORISATION_STATUSES = [
  "ADDITIONAL_AUTHORISATION_DECLINED",
  "ADDITIONAL_AUTHORISATION_FAILED_TERMINAL",
  "ADDITIONAL_AUTHORISATION_UNSUPPORTED",
] as const;

export type TerminalAdditionalAuthorisationStatus =
  (typeof TERMINAL_ADDITIONAL_AUTHORISATION_STATUSES)[number];

export function isTerminalAdditionalAuthorisationStatus(
  status: string | null | undefined,
): status is TerminalAdditionalAuthorisationStatus {
  const s = String(status ?? "").toUpperCase();
  return (TERMINAL_ADDITIONAL_AUTHORISATION_STATUSES as readonly string[]).includes(s);
}

/**
 * Map a terminal PSA row onto the modification payment gate.
 * FAILED_TERMINAL / UNSUPPORTED → technical `failed` (never invent bank decline).
 * DECLINED → `declined` (bank wording only when issuer reason is classified later).
 */
export function gateFromTerminalAuthorisationStatus(args: {
  status: string | null | undefined;
  authorisedTotalPence: number;
}): ModificationPaymentGateDecision | null {
  const s = String(args.status ?? "").toUpperCase();
  if (!isTerminalAdditionalAuthorisationStatus(s)) return null;
  const authorisedTotalPence = Math.max(0, Math.round(Number(args.authorisedTotalPence) || 0));
  if (s === "ADDITIONAL_AUTHORISATION_DECLINED") {
    return {
      phase: "PAYMENT_FAILED",
      mayApply: false,
      paymentStatus: "failed",
      requestStatus: "payment_failed",
      authorisedTotalPence,
      reason: "declined",
    };
  }
  return {
    phase: "PAYMENT_FAILED",
    mayApply: false,
    paymentStatus: "failed",
    requestStatus: "payment_failed",
    authorisedTotalPence,
    reason: "failed",
  };
}

/**
 * Stale/out-of-order protection: a pending outcome must never overwrite a newer
 * authoritative terminal TCR payment state (failed / applied / expired).
 */
export function canPendingOverwriteModificationRequestStatus(
  currentStatus: string | null | undefined,
): boolean {
  const s = String(currentStatus ?? "").toLowerCase();
  if (!s) return true;
  if (
    s === "payment_failed"
    || s === "expired"
    || s === "applied"
    || s === "approved"
    || s === "declined"
    || s === "rejected"
    || s === "cancelled"
    || s === "canceled"
    || s === "superseded"
  ) {
    return false;
  }
  return (
    s === "payment_required"
    || s === "payment_pending"
    || s === "payment_confirmed"
  );
}

/** PLATFORM_COLLECTED isolation — modification auth must not touch these write kinds. */
export const MODIFICATION_AUTH_FORBIDDEN_MUTATIONS = [
  "wallet_ledger_write",
  "commission_wallet_write",
  "payout_ledger_write",
  "invoice_mutation",
  "capture_mutation",
] as const;
