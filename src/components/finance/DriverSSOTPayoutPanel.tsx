import { AlertTriangle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { FinanceSSOTBadge } from '@/components/finance/FinanceSSOTBadge';
import { formatPence } from '@/hooks/useDriverWallet';
import {
  PerDriverSSOT,
  usePerDriverFinancialReconciliation,
  type PerDriverFinanceSSOT,
} from '@/hooks/usePerDriverFinancialReconciliation';
import type { ServiceAreaFinanceSelection } from '@/components/finance/ServiceAreaFinanceFilter';

export function DriverSSOTPayoutPanel({
  driverId,
  currencyCode,
  filter,
  compact = false,
}: {
  driverId: string | null;
  currencyCode: string;
  filter?: ServiceAreaFinanceSelection;
  compact?: boolean;
}) {
  const { data, isLoading, isError } = usePerDriverFinancialReconciliation({
    driverId,
    filter,
  });

  const ssot = data?.finance_reconciliation_driver_ssot;

  if (!driverId) return null;

  if (isLoading) {
    return (
      <p className="text-sm text-muted-foreground py-2">Loading per-driver reconciliation…</p>
    );
  }

  if (isError || !ssot) {
    return (
      <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 p-3 text-sm text-amber-800 dark:text-amber-200">
        <AlertTriangle className="h-4 w-4 inline mr-1" />
        Per-driver reconciliation required before payout.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <FinanceSSOTBadge badge={ssot.source_tier} />
        <Badge variant={ssot.reconciliation_status === 'BALANCED' ? 'outline' : 'destructive'}>
          {ssot.reconciliation_status}
        </Badge>
        {ssot.ledger_sync_missing && (
          <Badge variant="destructive">Ledger sync missing</Badge>
        )}
      </div>

      {ssot.payout_blocked && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 p-3 text-sm">
          <p className="font-medium flex items-center gap-1 text-amber-900 dark:text-amber-100">
            <AlertTriangle className="h-4 w-4" />
            Per-driver reconciliation required before payout.
          </p>
          <ul className="mt-2 list-disc pl-5 text-amber-800 dark:text-amber-200 space-y-1">
            {ssot.payout_blocked_reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      )}

      <div className={`grid gap-3 ${compact ? 'grid-cols-2' : 'grid-cols-2 sm:grid-cols-4'}`}>
        <Metric label="SSOT Available Now" value={ssot.driver_available_now_pence} ccy={currencyCode} highlight="green" />
        <Metric label="Pending Payout" value={ssot.driver_pending_payout_pence} ccy={currencyCode} />
        <Metric label="Remaining Liability" value={ssot.driver_remaining_liability_pence} ccy={currencyCode} />
        <Metric
          label="Provider Allocated"
          value={ssot.provider_available_balance_allocated_to_driver_pence}
          ccy={currencyCode}
        />
      </div>

      {!compact && (
        <Card>
          <CardContent className="pt-4 space-y-1 text-xs text-muted-foreground">
            <Row label="Gross earnings" value={formatPence(ssot.driver_gross_earnings_pence, currencyCode)} />
            <Row label="Net earnings" value={formatPence(ssot.driver_net_earnings_pence, currencyCode)} />
            <Row label="Bank payouts" value={formatPence(ssot.driver_paid_out_pence, currencyCode)} />
            <Row label="Early cashouts (completed)" value={formatPence(ssot.completed_early_cashouts_pence, currencyCode)} />
            <Row label="In-flight cashout" value={formatPence(ssot.in_flight_cashout_pence, currencyCode)} />
            <Row label="Platform provider available" value={formatPence(ssot.provider_available_balance_pence, currencyCode)} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export function useDriverSSOTPayoutGate(
  driverId: string | null,
  filter?: ServiceAreaFinanceSelection,
) {
  const query = usePerDriverFinancialReconciliation({ driverId, filter });
  const ssot = query.data?.finance_reconciliation_driver_ssot;
  return {
    ...query,
    ssot,
    canPayout: ssot ? PerDriverSSOT.canPayout(ssot) : false,
    payoutAmountPence: ssot?.driver_available_now_pence ?? 0,
  };
}

function Metric({
  label,
  value,
  ccy,
  highlight,
}: {
  label: string;
  value: number;
  ccy: string;
  highlight?: 'green';
}) {
  return (
    <Card>
      <CardContent className="pt-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className={`text-lg font-bold ${highlight === 'green' ? 'text-green-600' : ''}`}>
          {formatPence(value, ccy)}
        </p>
      </CardContent>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span>{label}</span>
      <span className="font-medium text-foreground">{value}</span>
    </div>
  );
}

export type { PerDriverFinanceSSOT };
