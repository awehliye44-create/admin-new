import { useMemo, useState } from 'react';
import { formatFinanceDateSafe } from '@/lib/financialReconciliationGuards';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatMoneyMinor } from '@/lib/formatMoneyMinor';
import { FinancePayoutAuditSection } from '@/components/finance/FinancePayoutAuditSection';
import { WeeklyMondaySettlementPanel } from '@/components/finance/WeeklyMondaySettlementPanel';
import { DriverWalletLedgerLink } from '@/components/finance/DriverWalletLedgerLink';
import {
  retryMondayPayoutItem,
  useMondayPayoutDiagnostics,
  type MondayPayoutDiagnosticsRow,
} from '@/hooks/useMondayPayoutDiagnostics';
import {
  fetchEarlyCashoutsDirect,
  fetchPayoutBatchesWithFallback,
  type EarlyCashoutRow,
  type PayoutBatch,
} from '@/lib/platformPayoutBatches';
import { formatPayoutDisplayStatus } from '@/lib/payoutStatusLabels';
import type { ServiceAreaFinanceSelection } from '@/components/finance/ServiceAreaFinanceFilter';
import { RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

function getStatusBadge(status: string) {
  const config: Record<string, { variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
    completed: { variant: 'default' },
    pending: { variant: 'secondary' },
    processing: { variant: 'outline' },
    failed: { variant: 'destructive' },
    ledger_sync_failed: { variant: 'destructive' },
  };
  const { variant } = config[status] || { variant: 'outline' as const };
  return <Badge variant={variant}>{formatPayoutDisplayStatus(status)}</Badge>;
}

function getKindDisplay(kind: string) {
  const kinds: Record<string, string> = {
    WEEKLY_MONDAY: 'Weekly (Monday)',
    EARLY_CASHOUT: 'Early Cashout',
    MANUAL_ADMIN: 'Manual Admin',
  };
  return kinds[kind] || kind;
}

/** Platform payout operations — only on Financial Reconciliation → Provider (SSOT). */
export function FinancialReconciliationPlatformPayoutOps({
  serviceFilter,
  currencyCode,
  periodFrom,
  periodTo,
  periodLabel,
  readOnly = false,
}: {
  serviceFilter: ServiceAreaFinanceSelection;
  currencyCode: string;
  periodFrom?: string;
  periodTo?: string;
  periodLabel?: string;
  readOnly?: boolean;
}) {
  const queryClient = useQueryClient();
  const [retryingPayoutId, setRetryingPayoutId] = useState<string | null>(null);
  const hasRegionScope = !!serviceFilter.regionId;

  const mondayPayouts = useMondayPayoutDiagnostics(serviceFilter, {
    allKinds: true,
    today: false,
    from: periodFrom,
    to: periodTo,
  });

  const { data: batches = [], isLoading: batchesLoading, refetch: refetchBatches } = useQuery<PayoutBatch[]>({
    queryKey: ['platform-payout-batches', serviceFilter.regionId, serviceFilter.serviceAreaId],
    queryFn: () => fetchPayoutBatchesWithFallback(serviceFilter),
  });

  const { data: earlyCashouts = [], isLoading: cashoutsLoading, refetch: refetchCashouts } = useQuery<EarlyCashoutRow[]>({
    queryKey: ['platform-early-cashouts'],
    queryFn: fetchEarlyCashoutsDirect,
  });

  const filteredCashouts = useMemo(() => earlyCashouts, [earlyCashouts]);

  const handleRetry = async (row: MondayPayoutDiagnosticsRow) => {
    setRetryingPayoutId(String(row.payout_item_id ?? ''));
    try {
      await retryMondayPayoutItem(row);
      toast.success('Payout retry submitted');
      await queryClient.invalidateQueries({ queryKey: ['monday-payout-diagnostics'] });
      await refetchBatches();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setRetryingPayoutId(null);
    }
  };

  return (
    <Card className="border-primary/20">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Platform payout operations</CardTitle>
        <p className="text-sm text-muted-foreground">
          Weekly settlement, batch audit, early cashouts — platform scope only (not per-driver ledger).
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {hasRegionScope && (
          <WeeklyMondaySettlementPanel
            filter={serviceFilter}
            currencyCode={currencyCode}
            readOnly={readOnly}
          />
        )}

        <FinancePayoutAuditSection
          mondayPayouts={mondayPayouts}
          currencyCode={currencyCode}
          onRetry={readOnly ? undefined : handleRetry}
          retryingId={retryingPayoutId}
          periodLabel={periodLabel}
          platformMode
        />

        <Tabs defaultValue="batches">
          <TabsList>
            <TabsTrigger value="batches">Payout batches ({batches.length})</TabsTrigger>
            <TabsTrigger value="early-cashouts">Early cashouts ({filteredCashouts.length})</TabsTrigger>
          </TabsList>

          <TabsContent value="batches" className="mt-4">
            <div className="flex justify-end mb-2">
              <Button variant="outline" size="sm" onClick={() => refetchBatches()} disabled={batchesLoading}>
                <RefreshCw className={`h-4 w-4 mr-2 ${batchesLoading ? 'animate-spin' : ''}`} />
                Refresh
              </Button>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Run date</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Drivers</TableHead>
                  <TableHead className="text-right">Failed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {batches.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground py-6">
                      No payout batches
                    </TableCell>
                  </TableRow>
                ) : (
                  batches.map((batch) => (
                    <TableRow key={batch.id}>
                      <TableCell className="text-xs whitespace-nowrap">
                        {formatFinanceDateSafe(batch.runDate, 'dd MMM yyyy')}
                      </TableCell>
                      <TableCell>{getKindDisplay(batch.kind)}</TableCell>
                      <TableCell>{getStatusBadge(batch.status)}</TableCell>
                      <TableCell className="text-right">
                        {batch.totalAmount != null ? formatMoneyMinor(batch.totalAmount, currencyCode) : '—'}
                      </TableCell>
                      <TableCell className="text-right">{batch.totalDrivers ?? '—'}</TableCell>
                      <TableCell className="text-right">{batch.failedPayouts ?? 0}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </TabsContent>

          <TabsContent value="early-cashouts" className="mt-4">
            <div className="flex justify-end mb-2">
              <Button variant="outline" size="sm" onClick={() => refetchCashouts()} disabled={cashoutsLoading}>
                <RefreshCw className={`h-4 w-4 mr-2 ${cashoutsLoading ? 'animate-spin' : ''}`} />
                Refresh
              </Button>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Created</TableHead>
                  <TableHead>Driver</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredCashouts.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground py-6">
                      No early cashouts
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredCashouts.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className="text-xs">{formatFinanceDateSafe(c.createdAt, 'dd MMM HH:mm')}</TableCell>
                      <TableCell>
                        <DriverWalletLedgerLink driverId={c.driverId} tab="payouts">
                          {c.driverName ?? (c.driverId ? c.driverId.slice(0, 8) : '—')}
                        </DriverWalletLedgerLink>
                      </TableCell>
                      <TableCell>{getStatusBadge(c.status)}</TableCell>
                      <TableCell className="text-xs capitalize">{c.payoutMethod ?? '—'}</TableCell>
                      <TableCell>
                        <DriverWalletLedgerLink driverId={c.driverId} tab="payouts" className="text-xs" />
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
