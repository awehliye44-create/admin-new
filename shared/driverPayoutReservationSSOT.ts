/**
 * Slice 6 — driver wallet payout reservation SSOT.
 * Reserves funds before provider submission. Never debits permanently, never calls Revolut /pay.
 */

export const RESERVATION_TYPE_DRIVER_PAYOUT = "DRIVER_PAYOUT" as const;

export const RESERVATION_STATUS = {
  PENDING: "PENDING",
  ACTIVE: "ACTIVE",
  RELEASED: "RELEASED",
  CONSUMED: "CONSUMED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
} as const;

export type ReservationStatus =
  (typeof RESERVATION_STATUS)[keyof typeof RESERVATION_STATUS];

export const SLICE6_ITEM_STATUS = {
  CREATED: "CREATED",
  VALIDATED: "VALIDATED",
  RESERVING: "RESERVING",
  RESERVED: "RESERVED",
  BLOCKED_EXECUTION_DISABLED: "BLOCKED_EXECUTION_DISABLED",
  SUBMITTING: "SUBMITTING",
  SUBMITTED: "SUBMITTED",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  RELEASED: "RELEASED",
  REVERSED: "REVERSED",
  CANCELLED: "CANCELLED",
  INELIGIBLE: "INELIGIBLE",
} as const;

export const SLICE6_BATCH_STATUS = {
  FUNDS_RESERVED_EXECUTION_DISABLED: "FUNDS_RESERVED_EXECUTION_DISABLED",
  BLOCKED_EXECUTION_DISABLED: "BLOCKED_EXECUTION_DISABLED",
} as const;

export const ADMIN_FUNDS_RESERVED_LABEL = "Funds reserved — execution disabled";

export const RESERVABLE_ITEM_STATUSES = new Set([
  "VALIDATED",
  "BLOCKED_EXECUTION_DISABLED",
  "RESERVING", // crash recovery / retry
  "RESERVED", // idempotent re-entry
]);

export const NON_RESERVABLE_TERMINAL_ITEM_STATUSES = new Set([
  "PAID",
  "COMPLETED",
  "completed",
  "SUBMITTED",
  "SUBMITTING",
  "SENT",
  "CANCELLED",
  "CANCELLED".toLowerCase(),
  "RELEASED",
  "REVERSED",
  "CONSUMED",
]);

export const RELEASE_REASONS = {
  MANUAL_ADMIN_CANCEL: "MANUAL_ADMIN_CANCEL",
  PROVIDER_SUBMISSION_FAILED: "PROVIDER_SUBMISSION_FAILED",
  DESTINATION_DISABLED: "DESTINATION_DISABLED",
  PAYOUT_ITEM_CANCELLED: "PAYOUT_ITEM_CANCELLED",
  BATCH_CANCELLED: "BATCH_CANCELLED",
  VALIDATION_FAILED: "VALIDATION_FAILED",
  SYSTEM_ROLLBACK: "SYSTEM_ROLLBACK",
} as const;

export const RESERVATION_ERROR = {
  INSUFFICIENT_AVAILABLE_WALLET: "INSUFFICIENT_AVAILABLE_WALLET",
  PAYOUT_ITEM_NOT_RESERVABLE: "PAYOUT_ITEM_NOT_RESERVABLE",
  DESTINATION_NOT_ACTIVE: "DESTINATION_NOT_ACTIVE",
  PROVIDER_LINK_NOT_VERIFIED: "PROVIDER_LINK_NOT_VERIFIED",
  DRIVER_PAYOUT_HELD: "DRIVER_PAYOUT_HELD",
  ACTIVE_RESERVATION_EXISTS: "ACTIVE_RESERVATION_EXISTS",
  CURRENCY_MISMATCH: "CURRENCY_MISMATCH",
  AMOUNT_MISMATCH: "AMOUNT_MISMATCH",
  IDEMPOTENCY_CONFLICT: "IDEMPOTENCY_CONFLICT",
  BATCH_NOT_ELIGIBLE: "BATCH_NOT_ELIGIBLE",
  WALLET_LOCK_TIMEOUT: "WALLET_LOCK_TIMEOUT",
} as const;

