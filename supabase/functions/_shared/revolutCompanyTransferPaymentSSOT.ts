/**
 * Slice 12 â Revolut Business company-transfer payment transport SSOT.
 * Validation + idempotency only when LIVE_COMPANY_TRANSFER_EXECUTION_ENABLED=false.
 */

import {
  REVOLUT_PAY_REQUEST_ID_MAX_LEN,
  canonicalCompanyTransferIdempotencyKey,
  canonicalCompanyTransferProviderRequestId,
} from "../../../shared/companyTransferSubmissionSSOT.ts";
import { resolveCompanyTransferProviderReference } from "../../../shared/companyTransferPaymentReferenceSSOT.ts";

export {
  REVOLUT_PAY_REQUEST_ID_MAX_LEN,
  canonicalCompanyTransferIdempotencyKey,
  canonicalCompanyTransferProviderRequestId,
};

export const APPROVED_COMPANY_TRANSFER_FIELDS = [
  "transfer_id",
  "source_account_id",
  "provider_counterparty_id",
  "provider_recipient_account_id",
  "amount_pence",
  "currency",
  "payment_reference",
  "provider_request_id",
  "idempotency_key",
] as const;

export type ApprovedCompanyTransferField = (typeof APPROVED_COMPANY_TRANSFER_FIELDS)[number];

export type ApprovedCompanyTransferPaymentInput = {
  transfer_id: string;
  source_account_id: string;
  provider_counterparty_id: string;
  provider_recipient_account_id: string;
  amount_pence: number;
  currency: string;
  payment_reference?: string | null;
  provider_request_id?: string | null;
  idempotency_key?: string | null;
};

export function isLiveCompanyTransferExecutionEnabled(
  env: { get(key: string): string | undefined } = Deno.env,
): boolean {
  return (env.get("LIVE_COMPANY_TRANSFER_EXECUTION_ENABLED") ?? "false").trim().toLowerCase() === "true";
}

export function isRevolutPaymentTransportEnabled(
  env: { get(key: string): string | undefined } = Deno.env,
): boolean {
  return (env.get("REVOLUT_PAYMENT_TRANSPORT_ENABLED") ?? "false").trim().toLowerCase() === "true";
}

export function mayCallRevolutPayForCompanyTransfer(
  env: { get(key: string): string | undefined } = Deno.env,
): boolean {
  return isLiveCompanyTransferExecutionEnabled(env) && isRevolutPaymentTransportEnabled(env);
}

export function companyTransferRequestFingerprint(input: {
  amount_pence: number;
  currency: string;
  source_account_id: string;
  provider_recipient_account_id: string;
  provider_counterparty_id: string;
  transfer_id: string;
}): string {
  return [
    String(input.amount_pence),
    input.currency.trim().toUpperCase(),
    input.source_account_id.trim(),
    input.provider_counterparty_id.trim(),
    input.provider_recipient_account_id.trim(),
    input.transfer_id.trim(),
  ].join("|");
}

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
    amount: Math.round(input.amount_pence) / 100,
    currency: input.currency.trim().toUpperCase(),
  };
  if (input.payment_reference) {
    payload.reference = resolveCompanyTransferProviderReference({
      payment_reference: input.payment_reference,
    });
  }
  return payload;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

export function rejectUnknownCompanyTransferFields(
  body: Record<string, unknown>,
): { ok: true } | { ok: false; extra: string[] } {
  const allowed = new Set<string>(APPROVED_COMPANY_TRANSFER_FIELDS);
  const extra = Object.keys(body).filter((k) => !allowed.has(k));
  if (extra.length > 0) return { ok: false, extra };
  return { ok: true };
}

