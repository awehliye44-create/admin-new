import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
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
import { FinancialReconciliationTripsTab } from '@/components/finance/FinancialReconciliationTripsTab';
import { DigitalFinanceEraPanel } from '@/components/finance/DigitalFinanceEraPanel';
import { FinancePanelErrorBoundary } from '@/components/finance/FinancePanelErrorBoundary';
import { useFinanceReconciliationMoney } from '@/hooks/useFinanceReconciliationMoney';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { startAdminPerformanceStep } from '@/lib/recordAdminPerformanceStep';
import {
  CRITICAL_BUTTON_TIMEOUT_MESSAGE,
  useCriticalButtonTimeout,
} from '@/lib/criticalButtonTimeout';
import { paymentSessionsUrl } from '../../shared/adminPaymentSessionsSSOT';
import { classifyFinanceReconciliationError } from '@/lib/financeReconciliationErrors';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';

const FR_TABS = [
  'overview',
  'drivers',
  'trips',
  'alerts',
  'mismatches',
  'shortfall',
  'missing_captures',
  'missing_releases',
  'recovery',
  'history',
] as const;
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
  const refreshFinanceTimeout = useCriticalButtonTimeout({
    action: 'admin_refresh_finance',
    isPending: isFetching,
    onTimeout: () => {
      void refetchFresh();
      toast.error(CRITICAL_BUTTON_TIMEOUT_MESSAGE);
    },
  });
  const isFinanceRefreshing = refreshFinanceTimeout.showSpinner;

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

  const tripAuditRows = data?.trip_financial_audit ?? [];

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

  if (searchParams.get('tab') === 'connect-balance' || searchParams.get('tab') === 'stripe') {
    return <Navigate to="/financial-reconciliation?tab=overview" replace />;
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
      <AdminLayout title="Financial Reconciliation (SSOT)">
        <div className="py-12 text-center text-muted-foreground">
          {!financeScopeReady ? 'Preparing finance scope…' : 'Loading finance reconciliation…'}
        </div>
      </AdminLayout>
    );
  }

  if (ssotStatus === 'UNAVAILABLE') {
    const failure = classifyFinanceReconciliationError(error);
    return (
      <AdminLayout
        title="Financial Reconciliation (SSOT)"
        description="Audit and comparison only — holds, wallet writes, and payouts live on their own pages."
      >
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <FinanceSSOTBadge badge="UNAVAILABLE" />
            <ServiceAreaFinanceFilter value={filter} onChange={setFilter} autoSelectFirstArea={false} />
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

  if (!summary) {
    return (
      <AdminLayout title="Financial Reconciliation (SSOT)">
        <Alert variant="destructive">
          <AlertTitle>Reconciliation unavailable</AlertTitle>
          <AlertDescription>No reconciliation data is available.</AlertDescription>
        </Alert>
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
            <Button variant="outline" size="sm" onClick={() => void handleRefreshFinance()} disabled={isFinanceRefreshing}>
              <RefreshCw className={`h-4 w-4 mr-2 ${isFinanceRefreshing ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        </div>

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

        <Tabs value={frTab} onValueChange={(v) => setFrTab(v as FrTab)}>
          <TabsList className="flex flex-wrap h-auto gap-1">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="drivers">Drivers</TabsTrigger>
            <TabsTrigger value="trips">Trips ({tripAuditRows.length})</TabsTrigger>
            <TabsTrigger value="alerts">Alerts</TabsTrigger>
            <TabsTrigger value="mismatches">Mismatches</TabsTrigger>
            <TabsTrigger value="shortfall">Shortfall</TabsTrigger>
            <TabsTrigger value="missing_captures">Missing Captures</TabsTrigger>
            <TabsTrigger value="missing_releases">Missing Releases</TabsTrigger>
            <TabsTrigger value="recovery">Recovery Queue</TabsTrigger>
            <TabsTrigger value="history">Resolved History</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="mt-4">
            <FinancePanelErrorBoundary panelName="Overview">
              <FinancialReconciliationOverviewTab
                ssot={ssot}
                platformKpis={data?.platform_kpis}
                money={money}
                currencyGroups={data?.currency_groups}
                serviceAreaGateways={data?.service_area_payment_gateways}
                readOnly={readOnly}
                onRefresh={() => void handleRefreshFinance()}
                isRefreshing={isFinanceRefreshing}
              />
            </FinancePanelErrorBoundary>
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
                />
              </FinancePanelErrorBoundary>
            )}
          </TabsContent>

          <TabsContent value="alerts" className="mt-4">
            {frTab === 'alerts' && (
              <FinancePanelErrorBoundary panelName="Alerts">
                <FinancialReconciliationAlertsTab
                  ssot={ssot}
                  backendAudit={backendAudit}
                  money={money}
                  readOnly={readOnly}
                />
              </FinancePanelErrorBoundary>
            )}
          </TabsContent>

          <TabsContent value="mismatches" className="mt-4">
            {frTab === 'mismatches' && (
              <FinancePanelErrorBoundary panelName="Mismatches">
                <div className="space-y-4">
                  <Alert>
                    <AlertTitle>Trip mismatches</AlertTitle>
                    <AlertDescription>
                      Capture / reconciliation mismatches for this period. Money-movement alerts remain on the Alerts tab.
                      Hold actions run on Payment Sessions. Financial Reconciliation never edits money.
                    </AlertDescription>
                  </Alert>
                  <FinancialReconciliationTripsTab
                    rows={tripAuditRows}
                    money={money}
                    readOnly={readOnly}
                    ssotBadge={ssotBadge}
                    lastSyncedAt={lastSyncedAt}
                    isRefreshing={isFinanceRefreshing}
                    onRefresh={() => void handleRefreshFinance()}
                    mode="mismatches"
                  />
                </div>
              </FinancePanelErrorBoundary>
            )}
          </TabsContent>

          <TabsContent value="shortfall" className="mt-4">
            {frTab === 'shortfall' && (
              <FinancePanelErrorBoundary panelName="Shortfall">
                <div className="space-y-4">
                  <Alert>
                    <AlertTitle>Shortfall (read-only)</AlertTitle>
                    <AlertDescription>
                      Trips with outstanding customer payable. Recovery actions live on Payment Sessions.
                    </AlertDescription>
                  </Alert>
                  <FinancialReconciliationTripsTab
                    rows={tripAuditRows}
                    money={money}
                    readOnly={readOnly}
                    ssotBadge={ssotBadge}
                    lastSyncedAt={lastSyncedAt}
                    isRefreshing={isFinanceRefreshing}
                    onRefresh={() => void handleRefreshFinance()}
                    mode="shortfall"
                  />
                </div>
              </FinancePanelErrorBoundary>
            )}
          </TabsContent>

          <TabsContent value="missing_captures" className="mt-4">
            {frTab === 'missing_captures' && (
              <FinancePanelErrorBoundary panelName="Missing Captures">
                <div className="space-y-4">
                  <Alert>
                    <AlertTitle>Missing captures (read-only)</AlertTitle>
                    <AlertDescription>
                      Authorised or payable trips without confirmed capture evidence. Capture lifecycle is owned by Payment Sessions.
                    </AlertDescription>
                  </Alert>
                  <FinancialReconciliationTripsTab
                    rows={tripAuditRows}
                    money={money}
                    readOnly={readOnly}
                    ssotBadge={ssotBadge}
                    lastSyncedAt={lastSyncedAt}
                    isRefreshing={isFinanceRefreshing}
                    onRefresh={() => void handleRefreshFinance()}
                    mode="missing_captures"
                  />
                </div>
              </FinancePanelErrorBoundary>
            )}
          </TabsContent>

          <TabsContent value="missing_releases" className="mt-4">
            {frTab === 'missing_releases' && (
              <FinancePanelErrorBoundary panelName="Missing Releases">
                <div className="space-y-4">
                  <Alert>
                    <AlertTitle>Missing releases (read-only)</AlertTitle>
                    <AlertDescription>
                      Authorised holds without release or capture. Release / retry lives on Payment Sessions.
                    </AlertDescription>
                  </Alert>
                  <FinancialReconciliationTripsTab
                    rows={tripAuditRows}
                    money={money}
                    readOnly={readOnly}
                    ssotBadge={ssotBadge}
                    lastSyncedAt={lastSyncedAt}
                    isRefreshing={isFinanceRefreshing}
                    onRefresh={() => void handleRefreshFinance()}
                    mode="missing_releases"
                  />
                </div>
              </FinancePanelErrorBoundary>
            )}
          </TabsContent>

          <TabsContent value="recovery" className="mt-4">
            {frTab === 'recovery' && (
              <FinancePanelErrorBoundary panelName="Recovery Queue">
                <div className="space-y-4">
                  <Alert>
                    <AlertTitle>Recovery queue (read-only)</AlertTitle>
                    <AlertDescription>
                      Outstanding / recovery-flagged trip audits. Execute recovery on Payment Sessions — this page never edits money.
                    </AlertDescription>
                  </Alert>
                  <FinancialReconciliationTripsTab
                    rows={tripAuditRows}
                    money={money}
                    readOnly={readOnly}
                    ssotBadge={ssotBadge}
                    lastSyncedAt={lastSyncedAt}
                    isRefreshing={isFinanceRefreshing}
                    onRefresh={() => void handleRefreshFinance()}
                    mode="recovery"
                  />
                </div>
              </FinancePanelErrorBoundary>
            )}
          </TabsContent>

          <TabsContent value="history" className="mt-4">
            {frTab === 'history' && (
              <FinancePanelErrorBoundary panelName="Resolved History">
                <div className="space-y-4">
                  <Alert>
                    <AlertTitle>Resolved History</AlertTitle>
                    <AlertDescription className="space-y-2">
                      <p>
                        Balanced trip reconciliations for this period. Hold release history lives on{' '}
                        <Link
                          to={paymentSessionsUrl({ tab: 'history' })}
                          className="underline font-medium"
                        >
                          Payment Sessions History
                        </Link>
                        .
                      </p>
                    </AlertDescription>
                  </Alert>
                  <FinancialReconciliationTripsTab
                    rows={tripAuditRows}
                    money={money}
                    readOnly={readOnly}
                    ssotBadge={ssotBadge}
                    lastSyncedAt={lastSyncedAt}
                    isRefreshing={isFinanceRefreshing}
                    onRefresh={() => void handleRefreshFinance()}
                    mode="resolved"
                  />
                </div>
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
