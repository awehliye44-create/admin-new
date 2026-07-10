import { Link, useSearchParams } from 'react-router-dom';
import { format } from 'date-fns';
import { Loader2, RefreshCw } from 'lucide-react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useAdminPayoutLedger } from '@/hooks/useAdminPayoutLedger';
import type { AdminPayoutLedgerTab } from '../../shared/adminPayoutLedgerSSOT';
import { payoutLedgerUrl } from '../../shared/adminPayoutLedgerSSOT';
import { driverWalletLedgerUrl } from '@/lib/driverWalletLedgerRoutes';
import { formatNullablePence } from '@/lib/formatNullablePence';
import { useMemo, useState } from 'react';
import {
  PayoutLedgerCreateWeeklyBatchButton,
  PayoutLedgerMarkPaidButton,
} from '@/components/finance/PayoutLedgerActions';
import {
  DEFAULT_SERVICE_AREA_SELECTION,
  ServiceAreaFinanceFilter,
  type ServiceAreaFinanceSelection,
} from '@/components/finance/ServiceAreaFinanceFilter';
import { paymentSessionsUrl } from '../../shared/adminPaymentSessionsSSOT';

const TABS: Array<{ id: AdminPayoutLedgerTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'scheduled', label: 'Scheduled' },
  { id: 'processing', label: 'Processing' },
  { id: 'completed', label: 'Completed' },
  { id: 'failed', label: 'Failed' },
  { id: 'returned_cancelled', label: 'Returned / Cancelled' },
  { id: 'batches', label: 'Batches' },
  { id: 'history', label: 'History' },
];

function parseTab(raw: string | null): AdminPayoutLedgerTab {
  if (raw && TABS.some((t) => t.id === raw)) return raw as AdminPayoutLedgerTab;
  return 'overview';
}

