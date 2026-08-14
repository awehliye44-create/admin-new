/**
 * Slice 4 — Revolut Business driver-payout payment transport SSOT.
 * Validation + dry-run + idempotency records only.
 * Never calls Revolut POST /pay while REVOLUT_PAYMENT_TRANSPORT_ENABLED=false
 * and LIVE_PAYOUT_EXECUTION_ENABLED=false.
 */

import {
  REVOLUT_PAY_REQUEST_ID_MAX_LEN,
  canonicalIdempotencyKey,
  canonicalProviderRequestId,
} from "../../../shared/driverPayoutSubmissionSSOT.ts";

/** @see shared/driverPayoutSubmissionSSOT — oc-dp:{uuidhex} ≤40 for Revolut /pay */
export {
  REVOLUT_PAY_REQUEST_ID_MAX_LEN,
  canonicalIdempotencyKey,
  canonicalProviderRequestId,
};

export const REVOLUT_BUSINESS_PAY_ENDPOINT = "POST https://b2b.revolut.com/api/1.0/pay";
export const REVOLUT_BUSINESS_PAY_PATH = "/pay";
export const REVOLUT_BUSINESS_PAY_OAUTH_SCOPE = "PAY";

/** Official docs: request_id provides idempotency (UUID recommended). No Idempotency-Key header required. */
export const REVOLUT_PAY_IDEMPOTENCY_FIELD = "request_id";

/** Transaction states from Revolut Business bank-transfer docs + Create a transfer API. */
export const REVOLUT_PAY_PROVIDER_STATES = [
  "pending",
  "completed",
  "failed",
  "reverted",
  "declined",
] as const;

export const PAYMENT_EXECUTION_DISABLED = "PAYMENT_EXECUTION_DISABLED";
export const IDEMPOTENCY_CONFLICT = "IDEMPOTENCY_CONFLICT";

export const PAYMENT_EXECUTION_STATUS = {
  DRAFT: "DRAFT",
  VALIDATED: "VALIDATED",
  BLOCKED: "BLOCKED",
  READY: "READY",
  SUBMITTING: "SUBMITTING",
  SUBMITTED: "SUBMITTED",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  DECLINED: "DECLINED",
  CANCELLED: "CANCELLED",
  REVERTED: "REVERTED",
  /** Slice 7: provider timeout / ambiguous outcome — no blind retry, no release. */
  UNKNOWN: "UNKNOWN",
} as const;

export type PaymentExecutionStatus =
  (typeof PAYMENT_EXECUTION_STATUS)[keyof typeof PAYMENT_EXECUTION_STATUS];

/** Slice 4 may only persist these. */
export const SLICE4_ALLOWED_STATUSES = new Set<PaymentExecutionStatus>([
  PAYMENT_EXECUTION_STATUS.VALIDATED,
  PAYMENT_EXECUTION_STATUS.BLOCKED,
]);

export const APPROVED_PAYMENT_FIELDS = [
  "payout_item_id",
  "driver_id",
  "payout_destination_id",
  "source_account_id",
  "provider_counterparty_id",
  "provider_recipient_account_id",
  "amount_pence",
  "currency",
  "payment_reference",
  "provider_request_id",
  "idempotency_key",
] as const;

export type ApprovedPaymentField = (typeof APPROVED_PAYMENT_FIELDS)[number];

export type ApprovedDriverPayoutPaymentInput = {
  payout_item_id: string;
  driver_id: string;
  payout_destination_id: string;
  source_account_id: string;
  provider_counterparty_id: string;
  provider_recipient_account_id: string;
  amount_pence: number;
  currency: string;
  payment_reference?: string | null;
  provider_request_id?: string | null;
  idempotency_key?: string | null;
};

export type DestinationLinkageSnapshot = {
  id: string;
  driver_id: string;
  currency_code?: string | null;
  verification_status?: string | null;
  provider_link_status?: string | null;
  provider_counterparty_id?: string | null;
  provider_recipient_account_id?: string | null;
  is_active?: boolean | null;
  archived_at?: string | null;
};

export type ExistingPaymentIntent = {
  id: string;
  payout_item_id: string;
  driver_id: string;
  payout_destination_id: string;
  provider_request_id: string;
  idempotency_key: string;
  source_account_id: string;
  provider_counterparty_id: string;
  provider_recipient_account_id: string;
  amount_pence: number;
  currency: string;
  payment_reference?: string | null;
  execution_status: string;
  provider_payment_id?: string | null;
  request_fingerprint: string;
};

