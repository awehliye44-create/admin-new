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
  | "failures"
  | "returned_cancelled"
  | "batches"
  | "history"
  | "transfers"
  | "connected_account"
  | "statements"
  | "audit_log"
  | "settings";

export type AdminPayoutLedgerPageStatus =
  | "LIVE"
  | "PARTIAL"
  | "DEGRADED"
  | "READ_ONLY"
  | "PROVIDER_UNAVAILABLE";

export type AdminPayoutLedgerListRequest = {
  mode?: "accounts_overview" | "list";
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
  /** Connect / KYC verification from drivers SSOT */
  verification_status: string | null;
  /** Masked bank last4 from latest Connect payout evidence */
  bank_account_last4: string | null;
  connected_account_id: string | null;
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

export type DriverPayoutAccountRow = {
  driver_id: string;
  name: string | null;
  code: string | null;
  service_area_id: string | null;
  service_area: string | null;
  tier: string | null;
  provider: string | null;
  connected_account: string | null;
  verification: string | null;
  available_balance_pence: number;
  pending_balance_pence: number;
  debt_pence: number;
  next_scheduled_at: string | null;
  last_payout_at: string | null;
  last_payout_amount_pence: number | null;
  schedule_label: string | null;
  payout_status: string;
  paused: boolean;
};

export type AdminPayoutLedgerFleetSummary = {
  total_available_pence: number;
  total_scheduled_pence: number;
  total_processing_pence: number;
  paid_today_pence: number;
  paid_week_pence: number;
  paid_month_pence: number;
  paid_year_pence: number;
  failed_count: number;
  paused_accounts: number;
  unverified_accounts: number;
  next_batch_amount_pence: number;
  next_batch_driver_count: number;
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

/** Append-only payout_audit_log rows for the Audit Log tab. */
export type AdminPayoutLedgerAuditRow = {
  id: string;
  created_at: string;
  driver_id: string | null;
  payout_type: string | null;
  event_type: string;
  requested_amount_pence: number | null;
  provider_error_code: string | null;
  provider_error_message: string | null;
  metadata: Record<string, unknown> | null;
};

export type AdminPayoutLedgerListResponse = {
  success: boolean;
  page_status: AdminPayoutLedgerPageStatus;
  tab: AdminPayoutLedgerTab;
  items: AdminPayoutLedgerItemRow[];
  batches: AdminPayoutLedgerBatchRow[];
  accounts?: DriverPayoutAccountRow[];
  fleet_summary?: AdminPayoutLedgerFleetSummary;
  audit_rows?: AdminPayoutLedgerAuditRow[];
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
    total_available_pence?: number;
    total_scheduled_pence?: number;
    total_processing_pence?: number;
    paid_week_pence?: number;
    paid_month_pence?: number;
    paid_year_pence?: number;
    paused_accounts?: number;
    unverified_accounts?: number;
    next_batch_amount_pence?: number;
    next_batch_driver_count?: number;
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
