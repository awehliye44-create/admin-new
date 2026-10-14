/**
 * Payout account balance composition — shared by Payout Ledger accounts and
 * Driver Wallet Ledger rows so both pages explain the same live balance the
 * same way.
 *
 *   Live = Available + Pending + Reserved + Held + Unbacked
 *
 * Available is the reservation formula (SQL driver_wallet_eligibility_balances),
 * never the TS projection, so a page can never show more than
 * reserve_driver_payout_item would allow. Unbacked is live balance that no
 * unallocated earning credit explains; it is always shown and never payable.
 *
 * Pure display/projection — never mutates, never feeds a payout amount.
 */
import { getLondonCalendarParts, getLondonDayBounds } from "./financeLondonDay.ts";
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

/** Statuses `driver_effective_payout_allowed` treats as suspended. */
const HELD_DRIVER_STATUSES = new Set(["disabled", "suspended", "banned", "blocked", "inactive", "held"]);

/** Eligibility hold that describes paid history, not a live hold. */
const HISTORY_ONLY_HOLD = "PAYOUT_ALLOCATED";

function pence(value: unknown): number {
  const n = Math.round(Number(value ?? 0));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Live balance not explained by any unallocated earning credit or in-flight
 * withdrawal. When the shortfall equals unrecorded early cash-out fees it is
 * typed CASHOUT_FEE_NOT_RECORDED; any other remainder needs review.
 */
export function computeUnbackedWalletBalance(args: {
  live_pence: number;
  eligibility: Pick<DriverPayoutEligibilityResult, "eligible_entries" | "held_entries">;
  withdrawal_in_progress_pence: number;
  unrecorded_cashout_fee_pence: number;
}): { unbacked_pence: number; unbacked_reason: UnbackedWalletReason | null } {
  let backed = 0;
  for (const entry of args.eligibility.eligible_entries) backed += Math.max(0, pence(entry.amount_pence));
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
  /** driver_effective_payout_allowed — the reservation gate. */
  gate_allowed: boolean;
};

export type PayoutAccountComposition = {
  live_pence: number;
  /** Payable now: reservation-formula Available, zero for deleted / held drivers. */
  available_pence: number;
  pending_pence: number;
  reserved_pence: number;
  /** In the wallet, backed by a credit, but not payable now (see hold_reason). */
  held_pence: number;
  unbacked_pence: number;
  unbacked_reason: UnbackedWalletReason | null;
  hold_reason: PayoutAccountHoldReason | null;
  /** True only when the next scheduled run would pay this driver. */
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
  /** Ledger ids of ADMIN_WALLET_CREDIT rows — not payable through payouts. */
  admin_credit_ledger_ids: ReadonlySet<string>;
  unrecorded_cashout_fee_pence: number;
}): PayoutAccountComposition {
  const live = pence(args.sql.live_balance_pence);
  const debt = Math.max(0, pence(args.sql.outstanding_debt_pence));
  const pending = Math.max(0, pence(args.sql.pending_balance_pence));
  const reserved = Math.max(0, pence(args.sql.withdrawal_in_progress_pence));
  const status = String(args.driver.driver_status ?? "").trim().toLowerCase();
  const identityHold = args.driver.deleted || status === "deleted" || HELD_DRIVER_STATUSES.has(status);
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
  const actionableHeld = args.eligibility.held_entries.filter((e) => e.hold_reason !== HISTORY_ONLY_HOLD);

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

/** Admin note for rows the next scheduled run will not pay — a calendar slot is not an approval. */
export function payoutAccountNotScheduledNote(hold_reason: PayoutAccountHoldReason | null): string {
  switch (hold_reason) {
    case PAYOUT_ACCOUNT_HOLD_REASON.DELETED_DRIVER_REVIEW:
      return "Not scheduled — deleted driver, review required";
    case PAYOUT_ACCOUNT_HOLD_REASON.DRIVER_STATUS_HOLD:
      return "Not scheduled — driver status hold";
    case PAYOUT_ACCOUNT_HOLD_REASON.ADMIN_HOLD:
      return "Not scheduled — payouts paused";
    case PAYOUT_ACCOUNT_HOLD_REASON.PAYOUTS_DISABLED:
      return "Not scheduled — payouts disabled";
    case PAYOUT_ACCOUNT_HOLD_REASON.DRIVER_NOT_APPROVED:
      return "Not scheduled — driver not approved";
    case PAYOUT_ACCOUNT_HOLD_REASON.NO_VERIFIED_DESTINATION:
      return "Not scheduled — no verified payout destination";
    default:
      return "Not scheduled — nothing payable";
  }
}

/** Σ early cash-out fees charged on the transfer but never written as CASHOUT_FEE, per driver. */
export async function loadUnrecordedCashoutFeePenceByDriver(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  driverIds: readonly string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (driverIds.length === 0) return out;
  const { data, error } = await supabase
    .from("early_cashout_invariant_audit")
    .select("driver_id, fee_pence, ledger_fee_pence, invariant_holds")
    .in("driver_id", [...driverIds])
    .eq("invariant_holds", false);
  if (error) {
    console.warn("[payoutAccountComposition] cash-out fee audit unavailable", error.message);
    return out;
  }
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const gap = Math.max(0, pence(row.fee_pence) - Math.abs(pence(row.ledger_fee_pence)));
    if (gap <= 0) continue;
    const id = String(row.driver_id ?? "");
    out.set(id, (out.get(id) ?? 0) + gap);
  }
  return out;
}

/** Europe/London start of today, this ISO week (Monday) and this month. */
export function londonPaidPeriodStarts(now: Date = new Date()): {
  day: Date;
  week: Date;
  month: Date;
  year: Date;
} {
  const { y, m, d } = getLondonCalendarParts(now);
  const londonMidnight = (yy: number, mm: number, dd: number) =>
    getLondonDayBounds(new Date(Date.UTC(yy, mm - 1, dd, 12, 0, 0))).start;
  const daysSinceMonday = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  return {
    day: londonMidnight(y, m, d),
    week: londonMidnight(y, m, d - daysSinceMonday),
    month: londonMidnight(y, m, 1),
    year: londonMidnight(y, 1, 1),
  };
}
