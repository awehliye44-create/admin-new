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
  useDriverFinancialSummaries,
  useDriverFinancialSummary,
  useDriverLedger,
  formatPence,
  getEntryTypeDisplay,
  type DriverFinancialSummary,
} from '@/hooks/useDriverWallet';
import { 
  Search, Download, DollarSign, TrendingUp, Eye, RefreshCw, User, Car,
  Banknote, Wallet, CheckCircle2, AlertTriangle, CreditCard, Plus, Minus,
  ArrowDownRight, ArrowUpRight
} from 'lucide-react';

export default function AdminDriverSettlements() {
  const [activeTab, setActiveTab] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedDriverId, setSelectedDriverId] = useState<string | null>(null);
  const [showAdjustmentDialog, setShowAdjustmentDialog] = useState(false);
  const [adjustmentAmount, setAdjustmentAmount] = useState('');
  const [adjustmentReason, setAdjustmentReason] = useState('');
  const [adjustmentType, setAdjustmentType] = useState<'add' | 'deduct'>('add');
  
  const queryClient = useQueryClient();

  const { data: drivers = [], isLoading, refetch } = useDriverFinancialSummaries();
  const { data: selectedDriverDetail } = useDriverFinancialSummary(selectedDriverId);
  const { data: ledgerEntries = [], isLoading: isLoadingLedger } = useDriverLedger(selectedDriverId);

  // Adjustment mutation
  const adjustmentMutation = useMutation({
    mutationFn: async ({ driverId, amountPence, reason }: { driverId: string; amountPence: number; reason: string }) => {
      const { data, error } = await supabase.functions.invoke('admin-driver-adjustment', {
        body: { driver_id: driverId, amount_pence: amountPence, reason },
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
      queryClient.invalidateQueries({ queryKey: ['driver-financial-summaries'] });
      queryClient.invalidateQueries({ queryKey: ['driver-financial-summary', selectedDriverId] });
      queryClient.invalidateQueries({ queryKey: ['driver-ledger', selectedDriverId] });
    },
    onError: (error: Error) => toast.error(`Adjustment failed: ${error.message}`),
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
      queryClient.invalidateQueries({ queryKey: ['driver-financial-summaries'] });
      queryClient.invalidateQueries({ queryKey: ['driver-financial-summary', selectedDriverId] });
    },
    onError: (error: Error) => toast.error(`Payout failed: ${error.message}`),
  });

  const handleAddAdjustment = () => {
    if (!selectedDriverId || !adjustmentAmount || !adjustmentReason) {
      toast.error('Please fill in all fields');
      return;
    }
    const amountPence = Math.round(parseFloat(adjustmentAmount) * 100);
    const finalAmount = adjustmentType === 'deduct' ? -amountPence : amountPence;
    adjustmentMutation.mutate({ driverId: selectedDriverId, amountPence: finalAmount, reason: adjustmentReason });
  };

  const filteredDrivers = drivers.filter(d => {
    const name = `${d.first_name} ${d.last_name}`.toLowerCase();
    const matchesSearch = name.includes(searchTerm.toLowerCase()) || d.email.toLowerCase().includes(searchTerm.toLowerCase());
    if (activeTab === 'with_earnings') return matchesSearch && d.available_for_payout > 0;
    if (activeTab === 'in_debt') return matchesSearch && d.wallet_balance < 0;
    if (activeTab === 'online') return matchesSearch && d.is_online;
    return matchesSearch;
  });

  // Stats from unified source
  const totalGross = drivers.reduce((s, d) => s + d.gross_trip_total, 0);
  const totalCommission = drivers.reduce((s, d) => s + d.company_commission_total, 0);
  const driversWithEarnings = drivers.filter(d => d.available_for_payout > 0).length;
  const onlineDrivers = drivers.filter(d => d.is_online).length;

  if (isLoading && drivers.length === 0) {
    return (
      <AdminLayout title="Driver Settlements" description="Manage driver settlements">
        <div className="flex items-center justify-center h-64">
          <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout 
      title="Driver Settlements" 
      description="Unified financial view — all numbers derived from driver_financial_summary"
    >
      <div className="space-y-6">
        {/* Stats */}
        <div className="grid gap-4 md:grid-cols-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Gross Trip Fares</CardTitle>
              <DollarSign className="h-4 w-4 text-green-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-500">{formatPence(totalGross)}</div>
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <TrendingUp className="h-3 w-3 text-green-500" /> All completed trips
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
              <p className="text-xs text-muted-foreground">Total earned by ONECAB</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Ready for Payout</CardTitle>
              <Wallet className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{driversWithEarnings}</div>
              <p className="text-xs text-muted-foreground">Drivers with positive balance</p>
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
              <TabsTrigger value="all">All ({drivers.length})</TabsTrigger>
              <TabsTrigger value="with_earnings">Ready for Payout ({driversWithEarnings})</TabsTrigger>
              <TabsTrigger value="in_debt">In Debt</TabsTrigger>
              <TabsTrigger value="online">Online ({onlineDrivers})</TabsTrigger>
            </TabsList>
            <div className="flex gap-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input placeholder="Search drivers..." className="pl-9 w-[200px]" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
              </div>
              <Button variant="outline" size="icon" onClick={() => refetch()}><RefreshCw className="h-4 w-4" /></Button>
              <Button variant="outline"><Download className="h-4 w-4 mr-2" />Export</Button>
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
                      <TableHead className="text-right">Gross Fares</TableHead>
                      <TableHead className="text-right">Commission</TableHead>
                      <TableHead className="text-right">Wallet Balance</TableHead>
                      <TableHead>Rating</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredDrivers.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">No drivers found</TableCell>
                      </TableRow>
                    ) : (
                      filteredDrivers.map((d) => (
                        <TableRow key={d.driver_id}>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center"><User className="h-4 w-4" /></div>
                              <div>
                                <p className="font-medium">{d.first_name} {d.last_name}</p>
                                <p className="text-xs text-muted-foreground">{d.email}</p>
                              </div>
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge variant={d.is_online ? 'default' : 'secondary'} className={d.is_online ? 'bg-green-500' : ''}>
                              {d.is_online ? 'Online' : 'Offline'}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right">{d.completed_trips}</TableCell>
                          <TableCell className="text-right">{formatPence(d.gross_trip_total)}</TableCell>
                          <TableCell className="text-right text-muted-foreground">-{formatPence(d.company_commission_total)}</TableCell>
                          <TableCell className={`text-right font-medium ${d.wallet_balance >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                            {formatPence(d.wallet_balance)}
                          </TableCell>
                          <TableCell>{d.rating ? <span className="flex items-center gap-1">⭐ {d.rating.toFixed(1)}</span> : '-'}</TableCell>
                          <TableCell className="text-right">
                            <Button variant="ghost" size="sm" onClick={() => setSelectedDriverId(d.driver_id)}><Eye className="h-4 w-4" /></Button>
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
              <DialogTitle>Driver Settlement Details</DialogTitle>
              <DialogDescription>
                {selectedDriverDetail?.first_name} {selectedDriverDetail?.last_name} — {selectedDriverDetail?.email}
              </DialogDescription>
            </DialogHeader>
            {selectedDriverDetail ? (
              <div className="space-y-4">
                {/* Summary Cards */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <Card><CardContent className="pt-4"><p className="text-xs text-muted-foreground">Gross Fares</p><p className="text-lg font-bold">{formatPence(selectedDriverDetail.gross_trip_total)}</p></CardContent></Card>
                  <Card><CardContent className="pt-4"><p className="text-xs text-muted-foreground">Commission</p><p className="text-lg font-bold text-blue-600">{formatPence(selectedDriverDetail.company_commission_total)}</p></CardContent></Card>
                  <Card><CardContent className="pt-4"><p className="text-xs text-muted-foreground">Wallet Balance</p><p className={`text-lg font-bold ${selectedDriverDetail.wallet_balance >= 0 ? 'text-green-600' : 'text-red-600'}`}>{formatPence(selectedDriverDetail.wallet_balance)}</p></CardContent></Card>
                  <Card><CardContent className="pt-4"><p className="text-xs text-muted-foreground">Available Payout</p><p className="text-lg font-bold text-green-600">{formatPence(selectedDriverDetail.available_for_payout)}</p></CardContent></Card>
                </div>

                {/* Wallet Breakdown */}
                <Card>
                  <CardContent className="pt-4 space-y-2 text-sm">
                    <div className="flex justify-between"><span className="text-muted-foreground flex items-center gap-1"><CreditCard className="h-3 w-3" /> Card Net Credits</span><span className="text-green-600">+{formatPence(selectedDriverDetail.card_net_credits)}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground flex items-center gap-1"><Banknote className="h-3 w-3" /> Cash Commission Debits</span><span className="text-red-600">-{formatPence(selectedDriverDetail.cash_commission_debits)}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Payouts Sent</span><span className="text-blue-600">-{formatPence(selectedDriverDetail.total_payouts_sent)}</span></div>
                    {selectedDriverDetail.adjustments_total !== 0 && (
                      <div className="flex justify-between"><span className="text-muted-foreground">Adjustments</span><span className={selectedDriverDetail.adjustments_total >= 0 ? 'text-green-600' : 'text-red-600'}>{selectedDriverDetail.adjustments_total >= 0 ? '+' : ''}{formatPence(selectedDriverDetail.adjustments_total)}</span></div>
                    )}
                    <Separator />
                    <div className="flex justify-between font-medium"><span>= Wallet Balance</span><span className={selectedDriverDetail.wallet_balance >= 0 ? 'text-green-600' : 'text-red-600'}>{formatPence(selectedDriverDetail.wallet_balance)}</span></div>
                    {selectedDriverDetail.amount_owed_to_onecab > 0 && (
                      <div className="flex justify-between text-red-600 font-medium"><span className="flex items-center gap-1"><AlertTriangle className="h-3 w-3" /> Owed to ONECAB</span><span>{formatPence(selectedDriverDetail.amount_owed_to_onecab)}</span></div>
                    )}
                  </CardContent>
                </Card>

                {/* Ledger */}
                <div>
                  <h4 className="font-medium mb-2">Transaction History</h4>
                  <ScrollArea className="h-[200px]">
                    {isLoadingLedger ? (
                      <div className="flex items-center justify-center py-8"><RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" /></div>
                    ) : ledgerEntries.length === 0 ? (
                      <p className="text-center text-muted-foreground py-8">No ledger transactions yet</p>
                    ) : (
                      <div className="space-y-2">
                        {ledgerEntries.map((entry) => {
                          const { label, color } = getEntryTypeDisplay(entry.entry_type);
                          const isPositive = entry.amount_pence > 0;
                          return (
                            <div key={entry.id} className="flex items-center justify-between p-3 rounded-lg border">
                              <div className="flex items-center gap-3">
                                <div className={`h-8 w-8 rounded-full flex items-center justify-center ${isPositive ? 'bg-green-100' : 'bg-red-100'}`}>
                                  {isPositive ? <ArrowDownRight className="h-4 w-4 text-green-600" /> : <ArrowUpRight className="h-4 w-4 text-red-600" />}
                                </div>
                                <div>
                                  <p className={`font-medium ${color}`}>{label}</p>
                                  <p className="text-xs text-muted-foreground">{format(new Date(entry.created_at), 'dd MMM yyyy, HH:mm')}</p>
                                </div>
                              </div>
                              <p className={`font-bold ${isPositive ? 'text-green-600' : 'text-red-600'}`}>{isPositive ? '+' : ''}{formatPence(entry.amount_pence)}</p>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </ScrollArea>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-center py-8"><RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" /></div>
            )}
            <DialogFooter className="gap-2 flex-wrap">
              <Button variant="outline" size="sm" onClick={() => { setAdjustmentType('add'); setShowAdjustmentDialog(true); }}>
                <Plus className="h-4 w-4 mr-1" /> Adjustment
              </Button>
              {selectedDriverDetail && selectedDriverDetail.available_for_payout > 0 && (
                <Button size="sm" onClick={() => selectedDriverId && payoutMutation.mutate(selectedDriverId)} disabled={payoutMutation.isPending}>
                  <Wallet className="h-4 w-4 mr-1" /> Payout {formatPence(selectedDriverDetail.available_for_payout)}
                </Button>
              )}
              <Button variant="outline" onClick={() => setSelectedDriverId(null)}>Close</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Adjustment Dialog */}
        <Dialog open={showAdjustmentDialog} onOpenChange={setShowAdjustmentDialog}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add Adjustment</DialogTitle>
              <DialogDescription>Add a manual credit or debit to the driver's wallet</DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="flex gap-2">
                <Button variant={adjustmentType === 'add' ? 'default' : 'outline'} size="sm" onClick={() => setAdjustmentType('add')}><Plus className="h-4 w-4 mr-1" />Credit</Button>
                <Button variant={adjustmentType === 'deduct' ? 'destructive' : 'outline'} size="sm" onClick={() => setAdjustmentType('deduct')}><Minus className="h-4 w-4 mr-1" />Debit</Button>
              </div>
              <div><Label>Amount (£)</Label><Input type="number" step="0.01" placeholder="0.00" value={adjustmentAmount} onChange={e => setAdjustmentAmount(e.target.value)} /></div>
              <div><Label>Reason</Label><Textarea placeholder="Reason for adjustment..." value={adjustmentReason} onChange={e => setAdjustmentReason(e.target.value)} /></div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowAdjustmentDialog(false)}>Cancel</Button>
              <Button onClick={handleAddAdjustment} disabled={adjustmentMutation.isPending}>{adjustmentMutation.isPending ? 'Processing...' : 'Submit'}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </AdminLayout>
  );
}