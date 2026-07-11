import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { format } from 'date-fns';
import { Loader2, RefreshCw } from 'lucide-react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  useAdminPaymentSessions,
  useInspectPaymentSessionProvider,
  usePaymentSessionHoldAction,
  usePaymentSessionRefund,
} from '@/hooks/useAdminPaymentSessions';
import type {
  AdminPaymentSessionsListRow,
  AdminPaymentSessionsTab,
} from '../../shared/adminPaymentSessionsSSOT';
import { paymentSessionsUrl } from '../../shared/adminPaymentSessionsSSOT';
import type { PaymentSessionPurpose } from '../../shared/paymentSessionPhase1SSOT';
import { payoutLedgerUrl } from '../../shared/adminPayoutLedgerSSOT';
import {
  financeReconciliationTripUrl,
  tripSettlementRecoverUrl,
} from '@/lib/financialReconciliationRoutes';
import { driverWalletLedgerUrl } from '@/lib/driverWalletLedgerRoutes';
import { formatAgeMinutes, formatNullablePence } from '@/lib/formatNullablePence';
import {
  DEFAULT_SERVICE_AREA_SELECTION,
  ServiceAreaFinanceFilter,
  type ServiceAreaFinanceSelection,
} from '@/components/finance/ServiceAreaFinanceFilter';
import { toast } from 'sonner';

const TABS: Array<{ id: AdminPaymentSessionsTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'active_holds', label: 'Active Holds' },
  { id: 'captured', label: 'Captured' },
  { id: 'released', label: 'Released' },
  { id: 'refunded', label: 'Refunded' },
  { id: 'failed_recovery', label: 'Failed / Recovery' },
  { id: 'history', label: 'History' },
];

const PURPOSES: PaymentSessionPurpose[] = [
  'RIDE_BOOKING',
  'SAVE_CARD',
  'PAYMENT_RECOVERY',
  'LEGACY_EVIDENCE',
];

type TriState = 'all' | 'true' | 'false';

function parseTab(raw: string | null): AdminPaymentSessionsTab {
  if (raw && TABS.some((t) => t.id === raw)) return raw as AdminPaymentSessionsTab;
  return 'overview';
}

function pageStatusVariant(
  status: string,
): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'LIVE') return 'default';
  if (status === 'PROVIDER_UNAVAILABLE' || status === 'DEGRADED') return 'destructive';
  return 'secondary';
}

function triStateToBool(value: TriState): boolean | null {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

function SessionActions({
  row,
  actingId,
  inspectingId,
  onAction,
  onRefund,
  onInspect,
}: {
  row: AdminPaymentSessionsListRow;
  actingId: string | null;
  inspectingId: string | null;
  onAction: (row: AdminPaymentSessionsListRow, action: 'release' | 'retry_release' | 'retry_recovery') => void;
  onRefund: (row: AdminPaymentSessionsListRow) => void;
  onInspect: (row: AdminPaymentSessionsListRow) => void;
}) {
  const key = row.provider_order_id || row.payment_session_id || row.id;
  const busy = actingId === key;
  const inspecting = inspectingId === key;
  const policy = row.action_policy;
  return (
    <div className="flex flex-wrap gap-1">
      {row.trip_id && policy.can_open_trip !== false && (
        <Button asChild size="sm" variant="outline">
          <Link to={tripSettlementRecoverUrl(row.trip_id, row.trip_code)}>Open trip</Link>
        </Button>
      )}
      {policy.can_open_reconciliation && row.trip_id && (
        <Button asChild size="sm" variant="outline">
          <Link to={financeReconciliationTripUrl(row.trip_id, row.trip_code)}>
            Open Financial Reconciliation
          </Link>
        </Button>
      )}
      {row.driver_id && (
        <Button asChild size="sm" variant="outline">
          <Link to={driverWalletLedgerUrl(row.driver_id, 'ledger')}>Open Wallet</Link>
        </Button>
      )}
      <Button asChild size="sm" variant="outline">
        <Link to={payoutLedgerUrl()}>Payout ledger</Link>
      </Button>
      {policy.can_release && (
        <Button size="sm" disabled={busy} onClick={() => onAction(row, 'release')}>
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Release hold'}
        </Button>
      )}
      {policy.can_retry_release && (
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => onAction(row, 'retry_release')}>
          Retry release
        </Button>
      )}
      {policy.can_retry_recovery && (
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => onAction(row, 'retry_recovery')}>
          Retry recovery
        </Button>
      )}
      {policy.can_refund && (
        <Button size="sm" variant="destructive" disabled={busy || !row.provider_order_id} onClick={() => onRefund(row)}>
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Refund'}
        </Button>
      )}
      {row.provider_order_id && (
        <Button size="sm" variant="ghost" disabled={inspecting} onClick={() => onInspect(row)}>
          {inspecting ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Inspect'}
        </Button>
      )}
      {row.provider_verification_status === 'UNAVAILABLE' && (
        <Badge variant="destructive">Provider verification unavailable</Badge>
      )}
    </div>
  );
}

