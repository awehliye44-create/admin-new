/**
 * Payout account balance composition — shared display SSOT.
 *
 *   Live = Available + Pending + Reserved + Held + Unbacked
 *
 * Available is the reservation formula (SQL / eligibility available).
 * Unbacked is live balance that no unallocated earning credit explains —
 * always shown, never payable.
 *
 * Mid-payout: ACTIVE reservation covering allocated funds is Reserved, not Unbacked.
 * Pure display/projection — never mutates, never feeds a payout amount.
 */
import type { DriverPayoutEligibilityResult } from "./driverPayoutEligibilitySSOT.ts";

export const PAYOUT_ACCOUNT_HOLD_REASON = {
  DELETED_DRIVER_REVIEW: "DELETED_DRIVER_REVIEW",
  DRIVER_STATUS_HOLD: "DRIVER_STATUS_HOLD",
  DRIVER_NOT_APPROVED: "DRIVER_NOT_APPROVED",
  ADMIN_HOLD: "ADMIN_HOLD",
  PAYOUTS_DISABLED: "PAYOUTS_DISABLED",
  NO_VERIFIED_DESTINATION: "NO_VERIFIED_DESTINATION",
  DEBT_RECOVERY: "DEBT_RECOVERY",
  ADMIN_CREDIT_NOT_PAYABLE: "ADMIN_CREDIT_NOT_PAYABLE",
  CASHOUT_FEE_NOT_RECORDED: "CASHOUT_FEE_NOT_RECORDED",
  UNBACKED_WALLET_BALANCE: "UNBACKED_WALLET_BALANCE",
} as const;

export type PayoutAccountHoldReason =
  | (typeof PAYOUT_ACCOUNT_HOLD_REASON)[keyof typeof PAYOUT_ACCOUNT_HOLD_REASON]
  | string;

export type UnbackedWalletReason =
  | typeof PAYOUT_ACCOUNT_HOLD_REASON.CASHOUT_FEE_NOT_RECORDED
  | typeof PAYOUT_ACCOUNT_HOLD_REASON.UNBACKED_WALLET_BALANCE;

const HELD_DRIVER_STATUSES = new Set([
  "disabled",
  "suspended",
  "banned",
  "blocked",
  "inactive",
  "held",
]);

/** Eligibility hold that describes paid / allocated history, not a live hold. */
const HISTORY_ONLY_HOLD = "PAYOUT_ALLOCATED";

