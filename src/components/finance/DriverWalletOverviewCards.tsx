import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { formatPence } from '@/hooks/useDriverWallet';
import type { DriverWalletSsotRow } from '@/hooks/useDriverWalletSsot';
import { Loader2 } from 'lucide-react';

function CompactCard({
  title,
  value,
  badge,
  currencyCode,
  subtitle,
}: {
  title: string;
  value: number | null | undefined;
  badge: string;
  currencyCode: string;
  subtitle?: string;
}) {
  return (
    <Card>
      <CardContent className="pt-4 pb-4">
        <div className="flex items-center justify-between gap-2 mb-2">
          <p className="text-xs text-muted-foreground">{title}</p>
          <Badge variant="outline" className="text-[10px]">{badge}</Badge>
        </div>
        <p className="text-xl font-semibold">
          {value == null ? '—' : formatPence(value, currencyCode)}
        </p>
        {subtitle ? <p className="text-[10px] text-muted-foreground mt-1">{subtitle}</p> : null}
      </CardContent>
    </Card>
  );
}

export function DriverWalletOverviewCards({
  driver,
  currencyCode = 'GBP',
  isLoading,
}: {
  driver: DriverWalletSsotRow | null | undefined;
  currencyCode?: string;
  isLoading?: boolean;
}) {
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading financial position…
      </div>
    );
  }

  if (!driver) {
    return (
      <p className="text-sm text-muted-foreground py-8">
        Select a driver to view their current financial position.
      </p>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <CompactCard
        title="ONECAB Wallet Balance"
        value={driver.wallet_balance_pence}
        badge="Wallet"
        currencyCode={currencyCode}
      />
      <CompactCard
        title="Finance Cleared"
        value={driver.finance_cleared_amount_pence}
        badge="Finance"
        currencyCode={currencyCode}
      />
      <CompactCard
        title="Scheduled Weekly Payout"
        value={driver.scheduled_payout_display_pence}
        badge="Scheduled"
        currencyCode={currencyCode}
      />
      <CompactCard
        title="Available Cash Out"
        value={driver.cashout_limit_pence}
        badge="Cash Out"
        currencyCode={currencyCode}
      />
    </div>
  );
}
