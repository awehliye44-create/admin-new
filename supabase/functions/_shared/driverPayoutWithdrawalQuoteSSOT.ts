/**
 * Canonical Driver withdrawal quote SSOT (Stage C2).
 * Pure — no I/O. Wallet UI, Admin, and driver-withdraw must share these semantics.
 *
 * Distinct amounts:
 *   ledger_balance_pence     = all driver credit (live)
 *   cleared_available_pence  = cleared before policy restrictions (Available)
 *   pending_pence            = uncleared clearing only (or live pool when OP-paused)
 *   reserved_pence           = reserved / in-flight payout holds
 *   withdrawable_pence       = amount permitted after ALL payout gates
 *
 * Legacy drivers.payouts_enabled must NOT independently zero Available or Withdrawable.
 */

import { balancePresentation, effectivePayoutAllowed } from "./payoutDestinationVerificationOutcomeSSOT.ts";
import type { DriverPayoutEligibilityResult } from "./driverPayoutEligibilitySSOT.ts";
import { PAYOUT_ELIGIBILITY_STATUS } from "./driverPayoutEligibilitySSOT.ts";

export const DRIVER_PAYOUT_WITHDRAWAL_QUOTE_VERSION =
  "driver_payout_withdrawal_quote_v1_stage_c2";

/** Wire contract for GET /driver-withdraw (quote) + POST executor identity. */
export const DRIVER_WITHDRAW_QUOTE_VERSION = "STAGE_C2_V1";
export const DRIVER_WITHDRAW_EXECUTOR_VERSION = "STAGE_C2_V1";
export const DRIVER_WITHDRAW_ELIGIBILITY_SOURCE = "DRIVER_EFFECTIVE_PAYOUT_ALLOWED";

export type DriverWithdrawExecutorDestination = {
  status: string | null;
  masked_account: string | null;
};

/** Authenticated read-only GET quote payload (zero writes). */
export type DriverWithdrawExecutorQuotePayload = {
  ok: true;
  quote_version: typeof DRIVER_WITHDRAW_QUOTE_VERSION;
  executor_version: typeof DRIVER_WITHDRAW_EXECUTOR_VERSION;
  eligibility_source: typeof DRIVER_WITHDRAW_ELIGIBILITY_SOURCE;
  quote_generated_at: string;
  ledger_balance_pence: number;
  cleared_available_pence: number;
  pending_pence: number;
  reserved_pence: number;
  withdrawable_pence: number;
  requested_pence: number;
  fee_pence: number;
  net_payout_pence: number;
  payout_allowed: boolean;
  blocking_reason_code: DriverPayoutBlockReasonCode | null;
  blocking_reason_copy: string | null;
  destination: DriverWithdrawExecutorDestination;
  /** Explicit: quote path never mutates money state. */
  revolut_pay_called: false;
  writes: false;
};

export function toDriverWithdrawExecutorQuotePayload(args: {
  quote: DriverPayoutWithdrawalQuote;
  destination_status?: string | null;
  destination_masked_last4?: string | null;
  quote_generated_at?: string;
}): DriverWithdrawExecutorQuotePayload {
  const q = args.quote;
  return {
    ok: true,
    quote_version: DRIVER_WITHDRAW_QUOTE_VERSION,
    executor_version: DRIVER_WITHDRAW_EXECUTOR_VERSION,
    eligibility_source: DRIVER_WITHDRAW_ELIGIBILITY_SOURCE,
    quote_generated_at: args.quote_generated_at ?? new Date().toISOString(),
    ledger_balance_pence: q.ledger_balance_pence,
    cleared_available_pence: q.cleared_available_pence,
    pending_pence: q.pending_pence,
    reserved_pence: q.reserved_pence,
    withdrawable_pence: q.withdrawable_pence,
    requested_pence: q.requested_pence,
    fee_pence: q.fee_pence,
    net_payout_pence: q.net_payout_pence,
    payout_allowed: q.payout_allowed,
    blocking_reason_code: q.blocking_reason_code,
    blocking_reason_copy: q.blocking_reason_copy,
    destination: {
      status: args.destination_status ?? null,
      masked_account: args.destination_masked_last4
        ? String(args.destination_masked_last4).replace(/\D/g, "").slice(-4) || null
        : null,
    },
    revolut_pay_called: false,
    writes: false,
  };
}

