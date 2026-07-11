import { Card, CardContent } from '@/components/ui/card';
import { Loader2 } from 'lucide-react';
import { formatNullablePence } from '@/lib/formatNullablePence';
import { useDriverWalletSsotAll } from '@/hooks/useDriverWalletSsot';
import { buildDriverWalletFleetOverview } from '@/lib/driverWalletFleetOverviewSSOT';

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
 */
export function DriverWalletFleetOverviewCards({
  regionId = null,
  currencyCode = 'GBP',
}: {
  regionId?: string | null;
  currencyCode?: string;
}) {
  const { data: drivers = [], isLoading, isFetching, isError, error } = useDriverWalletSsotAll(regionId);
  const overview = buildDriverWalletFleetOverview(drivers);
  const fmt = (p: number) => formatNullablePence(p, currencyCode);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-sm font-medium">Fleet overview</p>
          <p className="text-xs text-muted-foreground">
            Aggregate Driver Wallet Ledger SSOT across all drivers
            {isFetching ? ' · refreshing…' : ''}
          </p>
        </div>
      </div>

      {isLoading && drivers.length === 0 ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading fleet overview…
        </div>
      ) : null}

      {isError ? (
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : 'Unable to load fleet overview'}
        </p>
      ) : null}

      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
        <Metric label="Total Drivers" value={String(overview.total_drivers)} />
        <Metric label="Total Live Driver Balance" value={fmt(overview.total_live_balance_pence)} />
        <Metric label="Total Available Balance" value={fmt(overview.total_available_balance_pence)} />
        <Metric label="Total Pending Balance" value={fmt(overview.total_pending_balance_pence)} />
        <Metric label="Total Outstanding Debt" value={fmt(overview.total_outstanding_debt_pence)} />
        <Metric label="Wallets Active" value={String(overview.wallets_active)} />
        <Metric label="Wallets On Hold" value={String(overview.wallets_on_hold)} />
        <Metric label="Negative Wallets" value={String(overview.negative_wallets)} />
      </div>
    </div>
  );
}