function pence(value: unknown): number {
  const n = Math.round(Number(value ?? 0));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Live balance not explained by any unallocated earning credit or in-flight
 * withdrawal. When the shortfall equals unrecorded early cash-out fees it is
 * typed CASHOUT_FEE_NOT_RECORDED; any other remainder needs review.
 *
 * ACTIVE reservation (withdrawal_in_progress) covering mid-payout allocated
 * funds reduces Unbacked — those funds are Reserved, not Unbacked.
 */
export function computeUnbackedWalletBalance(args: {
  live_pence: number;
  eligibility: Pick<DriverPayoutEligibilityResult, "eligible_entries" | "held_entries">;
  withdrawal_in_progress_pence: number;
  unrecorded_cashout_fee_pence: number;
}): { unbacked_pence: number; unbacked_reason: UnbackedWalletReason | null } {
  let backed = 0;
  for (const entry of args.eligibility.eligible_entries) {
    backed += Math.max(0, pence(entry.amount_pence));
  }
  for (const entry of args.eligibility.held_entries) {
    if (entry.hold_reason === HISTORY_ONLY_HOLD) continue;
    backed += Math.max(0, pence(entry.amount_pence));
  }
  const unbacked = Math.max(
    0,
    pence(args.live_pence) - backed - Math.max(0, pence(args.withdrawal_in_progress_pence)),
  );
  if (unbacked <= 0) return { unbacked_pence: 0, unbacked_reason: null };
  const fee = Math.max(0, pence(args.unrecorded_cashout_fee_pence));
  return {
    unbacked_pence: unbacked,
    unbacked_reason: fee > 0 && fee === unbacked
      ? PAYOUT_ACCOUNT_HOLD_REASON.CASHOUT_FEE_NOT_RECORDED
      : PAYOUT_ACCOUNT_HOLD_REASON.UNBACKED_WALLET_BALANCE,
  };
}

export type PayoutAccountDriverState = {
  deleted: boolean;
  driver_status: string | null;
  approved: boolean;
  operational_paused: boolean;
  global_payouts_enabled: boolean;
  verified_destination: boolean;
  gate_allowed: boolean;
};

export type PayoutAccountComposition = {
  live_pence: number;
  available_pence: number;
  pending_pence: number;
  reserved_pence: number;
  held_pence: number;
  unbacked_pence: number;
  unbacked_reason: UnbackedWalletReason | null;
  hold_reason: PayoutAccountHoldReason | null;
  payout_included: boolean;
  eligible_entry_count: number;
  held_entry_count: number;
  status: "ELIGIBLE" | "PAUSED" | "HELD" | "HELD_REVIEW" | "ZERO";
};

export function resolvePayoutAccountComposition(args: {
  sql: {
    live_balance_pence: number;
    available_balance_pence: number;
    pending_balance_pence: number;
    withdrawal_in_progress_pence: number;
    outstanding_debt_pence: number;
  };
  eligibility: Pick<DriverPayoutEligibilityResult, "eligible_entries" | "held_entries">;
  driver: PayoutAccountDriverState;
  admin_credit_ledger_ids: ReadonlySet<string>;
  unrecorded_cashout_fee_pence: number;
}): PayoutAccountComposition {
  const live = pence(args.sql.live_balance_pence);
  const debt = Math.max(0, pence(args.sql.outstanding_debt_pence));
  const pending = Math.max(0, pence(args.sql.pending_balance_pence));
  const reserved = Math.max(0, pence(args.sql.withdrawal_in_progress_pence));
  const status = String(args.driver.driver_status ?? "").trim().toLowerCase();
  const identityHold = args.driver.deleted || status === "deleted" ||
    HELD_DRIVER_STATUSES.has(status);
  const available = identityHold ? 0 : Math.max(0, pence(args.sql.available_balance_pence));

  const { unbacked_pence, unbacked_reason } = computeUnbackedWalletBalance({
    live_pence: live,
    eligibility: args.eligibility,
    withdrawal_in_progress_pence: reserved,
    unrecorded_cashout_fee_pence: args.unrecorded_cashout_fee_pence,
  });
  const held = Math.max(0, live - available - pending - reserved - unbacked_pence);

  const payableEntries = args.eligibility.eligible_entries.filter(
    (e) => !args.admin_credit_ledger_ids.has(String(e.ledger_entry_id)),
  );
  const adminCreditEntries = args.eligibility.eligible_entries.length - payableEntries.length;
  const actionableHeld = args.eligibility.held_entries.filter(
    (e) => e.hold_reason !== HISTORY_ONLY_HOLD,
  );

  const payout_included = args.driver.gate_allowed && !identityHold && available > 0;

  let hold_reason: PayoutAccountHoldReason | null = null;
  if (args.driver.deleted || status === "deleted") {
    hold_reason = PAYOUT_ACCOUNT_HOLD_REASON.DELETED_DRIVER_REVIEW;
  } else if (identityHold) {
    hold_reason = PAYOUT_ACCOUNT_HOLD_REASON.DRIVER_STATUS_HOLD;
  } else if (args.driver.operational_paused) {
    hold_reason = PAYOUT_ACCOUNT_HOLD_REASON.ADMIN_HOLD;
  } else if (!args.driver.global_payouts_enabled) {
    hold_reason = PAYOUT_ACCOUNT_HOLD_REASON.PAYOUTS_DISABLED;
  } else if (!args.driver.approved) {
    hold_reason = PAYOUT_ACCOUNT_HOLD_REASON.DRIVER_NOT_APPROVED;
  } else if (available > 0 && !args.driver.verified_destination) {
    hold_reason = PAYOUT_ACCOUNT_HOLD_REASON.NO_VERIFIED_DESTINATION;
  } else if (held > 0 && actionableHeld.length > 0) {
    hold_reason = actionableHeld[0]!.hold_reason;
  } else if (held > 0 && debt > 0) {
    hold_reason = PAYOUT_ACCOUNT_HOLD_REASON.DEBT_RECOVERY;
  } else if (held > 0 && adminCreditEntries > 0) {
    hold_reason = PAYOUT_ACCOUNT_HOLD_REASON.ADMIN_CREDIT_NOT_PAYABLE;
  } else if (available <= 0 && unbacked_pence > 0) {
    hold_reason = unbacked_reason;
  }

  const heldEntryCount = identityHold
    ? args.eligibility.eligible_entries.length + actionableHeld.length
    : actionableHeld.length + adminCreditEntries;

  let accountStatus: PayoutAccountComposition["status"];
  if (identityHold && live > 0) accountStatus = "HELD_REVIEW";
  else if (args.driver.operational_paused) accountStatus = "PAUSED";
  else if (payout_included) accountStatus = "ELIGIBLE";
  else if (live > 0) accountStatus = "HELD";
  else accountStatus = "ZERO";

  return {
    live_pence: live,
    available_pence: available,
    pending_pence: pending,
    reserved_pence: reserved,
    held_pence: held,
    unbacked_pence,
    unbacked_reason,
    hold_reason,
    payout_included,
    eligible_entry_count: payout_included ? payableEntries.length : 0,
    held_entry_count: heldEntryCount,
    status: accountStatus,
  };
}