/** Driver / tests: accept only a complete STAGE_C2_V1 executor quote. */
export function isCompatibleDriverWithdrawExecutorQuote(
  raw: unknown,
): raw is DriverWithdrawExecutorQuotePayload {
  if (!raw || typeof raw !== "object") return false;
  const o = raw as Record<string, unknown>;
  if (o.quote_version !== DRIVER_WITHDRAW_QUOTE_VERSION) return false;
  if (o.executor_version !== DRIVER_WITHDRAW_EXECUTOR_VERSION) return false;
  if (o.eligibility_source !== DRIVER_WITHDRAW_ELIGIBILITY_SOURCE) return false;
  if (typeof o.quote_generated_at !== "string" || !o.quote_generated_at) return false;
  for (const k of [
    "ledger_balance_pence",
    "cleared_available_pence",
    "pending_pence",
    "reserved_pence",
    "withdrawable_pence",
    "requested_pence",
    "fee_pence",
    "net_payout_pence",
  ] as const) {
    if (typeof o[k] !== "number" || !Number.isFinite(o[k] as number)) return false;
  }
  if (typeof o.payout_allowed !== "boolean") return false;
  if (!o.destination || typeof o.destination !== "object") return false;
  return true;
}

export const DRIVER_PAYOUT_BLOCK_REASON = {
  NONE: "NONE",
  FEATURE_DISABLED: "FEATURE_DISABLED",
  ADMIN_HOLD: "ADMIN_HOLD",
  DRIVER_SUSPENDED: "DRIVER_SUSPENDED",
  DRIVER_NOT_APPROVED: "DRIVER_NOT_APPROVED",
  PAYOUT_ACCOUNT_NOT_VERIFIED: "PAYOUT_ACCOUNT_NOT_VERIFIED",
  ACCOUNT_UNVERIFIED: "ACCOUNT_UNVERIFIED",
  PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
  NO_AVAILABLE_BALANCE: "NO_AVAILABLE_BALANCE",
  FUNDS_CLEARING: "FUNDS_CLEARING",
  DEBT_RECOVERY: "DEBT_RECOVERY",
  ACTIVE_PAYOUT_RESERVATION: "ACTIVE_PAYOUT_RESERVATION",
  CASHOUT_ALREADY_PROCESSING: "CASHOUT_ALREADY_PROCESSING",
  BALANCE_NOT_GREATER_THAN_FEE: "BALANCE_NOT_GREATER_THAN_FEE",
  BELOW_MINIMUM: "BELOW_MINIMUM",
  DRIVER_COLLECTED_MODEL: "DRIVER_COLLECTED_MODEL",
  AMOUNT_EXCEEDS_WITHDRAWABLE: "AMOUNT_EXCEEDS_WITHDRAWABLE",
  STALE_QUOTE: "STALE_QUOTE",
} as const;

export type DriverPayoutBlockReasonCode =
  (typeof DRIVER_PAYOUT_BLOCK_REASON)[keyof typeof DRIVER_PAYOUT_BLOCK_REASON];

export type DriverPayoutWithdrawalQuote = {
  ledger_balance_pence: number;
  cleared_available_pence: number;
  pending_pence: number;
  reserved_pence: number;
  withdrawable_pence: number;
  requested_pence: number;
  fee_pence: number;
  net_payout_pence: number;
  payout_allowed: boolean;
  blocking_reason_code: DriverPayoutBlockReasonCode | null;
  blocking_reason_copy: string | null;
  eligibility_source: "stage_c2_effective_payout_allowed";
  eligibility_version: typeof DRIVER_PAYOUT_WITHDRAWAL_QUOTE_VERSION;
  /** Deprecated diagnostic only — never a hard gate. */
  legacy_payouts_enabled: boolean | null;
};

