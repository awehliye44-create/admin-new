import { useMemo, useState } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { supabase } from '@/integrations/supabase/client';
import { useQuery } from '@tanstack/react-query';
import { formatPence, useDriverFinancialSummaries } from '@/hooks/useDriverWallet';
import { ServiceAreaFinanceFilter, DEFAULT_SERVICE_AREA_SELECTION, type ServiceAreaFinanceSelection } from '@/components/finance/ServiceAreaFinanceFilter';
import { getSingleCurrency } from '@/components/finance/CurrencyGroupedStats';
import { format } from 'date-fns';
import { 
  RefreshCw, CheckCircle2, Clock, XCircle, Eye, Calendar,
  DollarSign, Wallet, AlertTriangle
} from 'lucide-react';

interface PayoutItem {
  id: string;
  driverId: string;
  driverName: string | null;
  amount: number;
  status: string;
  errorMessage: string | null;
  stripeTransferId: string | null;
  stripePayoutId: string | null;
  createdAt: string;
  completedAt: string | null;
}

interface PayoutBatch {
  id: string;
  kind: string;
  runDate: string;
  status: string;
  totalDrivers: number | null;
  totalAmount: number | null;
  successfulPayouts: number | null;
  failedPayouts: number | null;
  createdAt: string;
  completedAt: string | null;
  notes: string | null;
  items: PayoutItem[];
}

