import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { format, subDays } from 'date-fns';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { ServiceAreaFinanceFilter, DEFAULT_SERVICE_AREA_SELECTION, type ServiceAreaFinanceSelection } from '@/components/finance/ServiceAreaFinanceFilter';
import { useServiceAreas } from '@/hooks/useServiceAreas';
import { FINANCIAL_MODEL, filterServiceAreasByFinancialModel } from '../../shared/financialModelScopeSSOT';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useFinancialReconciliationSSOT } from '@/hooks/useFinancialReconciliationSSOT';
import { FinanceSSOTBadge } from '@/components/finance/FinanceSSOTBadge';
import { safeReconciliationStatus, formatFinanceDateSafe } from '@/lib/financialReconciliationGuards';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DriverWalletSsotPanel } from '@/components/finance/DriverWalletSsotPanel';
import { FinancialReconciliationOverviewTab } from '@/components/finance/FinancialReconciliationOverviewTab';
import { FinancialReconciliationTripsTab } from '@/components/finance/FinancialReconciliationTripsTab';
import { FinancialReconciliationIssuesTab } from '@/components/finance/FinancialReconciliationIssuesTab';
import { DigitalFinanceEraPanel } from '@/components/finance/DigitalFinanceEraPanel';
import { FinancePanelErrorBoundary } from '@/components/finance/FinancePanelErrorBoundary';
import { useFinanceReconciliationMoney } from '@/hooks/useFinanceReconciliationMoney';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { startAdminPerformanceStep } from '@/lib/recordAdminPerformanceStep';
import { paymentSessionsUrl } from '../../shared/adminPaymentSessionsSSOT';
import { classifyFinanceReconciliationError } from '@/lib/financeReconciliationErrors';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { DriverCreditExceptionsBanner } from '@/components/finance/DriverCreditExceptionsBanner';
import {
  buildFrUnifiedIssues,
  countFrIssuesByFilter,
  parseFrIssueFilter,
  parseFrTripFilter,
  resolveFrDriverCreditBanner,
  resolveFrTabBadgeCounts,
  resolveLegacyFrTabIssueFilter,
  financialReconciliationLegacyTabRedirect,
  type FrIssueFilter,
} from '../../shared/frIssuesSSOT';
import { aggregateDriverCreditExceptions } from '../../shared/driverCreditMonitoringSSOT';

const FR_TABS = ['overview', 'trips', 'drivers', 'issues'] as const;
type FrTab = (typeof FR_TABS)[number];

/** Tabs that need the full trip_financial_audit payload (not summary_only). */
const FR_FULL_AUDIT_TABS: ReadonlySet<FrTab> = new Set(['trips', 'issues']);