/** Ledger types for hold audit — must NOT affect live balance. */
export const PAYOUT_RESERVATION_HOLD = "PAYOUT_RESERVATION_HOLD" as const;
export const PAYOUT_RESERVATION_RELEASE = "PAYOUT_RESERVATION_RELEASE" as const;

export const HOLD_LEDGER_TYPES = new Set<string>([
  PAYOUT_RESERVATION_HOLD,
  PAYOUT_RESERVATION_RELEASE,
]);

export const FORBIDDEN_SLICE6_LEDGER_TYPES = new Set([
  "PAYOUT_PAID",
  "PAYOUT_DEBIT",
  "TRANSFER_COMPLETED",
  "DRIVER_PAYOUT_SETTLED",
  "WEEKLY_PAYOUT",
  "EARLY_CASHOUT",
  "MANUAL_PAYOUT",
  "PAYOUT",
]);

export function reservationIdempotencyKey(payoutItemId: string): string {
  return `driver-payout-reservation:${payoutItemId}`;
}

export function reservationFingerprint(args: {
  payout_item_id: string;
  payout_batch_id: string;
  driver_id: string;
  amount_pence: number;
  currency: string;
}): string {
  const currency = String(args.currency ?? "GBP").toUpperCase();
  const amount = Math.round(Number(args.amount_pence ?? 0));
  return [
    "drv-payout-res-v1",
    args.payout_item_id,
    args.payout_batch_id,
    args.driver_id,
    String(amount),
    currency,
  ].join(":");
}

/** Available after active reservations and other holds. Live balance unchanged. */
export function computeAvailableAfterReservations(args: {
  live_wallet_balance_pence: number;
  active_reservation_pence: number;
  other_holds_pence?: number;
}): number {
  const live = Math.round(Number(args.live_wallet_balance_pence ?? 0));
  const reserved = Math.max(0, Math.round(Number(args.active_reservation_pence ?? 0)));
  const other = Math.max(0, Math.round(Number(args.other_holds_pence ?? 0)));
  return Math.max(0, live - reserved - other);
}

export function computeReservedPence(args: {
  active_reservation_pence: number;
}): number {
  return Math.max(0, Math.round(Number(args.active_reservation_pence ?? 0)));
}

export function resolveIdempotencyDecision(args: {
  existing: {
    idempotency_key: string;
    fingerprint: string;
    status: string;
    amount_pence: number;
    driver_id: string;
    payout_item_id: string;
    currency: string;
  } | null;
  requested: {
    idempotency_key: string;
    fingerprint: string;
    amount_pence: number;
    driver_id: string;
    payout_item_id: string;
    currency: string;
  };
}): "create" | "reuse" | "conflict" {
  if (!args.existing) return "create";
  if (args.existing.idempotency_key !== args.requested.idempotency_key) {
    // different key for same item handled by ACTIVE uniqueness
    return "conflict";
  }
  const sameFingerprint = args.existing.fingerprint === args.requested.fingerprint;
  const sameCore =
    args.existing.payout_item_id === args.requested.payout_item_id &&
    args.existing.driver_id === args.requested.driver_id &&
    Math.round(args.existing.amount_pence) === Math.round(args.requested.amount_pence) &&
    String(args.existing.currency).toUpperCase() ===
      String(args.requested.currency).toUpperCase();
  if (sameFingerprint || sameCore) {
    if (args.existing.status === RESERVATION_STATUS.ACTIVE) return "reuse";
    if (args.existing.status === RESERVATION_STATUS.PENDING) return "reuse";
    return "create";
  }
  return "conflict";
}

export function mayReservePayoutItem(status: string | null | undefined): boolean {
  const s = String(status ?? "").toUpperCase();
  if (NON_RESERVABLE_TERMINAL_ITEM_STATUSES.has(s) ||
    NON_RESERVABLE_TERMINAL_ITEM_STATUSES.has(String(status ?? ""))) {
    return false;
  }
  return RESERVABLE_ITEM_STATUSES.has(s) || RESERVABLE_ITEM_STATUSES.has(String(status ?? ""));
}