export function blockingReasonCopy(code: DriverPayoutBlockReasonCode | null | undefined): string | null {
  switch (code) {
    case null:
    case undefined:
    case DRIVER_PAYOUT_BLOCK_REASON.NONE:
      return null;
    case DRIVER_PAYOUT_BLOCK_REASON.FEATURE_DISABLED:
      return "Driver payouts are currently disabled";
    case DRIVER_PAYOUT_BLOCK_REASON.ADMIN_HOLD:
      return "Driver payouts are temporarily paused";
    case DRIVER_PAYOUT_BLOCK_REASON.DRIVER_SUSPENDED:
      return "Account restricted";
    case DRIVER_PAYOUT_BLOCK_REASON.DRIVER_NOT_APPROVED:
      return "Account is not approved for payouts";
    case DRIVER_PAYOUT_BLOCK_REASON.PAYOUT_ACCOUNT_NOT_VERIFIED:
    case DRIVER_PAYOUT_BLOCK_REASON.ACCOUNT_UNVERIFIED:
      return "Payout account verification required";
    case DRIVER_PAYOUT_BLOCK_REASON.PROVIDER_UNAVAILABLE:
      return "Withdrawals are not available for this payout provider";
    case DRIVER_PAYOUT_BLOCK_REASON.NO_AVAILABLE_BALANCE:
      return "No balance available to withdraw.";
    case DRIVER_PAYOUT_BLOCK_REASON.FUNDS_CLEARING:
      return "Funds are still clearing";
    case DRIVER_PAYOUT_BLOCK_REASON.DEBT_RECOVERY:
      return "Payouts are held for recovery balance";
    case DRIVER_PAYOUT_BLOCK_REASON.ACTIVE_PAYOUT_RESERVATION:
    case DRIVER_PAYOUT_BLOCK_REASON.CASHOUT_ALREADY_PROCESSING:
      return "A payout is already in progress";
    case DRIVER_PAYOUT_BLOCK_REASON.BALANCE_NOT_GREATER_THAN_FEE:
      return "Available balance does not cover the withdrawal fee.";
    case DRIVER_PAYOUT_BLOCK_REASON.BELOW_MINIMUM:
      return "Funds cleared but below withdrawal minimum";
    case DRIVER_PAYOUT_BLOCK_REASON.DRIVER_COLLECTED_MODEL:
      return "This wallet cannot enter the platform payout flow";
    case DRIVER_PAYOUT_BLOCK_REASON.AMOUNT_EXCEEDS_WITHDRAWABLE:
      return "Requested amount exceeds withdrawable balance";
    case DRIVER_PAYOUT_BLOCK_REASON.STALE_QUOTE:
      return "Your available balance changed. Please review and try again.";
    default:
      return "Withdrawals are not available right now.";
  }
}

/**
 * Map eligibility / effective block codes onto typed withdrawal reasons.
 * Never collapses ADMIN_HOLD into NO_AVAILABLE_BALANCE.
 */
