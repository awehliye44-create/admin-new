/**
 * Payout Ledger Overview DTO — backend-built only (no React financial aggregation).
 */

import type { CompanyBalanceSnapshot } from "./companyBalanceSSOT.ts";

export const PAYOUT_LEDGER_ERROR = {
  API_UNAVAILABLE: "PAYOUT_LEDGER_API_UNAVAILABLE",
  PERMISSION_DENIED: "PAYOUT_LEDGER_PERMISSION_DENIED",
  SCHEMA_MISMATCH: "PAYOUT_LEDGER_SCHEMA_MISMATCH",
  SERVICE_AREA_NOT_CONFIGURED: "SERVICE_AREA_NOT_CONFIGURED",
  PAYOUT_PROVIDER_UNAVAILABLE: "PAYOUT_PROVIDER_UNAVAILABLE",
  COMPANY_BALANCE_SOURCE_UNAVAILABLE: "COMPANY_BALANCE_SOURCE_UNAVAILABLE",
  DRIVER_WALLET_SOURCE_UNAVAILABLE: "DRIVER_WALLET_SOURCE_UNAVAILABLE",
} as const;

export type PayoutLedgerOverviewStatus = "LIVE" | "PARTIAL" | "DEGRADED" | "UNAVAILABLE";

export type PayoutLedgerOverviewDto = {
  status: PayoutLedgerOverviewStatus;
  service_area_id: string | null;
  currency: string;
  generated_at: string;

  driver_wallet_total_pence: number | null;
  driver_available_pence: number | null;
  driver_pending_pence: number | null;
  driver_debt_pence: number | null;
  eligible_driver_count: number | null;
  held_driver_count: number | null;

  payout_scheduled_pence: number | null;
  payout_processing_pence: number | null;
  payout_paid_today_pence: number | null;
  payout_paid_week_pence: number | null;
  payout_paid_month_pence: number | null;
  payout_failed_count: number | null;

  company_balance_pence: number | null;
  company_available_for_transfer_pence: number | null;
  company_payables_pending_pence: number | null;
  company_transfers_processing_pence: number | null;
  company_transfers_paid_today_pence: number | null;
  company_transfers_failed_count: number | null;
  company_awaiting_approval_count: number | null;

  next_driver_batch_amount_pence: number | null;
  next_driver_batch_count: number | null;
  next_scheduled_weekly_driver_payout_at: string | null;

  evidence_status: string;
  unavailable_reason: string | null;
  section_errors: string[];

  sources: {
    driver_wallet: string;
    driver_payouts: string;
    company_balance: string;
    company_transfers: string;
  };

  company_balance?: CompanyBalanceSnapshot;
};

export function emptyPayoutLedgerOverviewDto(args?: {
  service_area_id?: string | null;
  currency?: string | null;
  status?: PayoutLedgerOverviewStatus;
  unavailable_reason?: string | null;
  now?: Date;
}): PayoutLedgerOverviewDto {
  return {
    status: args?.status ?? "UNAVAILABLE",
    service_area_id: args?.service_area_id ?? null,
    currency: String(args?.currency ?? "GBP").toUpperCase(),
    generated_at: (args?.now ?? new Date()).toISOString(),
    driver_wallet_total_pence: null,
    driver_available_pence: null,
    driver_pending_pence: null,
    driver_debt_pence: null,
    eligible_driver_count: null,
    held_driver_count: null,
    payout_scheduled_pence: null,
    payout_processing_pence: null,
    payout_paid_today_pence: null,
    payout_paid_week_pence: null,
    payout_paid_month_pence: null,
    payout_failed_count: null,
    company_balance_pence: null,
    company_available_for_transfer_pence: null,
    company_payables_pending_pence: null,
    company_transfers_processing_pence: null,
    company_transfers_paid_today_pence: null,
    company_transfers_failed_count: null,
    company_awaiting_approval_count: null,
    next_driver_batch_amount_pence: null,
    next_driver_batch_count: null,
    next_scheduled_weekly_driver_payout_at: null,
    evidence_status: "UNAVAILABLE",
    unavailable_reason: args?.unavailable_reason ?? PAYOUT_LEDGER_ERROR.API_UNAVAILABLE,
    section_errors: args?.unavailable_reason ? [args.unavailable_reason] : [],
    sources: {
      driver_wallet: "Driver Wallet Ledger SSOT",
      driver_payouts: "payout_items / payout_batches",
      company_balance: "Company Balance SSOT",
      company_transfers: "company_outgoing_transfers",
    },
  };
}

/** Merge section results into a partial-capable overview DTO. */
export function finalisePayoutLedgerOverviewStatus(
  dto: PayoutLedgerOverviewDto,
): PayoutLedgerOverviewDto {
  const errors = [...dto.section_errors];
  const driverOk = dto.driver_wallet_total_pence != null || dto.driver_available_pence != null;
  const companyOk = dto.company_balance_pence != null
    || dto.company_available_for_transfer_pence != null;

  let status: PayoutLedgerOverviewStatus = "LIVE";
  let unavailable_reason: string | null = null;

  if (!driverOk && !companyOk && errors.length > 0) {
    status = "UNAVAILABLE";
    unavailable_reason = errors[0] ?? PAYOUT_LEDGER_ERROR.API_UNAVAILABLE;
  } else if (!driverOk && errors.includes(PAYOUT_LEDGER_ERROR.DRIVER_WALLET_SOURCE_UNAVAILABLE)) {
    status = "DEGRADED";
    unavailable_reason = PAYOUT_LEDGER_ERROR.DRIVER_WALLET_SOURCE_UNAVAILABLE;
  } else if (errors.length > 0 || !companyOk) {
    status = "PARTIAL";
    // Preserve precise company status codes — never collapse ACCOUNT_NOT_CONFIGURED
    // / AUTHENTICATION_REQUIRED / etc. into a generic SOURCE_UNAVAILABLE.
    const companySpecific = errors.find((e) =>
      e === "ACCOUNT_NOT_CONFIGURED"
      || e === "AUTHENTICATION_REQUIRED"
      || e === "CURRENCY_MISMATCH"
      || e === "PROVIDER_UNAVAILABLE"
      || e === "STALE_PROVIDER_EVIDENCE"
      || e === "PENDING_SYNC"
      || e === "TRANSFER_DISABLED"
      || e === "COMPANY_BALANCE_PROVIDER_STUB_REJECTED"
      || e === PAYOUT_LEDGER_ERROR.COMPANY_BALANCE_SOURCE_UNAVAILABLE
      || e.startsWith("COMPANY_BALANCE_")
    );
    unavailable_reason = companySpecific
      ?? (!companyOk ? PAYOUT_LEDGER_ERROR.COMPANY_BALANCE_SOURCE_UNAVAILABLE : (errors[0] ?? null));
  }

  return {
    ...dto,
    status,
    unavailable_reason,
    evidence_status: status,
    section_errors: errors,
  };
}