export const PAYMENT_VALIDATION_ERROR = {
  EXTRA_FIELDS: "EXTRA_FIELDS_REJECTED",
  MISSING_FIELD: "MISSING_FIELD",
  ZERO_AMOUNT: "ZERO_AMOUNT",
  NEGATIVE_AMOUNT: "NEGATIVE_AMOUNT",
  MISSING_SOURCE_ACCOUNT: "MISSING_SOURCE_ACCOUNT",
  MISSING_COUNTERPARTY: "MISSING_COUNTERPARTY",
  MISSING_RECIPIENT_ACCOUNT: "MISSING_RECIPIENT_ACCOUNT",
  DESTINATION_MISMATCH: "DESTINATION_MISMATCH",
  CURRENCY_MISMATCH: "CURRENCY_MISMATCH",
  CURRENCY_NOT_GBP: "CURRENCY_NOT_GBP",
  UNVERIFIED_DESTINATION: "UNVERIFIED_DESTINATION",
  DESTINATION_NOT_LINKED: "DESTINATION_NOT_LINKED",
  IDEMPOTENCY_KEY_MISMATCH: "IDEMPOTENCY_KEY_MISMATCH",
  PROVIDER_REQUEST_ID_MISMATCH: "PROVIDER_REQUEST_ID_MISMATCH",
  IDEMPOTENCY_CONFLICT: IDEMPOTENCY_CONFLICT,
} as const;

export type PaymentValidationErrorCode =
  (typeof PAYMENT_VALIDATION_ERROR)[keyof typeof PAYMENT_VALIDATION_ERROR];

export function isLivePayoutExecutionEnabled(
  env: { get(key: string): string | undefined } = Deno.env,
): boolean {
  return (env.get("LIVE_PAYOUT_EXECUTION_ENABLED") ?? "false").trim().toLowerCase() === "true";
}

export function isRevolutPaymentTransportEnabled(
  env: { get(key: string): string | undefined } = Deno.env,
): boolean {
  return (env.get("REVOLUT_PAYMENT_TRANSPORT_ENABLED") ?? "false").trim().toLowerCase() === "true";
}

/** True only when both live + transport gates are on — Slice 4 must keep this false. */
export function mayCallRevolutPayEndpoint(
  env: { get(key: string): string | undefined } = Deno.env,
): boolean {
  return isLivePayoutExecutionEnabled(env) && isRevolutPaymentTransportEnabled(env);
}

export function paymentRequestFingerprint(input: {
  amount_pence: number;
  currency: string;
  source_account_id: string;
  provider_recipient_account_id: string;
  provider_counterparty_id: string;
  payout_destination_id: string;
}): string {
  const parts = [
    String(input.amount_pence),
    input.currency.trim().toUpperCase(),
    input.source_account_id.trim(),
    input.provider_counterparty_id.trim(),
    input.provider_recipient_account_id.trim(),
    input.payout_destination_id.trim(),
  ];
  return parts.join("|");
}

export function amountPenceToRevolutMajorUnits(amountPence: number): number {
  return Math.round(amountPence) / 100;
}

