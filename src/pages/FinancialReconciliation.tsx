import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { format, subDays } from 'date-fns';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { ServiceAreaFinanceFilter, DEFAULT_SERVICE_AREA_SELECTION, type ServiceAreaFinanceSelection } from '@/components/finance/ServiceAreaFinanceFilter';
import { useServiceAreas } from '@/hooks/useServiceAreas';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useFinancialReconciliationSSOT } from '@/hooks/useFinancialReconciliationSSOT';
import { FinanceSSOTBadge } from '@/components/finance/FinanceSSOTBadge';
import { useFinanceBackendAudit } from '@/hooks/useFinanceBackendAudit';
import { safeReconciliationStatus, formatFinanceDateSafe } from '@/lib/financialReconciliationGuards';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DriverWalletSsotPanel } from '@/components/finance/DriverWalletSsotPanel';
import { FinancialReconciliationOverviewTab } from '@/components/finance/FinancialReconciliationOverviewTab';
import { FinancialReconciliationAlertsTab } from '@/components/finance/FinancialReconciliationAlertsTab';
import { FinancialReconciliationStripeTab } from '@/components/finance/FinancialReconciliationStripeTab';
import { FinancialReconciliationTripsTab } from '@/components/finance/FinancialReconciliationTripsTab';
import { DigitalFinanceEraPanel } from '@/components/finance/DigitalFinanceEraPanel';
import { useFinanceReconciliationMoney } from '@/hooks/useFinanceReconciliationMoney';
import { AlertTriangle, RefreshCw, ShieldCheck } from 'lucide-react';

const FR_TABS = ['overview', 'drivers', 'trips', 'stripe', 'alerts'] as const;
type FrTab = (typeof FR_TABS)[number];

