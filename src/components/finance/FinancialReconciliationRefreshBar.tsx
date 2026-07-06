import { Button } from '@/components/ui/button';
import { FinanceSSOTBadge } from '@/components/finance/FinanceSSOTBadge';
import { formatFinanceDateSafe } from '@/lib/financialReconciliationGuards';
import type { FinanceDataSourceBadge } from '@/hooks/useFinancialReconciliationSSOT';
import { RefreshCw } from 'lucide-react';

type FinancialReconciliationRefreshBarProps = {
  badge: FinanceDataSourceBadge;
  lastSyncedAt?: string | null;
  isRefreshing?: boolean;
  readOnly?: boolean;
  onRefresh?: () => void;
  label?: string;
};

export function FinancialReconciliationRefreshBar({
  badge,
  lastSyncedAt,
  isRefreshing = false,
  readOnly = false,
  onRefresh,
  label = 'Live SSOT data',
}: FinancialReconciliationRefreshBarProps) {
  const lastSyncedLabel = lastSyncedAt
    ? formatFinanceDateSafe(lastSyncedAt, 'dd MMM yyyy HH:mm:ss')
    : null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/30 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <FinanceSSOTBadge badge={badge} />
        <span className="text-xs text-muted-foreground">{label}</span>
        {lastSyncedLabel && badge === 'LIVE' && (
          <span className="text-xs text-muted-foreground">· Last synced {lastSyncedLabel}</span>
        )}
        {badge === 'REFRESHING' && (
          <span className="text-xs text-muted-foreground">· Fetching live Provider + trip data…</span>
        )}
      </div>
      {onRefresh && (
        <Button
          variant="outline"
          size="sm"
          onClick={onRefresh}
          disabled={readOnly || isRefreshing}
        >
          <RefreshCw className={`h-4 w-4 mr-2 ${isRefreshing ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      )}
    </div>
  );
}
