import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ExternalLink,
  Loader2,
  RefreshCw,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  CRITICAL_BUTTON_TIMEOUT_MESSAGE,
  useCriticalButtonTimeout,
} from '@/lib/criticalButtonTimeout';
import { startAdminPerformanceStep } from '@/lib/recordAdminPerformanceStep';
import {
  Dialog,
  DialogContent,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { DriverDrawerTripRowActions } from '@/components/finance/DriverDrawerTripRowActions';
import { FinancialReconciliationRefreshBar } from '@/components/finance/FinancialReconciliationRefreshBar';
import type { ServiceAreaFinanceSelection } from '@/components/finance/ServiceAreaFinanceFilter';
import type { FinanceMoneyFormat } from '@/hooks/useFinanceReconciliationMoney';
import type { TripFinancialAuditRow } from '@/hooks/useFinanceReconciliation';
import type { DriverWalletSsotRow } from '@/hooks/useDriverWalletSsot';
import type { FinanceDataSourceBadge } from '@/hooks/useFinancialReconciliationSSOT';
import { useDriverWalletSsotDetail } from '@/hooks/useDriverWalletSsot';
import { usePerDriverFinancialReconciliation } from '@/hooks/usePerDriverFinancialReconciliation';
import { useDriverTripFinancialAudit } from '@/hooks/useDriverTripFinancialAudit';
import { formatFinanceDateSafe } from '@/lib/financialReconciliationGuards';
import { formatNullablePence } from '@/lib/formatNullablePence';
import {
  defaultDriverDateRange,
  driverDateRangeLabel,
  resolveDriverDateRange,
  type DriverDateRange,
  type DriverDateRangePreset,
} from '@/lib/financialReconciliationDriverDateRange';
import { driverWalletLedgerUrl } from '@/lib/driverWalletLedgerRoutes';
import { paymentSessionsUrl } from '../../../shared/adminPaymentSessionsSSOT';
import { payoutLedgerUrl } from '../../../shared/adminPayoutLedgerSSOT';
import { reconciliationBadgeVariant } from '@/lib/financeTripReconciliationBadge';

type PaymentStatusTab =
  | 'all'
  | 'succeeded'
  | 'refunded'
  | 'failed'
  | 'uncaptured'
  | 'pending_settlement'
  | 'paid_out';

function isDigitalPayment(_method: string | null | undefined): boolean {
  return true;
}

function providerLabel(row: TripFinancialAuditRow): string {
  return row.provider?.label ?? row.provider_status ?? '—';
}

function matchesPaymentTab(row: TripFinancialAuditRow, tab: PaymentStatusTab): boolean {
  if (tab === 'all') return true;
  const digital = isDigitalPayment(row.payment_method);
  const captured = row.captured_pence;
  const refunded = row.refunded_pence;
  const provider = providerLabel(row).toLowerCase();
  const payoutLabel = (row.driver_payout?.label ?? '').toLowerCase();

  if (tab === 'succeeded') {
    return digital && captured != null && captured > 0 && (refunded == null || refunded < captured);
  }
  if (tab === 'refunded') return refunded != null && refunded > 0;
  if (tab === 'failed') {
    if (!digital) return false;
    return provider.includes('failed') || provider.includes('canceled') || provider.includes('cancelled');
  }
  if (tab === 'uncaptured') {
    return digital && (captured == null || captured <= 0) && (
      provider.includes('requires_capture') || provider.includes('authorized') || provider.includes('pending')
    );
  }
  if (tab === 'pending_settlement') {
    return payoutLabel.includes('pending') || payoutLabel.includes('awaiting') || payoutLabel.includes('scheduled');
  }
  if (tab === 'paid_out') {
    return payoutLabel.includes('paid') || payoutLabel.includes('transferred') || payoutLabel.includes('completed');
  }
  return true;
}

function OverviewMetric({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <Card>
      <CardContent className="pt-3 pb-3">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-lg font-semibold tabular-nums mt-0.5">{value}</p>
        {hint ? <p className="text-[10px] text-muted-foreground mt-1">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}

function CompareRow({
  label,
  left,
  right,
  diff,
  fmt,
}: {
  label: string;
  left: number | null;
  right: number | null;
  diff: number | null;
  fmt: (p: number | null | undefined) => string;
}) {
  const matched = diff != null && Math.abs(diff) <= 1;
  return (
    <div className="grid grid-cols-[1fr_auto_auto_auto] gap-2 text-xs py-1 border-b border-border/40 last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums text-right">{fmt(left)}</span>
      <span className="tabular-nums text-right">{fmt(right)}</span>
      <span className={`tabular-nums text-right font-medium ${matched ? 'text-emerald-600' : 'text-destructive'}`}>
        {matched ? '✓' : fmt(diff)}
      </span>
    </div>
  );
}

export function FinancialReconciliationDriverDrawer({
  open,
  onOpenChange,
  driverRow,
  filter,
  pageFrom,
  pageTo,
  money,
  readOnly = false,
  ssotBadge = 'LIVE',
  lastSyncedAt = null,
  serviceAreaName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  driverRow: DriverWalletSsotRow | null;
  filter: ServiceAreaFinanceSelection;
  pageFrom?: string;
  pageTo?: string;
  money: FinanceMoneyFormat;
  readOnly?: boolean;
  ssotBadge?: FinanceDataSourceBadge;
  lastSyncedAt?: string | null;
  serviceAreaName?: string | null;
}) {
  const driverId = driverRow?.driver_id ?? null;
  const currencyCode = money.currencyCode ?? filter.currencyCode ?? 'GBP';
  const fmt = (p: number | null | undefined) => formatNullablePence(p, currencyCode);

  const [dateRange, setDateRange] = useState<DriverDateRange>(() => {
    if (pageFrom && pageTo) {
      return { preset: 'custom', from: pageFrom, to: pageTo };
    }
    return defaultDriverDateRange();
  });
  const [paymentTab, setPaymentTab] = useState<PaymentStatusTab>('all');
  const [selectedTrip, setSelectedTrip] = useState<TripFinancialAuditRow | null>(null);

  useEffect(() => {
    if (!open) return;
    setPaymentTab('all');
    setDateRange(defaultDriverDateRange());
  }, [open, driverRow?.driver_id]);

  const { data: walletDetail, isLoading: walletLoading, refetch: refetchWallet, isFetching: walletFetching } =
    useDriverWalletSsotDetail(open ? driverId : null);

  const { data: perDriverData, isLoading: perDriverLoading, refetch: refetchPerDriver, isFetching: perDriverFetching } =
    usePerDriverFinancialReconciliation({
      driverId: open ? driverId : null,
      filter,
      from: dateRange.from,
      to: dateRange.to,
      enabled: open && !!driverId,
    });

  const { data: tripRows = [], isLoading: tripsLoading, refetch: refetchTrips, isFetching: tripsFetching } =
    useDriverTripFinancialAudit({
      driverId: open ? driverId : null,
      filter,
      from: dateRange.from,
      to: dateRange.to,
      enabled: open && !!driverId,
    });

  const driver = walletDetail ?? driverRow;
  const perDriver = perDriverData?.finance_reconciliation_driver_ssot;

  const filteredTrips = useMemo(
    () => tripRows.filter((row) => matchesPaymentTab(row, paymentTab)),
    [tripRows, paymentTab],
  );

  // Display-only backend SSOT fields — no client-side settlement formulas.
  const customerRevenue = perDriver?.digital_net_customer_revenue_pence ?? null;
  const driverNet = perDriver?.driver_net_earnings_pence ?? null;
  const commissionNet = perDriver?.digital_onecab_net_commission_pence ?? null;
  const providerFee = perDriver?.digital_provider_processing_fee_pence ?? null;
  const variance = perDriver?.reconciliation_variance_pence ?? null;
  const paidOut = perDriver?.stripe_paid_out_total_pence ?? driver?.stripe_paid_out_total_pence ?? null;
  const eligiblePayout = perDriver?.eligible_payout_pence ?? perDriver?.driver_available_now_pence ?? null;
  const pendingBatch = perDriver?.included_in_payout_batch_pence ?? driver?.included_in_payout_batch_amount_pence ?? null;
  const walletBalance = perDriver?.driver_wallet_balance_pence ?? driver?.wallet_balance_pence ?? null;
  const remainingLiability = perDriver?.driver_remaining_liability_pence ?? null;

  const compareBalanced =
    (perDriver?.reconciliation_status ?? driver?.reconciliation_status) === 'BALANCED'
    && (variance == null || Math.abs(variance) <= 1);

  const payoutReasons = [
    ...(perDriver?.payout_blocked_reasons ?? []),
    ...(perDriver?.payout_warning_reasons ?? []),
    ...(driver?.reconciliation_reasons ?? []),
  ].filter(Boolean);

  const isRefreshing = walletFetching || perDriverFetching || tripsFetching;

  const refreshAll = () => {
    void refetchWallet();
    void refetchPerDriver();
    void refetchTrips();
  };

  const refreshDrawerTimeout = useCriticalButtonTimeout({
    action: 'admin_refresh_finance',
    isPending: isRefreshing,
    onTimeout: () => {
      refreshAll();
      toast.error(CRITICAL_BUTTON_TIMEOUT_MESSAGE);
    },
  });
  const showRefreshSpinner = refreshDrawerTimeout.showSpinner;

  const handleRefreshAll = () => {
    const perf = startAdminPerformanceStep({
      action_name: 'admin_refresh_finance',
      metadata: { surface: 'driver_drawer', driver_id: driverId ?? null },
    });
    void Promise.all([
      refetchWallet(),
      refetchPerDriver(),
      refetchTrips(),
    ]).then(
      () => perf.complete({ success: true }),
      (err) => perf.complete({
        success: false,
        error_code: err instanceof Error ? err.message : 'refresh_failed',
      }),
    );
  };

  const setPreset = (preset: DriverDateRangePreset) => {
    setDateRange(resolveDriverDateRange(preset));
  };

  if (!driverRow) return null;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className="fixed inset-y-0 right-0 left-auto h-full w-full max-w-5xl translate-x-0 translate-y-0 rounded-none border-l p-0 gap-0 overflow-hidden flex flex-col data-[state=open]:slide-in-from-right [&>button.absolute]:hidden"
        >
          <div className="border-b px-6 py-4 shrink-0 bg-background">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="text-xl font-semibold truncate">
                    {driverRow.driver_name ?? driverRow.driver_code ?? 'Driver'}
                  </h2>
                  {driverRow.driver_code ? (
                    <Badge variant="outline">{driverRow.driver_code}</Badge>
                  ) : null}
                  <Badge variant={compareBalanced ? 'default' : 'destructive'}>
                    {compareBalanced ? 'Balanced' : 'Mismatch'}
                  </Badge>
                </div>
                <div className="mt-2 grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-1 text-xs text-muted-foreground">
                  <span>Provider account: <span className="text-foreground font-mono">{driver?.connected_account_id ?? '—'}</span></span>
                  <span>Service area: <span className="text-foreground">{serviceAreaName ?? '—'}</span></span>
                  <span>Currency: <span className="text-foreground">{currencyCode.toUpperCase()}</span></span>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Button variant="outline" size="sm" onClick={handleRefreshAll} disabled={showRefreshSpinner}>
                  {showRefreshSpinner ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                  <span className="ml-1.5 hidden sm:inline">Refresh</span>
                </Button>
                <Button variant="ghost" size="icon" onClick={() => onOpenChange(false)}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground mt-2">
              Last synced {formatFinanceDateSafe(driver?.last_synced_at ?? lastSyncedAt, 'dd MMM yyyy HH:mm:ss')}
              {' · '}
              Read-only audit — capture, refund, and payout actions live on their SSOT pages.
            </p>
          </div>

          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
            <FinancialReconciliationRefreshBar
              badge={showRefreshSpinner ? 'REFRESHING' : ssotBadge}
              lastSyncedAt={driver?.last_synced_at ?? lastSyncedAt}
              isRefreshing={showRefreshSpinner}
              readOnly={readOnly}
              onRefresh={handleRefreshAll}
            />

            <div className="flex flex-wrap items-center gap-2">
              {(['today', '7d', '30d', 'custom'] as DriverDateRangePreset[]).map((preset) => (
                <Button
                  key={preset}
                  variant={dateRange.preset === preset ? 'default' : 'outline'}
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() => setPreset(preset)}
                >
                  {preset === 'today' ? 'Today' : preset === '7d' ? '7 days' : preset === '30d' ? '30 days' : 'Custom'}
                </Button>
              ))}
              <Input
                type="date"
                value={dateRange.from}
                onChange={(e) => setDateRange({ preset: 'custom', from: e.target.value, to: dateRange.to })}
                className="w-[140px] h-8 text-xs"
              />
              <span className="text-muted-foreground text-xs">→</span>
              <Input
                type="date"
                value={dateRange.to}
                onChange={(e) => setDateRange({ preset: 'custom', from: dateRange.from, to: e.target.value })}
                className="w-[140px] h-8 text-xs"
              />
            </div>

            {(walletLoading || perDriverLoading || tripsLoading) && !tripRows.length ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading driver finance data…
              </div>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">
                  Overview for <span className="font-medium text-foreground">{driverDateRangeLabel(dateRange)}</span>
                  {' · '}
                  {tripRows.length} trip{tripRows.length === 1 ? '' : 's'}
                  {' · '}
                  backend SSOT totals
                </p>
                <div className="grid gap-3 grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
                  <OverviewMetric label="Customer revenue (digital)" value={fmt(customerRevenue)} hint="Backend digital_net_customer_revenue" />
                  <OverviewMetric label="Driver net earnings" value={fmt(driverNet)} />
                  <OverviewMetric label="ONECAB net commission" value={fmt(commissionNet)} />
                  <OverviewMetric
                    label="Provider fee"
                    value={providerFee == null ? 'Pending provider fee' : fmt(providerFee)}
                  />
                  <OverviewMetric label="Reconciliation variance" value={fmt(variance)} />
                  <OverviewMetric label="Pending settlement" value={fmt(pendingBatch)} hint="In payout batch" />
                  <OverviewMetric label="Available for payout" value={fmt(eligiblePayout)} hint="Finance-cleared payable" />
                  <OverviewMetric label="Paid out" value={fmt(paidOut)} hint="Provider transfers" />
                  <OverviewMetric label="Wallet balance" value={fmt(walletBalance)} />
                  <OverviewMetric label="Remaining liability" value={fmt(remainingLiability)} />
                  <OverviewMetric
                    label="Reconciliation"
                    value={perDriver?.reconciliation_status ?? driver?.reconciliation_status ?? '—'}
                  />
                </div>
              </>
            )}

            <Card>
              <CardContent className="pt-4 pb-4">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-sm font-medium">ONECAB ledger vs Provider</p>
                  <Badge variant={compareBalanced ? 'default' : 'destructive'}>
                    {compareBalanced ? 'Balanced' : 'Mismatch'}
                  </Badge>
                </div>
                <div className="grid grid-cols-[1fr_auto_auto_auto] gap-2 text-[10px] uppercase text-muted-foreground mb-1 px-0">
                  <span />
                  <span className="text-right">ONECAB</span>
                  <span className="text-right">Compare</span>
                  <span className="text-right">Variance</span>
                </div>
                <CompareRow
                  label="Driver net vs remaining liability"
                  left={driverNet}
                  right={remainingLiability}
                  diff={
                    driverNet == null || remainingLiability == null
                      ? null
                      : driverNet - remainingLiability
                  }
                  fmt={(p) => fmt(p)}
                />
                <CompareRow
                  label="Backend reconciliation variance"
                  left={variance}
                  right={0}
                  diff={variance}
                  fmt={(p) => fmt(p)}
                />
                <CompareRow
                  label="Payout batch vs paid out"
                  left={pendingBatch}
                  right={paidOut}
                  diff={
                    pendingBatch == null && paidOut == null
                      ? null
                      : (pendingBatch ?? 0) - (paidOut ?? 0)
                  }
                  fmt={(p) => fmt(p)}
                />
                {!compareBalanced && payoutReasons.length > 0 ? (
                  <p className="text-xs text-destructive mt-3">{payoutReasons[0]}</p>
                ) : null}
              </CardContent>
            </Card>

            {((eligiblePayout == null || eligiblePayout <= 0) || payoutReasons.length > 0) && (
              <Card className="border-amber-500/30 bg-amber-500/5">
                <CardContent className="pt-4 pb-4">
                  <p className="text-sm font-medium">Why payout may not be scheduled</p>
                  <ul className="mt-2 space-y-1 text-xs text-muted-foreground list-disc pl-4">
                    {(eligiblePayout == null || eligiblePayout <= 0) && driver?.stripe_connect_available_pence === 0 ? (
                      <li>Platform Provider available is {fmt(0)} — awaiting Provider settlement</li>
                    ) : null}
                    {(pendingBatch == null || pendingBatch <= 0) && eligiblePayout != null && eligiblePayout > 0 ? (
                      <li>Payout batch not yet created for cleared earnings</li>
                    ) : null}
                    {payoutReasons.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                    {!payoutReasons.length && (eligiblePayout == null || eligiblePayout <= 0) ? (
                      <li>No finance-cleared balance payable in this period</li>
                    ) : null}
                  </ul>
                </CardContent>
              </Card>
            )}

            <Tabs value={paymentTab} onValueChange={(v) => setPaymentTab(v as PaymentStatusTab)}>
              <TabsList className="flex flex-wrap h-auto gap-1">
                <TabsTrigger value="all">All ({tripRows.length})</TabsTrigger>
                <TabsTrigger value="succeeded">Succeeded</TabsTrigger>
                <TabsTrigger value="refunded">Refunded</TabsTrigger>
                <TabsTrigger value="failed">Failed</TabsTrigger>
                <TabsTrigger value="uncaptured">Uncaptured</TabsTrigger>
                <TabsTrigger value="pending_settlement">Pending settlement</TabsTrigger>
                <TabsTrigger value="paid_out">Paid out</TabsTrigger>
              </TabsList>
            </Tabs>

            <div className="rounded-md border overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Trip</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead className="text-right">Customer paid</TableHead>
                    <TableHead>Provider status</TableHead>
                    <TableHead>Payment method</TableHead>
                    <TableHead>Refund status</TableHead>
                    <TableHead className="text-right">Driver net</TableHead>
                    <TableHead className="text-right">ONECAB commission</TableHead>
                    <TableHead>Payout status</TableHead>
                    <TableHead>Reconciliation</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredTrips.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={12} className="text-center text-muted-foreground py-10">
                        No trips in {driverDateRangeLabel(dateRange)}{paymentTab !== 'all' ? ` (${paymentTab})` : ''}.
                      </TableCell>
                    </TableRow>
                  ) : null}
                  {filteredTrips.map((row) => {
                    const recon = row.reconciliation_status;
                    return (
                      <TableRow key={row.trip_id} className="text-xs">
                        <TableCell className="whitespace-nowrap">
                          {formatFinanceDateSafe(row.date ?? row.created_at, 'dd MMM HH:mm')}
                        </TableCell>
                        <TableCell className="font-mono">{row.trip_code ?? row.trip_id.slice(0, 8)}</TableCell>
                        <TableCell>{row.customer_name ?? '—'}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {fmt(row.captured_pence ?? row.customer_paid_pence)}
                        </TableCell>
                        <TableCell>{providerLabel(row)}</TableCell>
                        <TableCell>
                          {row.payment_method ?? '—'}
                        </TableCell>
                        <TableCell>
                          {row.refunded_pence != null && row.refunded_pence > 0
                            ? fmt(row.refunded_pence)
                            : '—'}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{fmt(row.driver_net_pence)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmt(row.onecab_gross_commission_pence)}</TableCell>
                        <TableCell>{row.driver_payout?.label ?? '—'}</TableCell>
                        <TableCell>
                          {recon ? (
                            <Badge variant={reconciliationBadgeVariant(recon.tone)} className="text-[10px]">
                              {recon.label}
                            </Badge>
                          ) : '—'}
                        </TableCell>
                        <TableCell>
                          <DriverDrawerTripRowActions
                            row={row}
                            driverId={driverId!}
                            onViewTrip={setSelectedTrip}
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>

            <div className="flex flex-wrap gap-2 pb-4">
              <Button variant="outline" size="sm" asChild>
                <Link to={driverWalletLedgerUrl(driverId!, 'ledger')}>
                  View full ledger
                  <ExternalLink className="h-3 w-3 ml-1" />
                </Link>
              </Button>
              <Button variant="outline" size="sm" asChild>
                <Link to={payoutLedgerUrl({ driverId: driverId! })}>
                  Payout Ledger
                  <ExternalLink className="h-3 w-3 ml-1" />
                </Link>
              </Button>
              <Button variant="outline" size="sm" asChild>
                <Link to={paymentSessionsUrl()}>
                  Payment Sessions
                  <ExternalLink className="h-3 w-3 ml-1" />
                </Link>
              </Button>
              <Button variant="outline" size="sm" asChild>
                <Link to={`/trip-history?driverId=${driverId}`}>
                  Trip history
                  <ExternalLink className="h-3 w-3 ml-1" />
                </Link>
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!selectedTrip} onOpenChange={(o) => !o && setSelectedTrip(null)}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          {selectedTrip ? (
            <>
              <div className="space-y-1">
                <h3 className="text-lg font-semibold">
                  {selectedTrip.trip_code ?? selectedTrip.trip_id.slice(0, 8)}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {formatFinanceDateSafe(selectedTrip.date ?? selectedTrip.created_at, 'PPp')}
                  {' · '}
                  {selectedTrip.customer_name ?? 'Customer'}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs rounded-md border p-3 bg-muted/20">
                <div><span className="text-muted-foreground">Provider captured:</span> {fmt(selectedTrip.captured_pence)}</div>
                <div><span className="text-muted-foreground">Customer payable:</span> {fmt(selectedTrip.settlement_total_pence ?? selectedTrip.customer_paid_pence)}</div>
                <div><span className="text-muted-foreground">Refunded:</span> {fmt(selectedTrip.refunded_pence)}</div>
                <div><span className="text-muted-foreground">Variance:</span> {fmt(selectedTrip.variance_pence)}</div>
                <div><span className="text-muted-foreground">Driver net:</span> {fmt(selectedTrip.driver_net_pence)}</div>
                <div><span className="text-muted-foreground">Commission:</span> {fmt(selectedTrip.onecab_gross_commission_pence)}</div>
                <div><span className="text-muted-foreground">Provider:</span> {providerLabel(selectedTrip)}</div>
                <div><span className="text-muted-foreground">Payout:</span> {selectedTrip.driver_payout?.label ?? '—'}</div>
              </div>
              <p className="text-xs text-muted-foreground">
                Read-only comparison. Capture, release, and refund run on Payment Sessions.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" asChild>
                  <Link to={paymentSessionsUrl({ tripId: selectedTrip.trip_id })}>
                    Open Payment Sessions
                  </Link>
                </Button>
                <Button variant="outline" size="sm" asChild>
                  <Link to={driverWalletLedgerUrl(driverId!, 'ledger')}>
                    Open Driver Wallet
                  </Link>
                </Button>
                <Button variant="outline" size="sm" asChild>
                  <Link to={payoutLedgerUrl({ driverId: driverId! })}>
                    Open Payout Ledger
                  </Link>
                </Button>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
