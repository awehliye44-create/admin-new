import { Card, CardContent } from '@/components/ui/card';
import { formatNullablePence } from '@/lib/formatNullablePence';
import { useDriverWalletSsotAll } from '@/hooks/useDriverWalletSsot';
import { buildDriverWalletFleetOverview } from '@/lib/driverWalletFleetOverviewSSOT';
import { LoadingTimeout } from '@/components/LoadingTimeout';

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

/**
 * Level 1 aggregate cards across all drivers (fleet overview).
 * Displays rollup of Driver Wallet SSOT rows — not individual-driver period widgets.
 * Loads independently of the paginated driver table (does not block list first paint).
 */
export function DriverWalletFleetOverviewCards({
  regionId = null,
  currencyCode = 'GBP',
}: {
  regionId?: string | null;
  currencyCode?: string;
}) {
  const { data: drivers = [], isLoading, isFetching, isError, error, refetch } = useDriverWalletSsotAll(regionId);
  const overview = buildDriverWalletFleetOverview(drivers);
  const fmt = (p: number) => formatNullablePence(p, currencyCode);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-sm font-medium">Fleet overview</p>
          <p className="text-xs text-muted-foreground">
            Active Driver Wallet balances across all drivers (excludes completed payouts)
            {isFetching ? ' · refreshing…' : ''}
          </p>
        </div>
      </div>

      <LoadingTimeout
        isLoading={isLoading && drivers.length === 0}
        sectionLabel="fleet overview"
        loadingText="Loading fleet overview…"
        onRetry={() => void refetch()}
        allowPartialContent={drivers.length > 0}
      >
        {isError ? (
          <p className="text-sm text-destructive">
            {error instanceof Error ? error.message : 'Unable to load fleet overview'}
          </p>
        ) : null}

        {(drivers.length > 0 || !isLoading) ? (
          <div className="grid gap-3 grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            <Metric label="Total Drivers" value={String(overview.total_drivers)} />
            <Metric label="Total Pending" value={fmt(overview.total_pending_balance_pence)} />
            <Metric label="Total Available" value={fmt(overview.total_available_balance_pence)} />
            <Metric label="Total Reserved" value={fmt(overview.total_reserved_pence)} />
            <Metric label="Processing exceptions" value={fmt(overview.total_processing_exception_pence)} />
            <Metric label="Wallets On Hold" value={String(overview.wallets_on_hold)} />
          </div>
        ) : null}
      </LoadingTimeout>
    </div>
  );
}
