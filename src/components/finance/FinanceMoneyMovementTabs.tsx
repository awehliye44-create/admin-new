import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatPence } from '@/hooks/useDriverWallet';
import type { FinanceReconciliationSummary } from '@/hooks/useFinanceReconciliation';
import { formatFinanceDateSafe } from '@/lib/financialReconciliationGuards';
import { cn } from '@/lib/utils';
import { AlertTriangle } from 'lucide-react';

type MoneyMovement = NonNullable<FinanceReconciliationSummary['money_movement']>;
type PayoutRow = MoneyMovement['payouts'][number];
type Status = PayoutRow['reconciliation_status'];

function statusBadge(status: Status) {
  const label = status.replace(/_/g, ' ');
  const variant =
    status === 'matched' || status === 'paid_out'
      ? 'default'
      : status === 'pending_stripe_confirmation'
        ? 'secondary'
        : status === 'refunded_reversed'
          ? 'outline'
          : 'destructive';
  return <Badge variant={variant}>{label}</Badge>;
}

function PayoutTable({ rows, ccy }: { rows: PayoutRow[]; ccy: string }) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground py-6 text-center">No Stripe Connect payouts in this period.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Driver</TableHead>
            <TableHead>Connect account</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Payout ID</TableHead>
            <TableHead>Initiated</TableHead>
            <TableHead>Est. arrival</TableHead>
            <TableHead>Bank</TableHead>
            <TableHead>Method</TableHead>
            <TableHead className="text-right">Expected (ledger)</TableHead>
            <TableHead className="text-right">Actual (Stripe)</TableHead>
            <TableHead className="text-right">Diff</TableHead>
            <TableHead>Reconciliation</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow
              key={row.payout_id}
              className={cn(row.reconciliation_status === 'mismatch' && 'bg-destructive/5')}
            >
              <TableCell>
                <div className="font-medium">{row.driver_name}</div>
                {row.duplicate_connect_account && (
                  <Badge variant="destructive" className="mt-1 text-[10px]">Duplicate Connect</Badge>
                )}
              </TableCell>
              <TableCell className="font-mono text-xs">{row.connected_account_id.slice(0, 14)}…</TableCell>
              <TableCell className="text-right font-semibold">{formatPence(row.payout_amount_pence, ccy)}</TableCell>
              <TableCell>
                <Badge variant={row.payout_status === 'paid' ? 'default' : 'secondary'}>{row.payout_status}</Badge>
              </TableCell>
              <TableCell className="font-mono text-xs">{row.payout_id}</TableCell>
              <TableCell className="text-xs">{formatFinanceDateSafe(row.payout_initiated_at)}</TableCell>
              <TableCell className="text-xs">{formatFinanceDateSafe(row.estimated_arrival_at)}</TableCell>
              <TableCell className="text-xs">{row.external_bank_last4 ? `•••• ${row.external_bank_last4}` : '—'}</TableCell>
              <TableCell className="text-xs">{row.payout_method}</TableCell>
              <TableCell className="text-right text-xs">
                {row.expected_ledger_pence != null ? formatPence(row.expected_ledger_pence, ccy) : '—'}
              </TableCell>
              <TableCell className="text-right text-xs">{formatPence(row.actual_stripe_pence, ccy)}</TableCell>
              <TableCell className={cn('text-right text-xs', row.difference_pence !== 0 && 'text-destructive font-medium')}>
                {formatPence(row.difference_pence, ccy)}
              </TableCell>
              <TableCell>{statusBadge(row.reconciliation_status)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function FinanceMoneyMovementTabs({
  summary,
  currencyCode,
}: {
  summary: FinanceReconciliationSummary | null | undefined;
  currencyCode: string;
}) {
  const ccy = currencyCode.toLowerCase();
  const mm = summary?.money_movement;
  const pending = summary?.pending_stripe_confirmation;

  if (!mm) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Stripe money movement</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Connect payout data loads with full reconciliation (not summary-only). Refresh the page or widen the date range.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Stripe Connect money movement</CardTitle>
        <p className="text-sm text-muted-foreground">
          Live Stripe Connect balances and payouts linked to driver wallet ledger. Last synced{' '}
          {formatFinanceDateSafe(mm.last_synced_at)}.
        </p>
        {pending && pending.trip_count > 0 && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
            <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
            <div>
              <strong>{pending.label}</strong> — {pending.trip_count} completed card trip(s): expected revenue{' '}
              {formatPence(pending.expected_revenue_pence, ccy)} (excluded from reconciled totals until capture confirmed).
            </div>
          </div>
        )}
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="payouts">
          <TabsList className="flex flex-wrap h-auto gap-1">
            <TabsTrigger value="payments">Payments</TabsTrigger>
            <TabsTrigger value="transfers">Transfers</TabsTrigger>
            <TabsTrigger value="payouts">Payouts ({mm.payouts.length})</TabsTrigger>
            <TabsTrigger value="fees">Collected fees</TabsTrigger>
            <TabsTrigger value="recovery">Recovery debt</TabsTrigger>
            <TabsTrigger value="mismatches">Mismatches ({mm.mismatches.length})</TabsTrigger>
          </TabsList>

          <TabsContent value="payments" className="mt-4">
            <p className="text-xs text-muted-foreground mb-3">
              Reconciled card customer revenue uses captured payments only — authorisations and released buffer are excluded.
            </p>
            <div className="grid gap-3 sm:grid-cols-3">
              <Metric label="Reconciled card revenue" value={summary?.customer_revenue.net_card_revenue_pence ?? 0} ccy={ccy} />
              <Metric label="Refunded" value={summary?.customer_revenue.refunded_amount_pence ?? 0} ccy={ccy} />
              <Metric
                label="Pending Stripe confirmation"
                value={pending?.expected_revenue_pence ?? 0}
                ccy={ccy}
                pending
              />
            </div>
          </TabsContent>

          <TabsContent value="transfers" className="mt-4">
            {mm.transfers.length === 0 ? (
              <p className="text-sm text-muted-foreground py-6 text-center">No Connect transfers recorded.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Driver</TableHead>
                    <TableHead>Transfer ID</TableHead>
                    <TableHead>Trip</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {mm.transfers.map((t) => (
                    <TableRow key={t.transfer_id}>
                      <TableCell>{t.driver_name}</TableCell>
                      <TableCell className="font-mono text-xs">{t.transfer_id}</TableCell>
                      <TableCell className="font-mono text-xs">{t.trip_id?.slice(0, 8) ?? '—'}</TableCell>
                      <TableCell className="text-right">{formatPence(t.amount_pence, ccy)}</TableCell>
                      <TableCell className="text-xs">{formatFinanceDateSafe(t.created_at)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </TabsContent>

          <TabsContent value="payouts" className="mt-4">
            <PayoutTable rows={mm.payouts} ccy={ccy} />
          </TabsContent>

          <TabsContent value="fees" className="mt-4">
            {mm.collected_fees.length === 0 ? (
              <p className="text-sm text-muted-foreground py-6 text-center">No application fees in scope.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Driver</TableHead>
                    <TableHead>Trip</TableHead>
                    <TableHead>Application fee</TableHead>
                    <TableHead className="text-right">Commission</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {mm.collected_fees.map((f) => (
                    <TableRow key={`${f.trip_id}-${f.application_fee_id}`}>
                      <TableCell>{f.driver_name}</TableCell>
                      <TableCell className="font-mono text-xs">{f.trip_id?.slice(0, 8) ?? '—'}</TableCell>
                      <TableCell className="font-mono text-xs">{f.application_fee_id ?? '—'}</TableCell>
                      <TableCell className="text-right">{formatPence(f.amount_pence, ccy)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </TabsContent>

          <TabsContent value="recovery" className="mt-4">
            {mm.recovery_debt.length === 0 ? (
              <p className="text-sm text-muted-foreground py-6 text-center">No recovery debt on ledger.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Driver</TableHead>
                    <TableHead className="text-right">Recovery debt</TableHead>
                    <TableHead className="text-right">Net payable after recovery</TableHead>
                    <TableHead>Note</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {mm.recovery_debt.map((r) => {
                    const acct = mm.connect_accounts.find((a) => a.driver_id === r.driver_id);
                    return (
                      <TableRow key={r.driver_id}>
                        <TableCell>{r.driver_name}</TableCell>
                        <TableCell className="text-right text-destructive">{formatPence(r.recovery_debt_pence, ccy)}</TableCell>
                        <TableCell className="text-right">
                          {formatPence(acct?.net_payable_after_recovery_pence ?? 0, ccy)}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">{r.note}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </TabsContent>

          <TabsContent value="mismatches" className="mt-4">
            {mm.mismatches.length === 0 ? (
              <p className="text-sm text-muted-foreground py-6 text-center">No mismatches detected.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Kind</TableHead>
                    <TableHead>Driver</TableHead>
                    <TableHead>Reference</TableHead>
                    <TableHead className="text-right">Expected</TableHead>
                    <TableHead className="text-right">Actual</TableHead>
                    <TableHead className="text-right">Diff</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Message</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {mm.mismatches.map((m, i) => (
                    <TableRow key={`${m.kind}-${m.reference_id}-${i}`}>
                      <TableCell>{m.kind}</TableCell>
                      <TableCell>{m.driver_name ?? '—'}</TableCell>
                      <TableCell className="font-mono text-xs">{m.reference_id?.slice(0, 20) ?? '—'}</TableCell>
                      <TableCell className="text-right">
                        {m.expected_pence != null ? formatPence(m.expected_pence, ccy) : '—'}
                      </TableCell>
                      <TableCell className="text-right">
                        {m.actual_pence != null ? formatPence(m.actual_pence, ccy) : '—'}
                      </TableCell>
                      <TableCell className="text-right">{formatPence(m.difference_pence, ccy)}</TableCell>
                      <TableCell>{statusBadge(m.status)}</TableCell>
                      <TableCell className="text-xs max-w-md">{m.message}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </TabsContent>
        </Tabs>

        <div className="mt-6">
          <h3 className="text-sm font-semibold mb-2">Connect account balances (Stripe dashboard parity)</h3>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Driver</TableHead>
                <TableHead>Connect account</TableHead>
                <TableHead className="text-right">Live balance</TableHead>
                <TableHead className="text-right">Future payout</TableHead>
                <TableHead className="text-right">In transit</TableHead>
                <TableHead className="text-right">Lifetime volume</TableHead>
                <TableHead className="text-right">Expected wallet</TableHead>
                <TableHead className="text-right">Actual Stripe</TableHead>
                <TableHead className="text-right">Diff</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {mm.connect_accounts.map((a) => (
                <TableRow key={a.connected_account_id}>
                  <TableCell>
                    {a.driver_name}
                    {a.duplicate_connect_account && (
                      <Badge variant="destructive" className="ml-2 text-[10px]">Duplicate</Badge>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{a.connected_account_id.slice(0, 14)}…</TableCell>
                  <TableCell className="text-right">{formatPence(a.stripe_live_balance_pence, ccy)}</TableCell>
                  <TableCell className="text-right">{formatPence(a.future_payout_pence, ccy)}</TableCell>
                  <TableCell className="text-right">{formatPence(a.in_transit_to_bank_pence, ccy)}</TableCell>
                  <TableCell className="text-right">{formatPence(a.lifetime_volume_pence, ccy)}</TableCell>
                  <TableCell className="text-right">{formatPence(a.expected_wallet_balance_pence, ccy)}</TableCell>
                  <TableCell className="text-right">{formatPence(a.actual_stripe_balance_pence, ccy)}</TableCell>
                  <TableCell className={cn('text-right', a.difference_pence !== 0 && 'text-destructive')}>
                    {formatPence(a.difference_pence, ccy)}
                  </TableCell>
                  <TableCell>{statusBadge(a.reconciliation_status)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function Metric({
  label,
  value,
  ccy,
  pending,
}: {
  label: string;
  value: number;
  ccy: string;
  pending?: boolean;
}) {
  return (
    <div className={cn('rounded-lg border p-3', pending && 'border-dashed border-amber-500/50')}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn('text-lg font-semibold', pending && 'text-amber-700')}>{formatPence(value, ccy)}</div>
    </div>
  );
}
