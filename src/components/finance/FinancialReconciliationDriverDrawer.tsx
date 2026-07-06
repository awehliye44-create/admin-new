import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ExternalLink,
  Loader2,
  RefreshCw,
  X,
} from 'lucide-react';
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
import { FinanceRecoveryPanel } from '@/components/payment/FinanceRecoveryPanel';
import type { InitialPaymentAction } from '@/components/payment/PaymentControlsCard';
import {
  DriverDrawerTripRowActions,
  type DriverDrawerTripAction,
} from '@/components/finance/DriverDrawerTripRowActions';
import { FinancialReconciliationRefreshBar } from '@/components/finance/FinancialReconciliationRefreshBar';
import type { ServiceAreaFinanceSelection } from '@/components/finance/ServiceAreaFinanceFilter';
import type { FinanceMoneyFormat } from '@/hooks/useFinanceReconciliationMoney';
import type { TripFinancialAuditRow } from '@/hooks/useFinanceReconciliation';
import type { DriverWalletSsotRow } from '@/hooks/useDriverWalletSsot';
import type { FinanceDataSourceBadge } from '@/hooks/useFinancialReconciliationSSOT';
import { useDriverWalletSsotDetail } from '@/hooks/useDriverWalletSsot';
import { usePerDriverFinancialReconciliation } from '@/hooks/usePerDriverFinancialReconciliation';
import { useDriverTripFinancialAudit } from '@/hooks/useDriverTripFinancialAudit';
import { useFinanceActionPermission } from '@/hooks/useFinanceActionPermission';
import { formatFinanceDateSafe } from '@/lib/financialReconciliationGuards';
import {
  defaultDriverDateRange,
  driverDateRangeLabel,
  resolveDriverDateRange,
  type DriverDateRange,
  type DriverDateRangePreset,
} from '@/lib/financialReconciliationDriverDateRange';
import { driverWalletLedgerUrl } from '@/lib/driverWalletLedgerRoutes';
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
  const captured = row.captured_pence ?? 0;
  const refunded = row.refunded_pence ?? 0;
  const provider = providerLabel(row).toLowerCase();
  const payoutLabel = (row.driver_payout?.label ?? '').toLowerCase();

  if (tab === 'succeeded') {
    return digital && captured > 0 && refunded < captured;
  }
  if (tab === 'refunded') return refunded > 0;
  if (tab === 'failed') {
    if (!digital) return false;
    return provider.includes('failed') || provider.includes('canceled') || provider.includes('cancelled');
  }
  if (tab === 'uncaptured') {
    return digital && captured <= 0 && (
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
  left: number;
  right: number;
  diff: number;
  fmt: (p: number) => string;
}) {
  const matched = Math.abs(diff) <= 1;
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
  const fmt = (p: number | null | undefined) => money.fmt(p, currencyCode);

  const [dateRange, setDateRange] = useState<DriverDateRange>(() => {
    if (pageFrom && pageTo) {
      return { preset: 'custom', from: pageFrom, to: pageTo };
    }
    return defaultDriverDateRange();
  });
  const [paymentTab, setPaymentTab] = useState<PaymentStatusTab>('all');
  const [selectedTrip, setSelectedTrip] = useState<TripFinancialAuditRow | null>(null);
  const [selectedTripPaymentAction, setSelectedTripPaymentAction] = useState<InitialPaymentAction | null>(null);
  const { canUseFinanceActions } = useFinanceActionPermission();
  const actionsDisabled = readOnly || ssotBadge !== 'LIVE' || !canUseFinanceActions;

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
  const connectAccount = connectStatus?.connect_accounts.find((a) => a.driver_id === driverId) ?? null;

  const digitalTrips = useMemo(
    () => tripRows.filter((r) => isDigitalPayment(r.payment_method)),
    [tripRows],
  );

  const overview = useMemo(() => {
    let customerPayable = 0;
    let stripeCaptured = 0;
    let refunded = 0;
    let driverNet = 0;
    let commission = 0;
    let shortfall = 0;
    for (const row of digitalTrips) {
      const payable = row.settlement_total_pence ?? row.customer_paid_pence ?? row.final_fare_pence ?? 0;
      const captured = row.captured_pence ?? 0;
      customerPayable += payable;
      stripeCaptured += captured;
      refunded += row.refunded_pence ?? 0;
      driverNet += row.driver_net_pence ?? 0;
      commission += row.onecab_gross_commission_pence ?? 0;
      if (payable > captured) shortfall += payable - captured;
    }
    return { customerPayable, stripeCaptured, refunded, driverNet, commission, shortfall };
  }, [digitalTrips]);

  const filteredTrips = useMemo(
    () => tripRows.filter((row) => matchesPaymentTab(row, paymentTab)),
    [tripRows, paymentTab],
  );

  const walletCredited = perDriver?.driver_net_earnings_pence ?? overview.driverNet;
  const stripeCapturedTotal = overview.stripeCaptured;
  const customerPayableTotal = overview.customerPayable;
  const paidOut = perDriver?.stripe_paid_out_total_pence ?? driver?.stripe_paid_out_total_pence ?? 0;
  const eligiblePayout = perDriver?.eligible_payout_pence ?? perDriver?.driver_available_now_pence ?? 0;
  const pendingBatch = perDriver?.included_in_payout_batch_pence ?? driver?.included_in_payout_batch_amount_pence ?? 0;
  const walletBalance = perDriver?.driver_wallet_balance_pence ?? driver?.wallet_balance_pence ?? 0;

  const compareBalanced =
    Math.abs(customerPayableTotal - stripeCapturedTotal) <= 1
    && Math.abs((perDriver?.driver_net_earnings_pence ?? overview.driverNet) - walletCredited) <= 1
    && Math.abs(pendingBatch) <= 1
    && (perDriver?.reconciliation_status ?? driver?.reconciliation_status) === 'BALANCED';

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

  const setPreset = (preset: DriverDateRangePreset) => {
    setDateRange(resolveDriverDateRange(preset));
  };

  const handleTripAction = (row: TripFinancialAuditRow, action: DriverDrawerTripAction) => {
    setSelectedTrip(row);
    if (action === 'refund') setSelectedTripPaymentAction('refund');
    else if (action === 'partial_refund') setSelectedTripPaymentAction('partial_refund');
    else setSelectedTripPaymentAction(null);
  };

  const closeTripDialog = () => {
    setSelectedTrip(null);
    setSelectedTripPaymentAction(null);
  };



  if (!driverRow) return null;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className="fixed inset-y-0 right-0 left-auto h-full w-full max-w-5xl translate-x-0 translate-y-0 rounded-none border-l p-0 gap-0 overflow-hidden flex flex-col data-[state=open]:slide-in-from-right [&>button.absolute]:hidden"
        >
          {/* Header */}
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
                <Button variant="outline" size="sm" onClick={refreshAll} disabled={isRefreshing}>
                  {isRefreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                  <span className="ml-1.5 hidden sm:inline">Refresh</span>
                </Button>
                <Button variant="ghost" size="icon" onClick={() => onOpenChange(false)}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground mt-2">
              Last synced {formatFinanceDateSafe(driver?.last_synced_at ?? lastSyncedAt, 'dd MMM yyyy HH:mm:ss')}
            </p>
          </div>

          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
            <FinancialReconciliationRefreshBar
              badge={isRefreshing ? 'REFRESHING' : ssotBadge}
              lastSyncedAt={driver?.last_synced_at ?? lastSyncedAt}
              isRefreshing={isRefreshing}
              readOnly={readOnly}
              onRefresh={refreshAll}
              label={`Driver payments — ${driverDateRangeLabel(dateRange)} · digital trips only`}
            />

            {/* Date range */}
            <div className="flex flex-wrap items-center gap-2">
              {(['today', 'current_week', 'last_week', 'current_month'] as const).map((preset) => (
                <Button
                  key={preset}
                  size="sm"
                  variant={dateRange.preset === preset ? 'default' : 'outline'}
                  onClick={() => setPreset(preset)}
                >
                  {preset === 'today' ? 'Today' : preset === 'current_week' ? 'Current week' : preset === 'last_week' ? 'Last week' : 'Current month'}
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

            {/* Overview cards */}
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
                  {digitalTrips.length} digital trip{digitalTrips.length === 1 ? '' : 's'}
                </p>
                <div className="grid gap-3 grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
                  <OverviewMetric label="Provider captured" value={fmt(overview.stripeCaptured)} hint="Customer paid (actual capture)" />
                  <OverviewMetric label="Customer payable" value={fmt(overview.customerPayable)} hint="Expected fare (trip SSOT)" />
                  {overview.shortfall > 0 ? (
                    <OverviewMetric label="Provider capture shortfall" value={fmt(overview.shortfall)} hint="Digital trips only · payable − captured" />
                  ) : null}
                  <OverviewMetric label="Refunded" value={fmt(overview.refunded)} />
                  <OverviewMetric label="Driver net earnings" value={fmt(overview.driverNet)} />
                  <OverviewMetric label="ONECAB commission" value={fmt(overview.commission)} />
                  <OverviewMetric label="Pending settlement" value={fmt(pendingBatch)} hint="In payout batch" />
                  <OverviewMetric label="Available for payout" value={fmt(eligiblePayout)} hint="Finance-cleared payable" />
                  <OverviewMetric label="Paid out" value={fmt(paidOut)} hint="Provider transfers" />
                  <OverviewMetric label="Wallet balance" value={fmt(walletBalance)} />
                  <OverviewMetric
                    label="Reconciliation"
                    value={perDriver?.reconciliation_status ?? driver?.reconciliation_status ?? '—'}
                  />
                </div>
              </>
            )}

            {/* Compare with Provider */}
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
                  <span className="text-right">Provider / Ledger</span>
                  <span className="text-right">Diff</span>
                </div>
                <CompareRow
                  label="ONECAB customer paid vs Provider captured"
                  left={stripeCapturedTotal}
                  right={perDriver?.digital_net_customer_revenue_pence ?? stripeCapturedTotal}
                  diff={stripeCapturedTotal - (perDriver?.digital_net_customer_revenue_pence ?? stripeCapturedTotal)}
                  fmt={(p) => fmt(p)}
                />
                <CompareRow
                  label="ONECAB driver net vs wallet credited"
                  left={perDriver?.driver_net_earnings_pence ?? overview.driverNet}
                  right={walletCredited}
                  diff={(perDriver?.driver_net_earnings_pence ?? overview.driverNet) - walletCredited}
                  fmt={(p) => fmt(p)}
                />
                <CompareRow
                  label="Payout item vs Provider transfer/payout"
                  left={pendingBatch + paidOut}
                  right={paidOut}
                  diff={pendingBatch}
                  fmt={(p) => fmt(p)}
                />
                {!compareBalanced && payoutReasons.length > 0 ? (
                  <p className="text-xs text-destructive mt-3">{payoutReasons[0]}</p>
                ) : null}
              </CardContent>
            </Card>

            {/* Pending / settlement explanation */}
            {(eligiblePayout <= 0 || payoutReasons.length > 0) && (
              <Card className="border-amber-500/30 bg-amber-500/5">
                <CardContent className="pt-4 pb-4">
                  <p className="text-sm font-medium">Why payout may not be scheduled</p>
                  <ul className="mt-2 space-y-1 text-xs text-muted-foreground list-disc pl-4">
                    {eligiblePayout <= 0 && driver?.stripe_connect_available_pence === 0 ? (
                      <li>Platform Provider available is {fmt(0)} — awaiting Provider settlement</li>
                    ) : null}
                    {pendingBatch <= 0 && eligiblePayout > 0 ? (
                      <li>Payout batch not yet created for cleared earnings</li>
                    ) : null}
                    {payoutReasons.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                    {!payoutReasons.length && eligiblePayout <= 0 ? (
                      <li>No finance-cleared balance payable in this period</li>
                    ) : null}
                  </ul>
                </CardContent>
              </Card>
            )}

            {/* Payment status tabs */}
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

            {/* Payments table */}
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
                          {(row.refunded_pence ?? 0) > 0 ? fmt(row.refunded_pence) : '—'}
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
                            actionsDisabled={actionsDisabled}
                            onTripAction={handleTripAction}
                            onSynced={refreshAll}
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
                <Link to={`/trip-history?driverId=${driverId}`}>
                  Trip history
                  <ExternalLink className="h-3 w-3 ml-1" />
                </Link>
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Trip detail nested dialog */}
      <Dialog open={!!selectedTrip} onOpenChange={(o) => !o && closeTripDialog()}>
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
                <div><span className="text-muted-foreground">Shortfall:</span> {fmt(Math.max(0, (selectedTrip.settlement_total_pence ?? selectedTrip.customer_paid_pence ?? 0) - (selectedTrip.captured_pence ?? 0)))}</div>
                <div><span className="text-muted-foreground">Driver net:</span> {fmt(selectedTrip.driver_net_pence)}</div>
                <div><span className="text-muted-foreground">Commission:</span> {fmt(selectedTrip.onecab_gross_commission_pence)}</div>
                <div><span className="text-muted-foreground">Provider:</span> {providerLabel(selectedTrip)}</div>
                <div><span className="text-muted-foreground">Payout:</span> {selectedTrip.driver_payout?.label ?? '—'}</div>
              </div>
              <FinanceRecoveryPanel
                  tripId={selectedTrip.trip_id}
                  tripCode={selectedTrip.trip_code}
                  source="financial-reconciliation"
                  variant="finance"
                  readOnly={actionsDisabled}
                  initialPaymentAction={selectedTripPaymentAction}
                  onInitialActionConsumed={() => setSelectedTripPaymentAction(null)}
                  onActionComplete={() => {
                    refreshAll();
                    closeTripDialog();
                  }}
                />
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
