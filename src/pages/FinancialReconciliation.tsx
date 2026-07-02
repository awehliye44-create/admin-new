import React, { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { ServiceAreaFinanceFilter, type ServiceAreaFinanceSelection } from '@/components/finance/ServiceAreaFinanceFilter';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatPence } from '@/hooks/useDriverWallet';
import { useFinancialReconciliationSSOT } from '@/hooks/useFinancialReconciliationSSOT';
import { FinanceSSOTBadge } from '@/components/finance/FinanceSSOTBadge';
import { useFinanceBackendAudit } from '@/hooks/useFinanceBackendAudit';
import { getTripDisplayId } from '@/lib/tripUtils';
import {
  normalizeTripAuditStatusBadge,
  tripAuditStatusBadgeClassName,
  type TripAuditStatusBadge,
} from '@/lib/tripAuditStatusBadge';
import type { TripFinancialAuditRow } from '@/hooks/useFinanceReconciliation';
import { supabase } from '@/integrations/supabase/client';
import {
  safeReconciliationStatus,
} from '@/lib/financialReconciliationGuards';
import { cn } from '@/lib/utils';
import {
  AlertTriangle,
  Calculator,
  RefreshCw,
  Search,
} from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DriverWalletSsotPanel } from '@/components/finance/DriverWalletSsotPanel';
import { DriverWalletLedgerLink } from '@/components/finance/DriverWalletLedgerLink';
import { FinancialReconciliationOverviewTab } from '@/components/finance/FinancialReconciliationOverviewTab';
import { FinancialReconciliationAlertsTab } from '@/components/finance/FinancialReconciliationAlertsTab';
import { FinancialReconciliationStripeTab } from '@/components/finance/FinancialReconciliationStripeTab';
import { FinanceRecoveryPanel } from '@/components/payment/FinanceRecoveryPanel';
import { FinanceRecoveryMismatchSummary } from '@/components/payment/FinanceRecoveryMismatchSummary';
import type { FinanceRecoveryAction } from '@/components/payment/PaymentControlsCard';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Navigate } from 'react-router-dom';

const FR_TABS = ['overview', 'trips', 'drivers', 'stripe', 'alerts'] as const;
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

function TripAuditStatusChip({ badge }: { badge: TripAuditStatusBadge }) {
  const safe = normalizeTripAuditStatusBadge(badge);
  return (
    <Badge
      variant="outline"
      className={`text-xs font-medium ${tripAuditStatusBadgeClassName(safe.tone)}`}
    >
      {safe.label}
    </Badge>
  );
}

