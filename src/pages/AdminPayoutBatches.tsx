import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { FinanceSSOT, useFinancialReconciliationSSOT } from '@/hooks/useFinancialReconciliationSSOT';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { supabase } from '@/integrations/supabase/client';
import { useQuery } from '@tanstack/react-query';
import { formatPence, useDriverFinancialSummaries } from '@/hooks/useDriverWallet';
import { useRegionsMap } from '@/hooks/useRegions';
import { ServiceAreaFinanceFilter, DEFAULT_SERVICE_AREA_SELECTION, type ServiceAreaFinanceSelection } from '@/components/finance/ServiceAreaFinanceFilter';
import { FinancePeriodFilter } from '@/components/finance/FinancePeriodFilter';
import { getSingleCurrency } from '@/components/finance/CurrencyGroupedStats';
import { format } from 'date-fns';
import { 
  RefreshCw, CheckCircle2, Clock, XCircle, Eye, Calendar,
  DollarSign, Wallet, AlertTriangle, BookOpen, Landmark
} from 'lucide-react';
import { FinancePayoutAuditSection } from '@/components/finance/FinancePayoutAuditSection';
import { FinanceLedgerPanel } from '@/components/finance/FinanceLedgerPanel';
import { ConnectBalancePanel } from '@/components/finance/ConnectBalancePanel';
import { formatPayoutDisplayStatus } from '@/lib/payoutStatusLabels';
import { retryMondayPayoutItem, canRetryMondayPayoutItem, useMondayPayoutDiagnostics } from '@/hooks/useMondayPayoutDiagnostics';
import {
  isTimestampInPeriod,
  payoutActivityTimestamp,
  resolveFinancePeriodBounds,
  type FinancePeriod,
} from '@/lib/financePeriodFilter';
import { WeeklyMondaySettlementPanel } from '@/components/finance/WeeklyMondaySettlementPanel';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';

interface PayoutItem {
  id: string;
  driverId: string;
  driverName: string | null;
  amount: number;
  status: string;
  errorMessage: string | null;
  stripeTransferId: string | null;
  stripePayoutId: string | null;
  ledgerEntryId: string | null;
  walletRecalculatedAt: string | null;
  ledgerSyncError: string | null;
  createdAt: string;
  completedAt: string | null;
}

function payoutSentToBank(item: PayoutItem): boolean {
  return !!(item.stripeTransferId || item.stripePayoutId);
}

function ledgerDebitCreated(item: PayoutItem): boolean {
  return !!item.ledgerEntryId;
}

function walletRecalculated(item: PayoutItem): boolean {
  return !!item.walletRecalculatedAt;
}

function payoutReconciliationStatus(item: PayoutItem): {
  label: string;
  critical: boolean;
  detail: string;
} {
  const sent = payoutSentToBank(item);
  const ledger = ledgerDebitCreated(item);
  const recalc = walletRecalculated(item);

  if (sent && !ledger) {
    return {
      label: 'CRITICAL',
      critical: true,
      detail: 'Provider payout completed but driver ledger was not debited.',
    };
  }
  if (item.status === 'ledger_sync_failed') {
    return {
      label: 'Ledger sync failed',
      critical: true,
      detail: item.ledgerSyncError ?? item.errorMessage ?? 'Retry ledger sync required.',
    };
  }
  if (item.status === 'completed' && ledger && recalc) {
    return { label: 'Balanced', critical: false, detail: 'Payout sent, ledger debited, wallet recalculated.' };
  }
  if (item.status === 'failed' && !sent) {
    return { label: 'Failed (no debit)', critical: false, detail: 'Provider payout failed — wallet unchanged.' };
  }
  return { label: item.status, critical: false, detail: '—' };
}

interface PayoutBatch {
  id: string;
  kind: string;
  runDate: string;
  status: string;
  totalDrivers: number | null;
  totalAmount: number | null;
  successfulPayouts: number | null;
  failedPayouts: number | null;
  createdAt: string;
  completedAt: string | null;
  notes: string | null;
  items: PayoutItem[];
}

interface PayoutSummary {
  totalBatches: number;
  totalPaidOut: number;
  pendingBatches: number;
  failedBatches: number;
  availableForPayout: number;
  driversReadyForPayout: number;
  currencyCode: string;
  regionId: string | null;
}

interface PayoutResponse {
  batches: PayoutBatch[];
  summary: PayoutSummary;
}

