import { useMemo } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { FinanceMoneyFormat } from '@/hooks/useFinanceReconciliationMoney';
import type { FinanceReconciliationSummary } from '@/hooks/useFinanceReconciliation';
import type { StripePaymentIntentAuditRow, TripFinancialAuditRow } from '@/hooks/useFinanceReconciliation';
import type { ServiceAreaFinanceSelection } from '@/components/finance/ServiceAreaFinanceFilter';
import { FinancialReconciliationPlatformPayoutOps } from '@/components/finance/FinancialReconciliationPlatformPayoutOps';
import { DriverWalletLedgerLink } from '@/components/finance/DriverWalletLedgerLink';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { formatFinanceDateSafe, formatProviderHealthLabel } from '@/lib/financialReconciliationGuards';
import { Button } from '@/components/ui/button';
import { FinancialReconciliationRefreshBar } from '@/components/finance/FinancialReconciliationRefreshBar';
import type { FinanceDataSourceBadge } from '@/hooks/useFinancialReconciliationSSOT';

function statusChipVariant(label: string | null | undefined): 'default' | 'secondary' | 'destructive' | 'outline' {
  const l = String(label ?? '').toLowerCase();
  if (l.includes('healthy') || l.includes('matched') || l.includes('paid')) return 'default';
  if (l.includes('fail') || l.includes('mismatch')) return 'destructive';
  return 'secondary';
}

function isConnectReconciliationIssue(status: string | null | undefined): boolean {
  const s = String(status ?? '').toLowerCase();
  if (!s) return false;
  return s !== 'matched' && s !== 'healthy';
}

function isTransferMismatch(m: { kind?: string | null; message?: string | null }): boolean {
  const kind = String(m.kind ?? '').toLowerCase();
  const message = String(m.message ?? '').toLowerCase();
  return kind.includes('transfer') || message.includes('transfer');
}

