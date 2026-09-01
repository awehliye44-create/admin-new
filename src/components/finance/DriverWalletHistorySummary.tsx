import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatNullablePence } from '@/lib/formatNullablePence';
import type { DriverWalletSsotRow } from '@/hooks/useDriverWalletSsot';
import { Link } from 'react-router-dom';
import { payoutLedgerUrl } from '../../../shared/adminPayoutLedgerSSOT';

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
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
 * Driver wallet history — lifetime / completed movements (not active liability).
 */
export function DriverWalletHistorySummary({
  driver,
  currencyCode = 'GBP',
}: {
  driver: DriverWalletSsotRow;
  currencyCode?: string;
}) {
  const fmt = (p: number | null | undefined) => formatNullablePence(p, currencyCode);
  const kpis = driver.period_kpis;
  const lastProviderRef = driver.provider_connect_payouts?.[0]?.payout_id
    ?? driver.payout_items?.find((p) => p.provider_payout_id)?.provider_payout_id
    ?? null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Wallet history</CardTitle>
        <p className="text-sm text-muted-foreground">
          Completed payouts, lifetime credits, and provider references — not active liability.{' '}
          <Link className="underline" to={payoutLedgerUrl({ driverId: driver.driver_id, tab: 'history' })}>
            Payout history
          </Link>
        </p>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          <Metric
            label="Lifetime credited"
            value={fmt(driver.verified_wallet_credits_pence ?? kpis?.lifetime_earnings_pence)}
            hint="Verified trip credits on wallet ledger"
          />
          <Metric
            label="Completed payouts"
            value={fmt(driver.payout_ledger_completed_pence ?? driver.provider_paid_out_total_pence)}
            hint="See Payout Ledger history tab"
          />
          <Metric
            label="Cashout fees"
            value={fmt(driver.commission_fee_summary?.payment_provider_fees_pence)}
            hint="Provider / cashout fees (reference)"
          />
          <Metric
            label="Adjustments"
            value={fmt(driver.wallet_adjustments_pence ?? kpis?.total_adjustments_pence)}
          />
          <Metric
            label="Provider reference"
            value={lastProviderRef ? String(lastProviderRef).slice(0, 18) : '—'}
            hint={lastProviderRef ? 'Latest bank transfer id' : undefined}
          />
        </div>
      </CardContent>
    </Card>
  );
}
