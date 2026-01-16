import { useState } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { supabase } from '@/integrations/supabase/client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { 
  Search, 
  Download, 
  DollarSign,
  TrendingUp,
  Eye,
  RefreshCw,
  User,
  Car,
  Banknote,
  Wallet,
  CheckCircle2,
  AlertTriangle,
  CreditCard,
  Plus,
  Minus,
  ArrowDownRight,
  ArrowUpRight
} from 'lucide-react';

interface DriverSettlement {
  driver_id: string;
  driver_name: string;
  driver_email: string;
  is_online: boolean;
  rating: number | null;
  trip_count: number;
  gross_earnings_pence: number;
  commission_pence: number;
  driver_net_pence: number;
  wallet_available_pence: number;
  payouts_enabled: boolean;
  onboarding_complete: boolean;
}

interface WalletDetail {
  driver: {
    id: string;
    name: string;
    email: string;
    stripe_account_id: string | null;
    payouts_enabled: boolean;
    onboarding_complete: boolean;
  };
  wallet: {
    available_pence: number;
    pending_pence: number;
    lifetime_earned_pence: number;
  };
  ledger: Array<{
    id: string;
    type: string;
    amount_pence: number;
    description: string | null;
    related_trip_id: string | null;
    created_at: string;
  }>;
  earnings_summary: {
    this_week_pence: number;
    last_week_pence: number;
  };
}

const formatPence = (pence: number): string => {
  const prefix = pence < 0 ? '-' : '';
  return `${prefix}£${(Math.abs(pence) / 100).toFixed(2)}`;
};

const getEntryTypeDisplay = (type: string): { label: string; color: string } => {
  const types: Record<string, { label: string; color: string }> = {
    'TRIP_EARNING_NET': { label: 'Trip Earning', color: 'text-green-600' },
    'CASH_COMMISSION_DEBT': { label: 'Cash Commission Debt', color: 'text-red-600' },
    'WEEKLY_PAYOUT': { label: 'Weekly Payout', color: 'text-blue-600' },
    'EARLY_CASHOUT': { label: 'Early Cashout', color: 'text-blue-600' },
    'CASHOUT_FEE': { label: 'Cashout Fee', color: 'text-red-600' },
    'ADJUSTMENT': { label: 'Adjustment', color: 'text-amber-600' },
    'REFUND_DEBIT': { label: 'Refund Debit', color: 'text-red-600' },
    'MANUAL_PAYOUT': { label: 'Manual Payout', color: 'text-blue-600' },
  };
  return types[type] || { label: type, color: 'text-muted-foreground' };
};

