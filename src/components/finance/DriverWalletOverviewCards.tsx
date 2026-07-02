import { format } from 'date-fns';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { formatPence } from '@/hooks/useDriverWallet';
import type { DriverWalletSsotRow } from '@/hooks/useDriverWalletSsot';
import {
  driverLastStripePayout,
  driverNextWeeklyTransferPence,
  driverStripeAvailablePence,
  driverStripePendingPence,
  resolveStripeAccountStatus,
} from '@/lib/driverWalletStripeDisplay';
import { useConnectPayoutStatus } from '@/hooks/useConnectPayoutStatus';
import { Loader2 } from 'lucide-react';

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return format(new Date(iso), 'dd MMM yyyy HH:mm');
  } catch {
    return iso;
  }
}

function OverviewCard({
  title,
  description,
  children,
  badge,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
  badge?: string;
}) {
  return (
    <Card>
      <CardContent className="pt-4 pb-4">
        <div className="flex items-center justify-between gap-2 mb-1">
          <p className="text-sm font-medium">{title}</p>
          {badge ? (
            <Badge variant="outline" className="text-[10px]">{badge}</Badge>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground mb-3">{description}</p>
        {children}
      </CardContent>
    </Card>
  );
}

export function DriverWalletOverviewCards({
  driver,
  currencyCode = 'GBP',
  regionId = null,
  isLoading,
  driverId = null,
}: {
  driver: DriverWalletSsotRow | null | undefined;
  currencyCode?: string;
  regionId?: string | null;
  isLoading?: boolean;
  driverId?: string | null;
}) {
  const { data: connectStatus } = useConnectPayoutStatus(regionId);
  const connectAccount = connectStatus?.connect_accounts.find(
    (a) => a.driver_id === driver?.driver_id,
  ) ?? null;

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading Stripe payout position…
      </div>
    );
  }

  if (!driver && !driverId) {
    return (
      <p className="text-sm text-muted-foreground py-8">
        Select a driver above to view their Stripe payout position.
      </p>
    );
  }

  if (!driver) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading driver Stripe payout position…
      </div>
    );
  }

  const stripeAvailable = driverStripeAvailablePence(driver);
  const stripePending = driverStripePendingPence(driver);
  const nextTransfer = driverNextWeeklyTransferPence(driver);
  const lastPayout = driverLastStripePayout(driver);
  const accountStatus = resolveStripeAccountStatus({
    connectedAccountId: driver.connected_account_id,
    chargesEnabled: connectAccount?.charges_enabled,
    payoutsEnabled: connectAccount?.payouts_enabled,
    detailsSubmitted: connectAccount?.details_submitted,
    connectAccountStatus: connectAccount?.connect_account_status,
  });

  const fmt = (p: number | null | undefined) => (
    p == null ? '—' : formatPence(p, currencyCode)
  );

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Stripe Connect only — reads <span className="font-medium text-foreground">balance.available</span> and payout
        history. Trip earnings are calculated on Trip History (Trip Settlement SSOT).
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <OverviewCard
          title="Available in Stripe"
          description="Money currently available in the driver's Stripe Connect account (Stripe API balance.available)."
          badge="Stripe"
        >
          <p className="text-2xl font-semibold">
            {!driver.connected_account_id
              ? 'Payout account not connected'
              : stripeAvailable == null
                ? 'Unavailable'
                : fmt(stripeAvailable)}
          </p>
        </OverviewCard>

        <OverviewCard
          title="Pending in Stripe"
          description="Funds not yet available for payout (Stripe balance.pending)."
          badge="Pending"
        >
          <p className="text-2xl font-semibold">
            {!driver.connected_account_id || stripePending == null
              ? '—'
              : fmt(stripePending)}
          </p>
        </OverviewCard>

        <OverviewCard
          title="Next Weekly Transfer"
          description="Expected Stripe automatic payout from Connect available balance."
          badge="Weekly"
        >
          {!driver.connected_account_id || stripeAvailable == null ? (
            <p className="text-lg font-semibold text-muted-foreground">Not scheduled</p>
          ) : nextTransfer != null && nextTransfer > 0 ? (
            <p className="text-2xl font-semibold">{fmt(nextTransfer)}</p>
          ) : (
            <p className="text-lg font-semibold text-muted-foreground">Not scheduled</p>
          )}
        </OverviewCard>

        <OverviewCard
          title="Last Stripe Payout"
          description="Most recent Stripe Connect payout to the driver's bank."
          badge="Payout"
        >
          {lastPayout.at || lastPayout.amountPence != null ? (
            <div className="space-y-1 text-sm">
              <p className="text-2xl font-semibold">{fmt(lastPayout.amountPence)}</p>
              <p className="text-muted-foreground">{formatDate(lastPayout.at)}</p>
              {lastPayout.payoutId ? (
                <p className="font-mono text-xs text-muted-foreground truncate">{lastPayout.payoutId}</p>
              ) : null}
            </div>
          ) : (
            <p className="text-lg font-semibold text-muted-foreground">No payouts yet</p>
          )}
        </OverviewCard>

        <OverviewCard
          title="Stripe Account"
          description="Connect account health for payouts and charges."
          badge="Account"
        >
          <p className="text-2xl font-semibold">{accountStatus}</p>
          {driver.connected_account_id ? (
            <p className="font-mono text-xs text-muted-foreground mt-2 truncate">
              {driver.connected_account_id}
            </p>
          ) : null}
        </OverviewCard>
      </div>
    </div>
  );
}
