import { Card, CardContent } from '@/components/ui/card';
import { formatNullablePence } from '@/lib/formatNullablePence';
import type { DriverWalletSsotRow } from '@/hooks/useDriverWalletSsot';
import { displayDriverWalletSsotBalances } from '@/lib/driverWalletSsotBalances';
import { Badge } from '@/components/ui/badge';
import { Loader2 } from 'lucide-react';

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

function reservedPence(row: DriverWalletSsotRow): number {
  return Math.max(
    0,
    Math.round(
      Number(
        row.withdrawal_in_progress_pence
          ?? row.included_in_payout_batch_amount_pence
          ?? 0,
      ),
    ),
  );
}

function openDifferencePence(row: DriverWalletSsotRow): number | null {
  if (row.wallet_variance_pence == null) return null;
  return Math.round(Number(row.wallet_variance_pence));
}

function statusLabel(row: DriverWalletSsotRow): string {
  return row.driver_credit_status ?? row.wallet_status ?? '—';
}

/** Active wallet position only — pending, available, reserved, open difference. */
export function DriverWalletActivePositionCards({
  driver,
  isLoading,
  currencyCode = 'GBP',
}: {
  driver: DriverWalletSsotRow | null | undefined;
  currencyCode?: string;
  isLoading?: boolean;
}) {
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading active wallet position…
      </div>
    );
  }
  if (!driver) return null;

  const balances = displayDriverWalletSsotBalances(driver);
  const fmt = (p: number | null | undefined) => formatNullablePence(p, currencyCode);
  const processingException = Math.max(
    0,
    Math.round(Number(driver.failed_payout_stuck_processing_pence ?? 0)),
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={driver.wallet_status === 'ACTIVE' ? 'default' : 'destructive'}>
          {statusLabel(driver)}
        </Badge>
        <p className="text-xs text-muted-foreground">Active balances — excludes completed payouts</p>
      </div>
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <Metric label="Pending" value={fmt(balances.pendingPence)} hint="Not yet payout-cleared" />
        <Metric label="Available" value={fmt(balances.availablePence)} hint="Eligible for payout" />
        <Metric label="Reserved" value={fmt(reservedPence(driver))} hint="Withdrawal / batch reservation" />
        <Metric label="Open difference" value={fmt(openDifferencePence(driver))} hint="FR wallet variance" />
        {processingException > 0 ? (
          <Metric label="Processing exception" value={fmt(processingException)} hint="Stuck in-flight payout" />
        ) : null}
      </div>
    </div>
  );
}
