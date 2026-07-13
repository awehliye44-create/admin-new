import { Link, useSearchParams } from 'react-router-dom';
import { format } from 'date-fns';
import { ArrowLeft, Download, Loader2, MoreHorizontal, Printer, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
  DEFAULT_SERVICE_AREA_SELECTION,
  ServiceAreaFinanceFilter,
  type ServiceAreaFinanceSelection,
} from '@/components/finance/ServiceAreaFinanceFilter';
import {
  PayoutLedgerCancelButton,
  PayoutLedgerCreateWeeklyBatchButton,
  PayoutLedgerMarkPaidButton,
  PayoutLedgerRetryButton,
} from '@/components/finance/PayoutLedgerActions';
import { PayoutLedgerSettingsPanel } from '@/components/finance/PayoutLedgerSettingsPanel';
import { PayoutLedgerCompanyTransfersPanel } from '@/components/finance/PayoutLedgerCompanyTransfersPanel';
import { PayoutLedgerOverviewPanel } from '@/components/finance/PayoutLedgerOverviewPanel';
import { useAdminPayoutLedger } from '@/hooks/useAdminPayoutLedger';
import { supabase } from '@/integrations/supabase/client';
import { driverWalletLedgerUrl } from '@/lib/driverWalletLedgerRoutes';
import { downloadCsv, downloadRecordsAsExcel, printFinanceReport, printFinanceRecords } from '@/lib/financeExport';
import { formatNullablePence } from '@/lib/formatNullablePence';
import { paymentSessionsUrl } from '../../shared/adminPaymentSessionsSSOT';
import { payoutLedgerUrl } from '../../shared/adminPayoutLedgerSSOT';
import type {
  AdminPayoutLedgerDriverTab,
  AdminPayoutLedgerItemRow,
  AdminPayoutLedgerTopTab,
  DriverPayoutAccountRow,
} from '../../shared/adminPayoutLedgerSSOT';

const TOP_TABS: Array<{ id: AdminPayoutLedgerTopTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'driver_payouts', label: 'Driver Payouts' },
  { id: 'company_transfers', label: 'Company Transfers' },
  { id: 'batch_history', label: 'Batch History' },
  { id: 'failed_transfers', label: 'Failed Transfers' },
  { id: 'settings', label: 'Settings' },
  { id: 'audit_history', label: 'Audit History' },
];

const DRIVER_TABS: Array<{ id: AdminPayoutLedgerDriverTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'scheduled', label: 'Scheduled' },
  { id: 'history', label: 'Payout History' },
  { id: 'transfers', label: 'Transfers' },
  { id: 'failures', label: 'Failures' },
  { id: 'connected_account', label: 'Payout Destination' },
  { id: 'statements', label: 'Statements' },
  { id: 'audit_log', label: 'Audit Log' },
  { id: 'settings', label: 'Settings' },
];

const LEGACY_DRIVER_TOP: Record<string, AdminPayoutLedgerTopTab> = {
  scheduled: 'driver_payouts',
  processing: 'driver_payouts',
  completed: 'driver_payouts',
  failed: 'failed_transfers',
  failures: 'failed_transfers',
  batches: 'batch_history',
  history: 'driver_payouts',
  transfers: 'driver_payouts',
  connected_account: 'driver_payouts',
  statements: 'driver_payouts',
  audit_log: 'audit_history',
};

function parseTopTab(raw: string | null, hasDriver: boolean): AdminPayoutLedgerTopTab {
  if (hasDriver) return 'driver_payouts';
  if (raw && TOP_TABS.some((t) => t.id === raw)) return raw as AdminPayoutLedgerTopTab;
  if (raw && LEGACY_DRIVER_TOP[raw]) return LEGACY_DRIVER_TOP[raw];
  return 'overview';
}

function parseDriverTab(raw: string | null, topTab: string | null): AdminPayoutLedgerDriverTab {
  if (raw && DRIVER_TABS.some((t) => t.id === raw)) return raw as AdminPayoutLedgerDriverTab;
  if (topTab && DRIVER_TABS.some((t) => t.id === topTab)) return topTab as AdminPayoutLedgerDriverTab;
  return 'overview';
}

function shortDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : format(date, 'dd MMM HH:mm');
}