export default function AdminPayoutBatches() {
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [serviceFilter, setServiceFilter] = useState<ServiceAreaFinanceSelection>(DEFAULT_SERVICE_AREA_SELECTION);

  const { data: allDrivers = [], isLoading: isLoadingDrivers, refetch: refetchDrivers } = useDriverFinancialSummaries();

  const { data: batches = [], isLoading: isLoadingBatches, refetch: refetchBatches, isError, error } = useQuery<PayoutBatch[]>({
    queryKey: ['admin-payout-batches-list'],
    queryFn: async () => {
      const { data: batchRows, error: batchError } = await supabase
        .from('payout_batches')
        .select('id,kind,run_date,status,total_drivers,total_amount_pence,successful_payouts,failed_payouts,notes,created_at,completed_at')
        .order('created_at', { ascending: false });

      if (batchError) throw batchError;

      const batchIds = (batchRows || []).map(b => b.id);
      const { data: itemRows, error: itemError } = batchIds.length > 0
        ? await supabase
            .from('payout_items')
            .select('id,batch_id,driver_id,amount_pence,status,stripe_transfer_id,stripe_payout_id,error_message,created_at,completed_at,drivers:driver_id(first_name,last_name)')
            .in('batch_id', batchIds)
        : { data: [], error: null };

      if (itemError) throw itemError;

      const itemsByBatch: Record<string, PayoutItem[]> = {};
      itemRows?.forEach((item: any) => {
        if (!itemsByBatch[item.batch_id]) itemsByBatch[item.batch_id] = [];
        itemsByBatch[item.batch_id].push({
          id: item.id,
          driverId: item.driver_id,
          driverName: item.drivers ? `${item.drivers.first_name} ${item.drivers.last_name}` : null,
          amount: item.amount_pence,
          status: item.status,
          stripeTransferId: item.stripe_transfer_id,
          stripePayoutId: item.stripe_payout_id,
          errorMessage: item.error_message,
          createdAt: item.created_at,
          completedAt: item.completed_at,
        });
      });

      return (batchRows || []).map(batch => ({
        id: batch.id,
        kind: batch.kind,
        runDate: batch.run_date,
        status: batch.status,
        totalDrivers: batch.total_drivers,
        totalAmount: batch.total_amount_pence,
        successfulPayouts: batch.successful_payouts,
        failedPayouts: batch.failed_payouts,
        notes: batch.notes,
        createdAt: batch.created_at,
        completedAt: batch.completed_at,
        items: itemsByBatch[batch.id] || [],
      }));
    },
  });

  const drivers = useMemo(() => {
    if (!serviceFilter.regionId) return allDrivers;
    return allDrivers.filter(d => d.region_id === serviceFilter.regionId);
  }, [allDrivers, serviceFilter.regionId]);

  const resolvedCurrency = serviceFilter.currencyCode || getSingleCurrency(drivers) || '';
  const isMixedCurrency = !serviceFilter.currencyCode && !getSingleCurrency(drivers) && drivers.length > 0;

  const totalPaidOut = drivers.reduce((s, d) => s + d.total_payouts_sent, 0);
  const availableForPayout = drivers.reduce((s, d) => s + d.available_for_payout, 0);
  const driversReadyForPayout = drivers.filter(d => d.available_for_payout > 0).length;

  const summary = {
    totalBatches: batches.length,
    totalPaidOut,
    pendingBatches: batches.filter(b => b.status === 'pending' || b.status === 'processing').length,
    failedBatches: batches.filter(b => b.status === 'failed').length,
  };

  const selectedBatch = batches.find(b => b.id === selectedBatchId);
  const batchItems = selectedBatch?.items || [];
  const isLoading = isLoadingDrivers || isLoadingBatches;

  const refetch = () => {
    refetchDrivers();
    refetchBatches();
  };

  const getStatusBadge = (status: string) => {
    const config: Record<string, { variant: 'default' | 'secondary' | 'destructive' | 'outline', icon: React.ReactNode }> = {
      completed: { variant: 'default', icon: <CheckCircle2 className="h-3 w-3 mr-1" /> },
      pending: { variant: 'secondary', icon: <Clock className="h-3 w-3 mr-1" /> },
      processing: { variant: 'outline', icon: <RefreshCw className="h-3 w-3 mr-1 animate-spin" /> },
      failed: { variant: 'destructive', icon: <XCircle className="h-3 w-3 mr-1" /> },
    };
    const { variant, icon } = config[status] || { variant: 'outline' as const, icon: null };
    return <Badge variant={variant} className="flex items-center w-fit">{icon}{status}</Badge>;
  };

  const getKindDisplay = (kind: string) => {
    const kinds: Record<string, string> = {
      'WEEKLY_MONDAY': 'Weekly (Monday)',
      'EARLY_CASHOUT': 'Early Cashout',
      'MANUAL_ADMIN': 'Manual Admin',
    };
    return kinds[kind] || kind;
  };

  if (isLoading) {
    return (
      <AdminLayout title="Payout Batches" description="View payout history">
        <div className="flex items-center justify-center h-64">
          <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout 
      title="Payout Batches & Audit" 
      description="Unified payout reporting — totalPaidOut derived from driver_financial_summary"
    >
      <div className="space-y-6">
        {isError && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            Failed to load payout batches: {(error as Error)?.message || 'Unknown error'}
          </div>
        )}

        {/* Service Area Filter */}
        <div className="flex items-center gap-3">
          <ServiceAreaFinanceFilter value={serviceFilter} onChange={setServiceFilter} />
          {isMixedCurrency && (
            <Badge variant="outline" className="text-amber-600 border-amber-300">
              <AlertTriangle className="h-3 w-3 mr-1" /> Mixed currencies — select a service for totals
            </Badge>
          )}
        </div>

        {/* Stats */}
        <div className="grid gap-4 md:grid-cols-5">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Batches</CardTitle>
              <Calendar className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{summary.totalBatches}</div>
              <p className="text-xs text-muted-foreground">All time</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Paid Out</CardTitle>
              <DollarSign className="h-4 w-4 text-green-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-500">{formatPence(totalPaidOut, resolvedCurrency)}</div>
              <p className="text-xs text-muted-foreground">From unified ledger</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Available for Payout</CardTitle>
              <Wallet className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-blue-500">{formatPence(availableForPayout, resolvedCurrency)}</div>
              <p className="text-xs text-muted-foreground">{driversReadyForPayout} drivers ready</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Pending</CardTitle>
              <Clock className="h-4 w-4 text-amber-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-amber-500">{summary.pendingBatches}</div>
              <p className="text-xs text-muted-foreground">In progress</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Failed</CardTitle>
              <XCircle className="h-4 w-4 text-red-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-red-500">{summary.failedBatches}</div>
              <p className="text-xs text-muted-foreground">Need attention</p>
            </CardContent>
          </Card>
        </div>

        {/* Batches Table */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Payout Batches</CardTitle>
            <Button variant="outline" size="icon" onClick={() => refetch()}><RefreshCw className="h-4 w-4" /></Button>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Run Date</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Drivers</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="text-right">Success</TableHead>
                  <TableHead className="text-right">Failed</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {batches.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">No payout batches yet</TableCell>
                  </TableRow>
                ) : (
                  batches.map((batch) => (
                    <TableRow key={batch.id}>
                      <TableCell className="font-medium">
                        {batch.runDate ? format(new Date(batch.runDate), 'dd MMM yyyy') : format(new Date(batch.createdAt), 'dd MMM yyyy')}
                      </TableCell>
                      <TableCell>{getKindDisplay(batch.kind)}</TableCell>
                      <TableCell>{getStatusBadge(batch.status)}</TableCell>
                      <TableCell className="text-right">{batch.totalDrivers || 0}</TableCell>
                      <TableCell className="text-right font-medium text-green-600">{formatPence(batch.totalAmount || 0, resolvedCurrency)}</TableCell>
                      <TableCell className="text-right text-green-600">{batch.successfulPayouts || 0}</TableCell>
                      <TableCell className="text-right text-red-600">{batch.failedPayouts || 0}</TableCell>
                      <TableCell className="text-right">
                        <Button variant="ghost" size="sm" onClick={() => setSelectedBatchId(batch.id)}><Eye className="h-4 w-4" /></Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* Batch Detail Dialog */}
        <Dialog open={!!selectedBatchId} onOpenChange={() => setSelectedBatchId(null)}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Payout Batch Details</DialogTitle>
              <DialogDescription>
                {selectedBatch && (selectedBatch.runDate ? format(new Date(selectedBatch.runDate), 'dd MMM yyyy') : format(new Date(selectedBatch.createdAt), 'dd MMM yyyy'))} - {selectedBatch && getKindDisplay(selectedBatch.kind)}
              </DialogDescription>
            </DialogHeader>
            {selectedBatch && (
              <div className="space-y-4">
                <div className="grid grid-cols-4 gap-4">
                  <Card><CardContent className="pt-4"><p className="text-xs text-muted-foreground">Status</p>{getStatusBadge(selectedBatch.status)}</CardContent></Card>
                  <Card><CardContent className="pt-4"><p className="text-xs text-muted-foreground">Total</p><p className="text-lg font-bold text-green-600">{formatPence(selectedBatch.totalAmount || 0, resolvedCurrency)}</p></CardContent></Card>
                  <Card><CardContent className="pt-4"><p className="text-xs text-muted-foreground">Success</p><p className="text-lg font-bold text-green-600">{selectedBatch.successfulPayouts || 0}</p></CardContent></Card>
                  <Card><CardContent className="pt-4"><p className="text-xs text-muted-foreground">Failed</p><p className="text-lg font-bold text-red-600">{selectedBatch.failedPayouts || 0}</p></CardContent></Card>
                </div>

                {selectedBatch.notes && (
                  <Card><CardContent className="pt-4"><p className="text-sm text-muted-foreground">Notes</p><p className="text-sm">{selectedBatch.notes}</p></CardContent></Card>
                )}

                <div>
                  <h4 className="font-medium mb-2">Individual Payouts</h4>
                  <ScrollArea className="h-[250px]">
                    {batchItems.length === 0 ? (
                      <p className="text-center text-muted-foreground py-8">No payout items</p>
                    ) : (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Driver</TableHead>
                            <TableHead className="text-right">Amount</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead>Stripe Transfer</TableHead>
                            <TableHead>Error</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {batchItems.map((item) => (
                            <TableRow key={item.id}>
                              <TableCell className="font-medium">{item.driverName || item.driverId?.substring(0, 8)}</TableCell>
                              <TableCell className="text-right text-green-600">{formatPence(item.amount || 0, resolvedCurrency)}</TableCell>
                              <TableCell>{getStatusBadge(item.status)}</TableCell>
                              <TableCell className="text-xs font-mono">{item.stripeTransferId ? item.stripeTransferId.substring(0, 16) + '...' : '-'}</TableCell>
                              <TableCell className="text-xs text-red-600 max-w-[150px] truncate">{item.errorMessage || '-'}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    )}
                  </ScrollArea>
                </div>
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => setSelectedBatchId(null)}>Close</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </AdminLayout>
  );
}
