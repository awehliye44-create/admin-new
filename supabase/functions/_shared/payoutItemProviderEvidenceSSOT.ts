/**
 * Payout item ↔ payment-intent provider evidence SSOT (read-model + forward sync).
 *
 * Intent is authoritative when the item's provider columns are empty.
 * Sync is forward-only and never overwrites a conflicting newer terminal outcome.
 * Pure — never mutates wallets or retries provider payments.
 */

const TERMINAL_FAILED = new Set([
  "failed",
  "declined",
  "cancelled",
  "canceled",
  "reversed",
  "reverted",
  "error",
]);

const TERMINAL_COMPLETED = new Set([
  "completed",
  "paid",
  "succeeded",
]);

function norm(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

export type PayoutItemProviderFields = {
  provider_payout_id?: string | null;
  provider_transfer_id?: string | null;
  provider_reference?: string | null;
  provider_status?: string | null;
};

export type PayoutIntentProviderFields = {
  provider_payment_id?: string | null;
  provider_state?: string | null;
  execution_status?: string | null;
};

/**
 * Admin display: prefer item provider id; fall back to intent payment id when empty.
 * Prefer item provider_status; fall back to intent provider_state.
 */
export function resolvePayoutItemProviderEvidenceForDisplay(args: {
  item: PayoutItemProviderFields;
  intent: PayoutIntentProviderFields | null | undefined;
}): {
  provider_payout_id: string | null;
  provider_status: string | null;
  provider_evidence_source: "payout_item" | "payment_intent" | "none";
} {
  const itemId = String(
    args.item.provider_payout_id
      ?? args.item.provider_transfer_id
      ?? args.item.provider_reference
      ?? "",
  ).trim() || null;
  const itemStatus = String(args.item.provider_status ?? "").trim() || null;
  const intentId = String(args.intent?.provider_payment_id ?? "").trim() || null;
  const intentState = String(args.intent?.provider_state ?? "").trim() || null;

  if (itemId || itemStatus) {
    return {
      provider_payout_id: itemId,
      provider_status: itemStatus ?? intentState,
      provider_evidence_source: "payout_item",
    };
  }
  if (intentId || intentState) {
    return {
      provider_payout_id: intentId,
      provider_status: intentState,
      provider_evidence_source: "payment_intent",
    };
  }
  return {
    provider_payout_id: null,
    provider_status: null,
    provider_evidence_source: "none",
  };
}

/**
 * Forward-only patch for payout_items after successful completion.
 * Returns null when no write is safe / needed.
 */
export function planPayoutItemProviderFieldSync(args: {
  item: PayoutItemProviderFields;
  provider_payment_id: string;
  provider_state: string;
}): {
  provider_payout_id: string;
  provider_status: string;
} | null {
  const payId = String(args.provider_payment_id ?? "").trim();
  const state = String(args.provider_state ?? "").trim();
  if (!payId || !state) return null;

  const existingId = String(
    args.item.provider_payout_id
      ?? args.item.provider_transfer_id
      ?? args.item.provider_reference
      ?? "",
  ).trim();
  const existingStatus = norm(args.item.provider_status);

  // Never overwrite a conflicting provider id.
  if (existingId && existingId !== payId) return null;

  // Never overwrite a newer terminal failure with completed.
  if (TERMINAL_FAILED.has(existingStatus) && TERMINAL_COMPLETED.has(norm(state))) {
    return null;
  }

  // Idempotent: already synced.
  if (existingId === payId && existingStatus === norm(state)) {
    return null;
  }

  // Only fill empty status, or refresh when id matches / empty and state is not a downgrade.
  if (existingStatus && TERMINAL_COMPLETED.has(existingStatus) && !TERMINAL_COMPLETED.has(norm(state))) {
    return null;
  }

  return {
    provider_payout_id: payId,
    provider_status: state,
  };
}

/** Snapshot labels — never present prep-time figures as current live balance. */
export const PAYOUT_WALLET_SNAPSHOT_LABEL = {
  balance_at_preparation: "Balance at payout preparation",
  available_at_preparation: "Available at payout preparation",
  current_live: "Current live Driver Wallet balance",
} as const;