export function FinancialReconciliationStripeTab({
  summary,
  money,
  serviceFilter,
  periodFrom,
  periodTo,
  periodLabel,
  auditRows = [],
  paymentIntents = [],
  stripeBalanceError = null,
  ssotStatus = 'LIVE',
  ssotBadge,
  lastSyncedAt = null,
  snapshotSavedAt = null,
  readOnly = false,
  onRefreshStripe,
  isRefreshingStripe = false,
}: {
  summary: FinanceReconciliationSummary | null | undefined;
  money: FinanceMoneyFormat;
  serviceFilter: ServiceAreaFinanceSelection;
  periodFrom?: string;
  periodTo?: string;
  periodLabel?: string;
  auditRows?: TripFinancialAuditRow[];
  paymentIntents?: StripePaymentIntentAuditRow[];
  stripeBalanceError?: string | null;
  ssotStatus?: FinanceDataSourceBadge;
  ssotBadge?: FinanceDataSourceBadge;
  lastSyncedAt?: string | null;
  snapshotSavedAt?: string | null;
  readOnly?: boolean;
  onRefreshStripe?: () => void;
  isRefreshingStripe?: boolean;
}) {
  const fmt = money.fmt;
  const platformFmt = money.fmtPlatformStripe;
  const scopeCurrency = money.currencyCode ?? '';
  const mm = summary?.money_movement;
  const provider = summary?.provider_money;
  const fmtNullable = (p: number | null | undefined) => (p == null ? '—' : fmt(p));
  const connectFmt = (p: number | null | undefined, currencyCode?: string | null) =>
    fmt(p ?? 0, currencyCode ?? scopeCurrency);

  const charges = mm?.collected_fees ?? [];
  const transfers = mm?.transfers ?? [];
  const connectAccounts = mm?.connect_accounts ?? [];
  const payouts = mm?.payouts ?? [];
  const transferFailures = (mm?.mismatches ?? []).filter(isTransferMismatch);

  const connectReconciliationQueue = useMemo(
    () => connectAccounts.filter((a) => isConnectReconciliationIssue(a.reconciliation_status) || a.duplicate_connect_account),
    [connectAccounts],
  );
  const connectAccountsAll = connectAccounts;
  const moneyMovementTimedOut = stripeBalanceError === 'connect_money_movement_timeout';
  const displayBadge = ssotBadge ?? ssotStatus;
  const snapshotSavedLabel = snapshotSavedAt
    ? formatFinanceDateSafe(snapshotSavedAt, 'dd MMM yyyy HH:mm')
    : null;

  const platformPayoutStats = useMemo(() => {
    const byStatus = new Map<string, number>();
    let totalPence = 0;
    for (const p of payouts) {
      const status = String(p.payout_status ?? 'unknown').toLowerCase();
      byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
      totalPence += Number(p.payout_amount_pence ?? 0);
    }
    return {
      count: payouts.length,
      totalPence,
      byStatus: Array.from(byStatus.entries()).sort((a, b) => a[0].localeCompare(b[0])),
      mismatchCount: payouts.filter((p) => isConnectReconciliationIssue(p.reconciliation_status)).length,
    };
  }, [payouts]);

  const resolvedPaymentIntents = useMemo(() => {
    if (paymentIntents.length > 0) return paymentIntents;
    const seen = new Set<string>();
    return auditRows
      .filter((row) => {
        const pi = row.stripe_payment_intent_id?.trim();
        if (!pi || seen.has(pi)) return false;
        seen.add(pi);
        const method = (row.payment_method ?? '').toLowerCase();
        return method !== 'cash';
      })
      .map((row) => ({
        payment_intent_id: row.stripe_payment_intent_id!,
        trip_id: row.trip_id,
        trip_code: row.trip_code,
        driver_id: row.driver_id ?? null,
        driver_name: row.driver_name,
        customer_name: row.customer_name,
        captured_pence: row.captured_pence,
        status: row.provider?.label ?? '—',
        date: row.date,
      }));
  }, [paymentIntents, auditRows]);

  const lastPayoutByDriver = useMemo(() => {
    const map = new Map<string, { amount_pence: number; initiated_at: string | null; status: string }>();
    for (const p of payouts) {
      const existing = map.get(p.driver_id);
      const initiated = p.payout_initiated_at ?? '';
      if (!existing || initiated > (existing.initiated_at ?? '')) {
        map.set(p.driver_id, {
          amount_pence: p.payout_amount_pence,
          initiated_at: p.payout_initiated_at,
          status: p.payout_status,
        });
      }
    }
    return map;
  }, [payouts]);

  return (
    <div className="space-y-4">
      <FinancialReconciliationRefreshBar
        badge={isRefreshingStripe ? 'REFRESHING' : displayBadge}
        lastSyncedAt={lastSyncedAt ?? mm?.last_synced_at ?? null}
        isRefreshing={isRefreshingStripe}
        readOnly={readOnly}
        onRefresh={onRefreshStripe}
        label="Stripe Connect balances and money movement"
      />

      {ssotStatus === 'DEGRADED_SNAPSHOT' && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Stripe balances may be stale</AlertTitle>
          <AlertDescription>
            {snapshotSavedLabel
              ? `Showing cached snapshot from ${snapshotSavedLabel}. Refresh when live SSOT is available.`
              : 'Showing cached snapshot. Refresh when live SSOT is available.'}
          </AlertDescription>
        </Alert>
      )}

      {moneyMovementTimedOut && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Connect money movement timed out</AlertTitle>
          <AlertDescription>
            Stripe Connect account balances could not be loaded within 25 seconds. Connect Accounts and
            payout rows below may be incomplete — click Refresh to retry.
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2">
        {onRefreshStripe && (
          <Button
            variant="outline"
            size="sm"
            onClick={onRefreshStripe}
            disabled={readOnly || isRefreshingStripe}
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${isRefreshingStripe ? 'animate-spin' : ''}`} />
            Refresh Stripe now
          </Button>
        )}
      </div>

      <FinancialReconciliationPlatformPayoutOps
        serviceFilter={serviceFilter}
        currencyCode={scopeCurrency}
        periodFrom={periodFrom}
        periodTo={periodTo}
        periodLabel={periodLabel}
        readOnly={readOnly}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              Platform Stripe balance{scopeCurrency ? ` (${scopeCurrency})` : ''}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-4">
            <div>
              <p className="text-xs text-muted-foreground">Available</p>
              <p className="text-sm font-medium mt-1">{platformFmt(provider?.provider_available_balance_pence ?? 0)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Pending</p>
              <p className="text-sm font-medium mt-1">{platformFmt(provider?.provider_pending_balance_pence ?? 0)}</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Webhook health</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-4">
            <div>
              <p className="text-xs text-muted-foreground">Status</p>
              <Badge variant={statusChipVariant(provider?.provider_health_status)} className="mt-1">
                {formatProviderHealthLabel(provider?.provider_health_status, isRefreshingStripe)}
              </Badge>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Last webhook received</p>
              <p className="text-sm font-medium mt-1">
                {formatFinanceDateSafe(provider?.last_webhook_received_at, 'dd MMM yyyy HH:mm')}
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Stripe sync status</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div>
              <p className="text-xs text-muted-foreground">Money movement last synced</p>
              <p className="text-sm font-medium mt-1">
                {mm?.last_synced_at
                  ? formatFinanceDateSafe(mm.last_synced_at, 'dd MMM yyyy HH:mm')
                  : 'Not synced'}
              </p>
            </div>
            <p className="text-xs text-muted-foreground">
              Connect accounts in scope: {connectAccounts.length}
              {connectReconciliationQueue.length > 0
                ? ` · ${connectReconciliationQueue.length} need reconciliation`
                : ' · all balanced'}
            </p>
          </CardContent>
        </Card>

        <Card className={stripeBalanceError ? 'border-destructive/40' : undefined}>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Stripe API errors</CardTitle>
          </CardHeader>
          <CardContent>
            {stripeBalanceError ? (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>Stripe balance fetch failed</AlertTitle>
                <AlertDescription className="text-xs font-mono">{stripeBalanceError}</AlertDescription>
              </Alert>
            ) : (
              <p className="text-sm text-muted-foreground">No Stripe API errors in the latest reconciliation load.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Platform weekly payouts (aggregate)</CardTitle>
          <p className="text-sm text-muted-foreground">
            Platform-scope totals only. Per-driver bank payout history lives on Driver Wallet Ledger → Stripe.
          </p>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-6">
          <div>
            <p className="text-xs text-muted-foreground">Connect bank payouts in period</p>
            <p className="text-lg font-semibold">{platformPayoutStats.count}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Total paid to banks</p>
            <p className="text-lg font-semibold">{fmt(platformPayoutStats.totalPence)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Reconciliation issues</p>
            <p className="text-lg font-semibold">{platformPayoutStats.mismatchCount}</p>
          </div>
          {platformPayoutStats.byStatus.map(([status, count]) => (
            <div key={status}>
              <p className="text-xs text-muted-foreground capitalize">{status}</p>
              <p className="text-lg font-semibold">{count}</p>
            </div>
          ))}
        </CardContent>
      </Card>

      <Tabs defaultValue="charges">
        <TabsList className="flex flex-wrap h-auto gap-1">
          <TabsTrigger value="charges">Charges ({charges.length})</TabsTrigger>
          <TabsTrigger value="payment-intents">Payment Intents ({resolvedPaymentIntents.length})</TabsTrigger>
          <TabsTrigger value="transfers">Transfers ({transfers.length})</TabsTrigger>
          <TabsTrigger value="connect">Connect Accounts ({connectAccountsAll.length})</TabsTrigger>
          <TabsTrigger value="payouts">Payouts ({payouts.length})</TabsTrigger>
          <TabsTrigger value="transfer-failures">Transfer failures ({transferFailures.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="charges" className="mt-4">
          {charges.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">No charge / application fee records in period.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Charge ID</TableHead>
                  <TableHead>Driver</TableHead>
                  <TableHead>Trip</TableHead>
                  <TableHead className="text-right">Stripe application fee</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {charges.map((c) => (
                  <TableRow key={`${c.charge_id}-${c.trip_id}`}>
                    <TableCell className="font-mono text-xs">{c.charge_id ?? '—'}</TableCell>
                    <TableCell>
                      <DriverWalletLedgerLink driverId={c.driver_id} tab="stripe">
                        {c.driver_name}
                      </DriverWalletLedgerLink>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{c.trip_id?.slice(0, 8) ?? '—'}</TableCell>
                    <TableCell className="text-right">{fmt(c.amount_pence)}</TableCell>
                    <TableCell className="text-xs">{formatFinanceDateSafe(c.created_at)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TabsContent>

        <TabsContent value="payment-intents" className="mt-4">
          <div className="grid gap-3 sm:grid-cols-3 mb-4">
            <Card><CardContent className="pt-4"><p className="text-xs text-muted-foreground">Net card revenue</p><p className="text-lg font-semibold">{fmtNullable(summary?.customer_revenue?.net_card_revenue_pence)}</p></CardContent></Card>
            <Card><CardContent className="pt-4"><p className="text-xs text-muted-foreground">Refunded</p><p className="text-lg font-semibold">{fmtNullable(summary?.customer_revenue?.refunded_amount_pence)}</p></CardContent></Card>
            <Card><CardContent className="pt-4"><p className="text-xs text-muted-foreground">Pending Stripe confirmation</p><p className="text-lg font-semibold">{fmtNullable(summary?.pending_stripe_confirmation?.expected_revenue_pence)}</p></CardContent></Card>
          </div>
          {resolvedPaymentIntents.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">No card payment intents in selected period.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Payment Intent</TableHead>
                  <TableHead>Trip</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Driver</TableHead>
                  <TableHead className="text-right">Captured</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {resolvedPaymentIntents.map((pi) => (
                  <TableRow key={pi.payment_intent_id}>
                    <TableCell className="font-mono text-xs">{pi.payment_intent_id}</TableCell>
                    <TableCell className="font-mono text-xs">{pi.trip_code ?? pi.trip_id?.slice(0, 8)}</TableCell>
                    <TableCell className="text-xs">{pi.customer_name ?? '—'}</TableCell>
                    <TableCell className="text-xs">
                      <DriverWalletLedgerLink driverId={pi.driver_id} tab="stripe">
                        {pi.driver_name ?? '—'}
                      </DriverWalletLedgerLink>
                    </TableCell>
                    <TableCell className="text-right">{fmt(pi.captured_pence)}</TableCell>
                    <TableCell><Badge variant="outline">{pi.status}</Badge></TableCell>
                    <TableCell className="text-xs">{formatFinanceDateSafe(pi.date)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TabsContent>

        <TabsContent value="transfers" className="mt-4">
          {transfers.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">No Connect transfers in period.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Transfer ID</TableHead>
                  <TableHead>Driver</TableHead>
                  <TableHead>Trip</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {transfers.map((t) => (
                  <TableRow key={t.transfer_id}>
                    <TableCell className="font-mono text-xs">{t.transfer_id}</TableCell>
                    <TableCell>
                      <DriverWalletLedgerLink driverId={t.driver_id} tab="stripe">
                        {t.driver_name}
                      </DriverWalletLedgerLink>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{t.trip_id?.slice(0, 8) ?? '—'}</TableCell>
                    <TableCell className="text-right">{fmt(t.amount_pence)}</TableCell>
                    <TableCell><Badge variant="outline">{t.reconciliation_status}</Badge></TableCell>
                    <TableCell className="text-xs">{formatFinanceDateSafe(t.created_at)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TabsContent>

        <TabsContent value="connect" className="mt-4">
          {moneyMovementTimedOut && connectAccountsAll.length === 0 ? (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Connect Accounts unavailable</AlertTitle>
              <AlertDescription>
                Live Stripe Connect balance sync timed out. Use Refresh to load per-account balances.
              </AlertDescription>
            </Alert>
          ) : connectAccountsAll.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">No Connect accounts in this scope.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Driver</TableHead>
                  <TableHead>Connect account</TableHead>
                  <TableHead className="text-right">Stripe available</TableHead>
                  <TableHead className="text-right">Stripe pending</TableHead>
                  <TableHead className="text-right">In transit</TableHead>
                  <TableHead className="text-right">Stripe total</TableHead>
                  <TableHead>Last payout</TableHead>
                  <TableHead>Last synced</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {connectAccountsAll.map((a) => {
                  const available = a.stripe_live_balance_pence ?? 0;
                  const pending = a.future_payout_pence ?? 0;
                  const inTransit = a.in_transit_to_bank_pence ?? 0;
                  const total = available + pending;
                  const lastPayout = lastPayoutByDriver.get(a.driver_id);
                  return (
                  <TableRow key={a.connected_account_id ?? a.driver_id}>
                    <TableCell>
                      <DriverWalletLedgerLink driverId={a.driver_id} tab="stripe">
                        {a.driver_name ?? '—'}
                      </DriverWalletLedgerLink>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {a.connected_account_id ? `${a.connected_account_id.slice(0, 14)}…` : '—'}
                    </TableCell>
                    <TableCell className="text-right">{connectFmt(available, a.currency_code)}</TableCell>
                    <TableCell className="text-right">{connectFmt(pending, a.currency_code)}</TableCell>
                    <TableCell className="text-right">{connectFmt(inTransit, a.currency_code)}</TableCell>
                    <TableCell className="text-right font-medium">{connectFmt(total, a.currency_code)}</TableCell>
                    <TableCell className="text-xs">
                      {lastPayout
                        ? `${connectFmt(lastPayout.amount_pence, a.currency_code)} · ${formatFinanceDateSafe(lastPayout.initiated_at, 'dd MMM HH:mm')}`
                        : '—'}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {a.last_synced_at
                        ? formatFinanceDateSafe(a.last_synced_at, 'dd MMM yyyy HH:mm')
                        : '—'}
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusChipVariant(a.reconciliation_status)}>{a.reconciliation_status}</Badge>
                      {a.duplicate_connect_account ? (
                        <Badge variant="destructive" className="ml-1">Duplicate</Badge>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <DriverWalletLedgerLink driverId={a.driver_id} tab="stripe" className="text-xs" />
                    </TableCell>
                  </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
          {connectReconciliationQueue.length > 0 && (
            <p className="text-xs text-muted-foreground mt-3">
              {connectReconciliationQueue.length} account(s) need reconciliation attention.
            </p>
          )}
        </TabsContent>

        <TabsContent value="payouts" className="mt-4">
          {payouts.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">No Connect bank payouts in selected period.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Driver</TableHead>
                  <TableHead>Payout ID</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Reconciliation</TableHead>
                  <TableHead>Bank</TableHead>
                  <TableHead>Initiated</TableHead>
                  <TableHead>Est. arrival</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {payouts.map((p) => (
                  <TableRow key={p.payout_id}>
                    <TableCell>
                      <DriverWalletLedgerLink driverId={p.driver_id} tab="stripe">
                        {p.driver_name}
                        {p.driver_code ? ` (${p.driver_code})` : ''}
                      </DriverWalletLedgerLink>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{p.payout_id}</TableCell>
                    <TableCell className="text-right">{fmt(p.payout_amount_pence)}</TableCell>
                    <TableCell>
                      <Badge variant={statusChipVariant(p.payout_status)} className="capitalize">
                        {p.payout_status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusChipVariant(p.reconciliation_status)} className="capitalize">
                        {p.reconciliation_status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs">{p.external_bank_last4 ? `•••• ${p.external_bank_last4}` : '—'}</TableCell>
                    <TableCell className="text-xs">{formatFinanceDateSafe(p.payout_initiated_at)}</TableCell>
                    <TableCell className="text-xs">{formatFinanceDateSafe(p.estimated_arrival_at)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TabsContent>

        <TabsContent value="transfer-failures" className="mt-4">
          {transferFailures.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">No transfer failures detected.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Driver</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead className="text-right">Diff</TableHead>
                  <TableHead>Message</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {transferFailures.map((m, i) => (
                  <TableRow key={`${m.reference_id}-${i}`}>
                    <TableCell>
                      <DriverWalletLedgerLink driverId={m.driver_id} tab="stripe">
                        {m.driver_name ?? '—'}
                      </DriverWalletLedgerLink>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{m.reference_id?.slice(0, 20) ?? '—'}</TableCell>
                    <TableCell className="text-right">{fmt(m.difference_pence)}</TableCell>
                    <TableCell className="text-xs">{m.message}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