function parseFrTab(value: string | null): FrTab {
  if (value && (FR_TABS as readonly string[]).includes(value)) return value as FrTab;
  if (resolveLegacyFrTabIssueFilter(value)) return 'issues';
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
        <AdminLayout title="Financial Reconciliation (SSOT)">
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
    // Never auto-land on a CW service area — FR is PLATFORM_COLLECTED only.
    const platformAreas = filterServiceAreasByFinancialModel(
      serviceAreas,
      FINANCIAL_MODEL.PLATFORM_COLLECTED,
    );
    const first = platformAreas[0];
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

  const auditMode = FR_FULL_AUDIT_TABS.has(frTab) ? 'full' : 'summary';
  const ssot = useFinancialReconciliationSSOT({
    filter,
    from: from || undefined,
    to: to || undefined,
    enabled: financeScopeReady,
    auditMode,
  });
  const {
    isLoading,
    error,
    auditError,
    refetchFresh,
    isFetching,
    isAuditLoading,
    isAuditScopeTransition,
    isSummaryScopeTransition,
    readOnly,
    status: ssotStatus,
    snapshotSavedAt,
    lastSyncedAt,
    badge: ssotBadge,
  } = ssot;
  const isFinanceRefreshing = isFetching;

  const handleRefreshFinance = useCallback(async () => {
    const perf = startAdminPerformanceStep({ action_name: 'admin_refresh_finance' });
    try {
      await refetchFresh();
      perf.complete({ success: true });
    } catch (err) {
      perf.complete({
        success: false,
        error_code: err instanceof Error ? err.message : 'refresh_failed',
      });
    }
  }, [refetchFresh]);
  const data = ssot.response;

  const summary = ssot.summary;
  const money = useFinanceReconciliationMoney(data, filter.currencyCode);
  const ccy = money.currencyCode ?? filter.currencyCode ?? '';

  useEffect(() => {
    if (searchParams.get('recover') === '1') {
      const tripCode = searchParams.get('trip');
      const tripId = searchParams.get('tripId');
      setRecoverTripId(tripId);
      setRecoverTripCode(tripCode);
      const next = new URLSearchParams(searchParams);
      next.set('tab', 'trips');
      next.delete('recover');
      next.delete('issueFilter');
      next.delete('tripFilter');
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
    const next = new URLSearchParams(searchParams);
    if (!next.has('trip') && !next.has('tripId')) return;
    next.delete('trip');
    next.delete('tripId');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const rawTripAuditRows = data?.trip_financial_audit ?? [];
  const tripAuditRows = isAuditScopeTransition ? [] : rawTripAuditRows;
  const issueFilter = parseFrIssueFilter(searchParams.get('issueFilter'));
  const tripFilter = parseFrTripFilter(searchParams.get('tripFilter'));
  const issueTripCodes = useMemo(() => {
    const raw = searchParams.get('issueTripCodes');
    if (!raw?.trim()) return [];
    return raw.split(',').map((code) => code.trim()).filter(Boolean);
  }, [searchParams]);
  const legacyTab = searchParams.get('tab');

  const unifiedIssues = useMemo(() => buildFrUnifiedIssues(tripAuditRows), [tripAuditRows]);
  const issueCounts = useMemo(() => countFrIssuesByFilter(unifiedIssues), [unifiedIssues]);
  const tabBadgeCounts = useMemo(
    () => resolveFrTabBadgeCounts({
      tripAuditRows,
      unifiedOpenIssueCount: issueCounts.all,
      auditOverviewKpis: (isAuditScopeTransition || isSummaryScopeTransition) ? null : data?.audit_overview_kpis,
      metaTripCount: (isAuditScopeTransition || isSummaryScopeTransition) ? undefined : data?.meta?.trip_count,
    }),
    [tripAuditRows, issueCounts.all, data?.audit_overview_kpis, data?.meta?.trip_count, isAuditScopeTransition, isSummaryScopeTransition],
  );
  const driverCreditBanner = useMemo(
    () => resolveFrDriverCreditBanner({
      tripAuditRows,
      tripAgg: aggregateDriverCreditExceptions(tripAuditRows),
      auditOverviewKpis: (isAuditScopeTransition || isSummaryScopeTransition) ? null : data?.audit_overview_kpis,
    }),
    [tripAuditRows, data?.audit_overview_kpis, isAuditScopeTransition, isSummaryScopeTransition],
  );

  const periodLabel = from && to ? `${from} – ${to}` : undefined;
  const serviceAreaLabel =
    serviceAreas.find((sa) => sa.id === filter.serviceAreaId)?.name
    ?? serviceAreas.find((sa) => sa.region_id === filter.regionId)?.name
    ?? 'all';
  const frAuditExportMeta = useMemo(() => ({
    generatedAt: new Date().toISOString(),
    sourceSsot: 'Financial Reconciliation audit (Payment Sessions + trip settlement + Driver Wallet Ledger + Payout Ledger)',
    serviceArea: serviceAreaLabel,
    currency: ccy || 'GBP',
    formulaVersion: 'fr_trip_audit_v1',
    unresolvedMismatches: tabBadgeCounts.openIssueCount,
    periodLabel,
  }), [serviceAreaLabel, ccy, tabBadgeCounts.openIssueCount, periodLabel]);

  const handleDriverCreditFilter = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    if (frTab === 'trips') {
      if (tripFilter === 'driver_credit') {
        next.delete('tripFilter');
      } else {
        next.set('tripFilter', 'driver_credit');
      }
      setSearchParams(next, { replace: true });
      return;
    }
    if (frTab === 'issues') {
      if (issueFilter === 'driver_credit') {
        next.delete('issueFilter');
      } else {
        next.set('issueFilter', 'driver_credit');
      }
      setSearchParams(next, { replace: true });
      return;
    }
    next.set('tab', 'issues');
    next.delete('tripFilter');
    next.set('issueFilter', 'driver_credit');
    setSearchParams(next, { replace: true });
  }, [frTab, issueFilter, tripFilter, searchParams, setSearchParams]);

  const handleIssueFilterChange = useCallback((filterValue: FrIssueFilter) => {
    const next = new URLSearchParams(searchParams);
    next.set('tab', 'issues');
    next.delete('tripFilter');
    if (filterValue === 'all') next.delete('issueFilter');
    else next.set('issueFilter', filterValue);
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const frPerfRef = useRef<ReturnType<typeof startAdminPerformanceStep> | null>(null);
  useEffect(() => {
    frPerfRef.current = startAdminPerformanceStep({
      action_name: 'admin_financial_reconciliation_load',
    });
  }, []);

  useEffect(() => {
    if (!financeScopeReady || isLoading) return;
    frPerfRef.current?.complete({
      success: !error,
      error_code: error ? 'financial_reconciliation_load_failed' : null,
    });
    frPerfRef.current = null;
  }, [financeScopeReady, isLoading, error]);

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
    return <Navigate to="/financial-reconciliation?tab=overview" replace />;
  }
  if (searchParams.get('driverCreditExceptions') === '1') {
    return <Navigate to="/financial-reconciliation?tab=issues&issueFilter=driver_credit" replace />;
  }
  if (legacyTab && !(FR_TABS as readonly string[]).includes(legacyTab)) {
    const redirect = financialReconciliationLegacyTabRedirect(legacyTab);
    if (redirect) {
      return <Navigate to={redirect} replace />;
    }
    return <Navigate to="/financial-reconciliation?tab=overview" replace />;
  }

  const rawIssueFilter = searchParams.get('issueFilter');
  if (rawIssueFilter && frTab !== 'issues') {
    const next = new URLSearchParams(searchParams);
    next.delete('issueFilter');
    return <Navigate to={`/financial-reconciliation?${next.toString()}`} replace />;
  }
  if (
    frTab === 'issues'
    && rawIssueFilter
    && (rawIssueFilter !== issueFilter || rawIssueFilter === 'all')
  ) {
    const next = new URLSearchParams(searchParams);
    if (issueFilter === 'all') next.delete('issueFilter');
    else next.set('issueFilter', issueFilter);
    return <Navigate to={`/financial-reconciliation?${next.toString()}`} replace />;
  }

  const rawTripFilter = searchParams.get('tripFilter');
  if (rawTripFilter && (frTab !== 'trips' || !tripFilter)) {
    const next = new URLSearchParams(searchParams);
    next.delete('tripFilter');
    return <Navigate to={`/financial-reconciliation?${next.toString()}`} replace />;
  }

  if (frTab !== 'trips' && (searchParams.get('trip') || searchParams.get('tripId'))) {
    const next = new URLSearchParams(searchParams);
    next.delete('trip');
    next.delete('tripId');
    return <Navigate to={`/financial-reconciliation?${next.toString()}`} replace />;
  }

  const lastSyncedLabel = lastSyncedAt
    ? formatFinanceDateSafe(lastSyncedAt, 'dd MMM yyyy HH:mm:ss')
    : null;

  const setFrTab = (tab: FrTab) => {
    const next = new URLSearchParams(searchParams);
    next.set('tab', tab);
    if (tab !== 'issues') {
      next.delete('issueFilter');
    }
    if (tab !== 'trips') {
      next.delete('tripFilter');
      next.delete('trip');
      next.delete('tripId');
    }
    setSearchParams(next, { replace: true });
  };

  // First paint: shell + filters immediately. Summary cards skeleton independently.
  if (!financeScopeReady) {
    return (
      <AdminLayout title="Financial Reconciliation (SSOT)">
        <div className="py-12 text-center text-muted-foreground">Preparing finance scope…</div>
      </AdminLayout>
    );
  }

  if (ssotStatus === 'UNAVAILABLE' && !isLoading) {
    const failure = classifyFinanceReconciliationError(error);
    return (
      <AdminLayout
        title="Financial Reconciliation (SSOT)"
        description="Audit and comparison only — holds, wallet writes, and payouts live on their own pages."
      >
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <FinanceSSOTBadge badge="UNAVAILABLE" />
            <ServiceAreaFinanceFilter financialModel="PLATFORM_COLLECTED" value={filter} onChange={setFilter} autoSelectFirstArea={false} />
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-[150px]" />
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-[150px]" />
          </div>
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Financial Reconciliation unavailable</AlertTitle>
            <AlertDescription className="space-y-2">
              <p>{failure.userMessage}</p>
              {failure.kind === 'forbidden' && (
                <p className="text-xs">Required permission: <code>financial-reconciliation</code></p>
              )}
              <p className="text-xs text-muted-foreground">
                Hold operations:{' '}
                <Link className="underline" to={paymentSessionsUrl({ tab: 'active_holds' })}>
                  Open Payment Sessions
                </Link>
              </p>
            </AlertDescription>
          </Alert>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => void handleRefreshFinance()} disabled={isFinanceRefreshing}>
              <RefreshCw className={`h-4 w-4 mr-2 ${isFinanceRefreshing ? 'animate-spin' : ''}`} />
              Retry
            </Button>
            <Button asChild variant="secondary" size="sm">
              <Link to={paymentSessionsUrl()}>Payment Sessions</Link>
            </Button>
          </div>
          <Collapsible>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm" className="text-xs text-muted-foreground">
                View diagnostics
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <pre className="mt-2 max-h-48 overflow-auto rounded-md border bg-muted/40 p-3 text-[11px] whitespace-pre-wrap">
                {`function: admin-finance-reconciliation\nstatus: ${failure.httpStatus ?? 'n/a'}\nkind: ${failure.kind}\n${failure.diagnostics}`}
              </pre>
            </CollapsibleContent>
          </Collapsible>
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout
      title="Financial Reconciliation (SSOT)"
      description="Audits provider vs ONECAB integrity. Hold release, wallet credits, and payout execution live on their own pages."
    >
      <div className="space-y-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <FinanceSSOTBadge badge={summary ? ssotBadge : 'REFRESHING'} />
              {reconciliationChip && !isSummaryScopeTransition && (
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
            <ServiceAreaFinanceFilter financialModel="PLATFORM_COLLECTED" value={filter} onChange={setFilter} autoSelectFirstArea={false} />
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-[150px]" />
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-[150px]" />
            <Button variant="outline" size="sm" onClick={() => void handleRefreshFinance()} disabled={isFinanceRefreshing}>
              <RefreshCw className={`h-4 w-4 mr-2 ${isFinanceRefreshing ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        </div>

        {(!summary || (frTab === 'overview' && isSummaryScopeTransition)) ? (
          <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
            Loading reconciliation overview…
          </div>
        ) : null}

        {isAuditLoading && (frTab === 'trips' || frTab === 'issues') ? (
          <p className="text-xs text-muted-foreground px-1">
            Loading trip audit for {frTab === 'trips' ? 'Trips' : 'Issues'}…
          </p>
        ) : null}

        {ssotStatus === 'DEGRADED_SNAPSHOT' && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Awaiting Provider Sync</AlertTitle>
            <AlertDescription>
              Financial Reconciliation is read-only and showing the last verified snapshot. Money is never edited here.
              Exports, payouts, retries, approvals, adjustments, and reconciliation actions stay disabled until live SSOT recovers.
              {snapshotSavedAt ? ` Last updated ${snapshotSavedAt}.` : null}
            </AlertDescription>
          </Alert>
        )}
        {(ssotBadge === 'PARTIAL' || ssot.response?.downstream_status?.provider === 'UNAVAILABLE') && ssotStatus !== 'DEGRADED_SNAPSHOT' && (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Awaiting Provider Sync</AlertTitle>
            <AlertDescription>
              Provider balance/API evidence is unavailable. Showing last verified ONECAB trip and wallet audit rows.
              Downstream: provider={ssot.response?.downstream_status?.provider ?? 'unknown'}.
            </AlertDescription>
          </Alert>
        )}
        {ssot.response?.downstream_status?.payment_sessions === 'UNAVAILABLE' && ssotStatus !== 'DEGRADED_SNAPSHOT' && (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>PAYMENT_EVIDENCE_UNAVAILABLE</AlertTitle>
            <AlertDescription className="space-y-2">
              <p>Payment Sessions evidence could not load. Trip and wallet audit rows are still shown where available.</p>
              <Link to={paymentSessionsUrl()} className="underline font-medium">Open Payment Sessions</Link>
            </AlertDescription>
          </Alert>
        )}
        {ssot.response?.downstream_status?.wallet === 'UNAVAILABLE' && ssotStatus !== 'DEGRADED_SNAPSHOT' && (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>WALLET_EVIDENCE_UNAVAILABLE</AlertTitle>
            <AlertDescription>
              Driver wallet evidence could not load. Trip and payment audit rows are preserved.
            </AlertDescription>
          </Alert>
        )}
        {ssot.response?.downstream_status?.payouts === 'UNAVAILABLE' && ssotStatus !== 'DEGRADED_SNAPSHOT' && (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>PAYOUT_EVIDENCE_UNAVAILABLE</AlertTitle>
            <AlertDescription>
              Payout Ledger evidence could not load. All other audit data is preserved.
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

        <DriverCreditExceptionsBanner
          exceptionTripCount={driverCreditBanner.exception_trip_count}
          totalDifferencePence={driverCreditBanner.total_difference_pence}
          currencyCode={ccy || 'GBP'}
          onFilterExceptions={handleDriverCreditFilter}
          active={
            (frTab === 'trips' && tripFilter === 'driver_credit')
            || (frTab === 'issues' && issueFilter === 'driver_credit')
          }
        />

        <Tabs value={frTab} onValueChange={(v) => setFrTab(v as FrTab)}>
          <TabsList className="flex flex-wrap h-auto gap-1">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="trips">
              Trips{tabBadgeCounts.periodTripCount > 0 ? ` (${tabBadgeCounts.periodTripCount})` : ''}
            </TabsTrigger>
            <TabsTrigger value="drivers">Drivers</TabsTrigger>
            <TabsTrigger value="issues">
              Issues{tabBadgeCounts.openIssueCount > 0 ? ` (${tabBadgeCounts.openIssueCount})` : ''}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="mt-4">
            {frTab === 'overview' && (
              <FinancePanelErrorBoundary panelName="Overview">
                {summary && !isSummaryScopeTransition ? (
                  <FinancialReconciliationOverviewTab
                    ssot={ssot}
                    auditOverviewKpis={isSummaryScopeTransition ? null : data?.audit_overview_kpis}
                    money={money}
                    currencyGroups={isSummaryScopeTransition ? undefined : data?.currency_groups}
                    filter={filter}
                    from={from || undefined}
                    to={to || undefined}
                    openIssueCount={tabBadgeCounts.openIssueCount}
                    readOnly={readOnly}
                    onRefresh={() => void handleRefreshFinance()}
                    isRefreshing={isFinanceRefreshing}
                  />
                ) : (
                  <div className="py-8 text-center text-sm text-muted-foreground">
                    Loading overview…
                  </div>
                )}
              </FinancePanelErrorBoundary>
            )}
          </TabsContent>

          <TabsContent value="drivers" className="mt-4">
            {frTab === 'drivers' && (
              <FinancePanelErrorBoundary panelName="Drivers">
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
              </FinancePanelErrorBoundary>
            )}
          </TabsContent>

          <TabsContent value="trips" className="mt-4">
            {frTab === 'trips' && (
              <FinancePanelErrorBoundary panelName="Trips">
                {((isAuditLoading && tripAuditRows.length === 0) || isAuditScopeTransition) ? (
                  <div className="py-8 text-center text-sm text-muted-foreground">
                    Loading trip audit…
                  </div>
                ) : auditError && tripAuditRows.length === 0 ? (
                  <Alert variant="destructive">
                    <AlertTitle>Trip audit unavailable</AlertTitle>
                    <AlertDescription>{auditError.message}</AlertDescription>
                  </Alert>
                ) : error && tripAuditRows.length === 0 ? (
                  <Alert variant="destructive">
                    <AlertTitle>Trip audit unavailable</AlertTitle>
                    <AlertDescription>
                      {error instanceof Error ? error.message : 'Could not load trip audit for this period.'}
                    </AlertDescription>
                  </Alert>
                ) : (
                  <FinancialReconciliationTripsTab
                    rows={tripAuditRows}
                    money={money}
                    readOnly={readOnly}
                    ssotBadge={ssotBadge}
                    lastSyncedAt={lastSyncedAt}
                    isRefreshing={isFinanceRefreshing}
                    onRefresh={() => void handleRefreshFinance()}
                    initialTripId={recoverTripId}
                    initialTripCode={recoverTripCode}
                    onInitialTripConsumed={clearRecoverTrip}
                    mode={tripFilter === 'driver_credit' ? 'driver_credit_exceptions' : 'all'}
                    simplifiedStatus
                    periodLabel={periodLabel}
                  />
                )}
              </FinancePanelErrorBoundary>
            )}
          </TabsContent>

          <TabsContent value="issues" className="mt-4">
            {frTab === 'issues' && (
              <FinancePanelErrorBoundary panelName="Issues">
                {((isAuditLoading && tripAuditRows.length === 0) || isAuditScopeTransition) ? (
                  <div className="py-8 text-center text-sm text-muted-foreground">
                    Loading issues…
                  </div>
                ) : auditError && tripAuditRows.length === 0 ? (
                  <Alert variant="destructive">
                    <AlertTitle>Issues unavailable</AlertTitle>
                    <AlertDescription>{auditError.message}</AlertDescription>
                  </Alert>
                ) : error && tripAuditRows.length === 0 ? (
                  <Alert variant="destructive">
                    <AlertTitle>Issues unavailable</AlertTitle>
                    <AlertDescription>
                      {error instanceof Error ? error.message : 'Could not load issues for this period.'}
                    </AlertDescription>
                  </Alert>
                ) : (
                  <FinancialReconciliationIssuesTab
                    rows={tripAuditRows}
                    money={money}
                    readOnly={readOnly}
                    ssotBadge={ssotBadge}
                    lastSyncedAt={lastSyncedAt}
                    isRefreshing={isFinanceRefreshing}
                    onRefresh={() => void handleRefreshFinance()}
                    issueFilter={issueFilter}
                    onIssueFilterChange={handleIssueFilterChange}
                    issueTripCodes={issueTripCodes}
                    periodLabel={periodLabel}
                    exportMeta={frAuditExportMeta}
                  />
                )}
              </FinancePanelErrorBoundary>
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