export default function PayoutLedger() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = parseTab(searchParams.get('tab'));
  const driverId = searchParams.get('driverId');
  const batchId = searchParams.get('batchId');
  const [serviceFilter, setServiceFilter] = useState<ServiceAreaFinanceSelection>(
    DEFAULT_SERVICE_AREA_SELECTION,
  );

  const request = useMemo(
    () => ({
      tab,
      driver_id: driverId,
      batch_id: batchId,
      limit: 100,
    }),
    [tab, driverId, batchId],
  );

  const { data, isLoading, isFetching, error, refetch } = useAdminPayoutLedger(request);
  const items = data?.items ?? [];
  const batches = data?.batches ?? [];
  const summary = data?.summary;

  const setTab = (next: string) => {
    const params = new URLSearchParams(searchParams);
    params.set('tab', next);
    setSearchParams(params, { replace: true });
  };

  return (
    <AdminLayout title="Payout Ledger (SSOT)">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">
              Wallet → bank transfer lifecycle. Payout execution and retries live here only.
            </p>
            <div className="flex flex-wrap gap-2">
              <Badge variant={data?.page_status === 'LIVE' ? 'default' : 'secondary'}>
                {data?.page_status ?? 'PARTIAL'}
              </Badge>
              {summary && (
                <>
                  <Badge variant="outline">Processing: {summary.processing_count}</Badge>
                  <Badge variant="destructive">Failed: {summary.failed_count}</Badge>
                  <Badge variant="secondary">Paid: {formatNullablePence(summary.total_paid_pence)}</Badge>
                </>
              )}
              <Link to={paymentSessionsUrl()} className="text-xs underline text-muted-foreground self-center">
                Payment Sessions
              </Link>
              <Link to="/financial-reconciliation" className="text-xs underline text-muted-foreground self-center">
                Financial Reconciliation
              </Link>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ServiceAreaFinanceFilter value={serviceFilter} onChange={setServiceFilter} />
            <PayoutLedgerCreateWeeklyBatchButton
              regionId={serviceFilter.regionId}
              currencyCode={serviceFilter.currencyCode ?? 'GBP'}
            />
            <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching}>
              {isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              <span className="ml-2">Refresh</span>
            </Button>
          </div>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertTitle>Payout Ledger failed to load</AlertTitle>
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
                  <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Scheduled</CardTitle></CardHeader><CardContent className="text-xl font-semibold">{summary.scheduled_count}</CardContent></Card>
                  <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Processing</CardTitle></CardHeader><CardContent className="text-xl font-semibold">{summary.processing_count}</CardContent></Card>
                  <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Completed</CardTitle></CardHeader><CardContent className="text-xl font-semibold">{summary.completed_count}</CardContent></Card>
                  <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Failed</CardTitle></CardHeader><CardContent className="text-xl font-semibold">{summary.failed_count}</CardContent></Card>
                </div>
              )}

              {(t.id === 'batches' || t.id === 'overview') && batches.length > 0 && (
                <div className="overflow-x-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Created</TableHead>
                        <TableHead>Run date</TableHead>
                        <TableHead>Kind</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Drivers</TableHead>
                        <TableHead>Total</TableHead>
                        <TableHead>OK / Failed</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {batches.map((b) => (
                        <TableRow key={b.id}>
                          <TableCell className="text-xs">{format(new Date(b.created_at), 'dd MMM HH:mm')}</TableCell>
                          <TableCell className="text-xs">{b.run_date}</TableCell>
                          <TableCell className="text-xs">{b.kind}</TableCell>
                          <TableCell className="text-xs"><Badge variant="outline">{b.status}</Badge></TableCell>
                          <TableCell className="text-xs">{b.total_drivers ?? '—'}</TableCell>
                          <TableCell className="text-xs">{formatNullablePence(b.total_amount_pence)}</TableCell>
                          <TableCell className="text-xs">{b.successful_payouts ?? 0} / {b.failed_payouts ?? 0}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}

              {t.id !== 'batches' && (
                isLoading ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading payouts…
                  </div>
                ) : items.length === 0 ? (
                  <Alert>
                    <AlertTitle>No payouts match the selected filters.</AlertTitle>
                    <AlertDescription>
                      <Link className="underline" to={payoutLedgerUrl({ tab: t.id })}>Clear filters</Link>
                    </AlertDescription>
                  </Alert>
                ) : (
                  <div className="overflow-x-auto rounded-md border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Created</TableHead>
                          <TableHead>Driver</TableHead>
                          <TableHead>Service area</TableHead>
                          <TableHead>Type</TableHead>
                          <TableHead>Gross debit</TableHead>
                          <TableHead>Fees</TableHead>
                          <TableHead>Net transfer</TableHead>
                          <TableHead>Currency</TableHead>
                          <TableHead>Provider</TableHead>
                          <TableHead>Provider payout ID</TableHead>
                          <TableHead>Bank ref</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Processing</TableHead>
                          <TableHead>Paid</TableHead>
                          <TableHead>Wallet ledger</TableHead>
                          <TableHead>Failure</TableHead>
                          <TableHead>Allocations</TableHead>
                          <TableHead>Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {items.map((row) => (
                          <TableRow key={row.id}>
                            <TableCell className="text-xs whitespace-nowrap">
                              {format(new Date(row.created_at), 'dd MMM HH:mm')}
                            </TableCell>
                            <TableCell className="text-xs">{row.driver_name ?? row.driver_id.slice(0, 8)}</TableCell>
                            <TableCell className="text-xs">{row.service_area_name ?? '—'}</TableCell>
                            <TableCell className="text-xs">{row.payout_type ?? '—'}</TableCell>
                            <TableCell className="text-xs">{formatNullablePence(row.gross_wallet_debit_pence, row.currency)}</TableCell>
                            <TableCell className="text-xs">{formatNullablePence(row.fees_pence, row.currency)}</TableCell>
                            <TableCell className="text-xs">{formatNullablePence(row.net_bank_transfer_pence, row.currency)}</TableCell>
                            <TableCell className="text-xs">{row.currency}</TableCell>
                            <TableCell className="text-xs">{row.provider ?? '—'}</TableCell>
                            <TableCell className="text-xs font-mono">{row.provider_payout_id?.slice(0, 12) ?? '—'}</TableCell>
                            <TableCell className="text-xs">{row.bank_reference ?? '—'}</TableCell>
                            <TableCell className="text-xs"><Badge variant="outline">{row.status}</Badge></TableCell>
                            <TableCell className="text-xs whitespace-nowrap">
                              {row.processing_started_at
                                ? format(new Date(row.processing_started_at), 'dd MMM HH:mm')
                                : '—'}
                            </TableCell>
                            <TableCell className="text-xs">
                              {row.paid_at ? format(new Date(row.paid_at), 'dd MMM HH:mm') : '—'}
                            </TableCell>
                            <TableCell className="text-xs font-mono">
                              {row.wallet_ledger_entry_id
                                ? (
                                  <Link
                                    className="underline"
                                    to={driverWalletLedgerUrl(row.driver_id, 'ledger')}
                                    title={row.wallet_ledger_entry_id}
                                  >
                                    {row.wallet_ledger_entry_id.slice(0, 8)}
                                  </Link>
                                )
                                : '—'}
                            </TableCell>
                            <TableCell className="text-xs max-w-[160px] truncate">{row.failure_reason ?? '—'}</TableCell>
                            <TableCell className="text-xs">{row.allocation_count}</TableCell>
                            <TableCell>
                              <div className="flex flex-wrap gap-1">
                                {row.action_policy.can_open_wallet && (
                                  <Button asChild size="sm" variant="outline">
                                    <Link to={driverWalletLedgerUrl(row.driver_id, 'payout_allocations')}>
                                      Wallet
                                    </Link>
                                  </Button>
                                )}
                                {row.action_policy.can_open_reconciliation && (
                                  <Button asChild size="sm" variant="outline">
                                    <Link to="/financial-reconciliation?tab=drivers">Reconciliation</Link>
                                  </Button>
                                )}
                                {row.action_policy.can_view_allocations && (
                                  <Button asChild size="sm" variant="ghost">
                                    <Link to={driverWalletLedgerUrl(row.driver_id, 'ledger')}>
                                      Allocations ({row.allocation_count})
                                    </Link>
                                  </Button>
                                )}
                                {!row.paid_at
                                  && ['PENDING', 'SCHEDULED', 'PROCESSING', 'ON_HOLD', 'QUEUED'].includes(row.status)
                                  && (
                                  <PayoutLedgerMarkPaidButton
                                    payoutItemId={row.id}
                                    amountPence={row.net_bank_transfer_pence}
                                    currencyCode={row.currency}
                                  />
                                )}
                                {row.action_policy.can_retry && (
                                  <Badge variant="secondary">Retry via backend</Badge>
                                )}
                                {row.action_policy.can_cancel && (
                                  <Badge variant="outline">Cancel via backend</Badge>
                                )}
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )
              )}
            </TabsContent>
          ))}
        </Tabs>
      </div>
    </AdminLayout>
  );
}
