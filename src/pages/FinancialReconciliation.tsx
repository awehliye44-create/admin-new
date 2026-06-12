import { useMemo, useState } from 'react';
import { format } from 'date-fns';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { ServiceAreaFinanceFilter, type ServiceAreaFinanceSelection } from '@/components/finance/ServiceAreaFinanceFilter';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatPence } from '@/hooks/useDriverWallet';
import { FinanceSSOT, useFinancialReconciliationSSOT } from '@/hooks/useFinancialReconciliationSSOT';
import { FinanceSSOTBadge } from '@/components/finance/FinanceSSOTBadge';
import { useFinanceBackendAudit } from '@/hooks/useFinanceBackendAudit';
import { getTripDisplayId } from '@/lib/tripUtils';
import {
  AlertTriangle,
  Banknote,
  Building2,
  Calculator,
  CreditCard,
  RefreshCw,
  Users,
  Wallet,
} from 'lucide-react';

function statusChipVariant(label: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  const l = label.toLowerCase();
  if (l.includes('balanced') || l.includes('settled') || l.includes('paid')) return 'default';
  if (l.includes('error') || l.includes('failed') || l.includes('failing')) return 'destructive';
  if (l.includes('awaiting') || l.includes('partial')) return 'secondary';
  return 'outline';
}

function MetricCard({
  title,
  value,
  subtitle,
  ccy,
}: {
  title: string;
  value: number;
  subtitle?: string;
  ccy: string;
}) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <p className="text-xs text-muted-foreground">{title}</p>
      <p className="text-lg font-semibold">{formatPence(value, ccy)}</p>
      {subtitle && <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>}
    </div>
  );
}

