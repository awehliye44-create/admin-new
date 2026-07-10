/**
 * Admin Payout Ledger (SSOT) — provider-neutral list contract.
 * Reads existing payout_batches / payout_items / allocations. No duplicate writers.
 */

export const ADMIN_PAYOUT_LEDGER_FN = "admin-payout-ledger";

export type AdminPayoutLedgerTab =
  | "overview"
  | "scheduled"
  | "processing"
  | "completed"
  | "failed"
  | "returned_cancelled"
  | "batches"
  | "history"
  | "settings";

export type AdminPayoutLedgerPageStatus =
  | "LIVE"
  | "PARTIAL"
  | "DEGRADED"
  | "READ_ONLY"
  | "PROVIDER_UNAVAILABLE";

export type AdminPayoutLedgerListRequest = {
  tab?: AdminPayoutLedgerTab;
  driver_id?: string | null;
  service_area_id?: string | null;
  status?: string | null;
  payout_type?: string | null;
  batch_id?: string | null;
  date_from?: string | null;
  date_to?: string | null;
  limit?: number;
};

export type AdminPayoutLedgerItemRow = {
  id: string;
  created_at: string;
  driver_id: string;
  driver_name: string | null;
  service_area_id: string | null;
  service_area_name: string | null;
  payout_type: string | null;
  batch_id: string | null;
  gross_wallet_debit_pence: number | null;
  fees_pence: number | null;
  net_bank_transfer_pence: number | null;
  currency: string;
  provider: string | null;
  provider_payout_id: string | null;
  bank_reference: string | null;
  status: string;
  processing_started_at: string | null;
  paid_at: string | null;
  failure_reason: string | null;
  wallet_ledger_entry_id: string | null;
  allocation_count: number;
  action_policy: {
    can_open_wallet: boolean;
    can_view_allocations: boolean;
    can_open_reconciliation: boolean;
    can_retry: boolean;
    can_cancel: boolean;
    can_inspect_provider: boolean;
  };
};

export type AdminPayoutLedgerBatchRow = {
  id: string;
  created_at: string;
  run_date: string;
  kind: string;
  status: string;
  total_drivers: number | null;
  total_amount_pence: number | null;
  successful_payouts: number | null;
  failed_payouts: number | null;
  completed_at: string | null;
  failure_reason: string | null;
};

export type AdminPayoutLedgerListResponse = {
  success: boolean;
  page_status: AdminPayoutLedgerPageStatus;
  tab: AdminPayoutLedgerTab;
  items: AdminPayoutLedgerItemRow[];
  batches: AdminPayoutLedgerBatchRow[];
  summary: {
    total_items: number;
    scheduled_count: number;
    processing_count: number;
    completed_count: number;
    failed_count: number;
    returned_cancelled_count: number;
    pending_count: number;
    scheduled_today_count: number;
    paid_today_count: number;
    paid_today_pence: number | null;
    total_paid_pence: number | null;
    total_failed_pence: number | null;
    total_paid_week_pence: number | null;
    total_paid_month_pence: number | null;
    total_paid_year_pence: number | null;
  };
  error?: string;
};

export function payoutLedgerUrl(args?: {
  tab?: AdminPayoutLedgerTab;
  driverId?: string | null;
  payoutItemId?: string | null;
  batchId?: string | null;
}): string {
  const params = new URLSearchParams();
  if (args?.tab) params.set("tab", args.tab);
  if (args?.driverId) params.set("driverId", args.driverId);
  if (args?.payoutItemId) params.set("payoutItemId", args.payoutItemId);
  if (args?.batchId) params.set("batchId", args.batchId);
  const qs = params.toString();
  return qs ? `/payout-ledger?${qs}` : "/payout-ledger";
}
