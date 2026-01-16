import { useState } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { supabase } from '@/integrations/supabase/client';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { 
  RefreshCw,
  CheckCircle2,
  Clock,
  XCircle,
  Eye,
  Calendar,
  Wallet,
  Users,
  DollarSign
} from 'lucide-react';

interface PayoutBatch {
  id: string;
  kind: string;
  run_date: string;
  status: string;
  total_drivers: number | null;
  total_amount_pence: number | null;
  successful_payouts: number | null;
  failed_payouts: number | null;
  created_at: string;
  completed_at: string | null;
  notes: string | null;
}

interface PayoutItem {
  id: string;
  driver_id: string;
  driver_name: string;
  amount_pence: number;
  status: string;
  error_message: string | null;
  stripe_transfer_id: string | null;
  stripe_payout_id: string | null;
  created_at: string;
  completed_at: string | null;
}

const formatPence = (pence: number): string => {
  return `£${(pence / 100).toFixed(2)}`;
};

export default function AdminPayoutBatches() {
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);

  // Fetch batches
  const { data: batchData, isLoading, refetch } = useQuery<{ batches: PayoutBatch[]; items: PayoutItem[] }>({
    queryKey: ['admin-payout-batches'],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('admin-payout-batches');
      if (error) throw error;
      return data;
    },
  });

  const batches = batchData?.batches || [];
  const allItems = batchData?.items || [];

  const selectedBatch = batches.find(b => b.id === selectedBatchId);
  const batchItems = allItems.filter(item => {
    // Items are associated with batches via the batch_id, but our current query returns all items
    // In a real implementation, you'd filter by batch_id
    return true;
  });

  const getStatusBadge = (status: string) => {
    const config: Record<string, { variant: 'default' | 'secondary' | 'destructive' | 'outline', icon: React.ReactNode }> = {
      completed: { variant: 'default', icon: <CheckCircle2 className="h-3 w-3 mr-1" /> },
      pending: { variant: 'secondary', icon: <Clock className="h-3 w-3 mr-1" /> },
      processing: { variant: 'outline', icon: <RefreshCw className="h-3 w-3 mr-1 animate-spin" /> },
      failed: { variant: 'destructive', icon: <XCircle className="h-3 w-3 mr-1" /> },
    };
    const { variant, icon } = config[status] || { variant: 'outline', icon: null };
    return (
      <Badge variant={variant} className="flex items-center w-fit">
        {icon}
        {status}
      </Badge>
    );
  };

  const getKindDisplay = (kind: string) => {
    const kinds: Record<string, string> = {
      'WEEKLY_MONDAY': 'Weekly (Monday)',
      'EARLY_CASHOUT': 'Early Cashout',
      'MANUAL_ADMIN': 'Manual Admin',
    };
    return kinds[kind] || kind;
  };

  // Stats
  const totalBatches = batches.length;
  const completedBatches = batches.filter(b => b.status === 'completed').length;
  const totalPaidOut = batches
    .filter(b => b.status === 'completed')
    .reduce((sum, b) => sum + (b.total_amount_pence || 0), 0);
  const totalDriversPaid = batches
    .filter(b => b.status === 'completed')
    .reduce((sum, b) => sum + (b.successful_payouts || 0), 0);

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
      description="View payout runs, weekly settlements, and manual payouts"
    >
      <div className="space-y-6">
        {/* Stats */}
        <div className="grid gap-4 md:grid-cols-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Batches</CardTitle>
              <Calendar className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{totalBatches}</div>
              <p className="text-xs text-muted-foreground">All time</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Completed</CardTitle>
              <CheckCircle2 className="h-4 w-4 text-green-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-500">{completedBatches}</div>
              <p className="text-xs text-muted-foreground">Successful runs</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Paid Out</CardTitle>
              <DollarSign className="h-4 w-4 text-green-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-500">{formatPence(totalPaidOut)}</div>
              <p className="text-xs text-muted-foreground">Lifetime</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Drivers Paid</CardTitle>
              <Users className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{totalDriversPaid}</div>
              <p className="text-xs text-muted-foreground">Total payouts</p>
            </CardContent>
          </Card>
        </div>

        {/* Batches Table */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Payout Batches</CardTitle>
            <Button variant="outline" size="icon" onClick={() => refetch()}>
              <RefreshCw className="h-4 w-4" />
            </Button>
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
                    <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                      No payout batches yet
                    </TableCell>
                  </TableRow>
                ) : (
                  batches.map((batch) => (
                    <TableRow key={batch.id}>
                      <TableCell className="font-medium">
                        {format(new Date(batch.run_date), 'dd MMM yyyy')}
                      </TableCell>
                      <TableCell>{getKindDisplay(batch.kind)}</TableCell>
                      <TableCell>{getStatusBadge(batch.status)}</TableCell>
                      <TableCell className="text-right">{batch.total_drivers || 0}</TableCell>
                      <TableCell className="text-right font-medium text-green-600">
                        {formatPence(batch.total_amount_pence || 0)}
                      </TableCell>
                      <TableCell className="text-right text-green-600">{batch.successful_payouts || 0}</TableCell>
                      <TableCell className="text-right text-red-600">{batch.failed_payouts || 0}</TableCell>
                      <TableCell className="text-right">
                        <Button 
                          variant="ghost" 
                          size="sm"
                          onClick={() => setSelectedBatchId(batch.id)}
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
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
                {selectedBatch && format(new Date(selectedBatch.run_date), 'dd MMM yyyy')} - {selectedBatch && getKindDisplay(selectedBatch.kind)}
              </DialogDescription>
            </DialogHeader>
            {selectedBatch && (
              <div className="space-y-4">
                {/* Batch Summary */}
                <div className="grid grid-cols-4 gap-4">
                  <Card>
                    <CardContent className="pt-4">
                      <p className="text-xs text-muted-foreground">Status</p>
                      {getStatusBadge(selectedBatch.status)}
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="pt-4">
                      <p className="text-xs text-muted-foreground">Total</p>
                      <p className="text-lg font-bold text-green-600">
                        {formatPence(selectedBatch.total_amount_pence || 0)}
                      </p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="pt-4">
                      <p className="text-xs text-muted-foreground">Success</p>
                      <p className="text-lg font-bold text-green-600">{selectedBatch.successful_payouts || 0}</p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="pt-4">
                      <p className="text-xs text-muted-foreground">Failed</p>
                      <p className="text-lg font-bold text-red-600">{selectedBatch.failed_payouts || 0}</p>
                    </CardContent>
                  </Card>
                </div>

                {selectedBatch.notes && (
                  <Card>
                    <CardContent className="pt-4">
                      <p className="text-sm text-muted-foreground">Notes</p>
                      <p className="text-sm">{selectedBatch.notes}</p>
                    </CardContent>
                  </Card>
                )}

                {/* Payout Items - in a real implementation, filter by batch_id */}
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
                            <TableHead>Error</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {batchItems.slice(0, 20).map((item) => (
                            <TableRow key={item.id}>
                              <TableCell className="font-medium">{item.driver_name || item.driver_id.substring(0, 8)}</TableCell>
                              <TableCell className="text-right text-green-600">{formatPence(item.amount_pence)}</TableCell>
                              <TableCell>{getStatusBadge(item.status)}</TableCell>
                              <TableCell className="text-xs text-red-600 max-w-[150px] truncate">
                                {item.error_message || '-'}
                              </TableCell>
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
              <Button variant="outline" onClick={() => setSelectedBatchId(null)}>
                Close
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </AdminLayout>
  );
}
