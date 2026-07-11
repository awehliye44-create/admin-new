/** Financial Reconciliation audit export — backend DTO rows only; no money math. */

import { downloadCsv, downloadRecordsAsExcel, printFinanceReport, type ExportCell } from '@/lib/financeExport';
import type { TripFinancialAuditRow } from '@/hooks/useFinanceReconciliation';

export type FrAuditExportMeta = {
  generatedAt: string;
  sourceSsot: string;
  serviceArea: string;
  currency: string;
  formulaVersion: string;
  unresolvedMismatches: number;
  periodLabel?: string;
};

function auditExportRows(
  rows: TripFinancialAuditRow[],
  meta: FrAuditExportMeta,
): Array<Record<string, ExportCell>> {
  return rows.map((row) => ({
    source_ssot: meta.sourceSsot,
    generated_at: meta.generatedAt,
    period: meta.periodLabel ?? '',
    service_area: row.service_area_id ?? meta.serviceArea,
    currency: row.currency_code ?? meta.currency,
    formula_version: row.settlement_formula_version ?? meta.formulaVersion,
    trip_id: row.trip_id,
    trip_code: row.trip_code,
    completed_at: row.date,
    customer: row.customer_name,
    driver: row.driver_name,
    payment_session_id: row.payment_session_id,
    provider_state: row.provider_state,
    provider_verified_at: row.provider_verified_at,
    payment_method: row.payment_method,
    final_customer_fare_pence: row.final_customer_fare_pence ?? row.final_fare_pence,
    authorised_pence: row.authorised_pence,
    captured_pence: row.captured_pence,
    released_pence: row.released_pence,
    refunded_pence: row.refunded_pence,
    provider_fee_pence: row.processing_fee_pence,
    fee_status: row.fee_status,
    onecab_gross_commission_pence: row.onecab_gross_commission_pence,
    onecab_net_commission_pence: row.onecab_net_pence,
    driver_net_pence: row.driver_net_pence,
    wallet_credit_pence: row.wallet_credit_pence,
    payout_status: row.driver_payout?.label ?? row.driver_payout_status,
    capture_variance_pence: row.capture_variance_pence,
    wallet_variance_pence: row.wallet_variance_pence,
    payout_variance_pence: row.payout_variance_pence,
    capture_status: row.capture_reconciliation_status,
    release_status: row.release_reconciliation_status,
    refund_status: row.refund_reconciliation_status,
    wallet_status: row.wallet_reconciliation_status,
    payout_recon_status: row.payout_reconciliation_status,
    reconciliation_status: row.reconciliation_status?.label,
    warnings: (row.warnings ?? []).join('|'),
    unresolved_mismatches_in_export: meta.unresolvedMismatches,
  }));
}

export function exportFrAuditCsv(rows: TripFinancialAuditRow[], meta: FrAuditExportMeta): void {
  downloadCsv(`financial-reconciliation-audit-${meta.generatedAt.slice(0, 10)}.csv`, auditExportRows(rows, meta));
}

export function exportFrAuditExcel(rows: TripFinancialAuditRow[], meta: FrAuditExportMeta): void {
  downloadRecordsAsExcel(
    `financial-reconciliation-audit-${meta.generatedAt.slice(0, 10)}`,
    auditExportRows(rows, meta),
    'FR Audit',
  );
}

export function exportFrAuditPdf(): void {
  printFinanceReport();
}