export default function AdminDriverSettlements() {
  const [activeTab, setActiveTab] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedDriverId, setSelectedDriverId] = useState<string | null>(null);
  const [showAdjustmentDialog, setShowAdjustmentDialog] = useState(false);
  const [adjustmentAmount, setAdjustmentAmount] = useState('');
  const [adjustmentReason, setAdjustmentReason] = useState('');
  const [adjustmentType, setAdjustmentType] = useState<'add' | 'deduct'>('add');
  
  const queryClient = useQueryClient();

  // Fetch driver settlements
  const { data: settlements = [], isLoading, refetch } = useQuery<DriverSettlement[]>({
    queryKey: ['admin-driver-settlements', searchTerm],
    queryFn: async () => {
      const params: Record<string, string> = {};
      if (searchTerm) params.search = searchTerm;
      
      const { data, error } = await supabase.functions.invoke('admin-driver-settlements', {
        body: params,
      });
      if (error) throw error;
      return data.drivers || [];
    },
  });

  // Fetch wallet detail for selected driver
  const { data: walletDetail, isLoading: isLoadingWallet } = useQuery<WalletDetail>({
    queryKey: ['admin-driver-wallet-detail', selectedDriverId],
    enabled: !!selectedDriverId,
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('admin-driver-wallet-detail', {
        body: { driver_id: selectedDriverId },
      });
      if (error) throw error;
      return data;
    },
  });

  // Payout mutation
  const payoutMutation = useMutation({
    mutationFn: async (driverId: string) => {
      const { data, error } = await supabase.functions.invoke('admin-driver-payout', {
        body: { driver_id: driverId },
      });
      if (error) throw error;
      if (!data.success) throw new Error(data.error || 'Payout failed');
      return data;
    },
    onSuccess: () => {
      toast.success('Payout initiated successfully');
      queryClient.invalidateQueries({ queryKey: ['admin-driver-settlements'] });
      queryClient.invalidateQueries({ queryKey: ['admin-driver-wallet-detail'] });
    },
    onError: (error: Error) => {
      toast.error(`Payout failed: ${error.message}`);
    },
  });

  // Adjustment mutation
  const adjustmentMutation = useMutation({
    mutationFn: async ({ driverId, amountPence, reason }: { driverId: string; amountPence: number; reason: string }) => {
      const { data, error } = await supabase.functions.invoke('admin-driver-adjustment', {
        body: { 
          driver_id: driverId, 
          amount_pence: amountPence, 
          reason 
        },
      });
      if (error) throw error;
      if (!data.success) throw new Error(data.error || 'Adjustment failed');
      return data;
    },
    onSuccess: () => {
      toast.success('Adjustment added successfully');
      setShowAdjustmentDialog(false);
      setAdjustmentAmount('');
      setAdjustmentReason('');
      queryClient.invalidateQueries({ queryKey: ['admin-driver-settlements'] });
      queryClient.invalidateQueries({ queryKey: ['admin-driver-wallet-detail'] });
    },
    onError: (error: Error) => {
      toast.error(`Adjustment failed: ${error.message}`);
    },
  });

  const handleAddAdjustment = () => {
    if (!selectedDriverId || !adjustmentAmount || !adjustmentReason) {
      toast.error('Please fill in all fields');
      return;
    }
    const amountPence = Math.round(parseFloat(adjustmentAmount) * 100);
    const finalAmount = adjustmentType === 'deduct' ? -amountPence : amountPence;
    adjustmentMutation.mutate({ 
      driverId: selectedDriverId, 
      amountPence: finalAmount, 
      reason: adjustmentReason 
    });
  };

  const filteredSettlements = settlements.filter(driver => {
    const matchesSearch = 
      driver.driver_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      driver.driver_email.toLowerCase().includes(searchTerm.toLowerCase());
    
    if (activeTab === 'with_earnings') {
      return matchesSearch && driver.wallet_available_pence > 0;
    }
    if (activeTab === 'in_debt') {
      return matchesSearch && driver.wallet_available_pence < 0;
    }
    if (activeTab === 'online') {
      return matchesSearch && driver.is_online;
    }
    return matchesSearch;
  });

  // Stats
  const totalDriverNet = settlements.reduce((sum, d) => sum + d.driver_net_pence, 0);
  const totalCommission = settlements.reduce((sum, d) => sum + d.commission_pence, 0);
  const driversWithEarnings = settlements.filter(d => d.wallet_available_pence > 0).length;
  const onlineDrivers = settlements.filter(d => d.is_online).length;

  if (isLoading && settlements.length === 0) {
    return (
      <AdminLayout title="Driver Payouts & Settlements" description="Manage driver settlements">
        <div className="flex items-center justify-center h-64">
          <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout 
      title="Driver Payouts & Settlements" 
      description="Manage driver earnings, payouts, and wallet balances"
    >
      <div className="space-y-6">
        {/* Stats */}
        <div className="grid gap-4 md:grid-cols-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Driver Earnings</CardTitle>
              <DollarSign className="h-4 w-4 text-green-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-500">{formatPence(totalDriverNet)}</div>
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <TrendingUp className="h-3 w-3 text-green-500" />
                Net after commission
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Platform Commission</CardTitle>
              <Banknote className="h-4 w-4 text-blue-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-blue-500">{formatPence(totalCommission)}</div>
              <p className="text-xs text-muted-foreground">Total collected</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Drivers with Earnings</CardTitle>
              <User className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{driversWithEarnings}</div>
              <p className="text-xs text-muted-foreground">Can request payout</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Online Now</CardTitle>
              <Car className="h-4 w-4 text-green-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{onlineDrivers}</div>
              <p className="text-xs text-muted-foreground">Active drivers</p>
            </CardContent>
          </Card>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
          <div className="flex flex-col sm:flex-row justify-between gap-4">
            <TabsList>
              <TabsTrigger value="all">All ({settlements.length})</TabsTrigger>
              <TabsTrigger value="with_earnings">
                With Earnings
                {driversWithEarnings > 0 && (
                  <Badge variant="secondary" className="ml-1 h-5 min-w-5 rounded-full p-0 flex items-center justify-center text-xs">
                    {driversWithEarnings}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="in_debt">In Debt</TabsTrigger>
              <TabsTrigger value="online">Online ({onlineDrivers})</TabsTrigger>
            </TabsList>

            <div className="flex gap-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input 
                  placeholder="Search drivers..." 
                  className="pl-9 w-[200px]"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
              </div>
              <Button variant="outline" size="icon" onClick={() => refetch()}>
                <RefreshCw className="h-4 w-4" />
              </Button>
              <Button variant="outline">
                <Download className="h-4 w-4 mr-2" />
                Export
              </Button>
            </div>
          </div>

          <TabsContent value={activeTab} className="m-0">
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Driver</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Trips</TableHead>
                      <TableHead className="text-right">Total Earnings</TableHead>
                      <TableHead className="text-right">Commission</TableHead>
                      <TableHead className="text-right">Net Payout</TableHead>
                      <TableHead>Rating</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredSettlements.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                          No drivers found
                        </TableCell>
                      </TableRow>
                    ) : (
                      filteredSettlements.map((driver) => (
                        <TableRow key={driver.driver_id}>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center">
                                <User className="h-4 w-4" />
                              </div>
                              <div>
                                <p className="font-medium">{driver.driver_name}</p>
                                <p className="text-xs text-muted-foreground">{driver.driver_email}</p>
                              </div>
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge variant={driver.is_online ? 'default' : 'secondary'} className={driver.is_online ? 'bg-green-500' : ''}>
                              {driver.is_online ? 'Online' : 'Offline'}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right">{driver.trip_count}</TableCell>
                          <TableCell className="text-right">{formatPence(driver.gross_earnings_pence)}</TableCell>
                          <TableCell className="text-right text-muted-foreground">-{formatPence(driver.commission_pence)}</TableCell>
                          <TableCell className={`text-right font-medium ${driver.wallet_available_pence >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                            {formatPence(driver.wallet_available_pence)}
                          </TableCell>
                          <TableCell>
                            {driver.rating ? (
                              <span className="flex items-center gap-1">
                                ⭐ {driver.rating.toFixed(1)}
                              </span>
                            ) : '-'}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button 
                              variant="ghost" 
                              size="sm"
                              onClick={() => setSelectedDriverId(driver.driver_id)}
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
          </TabsContent>
        </Tabs>

        {/* Driver Detail Dialog */}
        <Dialog open={!!selectedDriverId} onOpenChange={() => setSelectedDriverId(null)}>
          <DialogContent className="max-w-2xl max-h-[85vh]">
            <DialogHeader>
              <DialogTitle>Driver Wallet Details</DialogTitle>
              <DialogDescription>
                {walletDetail?.driver?.name} - {walletDetail?.driver?.email}
              </DialogDescription>
            </DialogHeader>
            {isLoadingWallet ? (
              <div className="flex items-center justify-center py-8">
                <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : walletDetail ? (
              <div className="space-y-4">
                {/* Balance Summary */}
                <div className="grid grid-cols-3 gap-4">
                  <Card>
                    <CardContent className="pt-4">
                      <p className="text-xs text-muted-foreground">Available</p>
                      <p className={`text-xl font-bold ${walletDetail.wallet.available_pence >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {formatPence(walletDetail.wallet.available_pence)}
                      </p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="pt-4">
                      <p className="text-xs text-muted-foreground">This Week</p>
                      <p className="text-xl font-bold text-green-600">
                        {formatPence(walletDetail.earnings_summary.this_week_pence)}
                      </p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="pt-4">
                      <p className="text-xs text-muted-foreground">Last Week</p>
                      <p className="text-xl font-bold">
                        {formatPence(walletDetail.earnings_summary.last_week_pence)}
                      </p>
                    </CardContent>
                  </Card>
                </div>

                {/* Connected Account Status */}
                <Card>
                  <CardContent className="pt-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <CreditCard className="h-4 w-4" />
                        <span className="font-medium">Stripe Account</span>
                      </div>
                      <div className="flex items-center gap-2">
                        {walletDetail.driver.payouts_enabled ? (
                          <Badge className="bg-green-500"><CheckCircle2 className="h-3 w-3 mr-1" /> Payouts Enabled</Badge>
                        ) : (
                          <Badge variant="destructive"><AlertTriangle className="h-3 w-3 mr-1" /> Not Ready</Badge>
                        )}
                      </div>
                    </div>
                    {walletDetail.driver.stripe_account_id && (
                      <p className="text-xs text-muted-foreground mt-2">
                        Account: <code className="bg-muted px-1 rounded">{walletDetail.driver.stripe_account_id}</code>
                      </p>
                    )}
                  </CardContent>
                </Card>

                {/* Actions */}
                <div className="flex gap-2">
                  <Button 
                    onClick={() => payoutMutation.mutate(selectedDriverId!)}
                    disabled={!walletDetail.driver.payouts_enabled || walletDetail.wallet.available_pence <= 0 || payoutMutation.isPending}
                    className="bg-green-600 hover:bg-green-700"
                  >
                    <Wallet className="h-4 w-4 mr-2" />
                    {payoutMutation.isPending ? 'Processing...' : 'Pay Now'}
                  </Button>
                  <Button variant="outline" onClick={() => setShowAdjustmentDialog(true)}>
                    <Plus className="h-4 w-4 mr-2" />
                    Add Adjustment
                  </Button>
                </div>

                <Separator />

                {/* Ledger */}
                <div>
                  <h4 className="font-medium mb-2">Transaction History</h4>
                  <ScrollArea className="h-[250px]">
                    {walletDetail.ledger.length === 0 ? (
                      <p className="text-center text-muted-foreground py-8">No transactions yet</p>
                    ) : (
                      <div className="space-y-2">
                        {walletDetail.ledger.map((entry) => {
                          const { label, color } = getEntryTypeDisplay(entry.type);
                          const isPositive = entry.amount_pence > 0;
                          return (
                            <div key={entry.id} className="flex items-center justify-between p-3 rounded-lg border">
                              <div className="flex items-center gap-3">
                                <div className={`h-8 w-8 rounded-full flex items-center justify-center ${isPositive ? 'bg-green-100' : 'bg-red-100'}`}>
                                  {isPositive ? (
                                    <ArrowDownRight className="h-4 w-4 text-green-600" />
                                  ) : (
                                    <ArrowUpRight className="h-4 w-4 text-red-600" />
                                  )}
                                </div>
                                <div>
                                  <p className={`font-medium ${color}`}>{label}</p>
                                  <p className="text-xs text-muted-foreground">
                                    {format(new Date(entry.created_at), 'dd MMM yyyy, HH:mm')}
                                  </p>
                                </div>
                              </div>
                              <div className="text-right">
                                <p className={`font-bold ${isPositive ? 'text-green-600' : 'text-red-600'}`}>
                                  {isPositive ? '+' : ''}{formatPence(entry.amount_pence)}
                                </p>
                                {entry.description && (
                                  <p className="text-xs text-muted-foreground max-w-[180px] truncate">
                                    {entry.description}
                                  </p>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </ScrollArea>
                </div>
              </div>
            ) : null}
            <DialogFooter>
              <Button variant="outline" onClick={() => setSelectedDriverId(null)}>
                Close
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Adjustment Dialog */}
        <Dialog open={showAdjustmentDialog} onOpenChange={setShowAdjustmentDialog}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add Wallet Adjustment</DialogTitle>
              <DialogDescription>
                Add or deduct funds from driver's wallet
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="flex gap-2">
                <Button
                  variant={adjustmentType === 'add' ? 'default' : 'outline'}
                  onClick={() => setAdjustmentType('add')}
                  className={adjustmentType === 'add' ? 'bg-green-600' : ''}
                >
                  <Plus className="h-4 w-4 mr-2" />
                  Add Funds
                </Button>
                <Button
                  variant={adjustmentType === 'deduct' ? 'default' : 'outline'}
                  onClick={() => setAdjustmentType('deduct')}
                  className={adjustmentType === 'deduct' ? 'bg-red-600' : ''}
                >
                  <Minus className="h-4 w-4 mr-2" />
                  Deduct Funds
                </Button>
              </div>
              <div className="space-y-2">
                <Label htmlFor="amount">Amount (£)</Label>
                <Input
                  id="amount"
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="0.00"
                  value={adjustmentAmount}
                  onChange={(e) => setAdjustmentAmount(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="reason">Reason</Label>
                <Textarea
                  id="reason"
                  placeholder="Enter reason for adjustment..."
                  value={adjustmentReason}
                  onChange={(e) => setAdjustmentReason(e.target.value)}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowAdjustmentDialog(false)}>
                Cancel
              </Button>
              <Button 
                onClick={handleAddAdjustment}
                disabled={adjustmentMutation.isPending}
                className={adjustmentType === 'add' ? 'bg-green-600' : 'bg-red-600'}
              >
                {adjustmentMutation.isPending ? 'Processing...' : `${adjustmentType === 'add' ? 'Add' : 'Deduct'} ${adjustmentAmount ? `£${adjustmentAmount}` : ''}`}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </AdminLayout>
  );
}
