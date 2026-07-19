/**
 * Driver payout batch / item display SSOT (read-model only).
 * Never mutates wallets, reservations, or provider payments.
 *
 * Hard rule: a payout workflow record without a permanent wallet debit must
 * never be presented as money outside the Live Wallet.
 */

export const DRIVER_PAYOUT_ITEM_DISPLAY = {
  NOT_SUBMITTED: "NOT_SUBMITTED",
  RESERVED: "RESERVED",
  SUBMITTED: "SUBMITTED",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  DECLINED: "DECLINED",
  /** Unpaid / released / still inside Live Wallet — not an extra balance. */
  CARRIED_FORWARD: "CARRIED_FORWARD",
  UNKNOWN: "UNKNOWN",
} as const;

export type DriverPayoutItemDisplayStatus =
  (typeof DRIVER_PAYOUT_ITEM_DISPLAY)[keyof typeof DRIVER_PAYOUT_ITEM_DISPLAY];

export const CARRIED_FORWARD_SUPPORTING_TEXT = "Included in Live Wallet" as const;

export const CARRIED_FORWARD_REASON_LABEL = {
  BELOW_WEEKLY_MINIMUM_THRESHOLD: "Below weekly minimum threshold",
} as const;

const COMPLETED_ITEM = new Set([
  "completed",
  "paid",
  "succeeded",
]);

const FAILED_ITEM = new Set([
  "failed",
  "error",
  "declined",
  "cancelled",
  "canceled",
  "reversed",
  "reverted",
]);

const RESERVED_OR_BLOCKED = new Set([
  "reserved",
  "reserving",
  "blocked_execution_disabled",
  "funds_reserved_execution_disabled",
]);

const SUBMITTED_ITEM = new Set([
  "submitted",
  "submitting",
  "processing",
  "in_progress",
  "pending_provider",
  "provider_submission_in_progress",
]);

export function isDriverPayoutItemCompleted(status: string | null | undefined): boolean {
  return COMPLETED_ITEM.has(String(status ?? "").trim().toLowerCase());
}

function hasPermanentWalletDebit(args: {
  wallet_ledger_entry_id?: string | null;
  wallet_debited?: boolean | null;
  debit_ledger_entry_id?: string | null;
}): boolean {
  if (args.wallet_debited === true) return true;
  if (String(args.wallet_ledger_entry_id ?? "").trim()) return true;
  if (String(args.debit_ledger_entry_id ?? "").trim()) return true;
  return false;
}

/**
 * Workflow row that never left Live Wallet: not submitted, not paid,
 * reservation released (or marked INELIGIBLE), no permanent debit.
 */
export function isCarriedForwardPayoutItem(args: {
  status?: string | null;
  execution_status?: string | null;
  completed_at?: string | null;
  paid_at?: string | null;
  reservation_status?: string | null;
  wallet_ledger_entry_id?: string | null;
  wallet_debited?: boolean | null;
  debit_ledger_entry_id?: string | null;
}): boolean {
  const st = String(args.status ?? "").trim().toLowerCase();
  const exec = String(args.execution_status ?? "").trim().toLowerCase();
  if (COMPLETED_ITEM.has(st) || COMPLETED_ITEM.has(exec) || args.completed_at || args.paid_at) {
    return false;
  }
  if (SUBMITTED_ITEM.has(st) || SUBMITTED_ITEM.has(exec)) return false;
  if (hasPermanentWalletDebit(args)) return false;

  const reservation = String(args.reservation_status ?? "").trim().toUpperCase();
  if (reservation === "ACTIVE" || reservation === "CONSUMED") return false;

  const released = reservation === "RELEASED";
  const ineligible = st === "ineligible" || exec === "ineligible";
  return released || ineligible;
}