export default function PaymentSessions() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = parseTab(searchParams.get('tab'));
  const paymentSessionId = searchParams.get('paymentSessionId');
  const providerOrderId = searchParams.get('providerOrderId');
  const tripId = searchParams.get('tripId');

  const [serviceFilter, setServiceFilter] = useState<ServiceAreaFinanceSelection>(
    DEFAULT_SERVICE_AREA_SELECTION,
  );
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [provider, setProvider] = useState<string>('all');
  const [paymentMethod, setPaymentMethod] = useState('');
  const [purpose, setPurpose] = useState<string>('all');
  const [sessionStatus, setSessionStatus] = useState('');
  const [providerState, setProviderState] = useState('');
  const [hasTrip, setHasTrip] = useState<TriState>('all');
  const [activeHold, setActiveHold] = useState(false);
  const [releaseFailed, setReleaseFailed] = useState(false);
  const [recoveryPending, setRecoveryPending] = useState(false);
  const [legacyEvidence, setLegacyEvidence] = useState(false);
  const [refreshProviderState, setRefreshProviderState] = useState(false);

  const [actingId, setActingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [inspectSnapshots, setInspectSnapshots] = useState<Record<string, Record<string, unknown>>>({});
  const [inspectingId, setInspectingId] = useState<string | null>(null);

  const request = useMemo(
    () => ({
      tab,
      payment_session_id: paymentSessionId,
      provider_order_id: providerOrderId,
      trip_id: tripId,
      limit: 100,
      date_from: dateFrom || null,
      date_to: dateTo || null,
      service_area_id: serviceFilter.serviceAreaId,
      provider: provider === 'all' ? null : provider,
      payment_method: paymentMethod.trim() || null,
      purpose: purpose === 'all' ? null : (purpose as PaymentSessionPurpose),
      session_status: sessionStatus.trim() || null,
      provider_state: providerState.trim() || null,
      has_trip: triStateToBool(hasTrip),
      active_hold: activeHold ? true : null,
      release_failed: releaseFailed ? true : null,
      recovery_pending: recoveryPending ? true : null,
      legacy_evidence: legacyEvidence ? true : null,
      ...(refreshProviderState ? { refresh_provider_state: true as const } : {}),
    }),
    [
      tab,
      paymentSessionId,
      providerOrderId,
      tripId,
      dateFrom,
      dateTo,
      serviceFilter.serviceAreaId,
      provider,
      paymentMethod,
      purpose,
      sessionStatus,
      providerState,
      hasTrip,
      activeHold,
      releaseFailed,
      recoveryPending,
      legacyEvidence,
      refreshProviderState,
    ],
  );

  const { data, isLoading, isFetching, error, refetch } = useAdminPaymentSessions(request);
  const holdAction = usePaymentSessionHoldAction();
  const refundAction = usePaymentSessionRefund();
  const inspectProvider = useInspectPaymentSessionProvider();

  useEffect(() => {
    if (!refreshProviderState) return;
    if (isFetching || isLoading) return;
    setRefreshProviderState(false);
  }, [refreshProviderState, isFetching, isLoading]);

  const setTab = (next: string) => {
    const params = new URLSearchParams(searchParams);
    params.set('tab', next);
    setSearchParams(params, { replace: true });
  };

  const clearLocalFilters = () => {
    setServiceFilter(DEFAULT_SERVICE_AREA_SELECTION);
    setDateFrom('');
    setDateTo('');
    setProvider('all');
    setPaymentMethod('');
    setPurpose('all');
    setSessionStatus('');
    setProviderState('');
    setHasTrip('all');
    setActiveHold(false);
    setReleaseFailed(false);
    setRecoveryPending(false);
    setLegacyEvidence(false);
  };

  const hasLocalFilters =
    !!serviceFilter.serviceAreaId
    || !!dateFrom
    || !!dateTo
    || provider !== 'all'
    || !!paymentMethod.trim()
    || purpose !== 'all'
    || !!sessionStatus.trim()
    || !!providerState.trim()
    || hasTrip !== 'all'
    || activeHold
    || releaseFailed
    || recoveryPending
    || legacyEvidence;

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
        if (result?.already_resolved) {
          toast.success('Already resolved at provider');
        } else {
          toast.success(`Hold ${action.replace('_', ' ')} requested`);
        }
        await refetch();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Action failed');
      } finally {
        setActingId(null);
      }
    },
    [holdAction, refetch],
  );

  const runRefund = useCallback(
    async (row: AdminPaymentSessionsListRow) => {
      if (!row.provider_order_id) {
        toast.error('Missing provider order id');
        return;
      }
      const actionKey = row.provider_order_id || row.payment_session_id || row.id;
      setActingId(actionKey);
      try {
        await refundAction.mutateAsync({ providerOrderId: row.provider_order_id });
        toast.success('Refund requested');
        await refetch();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Refund failed');
      } finally {
        setActingId(null);
      }
    },
    [refundAction, refetch],
  );

  const runInspect = useCallback(
    async (row: AdminPaymentSessionsListRow) => {
      if (!row.provider_order_id) {
        toast.error('Missing provider order id');
        return;
      }
      const key = row.id;
      const actionKey = row.provider_order_id || row.payment_session_id || row.id;
      setExpandedId(key);
      setInspectingId(actionKey);
      try {
        const snapshot = await inspectProvider.mutateAsync(row.provider_order_id);
        setInspectSnapshots((prev) => ({ ...prev, [key]: snapshot ?? {} }));
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Inspect failed');
      } finally {
        setInspectingId(null);
      }
    },
    [inspectProvider],
  );

  const rows = data?.rows ?? [];
  const summary = data?.summary;

  return (
    <AdminLayout title="Payment Sessions (SSOT)">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">
              Provider lifecycle for every customer payment attempt. Release / refund / recovery live here only.
            </p>
            <div className="flex flex-wrap gap-2">
              <Badge variant={pageStatusVariant(data?.page_status ?? 'PARTIAL')}>
                {data?.page_status ?? 'PARTIAL'}
              </Badge>
              {summary && (
                <>
                  <Badge variant="outline">Active holds: {summary.active_hold_count}</Badge>
                  <Badge variant="destructive">RED: {summary.red}</Badge>
                  <Badge variant="secondary">
                    At risk: {formatNullablePence(summary.money_at_risk_pence)}
                  </Badge>
                </>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setRefreshProviderState(true)}
              disabled={isFetching || refreshProviderState}
            >
              {refreshProviderState && isFetching
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <RefreshCw className="h-4 w-4" />}
              <span className="ml-2">Force refresh provider</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void refetch()}
              disabled={isFetching}
            >
              {isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              <span className="ml-2">Refresh</span>
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-3 rounded-md border p-3">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">From</Label>
            <Input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="w-[150px]"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">To</Label>
            <Input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="w-[150px]"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Service area</Label>
            <ServiceAreaFinanceFilter
              value={serviceFilter}
              onChange={setServiceFilter}
              autoSelectFirstArea={false}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Provider</Label>
            <Select value={provider} onValueChange={setProvider}>
              <SelectTrigger className="w-[140px]">
                <SelectValue placeholder="All" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="revolut">revolut</SelectItem>
                <SelectItem value="stripe">stripe</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Payment method</Label>
            <Input
              value={paymentMethod}
              onChange={(e) => setPaymentMethod(e.target.value)}
              placeholder="e.g. card"
              className="w-[140px]"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Purpose</Label>
            <Select value={purpose} onValueChange={setPurpose}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="All" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                {PURPOSES.map((p) => (
                  <SelectItem key={p} value={p}>{p}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Session status</Label>
            <Input
              value={sessionStatus}
              onChange={(e) => setSessionStatus(e.target.value)}
              placeholder="status"
              className="w-[140px]"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Provider state</Label>
            <Input
              value={providerState}
              onChange={(e) => setProviderState(e.target.value)}
              placeholder="state"
              className="w-[140px]"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Has trip</Label>
            <Select value={hasTrip} onValueChange={(v) => setHasTrip(v as TriState)}>
              <SelectTrigger className="w-[120px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="true">true</SelectItem>
                <SelectItem value="false">false</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-wrap items-center gap-3 pb-2">
            <label className="flex items-center gap-2 text-xs">
              <Checkbox checked={activeHold} onCheckedChange={(v) => setActiveHold(v === true)} />
              active_hold
            </label>
            <label className="flex items-center gap-2 text-xs">
              <Checkbox checked={releaseFailed} onCheckedChange={(v) => setReleaseFailed(v === true)} />
              release_failed
            </label>
            <label className="flex items-center gap-2 text-xs">
              <Checkbox checked={recoveryPending} onCheckedChange={(v) => setRecoveryPending(v === true)} />
              recovery_pending
            </label>
            <label className="flex items-center gap-2 text-xs">
              <Checkbox checked={legacyEvidence} onCheckedChange={(v) => setLegacyEvidence(v === true)} />
              legacy_evidence
            </label>
          </div>
          {hasLocalFilters && (
            <Button variant="ghost" size="sm" onClick={clearLocalFilters}>
              Clear filters
            </Button>
          )}
        </div>

        {data?.provider_verification_message && (
          <Alert variant="destructive">
            <AlertTitle>Provider verification unavailable</AlertTitle>
            <AlertDescription>{data.provider_verification_message}</AlertDescription>
          </Alert>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertTitle>Payment Sessions failed to load</AlertTitle>
            <AlertDescription>{error instanceof Error ? error.message : String(error)}</AlertDescription>
          </Alert>
        )}

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="flex h-auto flex-wrap">
            {TABS.map((t) => (
              <TabsTrigger key={t.id} value={t.id}>{t.label}</TabsTrigger>
            ))}
          </TabsList>

          {TABS.map((t) => (
            <TabsContent key={t.id} value={t.id} className="space-y-3">
              {t.id === 'overview' && summary && (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Active holds</CardTitle></CardHeader><CardContent className="text-xl font-semibold">{summary.active_hold_count}</CardContent></Card>
                  <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Captured</CardTitle></CardHeader><CardContent className="text-xl font-semibold">{summary.captured_count}</CardContent></Card>
                  <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Released</CardTitle></CardHeader><CardContent className="text-xl font-semibold">{summary.released_count}</CardContent></Card>
                  <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Failed / recovery</CardTitle></CardHeader><CardContent className="text-xl font-semibold">{summary.failed_recovery_count}</CardContent></Card>
                </div>
              )}

              {isLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading payment sessions…
                </div>
              ) : rows.length === 0 ? (
                <Alert>
                  <AlertTitle>No payment attempts match the selected filters.</AlertTitle>
                  <AlertDescription>
                    Try Overview or History, or clear deep-link filters.
                    {paymentSessionId || providerOrderId || tripId || hasLocalFilters ? (
                      <>
                        {' '}
                        <Link
                          className="underline"
                          to={paymentSessionsUrl({ tab: t.id })}
                          onClick={clearLocalFilters}
                        >
                          Clear filters
                        </Link>
                      </>
                    ) : null}
                  </AlertDescription>
                </Alert>
              ) : (
                <div className="overflow-x-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Created</TableHead>
                        <TableHead>Customer</TableHead>
                        <TableHead>Trip</TableHead>
                        <TableHead>Service area</TableHead>
                        <TableHead>Provider</TableHead>
                        <TableHead>Method</TableHead>
                        <TableHead>Purpose</TableHead>
                        <TableHead>Authorised</TableHead>
                        <TableHead>Captured</TableHead>
                        <TableHead>Released</TableHead>
                        <TableHead>Refunded</TableHead>
                        <TableHead>Provider fee</TableHead>
                        <TableHead>Fee status</TableHead>
                        <TableHead>Provider state</TableHead>
                        <TableHead>Session status</TableHead>
                        <TableHead>Evidence status</TableHead>
                        <TableHead>Age</TableHead>
                        <TableHead>Reconciliation status</TableHead>
                        <TableHead>Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map((row) => {
                        const key = row.id;
                        return (
                          <Fragment key={key}>
                            <TableRow>
                              <TableCell className="whitespace-nowrap text-xs">
                                {format(new Date(row.created_at), 'dd MMM HH:mm')}
                                {row.source === 'orphan_payments' && (
                                  <Badge className="ml-1" variant="outline">ORPHAN_EVIDENCE</Badge>
                                )}
                              </TableCell>
                              <TableCell className="text-xs">
                                {row.customer_name ?? row.customer_email ?? '—'}
                              </TableCell>
                              <TableCell className="text-xs">
                                {row.trip_code ?? (row.trip_id ? row.trip_id.slice(0, 8) : 'No trip')}
                              </TableCell>
                              <TableCell className="text-xs">{row.service_area_name ?? '—'}</TableCell>
                              <TableCell className="text-xs">{row.payment_provider}</TableCell>
                              <TableCell className="text-xs">{row.payment_method ?? '—'}</TableCell>
                              <TableCell className="text-xs">{row.purpose ?? '—'}</TableCell>
                              <TableCell className="text-xs">
                                {row.amount_display === 'AMOUNT_UNCONFIRMED' && row.captured_amount_pence == null && !row.captured_at
                                  ? 'AMOUNT_UNCONFIRMED'
                                  : formatNullablePence(row.authorised_amount_pence)}
                              </TableCell>
                              <TableCell className="text-xs">
                                {formatNullablePence(row.captured_amount_pence)}
                                {row.evidence_status === 'CAPTURE_AMOUNT_MISSING' && (
                                  <div className="mt-1 text-[10px] text-amber-700">Captured amount not yet recorded</div>
                                )}
                              </TableCell>
                              <TableCell className="text-xs">
                                {row.released_at && row.released_amount_pence == null
                                  ? 'AMOUNT_UNCONFIRMED'
                                  : formatNullablePence(row.released_amount_pence)}
                              </TableCell>
                              <TableCell className="text-xs">{formatNullablePence(row.refunded_amount_pence)}</TableCell>
                              <TableCell className="text-xs">
                                {row.fee_display_badge === 'UNAVAILABLE'
                                  ? (row.fee_display_label ?? 'Fee unavailable')
                                  : row.fee_display_badge === 'PENDING'
                                    || row.provider_processing_fee_pence == null
                                  ? (row.fee_display_label ?? 'Pending provider fee')
                                  : formatNullablePence(row.provider_processing_fee_pence)}
                              </TableCell>
                              <TableCell className="text-xs">
                                {row.fee_display_badge ? (
                                  <Badge variant="outline">{row.fee_display_badge}</Badge>
                                ) : (
                                  row.fee_status ?? '—'
                                )}
                              </TableCell>
                              <TableCell className="text-xs">
                                <div>{row.provider_state_label ?? row.provider_state ?? 'UNKNOWN'}</div>
                              </TableCell>
                              <TableCell className="text-xs">
                                <div>{row.session_status_label ?? row.session_status ?? '—'}</div>
                              </TableCell>
                              <TableCell className="text-xs">
                                <Badge
                                  variant={
                                    row.evidence_status === 'COMPLETE'
                                      ? 'default'
                                      : row.evidence_status === 'CAPTURE_AMOUNT_MISSING'
                                      ? 'secondary'
                                      : 'outline'
                                  }
                                >
                                  {row.evidence_status ?? '—'}
                                </Badge>
                                {row.evidence_label && row.evidence_status !== 'COMPLETE' && (
                                  <div className="mt-1 text-[10px] text-muted-foreground">{row.evidence_label}</div>
                                )}
                              </TableCell>
                              <TableCell className="text-xs">{formatAgeMinutes(row.age_minutes)}</TableCell>
                              <TableCell className="text-xs">
                                <Badge variant={row.classification === 'RED' ? 'destructive' : row.classification === 'AMBER' ? 'secondary' : 'default'}>
                                  {row.classification ?? '—'}
                                </Badge>
                                <div className="mt-1 text-[10px] text-muted-foreground">{row.reconciliation_status}</div>
                              </TableCell>
                              <TableCell>
                                <SessionActions
                                  row={row}
                                  actingId={actingId}
                                  inspectingId={inspectingId}
                                  onAction={runAction}
                                  onRefund={runRefund}
                                  onInspect={runInspect}
                                />
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="mt-1"
                                  onClick={() => setExpandedId(expandedId === key ? null : key)}
                                >
                                  {expandedId === key ? 'Hide evidence' : 'Show evidence'}
                                </Button>
                              </TableCell>
                            </TableRow>
                            {expandedId === key && (
                              <TableRow>
                                <TableCell colSpan={19} className="bg-muted/40 text-xs">
                                  <div className="space-y-3">
                                    <div>
                                      <div className="mb-1 font-medium">Session evidence</div>
                                      <pre className="whitespace-pre-wrap">
                                        {JSON.stringify(
                                          {
                                            payment_session_id: row.payment_session_id,
                                            trip_id: row.trip_id,
                                            provider_order_id: row.provider_order_id,
                                            provider_payment_id: row.provider_payment_id,
                                            provider_capture_id: row.provider_capture_id,
                                            authorised_amount_pence: row.authorised_amount_pence,
                                            captured_amount_pence: row.captured_amount_pence,
                                            released_amount_pence: row.released_amount_pence,
                                            refunded_amount_pence: row.refunded_amount_pence,
                                            provider_processing_fee_pence: row.provider_processing_fee_pence,
                                            fee_status: row.fee_status,
                                            provider_state: row.provider_state,
                                            provider_state_verified_at: row.provider_state_verified_at,
                                            session_status_canonical: row.session_status_display,
                                            'Technical status': row.technical_status,
                                            captured_at: row.captured_at,
                                            released_at: row.released_at,
                                            refunded_at: row.refunded_at,
                                            evidence_status: row.evidence_status,
                                            evidence_label: row.evidence_label,
                                            evidence_warnings: row.evidence_warnings,
                                            reconciliation_status: row.reconciliation_status,
                                            attention_class: row.attention_class,
                                            webhook_timeline: row.webhook_timeline,
                                            admin_refresh_timeline: row.admin_refresh_timeline,
                                            action_policy: row.action_policy,
                                          },
                                          null,
                                          2,
                                        )}
                                      </pre>
                                    </div>
                                    {(row.evidence_warnings?.length ?? 0) > 0 && (
                                      <div>
                                        <div className="mb-1 font-medium">Evidence warnings</div>
                                        <ul className="list-disc pl-4 text-amber-800">
                                          {row.evidence_warnings.map((w) => (
                                            <li key={w}>{w}</li>
                                          ))}
                                        </ul>
                                      </div>
                                    )}
                                    <div>
                                      <div className="mb-1 font-medium">Webhook timeline</div>
                                      <pre className="whitespace-pre-wrap">
                                        {JSON.stringify(row.webhook_timeline ?? [], null, 2)}
                                      </pre>
                                    </div>
                                    <div>
                                      <div className="mb-1 font-medium">Admin refresh timeline</div>
                                      <pre className="whitespace-pre-wrap">
                                        {JSON.stringify(row.admin_refresh_timeline ?? [], null, 2)}
                                      </pre>
                                    </div>
                                    <div>
                                      <div className="mb-1 font-medium">Sanitised provider snapshot</div>
                                      {inspectSnapshots[key] ? (
                                        <pre className="whitespace-pre-wrap">
                                          {JSON.stringify(inspectSnapshots[key], null, 2)}
                                        </pre>
                                      ) : (
                                        <p className="text-muted-foreground">
                                          Use Inspect to load a sanitised provider snapshot (no raw secrets).
                                        </p>
                                      )}
                                    </div>
                                  </div>
                                </TableCell>
                              </TableRow>
                            )}
                          </Fragment>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </TabsContent>
          ))}
        </Tabs>
      </div>
    </AdminLayout>
  );
}
