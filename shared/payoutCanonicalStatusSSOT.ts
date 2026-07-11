export const CANONICAL_PAYOUT_BATCH_STATUSES = [
  "DRAFT",
  "SCHEDULED",
  "VALIDATING",
  "PROCESSING",
  "PARTIALLY_COMPLETED",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;

export const CANONICAL_PAYOUT_ITEM_STATUSES = [
  "PENDING",
  "ELIGIBILITY_HOLD",
  "SCHEDULED",
  "PROCESSING",
  "TRANSFER_CREATED",
  "PAID",
  "FAILED",
  "CANCELLED",
  "REVERSED",
  "MANUAL_REVIEW",
  "PROVIDER_CONFIRMATION_PENDING",
] as const;

export type CanonicalPayoutBatchStatus = (typeof CANONICAL_PAYOUT_BATCH_STATUSES)[number];
export type CanonicalPayoutItemStatus = (typeof CANONICAL_PAYOUT_ITEM_STATUSES)[number];

const ITEM_STATUS_ALIASES: Record<string, CanonicalPayoutItemStatus> = {
  pending: "PENDING",
  created: "PENDING",
  ready: "SCHEDULED",
  queued: "SCHEDULED",
  scheduled: "SCHEDULED",
  on_hold: "ELIGIBILITY_HOLD",
  eligibility_hold: "ELIGIBILITY_HOLD",
  blocked: "ELIGIBILITY_HOLD",
  processing: "PROCESSING",
  in_progress: "PROCESSING",
  submitted: "PROCESSING",
  sent: "TRANSFER_CREATED",
  transfer_created: "TRANSFER_CREATED",
  provider_confirmation_pending: "PROVIDER_CONFIRMATION_PENDING",
  pending_provider: "PROVIDER_CONFIRMATION_PENDING",
  completed: "PAID",
  complete: "PAID",
  paid: "PAID",
  succeeded: "PAID",
  failed: "FAILED",
  error: "FAILED",
  ledger_sync_failed: "FAILED",
  failed_duplicate: "FAILED",
  cancelled: "CANCELLED",
  canceled: "CANCELLED",
  returned: "REVERSED",
  reversed: "REVERSED",
  manual_review: "MANUAL_REVIEW",
};

const BATCH_STATUS_ALIASES: Record<string, CanonicalPayoutBatchStatus> = {
  draft: "DRAFT",
  created: "DRAFT",
  pending: "SCHEDULED",
  ready: "SCHEDULED",
  scheduled: "SCHEDULED",
  validating: "VALIDATING",
  processing: "PROCESSING",
  in_progress: "PROCESSING",
  sent: "PROCESSING",
  partial: "PARTIALLY_COMPLETED",
  partial_settlement: "PARTIALLY_COMPLETED",
  partially_completed: "PARTIALLY_COMPLETED",
  completed: "COMPLETED",
  complete: "COMPLETED",
  paid: "COMPLETED",
  failed: "FAILED",
  blocked: "FAILED",
  invalid_orphaned: "FAILED",
  cancelled: "CANCELLED",
  canceled: "CANCELLED",
  returned: "CANCELLED",
};

function key(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase();
}

export function normalizePayoutItemStatus(raw: unknown): CanonicalPayoutItemStatus {
  return ITEM_STATUS_ALIASES[key(raw)] ?? "PENDING";
}

export function normalizePayoutBatchStatus(raw: unknown): CanonicalPayoutBatchStatus {
  return BATCH_STATUS_ALIASES[key(raw)] ?? "DRAFT";
}

/**
 * DB writes stay on legacy lowercase values until payout_items.status CHECK widens.
 * Canonical PAID/PENDING/FAILED/PROCESSING map to completed/pending/failed/processing.
 * Hold/review/provider states are persisted as pending with metadata/failure_reason.
 */
export function toDbItemStatus(status: CanonicalPayoutItemStatus): string {
  if (status === "PAID") return "completed";
  if (status === "FAILED") return "failed";
  if (status === "PROCESSING" || status === "TRANSFER_CREATED" || status === "PROVIDER_CONFIRMATION_PENDING") {
    return "processing";
  }
  if (status === "CANCELLED" || status === "REVERSED") return "failed";
  return "pending";
}

/**
 * DB writes stay on legacy lowercase values until payout_batches.status CHECK widens.
 * Canonical COMPLETED/SCHEDULED/FAILED/PROCESSING map to completed/pending/failed/processing.
 */
export function toDbBatchStatus(status: CanonicalPayoutBatchStatus): string {
  if (status === "COMPLETED") return "completed";
  if (status === "FAILED" || status === "CANCELLED") return "failed";
  if (status === "PROCESSING" || status === "VALIDATING") return "processing";
  return "pending";
}
