import React, { useEffect, useMemo, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { ServiceAreaFinanceFilter, type ServiceAreaFinanceSelection } from '@/components/finance/ServiceAreaFinanceFilter';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useFinancialReconciliationSSOT } from '@/hooks/useFinancialReconciliationSSOT';
import { FinanceSSOTBadge } from '@/components/finance/FinanceSSOTBadge';
import { useFinanceBackendAudit } from '@/hooks/useFinanceBackendAudit';
import { safeReconciliationStatus } from '@/lib/financialReconciliationGuards';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DriverWalletSsotPanel } from '@/components/finance/DriverWalletSsotPanel';
import { FinancialReconciliationOverviewTab } from '@/components/finance/FinancialReconciliationOverviewTab';
import { FinancialReconciliationAlertsTab } from '@/components/finance/FinancialReconciliationAlertsTab';
import { FinancialReconciliationStripeTab } from '@/components/finance/FinancialReconciliationStripeTab';
import { DigitalFinanceEraPanel } from '@/components/finance/DigitalFinanceEraPanel';
import { AlertTriangle, RefreshCw, ShieldCheck } from 'lucide-react';

const FR_TABS = ['overview', 'drivers', 'stripe', 'alerts'] as const;
type FrTab = (typeof FR_TABS)[number];

function parseFrTab(value: string | null): FrTab {
  if (value === 'trips') return 'overview';
  if (value && (FR_TABS as readonly string[]).includes(value)) return value as FrTab;
  return 'overview';
}

function statusChipVariant(label: string | null | undefined): 'default' | 'secondary' | 'destructive' | 'outline' {
  const l = String(label ?? '').toLowerCase();
  if (l.includes('balanced') || l.includes('settled') || l.includes('paid')) return 'default';
  if (l.includes('error') || l.includes('failed') || l.includes('failing')) return 'destructive';
  if (l.includes('awaiting') || l.includes('partial')) return 'secondary';
  return 'outline';
}

class FinancialReconciliationErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[FinancialReconciliation]', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <AdminLayout title="Financial Reconciliation">
          <Alert variant="destructive">
            <AlertTitle>Financial Reconciliation failed to render</AlertTitle>
            <AlertDescription className="space-y-2">
              <p>{this.state.error.message}</p>
              <Button variant="outline" size="sm" onClick={() => this.setState({ error: null })}>
                Try Again
              </Button>
            </AlertDescription>
          </Alert>
        </AdminLayout>
      );
    }
    return this.props.children;
  }
}

function FinancialReconciliationPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const frTab = parseFrTab(searchParams.get('tab'));
  const [filter, setFilter] = useState<ServiceAreaFinanceSelection>({
    serviceAreaId: null,
    regionId: null,
    currencyCode: null,
  });
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  useEffect(() => {
    if (searchParams.get('tab') !== 'trips') return;
    const next = new URLSearchParams(searchParams);
    next.delete('tab');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const ssot = useFinancialReconciliationSSOT({
    filter,
    from: from || undefined,
    to: to || undefined,
  });
  const { isLoading, error, refetch, isFetching, readOnly, status: ssotStatus, snapshotSavedAt } = ssot;
  const data = ssot.response;

  const {
    data: backendAuditData,
  } = useFinanceBackendAudit({
    filter,
    from: from || undefined,
    to: to || undefined,
  });

  const summary = ssot.summary;
  const ccy = ssot.currencyCode || filter.currencyCode || 'GBP';
  const backendAudit = backendAuditData?.finance_backend_audit_v1;

  /** money_movement may live on response root or inside summary — merge for Stripe tab. */
  const stripeSummary = useMemo(() => {
    if (!summary) return null;
    const movement = summary.money_movement ?? data?.money_movement;
    if (movement === summary.money_movement) return summary;
    return { ...summary, money_movement: movement };
  }, [summary, data?.money_movement]);

  const reconciliationChip = useMemo(() => {
    if (!summary) return null;
    const reconciliationStatus = safeReconciliationStatus(summary);
    if (ssot.readOnly) {
      return reconciliationStatus === 'BALANCED' ? 'DEGRADED_SNAPSHOT' : reconciliationStatus;
    }
    if (reconciliationStatus === 'RECONCILIATION_MISMATCH' || reconciliationStatus === 'reconciliation_error') {
      return 'RECONCILIATION_MISMATCH';
    }
    if (reconciliationStatus === 'BALANCED') return 'BALANCED';
    return reconciliationStatus;
  }, [summary, ssot.readOnly]);

  const ssotBadge = ssot.badge;

  if (searchParams.get('tab') === 'connect-balance') {
    return <Navigate to="/driver-wallet-ledger?tab=stripe" replace />;
  }

  if (searchParams.get('recover') === '1') {
    const tripHistoryParams = new URLSearchParams();
    const tripCode = searchParams.get('trip');
    const tripId = searchParams.get('tripId');
    if (tripCode) tripHistoryParams.set('trip', tripCode);
    if (tripId) tripHistoryParams.set('tripId', tripId);
    tripHistoryParams.set('recover', '1');
    return <Navigate to={`/trip-history?${tripHistoryParams.toString()}`} replace />;
  }

  const setFrTab = (tab: FrTab) => {
    const next = new URLSearchParams(searchParams);
    next.set('tab', tab);
    setSearchParams(next, { replace: true });
  };

  if (isLoading && !summary) {
    return (
      <AdminLayout title="Financial Reconciliation">
        <div className="py-12 text-center text-muted-foreground">Loading finance reconciliation…</div>
      </AdminLayout>
    );
  }

  if (ssotStatus === 'UNAVAILABLE') {
    return (
      <AdminLayout title="Financial Reconciliation">
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <FinanceSSOTBadge badge="UNAVAILABLE" />
          </div>
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Financial Reconciliation unavailable</AlertTitle>
            <AlertDescription>
              {(error as Error | null)?.message ??
                'Live SSOT failed and no cached snapshot exists. Refresh after connectivity is restored.'}
            </AlertDescription>
          </Alert>
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={`h-4 w-4 mr-2 ${isFetching ? 'animate-spin' : ''}`} />
            Retry
          </Button>
        </div>
      </AdminLayout>
    );
  }

  if (!summary) {
    return (
      <AdminLayout title="Financial Reconciliation">
        <Alert variant="destructive">
          <AlertTitle>Reconciliation unavailable</AlertTitle>
          <AlertDescription>No reconciliation data is available.</AlertDescription>
        </Alert>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout title="Financial Reconciliation (SSOT)">
      <div className="space-y-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-6 w-6 text-primary" />
              <h1 className="text-2xl font-bold">Financial Reconciliation (SSOT)</h1>
            </div>
            <p className="text-sm text-muted-foreground mt-1 max-w-3xl">
              Audits Stripe platform integrity — does Stripe match ONECAB? Trip earnings are calculated on Trip History only.
            </p>
            <div className="flex flex-wrap items-center gap-2 mt-2">
              <FinanceSSOTBadge badge={ssotBadge} />
              {reconciliationChip && (
                <Badge variant={statusChipVariant(reconciliationChip)}>
                  {reconciliationChip}
                </Badge>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ServiceAreaFinanceFilter value={filter} onChange={setFilter} />
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-[150px]" />
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-[150px]" />
            <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw className={`h-4 w-4 mr-2 ${isFetching ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        </div>

        {ssotStatus === 'DEGRADED_SNAPSHOT' && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Financial Reconciliation SSOT unavailable — displaying read-only cached snapshot.</AlertTitle>
            <AlertDescription>
              Exports, payouts, retries, approvals, adjustments, and reconciliation actions are disabled until live SSOT
              recovers.
              {snapshotSavedAt ? ` Snapshot saved ${snapshotSavedAt}.` : null}
            </AlertDescription>
          </Alert>
        )}

        <DigitalFinanceEraPanel />

        <Tabs value={frTab} onValueChange={(v) => setFrTab(v as FrTab)}>
          <TabsList className="flex flex-wrap h-auto gap-1">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="drivers">Drivers</TabsTrigger>
            <TabsTrigger value="stripe">Stripe</TabsTrigger>
            <TabsTrigger value="alerts">Alerts</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="mt-4">
            <FinancialReconciliationOverviewTab
              ssot={ssot}
              platformKpis={data?.platform_kpis}
              currencyCode={ccy}
              readOnly={readOnly}
            />
          </TabsContent>

          <TabsContent value="drivers" className="mt-4">
            {frTab === 'drivers' && (
              <DriverWalletSsotPanel regionId={filter.regionId} currencyCode={ccy} />
            )}
          </TabsContent>

          <TabsContent value="stripe" className="mt-4">
            {frTab === 'stripe' && (
              <FinancialReconciliationStripeTab
                summary={stripeSummary}
                currencyCode={ccy}
                serviceFilter={filter}
                periodFrom={from || undefined}
                periodTo={to || undefined}
                periodLabel={from && to ? `${from} → ${to}` : undefined}
                paymentIntents={data?.stripe_payment_intents ?? []}
                stripeBalanceError={data?.meta?.stripe_balance_error ?? null}
                readOnly={readOnly}
              />
            )}
          </TabsContent>

          <TabsContent value="alerts" className="mt-4">
            {frTab === 'alerts' && (
              <FinancialReconciliationAlertsTab
                ssot={ssot}
                backendAudit={backendAudit}
                regionId={filter.regionId ?? null}
                currencyCode={ccy}
                readOnly={readOnly}
              />
            )}
          </TabsContent>
        </Tabs>
      </div>
    </AdminLayout>
  );
}

export default function FinancialReconciliation() {
  return (
    <FinancialReconciliationErrorBoundary>
      <FinancialReconciliationPage />
    </FinancialReconciliationErrorBoundary>
  );
}