interface EarlyCashoutRow {
  id: string;
  driverId: string;
  driverName: string | null;
  requestedAmount: number;
  driverReceives: number;
  feeAmount: number;
  status: string;
  payoutMethod: 'instant' | 'standard' | null;
  stripePayoutId: string | null;
  stripeTransferId: string | null;
  failureReason: string | null;
  createdAt: string;
  paidAt: string | null;
  currency: string;
}

function getPayoutMethodLabel(method: EarlyCashoutRow['payoutMethod']): string {
  if (method === 'instant') return 'Instant';
  if (method === 'standard') return 'Standard';
  return '—';
}

function buildPayoutBatchesPath(filter: ServiceAreaFinanceSelection): string {
  const params = new URLSearchParams();
  if (filter.regionId) params.set('region_id', filter.regionId);
  else if (filter.serviceAreaId) params.set('service_area_id', filter.serviceAreaId);
  const qs = params.toString();
  return qs ? `admin-payout-batches?${qs}` : 'admin-payout-batches';
}

async function fetchPayoutBatchesDirect(): Promise<PayoutBatch[]> {
  const { data: batchRows, error: batchError } = await supabase
    .from('payout_batches')
    .select('id,kind,run_date,status,total_drivers,total_amount_pence,successful_payouts,failed_payouts,notes,created_at,completed_at')
    .order('created_at', { ascending: false });

  if (batchError) throw batchError;

  const batchIds = (batchRows || []).map(b => b.id);
  const { data: itemRows, error: itemError } = batchIds.length > 0
    ? await supabase
        .from('payout_items')
        .select('id,batch_id,driver_id,amount_pence,status,stripe_transfer_id,stripe_payout_id,ledger_entry_id,wallet_recalculated_at,ledger_sync_error,error_message,created_at,completed_at,drivers:driver_id(first_name,last_name)')
        .in('batch_id', batchIds)
    : { data: [], error: null };

  if (itemError) throw itemError;

  const itemsByBatch: Record<string, PayoutItem[]> = {};
  itemRows?.forEach((item: {
    id: string;
    batch_id: string;
    driver_id: string;
    amount_pence: number;
    status: string;
    stripe_transfer_id: string | null;
    stripe_payout_id: string | null;
    ledger_entry_id: string | null;
    wallet_recalculated_at: string | null;
    ledger_sync_error: string | null;
    error_message: string | null;
    created_at: string;
    completed_at: string | null;
    drivers: { first_name: string; last_name: string } | null;
  }) => {
    if (!itemsByBatch[item.batch_id]) itemsByBatch[item.batch_id] = [];
    itemsByBatch[item.batch_id].push({
      id: item.id,
      driverId: item.driver_id,
      driverName: item.drivers ? `${item.drivers.first_name} ${item.drivers.last_name}` : null,
      amount: item.amount_pence,
      status: item.status,
      stripeTransferId: item.stripe_transfer_id,
      stripePayoutId: item.stripe_payout_id,
      ledgerEntryId: item.ledger_entry_id,
      walletRecalculatedAt: item.wallet_recalculated_at,
      ledgerSyncError: item.ledger_sync_error,
      errorMessage: item.error_message,
      createdAt: item.created_at,
      completedAt: item.completed_at,
    });
  });

  return (batchRows || []).map(batch => ({
    id: batch.id,
    kind: batch.kind,
    runDate: batch.run_date,
    status: batch.status,
    totalDrivers: batch.total_drivers,
    totalAmount: batch.total_amount_pence,
    successfulPayouts: batch.successful_payouts,
    failedPayouts: batch.failed_payouts,
    notes: batch.notes,
    createdAt: batch.created_at,
    completedAt: batch.completed_at,
    items: itemsByBatch[batch.id] || [],
  }));
}

async function fetchPayoutBatchesFromEdge(filter: ServiceAreaFinanceSelection): Promise<PayoutBatch[]> {
  const headers: Record<string, string> = {};
  if (filter.regionId) headers['x-region-id'] = filter.regionId;
  else if (filter.serviceAreaId) headers['x-service-area-id'] = filter.serviceAreaId;

  const path = buildPayoutBatchesPath(filter);
  const { data, error: fnError } = await supabase.functions.invoke(path, { method: 'GET', headers });
  if (fnError) throw fnError;
  return (data as PayoutResponse)?.batches ?? [];
}

async function fetchPayoutBatchesWithFallback(filter: ServiceAreaFinanceSelection): Promise<PayoutBatch[]> {
  try {
    return await fetchPayoutBatchesDirect();
  } catch (directError) {
    try {
      return await fetchPayoutBatchesFromEdge(filter);
    } catch {
      throw directError;
    }
  }
}

