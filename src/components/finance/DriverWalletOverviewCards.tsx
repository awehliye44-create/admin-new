import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Loader2 } from 'lucide-react';
import type { DriverWalletSsotRow } from '@/hooks/useDriverWalletSsot';
import { formatNullablePence } from '@/lib/formatNullablePence';
import { displayDriverWalletSsotBalances } from '@/lib/driverWalletSsotBalances';
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
  const balances = displayDriverWalletSsotBalances(driver);
  const fmt = (p: number | null | undefined) => formatNullablePence(p, ccy);
  const creditOk = driver.driver_credit_status === 'DRIVER_CREDIT_OK'
    || (driver.wallet_variance_pence === 0
      && (driver.expected_payable_pence ?? null) != null
      && (driver.actual_wallet_trip_credits_pence ?? null) != null);
  const creditFrozen = driver.wallet_status === 'FROZEN'
    || (driver.wallet_balance_pence ?? 0) < 0
    || driver.driver_credit_status === 'DRIVER_UNDER_CREDITED'
    || driver.driver_credit_status === 'DRIVER_OVER_CREDITED';
  const payoutBlocked = driver.payout_blocked === true || driver.payouts_enabled === false;
  const payoutHoldReasons = (driver.reconciliation_reasons ?? []).filter(Boolean);
  const payoutBlockReason = payoutBlocked
    ? (driver.payouts_enabled === false
      ? 'Driver payouts disabled'
      : payoutHoldReasons[0] ?? 'Payout eligibility hold')
    : null;
  // Never show "Automatic payout frozen" from credit-OK + verification alone.
  const showPayoutFrozenBadge = creditFrozen || (payoutBlocked && !creditOk);
  const showPayoutHoldBadge = payoutBlocked && creditOk && !creditFrozen;

  const nextPayoutHint = driver.next_scheduled_payout_local || undefined;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={driver.wallet_status === 'ACTIVE' ? 'default' : 'secondary'}>
          {driver.wallet_status ?? '—'}
        </Badge>
        {driver.driver_credit_status ? (
          <Badge variant={creditOk && !creditFrozen ? 'default' : 'secondary'}>
            Credit: {driver.driver_credit_status}
          </Badge>
        ) : null}
        {showPayoutFrozenBadge ? (
          <Badge variant="destructive">Automatic payout frozen</Badge>
        ) : null}
        {showPayoutHoldBadge ? (
          <Badge variant="secondary">Payout hold: {payoutBlockReason}</Badge>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Backend SSOT · Europe/London ·{' '}
          <Link className="underline" to={payoutLedgerUrl({ driverId: driver.driver_id })}>
            Open Payout Ledger
          </Link>
        </p>
      </div>

      {creditFrozen ? (
        <p className="text-xs text-destructive">
          Wallet credit variance or negative balance — automatic payouts are frozen until the ledger is balanced.
          Money is never discarded; resolve via Debt Recovery or Payout Ledger retry.
        </p>
      ) : null}
      {showPayoutHoldBadge && payoutBlockReason ? (
        <p className="text-xs text-muted-foreground">
          Credit reconciliation is OK. Payout is held: {payoutBlockReason}.
          This is not a missing ledger credit.
        </p>
      ) : null}

      <div className="grid gap-3 grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        <Metric
          label="Live Wallet Balance"
          value={fmt(balances.livePence)}
          hint="Ledger SSOT only — never calculated from trips"
        />
        <Metric
          label="Available Balance"
          value={fmt(balances.availablePence)}
          hint="Payout-cleared Driver Wallet funds — Revolut COMPLETED/CAPTURED is not clearing"
        />
        <Metric
          label="Pending Balance"
          value={fmt(balances.pendingPence)}
          hint="Earned but not yet payout-cleared — settlement pending, not a withdrawal reservation"
        />
        {(driver.withdrawal_in_progress_pence ?? 0) > 0 ? (
          <Metric
            label="Withdrawal in progress"
            value={fmt(driver.withdrawal_in_progress_pence)}
            hint="Active payout reservation — separate from settlement Pending"
          />
        ) : null}
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
