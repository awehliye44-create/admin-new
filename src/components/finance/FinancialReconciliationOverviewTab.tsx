import { Link } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { formatPence } from '@/hooks/useDriverWallet';
import { FinancialReconciliationRefreshBar } from '@/components/finance/FinancialReconciliationRefreshBar';
import type { FinancialReconciliationSSOTResult } from '@/hooks/useFinancialReconciliationSSOT';
import type { PlatformReconciliationKpis } from '@/hooks/useFinanceReconciliation';
import { FinanceSSOTBadge } from '@/components/finance/FinanceSSOTBadge';

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
  currencyCode,
  readOnly = false,
  onRefresh,
  isRefreshing = false,
}: {
  ssot: FinancialReconciliationSSOTResult;
  platformKpis?: PlatformReconciliationKpis | null;
  currencyCode: string;
  readOnly?: boolean;
  onRefresh?: () => void;
  isRefreshing?: boolean;
}) {
  const fmt = (p: number | null | undefined) => formatPence(Number(p ?? 0), currencyCode);
  const kpisUnavailable = platformKpis == null;
  const provider = ssot.summary?.provider_money;

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
          Stripe integrity audit — verifies platform and Connect match ledger sync. Trip money is on Trip History.
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Platform Stripe Available"
          value={provider?.provider_available_balance_pence != null ? fmt(provider.provider_available_balance_pence) : '—'}
        />
        <KpiCard
          label="Platform Stripe Pending"
          value={provider?.provider_pending_balance_pence != null ? fmt(provider.provider_pending_balance_pence) : '—'}
        />
        <KpiCard
          label="Provider Health"
          value={provider?.provider_health_status ?? '—'}
        />
        <KpiCard label="Reconciliation" value={ssot.summary?.reconciliation_check?.status ?? '—'} />
      </div>

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