export function resolveWithdrawalBlockCode(input: {
  effective_block:
    | "NONE"
    | "FEATURE_DISABLED"
    | "ACCOUNT_UNVERIFIED"
    | "ADMIN_HOLD"
    | "DRIVER_SUSPENDED"
    | "DRIVER_NOT_APPROVED";
  eligibility_primary_hold: string | null | undefined;
  cleared_available_pence: number;
  pending_pence: number;
  reserved_pence: number;
  ledger_balance_pence: number;
  early_cash_out_enabled?: boolean;
  provider_available?: boolean;
  financial_model_platform_collected?: boolean;
}): DriverPayoutBlockReasonCode | null {
  if (input.financial_model_platform_collected === false) {
    return DRIVER_PAYOUT_BLOCK_REASON.DRIVER_COLLECTED_MODEL;
  }
  if (input.early_cash_out_enabled === false) {
    return DRIVER_PAYOUT_BLOCK_REASON.FEATURE_DISABLED;
  }
  if (input.provider_available === false) {
    return DRIVER_PAYOUT_BLOCK_REASON.PROVIDER_UNAVAILABLE;
  }
  if (input.effective_block === "DRIVER_SUSPENDED") {
    return DRIVER_PAYOUT_BLOCK_REASON.DRIVER_SUSPENDED;
  }
  if (input.effective_block === "DRIVER_NOT_APPROVED") {
    return DRIVER_PAYOUT_BLOCK_REASON.DRIVER_NOT_APPROVED;
  }
  if (input.effective_block === "FEATURE_DISABLED") {
    return DRIVER_PAYOUT_BLOCK_REASON.FEATURE_DISABLED;
  }
  if (input.effective_block === "ADMIN_HOLD") {
    return DRIVER_PAYOUT_BLOCK_REASON.ADMIN_HOLD;
  }
  if (input.effective_block === "ACCOUNT_UNVERIFIED") {
    return DRIVER_PAYOUT_BLOCK_REASON.PAYOUT_ACCOUNT_NOT_VERIFIED;
  }
  // Reserved amount is already subtracted from cleared_available by aggregate.
  // Only treat full in-flight cashout lock as a hard block when available is zero
  // after reservation (caller may also pass CASHOUT_ALREADY_PROCESSING via hold).
  const hold = String(input.eligibility_primary_hold ?? "").toUpperCase();
  if (hold === PAYOUT_ELIGIBILITY_STATUS.DEBT_RECOVERY) {
    return DRIVER_PAYOUT_BLOCK_REASON.DEBT_RECOVERY;
  }
  if (hold === PAYOUT_ELIGIBILITY_STATUS.ACCOUNT_UNVERIFIED) {
    return DRIVER_PAYOUT_BLOCK_REASON.PAYOUT_ACCOUNT_NOT_VERIFIED;
  }
  if (hold === PAYOUT_ELIGIBILITY_STATUS.ADMIN_HOLD) {
    return DRIVER_PAYOUT_BLOCK_REASON.ADMIN_HOLD;
  }
  if (hold === PAYOUT_ELIGIBILITY_STATUS.PAYOUT_PROCESSING) {
    return DRIVER_PAYOUT_BLOCK_REASON.CASHOUT_ALREADY_PROCESSING;
  }
  if (input.cleared_available_pence <= 0) {
    if (input.reserved_pence > 0) return DRIVER_PAYOUT_BLOCK_REASON.ACTIVE_PAYOUT_RESERVATION;
    if (input.pending_pence > 0) return DRIVER_PAYOUT_BLOCK_REASON.FUNDS_CLEARING;
    if (input.ledger_balance_pence <= 0) return DRIVER_PAYOUT_BLOCK_REASON.NO_AVAILABLE_BALANCE;
    return DRIVER_PAYOUT_BLOCK_REASON.NO_AVAILABLE_BALANCE;
  }
  return null;
}

