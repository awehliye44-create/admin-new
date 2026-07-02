import { Link } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { formatPence } from '@/hooks/useDriverWallet';
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
  readOnly: _readOnly = false,
}: {
  ssot: FinancialReconciliationSSOTResult;
  platformKpis?: PlatformReconciliationKpis | null;
  currencyCode: string;
  readOnly?: boolean;
}) {
  const fmt = (p: number) => formatPence(p, currencyCode);
  const kpisUnavailable = platformKpis == null;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <FinanceSSOTBadge badge={ssot.badge} />
        <span className="text-xs text-muted-foreground">
          {kpisUnavailable
            ? 'Platform KPIs — unavailable (admin-finance-reconciliation SSOT)'
            : `Platform KPIs — admin-finance-reconciliation SSOT (${platformKpis.driver_count} drivers)`}
        </span>
      </div>

      {kpisUnavailable ? (
        <Alert variant="destructive">
          <AlertTitle>Platform KPIs unavailable</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>Live platform KPIs could not be loaded from the SSOT backend. No zero-fallback values are shown.</p>
            <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
              Refresh
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <KpiCard label="Balanced Drivers" value={platformKpis.balanced_drivers} />
          <KpiCard label="Drivers with Recovery" value={platformKpis.drivers_with_recovery} />
          <KpiCard label="Outstanding Liability" value={fmt(platformKpis.outstanding_liability_pence)} />
          <KpiCard label="Outstanding Recovery" value={fmt(platformKpis.outstanding_recovery_pence)} />
          <KpiCard label="Failed Payouts" value={fmt(platformKpis.failed_payouts_pence)} />
          <KpiCard label="Stripe-only" value={platformKpis.stripe_only_records} />
          <KpiCard label="Ledger-only" value={platformKpis.ledger_only_records} />
          <KpiCard label="Today's Captures" value={fmt(platformKpis.todays_captures_pence)} />
          <KpiCard label="Today's Card Trips" value={platformKpis.todays_card_trips} />
          <KpiCard label="Today's Cash Trips" value={platformKpis.todays_cash_trips} />
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Canonical platform financial KPIs — not duplicated on Dashboard or other admin pages.{' '}
        <Link to="/financial-reconciliation?tab=trips" className="underline">Trips</Link>
        {' · '}
        <Link to="/financial-reconciliation?tab=drivers" className="underline">Drivers</Link>
      </p>
    </div>
  );
}