export function validateApprovedCompanyTransferPayment(args: {
  body: Record<string, unknown>;
  loaded: {
    transfer_id: string;
    amount_pence: number;
    currency: string;
    source_account_id: string;
    provider_counterparty_id: string;
    provider_recipient_account_id: string;
    payment_reference?: string | null;
  };
}):
  | {
    ok: true;
    normalized: ApprovedCompanyTransferPaymentInput & {
      currency: "GBP";
      provider_request_id: string;
      idempotency_key: string;
      request_fingerprint: string;
      dry_run_payload: Record<string, unknown>;
    };
  }
  | { ok: false; code: string; message: string } {
  const fieldsCheck = rejectUnknownCompanyTransferFields(args.body);
  if (!fieldsCheck.ok) {
    return {
      ok: false,
      code: "EXTRA_FIELDS_REJECTED",
      message: `Unknown fields rejected: ${fieldsCheck.extra.join(",")}`,
    };
  }
  const b = args.body;
  const loaded = args.loaded;
  if (String(b.transfer_id ?? "").trim() !== loaded.transfer_id) {
    return { ok: false, code: "TRANSFER_MISMATCH", message: "transfer_id must match server-loaded transfer" };
  }
  const bodyAmount = typeof b.amount_pence === "number" ? b.amount_pence : Number(b.amount_pence);
  if (!Number.isFinite(bodyAmount) || Math.round(bodyAmount) !== loaded.amount_pence) {
    return { ok: false, code: "AMOUNT_MISMATCH", message: "amount_pence must match server-loaded transfer" };
  }
  for (const key of [
    "source_account_id",
    "provider_counterparty_id",
    "provider_recipient_account_id",
  ] as const) {
    if (isNonEmptyString(b[key]) && String(b[key]).trim() !== String(loaded[key]).trim()) {
      return { ok: false, code: "FIELD_MISMATCH", message: `${key} must match server-loaded transfer` };
    }
  }
  const currency = String(b.currency ?? loaded.currency ?? "GBP").trim().toUpperCase();
  if (currency !== "GBP" || loaded.currency.toUpperCase() !== "GBP") {
    return { ok: false, code: "CURRENCY_NOT_GBP", message: "GBP only" };
  }
  const expectedRequestId = canonicalCompanyTransferProviderRequestId(loaded.transfer_id);
  const providerRequestId = isNonEmptyString(b.provider_request_id)
    ? String(b.provider_request_id).trim()
    : expectedRequestId;
  const idempotencyKey = isNonEmptyString(b.idempotency_key)
    ? String(b.idempotency_key).trim()
    : canonicalCompanyTransferIdempotencyKey(loaded.transfer_id);
  if (providerRequestId !== expectedRequestId) {
    return {
      ok: false,
      code: "PROVIDER_REQUEST_ID_MISMATCH",
      message: "provider_request_id must equal oc-ct:{transfer_uuid_hex} (â¤40)",
    };
  }
  if (idempotencyKey !== canonicalCompanyTransferIdempotencyKey(loaded.transfer_id)) {
    return {
      ok: false,
      code: "IDEMPOTENCY_KEY_MISMATCH",
      message: "idempotency_key must equal oc-ct:{transfer_uuid_hex} (â¤40)",
    };
  }
  const fingerprint = companyTransferRequestFingerprint({
    amount_pence: loaded.amount_pence,
    currency,
    source_account_id: loaded.source_account_id,
    provider_recipient_account_id: loaded.provider_recipient_account_id,
    provider_counterparty_id: loaded.provider_counterparty_id,
    transfer_id: loaded.transfer_id,
  });
  return {
    ok: true,
    normalized: {
      transfer_id: loaded.transfer_id,
      source_account_id: loaded.source_account_id,
      provider_counterparty_id: loaded.provider_counterparty_id,
      provider_recipient_account_id: loaded.provider_recipient_account_id,
      amount_pence: loaded.amount_pence,
      currency: "GBP",
      payment_reference: loaded.payment_reference ?? null,
      provider_request_id: providerRequestId,
      idempotency_key: idempotencyKey,
      request_fingerprint: fingerprint,
      dry_run_payload: buildRevolutPayDryRunPayload({
        provider_request_id: providerRequestId,
        source_account_id: loaded.source_account_id,
        provider_counterparty_id: loaded.provider_counterparty_id,
        provider_recipient_account_id: loaded.provider_recipient_account_id,
        amount_pence: loaded.amount_pence,
        currency,
        payment_reference: loaded.payment_reference,
      }),
    },
  };
}
