import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Loader2 } from 'lucide-react';
import type { DriverWalletSsotRow } from '@/hooks/useDriverWalletSsot';
import { formatNullablePence } from '@/lib/formatNullablePence';
import { Link } from 'react-router-dom';
import { payoutLedgerUrl } from '../../../shared/adminPayoutLedgerSSOT';

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
 * Wallet Overview — display-only SSOT fields. No client settlement formulas.
 */
export function DriverWalletOverviewCards({
  driver,
  isLoading,
  driverId = null,
  currencyCode = 'GBP',
}: {
  driver: DriverWalletSsotRow | null | undefined;
  currencyCode?: string;
  regionId?: string | null;
  isLoading?: boolean;
  driverId?: string | null;
}) {
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading wallet position…
      </div>
    );
  }

  if (!driver && !driverId) {
    return (
      <p className="text-sm text-muted-foreground py-8">
        Select a driver above to view their wallet balance, available payout, and period earnings.
      </p>
    );
  }

  if (!driver) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading driver wallet SSOT…
      </div>
    );
  }

  const ccy = currencyCode;
  const kpis = driver.period_kpis;
  const fmt = (p: number | null | undefined) => formatNullablePence(p, ccy);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={driver.reconciliation_status === 'BALANCED' ? 'default' : 'destructive'}>
          {driver.reconciliation_status ?? '—'}
        </Badge>
        <p className="text-xs text-muted-foreground">
          Backend SSOT · Europe/London ·{' '}
          <Link className="underline" to={payoutLedgerUrl({ driverId: driver.driver_id })}>
            Open Payout Ledger
          </Link>
        </p>
      </div>

      <div className="grid gap-3 grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        <Metric label="Current Wallet Balance" value={fmt(driver.wallet_balance_pence)} />
        <Metric
          label="Available for Payout"
          value={fmt(driver.cashout_limit_pence)}
          hint="Consumed by Payout Ledger only — never bank transfer here"
        />
        <Metric
          label="Pending Earnings"
          value={fmt(kpis?.pending_earnings_pence)}
          hint="Cleared, not yet in payout batch"
        />
        <Metric label="Today's Earnings" value={fmt(kpis?.today_earnings_pence)} />
        <Metric label="This Week" value={fmt(kpis?.week_earnings_pence)} />
        <Metric label="This Month" value={fmt(kpis?.month_earnings_pence)} />
        <Metric label="This Year" value={fmt(kpis?.year_earnings_pence)} />
        <Metric label="Lifetime Earnings" value={fmt(kpis?.lifetime_earnings_pence)} />
        <Metric label="Outstanding Debt" value={fmt(driver.recovery_debt_pence ?? kpis?.outstanding_debt_pence)} />
        <Metric label="Total Bonuses" value={fmt(kpis?.total_bonuses_pence)} />
        <Metric label="Total Adjustments" value={fmt(kpis?.total_adjustments_pence)} />
        <Metric
          label="Trips Paid"
          value={kpis?.trips_paid_count != null ? String(kpis.trips_paid_count) : '—'}
        />
        <Metric
          label="Average Earnings per Trip"
          value={fmt(kpis?.average_earnings_per_trip_pence)}
        />
      </div>

      <p className="text-xs text-muted-foreground">
        Bank transfers and batch execution live on{' '}
        <Link className="underline" to={payoutLedgerUrl({ driverId: driver.driver_id })}>
          Payout Ledger
        </Link>
        {driver.included_in_payout_batch_amount_pence != null
          || driver.scheduled_payout_display_pence != null
          ? ` · in batch ${fmt(driver.included_in_payout_batch_amount_pence)} · scheduled ${fmt(driver.scheduled_payout_display_pence)}`
          : ''}
        . Debt recovery runs automatically on capture — no manual calculation.
      </p>

      {driver.reconciliation_reasons?.length ? (
        <p className="text-xs text-destructive">{driver.reconciliation_reasons[0]}</p>
      ) : null}
    </div>
  );
}