/** Dry-run Revolut POST /pay body — never sent in Slice 4. */
export function buildRevolutPayDryRunPayload(input: {
  provider_request_id: string;
  source_account_id: string;
  provider_counterparty_id: string;
  provider_recipient_account_id: string;
  amount_pence: number;
  currency: string;
  payment_reference?: string | null;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    request_id: input.provider_request_id,
    account_id: input.source_account_id,
    receiver: {
      counterparty_id: input.provider_counterparty_id,
      account_id: input.provider_recipient_account_id,
    },
    amount: amountPenceToRevolutMajorUnits(input.amount_pence),
    currency: input.currency.trim().toUpperCase(),
  };
  if (input.payment_reference) {
    payload.reference = String(input.payment_reference).slice(0, 100);
  }
  return payload;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function destinationIsVerifiedForPayment(dest: DestinationLinkageSnapshot): boolean {
  const link = String(dest.provider_link_status ?? "").toUpperCase();
  const ver = String(dest.verification_status ?? "").toUpperCase();
  if (link === "PROVIDER_VERIFIED") return true;
  if (ver === "PROVIDER_VERIFIED" || ver === "MANUAL_VERIFIED") {
    // Require both provider IDs even if legacy status is manual-only.
    return Boolean(dest.provider_counterparty_id && dest.provider_recipient_account_id);
  }
  return false;
}

export function rejectUnknownPaymentFields(
  body: Record<string, unknown>,
): { ok: true } | { ok: false; code: PaymentValidationErrorCode; extra: string[] } {
  const allowed = new Set<string>(APPROVED_PAYMENT_FIELDS);
  // Optional dry-run / meta flags that never reach Revolut
  allowed.add("dry_run");
  allowed.add("validation_only");
  const extra = Object.keys(body).filter((k) => !allowed.has(k));
  if (extra.length > 0) {
    return { ok: false, code: PAYMENT_VALIDATION_ERROR.EXTRA_FIELDS, extra };
  }
  return { ok: true };
}

export type ValidatePaymentResult =
  | {
    ok: true;
    normalized: ApprovedDriverPayoutPaymentInput & {
      currency: "GBP";
      provider_request_id: string;
      idempotency_key: string;
      request_fingerprint: string;
      dry_run_payload: Record<string, unknown>;
    };
  }
  | {
    ok: false;
    code: PaymentValidationErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };

/**
 * Field + destination linkage validation (no Revolut call, no wallet mutation).
 */
export function validateApprovedDriverPayoutPayment(args: {
  body: Record<string, unknown>;
  destination: DestinationLinkageSnapshot | null;
}): ValidatePaymentResult {
  const fieldsCheck = rejectUnknownPaymentFields(args.body);
  if (!fieldsCheck.ok) {
    return {
      ok: false,
      code: fieldsCheck.code,
      message: `Unknown fields rejected: ${fieldsCheck.extra.join(",")}`,
      details: { extra: fieldsCheck.extra },
    };
  }

  const b = args.body;
  const requiredStringKeys: ApprovedPaymentField[] = [
    "payout_item_id",
    "driver_id",
    "payout_destination_id",
    "source_account_id",
    "provider_counterparty_id",
    "provider_recipient_account_id",
  ];
  for (const key of requiredStringKeys) {
    if (!isNonEmptyString(b[key])) {
      const codeMap: Record<string, PaymentValidationErrorCode> = {
        source_account_id: PAYMENT_VALIDATION_ERROR.MISSING_SOURCE_ACCOUNT,
        provider_counterparty_id: PAYMENT_VALIDATION_ERROR.MISSING_COUNTERPARTY,
        provider_recipient_account_id: PAYMENT_VALIDATION_ERROR.MISSING_RECIPIENT_ACCOUNT,
      };
      return {
        ok: false,
        code: codeMap[key] ?? PAYMENT_VALIDATION_ERROR.MISSING_FIELD,
        message: `${key} is required`,
      };
    }
  }

  const amountRaw = b.amount_pence;
  const amount = typeof amountRaw === "number" ? amountRaw : Number(amountRaw);
  if (!Number.isFinite(amount) || !Number.isInteger(amount)) {
    return { ok: false, code: PAYMENT_VALIDATION_ERROR.MISSING_FIELD, message: "amount_pence must be an integer" };
  }
  if (amount === 0) {
    return { ok: false, code: PAYMENT_VALIDATION_ERROR.ZERO_AMOUNT, message: "amount_pence must be > 0" };
  }
  if (amount < 0) {
    return { ok: false, code: PAYMENT_VALIDATION_ERROR.NEGATIVE_AMOUNT, message: "amount_pence must be > 0" };
  }

  const currency = String(b.currency ?? "GBP").trim().toUpperCase();
  if (currency !== "GBP") {
    return { ok: false, code: PAYMENT_VALIDATION_ERROR.CURRENCY_NOT_GBP, message: "GBP only" };
  }

  const payoutItemId = String(b.payout_item_id).trim();
  const driverId = String(b.driver_id).trim();
  const destinationId = String(b.payout_destination_id).trim();
  const sourceAccountId = String(b.source_account_id).trim();
  const counterpartyId = String(b.provider_counterparty_id).trim();
  const recipientAccountId = String(b.provider_recipient_account_id).trim();
  const paymentReference = isNonEmptyString(b.payment_reference)
    ? String(b.payment_reference).trim()
    : null;

  const expectedRequestId = canonicalProviderRequestId(payoutItemId);
  const expectedIdem = canonicalIdempotencyKey(payoutItemId);
  const providerRequestId = isNonEmptyString(b.provider_request_id)
    ? String(b.provider_request_id).trim()
    : expectedRequestId;
  const idempotencyKey = isNonEmptyString(b.idempotency_key)
    ? String(b.idempotency_key).trim()
    : expectedIdem;

  if (providerRequestId !== expectedRequestId) {
    return {
      ok: false,
      code: PAYMENT_VALIDATION_ERROR.PROVIDER_REQUEST_ID_MISMATCH,
      message: "provider_request_id must equal oc-dp:{payout_item_uuid_hex} (≤40)",
    };
  }
  if (idempotencyKey !== expectedIdem) {
    return {
      ok: false,
      code: PAYMENT_VALIDATION_ERROR.IDEMPOTENCY_KEY_MISMATCH,
      message: "idempotency_key must equal oc-dp:{payout_item_uuid_hex} (≤40)",
    };
  }

  const dest = args.destination;
  if (!dest) {
    return {
      ok: false,
      code: PAYMENT_VALIDATION_ERROR.DESTINATION_MISMATCH,
      message: "payout destination not found",
    };
  }
  if (dest.id !== destinationId || dest.driver_id !== driverId) {
    return {
      ok: false,
      code: PAYMENT_VALIDATION_ERROR.DESTINATION_MISMATCH,
      message: "driver_id / payout_destination_id mismatch",
    };
  }
  if (dest.is_active === false || dest.archived_at) {
    return {
      ok: false,
      code: PAYMENT_VALIDATION_ERROR.UNVERIFIED_DESTINATION,
      message: "destination inactive or archived",
    };
  }
  if (!destinationIsVerifiedForPayment(dest)) {
    return {
      ok: false,
      code: PAYMENT_VALIDATION_ERROR.UNVERIFIED_DESTINATION,
      message: "destination must be PROVIDER_VERIFIED with counterparty + recipient",
    };
  }
  if (
    String(dest.provider_counterparty_id ?? "") !== counterpartyId
    || String(dest.provider_recipient_account_id ?? "") !== recipientAccountId
  ) {
    return {
      ok: false,
      code: PAYMENT_VALIDATION_ERROR.DESTINATION_MISMATCH,
      message: "provider counterparty/recipient does not match linked destination",
    };
  }
  if (!dest.provider_counterparty_id || !dest.provider_recipient_account_id) {
    return {
      ok: false,
      code: PAYMENT_VALIDATION_ERROR.DESTINATION_NOT_LINKED,
      message: "destination missing provider linkage IDs",
    };
  }
  const destCurrency = String(dest.currency_code ?? "GBP").trim().toUpperCase();
  if (destCurrency && destCurrency !== "GBP") {
    return {
      ok: false,
      code: PAYMENT_VALIDATION_ERROR.CURRENCY_MISMATCH,
      message: "destination currency is not GBP",
    };
  }
  if (destCurrency && destCurrency !== currency) {
    return {
      ok: false,
      code: PAYMENT_VALIDATION_ERROR.CURRENCY_MISMATCH,
      message: "currency does not match destination",
    };
  }

  const fingerprint = paymentRequestFingerprint({
    amount_pence: amount,
    currency,
    source_account_id: sourceAccountId,
    provider_recipient_account_id: recipientAccountId,
    provider_counterparty_id: counterpartyId,
    payout_destination_id: destinationId,
  });

  const dryRunPayload = buildRevolutPayDryRunPayload({
    provider_request_id: providerRequestId,
    source_account_id: sourceAccountId,
    provider_counterparty_id: counterpartyId,
    provider_recipient_account_id: recipientAccountId,
    amount_pence: amount,
    currency,
    payment_reference: paymentReference,
  });

  return {
    ok: true,
    normalized: {
      payout_item_id: payoutItemId,
      driver_id: driverId,
      payout_destination_id: destinationId,
      source_account_id: sourceAccountId,
      provider_counterparty_id: counterpartyId,
      provider_recipient_account_id: recipientAccountId,
      amount_pence: amount,
      currency: "GBP",
      payment_reference: paymentReference,
      provider_request_id: providerRequestId,
      idempotency_key: idempotencyKey,
      request_fingerprint: fingerprint,
      dry_run_payload: dryRunPayload,
    },
  };
}

/**
 * Idempotent upsert decision given existing rows looked up by idempotency_key and/or payout_item_id.
 */
export function resolvePaymentIntentIdempotency(args: {
  normalized: {
    payout_item_id: string;
    idempotency_key: string;
    provider_request_id: string;
    request_fingerprint: string;
    amount_pence: number;
    currency: string;
    source_account_id: string;
    provider_recipient_account_id: string;
  };
  existingByIdempotencyKey: ExistingPaymentIntent | null;
  existingActiveByPayoutItemId: ExistingPaymentIntent | null;
}):
  | { action: "reuse"; intent: ExistingPaymentIntent }
  | { action: "create" }
  | { action: "conflict"; code: typeof IDEMPOTENCY_CONFLICT; message: string; intent?: ExistingPaymentIntent } {
  const n = args.normalized;
  const byKey = args.existingByIdempotencyKey;
  if (byKey) {
    const sameFingerprint = byKey.request_fingerprint === n.request_fingerprint
      || (
        byKey.amount_pence === n.amount_pence
        && byKey.currency.toUpperCase() === n.currency.toUpperCase()
        && byKey.source_account_id === n.source_account_id
        && byKey.provider_recipient_account_id === n.provider_recipient_account_id
      );
    if (!sameFingerprint) {
      return {
        action: "conflict",
        code: IDEMPOTENCY_CONFLICT,
        message: "same idempotency_key with different amount/currency/source/recipient",
        intent: byKey,
      };
    }
    return { action: "reuse", intent: byKey };
  }

  const byItem = args.existingActiveByPayoutItemId;
  if (byItem) {
    const same = byItem.request_fingerprint === n.request_fingerprint
      || (
        byItem.amount_pence === n.amount_pence
        && byItem.currency.toUpperCase() === n.currency.toUpperCase()
        && byItem.source_account_id === n.source_account_id
        && byItem.provider_recipient_account_id === n.provider_recipient_account_id
        && byItem.idempotency_key === n.idempotency_key
      );
    if (!same) {
      return {
        action: "conflict",
        code: IDEMPOTENCY_CONFLICT,
        message: "active payment intent exists for payout_item_id with different parameters",
        intent: byItem,
      };
    }
    return { action: "reuse", intent: byItem };
  }

  return { action: "create" };
}

/**
 * Slice 4 terminal status after successful validation when provider call is disabled.
 * Always VALIDATED (or BLOCKED if explicitly gated by env/live mismatch).
 */
export function slice4IntentStatusAfterValidation(args?: {
  forceBlocked?: boolean;
  blockReason?: string | null;
}): { status: "VALIDATED" | "BLOCKED"; failure_code: string | null; failure_reason_safe: string | null } {
  if (args?.forceBlocked) {
    return {
      status: "BLOCKED",
      failure_code: args.blockReason ?? PAYMENT_EXECUTION_DISABLED,
      failure_reason_safe: "Payment execution disabled — intent blocked without provider call",
    };
  }
  return { status: "VALIDATED", failure_code: null, failure_reason_safe: null };
}

export function assertSlice4MoneySafety(flags: {
  revolut_pay_called: boolean;
  wallet_mutated: boolean;
  live_payout_execution_enabled: boolean;
  payment_transport_enabled: boolean;
  provider_payment_id: string | null | undefined;
}): void {
  if (flags.revolut_pay_called) throw new Error("slice4_invariant_pay_called");
  if (flags.wallet_mutated) throw new Error("slice4_invariant_wallet_mutated");
  if (flags.live_payout_execution_enabled) throw new Error("slice4_invariant_live_payout_enabled");
  if (flags.payment_transport_enabled) throw new Error("slice4_invariant_payment_transport_enabled");
  if (flags.provider_payment_id) throw new Error("slice4_invariant_provider_payment_id_set");
}

/** Official contract summary for Slice 4 return docs (from Revolut Business API). */
export function revolutBusinessPayContractVerified(): {
  endpoint: string;
  oauth_scope: string;
  headers: string[];
  idempotency: string;
  states: readonly string[];
  source_account_requirement: string;
} {
  return {
    endpoint: REVOLUT_BUSINESS_PAY_ENDPOINT,
    oauth_scope: REVOLUT_BUSINESS_PAY_OAUTH_SCOPE,
    headers: [
      "Authorization: Bearer <access_token>",
      "Content-Type: application/json",
    ],
    idempotency:
      "Body field request_id (UUID recommended). Same request_id will not create a duplicate payment.",
    states: REVOLUT_PAY_PROVIDER_STATES,
    source_account_requirement:
      "account_id is the Revolut Business source account UUID from which funds are sent; receiver.counterparty_id required; receiver.account_id required when the counterparty has multiple payment methods.",
  };
}