export function adminBatchStatusLabelSlice6(status: string): string {
  if (status === SLICE6_BATCH_STATUS.FUNDS_RESERVED_EXECUTION_DISABLED) {
    return ADMIN_FUNDS_RESERVED_LABEL;
  }
  if (status === SLICE6_BATCH_STATUS.BLOCKED_EXECUTION_DISABLED) {
    return "Execution disabled";
  }
  return status;
}

export function adminItemStatusLabelSlice6(status: string): string {
  const s = String(status ?? "").toUpperCase();
  if (s === "RESERVED" || s === "RESERVING") return "Funds reserved — execution disabled";
  if (s === "BLOCKED_EXECUTION_DISABLED") return "Execution disabled";
  return status;
}

/** Driver-facing — never "Paid". */
export function driverReservationStatusLabel(args: {
  has_active_reservation: boolean;
  scheduled?: boolean;
}): "Reserved for payout" | "Scheduled" | null {
  if (args.has_active_reservation) return "Reserved for payout";
  if (args.scheduled) return "Scheduled";
  return null;
}

export function assertSlice6MoneySafety(args: {
  wallet_debited?: boolean;
  revolut_pay_called?: boolean;
  relay_payment_called?: boolean;
  provider_payment_id_created?: boolean;
  slices_7_to_12_started?: boolean;
  permanent_debit_ledger_types?: string[];
}): void {
  if (args.wallet_debited) throw new Error("SLICE6_INVARIANT: permanent wallet debit");
  if (args.revolut_pay_called) throw new Error("SLICE6_INVARIANT: Revolut /pay called");
  if (args.relay_payment_called) throw new Error("SLICE6_INVARIANT: relay payment called");
  if (args.provider_payment_id_created) {
    throw new Error("SLICE6_INVARIANT: provider_payment_id created");
  }
  if (args.slices_7_to_12_started) throw new Error("SLICE6_INVARIANT: slices 7–12 started");
  for (const t of args.permanent_debit_ledger_types ?? []) {
    if (FORBIDDEN_SLICE6_LEDGER_TYPES.has(String(t).toUpperCase())) {
      throw new Error(`SLICE6_INVARIANT: forbidden ledger type ${t}`);
    }
  }
}

export function isLivePayoutExecutionEnabled(
  env: { get(key: string): string | undefined } = typeof Deno !== "undefined"
    ? Deno.env
    : { get: () => undefined },
): boolean {
  return (env.get("LIVE_PAYOUT_EXECUTION_ENABLED") ?? "false").trim().toLowerCase() === "true";
}

export function isRevolutPaymentTransportEnabled(
  env: { get(key: string): string | undefined } = typeof Deno !== "undefined"
    ? Deno.env
    : { get: () => undefined },
): boolean {
  return (env.get("REVOLUT_PAYMENT_TRANSPORT_ENABLED") ?? "false").trim().toLowerCase() === "true";
}

export function sumReservationAmounts(
  rows: Array<{ amount_pence: number; status?: string }>,
  status: string = RESERVATION_STATUS.ACTIVE,
): number {
  return rows
    .filter((r) => !r.status || r.status === status)
    .reduce((s, r) => s + Math.max(0, Math.round(Number(r.amount_pence ?? 0))), 0);
}

/** Proof helpers for Ahmed / Bosteyo Slice 6 expectation. */
export const SLICE6_PROOF_DRIVERS = {
  AHMED_ID: "5ed232c3-8bb5-4085-95d6-73e48e6c5e28",
  AHMED_DEST: "ad3ead22-33ef-403a-a6c9-1fd69255bd3a",
  AHMED_AMOUNT_PENCE: 1001,
  BOSTEYO_ID: "cd8bae4c-3827-4b90-98c6-10be70eb0e52",
  BOSTEYO_DEST: "e9e43f5c-20fe-479e-8cfe-edb7fb3e0784",
  BOSTEYO_AMOUNT_PENCE: 408,
  FLEET_LIVE_PENCE: 1409,
  FLEET_RESERVED_AFTER_PENCE: 1409,
  FLEET_AVAILABLE_AFTER_PENCE: 0,
  OCCURRENCE_KEY: "weekly-payout:milton-keynes:2026-07-14T12:00:00+01:00",
} as const;
