import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { RefreshCw, AlertTriangle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  MondayPayoutTodayCards,
  PartialSettlementAlert,
} from '@/components/finance/MondayPayoutTodayCards';
import { MondayPayoutDiagnosticsTable } from '@/components/finance/MondayPayoutDiagnosticsTable';
import type { MondayPayoutDiagnosticsRow } from '@/hooks/useMondayPayoutDiagnostics';
import type { MondayPayoutQuery } from '@/lib/financePageSSOT';
import {
  PAYOUT_AUDIT_EMPTY_MESSAGE,
  PAYOUT_AUDIT_TABLE_DESCRIPTION,
  PAYOUT_AUDIT_TABLE_TITLE,
} from '@/lib/financePageSSOT';

export function FinancePayoutAuditSection({
  mondayPayouts,
  currencyCode,
  onRetry,
  retryingId,
  showFailedSection = true,
  compact,
  periodLabel,
  platformMode = false,
}: {
  mondayPayouts: MondayPayoutQuery & {
    isError?: boolean;
    error?: Error | null;
    refetch?: () => void;
    isFetching?: boolean;
  };
  currencyCode: string;
  onRetry?: (row: MondayPayoutDiagnosticsRow) => void;
  retryingId?: string | null;
  showFailedSection?: boolean;
  compact?: boolean;
  periodLabel?: string;
  /** Platform reconciliation queue — links drivers to wallet ledger, no per-driver bank payout history. */
  platformMode?: boolean;
}) {
  const data = mondayPayouts.data;

  if (mondayPayouts.isError) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Payout audit unavailable</AlertTitle>
        <AlertDescription className="space-y-3">
          <p>
            {(mondayPayouts.error as Error | null)?.message ??
              'Could not load payout diagnostics from admin-monday-payout-diagnostics.'}
          </p>
          {mondayPayouts.refetch && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => mondayPayouts.refetch?.()}
              disabled={mondayPayouts.isFetching}
            >
              <RefreshCw className={`h-4 w-4 mr-2 ${mondayPayouts.isFetching ? 'animate-spin' : ''}`} />
              Retry payout audit
            </Button>
          )}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-4">
      <MondayPayoutTodayCards
        cards={data?.today_cards}
        currencyCode={currencyCode}
        isLoading={mondayPayouts.isLoading}
        todayPeriodStart={data?.today_period_start}
        periodLabel={periodLabel}
      />
      <PartialSettlementAlert count={data?.partial_settlements?.length ?? 0} />

      {(data?.reconciliation_mismatches?.length ?? 0) > 0 && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>RECONCILIATION_MISMATCH — payout rows</AlertTitle>
          <AlertDescription>
            {data?.reconciliation_mismatches?.length} payout(s) fail gross−commission=net or
            net=paid+failed+pending+returned checks.
          </AlertDescription>
        </Alert>
      )}

      {showFailedSection && (data?.failed_payouts?.length ?? 0) > 0 && (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="text-base text-destructive">Failed payouts — reconciliation queue</CardTitle>
            <p className="text-sm text-muted-foreground">
              Platform retry only. Per-driver payout amounts and wallet detail are on Driver Wallet Ledger.
            </p>
          </CardHeader>
          <CardContent>
            <MondayPayoutDiagnosticsTable
              rows={data?.failed_payouts ?? []}
              currencyCode={currencyCode}
              onRetry={onRetry}
              retryingId={retryingId}
              platformMode={platformMode}
            />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{PAYOUT_AUDIT_TABLE_TITLE}</CardTitle>
          <p className="text-sm text-muted-foreground">
            {PAYOUT_AUDIT_TABLE_DESCRIPTION}
            {platformMode ? ' Open Driver Wallet Ledger for per-driver Stripe and bank payout detail.' : ''}
          </p>
        </CardHeader>
        <CardContent>
          <MondayPayoutDiagnosticsTable
            rows={data?.payouts ?? []}
            currencyCode={currencyCode}
            onRetry={onRetry}
            retryingId={retryingId}
            compact={compact}
            platformMode={platformMode}
            emptyMessage={PAYOUT_AUDIT_EMPTY_MESSAGE}
          />
        </CardContent>
      </Card>
    </div>
  );
}
