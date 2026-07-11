/**
 * Admin Payout Ledger (SSOT) — provider-neutral list contract.
 * Owns ALL outgoing money: driver payouts + company transfers.
 * Never owns customer payments, DWL balance math, or FR.
 */

export const ADMIN_PAYOUT_LEDGER_FN = "admin-payout-ledger";
export const ADMIN_COMPANY_TRANSFER_FN = "admin-company-outgoing-transfer";

/** Top-level Payout Ledger page tabs (no new route). */
export type AdminPayoutLedgerTopTab =
  | "overview"
  | "driver_payouts"
  | "company_transfers"
  | "batch_history"
  | "failed_transfers"
  | "settings"
  | "audit_history";

/** Driver drill-down tabs (under Driver Payouts). */
export type AdminPayoutLedgerDriverTab =
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

/** @deprecated Prefer AdminPayoutLedgerTopTab | AdminPayoutLedgerDriverTab */
export type AdminPayoutLedgerTab = AdminPayoutLedgerTopTab | AdminPayoutLedgerDriverTab;

export type AdminPayoutLedgerPageStatus =
  | "LIVE"
  | "PARTIAL"
  | "DEGRADED"
  | "READ_ONLY"
  | "PROVIDER_UNAVAILABLE";

export type AdminPayoutLedgerListRequest = {
  mode?:
    | "accounts_overview"
    | "list"
    | "ledger_overview"
    | "company_list"
    | "company_batches"
    | "company_failed"
    | "company_audit";
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
  verification_status: string | null;
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

/** Combined top Overview widgets — backend only, no React sums. */
export type AdminPayoutLedgerOverviewSummary = {
  driver_payouts_pending_pence: number;
  driver_payouts_scheduled_pence: number;
  driver_payouts_completed_today_pence: number;
  company_transfers_pending_pence: number;
  company_transfers_completed_today_pence: number;
  failed_transfers_count: number;
  awaiting_approval_count: number;
  next_scheduled_weekly_driver_payout_at: string | null;
};

export type CompanyOutgoingTransferRow = {
  id: string;
  transfer_ref: string;
  created_at: string;
  recipient_name: string;
  recipient_type: string;
  category: string;
  money_source: string;
  source_account: string | null;
  destination_account: string | null;
  amount_pence: number;
  currency: string;
  purpose: string;
  service_area_id: string | null;
  cost_centre: string | null;
  requested_by: string | null;
  approved_by: string | null;
  approval_count: number;
  approvals_required: number;
  provider: string | null;
  provider_reference: string | null;
  status: string;
  execution_at: string | null;
  failure_reason: string | null;
  provider_error: string | null;
  retry_count: number;
  last_attempt_at: string | null;
  notes: string | null;
  attachment_url: string | null;
  batch_id: string | null;
};

export type CompanyOutgoingBatchRow = {
  id: string;
  batch_ref: string;
  created_at: string;
  batch_type: string;
  provider: string | null;
  status: string;
  transfer_count: number;
  success_count: number;
  failed_count: number;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
};

export type CompanyOutgoingAuditRow = {
  id: string;
  created_at: string;
  transfer_id: string;
  actor_id: string | null;
  event_type: string;
  old_status: string | null;
  new_status: string | null;
  provider: string | null;
  provider_reference: string | null;
  amount_pence: number | null;
  currency: string | null;
  reason: string | null;
  attachment_url: string | null;
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
  overview_summary?: AdminPayoutLedgerOverviewSummary;
  company_transfers?: CompanyOutgoingTransferRow[];
  company_batches?: CompanyOutgoingBatchRow[];
  company_audit_rows?: CompanyOutgoingAuditRow[];
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
  driverTab?: AdminPayoutLedgerDriverTab | null;
}): string {
  const params = new URLSearchParams();
  if (args?.tab) params.set("tab", args.tab);
  if (args?.driverId) params.set("driverId", args.driverId);
  if (args?.driverTab) params.set("driverTab", args.driverTab);
  if (args?.payoutItemId) params.set("payoutItemId", args.payoutItemId);
  if (args?.batchId) params.set("batchId", args.batchId);
  const qs = params.toString();
  return qs ? `/payout-ledger?${qs}` : "/payout-ledger";
}