/** Normalize audit rows — supports new badge objects and legacy string status fields. */
function auditPence(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeAuditRow(row: TripFinancialAuditRow & Record<string, unknown>): TripFinancialAuditRow {
  const legacy = row as TripFinancialAuditRow & {
    driver_payout_status?: string;
    onecab_commission_status?: string;
    provider_status?: string;
  };
  const customerPaid = auditPence(row.customer_paid_pence);
  const captured = auditPence(row.captured_pence);
  return {
    ...row,
    trip_id: String(row.trip_id ?? legacy.trip_id ?? ''),
    driver_id: row.driver_id ?? (legacy as { driver_id?: string }).driver_id ?? null,
    customer_name: row.customer_name ?? (legacy as { passenger_name?: string }).passenger_name ?? null,
    stripe_payment_intent_id: row.stripe_payment_intent_id ?? (legacy as { stripe_payment_intent_id?: string }).stripe_payment_intent_id ?? null,
    customer_paid_pence: customerPaid,
    gross_fare_pence: auditPence(row.gross_fare_pence) ?? customerPaid,
    discount_pence: auditPence(row.discount_pence),
    final_fare_pence: auditPence(row.final_fare_pence ?? row.settlement_total_pence ?? row.customer_paid_pence),
    settlement_total_pence: auditPence(row.settlement_total_pence ?? row.customer_paid_pence),
    captured_pence: captured,
    refunded_pence: auditPence(row.refunded_pence),
    net_customer_payment_pence: auditPence(row.net_customer_payment_pence),
    outstanding_pence: auditPence(row.outstanding_pence),
    capture_mismatch: row.capture_mismatch ?? hasCaptureMismatch({
      ...row,
      customer_paid_pence: customerPaid ?? 0,
      captured_pence: captured ?? 0,
      payment_method: row.payment_method ?? null,
    } as TripFinancialAuditRow),
    driver_net_pence: row.driver_net_pence == null ? null : auditPence(row.driver_net_pence),
    debt_recovered_pence: auditPence(row.debt_recovered_pence),
    available_payout_created_pence: row.available_payout_created_pence == null
      ? null
      : auditPence(row.available_payout_created_pence),
    onecab_gross_commission_pence: auditPence(row.onecab_gross_commission_pence),
    processing_fee_pence: auditPence(row.processing_fee_pence),
    onecab_net_pence: auditPence(row.onecab_net_pence),
    driver_payout: normalizeTripAuditStatusBadge(row.driver_payout, legacy.driver_payout_status),
    onecab_commission: normalizeTripAuditStatusBadge(row.onecab_commission, legacy.onecab_commission_status),
    provider: normalizeTripAuditStatusBadge(row.provider, legacy.provider_status),
  };
}

function fmtAuditPence(p: number | null | undefined, ccy: string): string {
  return p == null ? '—' : formatPence(p, ccy);
}

function safeTripDisplayId(row: TripFinancialAuditRow): string {
  const id = row.trip_id || 'unknown';
  try {
    return getTripDisplayId({ trip_code: row.trip_code, id });
  } catch {
    return row.trip_code ?? id.slice(0, 8).toUpperCase();
  }
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

function hasCaptureMismatch(row: TripFinancialAuditRow): boolean {
  if (row.capture_mismatch === false) return false;
  if (row.capture_mismatch === true) return true;
  const method = (row.payment_method ?? '').toLowerCase();
  if (method === 'cash') return false;
  const settlement = row.settlement_total_pence ?? row.customer_paid_pence;
  const captured = row.captured_pence;
  if (settlement == null || captured == null) return false;
  const outstanding = row.outstanding_pence ?? 0;
  if (outstanding <= 1) return false;
  return settlement > captured + 1;
}

function auditOutstandingPence(row: TripFinancialAuditRow): number {
  const o = row.outstanding_pence;
  return o == null ? 0 : Math.max(0, o);
}

function rowSettlementPence(row: TripFinancialAuditRow): number | null {
  return row.settlement_total_pence ?? row.customer_paid_pence ?? null;
}

function rowCaptureMismatch(row: TripFinancialAuditRow): boolean {
  return row.capture_mismatch ?? hasCaptureMismatch(row);
}

function openFinanceRecovery(
  setRecoveryTripId: (id: string) => void,
  setRecoveryTripCode: (code: string | null) => void,
  setRecoveryInitialAction: (action: FinanceRecoveryAction | null) => void,
  tripId: string,
  tripCode: string | null,
  action?: FinanceRecoveryAction,
) {
  setRecoveryTripId(tripId);
  setRecoveryTripCode(tripCode);
  setRecoveryInitialAction(action ?? null);
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
  const [tripSearchInput, setTripSearchInput] = useState('');
  const [tripSearchMode, setTripSearchMode] = useState<'code' | 'id'>('code');
  const [debouncedTripSearch, setDebouncedTripSearch] = useState('');
  const [recoveryTripId, setRecoveryTripId] = useState<string | null>(null);
  const [recoveryTripCode, setRecoveryTripCode] = useState<string | null>(null);
  const [recoveryInitialAction, setRecoveryInitialAction] = useState<FinanceRecoveryAction | null>(null);

  useEffect(() => {
    const tripCode = searchParams.get('trip')?.trim();
    const tripId = searchParams.get('tripId')?.trim();
    const recover = searchParams.get('recover') === '1';
    if (!recover) return;
    if (tripCode) {
      setTripSearchMode('code');
      setTripSearchInput(tripCode);
      setDebouncedTripSearch(tripCode);
    } else if (tripId) {
      setTripSearchMode('id');
      setTripSearchInput(tripId);
      setDebouncedTripSearch(tripId);
    }
  }, [searchParams]);

  useEffect(() => {
    if (searchParams.get('tab') !== 'trips') return;
    if (searchParams.get('recover') === '1') return;
    const tripCode = searchParams.get('trip')?.trim();
    const tripId = searchParams.get('tripId')?.trim();
    if (tripCode) {
      setTripSearchMode('code');
      setTripSearchInput(tripCode);
      setDebouncedTripSearch(tripCode);
    } else if (tripId) {
      setTripSearchMode('id');
      setTripSearchInput(tripId);
      setDebouncedTripSearch(tripId);
    }
  }, [searchParams]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedTripSearch(tripSearchInput.trim()), 350);
    return () => clearTimeout(timer);
  }, [tripSearchInput]);

  const ssot = useFinancialReconciliationSSOT({
    filter,
    from: from || undefined,
    to: to || undefined,
    tripSearch: debouncedTripSearch || undefined,
    tripSearchType: tripSearchMode,
  });
  const { isLoading, error, refetch, isFetching, readOnly, status: ssotStatus, snapshotSavedAt } = ssot;
  const data = ssot.response;

  const {
    data: backendAuditData,
    isLoading: backendAuditLoading,
    error: backendAuditError,
  } = useFinanceBackendAudit({
    filter,
    from: from || undefined,
    to: to || undefined,
  });

  const summary = ssot.summary;
  const ccy = ssot.currencyCode || filter.currencyCode || 'GBP';
  const auditRows = useMemo(() => {
    const raw = data?.trip_financial_audit;
    if (!Array.isArray(raw)) return [];
    return raw.map((row) => {
      try {
        return normalizeAuditRow(row as TripFinancialAuditRow & Record<string, unknown>);
      } catch (e) {
        console.warn('[FinancialReconciliation] Skipping malformed audit row', e, row);
        return normalizeAuditRow({
          trip_id: String((row as { trip_id?: string })?.trip_id ?? ''),
          trip_code: null,
          date: null,
          driver_name: null,
          payment_method: null,
          customer_paid_pence: null,
          captured_pence: null,
          refunded_pence: null,
          net_customer_payment_pence: null,
          driver_net_pence: null,
          onecab_gross_commission_pence: null,
          processing_fee_pence: null,
          onecab_net_pence: null,
          driver_payout_status: 'Unknown',
          onecab_commission_status: 'Unknown',
          provider_status: 'Unknown',
        } as TripFinancialAuditRow & Record<string, unknown>);
      }
    });
  }, [data?.trip_financial_audit]);
  const backendAudit = backendAuditData?.finance_backend_audit_v1;

  useEffect(() => {
    if (readOnly) return;
    if (searchParams.get('recover') !== '1') return;
    const tripCode = searchParams.get('trip')?.trim();
    const tripIdParam = searchParams.get('tripId')?.trim();

    if (tripIdParam) {
      setRecoveryTripId(tripIdParam);
      setRecoveryTripCode(tripCode ?? null);
      return;
    }

    const match = auditRows.find((row) => {
      if (tripCode && row.trip_code?.toUpperCase() === tripCode.toUpperCase()) return true;
      if (tripCode && safeTripDisplayId(row).toUpperCase() === tripCode.toUpperCase()) return true;
      return false;
    });
    if (match) {
      setRecoveryTripId(match.trip_id);
      setRecoveryTripCode(match.trip_code ?? safeTripDisplayId(match));
      return;
    }

    if (!tripCode) return;

    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('trips')
        .select('id, trip_code, trip_number')
        .or(`trip_code.eq.${tripCode},trip_number.eq.${tripCode}`)
        .maybeSingle();
      if (cancelled || error || !data) return;
      setRecoveryTripId(data.id);
      setRecoveryTripCode(data.trip_code ?? data.trip_number ?? tripCode);
    })();

    return () => {
      cancelled = true;
    };
  }, [searchParams, auditRows, readOnly]);

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
              <Calculator className="h-6 w-6 text-primary" />
              <h1 className="text-2xl font-bold">Financial Reconciliation (SSOT)</h1>
            </div>
            <p className="text-sm text-muted-foreground mt-1 max-w-3xl">
              Entire platform financial health — trips, drivers, Stripe, and alerts from one SSOT backend.
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

        <Tabs value={frTab} onValueChange={(v) => setFrTab(v as FrTab)}>
          <TabsList className="flex flex-wrap h-auto gap-1">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="trips">Trips</TabsTrigger>
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

          <TabsContent value="trips" className="mt-4">
            <Card>
              <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <CardTitle className="text-base">Trips</CardTitle>
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    value={tripSearchMode}
                    onValueChange={(v) => {
                      setTripSearchMode(v as 'code' | 'id');
                      setTripSearchInput('');
                      setDebouncedTripSearch('');
                    }}
                  >
                    <SelectTrigger className="w-[110px]"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="code">Trip code</SelectItem>
                      <SelectItem value="id">Trip ID</SelectItem>
                    </SelectContent>
                  </Select>
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      placeholder={tripSearchMode === 'id' ? 'Trip ID (UUID)' : 'Trip code'}
                      className={cn('pl-9 pr-9', tripSearchMode === 'id' ? 'w-[280px]' : 'w-[240px]')}
                      value={tripSearchInput}
                      onChange={(e) => setTripSearchInput(e.target.value)}
                    />
                    {isFetching && debouncedTripSearch !== tripSearchInput.trim() && (
                      <RefreshCw className="absolute right-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 animate-spin text-muted-foreground" />
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent className={cn('overflow-x-auto', isFetching && debouncedTripSearch && 'opacity-80')}>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Trip</TableHead>
                      <TableHead>Customer</TableHead>
                      <TableHead>Driver</TableHead>
                      <TableHead>Payment Method</TableHead>
                      <TableHead className="text-right">Gross Fare</TableHead>
                      <TableHead className="text-right">Discount</TableHead>
                      <TableHead className="text-right">Final Fare</TableHead>
                      <TableHead className="text-right">Commission</TableHead>
                      <TableHead className="text-right">Driver Net</TableHead>
                      <TableHead className="text-right">Captured</TableHead>
                      <TableHead className="text-right">Settlement</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Mismatch</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {auditRows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={13} className="text-center text-muted-foreground py-8">
                          {debouncedTripSearch ? `No audit rows matching "${debouncedTripSearch}"` : 'No trips in selected period'}
                        </TableCell>
                      </TableRow>
                    ) : (
                      auditRows.map((row) => {
                        const settlement = rowSettlementPence(row);
                        const gross = row.gross_fare_pence ?? row.customer_paid_pence;
                        const discount = row.discount_pence ?? 0;
                        const finalFare = row.final_fare_pence ?? settlement;
                        return (
                          <TableRow key={row.trip_id}>
                            <TableCell className="font-mono text-xs">{safeTripDisplayId(row)}</TableCell>
                            <TableCell className="text-xs">{row.customer_name ?? '—'}</TableCell>
                            <TableCell className="text-sm">
                              <DriverWalletLedgerLink driverId={row.driver_id} tab="overview">
                                {row.driver_name ?? '—'}
                              </DriverWalletLedgerLink>
                            </TableCell>
                            <TableCell>
                              <Badge variant="outline" className="text-xs uppercase">{row.payment_method ?? '—'}</Badge>
                            </TableCell>
                            <TableCell className="text-right">{fmtAuditPence(gross, ccy)}</TableCell>
                            <TableCell className="text-right">{discount != null && discount > 0 ? formatPence(discount, ccy) : '—'}</TableCell>
                            <TableCell className="text-right">{fmtAuditPence(finalFare, ccy)}</TableCell>
                            <TableCell className="text-right">{fmtAuditPence(row.onecab_gross_commission_pence, ccy)}</TableCell>
                            <TableCell className="text-right">{fmtAuditPence(row.driver_net_pence, ccy)}</TableCell>
                            <TableCell className="text-right">{fmtAuditPence(row.captured_pence, ccy)}</TableCell>
                            <TableCell className="text-right">{fmtAuditPence(settlement, ccy)}</TableCell>
                            <TableCell><TripAuditStatusChip badge={row.driver_payout} /></TableCell>
                            <TableCell>
                              {rowCaptureMismatch(row) ? (
                                <div className="space-y-1">
                                  <Badge variant="outline" className="text-[10px] border-amber-500/50 text-amber-800 bg-amber-500/10">
                                    Capture mismatch
                                  </Badge>
                                  {auditOutstandingPence(row) > 0 && (
                                    <FinanceRecoveryMismatchSummary
                                      compact
                                      captureMismatch
                                      capturedPence={row.captured_pence ?? 0}
                                      settlementTotalPence={settlement ?? 0}
                                      outstandingPence={auditOutstandingPence(row)}
                                      currency={ccy}
                                      showActions={!readOnly}
                                      onAction={(action) => {
                                        if (readOnly) return;
                                        openFinanceRecovery(
                                          setRecoveryTripId,
                                          setRecoveryTripCode,
                                          setRecoveryInitialAction,
                                          row.trip_id,
                                          row.trip_code ?? safeTripDisplayId(row),
                                          action,
                                        );
                                      }}
                                    />
                                  )}
                                </div>
                              ) : (
                                <span className="text-xs text-muted-foreground">—</span>
                              )}
                            </TableCell>
                          </TableRow>
                        );
                      })
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="drivers" className="mt-4">
            <DriverWalletSsotPanel regionId={filter.regionId} currencyCode={ccy} />
          </TabsContent>

          <TabsContent value="stripe" className="mt-4">
            <FinancialReconciliationStripeTab
              summary={ssot.summary}
              currencyCode={ccy}
              serviceFilter={filter}
              periodFrom={from || undefined}
              periodTo={to || undefined}
              periodLabel={from && to ? `${from} → ${to}` : undefined}
              auditRows={auditRows}
              paymentIntents={data?.stripe_payment_intents ?? []}
              stripeBalanceError={data?.meta?.stripe_balance_error ?? null}
              readOnly={readOnly}
            />
          </TabsContent>

          <TabsContent value="alerts" className="mt-4">
            <FinancialReconciliationAlertsTab
              ssot={ssot}
              backendAudit={backendAudit}
              regionId={filter.regionId ?? null}
              currencyCode={ccy}
              readOnly={readOnly}
            />
          </TabsContent>
        </Tabs>

        <Dialog
          open={!!recoveryTripId}
          onOpenChange={(open) => {
            if (!open) {
              setRecoveryTripId(null);
              setRecoveryTripCode(null);
              setRecoveryInitialAction(null);
              if (searchParams.get('recover')) {
                const next = new URLSearchParams(searchParams);
                next.delete('recover');
                next.delete('trip');
                next.delete('tripId');
                setSearchParams(next, { replace: true });
              }
            }
          }}
        >
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>
                Finance recovery — {recoveryTripCode ?? recoveryTripId?.slice(0, 8)}
              </DialogTitle>
            </DialogHeader>
            {recoveryTripId && (
              <FinanceRecoveryPanel
                tripId={recoveryTripId}
                tripCode={recoveryTripCode}
                source="financial-reconciliation"
                variant="finance"
                initialAction={recoveryInitialAction}
                onInitialActionConsumed={() => setRecoveryInitialAction(null)}
                readOnly={readOnly}
              />
            )}
          </DialogContent>
        </Dialog>
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
