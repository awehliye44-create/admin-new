import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Loader2 } from 'lucide-react';
import type { DriverWalletSsotRow } from '@/hooks/useDriverWalletSsot';
import { formatNullablePence } from '@/lib/formatNullablePence';
import { Link } from 'react-router-dom';
import { format } from 'date-fns';
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
 * Wallet Overview widgets — display-only SSOT fields. No client settlement formulas.
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
        Select a driver from the list to view Live Balance, Available, Pending, and period earnings.
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
  const payoutFrozen = driver.wallet_status === 'FROZEN'
    || driver.payout_blocked === true
    || (driver.wallet_balance_pence ?? 0) < 0;

  const nextPayoutHint = driver.next_scheduled_payout_at
    ? (() => {
      try {
        return format(new Date(driver.next_scheduled_payout_at), 'dd MMM yyyy');
      } catch {
        return undefined;
      }
    })()
    : undefined;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={driver.wallet_status === 'ACTIVE' ? 'default' : 'destructive'}>
          {driver.wallet_status ?? '—'}
        </Badge>
        {payoutFrozen ? (
          <Badge variant="destructive">Automatic payout frozen</Badge>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Backend SSOT · Europe/London ·{' '}
          <Link className="underline" to={payoutLedgerUrl({ driverId: driver.driver_id })}>
            Open Payout Ledger
          </Link>
        </p>
      </div>

      {payoutFrozen ? (
        <p className="text-xs text-destructive">
          Wallet mismatch or negative balance detected — automatic payouts are frozen until the ledger is balanced.
          Money is never discarded; resolve via Debt Recovery or Payout Ledger retry.
        </p>
      ) : null}

      <div className="grid gap-3 grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        <Metric
          label="Live Wallet Balance"
          value={fmt(driver.wallet_balance_pence)}
          hint="Ledger SSOT only — never calculated from trips"
        />
        <Metric
          label="Available Balance"
          value={fmt(driver.cashout_limit_pence)}
          hint="Consumed by Payout Ledger only — never bank transfer here"
        />
        <Metric
          label="Pending Balance"
          value={fmt(kpis?.pending_earnings_pence)}
          hint="Cleared, not yet in payout batch"
        />
        <Metric
          label="Outstanding Debt"
          value={fmt(
            driver.debt_recovery?.outstanding_debt_pence
              ?? driver.recovery_debt_pence
              ?? kpis?.outstanding_debt_pence,
          )}
          hint={
            driver.debt_recovery
              ? `Open remaining ${fmt(driver.debt_recovery.remaining_debt_pence)}`
              : 'Lifetime debt created on wallet ledger'
          }
        />
        <Metric label="Lifetime Earnings" value={fmt(kpis?.lifetime_earnings_pence)} />
        <Metric label="Annual Earnings" value={fmt(kpis?.year_earnings_pence)} />
        <Metric label="Monthly Earnings" value={fmt(kpis?.month_earnings_pence)} />
        <Metric label="Weekly Earnings" value={fmt(kpis?.week_earnings_pence)} />
        <Metric label="Today's Earnings" value={fmt(kpis?.today_earnings_pence)} />
        <Metric
          label="Commission Paid"
          value={fmt(
            driver.commission_fee_summary?.net_onecab_commission_pence
              ?? kpis?.platform_commission_pence,
          )}
          hint={
            driver.commission_fee_summary
              ? `Net after provider fees · Gross ${fmt(driver.commission_fee_summary.gross_onecab_commission_pence)} · Fees ${fmt(driver.commission_fee_summary.payment_provider_fees_pence)}`
              : 'Net ONECAB after provider fees when available'
          }
        />
        <Metric
          label="Wallet Adjustments"
          value={fmt(kpis?.total_adjustments_pence)}
        />
        <Metric
          label="Next Scheduled Payout"
          value={fmt(driver.scheduled_payout_display_pence)}
          hint={nextPayoutHint}
        />
      </div>
    </div>
  );
}