export function resolveCarriedForwardReasonLabel(
  releaseReason?: string | null,
  failureReason?: string | null,
): string | null {
  const raw = String(releaseReason ?? failureReason ?? "").trim();
  if (!raw) return null;
  const key = raw.toUpperCase().replace(/\s+/g, "_");
  if (key === "BELOW_WEEKLY_MINIMUM_THRESHOLD") {
    return CARRIED_FORWARD_REASON_LABEL.BELOW_WEEKLY_MINIMUM_THRESHOLD;
  }
  return raw.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Canonical item display — Ahmed RESERVED → NOT_SUBMITTED; released/INELIGIBLE → CARRIED_FORWARD. */
export function resolveDriverPayoutItemDisplayStatus(args: {
  status?: string | null;
  execution_status?: string | null;
  completed_at?: string | null;
  paid_at?: string | null;
  reservation_status?: string | null;
  wallet_ledger_entry_id?: string | null;
  wallet_debited?: boolean | null;
  debit_ledger_entry_id?: string | null;
}): DriverPayoutItemDisplayStatus {
  const st = String(args.status ?? "").trim().toLowerCase();
  const exec = String(args.execution_status ?? "").trim().toLowerCase();
  if (COMPLETED_ITEM.has(st) || COMPLETED_ITEM.has(exec) || args.completed_at) {
    if (COMPLETED_ITEM.has(st) || COMPLETED_ITEM.has(exec)) {
      return DRIVER_PAYOUT_ITEM_DISPLAY.COMPLETED;
    }
  }
  if (st === "declined" || exec === "declined") return DRIVER_PAYOUT_ITEM_DISPLAY.DECLINED;
  if (FAILED_ITEM.has(st) || FAILED_ITEM.has(exec)) return DRIVER_PAYOUT_ITEM_DISPLAY.FAILED;
  if (SUBMITTED_ITEM.has(st) || SUBMITTED_ITEM.has(exec)) {
    return DRIVER_PAYOUT_ITEM_DISPLAY.SUBMITTED;
  }
  if (isCarriedForwardPayoutItem(args)) {
    return DRIVER_PAYOUT_ITEM_DISPLAY.CARRIED_FORWARD;
  }
  if (
    RESERVED_OR_BLOCKED.has(st)
    || RESERVED_OR_BLOCKED.has(exec)
    || String(args.reservation_status ?? "").toUpperCase() === "ACTIVE"
  ) {
    return DRIVER_PAYOUT_ITEM_DISPLAY.NOT_SUBMITTED;
  }
  if (st === "unknown" || exec === "unknown") return DRIVER_PAYOUT_ITEM_DISPLAY.UNKNOWN;
  return DRIVER_PAYOUT_ITEM_DISPLAY.NOT_SUBMITTED;
}

export function resolveDriverPayoutItemDisplayLabel(
  display: DriverPayoutItemDisplayStatus,
): string {
  switch (display) {
    case "NOT_SUBMITTED":
      return "Not submitted";
    case "RESERVED":
      return "Reserved";
    case "SUBMITTED":
      return "Submitted to provider";
    case "COMPLETED":
      return "Completed";
    case "FAILED":
      return "Failed";
    case "DECLINED":
      return "Provider declined";
    case "CARRIED_FORWARD":
      return "Carried forward";
    default:
      return "Unknown";
  }
}

export type DriverPayoutItemDisplayPresentation = {
  display_status: DriverPayoutItemDisplayStatus;
  display_status_label: string;
  supporting_text: string | null;
  reason_label: string | null;
  /** True when amount is a subset of Live Wallet, not an additive unpaid balance. */
  included_in_live_wallet: boolean;
};

export function resolveDriverPayoutItemDisplayPresentation(args: {
  status?: string | null;
  execution_status?: string | null;
  completed_at?: string | null;
  paid_at?: string | null;
  reservation_status?: string | null;
  wallet_ledger_entry_id?: string | null;
  wallet_debited?: boolean | null;
  debit_ledger_entry_id?: string | null;
  release_reason?: string | null;
  failure_reason?: string | null;
}): DriverPayoutItemDisplayPresentation {
  const display_status = resolveDriverPayoutItemDisplayStatus(args);
  const carried = display_status === DRIVER_PAYOUT_ITEM_DISPLAY.CARRIED_FORWARD;
  return {
    display_status,
    display_status_label: resolveDriverPayoutItemDisplayLabel(display_status),
    supporting_text: carried ? CARRIED_FORWARD_SUPPORTING_TEXT : null,
    reason_label: carried
      ? resolveCarriedForwardReasonLabel(args.release_reason, args.failure_reason)
      : null,
    included_in_live_wallet: carried,
  };
}

/**
 * Admin/driver summary composition — display only.
 * carried + new_earnings = live (never present carried as outside live).
 */
export function buildLiveWalletCompositionDisplay(args: {
  live_balance_pence: number;
  carried_forward_pence: number;
}): {
  live_balance_pence: number;
  carried_forward_pence: number;
  new_earnings_pence: number;
} {
  const live = Math.max(0, Math.round(Number(args.live_balance_pence ?? 0)));
  const carriedRaw = Math.max(0, Math.round(Number(args.carried_forward_pence ?? 0)));
  const carried = Math.min(live, carriedRaw);
  return {
    live_balance_pence: live,
    carried_forward_pence: carried,
    new_earnings_pence: Math.max(0, live - carried),
  };
}

export function sumCarriedForwardPayoutItemsPence(
  items: ReadonlyArray<{
    amount_pence?: number | null;
    net_bank_transfer_pence?: number | null;
    display_status?: string | null;
    status?: string | null;
    execution_status?: string | null;
    reservation_status?: string | null;
    paid_at?: string | null;
    completed_at?: string | null;
    wallet_ledger_entry_id?: string | null;
  }>,
): number {
  let sum = 0;
  for (const item of items) {
    const display = String(item.display_status ?? "").toUpperCase() === "CARRIED_FORWARD"
      || isCarriedForwardPayoutItem(item);
    if (!display) continue;
    const amt = item.net_bank_transfer_pence ?? item.amount_pence ?? 0;
    sum += Math.max(0, Math.round(Number(amt)));
  }
  return sum;
}

/**
 * Batch aggregate from item statuses.
 * Mix of completed + unfinished → PARTIALLY_COMPLETED (never claim full COMPLETED;
 * never leave generic PROVIDER_SUBMISSION_PARTIAL once a child is COMPLETED).
 */
export function aggregateDriverPayoutBatchStatus(
  items: ReadonlyArray<{ status?: string | null; execution_status?: string | null }>,
  storedStatus?: string | null,
): {
  status: string;
  status_label: string;
  successful_payouts: number;
  unfinished_payouts: number;
  total_items: number;
} {
  const total = items.length;
  let successful = 0;
  let unfinished = 0;
  for (const item of items) {
    const display = resolveDriverPayoutItemDisplayStatus(item);
    if (display === "COMPLETED") successful += 1;
    else unfinished += 1;
  }

  const stored = String(storedStatus ?? "").trim().toUpperCase();
  let status = stored || "DRAFT";
  let status_label = stored || "Draft";

  if (total > 0 && successful > 0 && unfinished > 0) {
    status = "PARTIALLY_COMPLETED";
    status_label = "Partially completed";
  } else if (total > 0 && successful === total) {
    status = "COMPLETED";
    status_label = "Completed";
  } else if (total > 0 && successful === 0) {
    if (
      stored === "PROVIDER_SUBMISSION_PARTIAL"
      || stored === "PROVIDER_SUBMISSION_IN_PROGRESS"
    ) {
      status = stored;
      status_label = "Provider submission in progress";
    } else if (stored === "FUNDS_RESERVED_EXECUTION_DISABLED") {
      status = stored;
      status_label = "Funds reserved — execution disabled";
    }
  } else if (stored === "PROVIDER_SUBMISSION_PARTIAL" && successful > 0) {
    // Safety: never leave PROVIDER_SUBMISSION_PARTIAL when completed children exist.
    status = unfinished > 0 ? "PARTIALLY_COMPLETED" : "COMPLETED";
    status_label = unfinished > 0 ? "Partially completed" : "Completed";
  }

  return {
    status,
    status_label,
    successful_payouts: successful,
    unfinished_payouts: unfinished,
    total_items: total,
  };
}

export const COMPANY_TRANSFERS_EMPTY_COPY =
  "No company transfers yet. Driver payouts are shown under Driver Payouts and Batch History." as const;
