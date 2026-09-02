import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2, MoreHorizontal, RefreshCw } from 'lucide-react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  PaymentSessionsFilterBar,
  paymentSessionsSearchMatchesRow,
  triStateToBool,
  type PaymentSessionsFilterState,
} from '@/components/finance/PaymentSessionsFilterBar';
import { PaymentSessionsListPanel } from '@/components/finance/PaymentSessionsListPanel';
import { PaymentSessionsOperationalChips } from '@/components/finance/PaymentSessionsOperationalChips';
import { PaymentSessionsOperationalChipAuditPanel } from '@/components/finance/PaymentSessionsOperationalChipAuditPanel';
import { PaymentSessionsSummaryCards } from '@/components/finance/PaymentSessionsSummaryCards';
import {
  useAdminPaymentSessions,
  useInspectPaymentSessionProvider,
  usePaymentSessionHoldAction,
  usePaymentSessionRefund,
} from '@/hooks/useAdminPaymentSessions';
import type { AdminPaymentSessionsListRow } from '../../shared/adminPaymentSessionsSSOT';
import type { PaymentSessionPurpose } from '../../shared/paymentSessionPhase1SSOT';
import {
  buildPaymentSessionsBackendRequest,
  buildPaymentSessionsNavPatch,
  filterPaymentSessionsRowsForNav,
  needsClientSidePaymentSessionsNavFilter,
  normalizePaymentSessionsSearchParams,
  parsePaymentSessionsNavTab,
  parsePaymentSessionsOpChip,
  resolveLegacyPaymentSessionsIssueParams,
  resolvePaymentSessionsFilteredTotal,
  resolvePaymentSessionsListHasMore,
  PAYMENT_SESSIONS_NAV_TABS,
  type PaymentSessionsNavTab,
  type PaymentSessionsOpChip,
} from '../../shared/paymentSessionsNavigationSSOT';
import { classifyCaptureConfirmation } from '../../shared/paymentSessionsCaptureConfirmationSSOT';
import {
  DEFAULT_SERVICE_AREA_SELECTION,
  type ServiceAreaFinanceSelection,
} from '@/components/finance/ServiceAreaFinanceFilter';
import { useServiceAreas } from '@/hooks/useServiceAreas';
import { FINANCIAL_MODEL, filterServiceAreasByFinancialModel } from '../../shared/financialModelScopeSSOT';
import { formatNullablePence } from '@/lib/formatNullablePence';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';

const NAV_TAB_LABELS: Record<PaymentSessionsNavTab, string> = {
  captured: 'Captured',
  released: 'Released',
  refunded: 'Refunded',
  recovery: 'Recovery',
};

const PAGE_LIMIT = 100;

