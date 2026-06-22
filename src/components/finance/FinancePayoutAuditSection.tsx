import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AlertTriangle } from 'lucide-react';
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
}: {
  mondayPayouts: MondayPayoutQuery;
  currencyCode: string;
  onRetry?: (row: MondayPayoutDiagnosticsRow) => void;
  retryingId?: string | null;
  showFailedSection?: boolean;
  compact?: boolean;
}) {
  const data = mondayPayouts.data;

  return (
    <div className="space-y-4">
      <MondayPayoutTodayCards
        cards={data?.today_cards}
        currencyCode={currencyCode}
        isLoading={mondayPayouts.isLoading}
        todayPeriodStart={data?.today_period_start}
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
            <CardTitle className="text-base text-destructive">Failed Payouts — must not be hidden</CardTitle>
          </CardHeader>
          <CardContent>
            <MondayPayoutDiagnosticsTable
              rows={data?.failed_payouts ?? []}
              currencyCode={currencyCode}
              onRetry={onRetry}
              retryingId={retryingId}
            />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{PAYOUT_AUDIT_TABLE_TITLE}</CardTitle>
          <p className="text-sm text-muted-foreground">{PAYOUT_AUDIT_TABLE_DESCRIPTION}</p>
        </CardHeader>
        <CardContent>
          <MondayPayoutDiagnosticsTable
            rows={data?.payouts ?? []}
            currencyCode={currencyCode}
            onRetry={onRetry}
            retryingId={retryingId}
            compact={compact}
            emptyMessage={PAYOUT_AUDIT_EMPTY_MESSAGE}
          />
        </CardContent>
      </Card>
    </div>
  );
}