export function buildDriverPayoutWithdrawalQuote(input: {
  eligibility: DriverPayoutEligibilityResult;
  global_payouts_enabled: boolean;
  payout_operational_paused: boolean;
  provider_verified_active_destination: boolean;
  driver_approved: boolean;
  driver_suspended: boolean;
  fee_pence?: number | null;
  minimum_pence?: number | null;
  early_cash_out_enabled?: boolean;
  provider_available?: boolean;
  financial_model_platform_collected?: boolean;
  /** Deprecated diagnostic only. */
  legacy_payouts_enabled?: boolean | null;
}): DriverPayoutWithdrawalQuote {
  const elig = input.eligibility;
  const ledger = Math.round(Number(elig.live_balance_pence ?? 0));
  const reserved = Math.max(0, Math.round(Number(elig.withdrawal_in_progress_pence ?? 0)));
  const clearedFromElig = Math.max(0, Math.round(Number(elig.available_balance_pence ?? 0)));
  const pendingFromElig = Math.max(0, Math.round(Number(elig.pending_balance_pence ?? 0)));

  const effective = effectivePayoutAllowed({
    global_payouts_enabled: input.global_payouts_enabled !== false,
    provider_verified_active_destination: input.provider_verified_active_destination === true,
    payout_operational_paused: input.payout_operational_paused === true,
    driver_approved: input.driver_approved === true,
    driver_suspended: input.driver_suspended === true,
  });

  const presentation = balancePresentation({
    cleared_pence: clearedFromElig,
    uncleared_pending_pence: pendingFromElig,
    payout_operational_paused: input.payout_operational_paused === true,
    effective_payout_allowed: effective.effective_payout_allowed,
    minimum_pence: Math.max(0, Math.round(Number(input.minimum_pence ?? 0))),
    block_reason: effective.block_reason,
  });

  const fee = Math.max(0, Math.round(Number(input.fee_pence ?? 0)));
  const minimum = Math.max(0, Math.round(Number(input.minimum_pence ?? 0)));

  let block = resolveWithdrawalBlockCode({
    effective_block: effective.block_reason,
    eligibility_primary_hold: elig.primary_hold_reason,
    cleared_available_pence: presentation.available_pence,
    pending_pence: presentation.pending_pence,
    reserved_pence: reserved,
    ledger_balance_pence: ledger,
    early_cash_out_enabled: input.early_cash_out_enabled,
    provider_available: input.provider_available,
    financial_model_platform_collected: input.financial_model_platform_collected,
  });

  let withdrawable = Math.max(0, presentation.withdrawable_pence);
  if (block) withdrawable = 0;

  if (!block && withdrawable > 0 && fee > 0 && withdrawable - fee <= 0) {
    block = DRIVER_PAYOUT_BLOCK_REASON.BALANCE_NOT_GREATER_THAN_FEE;
    withdrawable = 0;
  }
  if (!block && withdrawable > 0 && minimum > 0 && withdrawable < minimum) {
    block = DRIVER_PAYOUT_BLOCK_REASON.BELOW_MINIMUM;
    withdrawable = 0;
  }

  const payoutAllowed = withdrawable > 0 && block == null;
  const requested = payoutAllowed ? withdrawable : 0;
  const net = payoutAllowed ? Math.max(0, requested - fee) : 0;

  return {
    ledger_balance_pence: ledger,
    cleared_available_pence: presentation.available_pence,
    pending_pence: presentation.pending_pence,
    reserved_pence: reserved,
    withdrawable_pence: withdrawable,
    requested_pence: requested,
    fee_pence: fee,
    net_payout_pence: net,
    payout_allowed: payoutAllowed,
    blocking_reason_code: payoutAllowed ? null : (block ?? DRIVER_PAYOUT_BLOCK_REASON.NO_AVAILABLE_BALANCE),
    blocking_reason_copy: payoutAllowed
      ? null
      : blockingReasonCopy(block ?? DRIVER_PAYOUT_BLOCK_REASON.NO_AVAILABLE_BALANCE),
    eligibility_source: "stage_c2_effective_payout_allowed",
    eligibility_version: DRIVER_PAYOUT_WITHDRAWAL_QUOTE_VERSION,
    legacy_payouts_enabled: input.legacy_payouts_enabled ?? null,
  };
}

/** Reject client-supplied amount when it exceeds server withdrawable. */
export function assertClientAmountWithinWithdrawable(args: {
  client_requested_pence: number | null | undefined;
  quote: DriverPayoutWithdrawalQuote;
}): { ok: true } | { ok: false; code: DriverPayoutBlockReasonCode; copy: string } {
  if (!args.quote.payout_allowed || args.quote.withdrawable_pence <= 0) {
    const code = args.quote.blocking_reason_code ?? DRIVER_PAYOUT_BLOCK_REASON.NO_AVAILABLE_BALANCE;
    return { ok: false, code, copy: blockingReasonCopy(code) ?? "Withdrawals are not available right now." };
  }
  if (args.client_requested_pence == null) return { ok: true };
  const client = Math.round(Number(args.client_requested_pence));
  if (!Number.isFinite(client) || client <= 0) return { ok: true };
  if (client > args.quote.withdrawable_pence) {
    return {
      ok: false,
      code: DRIVER_PAYOUT_BLOCK_REASON.AMOUNT_EXCEEDS_WITHDRAWABLE,
      copy: blockingReasonCopy(DRIVER_PAYOUT_BLOCK_REASON.AMOUNT_EXCEEDS_WITHDRAWABLE)!,
    };
  }
  if (client !== args.quote.requested_pence) {
    return {
      ok: false,
      code: DRIVER_PAYOUT_BLOCK_REASON.STALE_QUOTE,
      copy: blockingReasonCopy(DRIVER_PAYOUT_BLOCK_REASON.STALE_QUOTE)!,
    };
  }
  return { ok: true };
}
