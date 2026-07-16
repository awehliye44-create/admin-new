import type { ReactNode } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import type { FinanceMoneyFormat } from '@/hooks/useFinanceReconciliationMoney';
import type { FinancialReconciliationSSOTResult } from '@/hooks/useFinancialReconciliationSSOT';
import type { FinanceBackendAuditV1 } from '@/hooks/useFinanceBackendAudit';
import { AlertTriangle } from 'lucide-react';
import { DriverWalletLedgerLink } from '@/components/finance/DriverWalletLedgerLink';
import { safeReconciliationCheck } from '@/lib/financialReconciliationGuards';
import {
  classifyFinanceMismatch,
  type FinanceAlertItem,
} from '@/lib/financeAlertClassification';


type AlertListItem = {
  id: string;
  label: string;
  detail: ReactNode;
  severity: 'destructive' | 'default';
};

/** Money-movement mismatches only — shared by Alerts and Mismatches tabs. */
export function buildFinanceMismatchAlertItems(
  mismatches: Array<{
    kind?: string;
    message?: string | null;
    reference_id?: string | null;
  }>,
): FinanceAlertItem[] {
  const items: FinanceAlertItem[] = [];
  for (const m of mismatches) {
    const classified = classifyFinanceMismatch(m);
    if (classified) items.push(classified);
  }
  return items;
}

export function FinancialReconciliationAlertsTab({
  ssot,
  backendAudit,
  money,
  readOnly: _readOnly = false,
  mode = 'all',
}: {
  ssot: FinancialReconciliationSSOTResult;
  backendAudit?: FinanceBackendAuditV1 | null;
  regionId?: string | null;
  money: FinanceMoneyFormat;
  readOnly?: boolean;
  /** `mismatches` — only classified money-movement mismatches (no holds / wallet / webhook). */
  mode?: 'all' | 'mismatches';
}) {
  const fmt = (p: number) => money.fmt(p) ?? '—';
  const summary = ssot.summary;
  const check = summary ? safeReconciliationCheck(summary) : null;
  const mm = summary?.money_movement;
  const mismatches = mm?.mismatches ?? [];
  const mismatchOnly = mode === 'mismatches';

  const alertItems: AlertListItem[] = [];

  if (!mismatchOnly && check && !check.balanced && !ssot.readOnly) {
    alertItems.push({
      id: 'settlement-mismatch',
      label: 'Settlement mismatch',
      detail: 'Platform ledger reconciliation failed — see variance on Overview.',
      severity: 'destructive',
    });
  }

  for (const item of buildFinanceMismatchAlertItems(mismatches)) {
    alertItems.push(item);
  }

  if (!mismatchOnly) {
    for (const row of backendAudit?.wallet_integrity ?? []) {
      if (row.completed_payouts_without_ledger_pence > 0) {
        alertItems.push({
          id: `wi-${row.driver_id}`,
          label: 'Ledger without Provider',
          detail: (
            <>
              <DriverWalletLedgerLink driverId={row.driver_id} tab="payouts">
                {row.driver_name ?? row.driver_id.slice(0, 8)}
              </DriverWalletLedgerLink>
              {': '}
              {row.explanation ?? `Provider payout without ledger debit ${fmt(row.completed_payouts_without_ledger_pence)}`}
            </>
          ),
          severity: 'destructive',
        });
      }
    }

    for (const row of backendAudit?.payout_rows ?? []) {
      if (row.provider_reference && !row.ledger_entry_created) {
        alertItems.push({
          id: `payout-no-ledger-${row.payout_id}`,
          label: 'Provider without Ledger',
          detail: `${row.payout_id.slice(0, 8)}… · ${fmt(row.amount_pence)} · ${row.status}`,
          severity: 'destructive',
        });
      }
    }

    if (summary?.provider_money?.provider_health_status === 'failing') {
      alertItems.push({
        id: 'webhook-health',
        label: 'Webhook failure',
        detail: `Provider health: ${summary.provider_money.provider_health_status}`,
        severity: 'destructive',
      });
    }
  }

  const uniqueAlerts = Array.from(new Map(alertItems.map((a) => [a.id, a])).values());

  return (
    <div className="space-y-4">
      {!mismatchOnly ? <PaymentHoldsFinanceAlertSummary /> : null}

      {uniqueAlerts.length === 0 ? (
        <Alert>
          <AlertTitle>
            {mismatchOnly ? 'No reconciliation mismatches' : 'No active finance alerts'}
          </AlertTitle>
          <AlertDescription>
            {mismatchOnly
              ? 'No classified money-movement mismatches for the selected scope.'
              : 'All monitored reconciliation checks are clear for the selected scope.'}
          </AlertDescription>
        </Alert>
      ) : (
        uniqueAlerts.map((item) => (
          <Alert key={item.id} variant={item.severity}>
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>{item.label}</AlertTitle>
            <AlertDescription>{item.detail}</AlertDescription>
          </Alert>
        ))
      )}
    </div>
  );
}
