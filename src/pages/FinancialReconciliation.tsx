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
import { useFinanceReconciliation } from '@/hooks/useFinanceReconciliation';
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

  const { data, isLoading, error, refetch, isFetching } = useFinanceReconciliation({
    filter,
    from: from || undefined,
    to: to || undefined,
  });

  const summary = data?.finance_reconciliation_summary;
  const ccy = data?.currency_code ?? filter.currencyCode ?? 'GBP';
  const auditRows = data?.trip_financial_audit ?? [];

  const reconciliationChip = useMemo(() => {
    if (!summary) return null;
    return summary.reconciliation_check.balanced ? 'Balanced' : 'Reconciliation Error';
  }, [summary]);

  if (isLoading && !data) {
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
              Single source of truth for ONECAB finance. ONECAB commission = sum(trip commission_pence) — never
              Stripe balance minus driver payable.
            </p>
            {reconciliationChip && (
              <Badge variant={statusChipVariant(reconciliationChip)} className="mt-2">
                {reconciliationChip}
              </Badge>
            )}
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

        {!check.balanced && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Reconciliation Error</AlertTitle>
            <AlertDescription>
              Net customer revenue {formatPence(check.net_customer_revenue_pence, ccy)} ≠ driver net{' '}
              {formatPence(check.driver_net_earnings_pence, ccy)} + ONECAB gross{' '}
              {formatPence(check.onecab_gross_commission_pence, ccy)} + adjustments{' '}
              {formatPence(check.adjustments_pence, ccy)}. Processing fees are included in ONECAB gross
              commission. Delta {formatPence(check.delta_pence, ccy)}.
            </AlertDescription>
          </Alert>
        )}

        {data.meta.stripe_balance_error && (
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
          <CardContent className="grid gap-3 sm:grid-cols-3">
            <MetricCard title="Total Customer Revenue" value={revenue.total_customer_revenue_pence} ccy={ccy} />
            <MetricCard title="Refunded Amount" value={revenue.refunded_amount_pence} ccy={ccy} />
            <MetricCard title="Net Customer Revenue" value={revenue.net_customer_revenue_pence} ccy={ccy} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Users className="h-4 w-4" />
              Driver
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <MetricCard title="Driver Gross Earnings" value={driver.driver_gross_earnings_pence} ccy={ccy} />
            <MetricCard title="Driver Net Earnings" value={driver.driver_net_earnings_pence} ccy={ccy} />
            <MetricCard title="Driver Available Payout" value={driver.driver_available_payout_pence} ccy={ccy} />
            <MetricCard title="Driver Pending Payout" value={driver.driver_pending_payout_pence} ccy={ccy} />
            <MetricCard title="Driver Paid Out" value={driver.driver_paid_out_pence} ccy={ccy} />
            <MetricCard title="Driver Payout Liability" value={driver.driver_payout_liability_pence} ccy={ccy} />
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
            <MetricCard title="ONECAB Gross Commission" value={onecab.onecab_gross_commission_pence} ccy={ccy} />
            <MetricCard title="Processing Fees" value={onecab.provider_processing_fee_pence} ccy={ccy} />
            <MetricCard title="ONECAB Net Commission" value={onecab.onecab_net_commission_pence} ccy={ccy} />
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
                    <TableCell colSpan={14} className="text-center text-muted-foreground py-8">
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