function statementRecords(items: AdminPayoutLedgerItemRow[]) {
  return items.map((r) => ({
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
}

export default function PayoutLedger() {
  const [searchParams, setSearchParams] = useSearchParams();
  const driverId = searchParams.get('driverId');
  const batchId = searchParams.get('batchId');
  const topTab = parseTopTab(searchParams.get('tab'), Boolean(driverId));
  const driverTab = parseDriverTab(searchParams.get('driverTab'), searchParams.get('tab'));
  const queryClient = useQueryClient();
  const [serviceFilter, setServiceFilter] = useState<ServiceAreaFinanceSelection>(
    DEFAULT_SERVICE_AREA_SELECTION,
  );

  const listRequest = useMemo(() => {
    if (topTab === 'overview') {
      return {
        mode: 'ledger_overview' as const,
        tab: 'overview' as const,
        service_area_id: serviceFilter.serviceAreaId,
        limit: 100,
      };
    }
    if (topTab === 'company_transfers') {
      return {
        mode: 'company_list' as const,
        tab: 'company_transfers' as const,
        service_area_id: serviceFilter.serviceAreaId,
        limit: 100,
      };
    }
    if (topTab === 'failed_transfers') {
      return {
        mode: 'company_failed' as const,
        tab: 'failed_transfers' as const,
        service_area_id: serviceFilter.serviceAreaId,
        limit: 100,
      };
    }
    if (topTab === 'batch_history') {
      return {
        mode: 'company_batches' as const,
        tab: 'batch_history' as const,
        service_area_id: serviceFilter.serviceAreaId,
        limit: 100,
      };
    }
    if (topTab === 'audit_history') {
      return {
        mode: 'company_audit' as const,
        tab: 'audit_history' as const,
        limit: 100,
      };
    }
    return {
      mode: driverId ? 'list' as const : 'accounts_overview' as const,
      tab: driverId ? driverTab : 'driver_payouts' as const,
      driver_id: driverId,
      batch_id: batchId,
      service_area_id: serviceFilter.serviceAreaId,
      limit: 100,
    };
  }, [topTab, driverTab, driverId, batchId, serviceFilter.serviceAreaId]);

  const accountRequest = useMemo(
    () => ({
      mode: 'accounts_overview' as const,
      tab: 'driver_payouts' as const,
      driver_id: driverId,
      service_area_id: serviceFilter.serviceAreaId,
      limit: 1,
    }),
    [driverId, serviceFilter.serviceAreaId],
  );

  const listEnabled = topTab !== 'settings';
  const { data, isLoading, isFetching, error, refetch, isError } = useAdminPayoutLedger(
    listRequest,
    listEnabled,
  );
  const { data: accountData } = useAdminPayoutLedger(accountRequest, Boolean(driverId));
  const items = data?.items ?? [];
  const batches = data?.batches ?? [];
  const accounts = data?.accounts ?? [];
  const auditRows = data?.audit_rows ?? [];
  const companyTransfers = data?.company_transfers ?? [];
  const companyBatches = data?.company_batches ?? [];
  const companyAuditRows = data?.company_audit_rows ?? [];
  const overview = data?.overview_summary;
  const companyBalance = data?.company_balance ?? overview?.company_balance ?? null;
  const account = accountData?.accounts?.[0] ?? accounts.find((row) => row.driver_id === driverId) ?? null;
  const summary = data?.summary;
  const fleet = data?.fleet_summary;
  const ledgerErrorCode = data?.error_code
    ?? (error instanceof Error && /permission|403|401/i.test(error.message)
      ? 'PAYOUT_LEDGER_PERMISSION_DENIED'
      : null);

  useEffect(() => {
    if (topTab === 'settings') return;
    const channel = supabase
      .channel('payout-ledger-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'payout_items' }, () => {
        void queryClient.invalidateQueries({ queryKey: ['admin-payout-ledger'] });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'payout_batches' }, () => {
        void queryClient.invalidateQueries({ queryKey: ['admin-payout-ledger'] });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'company_outgoing_transfers' }, () => {
        void queryClient.invalidateQueries({ queryKey: ['admin-payout-ledger'] });
      })
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [topTab, queryClient]);

  const setTopTab = (next: string) => {
    const params = new URLSearchParams(searchParams);
    params.set('tab', next);
    params.delete('driverId');
    params.delete('driverTab');
    setSearchParams(params, { replace: true });
  };

  const setDriverTab = (next: string) => {
    const params = new URLSearchParams(searchParams);
    params.set('tab', 'driver_payouts');
    params.set('driverTab', next);
    setSearchParams(params, { replace: true });
  };

  const openAccount = (row: DriverPayoutAccountRow, nextTab: AdminPayoutLedgerDriverTab = 'overview') => {
    const params = new URLSearchParams(searchParams);
    params.set('tab', 'driver_payouts');
    params.set('driverId', row.driver_id);
    params.set('driverTab', nextTab);
    setSearchParams(params, { replace: true });
  };

  const backToFleet = () => {
    const params = new URLSearchParams(searchParams);
    params.delete('driverId');
    params.delete('driverTab');
    params.set('tab', 'driver_payouts');
    setSearchParams(params, { replace: true });
  };

  const updatePayoutPause = async (row: DriverPayoutAccountRow) => {
    const action = row.paused ? 'resume' : 'pause';
    if (!window.confirm(`Confirm ${action} payouts for ${row.name ?? row.code ?? row.driver_id}?`)) return;
    const { error: updateError } = await supabase
      .from('drivers')
      .update({ payouts_enabled: row.paused })
      .eq('id', row.driver_id);
    if (updateError) throw updateError;
    await queryClient.invalidateQueries({ queryKey: ['admin-payout-ledger'] });
  };

  const exportItemsCsv = (filename = 'payout-ledger-history.csv') => {
    downloadCsv(filename, statementRecords(items));
  };

  const exportAccountStatement = (row: DriverPayoutAccountRow) => {
    downloadCsv(`payout-account-${row.driver_id.slice(0, 8)}.csv`, [{
      driver_id: row.driver_id,
      name: row.name,
      code: row.code,
      available_balance_pence: row.available_balance_pence,
      pending_balance_pence: row.pending_balance_pence,
      debt_pence: row.debt_pence,
      payout_status: row.payout_status,
      verification: row.verification,
    }]);
  };

  const exportRow = (row: AdminPayoutLedgerItemRow) => {
    downloadCsv(`payout-item-${row.id.slice(0, 8)}.csv`, statementRecords([row]));
  };

  return (
    <AdminLayout title="Payout Ledger (SSOT)">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">
              ALL outgoing money SSOT: driver payouts (from Driver Wallet available) and company transfers (from Company Balance / payables). Never customer payments or FR execution.
            </p>
            <div className="flex flex-wrap gap-2">
              <Badge variant={data?.page_status === 'LIVE' || topTab === 'settings' ? 'default' : 'secondary'}>
                {data?.page_status ?? (topTab === 'settings' ? 'LIVE' : 'PARTIAL')}
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
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ServiceAreaFinanceFilter value={serviceFilter} onChange={setServiceFilter} />
            {topTab === 'driver_payouts' && (
              <PayoutLedgerCreateWeeklyBatchButton
                regionId={serviceFilter.regionId}
                serviceAreaId={serviceFilter.serviceAreaId}
                currencyCode={serviceFilter.currencyCode ?? 'GBP'}
              />
            )}
            {topTab !== 'settings' && isError && (
              <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching}>
                {isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                <span className="ml-2">Retry</span>
              </Button>
            )}
          </div>
        </div>

        {error && topTab !== 'settings' && data?.page_status !== 'PARTIAL' && data?.page_status !== 'DEGRADED' && (
          <Alert variant="destructive">
            <AlertTitle>Payout Ledger failed to load</AlertTitle>
            <AlertDescription>{error instanceof Error ? error.message : String(error)}</AlertDescription>
          </Alert>
        )}
        {!error && data?.page_status === 'PARTIAL' && data?.error_code && topTab !== 'settings' && (
          <Alert>
            <AlertTitle>Payout Ledger partial</AlertTitle>
            <AlertDescription>
              Some sections are unavailable ({data.error_code}). Other tabs remain readable.
            </AlertDescription>
          </Alert>
        )}

        <Tabs value={topTab} onValueChange={setTopTab}>
          <TabsList className="flex h-auto flex-wrap">
            {TOP_TABS.map((t) => (
              <TabsTrigger key={t.id} value={t.id}>{t.label}</TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="overview" className="mt-4 space-y-4">
            <PayoutLedgerOverviewPanel
              overview={overview}
              companyBalance={companyBalance}
              isLoading={isLoading}
              isError={isError && !overview}
              errorCode={ledgerErrorCode}
              errorMessage={error instanceof Error ? error.message : error ? String(error) : null}
              onRetry={() => void refetch()}
              isFetching={isFetching}
            />
          </TabsContent>

          <TabsContent value="company_transfers" className="mt-4">
            <PayoutLedgerCompanyTransfersPanel
              transfers={companyTransfers}
              isLoading={isLoading}
              serviceAreaId={serviceFilter.serviceAreaId}
              companyBalance={companyBalance}
              kpis={data?.company_transfer_kpis ?? null}
            />
          </TabsContent>

          <TabsContent value="failed_transfers" className="mt-4 space-y-4">
            <PayoutLedgerCompanyTransfersPanel
              transfers={companyTransfers}
              isLoading={isLoading}
              failedOnly
              serviceAreaId={serviceFilter.serviceAreaId}
              companyBalance={companyBalance}
              kpis={data?.company_transfer_kpis ?? null}
            />
            {items.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-sm font-medium">Failed driver payouts</h3>
                <PayoutItemsTable items={items} exportRow={exportRow} />
              </div>
            )}
          </TabsContent>

          <TabsContent value="batch_history" className="mt-4 space-y-4">
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={companyBatches.length === 0 && batches.length === 0}
                onClick={() => {
                  downloadCsv('payout-batch-history.csv', [
                    ...companyBatches.map((b) => ({
                      scope: 'company',
                      batch_id: b.batch_ref,
                      execution_time: b.started_at ?? b.created_at,
                      transfer_count: b.transfer_count,
                      success_count: b.success_count,
                      failed_count: b.failed_count,
                      provider: b.provider,
                      duration_ms: b.duration_ms,
                      status: b.status,
                    })),
                    ...batches.map((b) => ({
                      scope: 'driver',
                      batch_id: b.id,
                      execution_time: b.created_at,
                      transfer_count: b.total_drivers,
                      success_count: b.successful_payouts,
                      failed_count: b.failed_payouts,
                      provider: b.kind,
                      duration_ms: null,
                      status: b.status,
                    })),
                  ]);
                }}
              >
                <Download className="h-4 w-4 mr-2" /> Download report
              </Button>
            </div>
            <div className="space-y-2">
              <h3 className="text-sm font-medium">Company batches</h3>
              {companyBatches.length === 0 ? (
                <Alert><AlertTitle>No company batches yet</AlertTitle></Alert>
              ) : (
                <div className="overflow-x-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Batch ID</TableHead>
                        <TableHead>Execution Time</TableHead>
                        <TableHead>Transfer Count</TableHead>
                        <TableHead>Success Count</TableHead>
                        <TableHead>Failed Count</TableHead>
                        <TableHead>Provider</TableHead>
                        <TableHead>Duration</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {companyBatches.map((b) => (
                        <TableRow key={b.id}>
                          <TableCell className="text-xs font-mono">{b.batch_ref}</TableCell>
                          <TableCell className="text-xs">{shortDate(b.started_at ?? b.created_at)}</TableCell>
                          <TableCell className="text-xs">{b.transfer_count}</TableCell>
                          <TableCell className="text-xs">{b.success_count}</TableCell>
                          <TableCell className="text-xs">{b.failed_count}</TableCell>
                          <TableCell className="text-xs">{b.provider ?? '—'}</TableCell>
                          <TableCell className="text-xs">{b.duration_ms == null ? '—' : `${b.duration_ms} ms`}</TableCell>
                          <TableCell className="text-xs"><Badge variant="outline">{b.status}</Badge></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
            <div className="space-y-2">
              <h3 className="text-sm font-medium">Driver payout batches</h3>
              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Batch ID</TableHead>
                      <TableHead>Execution Time</TableHead>
                      <TableHead>Transfer Count</TableHead>
                      <TableHead>Success Count</TableHead>
                      <TableHead>Failed Count</TableHead>
                      <TableHead>Provider</TableHead>
                      <TableHead>Duration</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {batches.map((b) => (
                      <TableRow key={b.id}>
                        <TableCell className="text-xs font-mono">{b.id.slice(0, 8)}</TableCell>
                        <TableCell className="text-xs">{shortDate(b.created_at)}</TableCell>
                        <TableCell className="text-xs">{b.total_drivers ?? '—'}</TableCell>
                        <TableCell className="text-xs">{b.successful_payouts ?? '—'}</TableCell>
                        <TableCell className="text-xs">{b.failed_payouts ?? '—'}</TableCell>
                        <TableCell className="text-xs">{b.kind}</TableCell>
                        <TableCell className="text-xs">—</TableCell>
                        <TableCell className="text-xs"><Badge variant="outline">{b.status}</Badge></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="audit_history" className="mt-4 space-y-3">
            {companyAuditRows.length === 0 ? (
              <Alert>
                <AlertTitle>No company transfer audit events yet</AlertTitle>
                <AlertDescription>Append-only audit rows appear after create/approve/pay actions. Never deleted.</AlertDescription>
              </Alert>
            ) : (
              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                        <TableHead>Timestamp</TableHead>
                        <TableHead>Transfer ID</TableHead>
                        <TableHead>Requester</TableHead>
                        <TableHead>Approver</TableHead>
                        <TableHead>Event</TableHead>
                        <TableHead>Old → New</TableHead>
                        <TableHead>Amount</TableHead>
                        <TableHead>Currency</TableHead>
                        <TableHead>Provider</TableHead>
                        <TableHead>Provider Reference</TableHead>
                        <TableHead>Reason</TableHead>
                        <TableHead>Attachment</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {companyAuditRows.map((row) => (
                        <TableRow key={row.id}>
                          <TableCell className="text-xs">{shortDate(row.created_at)}</TableCell>
                          <TableCell className="text-xs font-mono">{row.transfer_id.slice(0, 8)}</TableCell>
                          <TableCell className="text-xs font-mono">{row.actor_id?.slice(0, 8) ?? '—'}</TableCell>
                          <TableCell className="text-xs font-mono">—</TableCell>
                          <TableCell className="text-xs"><Badge variant="outline">{row.event_type}</Badge></TableCell>
                          <TableCell className="text-xs">{row.old_status ?? '—'} → {row.new_status ?? '—'}</TableCell>
                          <TableCell className="text-xs tabular-nums">{formatNullablePence(row.amount_pence)}</TableCell>
                          <TableCell className="text-xs">{row.currency ?? '—'}</TableCell>
                          <TableCell className="text-xs">{row.provider ?? '—'}</TableCell>
                          <TableCell className="text-xs font-mono">{row.provider_reference ?? '—'}</TableCell>
                          <TableCell className="text-xs max-w-[180px] truncate">{row.reason ?? '—'}</TableCell>
                          <TableCell className="text-xs max-w-[120px] truncate">{row.attachment_url ?? '—'}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                </Table>
              </div>
            )}
          </TabsContent>

          <TabsContent value="settings" className="mt-4">
            <PayoutLedgerSettingsPanel serviceFilter={serviceFilter} />
          </TabsContent>

          <TabsContent value="driver_payouts" className="mt-4 space-y-4">
        {!driverId && (
          <div className="space-y-4">
            {fleet && (
              <div className="grid gap-3 grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Total Live Driver Wallet</CardTitle></CardHeader><CardContent className="text-xl font-semibold tabular-nums">{formatNullablePence(fleet.total_live_wallet_pence ?? null)}</CardContent></Card>
                <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Total Available for Payout</CardTitle></CardHeader><CardContent className="text-xl font-semibold tabular-nums">{formatNullablePence(fleet.total_available_pence)}</CardContent></Card>
                <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Total Pending / Held</CardTitle></CardHeader><CardContent className="text-xl font-semibold tabular-nums">{formatNullablePence(fleet.total_pending_pence ?? null)}</CardContent></Card>
                <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Total Outstanding Debt</CardTitle></CardHeader><CardContent className="text-xl font-semibold tabular-nums">{formatNullablePence(fleet.total_outstanding_debt_pence ?? null)}</CardContent></Card>
                <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Next Batch Amount</CardTitle></CardHeader><CardContent className="text-xl font-semibold tabular-nums">{formatNullablePence(fleet.next_batch_amount_pence)}</CardContent></Card>
                <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Eligible Driver Count</CardTitle></CardHeader><CardContent className="text-xl font-semibold tabular-nums">{fleet.eligible_driver_count ?? fleet.next_batch_driver_count}</CardContent></Card>
                <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Held Driver Count</CardTitle></CardHeader><CardContent className="text-xl font-semibold tabular-nums">{fleet.held_driver_count ?? 0}</CardContent></Card>
                <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Scheduled Payouts</CardTitle></CardHeader><CardContent className="text-xl font-semibold tabular-nums">{fleet.scheduled_payouts_count ?? 0} · {formatNullablePence(fleet.total_scheduled_pence)}</CardContent></Card>
                <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Processing Payouts</CardTitle></CardHeader><CardContent className="text-xl font-semibold tabular-nums">{fleet.processing_payouts_count ?? 0} · {formatNullablePence(fleet.total_processing_pence)}</CardContent></Card>
                <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Completed Payouts</CardTitle></CardHeader><CardContent className="text-xl font-semibold tabular-nums">{fleet.completed_payouts_count ?? 0}</CardContent></Card>
                <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Paid Today</CardTitle></CardHeader><CardContent className="text-xl font-semibold tabular-nums">{formatNullablePence(fleet.paid_today_pence)}</CardContent></Card>
                <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Paid This Week</CardTitle></CardHeader><CardContent className="text-xl font-semibold tabular-nums">{formatNullablePence(fleet.paid_week_pence)}</CardContent></Card>
                <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Paid This Month</CardTitle></CardHeader><CardContent className="text-xl font-semibold tabular-nums">{formatNullablePence(fleet.paid_month_pence)}</CardContent></Card>
                <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Failed Payouts</CardTitle></CardHeader><CardContent className="text-xl font-semibold tabular-nums">{fleet.failed_count}</CardContent></Card>
              </div>
            )}

            {fleet?.zero_batch_guard ? (
              <Alert>
                <AlertTitle>No eligible payouts</AlertTitle>
                <AlertDescription>
                  Zero-batch guard: <span className="font-mono">{fleet.zero_batch_guard}</span>. Next weekly batch will not be created until Available &gt; 0 for at least one driver.
                </AlertDescription>
              </Alert>
            ) : null}

            {fleet && fleet.failed_count > 0 && items.length > 0 && (
              <Alert variant="destructive">
                <AlertTitle>Failed payout alerts</AlertTitle>
                <AlertDescription>
                  {items.slice(0, 5).map((row) => (
                    <div key={row.id} className="text-xs">
                      {row.driver_name ?? row.driver_id.slice(0, 8)} · {formatNullablePence(row.net_bank_transfer_pence)} · {row.failure_reason ?? row.status}
                    </div>
                  ))}
                </AlertDescription>
              </Alert>
            )}

            {batches.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-sm font-medium">Recent batches</h3>
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
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {batches.map((b) => (
                        <TableRow key={b.id}>
                          <TableCell className="text-xs">{shortDate(b.created_at)}</TableCell>
                          <TableCell className="text-xs">{b.run_date}</TableCell>
                          <TableCell className="text-xs">{b.kind}</TableCell>
                          <TableCell className="text-xs"><Badge variant="outline">{b.status}</Badge></TableCell>
                          <TableCell className="text-xs">{b.total_drivers ?? '—'}</TableCell>
                          <TableCell className="text-xs">{formatNullablePence(b.total_amount_pence)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}

            {isLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading payout accounts...
              </div>
            ) : accounts.length === 0 ? (
              <Alert>
                <AlertTitle>No payout accounts match the selected filters.</AlertTitle>
                <AlertDescription>Driver accounts will appear here once available from Driver Wallet Ledger.</AlertDescription>
              </Alert>
            ) : (
              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Driver</TableHead>
                      <TableHead>Service Area</TableHead>
                      <TableHead>Tier</TableHead>
                      <TableHead>Provider</TableHead>
                      <TableHead>Payout Destination</TableHead>
                      <TableHead>Verification</TableHead>
                      <TableHead>Live Wallet</TableHead>
                      <TableHead>Available</TableHead>
                      <TableHead>Pending/Held</TableHead>
                      <TableHead>Debt</TableHead>
                      <TableHead>Hold Reason</TableHead>
                      <TableHead>Eligible Entries</TableHead>
                      <TableHead>Next Scheduled</TableHead>
                      <TableHead>Last Payout</TableHead>
                      <TableHead>Schedule</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {accounts.map((row) => (
                      <TableRow
                        key={row.driver_id}
                        className="cursor-pointer hover:bg-muted/40"
                        onClick={() => openAccount(row)}
                      >
                        <TableCell className="text-xs">
                          <div className="font-medium">{row.name ?? row.driver_id.slice(0, 8)}</div>
                          <div className="text-muted-foreground">{row.code ?? '—'}</div>
                        </TableCell>
                        <TableCell className="text-xs">{row.service_area ?? '—'}</TableCell>
                        <TableCell className="text-xs">{row.tier ?? '—'}</TableCell>
                        <TableCell className="text-xs">{row.provider ?? '—'}</TableCell>
                        <TableCell className="text-xs font-mono">
                          {row.payout_destination ?? row.connected_account?.slice(0, 12) ?? '—'}
                        </TableCell>
                        <TableCell className="text-xs">{row.verification ?? '—'}</TableCell>
                        <TableCell className="text-xs">{formatNullablePence(row.live_balance_pence ?? null)}</TableCell>
                        <TableCell className="text-xs font-semibold">{formatNullablePence(row.available_balance_pence)}</TableCell>
                        <TableCell className="text-xs">{formatNullablePence(row.pending_balance_pence)}</TableCell>
                        <TableCell className="text-xs">{formatNullablePence(row.debt_pence)}</TableCell>
                        <TableCell className="text-[10px] text-muted-foreground max-w-[140px]">
                          {row.unavailable_reason ?? '—'}
                        </TableCell>
                        <TableCell className="text-xs tabular-nums">{row.eligible_entry_count ?? 0}</TableCell>
                        <TableCell className="text-xs">{row.next_scheduled_local ?? '—'}</TableCell>
                        <TableCell className="text-xs">{shortDate(row.last_payout_at)}</TableCell>
                        <TableCell className="text-xs">{row.schedule_label ?? '—'}</TableCell>
                        <TableCell className="text-xs"><Badge variant={row.paused ? 'destructive' : 'outline'}>{row.payout_status}</Badge></TableCell>
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="sm" aria-label="Payout account actions">
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuLabel>Account actions</DropdownMenuLabel>
                              <DropdownMenuItem onClick={() => openAccount(row)}>Open payout account</DropdownMenuItem>
                              <DropdownMenuItem onClick={() => openAccount(row, 'history')}>View payout history</DropdownMenuItem>
                              <DropdownMenuItem onClick={() => openAccount(row, 'scheduled')}>
                                Create manual payout
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => void updatePayoutPause(row)}>
                                {row.paused ? 'Resume payouts' : 'Pause payouts'}
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => openAccount(row, 'failures')}>Retry failed payout</DropdownMenuItem>
                              <DropdownMenuItem onClick={() => openAccount(row, 'connected_account')}>
                                View payout destination
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem onClick={() => exportAccountStatement(row)}>
                                Download statement
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => printFinanceReport()}>Print statement</DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        )}

        {driverId && (
          <div className="space-y-4">
            <div className="rounded-md border p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-2">
                  <Button variant="ghost" size="sm" onClick={backToFleet} className="mb-1 px-0">
                    <ArrowLeft className="h-4 w-4 mr-2" /> Back to payout accounts
                  </Button>
                  <h2 className="text-lg font-semibold">{account?.name ?? driverId.slice(0, 8)}</h2>
                  <div className="grid gap-1 text-sm text-muted-foreground sm:grid-cols-2">
                    <div>Driver ID: <span className="font-mono text-foreground">{driverId}</span></div>
                    <div>Driver Code: {account?.code ?? '—'}</div>
                    <div>Driver Tier: {account?.tier ?? '—'}</div>
                    <div>Service Area: {account?.service_area ?? '—'}</div>
                    <div>Payout Provider: {account?.provider ?? '—'}</div>
                    <div>Payout Destination: <span className="font-mono text-foreground">{account?.payout_destination ?? account?.connected_account ?? '—'}</span></div>
                    <div>Account Verification: {account?.verification ?? '—'}</div>
                    <div>Bank Account Status: {account?.verification === 'manual_bank' || account?.verification === 'connected' ? 'Ready' : 'Not set'}</div>
                    <div>Payout Status: {account?.payout_status ?? '—'}</div>
                    <div>Eligible Entries: {account?.eligible_entry_count ?? 0}</div>
                    <div>Live Wallet: {formatNullablePence(account?.live_balance_pence ?? null)}</div>
                    <div>Wallet Available: {formatNullablePence(account?.available_balance_pence ?? null)}</div>
                    <div>Wallet Pending/Held: {formatNullablePence(account?.pending_balance_pence ?? null)}</div>
                    <div>Outstanding Debt: {formatNullablePence(account?.debt_pence ?? null)}</div>
                    {account?.unavailable_reason ? (
                      <div className="text-amber-700">Hold reason: {account.unavailable_reason}</div>
                    ) : null}
                    <div>Next Scheduled: {account?.next_scheduled_local ?? '—'}</div>
                    <div>Last Successful: {shortDate(account?.last_payout_at)} ({formatNullablePence(account?.last_payout_amount_pence ?? null)})</div>
                    <div>Schedule: {account?.schedule_label ?? '—'}</div>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 text-sm">
                  <Badge variant="outline">Available {formatNullablePence(account?.available_balance_pence ?? null)}</Badge>
                  <Badge variant={account?.paused ? 'destructive' : 'secondary'}>{account?.payout_status ?? 'loading'}</Badge>
                  <Badge variant="outline">{account?.verification ?? 'verification unknown'}</Badge>
                </div>
              </div>
            </div>

            <Tabs value={driverTab} onValueChange={setDriverTab}>
              <TabsList className="flex h-auto flex-wrap">
                {DRIVER_TABS.map((t) => (
                  <TabsTrigger key={t.id} value={t.id}>{t.label}</TabsTrigger>
                ))}
              </TabsList>

              <TabsContent value="settings" className="mt-4">
                <PayoutLedgerSettingsPanel serviceFilter={serviceFilter} />
              </TabsContent>

              <TabsContent value="connected_account" className="mt-4">
                <Card>
                  <CardHeader><CardTitle className="text-base">Payout Destination</CardTitle></CardHeader>
                  <CardContent className="space-y-2 text-sm">
                    <div>Destination: <span className="font-mono">{account?.payout_destination ?? account?.connected_account ?? '—'}</span></div>
                    <div>Provider: {account?.provider ?? '—'}</div>
                    <div>Verification: {account?.verification ?? '—'}</div>
                    <div>Payouts: {account?.paused ? 'Paused' : 'Enabled'}</div>
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="statements" className="mt-4 space-y-3">
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => exportItemsCsv(`payout-statement-${driverId.slice(0, 8)}.csv`)} disabled={items.length === 0}>
                    <Download className="h-4 w-4 mr-2" /> CSV
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => downloadRecordsAsExcel('payout-statement', statementRecords(items), 'Payout Statement')} disabled={items.length === 0}>
                    <Download className="h-4 w-4 mr-2" /> Excel
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => printFinanceReport()} disabled={items.length === 0}>
                    <Printer className="h-4 w-4 mr-2" /> Print
                  </Button>
                </div>
                <PayoutItemsTable items={items} exportRow={exportRow} />
              </TabsContent>

              <TabsContent value="audit_log" className="mt-4 space-y-3">
                {isLoading ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading audit log...
                  </div>
                ) : auditRows.length === 0 ? (
                  <Alert>
                    <AlertTitle>No payout audit events yet</AlertTitle>
                    <AlertDescription>
                      Append-only `payout_audit_log` rows for this driver will appear here. Item history below remains permanent.
                    </AlertDescription>
                  </Alert>
                ) : (
                  <div className="overflow-x-auto rounded-md border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>When</TableHead>
                          <TableHead>Event</TableHead>
                          <TableHead>Type</TableHead>
                          <TableHead>Amount</TableHead>
                          <TableHead>Provider error</TableHead>
                          <TableHead>Message</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {auditRows.map((row) => (
                          <TableRow key={row.id}>
                            <TableCell className="text-xs">{shortDate(row.created_at)}</TableCell>
                            <TableCell className="text-xs"><Badge variant="outline">{row.event_type}</Badge></TableCell>
                            <TableCell className="text-xs">{row.payout_type ?? '—'}</TableCell>
                            <TableCell className="text-xs tabular-nums">{formatNullablePence(row.requested_amount_pence)}</TableCell>
                            <TableCell className="text-xs font-mono">{row.provider_error_code ?? '—'}</TableCell>
                            <TableCell className="text-xs max-w-[280px] truncate">{row.provider_error_message ?? '—'}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
                <PayoutItemsTable items={items} exportRow={exportRow} />
              </TabsContent>

              {DRIVER_TABS
                .filter((t) => !['settings', 'connected_account', 'statements', 'audit_log'].includes(t.id))
                .map((t) => (
                  <TabsContent key={t.id} value={t.id} className="space-y-3">
                    {t.id === 'overview' && summary && (
                      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                        <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Pending</CardTitle></CardHeader><CardContent className="text-xl font-semibold">{summary.pending_count}</CardContent></Card>
                        <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Processing</CardTitle></CardHeader><CardContent className="text-xl font-semibold">{summary.processing_count}</CardContent></Card>
                        <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Paid Week</CardTitle></CardHeader><CardContent className="text-xl font-semibold">{formatNullablePence(summary.total_paid_week_pence)}</CardContent></Card>
                        <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Failed</CardTitle></CardHeader><CardContent className="text-xl font-semibold">{summary.failed_count}</CardContent></Card>
                      </div>
                    )}

                    {(t.id === 'overview' || t.id === 'history') && batches.length > 0 && (
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
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {batches.map((b) => (
                              <TableRow key={b.id}>
                                <TableCell className="text-xs">{shortDate(b.created_at)}</TableCell>
                                <TableCell className="text-xs">{b.run_date}</TableCell>
                                <TableCell className="text-xs">{b.kind}</TableCell>
                                <TableCell className="text-xs"><Badge variant="outline">{b.status}</Badge></TableCell>
                                <TableCell className="text-xs">{b.total_drivers ?? '—'}</TableCell>
                                <TableCell className="text-xs">{formatNullablePence(b.total_amount_pence)}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    )}

                    {isLoading ? (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" /> Loading payouts...
                      </div>
                    ) : (
                      <PayoutItemsTable items={items} exportRow={exportRow} />
                    )}
                  </TabsContent>
                ))}
            </Tabs>
          </div>
        )}
          </TabsContent>
        </Tabs>
      </div>
    </AdminLayout>
  );
}

function PayoutItemsTable({
  items,
  exportRow,
}: {
  items: AdminPayoutLedgerItemRow[];
  exportRow: (row: AdminPayoutLedgerItemRow) => void;
}) {
  if (items.length === 0) {
    return (
      <Alert>
        <AlertTitle>No payouts match the selected filters.</AlertTitle>
        <AlertDescription>
          <Link className="underline" to={payoutLedgerUrl({ tab: 'overview' })}>Clear filters</Link>
        </AlertDescription>
      </Alert>
    );
  }

  return (
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
            <TableHead>Status</TableHead>
            <TableHead>Failure</TableHead>
            <TableHead>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="text-xs font-mono">{row.batch_id?.slice(0, 8) ?? '—'}</TableCell>
              <TableCell className="text-xs whitespace-nowrap">{shortDate(row.created_at)}</TableCell>
              <TableCell className="text-xs">{row.driver_name ?? row.driver_id.slice(0, 8)}</TableCell>
              <TableCell className="text-xs">{row.verification_status ?? '—'}</TableCell>
              <TableCell className="text-xs">{row.bank_account_last4 ? `•••• ${row.bank_account_last4}` : '—'}</TableCell>
              <TableCell className="text-xs">{formatNullablePence(row.net_bank_transfer_pence, row.currency)}</TableCell>
              <TableCell className="text-xs whitespace-nowrap">{shortDate(row.processing_started_at)}</TableCell>
              <TableCell className="text-xs">{shortDate(row.paid_at)}</TableCell>
              <TableCell className="text-xs">{row.provider ?? '—'}</TableCell>
              <TableCell className="text-xs font-mono">{row.provider_payout_id?.slice(0, 12) ?? '—'}</TableCell>
              <TableCell className="text-xs"><Badge variant="outline">{row.status}</Badge></TableCell>
              <TableCell className="text-xs max-w-[160px] truncate">{row.failure_reason ?? '—'}</TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  <Button asChild size="sm" variant="outline">
                    <Link to={driverWalletLedgerUrl(row.driver_id, 'payout_allocations')}>View</Link>
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
                  {row.action_policy.can_retry && <PayoutLedgerRetryButton payoutItemId={row.id} />}
                  {row.action_policy.can_cancel && <PayoutLedgerCancelButton payoutItemId={row.id} />}
                  <Button size="sm" variant="ghost" onClick={() => exportRow(row)}>CSV</Button>
                  <Button size="sm" variant="ghost" onClick={() => printFinanceReport()}>Print</Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
