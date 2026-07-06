import { Link } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { formatMoneyMinor } from '@/lib/formatMoneyMinor';
import { FinancialReconciliationRefreshBar } from '@/components/finance/FinancialReconciliationRefreshBar';
import type { FinancialReconciliationSSOTResult } from '@/hooks/useFinancialReconciliationSSOT';
import type { PlatformReconciliationKpis } from '@/hooks/useFinanceReconciliation';
import type { FinanceMoneyFormat } from '@/hooks/useFinanceReconciliationMoney';
import { FinanceSSOTBadge } from '@/components/finance/FinanceSSOTBadge';
import { formatProviderHealthLabel } from '@/lib/financialReconciliationGuards';
import { PlatformStripePendingExplainer } from '@/components/finance/PlatformStripePendingExplainer';
import {
  ServiceAreaGatewayStatusPanel,
  type ServiceAreaGatewayStatusRow,
} from '@/components/finance/ServiceAreaGatewayStatusPanel';

function KpiCard({ label, value, subtitle }: { label: string; value: string | number; subtitle?: string }) {
  return (
    <Card>
      <CardContent className="pt-4 pb-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-xl font-semibold mt-1">{value}</p>
        {subtitle && <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>}
      </CardContent>
    </Card>
  );
}

export function FinancialReconciliationOverviewTab({
  ssot,
  platformKpis,
  money,
  currencyGroups,
  serviceAreaGateways,
  readOnly = false,
  onRefresh,
  isRefreshing = false,
}: {
  ssot: FinancialReconciliationSSOTResult;
  platformKpis?: PlatformReconciliationKpis | null;
  money: FinanceMoneyFormat;
  currencyGroups?: Array<{
    currency_code: string;
    currency_symbol: string;
    currency_minor_unit: number;
    customer_revenue_pence: number;
    driver_net_pence: number;
    commission_pence: number;
    trip_count: number;
  }>;
  serviceAreaGateways?: ServiceAreaGatewayStatusRow[];
  readOnly?: boolean;
  onRefresh?: () => void;
  isRefreshing?: boolean;
}) {
  const fmt = money.fmt;
  const platformFmt = money.fmtPlatformStripe;
  const kpisUnavailable = platformKpis == null;
  const provider = ssot.summary?.provider_money;
  const driverMoney = ssot.summary?.driver_money;

  return (
    <div className="space-y-4">
      <FinancialReconciliationRefreshBar
        badge={isRefreshing ? 'REFRESHING' : ssot.badge}
        lastSyncedAt={ssot.lastSyncedAt}
        isRefreshing={isRefreshing}
        readOnly={readOnly}
        onRefresh={onRefresh}
        label="Platform reconciliation overview"
      />

      <div className="flex items-center gap-2">
        <FinanceSSOTBadge badge={ssot.badge} />
        <span className="text-xs text-muted-foreground">
          Payment provider integrity audit — verifies platform balances match ledger sync. Trip money is on Trip History.
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label={`Platform Available${money.currencyCode ? ` (${money.currencyCode})` : ''}`}
          value={provider?.provider_available_balance_pence != null ? platformFmt(provider.provider_available_balance_pence) : '—'}
        />
        <KpiCard
          label={`Platform Pending${money.currencyCode ? ` (${money.currencyCode})` : ''}`}
          value={provider?.provider_pending_balance_pence != null ? platformFmt(provider.provider_pending_balance_pence) : '—'}
        />
        <KpiCard
          label="Provider Health"
          value={formatProviderHealthLabel(provider?.provider_health_status, isRefreshing)}
        />
        <KpiCard label="Reconciliation" value={ssot.summary?.reconciliation_check?.status ?? '—'} />
      </div>

      {provider?.provider_pending_balance_pence != null && provider.provider_pending_balance_pence > 0 ? (
        <PlatformStripePendingExplainer
          pendingPence={provider.provider_pending_balance_pence}
          availablePence={provider.provider_available_balance_pence ?? 0}
          currencyCode={money.currencyCode}
          driverWalletTotalPence={driverMoney?.driver_payout_liability_pence ?? driverMoney?.driver_available_payout_pence}
          driverScheduledPayoutPence={driverMoney?.driver_pending_payout_pence}
        />
      ) : null}

      {money.isMixedCurrency && currencyGroups && currencyGroups.length > 0 ? (
        <div className="space-y-2">
          <p className="text-sm font-medium">Totals by currency</p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {currencyGroups.map((group) => (
              <Card key={group.currency_code}>
                <CardContent className="pt-4 pb-4 space-y-1">
                  <p className="text-xs text-muted-foreground">{group.currency_code} · {group.trip_count} trips</p>
                  <p className="text-sm">Revenue: {formatMoneyMinor(group.customer_revenue_pence, group.currency_code, 'en-GB', group.currency_minor_unit)}</p>
                  <p className="text-sm">Driver net: {formatMoneyMinor(group.driver_net_pence, group.currency_code, 'en-GB', group.currency_minor_unit)}</p>
                  <p className="text-sm">Commission: {formatMoneyMinor(group.commission_pence, group.currency_code, 'en-GB', group.currency_minor_unit)}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      ) : null}

      {serviceAreaGateways && serviceAreaGateways.length > 0 ? (
        <ServiceAreaGatewayStatusPanel rows={serviceAreaGateways} />
      ) : null}

      {kpisUnavailable ? (
        <Alert variant="destructive">
          <AlertTitle>Sync KPIs unavailable</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>Driver sync KPIs could not be loaded. Select a service area and refresh.</p>
            <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
              Refresh
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <KpiCard label="Balanced Drivers" value={platformKpis?.balanced_drivers ?? 0} />
          <KpiCard label="Failed Payouts" value={fmt(platformKpis?.failed_payouts_pence)} />
          <KpiCard label="Stripe-only Records" value={platformKpis?.stripe_only_records ?? 0} />
          <KpiCard label="Ledger-only Records" value={platformKpis?.ledger_only_records ?? 0} />
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Trip earnings and settlement calculations:{' '}
        <Link to="/trip-history" className="underline">Trip History (Trip Settlement SSOT)</Link>
        {' · '}
        <Link to="/financial-reconciliation?tab=drivers" className="underline">Drivers</Link>
        {' · '}
        <Link to="/financial-reconciliation?tab=stripe" className="underline">Stripe</Link>
      </p>
    </div>
  );
}
