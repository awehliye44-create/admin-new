import { useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { RefreshCw } from 'lucide-react';
import { formatNullablePence } from '@/lib/formatNullablePence';
import { useDriverWalletSsotAll } from '@/hooks/useDriverWalletSsot';
import { buildDriverWalletFleetOverview } from '@/lib/driverWalletFleetOverviewSSOT';

/** Only after this long do we offer a manual retry — no alarming banner before it. */
const FLEET_OVERVIEW_RETRY_HINT_MS = 20_000;

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="pt-3 pb-3">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-lg font-semibold tabular-nums mt-0.5">{value}</p>
      </CardContent>
    </Card>
  );
}

function MetricSkeleton({ label }: { label: string }) {
  return (
    <Card>
      <CardContent className="pt-3 pb-3">
        <p className="text-xs text-muted-foreground">{label}</p>
        <Skeleton className="h-6 w-20 mt-1" />
      </CardContent>
    </Card>
  );
}

const METRIC_LABELS = [
  'Total Drivers',
  'Total Pending',
  'Total Available',
  'Total Reserved',
  'Processing exceptions',
  'Wallets On Hold',
] as const;

/**
 * Level 1 aggregate cards across all drivers (fleet overview).
 * Displays rollup of Driver Wallet SSOT rows — not individual-driver period widgets.
 * Loads independently of the paginated driver table (does not block list first paint).
 */
export function DriverWalletFleetOverviewCards({
  regionId = null,
  currencyCode = 'GBP',
  periodFrom = null,
  periodTo = null,
}: {
  regionId?: string | null;
  currencyCode?: string;
  periodFrom?: string | null;
  periodTo?: string | null;
}) {
  const { data: drivers = [], isLoading, isFetching, isError, error, refetch } = useDriverWalletSsotAll(
    regionId,
    { periodFrom, periodTo },
  );
  const overview = buildDriverWalletFleetOverview(drivers);
  const fmt = (p: number) => formatNullablePence(p, currencyCode);

  const showSkeleton = isLoading && drivers.length === 0;
  const [retryHint, setRetryHint] = useState(false);

  useEffect(() => {
    if (!showSkeleton) {
      setRetryHint(false);
      return;
    }
    const timer = setTimeout(() => setRetryHint(true), FLEET_OVERVIEW_RETRY_HINT_MS);
    return () => clearTimeout(timer);
  }, [showSkeleton]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-sm font-medium">Fleet overview</p>
          <p className="text-xs text-muted-foreground">
            Active Driver Wallet balances across all drivers (excludes completed payouts)
            {showSkeleton ? ' · loading…' : isFetching ? ' · refreshing…' : ''}
          </p>
        </div>
        {retryHint && showSkeleton ? (
          <Button variant="outline" size="sm" onClick={() => void refetch()}>
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
            Retry
          </Button>
        ) : null}
      </div>

      {isError ? (
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : 'Unable to load fleet overview'}
        </p>
      ) : null}

      <div className="grid gap-3 grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {showSkeleton ? (
          METRIC_LABELS.map((label) => <MetricSkeleton key={label} label={label} />)
        ) : (
          <>
            <Metric label="Total Drivers" value={String(overview.total_drivers)} />
            <Metric label="Total Pending" value={fmt(overview.total_pending_balance_pence)} />
            <Metric label="Total Available" value={fmt(overview.total_available_balance_pence)} />
            <Metric label="Total Reserved" value={fmt(overview.total_reserved_pence)} />
            <Metric label="Processing exceptions" value={fmt(overview.total_processing_exception_pence)} />
            <Metric label="Wallets On Hold" value={String(overview.wallets_on_hold)} />
          </>
        )}
      </div>
    </div>
  );
}
