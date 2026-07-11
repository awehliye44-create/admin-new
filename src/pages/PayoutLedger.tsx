import { Link, useSearchParams } from 'react-router-dom';
import { format } from 'date-fns';
import { Download, Loader2, Printer, RefreshCw } from 'lucide-react';
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
import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  PayoutLedgerCancelButton,
  PayoutLedgerCreateWeeklyBatchButton,
  PayoutLedgerMarkPaidButton,
  PayoutLedgerRetryButton,
} from '@/components/finance/PayoutLedgerActions';
import { PayoutLedgerSettingsPanel } from '@/components/finance/PayoutLedgerSettingsPanel';
import {
  DEFAULT_SERVICE_AREA_SELECTION,
  ServiceAreaFinanceFilter,
  type ServiceAreaFinanceSelection,
} from '@/components/finance/ServiceAreaFinanceFilter';
import { paymentSessionsUrl } from '../../shared/adminPaymentSessionsSSOT';

import { downloadCsv, downloadRecordsAsExcel, printFinanceReport } from '@/lib/financeExport';
import type { AdminPayoutLedgerItemRow } from '../../shared/adminPayoutLedgerSSOT';

const TABS: Array<{ id: AdminPayoutLedgerTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'scheduled', label: 'Scheduled' },
  { id: 'processing', label: 'Processing' },
  { id: 'completed', label: 'Completed' },
  { id: 'failed', label: 'Failed' },
  { id: 'returned_cancelled', label: 'Returned / Cancelled' },
  { id: 'batches', label: 'Batches' },
  { id: 'history', label: 'History' },
  { id: 'settings', label: 'Settings' },
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
  const queryClient = useQueryClient();
  const [serviceFilter, setServiceFilter] = useState<ServiceAreaFinanceSelection>(
    DEFAULT_SERVICE_AREA_SELECTION,
  );

  const request = useMemo(
    () => ({
      tab,
      driver_id: driverId,
      batch_id: batchId,
      service_area_id: serviceFilter.serviceAreaId,
      limit: 100,
    }),
    [tab, driverId, batchId, serviceFilter.serviceAreaId],
  );

  const { data, isLoading, isFetching, error, refetch, isError } = useAdminPayoutLedger(
    request,
    tab !== 'settings',
  );
  const items = data?.items ?? [];
  const batches = data?.batches ?? [];
  const summary = data?.summary;

  useEffect(() => {
    if (tab === 'settings') return;
    const channel = supabase
      .channel('payout-ledger-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'payout_items' }, () => {
        void queryClient.invalidateQueries({ queryKey: ['admin-payout-ledger'] });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'payout_batches' }, () => {
        void queryClient.invalidateQueries({ queryKey: ['admin-payout-ledger'] });
      })
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [tab, queryClient]);

  const setTab = (next: string) => {
    const params = new URLSearchParams(searchParams);
    params.set('tab', next);
    setSearchParams(params, { replace: true });
  };

  const historyRecords = () =>
    items.map((r) => ({
      batch_id: r.batch_id,
      driver: r.driver_name ?? r.driver_id,
      amount_pence: r.net_bank_transfer_pence,
      created: r.created_at,
      processed: r.processing_started_at,
      completed: r.paid_at,
      provider: r.provider,
      provider_reference: r.provider_payout_id,
      bank_reference: r.bank_reference,
      status: r.status,
      failure_reason: r.failure_reason,
    }));

  const exportHistory = () => {
    downloadCsv('payout-ledger-history.csv', historyRecords());
  };

  const exportHistoryExcel = () => {
    downloadRecordsAsExcel('payout-ledger-history', historyRecords(), 'Payout History');
  };

  const exportRow = (row: AdminPayoutLedgerItemRow) => {
    downloadCsv(`payout-item-${row.id.slice(0, 8)}.csv`, [{
      batch_id: row.batch_id,
      driver: row.driver_name ?? row.driver_id,
      amount_pence: row.net_bank_transfer_pence,
      created: row.created_at,
      processed: row.processing_started_at,
      completed: row.paid_at,
      provider: row.provider,
      provider_reference: row.provider_payout_id,
      bank_reference: row.bank_reference,
      status: row.status,
      failure_reason: row.failure_reason,
    }]);
  };

  return (
    <AdminLayout title="Payout Ledger (SSOT)">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">
              Moves Available Payout from Driver Wallet to bank/Revolut. Never recalculates earnings.
            </p>
            <div className="flex flex-wrap gap-2">
              <Badge variant={data?.page_status === 'LIVE' ? 'default' : 'secondary'}>
                {data?.page_status ?? (tab === 'settings' ? 'LIVE' : 'PARTIAL')}
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
              <Link to="/driver-wallet-ledger" className="text-xs underline text-muted-foreground self-center">
                Driver Wallet
              </Link>
              <Link to="/onecab-revenue-profit" className="text-xs underline text-muted-foreground self-center">
                ONECAB annual report
              </Link>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ServiceAreaFinanceFilter value={serviceFilter} onChange={setServiceFilter} />
            <PayoutLedgerCreateWeeklyBatchButton
              regionId={serviceFilter.regionId}
              serviceAreaId={serviceFilter.serviceAreaId}
              currencyCode={serviceFilter.currencyCode ?? 'GBP'}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const next = new URLSearchParams(searchParams);
                next.set('tab', 'scheduled');
                setSearchParams(next, { replace: true });
              }}
            >
              Manual payouts
            </Button>
            {(tab === 'history' || tab === 'completed') && (
              <>
                <Button variant="outline" size="sm" onClick={exportHistory} disabled={items.length === 0}>
                  <Download className="h-4 w-4 mr-2" />
                  CSV
                </Button>
                <Button variant="outline" size="sm" onClick={exportHistoryExcel} disabled={items.length === 0}>
                  <Download className="h-4 w-4 mr-2" />
                  Excel
                </Button>
                <Button variant="outline" size="sm" onClick={() => printFinanceReport()} disabled={items.length === 0}>
                  <Printer className="h-4 w-4 mr-2" />
                  PDF
                </Button>
              </>
            )}
            {tab !== 'settings' && isError && (
              <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching}>
                {isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                <span className="ml-2">Retry</span>
              </Button>
            )}
          </div>
        </div>

        {error && tab !== 'settings' && (
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

          <TabsContent value="settings" className="mt-4">
            <PayoutLedgerSettingsPanel serviceFilter={serviceFilter} />
          </TabsContent>

          {TABS.filter((t) => t.id !== 'settings').map((t) => (
            <TabsContent key={t.id} value={t.id} className="space-y-3">
              {t.id === 'overview' && summary && (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5">
                  <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Scheduled Today</CardTitle></CardHeader><CardContent className="text-xl font-semibold">{summary.scheduled_today_count ?? 0}</CardContent></Card>
                  <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Paid Today</CardTitle></CardHeader><CardContent className="text-xl font-semibold">{formatNullablePence(summary.paid_today_pence)} <span className="text-xs text-muted-foreground">({summary.paid_today_count ?? 0})</span></CardContent></Card>
                  <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Pending</CardTitle></CardHeader><CardContent className="text-xl font-semibold">{summary.pending_count ?? summary.scheduled_count}</CardContent></Card>
                  <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Processing</CardTitle></CardHeader><CardContent className="text-xl font-semibold">{summary.processing_count}</CardContent></Card>
                  <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Failed</CardTitle></CardHeader><CardContent className="text-xl font-semibold">{summary.failed_count}</CardContent></Card>
                  <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Returned</CardTitle></CardHeader><CardContent className="text-xl font-semibold">{summary.returned_cancelled_count}</CardContent></Card>
                  <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Total Paid This Week</CardTitle></CardHeader><CardContent className="text-xl font-semibold">{formatNullablePence(summary.total_paid_week_pence)}</CardContent></Card>
                  <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Total Paid This Month</CardTitle></CardHeader><CardContent className="text-xl font-semibold">{formatNullablePence(summary.total_paid_month_pence)}</CardContent></Card>
                  <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Total Paid This Year</CardTitle></CardHeader><CardContent className="text-xl font-semibold">{formatNullablePence(summary.total_paid_year_pence)}</CardContent></Card>
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
                          <TableHead>Batch ID</TableHead>
                          <TableHead>Created</TableHead>
                          <TableHead>Driver</TableHead>
                          <TableHead>Verification</TableHead>
                          <TableHead>Bank</TableHead>
                          <TableHead>Amount</TableHead>
                          <TableHead>Processed</TableHead>
                          <TableHead>Completed</TableHead>
                          <TableHead>Provider</TableHead>
                          <TableHead>Provider Ref</TableHead>
                          <TableHead>Bank Ref</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Failure</TableHead>
                          <TableHead>Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {items.map((row) => (
                          <TableRow key={row.id}>
                            <TableCell className="text-xs font-mono">{row.batch_id?.slice(0, 8) ?? '—'}</TableCell>
                            <TableCell className="text-xs whitespace-nowrap">
                              {format(new Date(row.created_at), 'dd MMM HH:mm')}
                            </TableCell>
                            <TableCell className="text-xs">{row.driver_name ?? row.driver_id.slice(0, 8)}</TableCell>
                            <TableCell className="text-xs">{row.verification_status ?? '—'}</TableCell>
                            <TableCell className="text-xs">
                              {row.bank_account_last4 ? `•••• ${row.bank_account_last4}` : '—'}
                            </TableCell>
                            <TableCell className="text-xs">{formatNullablePence(row.net_bank_transfer_pence, row.currency)}</TableCell>
                            <TableCell className="text-xs whitespace-nowrap">
                              {row.processing_started_at
                                ? format(new Date(row.processing_started_at), 'dd MMM HH:mm')
                                : '—'}
                            </TableCell>
                            <TableCell className="text-xs">
                              {row.paid_at ? format(new Date(row.paid_at), 'dd MMM HH:mm') : '—'}
                            </TableCell>
                            <TableCell className="text-xs">{row.provider ?? '—'}</TableCell>
                            <TableCell className="text-xs font-mono">{row.provider_payout_id?.slice(0, 12) ?? '—'}</TableCell>
                            <TableCell className="text-xs">{row.bank_reference ?? '—'}</TableCell>
                            <TableCell className="text-xs"><Badge variant="outline">{row.status}</Badge></TableCell>
                            <TableCell className="text-xs max-w-[160px] truncate">{row.failure_reason ?? '—'}</TableCell>
                            <TableCell>
                              <div className="flex flex-wrap gap-1">
                                <Button asChild size="sm" variant="outline">
                                  <Link to={driverWalletLedgerUrl(row.driver_id, 'payout_allocations')}>
                                    View
                                  </Link>
                                </Button>
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
                                  <PayoutLedgerRetryButton payoutItemId={row.id} />
                                )}
                                {row.action_policy.can_cancel && (
                                  <PayoutLedgerCancelButton payoutItemId={row.id} />
                                )}
                                <Button size="sm" variant="ghost" onClick={() => exportRow(row)}>
                                  CSV
                                </Button>
                                <Button size="sm" variant="ghost" onClick={() => printFinanceReport()}>
                                  PDF
                                </Button>
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