async function fetchEarlyCashoutsDirect(): Promise<EarlyCashoutRow[]> {
  const { data, error } = await supabase
    .from('driver_early_cashouts')
    .select(`
      id,
      driver_id,
      requested_cashout_pence,
      driver_receives_pence,
      early_cashout_fee_pence,
      status,
      stripe_payout_id,
      stripe_transfer_id,
      payout_method,
      failure_reason,
      created_at,
      paid_at,
      currency,
      drivers:driver_id(first_name, last_name)
    `)
    .order('created_at', { ascending: false });

  if (error) throw error;

  return (data || []).map((row: {
    id: string;
    driver_id: string;
    requested_cashout_pence: number;
    driver_receives_pence: number;
    early_cashout_fee_pence: number;
    status: string;
    stripe_payout_id: string | null;
    stripe_transfer_id: string | null;
    payout_method: 'instant' | 'standard' | null;
    failure_reason: string | null;
    created_at: string;
    paid_at: string | null;
    currency: string;
    drivers: { first_name: string; last_name: string } | null;
  }) => ({
    id: row.id,
    driverId: row.driver_id,
    driverName: row.drivers ? `${row.drivers.first_name} ${row.drivers.last_name}` : null,
    requestedAmount: row.requested_cashout_pence,
    driverReceives: row.driver_receives_pence,
    feeAmount: row.early_cashout_fee_pence,
    status: row.status,
    payoutMethod: row.payout_method ?? null,
    stripePayoutId: row.stripe_payout_id,
    stripeTransferId: row.stripe_transfer_id,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    paidAt: row.paid_at,
    currency: row.currency,
  }));
}