export default function PaymentSessions() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const paymentSessionId = searchParams.get('paymentSessionId');
  const providerOrderId = searchParams.get('providerOrderId');
  const tripIdParam = searchParams.get('tripId');
  const customerIdParam = searchParams.get('customerId');

  const navTab = parsePaymentSessionsNavTab(searchParams.get('tab'));
  const opChip = parsePaymentSessionsOpChip(
    searchParams.get('opFilter') ?? resolveLegacyPaymentSessionsIssueParams(searchParams),
  );

  useEffect(() => {
    const normalized = normalizePaymentSessionsSearchParams(searchParams);
    if (normalized) {
      navigate(normalized, { replace: true });
    }
  }, [navigate, searchParams]);

  const [filters, setFilters] = useState<PaymentSessionsFilterState>(() => ({
    serviceFilter: DEFAULT_SERVICE_AREA_SELECTION,
    dateFrom: '',
    dateTo: '',
    search: '',
    provider: 'all',
    paymentMethod: '',
    purpose: 'all',
    sessionStatus: '',
    providerState: '',
    customerId: customerIdParam ?? '',
    tripIdFilter: tripIdParam ?? '',
    hasTrip: 'all',
    activeHold: false,
    releaseFailed: false,
    recoveryPending: false,
    providerFeesPending: false,
    captureFailed: false,
  }));
  const [financeScopeReady, setFinanceScopeReady] = useState(false);
  const [providerRefreshActive, setProviderRefreshActive] = useState(false);
  const [forceRefreshOpen, setForceRefreshOpen] = useState(false);
  const [listOffset, setListOffset] = useState(0);

  const { data: serviceAreas = [], isLoading: serviceAreasLoading } = useServiceAreas({ activeOnly: true });

  // Never load unscoped — all-service-area list is slow and feels stuck on large fleets (FR SSOT).
  useEffect(() => {
    if (financeScopeReady || serviceAreasLoading) return;
    if (filters.serviceFilter.regionId || filters.serviceFilter.serviceAreaId) {
      setFinanceScopeReady(true);
      return;
    }
    const platformAreas = filterServiceAreasByFinancialModel(
      serviceAreas,
      FINANCIAL_MODEL.PLATFORM_COLLECTED,
    );
    const first = platformAreas[0];
    if (first) {
      const cc = first.region?.currency_code || first.currency_code || null;
      setFilters((f) => ({
        ...f,
        serviceFilter: {
          serviceAreaId: first.id,
          regionId: first.region_id,
          currencyCode: cc,
        },
      }));
    }
    setFinanceScopeReady(true);
  }, [
    financeScopeReady,
    serviceAreasLoading,
    serviceAreas,
    filters.serviceFilter.regionId,
    filters.serviceFilter.serviceAreaId,
  ]);

  const triggerProviderListRefresh = useCallback(() => {
    setProviderRefreshActive(true);
  }, []);

  const [actingId, setActingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [inspectSnapshots, setInspectSnapshots] = useState<Record<string, Record<string, unknown>>>({});
  const [inspectingId, setInspectingId] = useState<string | null>(null);
  const [refundRow, setRefundRow] = useState<AdminPaymentSessionsListRow | null>(null);
  const [refundAmountInput, setRefundAmountInput] = useState('');
  const [refundReason, setRefundReason] = useState('');

  useEffect(() => {
    if (customerIdParam) setFilters((f) => ({ ...f, customerId: customerIdParam }));
  }, [customerIdParam]);

  useEffect(() => {
    if (tripIdParam) setFilters((f) => ({ ...f, tripIdFilter: tripIdParam }));
  }, [tripIdParam]);

  useEffect(() => {
    setListOffset(0);
  }, [navTab, opChip, paymentSessionId, providerOrderId, filters]);

  const serviceFilter = filters.serviceFilter;

  const baseRequest = useMemo(
    () => ({
      payment_session_id: paymentSessionId,
      provider_order_id: providerOrderId,
      trip_id: filters.tripIdFilter.trim() || null,
      customer_id: filters.customerId.trim() || null,
      limit: PAGE_LIMIT,
      offset: listOffset,
      date_from: filters.dateFrom || null,
      date_to: filters.dateTo || null,
      service_area_id: serviceFilter.serviceAreaId,
      provider: filters.provider === 'all' ? null : filters.provider,
      payment_method: filters.paymentMethod.trim() || null,
      purpose: filters.purpose === 'all' ? null : (filters.purpose as PaymentSessionPurpose),
      session_status: filters.sessionStatus.trim() || null,
      provider_state: filters.providerState.trim() || null,
      has_trip: triStateToBool(filters.hasTrip),
      active_hold: filters.activeHold || null,
      release_failed: filters.releaseFailed || null,
      recovery_pending: filters.recoveryPending || null,
      provider_fees_pending: filters.providerFeesPending || null,
      capture_failed: filters.captureFailed || null,
      ...(providerRefreshActive ? { refresh_provider_state: true as const } : {}),
    }),
    [paymentSessionId, providerOrderId, filters, listOffset, providerRefreshActive, serviceFilter],
  );

  const listRequest = useMemo(
    () => buildPaymentSessionsBackendRequest({ navTab, opChip, base: baseRequest }),
    [navTab, opChip, baseRequest],
  );

  const { data, isLoading, isFetching, error, refetch } = useAdminPaymentSessions(
    listRequest,
    financeScopeReady,
  );

  useEffect(() => {
    if (!providerRefreshActive) return;
    if (isFetching || isLoading) return;
    setProviderRefreshActive(false);
  }, [providerRefreshActive, isFetching, isLoading, data, error]);

  const summary = data?.summary;
  const rawRows = data?.rows ?? [];

  const clientFiltered = needsClientSidePaymentSessionsNavFilter({
    navTab,
    opChip,
    search: filters.search,
  });

  const displayRows = useMemo(() => {
    let rows = filterPaymentSessionsRowsForNav(rawRows, navTab, opChip);
    if (filters.search.trim()) {
      rows = rows.filter((r) => paymentSessionsSearchMatchesRow(filters.search, r));
    }
    return rows;
  }, [rawRows, navTab, opChip, filters.search]);

  const filteredTotal = resolvePaymentSessionsFilteredTotal({
    clientFiltered,
    navTab,
    opChip,
    summary,
    backendFilteredTotal: data?.filtered_total,
    displayRowCount: displayRows.length,
    hasSearch: !!filters.search.trim(),
  });

  const listHasMore = resolvePaymentSessionsListHasMore({
    clientFiltered,
    listOffset,
    rawRowCount: rawRows.length,
    pageLimit: PAGE_LIMIT,
    backendHasMore: Boolean(data?.has_more),
    filteredTotal,
  });

  useEffect(() => {
    if (displayRows.length === 0) return;
    const match = displayRows.find((row) =>
      (paymentSessionId && row.payment_session_id === paymentSessionId)
      || (providerOrderId && row.provider_order_id === providerOrderId),
    );
    if (match) setExpandedId(match.id);
  }, [paymentSessionId, providerOrderId, displayRows]);

  const patchSearchParams = useCallback((patch: Record<string, string | null>) => {
    const params = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(patch)) {
      if (value == null || value === '' || value === 'all') params.delete(key);
      else params.set(key, value);
    }
    params.delete('offset');
    setSearchParams(params, { replace: true });
  }, [searchParams, setSearchParams]);

  const setNavTab = (next: PaymentSessionsNavTab) => {
    patchSearchParams(buildPaymentSessionsNavPatch({ tab: next, opFilter: null }));
  };

  const setOpChip = (chip: PaymentSessionsOpChip) => {
    patchSearchParams({ opFilter: chip === 'all' ? null : chip });
  };

  const clearFilters = () => {
    setFilters({
      serviceFilter: DEFAULT_SERVICE_AREA_SELECTION,
      dateFrom: '',
      dateTo: '',
      search: '',
      provider: 'all',
      paymentMethod: '',
      purpose: 'all',
      sessionStatus: '',
      providerState: '',
      customerId: '',
      tripIdFilter: '',
      hasTrip: 'all',
      activeHold: false,
      releaseFailed: false,
      recoveryPending: false,
      providerFeesPending: false,
      captureFailed: false,
    });
    setListOffset(0);
    patchSearchParams({
      customerId: null,
      tripId: null,
      paymentSessionId: null,
      providerOrderId: null,
      opFilter: null,
    });
  };

  const hasActiveFilters =
    !!paymentSessionId
    || !!providerOrderId
    || !!serviceFilter.serviceAreaId
    || !!filters.dateFrom
    || !!filters.dateTo
    || !!filters.search.trim()
    || filters.provider !== 'all'
    || !!filters.paymentMethod.trim()
    || filters.purpose !== 'all'
    || !!filters.sessionStatus.trim()
    || !!filters.providerState.trim()
    || !!filters.customerId.trim()
    || !!filters.tripIdFilter.trim()
    || filters.hasTrip !== 'all'
    || filters.activeHold
    || filters.releaseFailed
    || filters.recoveryPending
    || filters.providerFeesPending
    || filters.captureFailed;

  const holdAction = usePaymentSessionHoldAction();
  const refundAction = usePaymentSessionRefund();
  const inspectProvider = useInspectPaymentSessionProvider();

  const runAction = useCallback(
    async (
      row: AdminPaymentSessionsListRow,
      action: 'release' | 'retry_release' | 'retry_recovery',
    ) => {
      const actionKey = row.provider_order_id || row.payment_session_id || row.id;
      setActingId(actionKey);
      try {
        const result = await holdAction.mutateAsync({
          ...(row.source === 'payment_sessions' && row.payment_session_id
            ? { payment_session_id: row.payment_session_id }
            : {}),
          provider_order_id: row.provider_order_id ?? undefined,
          action,
        }) as { already_resolved?: boolean };
        if (result?.already_resolved) toast.success('Already resolved at provider');
        else toast.success(`Hold ${action.replace('_', ' ')} requested`);
        await refetch();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Action failed');
      } finally {
        setActingId(null);
      }
    },
    [holdAction, refetch],
  );

  const openRefundSheet = useCallback((row: AdminPaymentSessionsListRow) => {
    if (!row.trip_id) {
      toast.error('Trip id is required to refund');
      return;
    }
    setRefundRow(row);
    setRefundAmountInput('');
    setRefundReason(`Payment Sessions refund for ${row.trip_code ?? row.trip_id}`);
  }, []);

  const submitRefundSheet = useCallback(async () => {
    if (!refundRow?.trip_id) return;
    const pounds = Number(refundAmountInput);
    if (!Number.isFinite(pounds) || pounds <= 0) {
      toast.error('Enter a refund amount greater than £0');
      return;
    }
    const amountPence = Math.round(pounds * 100);
    const actionKey = refundRow.provider_order_id || refundRow.payment_session_id || refundRow.id;
    setActingId(actionKey);
    try {
      await refundAction.mutateAsync({
        tripId: refundRow.trip_id,
        amountPence,
        reason: refundReason.trim() || undefined,
      });
      toast.success(`Refunded £${(amountPence / 100).toFixed(2)}`);
      setRefundRow(null);
      await refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Refund failed');
    } finally {
      setActingId(null);
    }
  }, [refundRow, refundAmountInput, refundReason, refundAction, refetch]);

  const runRequestRecovery = useCallback(async (row: AdminPaymentSessionsListRow) => {
    if (!row.trip_id) {
      toast.error('Trip id is required');
      return;
    }
    const confirmation = classifyCaptureConfirmation({
      providerState: row.provider_state,
      providerCapturedPence: row.captured_amount_pence,
      localCapturedPence: row.captured_amount_pence,
      canonicalPayablePence: row.customer_payable_pence,
      authorisedPence: row.authorised_amount_pence,
      purpose: row.purpose,
    });
    const outstanding = row.outstanding_pence ?? confirmation.outstanding_pence;
    if (outstanding == null || outstanding <= 0) {
      toast.error('No outstanding balance to collect');
      return;
    }
    setActingId(row.id);
    try {
      const { data: resp, error: invokeErr } = await supabase.functions.invoke('create-payment-recovery', {
        body: {
          trip_id: row.trip_id,
          parent_session_id: row.payment_session_id ?? null,
          amount_pence: outstanding,
          action_mode: 'collect_outstanding',
        },
      });
      if (invokeErr) throw invokeErr;
      const payload = (resp ?? {}) as { checkout_url?: string | null };
      if (payload.checkout_url) window.open(payload.checkout_url, '_blank', 'noopener');
      await refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Recovery request failed');
    } finally {
      setActingId(null);
    }
  }, [refetch]);

  const runAbandonRecovery = useCallback(async (row: AdminPaymentSessionsListRow) => {
    if (!row.trip_id) return;
    const reason = window.prompt('Abandon recovery reason (min 5 chars):', '');
    if (!reason || reason.trim().length < 5) return;
    setActingId(row.id);
    try {
      const { error: invokeErr } = await supabase.functions.invoke('admin-cancel-trip-payment', {
        body: { trip_id: row.trip_id, reason: reason.trim(), abandon_recovery: true },
      });
      if (invokeErr) throw invokeErr;
      toast.success('Recovery abandoned');
      await refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Abandon failed');
    } finally {
      setActingId(null);
    }
  }, [refetch]);

  const runInspect = useCallback(async (row: AdminPaymentSessionsListRow) => {
    if (!row.provider_order_id) return;
    setExpandedId(row.id);
    setInspectingId(row.id);
    try {
      const snapshot = await inspectProvider.mutateAsync(row.provider_order_id);
      setInspectSnapshots((prev) => ({ ...prev, [row.id]: snapshot ?? {} }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Inspect failed');
    } finally {
      setInspectingId(null);
    }
  }, [inspectProvider]);

  const runForceRefreshProvider = async () => {
    setForceRefreshOpen(false);
    triggerProviderListRefresh();
    try {
      const { data: refreshData, error: invokeErr } = await supabase.functions.invoke('admin-refresh-payment-sessions', {
        body: { service_area_id: serviceFilter.serviceAreaId || null },
      });
      if (refreshData && typeof refreshData === 'object' && (refreshData as { ok?: boolean }).ok === false) {
        throw new Error(
          typeof (refreshData as { error?: unknown }).error === 'string'
            ? (refreshData as { error: string }).error
            : 'Provider refresh failed',
        );
      }
      if (invokeErr) throw invokeErr;
      toast.success('Provider state refreshed');
    } catch (err) {
      toast.error(`Refresh failed: ${(err as Error).message}`);
      setProviderRefreshActive(false);
    }
  };

  const listPanelProps = {
    rows: displayRows,
    isLoading: !financeScopeReady || isLoading,
    isFetching,
    error: error as Error | null,
    filteredTotal,
    listOffset,
    pageLimit: PAGE_LIMIT,
    hasMore: listHasMore,
    actingId,
    inspectingId,
    expandedId,
    inspectSnapshots,
    onExpandToggle: setExpandedId,
    onRefetch: () => void refetch(),
    onPagePrev: () => setListOffset((o) => Math.max(0, o - PAGE_LIMIT)),
    onPageNext: () => setListOffset((o) => o + PAGE_LIMIT),
    onAction: runAction,
    onRefund: openRefundSheet,
    onInspect: runInspect,
    onRequestRecovery: runRequestRecovery,
    onAbandonRecovery: runAbandonRecovery,
    onRefreshProvider: () => {
      triggerProviderListRefresh();
    },
  };

  return (
    <AdminLayout title="Payment Sessions (SSOT)">
      <div className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-2 min-w-0">
            <p className="text-sm text-muted-foreground">
              Customer payment lifecycle only — capture, release, refund, and recovery.
              {' '}
              <Link className="underline" to="/financial-reconciliation">Financial Reconciliation</Link>
              {' '}
              owns driver-credit audit.
            </p>
            <PaymentSessionsOperationalChips
              summary={summary}
              onSelect={({ tab, opFilter }) => {
                patchSearchParams(buildPaymentSessionsNavPatch({ tab, opFilter }));
              }}
            />
            {(opChip === 'release_pending' || opChip === 'recovery_required') && (
              <PaymentSessionsOperationalChipAuditPanel summary={summary} opChip={opChip} />
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching}>
              {isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              <span className="ml-2">Refresh</span>
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" aria-label="Operations">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setForceRefreshOpen(true)}>
                  Force refresh provider…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {error && !summary ? (
          <Alert variant="destructive">
            <AlertTitle>Payment Sessions unavailable</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center gap-2">
              <span>{error instanceof Error ? error.message : String(error)}</span>
              <Button size="sm" variant="outline" onClick={() => void refetch()}>Retry</Button>
            </AlertDescription>
          </Alert>
        ) : (
          <PaymentSessionsSummaryCards
            summary={summary}
            currencyCode={serviceFilter.currencyCode ?? 'GBP'}
          />
        )}

        <PaymentSessionsFilterBar
          financialModel="PLATFORM_COLLECTED"
          filters={filters}
          onChange={(patch) => setFilters((f) => ({ ...f, ...patch }))}
          onClear={clearFilters}
          hasActiveFilters={hasActiveFilters}
        />

        {data?.provider_verification_message && (
          <Alert variant="destructive">
            <AlertTitle>Provider sync pending</AlertTitle>
            <AlertDescription>{data.provider_verification_message}</AlertDescription>
          </Alert>
        )}

        <Tabs value={navTab} onValueChange={(v) => setNavTab(v as PaymentSessionsNavTab)}>
          <TabsList className="grid w-full max-w-lg grid-cols-4">
            {PAYMENT_SESSIONS_NAV_TABS.map((t) => (
              <TabsTrigger key={t} value={t}>{NAV_TAB_LABELS[t]}</TabsTrigger>
            ))}
          </TabsList>

          {PAYMENT_SESSIONS_NAV_TABS.map((t) => (
            <TabsContent key={t} value={t} className="mt-4">
              {navTab === t ? (
                <>
                  {opChip !== 'all' && (
                    <div className="mb-3 flex items-center gap-2 text-sm">
                      <span className="text-muted-foreground">Filter:</span>
                      <Button variant="secondary" size="sm" onClick={() => setOpChip('all')}>
                        Clear chip filter
                      </Button>
                    </div>
                  )}
                  <PaymentSessionsListPanel {...listPanelProps} />
                </>
              ) : null}
            </TabsContent>
          ))}
        </Tabs>
      </div>

      <Dialog open={forceRefreshOpen} onOpenChange={setForceRefreshOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Force refresh provider?</DialogTitle>
            <DialogDescription>
              Synchronises live provider state for sessions in the selected service area.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setForceRefreshOpen(false)}>Cancel</Button>
            <Button onClick={() => void runForceRefreshProvider()} disabled={providerRefreshActive || isFetching}>
              Refresh provider
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={refundRow != null} onOpenChange={(open) => { if (!open) setRefundRow(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Refund</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="ps-refund-amount">Amount (GBP)</Label>
              <Input
                id="ps-refund-amount"
                type="number"
                step="0.01"
                value={refundAmountInput}
                onChange={(e) => setRefundAmountInput(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="ps-refund-reason">Reason</Label>
              <Textarea
                id="ps-refund-reason"
                rows={2}
                value={refundReason}
                onChange={(e) => setRefundReason(e.target.value)}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Captured: {formatNullablePence(refundRow?.captured_amount_pence ?? null)}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRefundRow(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => void submitRefundSheet()}>Confirm refund</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}