export default function FinancialReconciliation() {
  const [filter, setFilter] = useState<ServiceAreaFinanceSelection>({
    serviceAreaId: null,
    regionId: null,
    currencyCode: null,
  });
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const ssot = useFinancialReconciliationSSOT({
    filter,
    from: from || undefined,
    to: to || undefined,
  });
  const { isLoading, error, refetch, isFetching } = ssot;
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
  const auditRows = data?.trip_financial_audit ?? [];
  const backendAudit = backendAuditData?.finance_backend_audit_v1;

  const reconciliationChip = useMemo(() => {
    if (!summary) return null;
    const status = FinanceSSOT.reconciliationStatus(summary);
    if (status === 'RECONCILIATION_MISMATCH' || status === 'reconciliation_error') {
      return 'RECONCILIATION_MISMATCH';
    }
    return 'BALANCED';
  }, [summary]);

  const ssotBadge = ssot.badge;

  if (isLoading && !summary) {
    return (
      <AdminLayout title="Financial Reconciliation">
        <div className="py-12 text-center text-muted-foreground">Loading finance reconciliation…</div>
      </AdminLayout>
    );
  }

  if (error) {
    return (
      <AdminLayout title="Financial Reconciliation">
        <Alert variant="destructive">
          <AlertTitle>Reconciliation unavailable</AlertTitle>
          <AlertDescription>{(error as Error).message}</AlertDescription>
        </Alert>
      </AdminLayout>
    );
  }

  if (!summary) return null;

  const revenue = summary.customer_revenue;
  const driver = summary.driver_money;
  const onecab = summary.onecab_money;
  const provider = summary.provider_money;
  const check = summary.reconciliation_check;

  return (
    <AdminLayout title="Financial Reconciliation">
      <div className="space-y-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <Calculator className="h-6 w-6 text-primary" />
              <h1 className="text-2xl font-bold">Financial Reconciliation</h1>
            </div>
            <p className="text-sm text-muted-foreground mt-1 max-w-3xl">
              Accounting source of truth — card/Stripe revenue and cash collected by drivers are reconciled in
              separate ledgers. Cash fare never increases Stripe revenue or card driver payout liability.
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

        {ssotBadge !== 'LIVE' && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Live reconciliation unavailable</AlertTitle>
            <AlertDescription>
              Showing {ssotBadge} fallback data. All admin finance surfaces should use this page when LIVE — other
              pages may show incomplete totals until live reconciliation is restored.
            </AlertDescription>
          </Alert>
        )}

        {!check.balanced && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>RECONCILIATION_MISMATCH</AlertTitle>
            <AlertDescription className="space-y-2">
              {!check.card_reconciliation.balanced && (
                <p>
                  <strong>Card ledger:</strong> card customer revenue{' '}
                  {formatPence(check.card_reconciliation.card_customer_revenue_pence, ccy)} ≠ card driver payable{' '}
                  {formatPence(check.card_reconciliation.card_driver_payable_pence, ccy)} + ONECAB card commission{' '}
                  {formatPence(check.card_reconciliation.onecab_card_commission_pence, ccy)}. Delta{' '}
                  {formatPence(check.card_reconciliation.delta_pence, ccy)}.
                </p>
              )}
              {!check.cash_reconciliation.balanced && (
                <p>
                  <strong>Cash ledger:</strong> cash collected by driver{' '}
                  {formatPence(check.cash_reconciliation.cash_collected_by_driver_pence, ccy)} ≠ cash driver already
                  received {formatPence(check.cash_reconciliation.cash_driver_already_received_pence, ccy)} +
                  ONECAB cash commission receivable{' '}
                  {formatPence(check.cash_reconciliation.onecab_cash_commission_receivable_pence, ccy)}. Delta{' '}
                  {formatPence(check.cash_reconciliation.delta_pence, ccy)}.
                </p>
              )}
              <p className="text-xs opacity-90">
                Card and cash trips are checked separately. Cash fare is not ONECAB Stripe revenue and does not
                increase driver payout liability.
              </p>
            </AlertDescription>
          </Alert>
        )}

        {data?.meta?.stripe_balance_error && (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Provider balance unavailable</AlertTitle>
            <AlertDescription>{data.meta.stripe_balance_error}</AlertDescription>
          </Alert>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CreditCard className="h-4 w-4" />
              Revenue
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard title="Card Customer Revenue" value={revenue.card_customer_revenue_pence} ccy={ccy} />
            <MetricCard title="Cash Collected by Driver" value={revenue.cash_collected_by_driver_pence} ccy={ccy} />
            <MetricCard title="Refunded Amount" value={revenue.refunded_amount_pence} ccy={ccy} />
            <MetricCard title="Net Card Revenue" value={revenue.net_card_revenue_pence} ccy={ccy} />
          </CardContent>
        </Card>

        <Card className="border-blue-500/30">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CreditCard className="h-4 w-4 text-blue-500" />
              A. Card / Stripe Reconciliation
              <Badge variant={statusChipVariant(check.card_reconciliation.status)} className="ml-auto">
                {check.card_reconciliation.status}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard title="Card Customer Revenue" value={check.card_reconciliation.card_customer_revenue_pence} ccy={ccy} />
            <MetricCard title="Card Driver Payable" value={check.card_reconciliation.card_driver_payable_pence} ccy={ccy} />
            <MetricCard title="ONECAB Card Commission" value={check.card_reconciliation.onecab_card_commission_pence} ccy={ccy} />
            <MetricCard title="Stripe Processing Fees" value={onecab.provider_processing_fee_pence} ccy={ccy} />
            <MetricCard
              title="ONECAB Card Net Commission"
              value={onecab.onecab_net_commission_pence}
              ccy={ccy}
              subtitle="Card commission − Stripe fees"
            />
            <MetricCard title="Expected (driver + commission)" value={check.card_reconciliation.expected_sum_pence} ccy={ccy} />
            <MetricCard title="Variance" value={check.card_reconciliation.variance_pence} ccy={ccy} />
          </CardContent>
        </Card>

        <Card className="border-amber-500/30">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Banknote className="h-4 w-4 text-amber-500" />
              B. Cash Reconciliation
              <Badge variant={statusChipVariant(check.cash_reconciliation.status)} className="ml-auto">
                {check.cash_reconciliation.status}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard title="Cash Collected by Driver" value={check.cash_reconciliation.cash_collected_by_driver_pence} ccy={ccy} />
            <MetricCard title="Cash Driver Already Received" value={check.cash_reconciliation.cash_driver_already_received_pence} ccy={ccy} />
            <MetricCard title="ONECAB Cash Commission Receivable" value={check.cash_reconciliation.onecab_cash_commission_receivable_pence} ccy={ccy} />
            <MetricCard title="Expected (driver + commission)" value={check.cash_reconciliation.expected_sum_pence} ccy={ccy} />
            <MetricCard title="Variance" value={check.cash_reconciliation.variance_pence} ccy={ccy} />
            <p className="text-xs text-muted-foreground sm:col-span-2">
              Cash fare stays with the driver. ONECAB commission is receivable (debited from driver wallet), not Stripe revenue.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Users className="h-4 w-4" />
              C. Driver Wallet Summary
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <MetricCard title="Card Driver Payable" value={driver.card_driver_payable_pence} ccy={ccy} />
            <MetricCard title="Cash Driver Already Received" value={driver.cash_driver_already_received_pence} ccy={ccy} />
            <MetricCard title="Driver Available Payout" value={driver.driver_available_payout_pence} ccy={ccy} subtitle="Card earnings only" />
            <MetricCard title="Driver Pending Payout" value={driver.driver_pending_payout_pence} ccy={ccy} />
            <MetricCard title="Driver Paid Out" value={driver.driver_paid_out_pence} ccy={ccy} />
            <MetricCard title="Driver Payout Liability" value={driver.driver_payout_liability_pence} ccy={ccy} subtitle="Card payable − paid out" />
            <MetricCard title="Owed to ONECAB (cash commission)" value={driver.onecab_cash_commission_owed_pence} ccy={ccy} />
            <MetricCard title="Wallet Balance (net)" value={driver.driver_wallet_balance_pence} ccy={ccy} subtitle="After cash commission debits" />
          </CardContent>
        </Card>

        <Card className="border-primary/30">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Building2 className="h-4 w-4" />
              ONECAB
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <MetricCard title="ONECAB Card Commission" value={onecab.onecab_card_commission_pence} ccy={ccy} />
            <MetricCard title="ONECAB Cash Commission Receivable" value={onecab.onecab_cash_commission_receivable_pence} ccy={ccy} />
            <MetricCard title="Processing Fees" value={onecab.provider_processing_fee_pence} ccy={ccy} />
            <MetricCard title="ONECAB Net Commission" value={onecab.onecab_net_commission_pence} ccy={ccy} subtitle="Card commission − fees" />
            <MetricCard title="ONECAB Bank Payout" value={onecab.onecab_bank_payout_pence} ccy={ccy} />
            <div className="rounded-lg border bg-card p-3">
              <p className="text-xs text-muted-foreground">Commission Status</p>
              <Badge variant={statusChipVariant(onecab.onecab_commission_status_label)} className="mt-2">
                {onecab.onecab_commission_status_label}
              </Badge>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Banknote className="h-4 w-4" />
              Payment Provider ({provider.provider_name})
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard title="Provider Available Balance" value={provider.provider_available_balance_pence} ccy={ccy} />
            <MetricCard title="Provider Pending Balance" value={provider.provider_pending_balance_pence} ccy={ccy} />
            <div className="rounded-lg border bg-card p-3">
              <p className="text-xs text-muted-foreground">Provider Health</p>
              <Badge variant={statusChipVariant(provider.provider_health_status)} className="mt-2 capitalize">
                {provider.provider_health_status}
              </Badge>
            </div>
            <div className="rounded-lg border bg-card p-3">
              <p className="text-xs text-muted-foreground">Last Webhook Received</p>
              <p className="text-sm font-medium mt-1">
                {provider.last_webhook_received_at
                  ? format(new Date(provider.last_webhook_received_at), 'dd MMM yyyy HH:mm')
                  : '—'}
              </p>
            </div>
          </CardContent>
        </Card>

        {backendAudit && (
          <>
            <Card className="border-amber-500/40">
              <CardHeader>
                <CardTitle className="text-base">finance_backend_audit_v1</CardTitle>
                <p className="text-sm text-muted-foreground">
                  Backend money audit — answers what came in, what was paid out, what remains, and who owns it.
                </p>
              </CardHeader>
              <CardContent className="space-y-6">
                {backendAudit.reconciliation.reconciliation_status === 'MISMATCH' && (
                  <Alert variant="destructive">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertTitle>Reconciliation MISMATCH</AlertTitle>
                    <AlertDescription>
                      Difference {formatPence(backendAudit.reconciliation.reconciliation_difference_pence, ccy)} —
                      {backendAudit.answered_questions.K_wallet_vs_payout_diagnosis}
                    </AlertDescription>
                  </Alert>
                )}

                <div>
                  <h3 className="text-sm font-semibold mb-2">INCOMING MONEY</h3>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    <MetricCard title="Customer Captured" value={backendAudit.incoming_money.customer_captured_total_pence} ccy={ccy} />
                    <MetricCard title="Customer Refunded" value={backendAudit.incoming_money.customer_refunded_total_pence} ccy={ccy} />
                    <MetricCard title="Net Customer Money In" value={backendAudit.incoming_money.net_customer_money_in_pence} ccy={ccy} />
                    <MetricCard title="Provider Available" value={backendAudit.incoming_money.provider_available_balance_pence} ccy={ccy} />
                    <MetricCard title="Provider Pending" value={backendAudit.incoming_money.provider_pending_balance_pence} ccy={ccy} />
                    <MetricCard title="Provider Payouts to ONECAB Bank" value={backendAudit.incoming_money.provider_payouts_to_onecab_bank_pence} ccy={ccy} />
                  </div>
                </div>

                <div>
                  <h3 className="text-sm font-semibold mb-2">PAID OUT</h3>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    <MetricCard title="Driver Paid Out Total" value={backendAudit.paid_out.driver_paid_out_total_pence} ccy={ccy} />
                    <MetricCard title="Weekly Payouts Paid" value={backendAudit.paid_out.driver_weekly_payouts_paid_pence} ccy={ccy} />
                    <MetricCard title="Early Cashouts Paid" value={backendAudit.paid_out.driver_early_cashouts_paid_pence} ccy={ccy} />
                    <MetricCard title="Failed Payouts" value={backendAudit.paid_out.failed_payouts_pence} ccy={ccy} />
                    <MetricCard title="ONECAB Paid to Bank" value={backendAudit.paid_out.onecab_paid_to_bank_pence} ccy={ccy} />
                    <MetricCard title="Provider Fees Paid" value={backendAudit.paid_out.provider_fees_paid_pence} ccy={ccy} />
                  </div>
                </div>

                <div>
                  <h3 className="text-sm font-semibold mb-2">REMAINING MONEY</h3>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    <MetricCard title="Driver Remaining Liability" value={backendAudit.remaining_money.driver_remaining_liability_pence} ccy={ccy} />
                    <MetricCard title="Driver Available Now" value={backendAudit.remaining_money.driver_available_now_pence} ccy={ccy} subtitle="min(liability, provider available)" />
                    <MetricCard title="Driver Pending Settlement" value={backendAudit.remaining_money.driver_pending_settlement_pence} ccy={ccy} />
                    <MetricCard title="ONECAB Remaining Commission" value={backendAudit.remaining_money.onecab_remaining_commission_pence} ccy={ccy} />
                    <MetricCard title="Provider Available" value={backendAudit.remaining_money.provider_available_balance_pence} ccy={ccy} />
                    <MetricCard title="Reconciliation Difference" value={backendAudit.remaining_money.reconciliation_difference_pence} ccy={ccy} />
                  </div>
                </div>

                <div className="space-y-2">
                  <h3 className="text-sm font-semibold">Critical checks</h3>
                  {backendAudit.critical_checks.map((check) => (
                    <div key={check.id} className="flex items-start gap-2 text-sm">
                      <Badge variant={check.passed ? 'default' : 'destructive'}>{check.passed ? 'PASS' : 'FAIL'}</Badge>
                      <span>{check.detail}</span>
                    </div>
                  ))}
                </div>

                {backendAudit.wallet_integrity.length > 0 && (
                  <div className="overflow-x-auto">
                    <h3 className="text-sm font-semibold mb-2">Wallet integrity (why balance may still show after payout)</h3>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Driver</TableHead>
                          <TableHead className="text-right">Wallet</TableHead>
                          <TableHead className="text-right">Ledger sum</TableHead>
                          <TableHead className="text-right">Missing ledger payout</TableHead>
                          <TableHead>Explanation</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {backendAudit.wallet_integrity.map((row) => (
                          <TableRow key={row.driver_id}>
                            <TableCell>{row.driver_name ?? row.driver_id.slice(0, 8)}</TableCell>
                            <TableCell className="text-right">{formatPence(row.wallet_balance_pence, ccy)}</TableCell>
                            <TableCell className="text-right">{formatPence(row.ledger_sum_pence, ccy)}</TableCell>
                            <TableCell className="text-right">{formatPence(row.completed_payouts_without_ledger_pence, ccy)}</TableCell>
                            <TableCell className="text-xs text-muted-foreground max-w-md">{row.explanation ?? '—'}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}

                <div className="overflow-x-auto">
                  <h3 className="text-sm font-semibold mb-2">Payout audit rows</h3>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Payout</TableHead>
                        <TableHead>Driver</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Sent to bank</TableHead>
                        <TableHead>Provider payout ID</TableHead>
                        <TableHead>Ledger debit</TableHead>
                        <TableHead>Reconciliation</TableHead>
                        <TableHead>Paid at</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {backendAudit.payout_rows.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={9} className="text-center text-muted-foreground py-6">No payouts in period</TableCell>
                        </TableRow>
                      ) : (
                        backendAudit.payout_rows.map((row) => {
                          const sentToBank = !!(row.provider_reference);
                          const ledgerOk = row.ledger_entry_created;
                          const critical = sentToBank && !ledgerOk;
                          return (
                          <TableRow key={`${row.payout_source}-${row.payout_id}`} className={critical ? 'bg-destructive/5' : undefined}>
                            <TableCell className="font-mono text-xs">{row.payout_id.slice(0, 8)}…</TableCell>
                            <TableCell className="font-mono text-xs">{row.driver_id.slice(0, 8)}…</TableCell>
                            <TableCell className="text-right">{formatPence(row.amount_pence, ccy)}</TableCell>
                            <TableCell>{row.status}</TableCell>
                            <TableCell>{sentToBank ? 'Yes' : 'No'}</TableCell>
                            <TableCell className="text-xs font-mono">{row.provider_reference?.slice(0, 16) ?? '—'}</TableCell>
                            <TableCell>
                              <Badge variant={ledgerOk ? 'default' : 'destructive'}>
                                {ledgerOk ? 'Yes' : 'No'}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-xs max-w-[180px]">
                              {critical ? (
                                <span className="text-destructive font-semibold">
                                  CRITICAL: Provider payout completed but driver ledger was not debited.
                                </span>
                              ) : ledgerOk ? (
                                <span className="text-muted-foreground">Balanced</span>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </TableCell>
                            <TableCell className="text-xs whitespace-nowrap">
                              {row.paid_at ? format(new Date(row.paid_at), 'dd MMM HH:mm') : '—'}
                            </TableCell>
                          </TableRow>
                        );})
                      )}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          </>
        )}

        {backendAuditLoading && !backendAudit && (
          <p className="text-sm text-muted-foreground">Loading finance_backend_audit_v1…</p>
        )}

        {backendAuditError && (
          <Alert variant="destructive">
            <AlertTitle>Backend audit unavailable</AlertTitle>
            <AlertDescription>{(backendAuditError as Error).message}</AlertDescription>
          </Alert>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Wallet className="h-4 w-4" />
              Trip Financial Audit
            </CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Trip</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead>Driver</TableHead>
                  <TableHead className="text-right">Customer Paid</TableHead>
                  <TableHead className="text-right">Captured</TableHead>
                  <TableHead className="text-right">Refunded</TableHead>
                  <TableHead className="text-right">Net Payment</TableHead>
                  <TableHead className="text-right">Driver Net</TableHead>
                  <TableHead className="text-right">ONECAB Gross</TableHead>
                  <TableHead className="text-right">Fee</TableHead>
                  <TableHead className="text-right">ONECAB Net</TableHead>
                  <TableHead>Driver Payout</TableHead>
                  <TableHead>Commission</TableHead>
                  <TableHead>Provider</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {auditRows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={15} className="text-center text-muted-foreground py-8">
                      No trips in selected period
                    </TableCell>
                  </TableRow>
                ) : (
                  auditRows.map((row) => (
                    <TableRow key={row.trip_id}>
                      <TableCell className="font-mono text-xs">
                        {getTripDisplayId({ trip_code: row.trip_code, id: row.trip_id })}
                      </TableCell>
                      <TableCell className="text-xs whitespace-nowrap">
                        {row.date ? format(new Date(row.date), 'dd MMM yyyy HH:mm') : '—'}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-xs uppercase">
                          {row.payment_method ?? '—'}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm">{row.driver_name ?? '—'}</TableCell>
                      <TableCell className="text-right">{formatPence(row.customer_paid_pence, ccy)}</TableCell>
                      <TableCell className="text-right">{formatPence(row.captured_pence, ccy)}</TableCell>
                      <TableCell className="text-right">{formatPence(row.refunded_pence, ccy)}</TableCell>
                      <TableCell className="text-right">{formatPence(row.net_customer_payment_pence, ccy)}</TableCell>
                      <TableCell className="text-right">{formatPence(row.driver_net_pence, ccy)}</TableCell>
                      <TableCell className="text-right">{formatPence(row.onecab_gross_commission_pence, ccy)}</TableCell>
                      <TableCell className="text-right">{formatPence(row.processing_fee_pence, ccy)}</TableCell>
                      <TableCell className="text-right">{formatPence(row.onecab_net_pence, ccy)}</TableCell>
                      <TableCell>
                        <Badge variant={statusChipVariant(row.driver_payout_status)} className="text-xs">
                          {row.driver_payout_status}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={statusChipVariant(row.onecab_commission_status)} className="text-xs">
                          {row.onecab_commission_status}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={statusChipVariant(row.provider_status)} className="text-xs">
                          {row.provider_status}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </AdminLayout>
  );
}