export default function AdminPayoutBatches() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = (() => {
    const tab = searchParams.get('tab');
    if (tab === 'early-cashouts' || tab === 'ledger' || tab === 'connect-balance') return tab;
    return 'batches';
  })();

  const setActiveTab = (tab: string) => {
    const next = new URLSearchParams(searchParams);
    if (tab === 'batches') next.delete('tab');
    else next.set('tab', tab);
    setSearchParams(next, { replace: true });
  };

  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [serviceFilter, setServiceFilter] = useState<ServiceAreaFinanceSelection>(DEFAULT_SERVICE_AREA_SELECTION);
  const [period, setPeriod] = useState<FinancePeriod>('week');
  const [customDateFrom, setCustomDateFrom] = useState<Date | undefined>(undefined);
  const [customDateTo, setCustomDateTo] = useState<Date | undefined>(undefined);

  const periodBounds = useMemo(
    () => resolveFinancePeriodBounds(period, customDateFrom, customDateTo),
    [period, customDateFrom, customDateTo],
  );

  const [retryingPayoutId, setRetryingPayoutId] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const regionScope = serviceFilter.regionId ?? null;
  const financeSSOT = useFinancialReconciliationSSOT({
    filter: serviceFilter,
    from: periodBounds.from,
    to: periodBounds.to,
  });
  const mondayPayouts = useMondayPayoutDiagnostics(serviceFilter, {
    allKinds: true,
    today: false,
    from: periodBounds.from,
    to: periodBounds.to,
  });
  const hasRegionScope = !!regionScope;

  const { data: allDrivers = [], isLoading: isLoadingDrivers, isError: isDriversError, error: driversError, refetch: refetchDrivers } =
    useDriverFinancialSummaries();
  const { map: regionsMap } = useRegionsMap();

  const driverRegionById = useMemo(() => {
    const map = new Map<string, string | null>();
    allDrivers.forEach(d => map.set(d.driver_id, d.region_id));
    return map;
  }, [allDrivers]);
  const drivers = useMemo(() => {
    if (!regionScope) return [];
    return allDrivers.filter(d => d.region_id === regionScope);
  }, [allDrivers, regionScope]);

  const {
    data: batches = [],
    isLoading: isLoadingBatches,
    refetch: refetchBatches,
    isError: isBatchesError,
    error: batchesError,
  } = useQuery<PayoutBatch[]>({
    queryKey: ['admin-payout-batches-list', regionScope, serviceFilter.serviceAreaId],
    queryFn: () => fetchPayoutBatchesWithFallback(serviceFilter),
  });

  const {
    data: earlyCashouts = [],
    isLoading: isLoadingEarlyCashouts,
    isError: isEarlyCashoutsError,
    error: earlyCashoutsError,
    refetch: refetchEarlyCashouts,
  } = useQuery<EarlyCashoutRow[]>({
    queryKey: ['admin-early-cashouts-list'],
    queryFn: fetchEarlyCashoutsDirect,
  });

  const filteredDriverIds = useMemo(
    () => new Set(drivers.map(d => d.driver_id)),
    [drivers],
  );

  const filteredBatches = useMemo(() => {
    const inPeriod = batches.filter((batch) =>
      isTimestampInPeriod(
        payoutActivityTimestamp({
          completedAt: batch.completedAt,
          createdAt: batch.createdAt,
          runDate: batch.runDate,
        }),
        periodBounds.from,
        periodBounds.to,
      ),
    );
    if (!regionScope) return inPeriod;
    return inPeriod
      .map(batch => {
        const items = batch.items.filter(item => filteredDriverIds.has(item.driverId));
        if (items.length === 0) return null;
        return {
          ...batch,
          items,
          totalDrivers: items.length,
          totalAmount: items.reduce((sum, item) => sum + item.amount, 0),
          successfulPayouts: items.filter(item => item.status === 'completed').length,
          failedPayouts: items.filter(item => item.status === 'failed').length,
        };
      })
      .filter((batch): batch is PayoutBatch => batch !== null);
  }, [batches, regionScope, filteredDriverIds, periodBounds.from, periodBounds.to]);

  const filteredEarlyCashouts = useMemo(() => {
    const inPeriod = earlyCashouts.filter((cashout) =>
      isTimestampInPeriod(
        payoutActivityTimestamp({
          createdAt: cashout.createdAt,
          paidAt: cashout.paidAt,
          status: cashout.status,
        }),
        periodBounds.from,
        periodBounds.to,
      ),
    );
    if (!regionScope) return inPeriod;
    return inPeriod.filter(c => filteredDriverIds.has(c.driverId));
  }, [earlyCashouts, regionScope, filteredDriverIds, periodBounds.from, periodBounds.to]);

  const earlyCashoutStats = useMemo(() => ({
    total: filteredEarlyCashouts.length,
    processing: filteredEarlyCashouts.filter(c => c.status === 'processing' || c.status === 'pending').length,
    paid: filteredEarlyCashouts.filter(c => c.status === 'paid' || c.status === 'completed').length,
    failed: filteredEarlyCashouts.filter(c => c.status === 'failed').length,
  }), [filteredEarlyCashouts]);

  const getDriverRegionName = (driverId: string) => {
    const regionId = driverRegionById.get(driverId);
    if (!regionId) return '—';
    return regionsMap.get(regionId)?.name ?? regionId.substring(0, 8);
  };

  const resolvedCurrency = hasRegionScope
    ? (serviceFilter.currencyCode ||
      getSingleCurrency(drivers) ||
      '')
    : 'GBP';

  const isMixedCurrency =
    hasRegionScope &&
    !serviceFilter.currencyCode &&
    !getSingleCurrency(drivers) &&
    drivers.length > 0;

  // SSOT totals — never aggregate commission/liability locally
  const ssotSummary = financeSSOT.summary;
  const periodPaidOut = mondayPayouts.data?.today_cards?.driver_payout_sent_pence
    ?? filteredBatches.reduce(
      (sum, batch) => sum + batch.items
        .filter((item) => item.status === 'completed')
        .reduce((itemSum, item) => itemSum + item.amount, 0),
      0,
    );
  const totalPaidOut = hasRegionScope ? periodPaidOut : 0;
  const availableForPayout = hasRegionScope && ssotSummary
    ? FinanceSSOT.driverAvailableNow(ssotSummary)
    : 0;
  const driversReadyForPayout = hasRegionScope
    ? drivers.filter(d => d.net_available_for_payout > 0).length
    : 0;

  const summary = {
    totalBatches: filteredBatches.length,
    totalPaidOut,
    pendingBatches: filteredBatches.filter(b => b.status === 'pending' || b.status === 'processing').length,
    failedBatches: filteredBatches.filter(b => b.status === 'failed').length,
  };

  const selectedBatch = filteredBatches.find(b => b.id === selectedBatchId);
  const batchItems = selectedBatch?.items || [];
  const isLoading = isLoadingDrivers || isLoadingBatches;
  const earlyCashoutColSpan = hasRegionScope ? 8 : 9;

  const refetch = () => {
    refetchDrivers();
    refetchBatches();
    refetchEarlyCashouts();
  };

  const handleServiceFilterChange = (selection: ServiceAreaFinanceSelection) => {
    setSelectedBatchId(null);
    setServiceFilter(selection);
  };

  const handleRetryLedgerSync = async (payoutItemId: string) => {
    const { data, error } = await supabase.functions.invoke('admin-sync-payout-ledger', {
      body: { payout_item_id: payoutItemId },
    });
    if (error) throw error;
    if (!(data as { ok?: boolean })?.ok) {
      throw new Error((data as { error?: string })?.error ?? 'Ledger sync failed');
    }
    refetchBatches();
  };

  const handleRetryMondayPayout = async (row: Parameters<typeof retryMondayPayoutItem>[0]) => {
    setRetryingPayoutId(row.payout_item_id);
    try {
      await retryMondayPayoutItem(row);
      toast.success('Payout retry initiated');
      await mondayPayouts.refetch();
      refetchBatches();
      queryClient.invalidateQueries({ queryKey: ['admin-payout-batches-list'] });
      financeSSOT.refetch();
    } catch (e) {
      toast.error(`Retry failed: ${(e as Error).message}`);
    } finally {
      setRetryingPayoutId(null);
    }
  };

  const getStatusBadge = (status: string) => {
    const config: Record<string, { variant: 'default' | 'secondary' | 'destructive' | 'outline', icon: React.ReactNode }> = {
      completed: { variant: 'default', icon: <CheckCircle2 className="h-3 w-3 mr-1" /> },
      pending: { variant: 'secondary', icon: <Clock className="h-3 w-3 mr-1" /> },
      processing: { variant: 'outline', icon: <RefreshCw className="h-3 w-3 mr-1 animate-spin" /> },
      failed: { variant: 'destructive', icon: <XCircle className="h-3 w-3 mr-1" /> },
      ledger_sync_failed: { variant: 'destructive', icon: <AlertTriangle className="h-3 w-3 mr-1" /> },
    };
    const { variant, icon } = config[status] || { variant: 'outline' as const, icon: null };
    const label = formatPayoutDisplayStatus(status);
    return <Badge variant={variant} className="flex items-center w-fit">{icon}{label}</Badge>;
  };

  const getKindDisplay = (kind: string) => {
    const kinds: Record<string, string> = {
      'WEEKLY_MONDAY': 'Weekly (Monday)',
      'EARLY_CASHOUT': 'Early Cashout',
      'MANUAL_ADMIN': 'Manual Admin',
    };
    return kinds[kind] || kind;
  };

  if (isLoading) {
    return (
      <AdminLayout title="Payouts & Ledger Audit" description="Payout batches, early cashouts, ledger audit, and Stripe Connect">
        <div className="flex items-center justify-center h-64">
          <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout 
      title="Payouts & Ledger Audit" 
      description="Payout operations and audit — batches, early cashouts, driver wallet ledger, and Stripe Connect balances"
    >
      <div className="space-y-6">
        {isDriversError && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            Failed to load driver balances: {(driversError as Error)?.message || 'Unknown error'}
          </div>
        )}
        {isBatchesError && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            Failed to load payout batches: {(batchesError as Error)?.message || 'Unknown error'}
          </div>
        )}
        {isEarlyCashoutsError && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            Failed to load driver early cashouts: {(earlyCashoutsError as Error)?.message || 'Unknown error'}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <ServiceAreaFinanceFilter value={serviceFilter} onChange={handleServiceFilterChange} />
          <FinancePeriodFilter
            period={period}
            onPeriodChange={setPeriod}
            customFrom={customDateFrom}
            customTo={customDateTo}
            onCustomFromChange={setCustomDateFrom}
            onCustomToChange={setCustomDateTo}
          />
          {isMixedCurrency && (
            <Badge variant="outline" className="text-amber-600 border-amber-300">
              <AlertTriangle className="h-3 w-3 mr-1" /> Mixed currencies — select a service for totals
            </Badge>
          )}
        </div>

        {financeSSOT.error && (
          <div className="rounded-md border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-100">
            Live finance reconciliation unavailable — batch totals may use summary fallback.{' '}
            {(financeSSOT.error as Error).message}
          </div>
        )}

        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
          <TabsList className="flex flex-wrap h-auto gap-1">
            <TabsTrigger value="batches">Payout Batches</TabsTrigger>
            <TabsTrigger value="early-cashouts">Early Cashouts</TabsTrigger>
            <TabsTrigger value="ledger">
              <BookOpen className="h-4 w-4 mr-1.5" />
              Driver Wallet Ledger
            </TabsTrigger>
            <TabsTrigger value="connect-balance">
              <Landmark className="h-4 w-4 mr-1.5" />
              Stripe Connect Balance
            </TabsTrigger>
          </TabsList>

          <TabsContent value="batches" className="space-y-6 mt-4">
        {hasRegionScope && (
          <WeeklyMondaySettlementPanel filter={serviceFilter} currencyCode={resolvedCurrency} />
        )}

        <FinancePayoutAuditSection
          mondayPayouts={mondayPayouts}
          currencyCode={resolvedCurrency}
          onRetry={handleRetryMondayPayout}
          retryingId={retryingPayoutId}
          periodLabel={periodBounds.label}
        />

        <div className="grid gap-4 md:grid-cols-5">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Batches</CardTitle>
              <Calendar className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{summary.totalBatches}</div>
              <p className="text-xs text-muted-foreground">{periodBounds.label}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Paid Out</CardTitle>
              <DollarSign className="h-4 w-4 text-green-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-500">{formatPence(totalPaidOut, resolvedCurrency)}</div>
              <p className="text-xs text-muted-foreground">Sent in selected period</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Available for Payout</CardTitle>
              <Wallet className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-blue-500">{formatPence(availableForPayout, resolvedCurrency)}</div>
              <p className="text-xs text-muted-foreground">{driversReadyForPayout} drivers ready · after reserved cashouts</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Pending</CardTitle>
              <Clock className="h-4 w-4 text-amber-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-amber-500">{summary.pendingBatches}</div>
              <p className="text-xs text-muted-foreground">In progress</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Failed</CardTitle>
              <XCircle className="h-4 w-4 text-red-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-red-500">{summary.failedBatches}</div>
              <p className="text-xs text-muted-foreground">Need attention</p>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle>Payout Batches</CardTitle>
              <p className="text-sm text-muted-foreground mt-1">Weekly, manual admin, and early-cashout batch runs</p>
            </div>
            <Button variant="outline" size="icon" onClick={() => refetch()}><RefreshCw className="h-4 w-4" /></Button>
          </CardHeader>
          <CardContent className="p-0">
            {isLoadingBatches ? (
              <div className="flex items-center justify-center py-12">
                <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Run Date</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Drivers</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="text-right">Success</TableHead>
                  <TableHead className="text-right">Failed</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isBatchesError ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                      Unable to load payout batches — see error above
                    </TableCell>
                  </TableRow>
                ) : filteredBatches.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                      <div className="space-y-1">
                        <p>
                          {regionScope
                            ? 'No weekly or admin payout batches for this service area'
                            : 'No weekly or admin payout batches yet'}
                        </p>
                        <p className="text-xs">
                          Driver early cashouts are on the Early Cashouts tab — they are not stored as payout batches.
                        </p>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredBatches.map((batch) => (
                    <TableRow key={batch.id}>
                      <TableCell className="font-medium">
                        {batch.runDate ? format(new Date(batch.runDate), 'dd MMM yyyy') : format(new Date(batch.createdAt), 'dd MMM yyyy')}
                      </TableCell>
                      <TableCell>{getKindDisplay(batch.kind)}</TableCell>
                      <TableCell>{getStatusBadge(batch.status)}</TableCell>
                      <TableCell className="text-right">{batch.totalDrivers || 0}</TableCell>
                      <TableCell className="text-right font-medium text-green-600">{formatPence(batch.totalAmount || 0, resolvedCurrency)}</TableCell>
                      <TableCell className="text-right text-green-600">{batch.successfulPayouts || 0}</TableCell>
                      <TableCell className="text-right text-red-600">{batch.failedPayouts || 0}</TableCell>
                      <TableCell className="text-right">
                        <Button variant="ghost" size="sm" onClick={() => setSelectedBatchId(batch.id)}><Eye className="h-4 w-4" /></Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
            )}
          </CardContent>
        </Card>
          </TabsContent>

          <TabsContent value="early-cashouts" className="space-y-6 mt-4">
        <Card className="border-blue-200/60">
          <CardHeader className="flex flex-row items-center justify-between gap-4">
            <div className="space-y-2">
              <CardTitle>Driver Early Cashouts</CardTitle>
              <p className="text-sm text-muted-foreground">
                Individual driver-initiated cashouts — processing, paid, failed, and in transit.
                Separate from weekly/admin payout batch runs.
              </p>
              {!isLoadingEarlyCashouts && !isEarlyCashoutsError && (
                <div className="flex flex-wrap gap-2">
                  <Badge variant="outline">{earlyCashoutStats.total} total</Badge>
                  {earlyCashoutStats.processing > 0 && (
                    <Badge variant="outline" className="text-amber-600 border-amber-300">
                      <Clock className="h-3 w-3 mr-1" />
                      {earlyCashoutStats.processing} processing
                    </Badge>
                  )}
                  {earlyCashoutStats.paid > 0 && (
                    <Badge variant="outline" className="text-green-600 border-green-300">
                      <CheckCircle2 className="h-3 w-3 mr-1" />
                      {earlyCashoutStats.paid} paid
                    </Badge>
                  )}
                  {earlyCashoutStats.failed > 0 && (
                    <Badge variant="outline" className="text-red-600 border-red-300">
                      <XCircle className="h-3 w-3 mr-1" />
                      {earlyCashoutStats.failed} failed
                    </Badge>
                  )}
                </div>
              )}
            </div>
            <Button variant="outline" size="icon" onClick={() => refetchEarlyCashouts()}><RefreshCw className="h-4 w-4" /></Button>
          </CardHeader>
          <CardContent className="p-0">
            {isLoadingEarlyCashouts ? (
              <div className="flex items-center justify-center py-12">
                <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
                <span className="ml-2 text-sm text-muted-foreground">Loading early cashouts…</span>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    {!hasRegionScope && <TableHead>Region</TableHead>}
                    <TableHead>Driver</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Requested</TableHead>
                    <TableHead className="text-right">Fee</TableHead>
                    <TableHead className="text-right">Net to bank</TableHead>
                    <TableHead>Method</TableHead>
                    <TableHead>Stripe payout ID</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isEarlyCashoutsError ? (
                    <TableRow>
                      <TableCell colSpan={earlyCashoutColSpan} className="text-center py-8 text-destructive">
                        Unable to load early cashouts — see error above
                      </TableCell>
                    </TableRow>
                  ) : filteredEarlyCashouts.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={earlyCashoutColSpan} className="text-center py-8 text-muted-foreground">
                        {regionScope
                          ? 'No early cashouts for this service area yet'
                          : 'No early cashouts across any service area yet'}
                      </TableCell>
                    </TableRow>
                  ) : (
                    filteredEarlyCashouts.map((cashout) => (
                      <TableRow key={cashout.id}>
                        <TableCell className="font-medium whitespace-nowrap">
                          {format(new Date(cashout.createdAt), 'dd MMM yyyy HH:mm')}
                        </TableCell>
                        {!hasRegionScope && (
                          <TableCell className="text-sm">{getDriverRegionName(cashout.driverId)}</TableCell>
                        )}
                        <TableCell>{cashout.driverName || cashout.driverId.substring(0, 8)}</TableCell>
                        <TableCell>
                          <div className="space-y-1">
                            {getStatusBadge(cashout.status)}
                            {cashout.status === 'failed' && cashout.failureReason && (
                              <p className="text-xs text-red-600 max-w-[200px] truncate" title={cashout.failureReason}>
                                {cashout.failureReason}
                              </p>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-right">{formatPence(cashout.requestedAmount, cashout.currency || resolvedCurrency)}</TableCell>
                        <TableCell className="text-right text-orange-600">{formatPence(cashout.feeAmount, cashout.currency || resolvedCurrency)}</TableCell>
                        <TableCell className="text-right font-medium text-green-600">{formatPence(cashout.driverReceives, cashout.currency || resolvedCurrency)}</TableCell>
                        <TableCell>{getPayoutMethodLabel(cashout.payoutMethod)}</TableCell>
                        <TableCell className="text-xs font-mono max-w-[180px] truncate" title={cashout.stripePayoutId ?? undefined}>
                          {cashout.stripePayoutId ?? '—'}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
          </TabsContent>

          <TabsContent value="ledger" className="space-y-6 mt-4">
            <Card>
              <CardHeader>
                <CardTitle>Driver Wallet Ledger (ONECAB liability)</CardTitle>
                <p className="text-sm text-muted-foreground">
                  Current ONECAB liability only — trip earnings, cash commission recovery, debt recovery,
                  adjustments, and payout debits. Not Stripe Connect cash or lifetime earnings.
                  {' '}
                  <span className="font-medium">{periodBounds.label}</span>
                </p>
              </CardHeader>
              <CardContent>
                <FinanceLedgerPanel
                  serviceFilter={serviceFilter}
                  periodFrom={periodBounds.from}
                  periodTo={periodBounds.to}
                />
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="connect-balance" className="space-y-6 mt-4">
            <ConnectBalancePanel regionId={serviceFilter.regionId} currencyCode={resolvedCurrency} />
          </TabsContent>
        </Tabs>

        <Dialog open={!!selectedBatchId} onOpenChange={() => setSelectedBatchId(null)}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Payout Batch Details</DialogTitle>
              <DialogDescription>
                {selectedBatch && (selectedBatch.runDate ? format(new Date(selectedBatch.runDate), 'dd MMM yyyy') : format(new Date(selectedBatch.createdAt), 'dd MMM yyyy'))} - {selectedBatch && getKindDisplay(selectedBatch.kind)}
              </DialogDescription>
            </DialogHeader>
            {selectedBatch && (
              <div className="space-y-4">
                <div className="grid grid-cols-4 gap-4">
                  <Card><CardContent className="pt-4"><p className="text-xs text-muted-foreground">Status</p>{getStatusBadge(selectedBatch.status)}</CardContent></Card>
                  <Card><CardContent className="pt-4"><p className="text-xs text-muted-foreground">Total</p><p className="text-lg font-bold text-green-600">{formatPence(selectedBatch.totalAmount || 0, resolvedCurrency)}</p></CardContent></Card>
                  <Card><CardContent className="pt-4"><p className="text-xs text-muted-foreground">Success</p><p className="text-lg font-bold text-green-600">{selectedBatch.successfulPayouts || 0}</p></CardContent></Card>
                  <Card><CardContent className="pt-4"><p className="text-xs text-muted-foreground">Failed</p><p className="text-lg font-bold text-red-600">{selectedBatch.failedPayouts || 0}</p></CardContent></Card>
                </div>

                {selectedBatch.notes && (
                  <Card><CardContent className="pt-4"><p className="text-sm text-muted-foreground">Notes</p><p className="text-sm">{selectedBatch.notes}</p></CardContent></Card>
                )}

                <div>
                  <h4 className="font-medium mb-2">Individual Payouts</h4>
                  <ScrollArea className="h-[250px]">
                    {batchItems.length === 0 ? (
                      <p className="text-center text-muted-foreground py-8">No payout items</p>
                    ) : (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Driver</TableHead>
                            <TableHead className="text-right">Amount</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead>Sent to bank</TableHead>
                            <TableHead>Provider payout ID</TableHead>
                            <TableHead>Ledger debit</TableHead>
                            <TableHead>Wallet recalc</TableHead>
                            <TableHead>Reconciliation</TableHead>
                            <TableHead>Actions</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {batchItems.map((item) => {
                            const recon = payoutReconciliationStatus(item);
                            return (
                            <TableRow key={item.id} className={recon.critical ? 'bg-destructive/5' : undefined}>
                              <TableCell className="font-medium">{item.driverName || item.driverId?.substring(0, 8)}</TableCell>
                              <TableCell className="text-right text-green-600">{formatPence(item.amount || 0, resolvedCurrency)}</TableCell>
                              <TableCell>{getStatusBadge(item.status)}</TableCell>
                              <TableCell>{payoutSentToBank(item) ? 'Yes' : 'No'}</TableCell>
                              <TableCell className="text-xs font-mono max-w-[120px] truncate" title={item.stripePayoutId ?? item.stripeTransferId ?? undefined}>
                                {item.stripePayoutId ?? item.stripeTransferId ?? '—'}
                              </TableCell>
                              <TableCell>{ledgerDebitCreated(item) ? 'Yes' : 'No'}</TableCell>
                              <TableCell>{walletRecalculated(item) ? 'Yes' : 'No'}</TableCell>
                              <TableCell className="text-xs max-w-[200px]">
                                {recon.critical ? (
                                  <span className="text-destructive font-semibold">CRITICAL: {recon.detail}</span>
                                ) : (
                                  <span className="text-muted-foreground">{recon.label}</span>
                                )}
                              </TableCell>
                              <TableCell>
                                {(item.status === 'ledger_sync_failed' || (payoutSentToBank(item) && !ledgerDebitCreated(item))) && (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => handleRetryLedgerSync(item.id).catch((e) => alert((e as Error).message))}
                                  >
                                    Retry ledger
                                  </Button>
                                )}
                              </TableCell>
                            </TableRow>
                          );})}
                        </TableBody>
                      </Table>
                    )}
                  </ScrollArea>
                </div>
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => setSelectedBatchId(null)}>Close</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </AdminLayout>
  );
}
