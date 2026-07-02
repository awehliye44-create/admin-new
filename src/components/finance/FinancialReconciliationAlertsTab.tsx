import type { ReactNode } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { formatPence } from '@/hooks/useDriverWallet';
import type { FinancialReconciliationSSOTResult } from '@/hooks/useFinancialReconciliationSSOT';
import type { FinanceBackendAuditV1 } from '@/hooks/useFinanceBackendAudit';
import { AlertTriangle } from 'lucide-react';
import { DriverWalletLedgerLink } from '@/components/finance/DriverWalletLedgerLink';
import { safeReconciliationCheck } from '@/lib/financialReconciliationGuards';
import { classifyFinanceMismatch } from '@/lib/financeAlertClassification';

export function FinancialReconciliationAlertsTab({
  ssot,
  backendAudit,
  currencyCode,
  readOnly: _readOnly = false,
}: {
  ssot: FinancialReconciliationSSOTResult;
  backendAudit?: FinanceBackendAuditV1 | null;
  regionId?: string | null;
  currencyCode: string;
  readOnly?: boolean;
}) {
  const fmt = (p: number) => formatPence(p, currencyCode);
  const summary = ssot.summary;
  const check = summary ? safeReconciliationCheck(summary) : null;
  const mm = summary?.money_movement;
  const mismatches = mm?.mismatches ?? [];

  const alertItems: Array<{
    id: string;
    label: string;
    detail: ReactNode;
    severity: 'destructive' | 'default';
  }> = [];

  if (check && !check.balanced && !ssot.readOnly) {
    alertItems.push({
      id: 'settlement-mismatch',
      label: 'Settlement mismatch',
      detail: 'Card or cash ledger reconciliation failed — see variance on Overview.',
      severity: 'destructive',
    });
  }

  for (const m of mismatches) {
    const classified = classifyFinanceMismatch(m);
    if (classified) alertItems.push(classified);
  }

  for (const row of backendAudit?.wallet_integrity ?? []) {
    if (row.completed_payouts_without_ledger_pence > 0) {
      alertItems.push({
        id: `wi-${row.driver_id}`,
        label: 'Ledger without Stripe',
        detail: (
          <>
            <DriverWalletLedgerLink driverId={row.driver_id} tab="payouts">
              {row.driver_name ?? row.driver_id.slice(0, 8)}
            </DriverWalletLedgerLink>
            {': '}
            {row.explanation ?? `Stripe payout without ledger debit ${fmt(row.completed_payouts_without_ledger_pence)}`}
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
        label: 'Stripe without Ledger',
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

  const uniqueAlerts = Array.from(new Map(alertItems.map((a) => [a.id, a])).values());

  return (
    <div className="space-y-4">
      {uniqueAlerts.length === 0 ? (
        <Alert>
          <AlertTitle>No active finance alerts</AlertTitle>
          <AlertDescription>All monitored reconciliation checks are clear for the selected scope.</AlertDescription>
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
