import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatPence } from '@/hooks/useDriverWallet';
import type { DriverWalletSsotRow } from '@/hooks/useDriverWalletSsot';
import { DriverWalletPayoutsTab } from '@/components/finance/DriverWalletPayoutsTab';
import { DriverWalletStripeTab } from '@/components/finance/DriverWalletStripeTab';
import { Loader2 } from 'lucide-react';

function AccountingCard({
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

/** Internal ONECAB accounting — not driver-facing money. */
export function DriverWalletAccountingTab({
  driver,
  currencyCode = 'GBP',
  regionId = null,
  isLoading,
}: {
  driver: DriverWalletSsotRow | null | undefined;
  currencyCode?: string;
  regionId?: string | null;
  isLoading?: boolean;
}) {
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading accounting records…
      </div>
    );
  }

  if (!driver) {
    return (
      <p className="text-sm text-muted-foreground py-8">
        Select a driver to view internal accounting records.
      </p>
    );
  }

  const walletSigned = driver.wallet_balance_pence;
  const liabilityPence = Math.max(0, walletSigned);
  const debtPence = Math.max(0, -walletSigned);

  return (
    <div className="space-y-6">
      <Card className="border-dashed">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Accounting totals (internal only)</CardTitle>
          <p className="text-sm text-muted-foreground">
            Ledger and finance-cleared figures for audits. Driver money on Overview uses Stripe
            balance.available only — never these totals.
          </p>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <AccountingCard
              title="Wallet Balance (ledger)"
              value={walletSigned}
              badge="Ledger"
              currencyCode={currencyCode}
              subtitle="Signed Σ driver_wallet_ledger"
            />
            <AccountingCard
              title="ONECAB Liability (owed to driver)"
              value={liabilityPence}
              badge="Liability"
              currencyCode={currencyCode}
            />
            <AccountingCard
              title="Driver Debt (owed to ONECAB)"
              value={debtPence}
              badge="Debt"
              currencyCode={currencyCode}
            />
            <AccountingCard
              title="Finance Cleared"
              value={driver.finance_cleared_amount_pence}
              badge="Settlements"
              currencyCode={currencyCode}
            />
            <AccountingCard
              title="Included in Payout Batch"
              value={driver.included_in_payout_batch_amount_pence}
              badge="Batch"
              currencyCode={currencyCode}
            />
            <AccountingCard
              title="Available Cash Out (SSOT cap)"
              value={driver.cashout_limit_pence}
              badge="Cash Out"
              currencyCode={currencyCode}
            />
            <AccountingCard
              title="Recovery / Cash Commission Debt"
              value={driver.recovery_debt_pence}
              badge="Recovery"
              currencyCode={currencyCode}
            />
            <AccountingCard
              title="Stripe Paid Out (lifetime)"
              value={driver.stripe_paid_out_total_pence}
              badge="Stripe"
              currencyCode={currencyCode}
            />
          </div>
          {driver.reconciliation_status ? (
            <p className="text-xs text-muted-foreground mt-4">
              Reconciliation: <span className="font-medium text-foreground">{driver.reconciliation_status}</span>
              {driver.reconciliation_reasons?.[0]
                ? ` — ${driver.reconciliation_reasons[0]}`
                : ''}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <DriverWalletPayoutsTab
        driver={driver}
        currencyCode={currencyCode}
        isLoading={false}
      />

      <DriverWalletStripeTab
        driver={driver}
        currencyCode={currencyCode}
        regionId={regionId}
        isLoading={false}
      />
    </div>
  );
}
