/**
 * Admin Payout Ledger (SSOT) — provider-neutral list contract.
 * Owns ALL outgoing money: driver payouts + company transfers.
 * Never owns customer payments, DWL balance math, or FR.
 */

import type { CompanyBalanceSnapshot } from "./companyBalanceSSOT.ts";
import type { PayoutLedgerOverviewDto } from "./payoutLedgerOverviewSSOT.ts";
import type { PayoutScheduleDto } from "./payoutScheduleSSOT.ts";
import type { CompanyFundingClassifiedSource } from "./payoutLedgerCompanyFundingSSOT.ts";

export const ADMIN_PAYOUT_LEDGER_FN = "admin-payout-ledger";
export const ADMIN_COMPANY_TRANSFER_FN = "admin-company-outgoing-transfer";
export const ADMIN_COMPANY_PAYEES_FN = "admin-company-payees";
export const ADMIN_SUBMIT_COMPANY_TRANSFER_FN = "admin-submit-company-transfer-payment";
export const ADMIN_FINALIZE_COMPANY_TRANSFER_FN = "admin-finalize-company-transfer-completion";
export const ADMIN_SYNC_COMPANY_TRANSFER_STATUS_FN = "admin-sync-company-transfer-provider-status";

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
  /** Canonical display status (NOT_SUBMITTED / COMPLETED / …). */
  display_status?: string | null;
  display_status_label?: string | null;
  execution_status?: string | null;
  reservation_status?: string | null;
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
  /** DWL live wallet balance — liability, not always payable. */
  live_balance_pence?: number;
  available_balance_pence: number;
  pending_balance_pence: number;
  debt_pence: number;
  /** Machine-readable hold when live > 0 and available = 0. */
  unavailable_reason?: string | null;
  /** Count of eligibility-proven ledger credits included in available. */
  eligible_entry_count?: number;
  /** Display label for payout destination (manual bank / provider account). */
  payout_destination?: string | null;
  next_scheduled_at: string | null;
  /** Backend-formatted local next run (Europe/London wall clock) — never browser-local. */
  next_scheduled_local?: string | null;
  last_payout_at: string | null;
  last_payout_amount_pence: number | null;
  schedule_label: string | null;
  payout_status: string;
  paused: boolean;
};

export type AdminPayoutLedgerFleetSummary = {
  /** Σ live DWL balances for listed drivers. */
  total_live_wallet_pence?: number;
  total_available_pence: number;
  total_pending_pence?: number;
  total_outstanding_debt_pence?: number;
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
  eligible_driver_count?: number;
  held_driver_count?: number;
  scheduled_payouts_count?: number;
  processing_payouts_count?: number;
  completed_payouts_count?: number;
  /** Present when next batch must not be created. */
  zero_batch_guard?: string | null;
};

/**
 * Combined top Overview widgets — backend only, no React sums.
 * Extends the PL Overview DTO; legacy aliases kept for older cards.
 */
export type AdminPayoutLedgerOverviewSummary = PayoutLedgerOverviewDto & {
  /** @deprecated use driver_pending_pence / payout_scheduled_pence */
  driver_payouts_pending_pence?: number;
  /** @deprecated use payout_scheduled_pence */
  driver_payouts_scheduled_pence?: number;
  /** @deprecated use payout_paid_today_pence */
  driver_payouts_completed_today_pence?: number;
  /** @deprecated use company_payables_pending_pence */
  company_transfers_pending_pence?: number;
  /** @deprecated use company_transfers_paid_today_pence */
  company_transfers_completed_today_pence?: number;
  /** @deprecated use payout_failed_count + company_transfers_failed_count */
  failed_transfers_count?: number;
  /** @deprecated use company_awaiting_approval_count */
  awaiting_approval_count?: number;
  schedule_label?: string | null;
  next_run_at_local?: string | null;
  payout_schedule?: PayoutScheduleDto;
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
  /** Slice 11 */
  blocked_reason_codes?: string[] | null;
  approval_funding_snapshot?: Record<string, unknown> | null;
  pre_execution_funding_snapshot?: Record<string, unknown> | null;
  blocked_at?: string | null;
  ready_for_execution_at?: string | null;
  payee_id?: string | null;
  /** Slice 12 provider lifecycle */
  provider_state?: string | null;
  provider_transaction_id?: string | null;
  provider_created_at?: string | null;
  provider_completed_at?: string | null;
  last_provider_sync_at?: string | null;
  funding_hold_status?: string | null;
  provider_payment_id_masked?: string | null;
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
  /** Human status for UI (e.g. "Execution disabled"). Falls back to status. */
  status_label?: string | null;
  schedule_occurrence_key?: string | null;
  schedule_id?: string | null;
  scheduled_local_at?: string | null;
  scheduled_utc_at?: string | null;
  timezone?: string | null;
  currency?: string | null;
  eligible_driver_count?: number | null;
  /** Always false for Slice 5 blocked batches — never claim paid. */
  paid_claim?: boolean;
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
  /** Alias of success for Slice A structured contract. */
  ok?: boolean;
  page_status: AdminPayoutLedgerPageStatus;
  tab: AdminPayoutLedgerTab;
  items: AdminPayoutLedgerItemRow[];
  batches: AdminPayoutLedgerBatchRow[];
  accounts?: DriverPayoutAccountRow[];
  fleet_summary?: AdminPayoutLedgerFleetSummary;
  overview_summary?: AdminPayoutLedgerOverviewSummary;
  company_balance?: CompanyBalanceSnapshot;
  payout_schedule?: PayoutScheduleDto;
  /** Backend KPIs for Company Transfers tab — no React money sums. */
  company_transfer_kpis?: {
    awaiting_approval_count: number;
    approved_payables_pending_pence: number;
    processing_pence: number;
    /** @deprecated Prefer completed_driver_payouts_month_pence */
    completed_month_pence: number;
    completed_driver_payouts_month_pence: number;
    completed_company_transfers_month_pence: number;
    failed_count: number;
  };
  company_transfers_empty_copy?: string;
  /** Sanitised machine code when page_status is not LIVE. */
  error_code?: string | null;
  /** Company Transfers remain display-only while LIVE_PAYOUT is disabled. */
  company_transfers_read_only?: boolean;
  live_payout_execution_enabled?: boolean;
  /** Root-level section statuses (Slice E). */
  sections?: NonNullable<CompanyBalanceSnapshot["sections"]>;
  provider_balance?: CompanyBalanceSnapshot["sections"] extends infer S
    ? S extends { provider_balance: infer P } ? P : never
    : never;
  driver_liabilities?: CompanyBalanceSnapshot["sections"] extends infer S
    ? S extends { driver_liabilities: infer P } ? P : never
    : never;
  reserved_driver_payouts?: CompanyBalanceSnapshot["sections"] extends infer S
    ? S extends { reserved_driver_payouts: infer P } ? P : never
    : never;
  approved_company_payables?: CompanyBalanceSnapshot["sections"] extends infer S
    ? S extends { approved_company_payables: infer P } ? P : never
    : never;
  operational_reserve?: CompanyBalanceSnapshot["sections"] extends infer S
    ? S extends { operational_reserve: infer P } ? P : never
    : never;
  company_transfer_available?: CompanyBalanceSnapshot["sections"] extends infer S
    ? S extends { company_transfer_available: infer P } ? P : never
    : never;
  company_transfers?: CompanyOutgoingTransferRow[];
  company_batches?: CompanyOutgoingBatchRow[];
  company_audit_rows?: CompanyOutgoingAuditRow[];
  /** Company-owned cash classification for Audit History tab. */
  company_funding_audit?: CompanyFundingClassifiedSource[];
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
