/**
 * Admin trip page ownership for no-show vs missed/cancelled.
 *
 * Product rule:
 * - No-show is a terminal history outcome (Trip History).
 * - No-show must NOT appear in Missed & Cancelled.
 * - Display only — no Payment Sessions / wallet / payout / Revolut writes.
 */

export const MISSED_CANCELLED_STATUSES = [
  "cancelled",
  "customer_cancelled",
  "missed",
  "expired",
] as const;

export type AdminTripClassificationRow = {
  status?: string | null;
  financial_outcome?: string | null;
  payment_status?: string | null;
  cancellation_reason?: string | null;
  terminal_reason?: string | null;
  terminal_disposition_reason?: string | null;
  no_show_charge_pence?: number | null;
  capture_amount_pence?: number | null;
  captured_amount_pence?: number | null;
  ps_captured_pence?: number | null;
  completed_at?: string | null;
  cancelled_at?: string | null;
  created_at?: string | null;
  payment_disposition?: {
    is_no_show_outcome?: boolean;
    terminal_disposition_reason?: string | null;
    payment_label?: string | null;
  } | null;
};

function blobIncludesNoShow(value: string | null | undefined): boolean {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/-/g, "_");
  return normalized.includes("no_show") || normalized.includes("noshow");
}

export function isAdminNoShowTrip(row: AdminTripClassificationRow | null | undefined): boolean {
  if (!row) return false;
  if (row.payment_disposition?.is_no_show_outcome) return true;

  const dispoReason = String(
    row.terminal_disposition_reason
      ?? row.payment_disposition?.terminal_disposition_reason
      ?? "",
  ).trim().toUpperCase();
  if (dispoReason === "CUSTOMER_NO_SHOW" || dispoReason === "NO_SHOW") return true;

  const status = String(row.status ?? "").trim().toLowerCase();
  if (status === "no_show") return true;

  const outcome = String(row.financial_outcome ?? "").trim().toUpperCase();
  if (outcome === "NO_SHOW") return true;

  const terminalReason = String(row.terminal_reason ?? "").trim().toLowerCase();
  if (terminalReason === "no_show") return true;

  if (blobIncludesNoShow(row.payment_status)) return true;
  if (blobIncludesNoShow(row.cancellation_reason)) return true;
  if (blobIncludesNoShow(row.payment_disposition?.payment_label)) return true;

  const charge = Number(row.no_show_charge_pence);
  if (Number.isFinite(charge) && charge > 0) return true;

  return false;
}

/** Trip History status badge — explicit fallbacks before generic Completed. */
export function tripHistoryNoShowDisplayLabel(
  row: AdminTripClassificationRow | null | undefined,
): string | null {
  if (!row) return null;
  if (isAdminNoShowTrip(row)) return "No-show";
  if (String(row.status ?? "").trim().toLowerCase() === "no_show") return "No-show";
  if (String(row.financial_outcome ?? "").trim().toUpperCase() === "NO_SHOW") return "No-show";
  if (blobIncludesNoShow(row.payment_status)) return "No-show";
  if (blobIncludesNoShow(row.cancellation_reason)) return "No-show";
  if (row.payment_disposition?.is_no_show_outcome) return "No-show";
  return null;
}

/** Missed & Cancelled bucket — cancels/missed/expired only; never no-show. */
export function belongsInMissedCancelled(
  row: AdminTripClassificationRow | null | undefined,
): boolean {
  if (!row) return false;
  if (isAdminNoShowTrip(row)) return false;
  const status = String(row.status ?? "").trim().toLowerCase();
  return (MISSED_CANCELLED_STATUSES as readonly string[]).includes(status);
}

/** Trip History bucket — completed + no-show terminal outcomes. */
export function belongsInTripHistory(
  row: AdminTripClassificationRow | null | undefined,
): boolean {
  if (!row) return false;
  if (isAdminNoShowTrip(row)) return true;
  const status = String(row.status ?? "").trim().toLowerCase();
  if (status === "completed") return true;
  const outcome = String(row.financial_outcome ?? "").trim().toUpperCase();
  return outcome === "COMPLETED" || outcome === "LATE_PASSENGER_CANCELLATION";
}

export function adminNoShowStatusLabel(
  row: AdminTripClassificationRow | null | undefined,
): string | null {
  if (!isAdminNoShowTrip(row)) return null;
  return "No-show";
}

export function resolveAdminCapturedPenceForNoShowLabel(
  row: AdminTripClassificationRow | null | undefined,
): number {
  if (!row) return 0;
  for (const raw of [row.ps_captured_pence, row.captured_amount_pence, row.capture_amount_pence]) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  }
  const charge = Number(row.no_show_charge_pence);
  if (Number.isFinite(charge) && charge > 0) return Math.round(charge);
  return 0;
}

/** Payment lifecycle label for no-show rows in Trip History. */
export function adminNoShowPaymentLabel(
  row: AdminTripClassificationRow | null | undefined,
  capturedPenceOverride?: number | null,
): string | null {
  if (!isAdminNoShowTrip(row)) return null;
  const captured =
    capturedPenceOverride != null && Number.isFinite(Number(capturedPenceOverride))
      ? Math.round(Number(capturedPenceOverride))
      : resolveAdminCapturedPenceForNoShowLabel(row);
  return captured > 0 ? "No-show fee captured" : "No-show - no charge";
}

/** Prefer completed_at; for no-show without it, fall back to cancelled_at then created_at. */
export function adminTripHistoryDisplayAt(
  row: AdminTripClassificationRow | null | undefined,
): string | null {
  if (!row) return null;
  if (row.completed_at) return row.completed_at;
  if (isAdminNoShowTrip(row) && row.cancelled_at) return row.cancelled_at;
  if (isAdminNoShowTrip(row) && row.created_at) return row.created_at;
  return row.completed_at ?? null;
}
