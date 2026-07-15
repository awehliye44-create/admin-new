/**
 * Driver payout batch / item display SSOT (read-model only).
 * Never mutates wallets, reservations, or provider payments.
 */

export const DRIVER_PAYOUT_ITEM_DISPLAY = {
  NOT_SUBMITTED: "NOT_SUBMITTED",
  RESERVED: "RESERVED",
  SUBMITTED: "SUBMITTED",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  DECLINED: "DECLINED",
  UNKNOWN: "UNKNOWN",
} as const;

export type DriverPayoutItemDisplayStatus =
  (typeof DRIVER_PAYOUT_ITEM_DISPLAY)[keyof typeof DRIVER_PAYOUT_ITEM_DISPLAY];

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

/** Canonical item display — Ahmed RESERVED → NOT_SUBMITTED; Bosteyo COMPLETED stays COMPLETED. */
export function resolveDriverPayoutItemDisplayStatus(args: {
  status?: string | null;
  execution_status?: string | null;
  completed_at?: string | null;
  reservation_status?: string | null;
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
    default:
      return "Unknown";
  }
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
