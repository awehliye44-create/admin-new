import { Card, CardContent } from '@/components/ui/card';
import { Loader2 } from 'lucide-react';
import { formatNullablePence } from '@/lib/formatNullablePence';
import { useDriverWalletSummary } from '@/hooks/useDriverWalletSummary';

function Metric({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <Card>
      <CardContent className="pt-3 pb-3">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-lg font-semibold tabular-nums mt-0.5">{value}</p>
        {hint ? <p className="text-[10px] text-muted-foreground mt-1">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}

/**
 * Period + account widget cards — display-only consume of backend wallet_summary.
 * No React financial sums. Balances live here only (not per transaction row).
 */
export function DriverWalletPeriodWidgetCards({
  driverId,
  serviceAreaId = null,
  currencyCode = 'GBP',
  period,
  periodFrom,
  periodTo,
  periodLabel,
  enabled = true,
}: {
  driverId: string | null;
  serviceAreaId?: string | null;
  currencyCode?: string;
  period: string;
  periodFrom: string;
  periodTo: string;
  periodLabel?: string;
  enabled?: boolean;
}) {
  const { data, isLoading, isFetching, isError, error } = useDriverWalletSummary({
    driverId,
    serviceAreaId,
    period,
    from: periodFrom,
    to: periodTo,
    enabled: enabled && Boolean(periodFrom && periodTo),
  });

  if (!driverId) return null;

  if (!enabled || !periodFrom || !periodTo) {
    return (
      <div className="space-y-3">
        <p className="text-sm font-medium">Wallet widgets</p>
        <p className="text-sm text-muted-foreground">
          Select a custom From / To range and press Apply to load widget totals.
        </p>
      </div>
    );
  }

  const fmt = (p: number | null | undefined) => formatNullablePence(p ?? 0, currencyCode);
  const summary = data?.summary;
  const account = data?.account;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium">Wallet widgets</p>
        <p className="text-xs text-muted-foreground">
          {periodLabel ?? data?.period.key ?? period}
          {isFetching ? ' · refreshing…' : ''}
        </p>
      </div>

      {isLoading && !data ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading wallet summary…
        </div>
      ) : null}

      {isError ? (
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : 'Unable to load wallet summary'}
        </p>
      ) : null}

      <div className="grid gap-3 grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <Metric label="Live Driver Balance" value={fmt(account?.live_balance_pence)} hint="Authoritative wallet ledger balance" />
        <Metric label="Available Balance" value={fmt(account?.available_balance_pence)} hint="Eligible for Payout Ledger" />
        <Metric label="Pending Balance" value={fmt(account?.pending_balance_pence)} hint="Not yet payout-eligible" />
        <Metric label="Driver Net Earnings" value={fmt(summary?.driver_net_earnings_pence)} hint="Selected period" />
        <Metric label="Completed Trips" value={String(summary?.paid_trip_count ?? 0)} hint="Unique trip credits in period" />
        <Metric label="Wallet Adjustments" value={fmt(summary?.wallet_adjustment_pence)} hint="Selected period" />
        <Metric label="Debt Recovery" value={fmt(summary?.debt_recovered_pence)} hint="Selected period" />
        <Metric label="Payouts" value={fmt(summary?.payout_debit_pence)} hint="Selected period" />
        <Metric
          label="Annual Driver Earnings"
          value={fmt(account?.annual_driver_earnings_pence)}
          hint="Year-to-date from wallet SSOT"
        />
      </div>
    </div>
  );
}