function parseFrTab(value: string | null): FrTab {
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
  const [filter, setFilter] = useState<ServiceAreaFinanceSelection>(DEFAULT_SERVICE_AREA_SELECTION);
  const [financeScopeReady, setFinanceScopeReady] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [recoverTripId, setRecoverTripId] = useState<string | null>(null);
  const [recoverTripCode, setRecoverTripCode] = useState<string | null>(null);

  const { data: serviceAreas = [], isLoading: serviceAreasLoading } = useServiceAreas({ activeOnly: true });

  useEffect(() => {
    if (financeScopeReady || serviceAreasLoading) return;
    if (filter.regionId || filter.serviceAreaId) {
      setFinanceScopeReady(true);
      return;
    }
    const first = serviceAreas[0];
    if (first) {
      const cc = first.region?.currency_code || first.currency_code || null;
      setFilter({ serviceAreaId: first.id, regionId: first.region_id, currencyCode: cc });
    }
    setFinanceScopeReady(true);
  }, [financeScopeReady, filter.regionId, filter.serviceAreaId, serviceAreas, serviceAreasLoading]);

  useEffect(() => {
    if (!financeScopeReady || from || to) return;
    const end = new Date();
    const start = subDays(end, 7);
    setFrom(format(start, 'yyyy-MM-dd'));
    setTo(format(end, 'yyyy-MM-dd'));
  }, [financeScopeReady, from, to]);

  const ssot = useFinancialReconciliationSSOT({
    filter,
    from: from || undefined,
    to: to || undefined,
    enabled: financeScopeReady,
  });
  const { isLoading, error, refetchFresh, isFetching, readOnly, status: ssotStatus, snapshotSavedAt, lastSyncedAt, badge: ssotBadge } = ssot;
  const data = ssot.response;

  const {
    data: backendAuditData,
  } = useFinanceBackendAudit({
    filter,
    from: from || undefined,
    to: to || undefined,
    enabled: financeScopeReady,
  });

  const summary = ssot.summary;
  const money = useFinanceReconciliationMoney(data, filter.currencyCode);
  const ccy = money.currencyCode ?? filter.currencyCode ?? '';
  const backendAudit = backendAuditData?.finance_backend_audit_v1;

  useEffect(() => {
    if (searchParams.get('recover') === '1') {
      const tripCode = searchParams.get('trip');
      const tripId = searchParams.get('tripId');
      setRecoverTripId(tripId);
      setRecoverTripCode(tripCode);
      const next = new URLSearchParams(searchParams);
      next.set('tab', 'trips');
      next.delete('recover');
      setSearchParams(next, { replace: true });
      return;
    }
    const tripCode = searchParams.get('trip');
    const tripId = searchParams.get('tripId');
    if (tripCode || tripId) {
      setRecoverTripId(tripId);
      setRecoverTripCode(tripCode);
    }
  }, [searchParams, setSearchParams]);

  const clearRecoverTrip = useCallback(() => {
    setRecoverTripId(null);
    setRecoverTripCode(null);
  }, []);

  /** money_movement may live on response root or inside summary — merge for Stripe tab. */
  const stripeSummary = useMemo(() => {
    if (!summary) return null;
    const movement = summary.money_movement ?? data?.money_movement;
    if (movement === summary.money_movement) return summary;
    return { ...summary, money_movement: movement };
  }, [summary, data?.money_movement]);

  const tripAuditRows = data?.trip_financial_audit ?? [];

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

  if (searchParams.get('tab') === 'connect-balance') {
    return <Navigate to="/driver-wallet-ledger?tab=stripe" replace />;
  }

  const lastSyncedLabel = lastSyncedAt
    ? formatFinanceDateSafe(lastSyncedAt, 'dd MMM yyyy HH:mm:ss')
    : null;

  const setFrTab = (tab: FrTab) => {
    const next = new URLSearchParams(searchParams);
    next.set('tab', tab);
    setSearchParams(next, { replace: true });
  };

  if (!financeScopeReady || (isLoading && !summary)) {
    return (
      <AdminLayout title="Financial Reconciliation">
        <div className="py-12 text-center text-muted-foreground">
          {!financeScopeReady ? 'Preparing finance scope…' : 'Loading finance reconciliation…'}
        </div>
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
            <AlertDescription className="space-y-2">
              <p>
                {(error as Error | null)?.message ??
                  'Live SSOT failed and no cached snapshot exists. Refresh after connectivity is restored.'}
              </p>
              <p className="text-xs text-muted-foreground">
                Source: <code className="text-xs">admin-finance-reconciliation</code>
                {filter.regionId ? ` (region ${filter.regionId.slice(0, 8)}…)` : filter.serviceAreaId ? ' (service area)' : ' (all services)'}
                . Sign in as admin if you see 401/403.
              </p>
            </AlertDescription>
          </Alert>
          <Button variant="outline" size="sm" onClick={() => void refetchFresh()} disabled={isFetching}>
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
              {lastSyncedLabel && (ssotStatus === 'LIVE' || ssotBadge === 'REFRESHING') && (
                <Badge variant="outline" className="text-xs font-normal">
                  Last synced {lastSyncedLabel}
                </Badge>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ServiceAreaFinanceFilter value={filter} onChange={setFilter} autoSelectFirstArea={false} />
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-[150px]" />
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-[150px]" />
            <Button variant="outline" size="sm" onClick={() => void refetchFresh()} disabled={isFetching}>
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

        {money.isMixedCurrency && (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Mixed currencies</AlertTitle>
            <AlertDescription>
              All Services spans multiple operational currencies. Totals are not summed into one symbol —
              see grouped amounts per currency on Overview.
            </AlertDescription>
          </Alert>
        )}

        <DigitalFinanceEraPanel />

        <Tabs value={frTab} onValueChange={(v) => setFrTab(v as FrTab)}>
          <TabsList className="flex flex-wrap h-auto gap-1">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="drivers">Drivers</TabsTrigger>
            <TabsTrigger value="trips">Trips ({tripAuditRows.length})</TabsTrigger>
            <TabsTrigger value="stripe">Stripe</TabsTrigger>
            <TabsTrigger value="alerts">Alerts</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="mt-4">
            <FinancialReconciliationOverviewTab
              ssot={ssot}
              platformKpis={data?.platform_kpis}
              money={money}
              currencyGroups={data?.currency_groups}
              serviceAreaGateways={data?.service_area_payment_gateways}
              readOnly={readOnly}
              onRefresh={() => void refetchFresh()}
              isRefreshing={isFetching}
            />
          </TabsContent>

          <TabsContent value="drivers" className="mt-4">
            {frTab === 'drivers' && (
              <DriverWalletSsotPanel
                regionId={filter.regionId}
                currencyCode={ccy || undefined}
                filter={filter}
                pageFrom={from || undefined}
                pageTo={to || undefined}
                money={money}
                readOnly={readOnly}
                ssotBadge={ssotBadge}
                lastSyncedAt={lastSyncedAt}
                serviceAreaName={
                  serviceAreas.find((sa) => sa.id === filter.serviceAreaId)?.name
                  ?? serviceAreas.find((sa) => sa.region_id === filter.regionId)?.name
                  ?? null
                }
              />
            )}
          </TabsContent>

          <TabsContent value="trips" className="mt-4">
            {frTab === 'trips' && (
              <FinancialReconciliationTripsTab
                rows={tripAuditRows}
                money={money}
                readOnly={readOnly}
                ssotBadge={ssotBadge}
                lastSyncedAt={lastSyncedAt}
                isRefreshing={isFetching}
                onRefresh={() => void refetchFresh()}
                initialTripId={recoverTripId}
                initialTripCode={recoverTripCode}
                onInitialTripConsumed={clearRecoverTrip}
              />
            )}
          </TabsContent>

          <TabsContent value="stripe" className="mt-4">
            {frTab === 'stripe' && (
              <FinancialReconciliationStripeTab
                summary={stripeSummary}
                money={money}
                serviceFilter={filter}
                periodFrom={from || undefined}
                periodTo={to || undefined}
                periodLabel={from && to ? `${from} → ${to}` : undefined}
                auditRows={tripAuditRows}
                paymentIntents={data?.stripe_payment_intents ?? []}
                stripeBalanceError={data?.meta?.stripe_balance_error ?? null}
                ssotStatus={ssotStatus}
                ssotBadge={ssotBadge}
                lastSyncedAt={lastSyncedAt}
                snapshotSavedAt={snapshotSavedAt}
                readOnly={readOnly}
                onRefreshStripe={() => void refetchFresh()}
                isRefreshingStripe={isFetching}
              />
            )}
          </TabsContent>

          <TabsContent value="alerts" className="mt-4">
            {frTab === 'alerts' && (
              <FinancialReconciliationAlertsTab
                ssot={ssot}
                backendAudit={backendAudit}
                money={money}
                regionId={filter.regionId ?? null}
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
