import { useState } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { supabase } from '@/integrations/supabase/client';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { 
  CreditCard, 
  Search, 
  Download, 
  DollarSign,
  TrendingUp,
  Eye,
  RefreshCw,
  ArrowUpRight,
  ArrowDownLeft,
  Wallet,
  Clock,
  CheckCircle2,
  XCircle,
  Banknote,
  Smartphone
} from 'lucide-react';

interface PaymentSummary {
  totalRevenue: number;
  totalTransactions: number;
  pendingAmount: number;
  todayTransactions: number;
  completedTrips: number;
  refundedTrips: number;
  totalRefunds: number;
  paymentMethods: Record<string, number>;
}

interface PaymentTransaction {
  id: string;
  tripCode: string;
  type: 'payment' | 'refund';
  route: string;
  amount: number;
  refundAmount: number;
  status: string;
  method: string;
  date: string;
  completedAt: string | null;
  driver: string | null;
  driverId: string | null;
  customer: string | null;
  customerId: string | null;
  commission: number;
  driverNet: number;
  extras: number;
  tip: number;
  stripePaymentIntentId: string | null;
  stripeChargeId: string | null;
}

interface PaymentDetail {
  trip: {
    id: string;
    trip_code: string;
    trip_number: string;
    status: string;
    pickup_address: string;
    dropoff_address: string;
    created_at: string;
    completed_at: string | null;
  };
  customer: { name: string; id: string } | null;
  driver: { name: string; id: string } | null;
  fare_breakdown: {
    estimated_total_pence: number;
    authorised_amount_pence: number;
    final_fare_pence: number;
    extras_pence: number;
    tip_pence: number;
    gross_fare_pence: number;
  };
  commission_breakdown: {
    commission_percent: number;
    commission_fixed_pence: number;
    platform_commission_pence: number;
    driver_net_pence: number;
    stripe_processing_fee_pence: number;
  };
  payment_info: {
    payment_method: string;
    payment_status: string;
    stripe_payment_intent_id: string | null;
    stripe_charge_id: string | null;
  };
  refund_info: {
    refund_amount_pence: number;
    refund_reason: string | null;
    refunded_at: string | null;
  } | null;
}

const formatPence = (pence: number): string => {
  return `£${(pence / 100).toFixed(2)}`;
};

export default function AdminPayments() {
  const [activeTab, setActiveTab] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [methodFilter, setMethodFilter] = useState<string>('all');
  const [viewingTripId, setViewingTripId] = useState<string | null>(null);

  // Fetch summary from edge function
  const { data: summary, isLoading: isLoadingSummary, refetch: refetchSummary } = useQuery<PaymentSummary>({
    queryKey: ['admin-payments-summary'],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('admin-payments-summary', {
        method: 'GET',
      });
      if (error) throw error;
      return data;
    },
  });

  // Fetch transactions from edge function (GET query params)
  const { data: transactions = [], isLoading: isLoadingList, refetch: refetchList } = useQuery<PaymentTransaction[]>({
    queryKey: ['admin-payments-list', statusFilter, methodFilter, searchTerm],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (methodFilter !== 'all') params.set('method', methodFilter);
      if (searchTerm) params.set('search', searchTerm);

      const path = params.toString() ? `admin-payments-list?${params.toString()}` : 'admin-payments-list';
      const { data, error } = await supabase.functions.invoke(path, { method: 'GET' });
      if (error) throw error;
      return data.transactions || [];
    },
  });

  // Fetch payment detail when viewing
  const { data: paymentDetail, isLoading: isLoadingDetail } = useQuery<PaymentDetail>({
    queryKey: ['admin-payment-detail', viewingTripId],
    enabled: !!viewingTripId,
    queryFn: async () => {
      const path = `admin-payment-detail?trip_id=${viewingTripId}`;
      const { data, error } = await supabase.functions.invoke(path, { method: 'GET' });
      if (error) throw error;

      // Normalize camelCase edge response to the shape used by this page
      return {
        trip: {
          id: data.trip?.id,
          trip_code: data.trip?.tripCode || '',
          trip_number: data.trip?.tripCode || '',
          status: data.trip?.status || 'unknown',
          pickup_address: data.trip?.pickup?.address || '',
          dropoff_address: data.trip?.dropoff?.address || '',
          created_at: data.trip?.timestamps?.created || '',
          completed_at: data.trip?.timestamps?.completed || null,
        },
        customer: data.customer ? { name: data.customer.name, id: data.customer.id } : null,
        driver: data.driver ? { name: data.driver.name, id: data.driver.id } : null,
        fare_breakdown: {
          estimated_total_pence: data.fareBreakdown?.estimatedFare || 0,
          authorised_amount_pence: data.fareBreakdown?.authorisedAmount || 0,
          final_fare_pence: Math.max(
            0,
            (data.fareBreakdown?.grossFare || 0) - (data.fareBreakdown?.extras || 0) - (data.fareBreakdown?.tip || 0)
          ),
          extras_pence: data.fareBreakdown?.extras || 0,
          tip_pence: data.fareBreakdown?.tip || 0,
          gross_fare_pence: data.fareBreakdown?.grossFare || 0,
        },
        commission_breakdown: {
          commission_percent: data.commissionBreakdown?.commissionPercent || 0,
          commission_fixed_pence: data.commissionBreakdown?.commissionFixed || 0,
          platform_commission_pence: data.commissionBreakdown?.platformCommission || 0,
          driver_net_pence: data.commissionBreakdown?.driverNet || 0,
          stripe_processing_fee_pence: data.commissionBreakdown?.stripeFee || 0,
        },
        payment_info: {
          payment_method: data.trip?.paymentMethod || 'unknown',
          payment_status: data.trip?.paymentStatus || 'unknown',
          stripe_payment_intent_id: data.stripe?.paymentIntentId || null,
          stripe_charge_id: data.stripe?.chargeId || null,
        },
        refund_info: data.refund
          ? {
              refund_amount_pence: data.refund.amount || 0,
              refund_reason: data.refund.reason || null,
              refunded_at: data.refund.refundedAt || null,
            }
          : null,
      };
    },
  });

  const handleRefresh = () => {
    refetchSummary();
    refetchList();
  };

  const filteredTransactions = transactions.filter(tx => {
    const matchesTab = activeTab === 'all' || tx.type === activeTab;
    return matchesTab;
  });

  const getStatusBadge = (status: string) => {
    const config: Record<string, { variant: 'default' | 'secondary' | 'destructive' | 'outline', icon: React.ReactNode, label: string }> = {
      captured: { variant: 'default', icon: <CheckCircle2 className="h-3 w-3 mr-1" />, label: 'Paid' },
      completed: { variant: 'default', icon: <CheckCircle2 className="h-3 w-3 mr-1" />, label: 'Completed' },
      collected_cash: { variant: 'default', icon: <Banknote className="h-3 w-3 mr-1" />, label: 'Cash Collected' },
      authorized: { variant: 'secondary', icon: <Clock className="h-3 w-3 mr-1" />, label: 'Authorized' },
      pending: { variant: 'secondary', icon: <Clock className="h-3 w-3 mr-1" />, label: 'Pending' },
      failed: { variant: 'destructive', icon: <XCircle className="h-3 w-3 mr-1" />, label: 'Failed' },
      refunded: { variant: 'outline', icon: <ArrowUpRight className="h-3 w-3 mr-1" />, label: 'Refunded' },
    };
    const { variant, icon, label } = config[status] || { variant: 'outline', icon: null, label: status };
    return (
      <Badge variant={variant} className="flex items-center w-fit">
        {icon}
        {label}
      </Badge>
    );
  };

  const getMethodIcon = (method: string) => {
    switch (method?.toLowerCase()) {
      case 'card': return <CreditCard className="h-4 w-4" />;
      case 'apple_pay': return <Smartphone className="h-4 w-4" />;
      case 'google_pay': return <Smartphone className="h-4 w-4" />;
      case 'wallet': return <Wallet className="h-4 w-4" />;
      case 'cash': return <Banknote className="h-4 w-4" />;
      default: return <CreditCard className="h-4 w-4" />;
    }
  };

  const getMethodDisplay = (method: string) => {
    const methods: Record<string, string> = {
      cash: 'Cash',
      card: 'Card',
      apple_pay: 'Apple Pay',
      google_pay: 'Google Pay',
      wallet: 'Wallet',
    };
    return methods[method?.toLowerCase()] || method || 'Unknown';
  };

  const isLoading = isLoadingSummary || isLoadingList;

  if (isLoading && transactions.length === 0) {
    return (
      <AdminLayout title="Payments & Transactions" description="Manage payments">
        <div className="flex items-center justify-center h-64">
          <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout 
      title="Payments & Transactions" 
      description="Platform-wide payment reporting — derived from trip payments, refunds, and wallet events"
    >
      <div className="space-y-6">
        {/* Stats */}
        <div className="grid gap-4 md:grid-cols-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Platform Revenue</CardTitle>
              <DollarSign className="h-4 w-4 text-green-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-500">
                {formatPence(summary?.totalRevenue || 0)}
              </div>
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <TrendingUp className="h-3 w-3 text-green-500" />
                Commission - Stripe fees
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Transactions</CardTitle>
              <CreditCard className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{summary?.totalTransactions || 0}</div>
              <p className="text-xs text-muted-foreground">All completed trips</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Pending Amount</CardTitle>
              <Clock className="h-4 w-4 text-amber-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-amber-500">
                {formatPence(summary?.pendingAmount || 0)}
              </div>
              <p className="text-xs text-muted-foreground">Awaiting capture</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Today's Transactions</CardTitle>
              <Wallet className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{summary?.todayTransactions || 0}</div>
              <p className="text-xs text-muted-foreground">Transactions today</p>
            </CardContent>
          </Card>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
          <div className="flex flex-col sm:flex-row justify-between gap-4">
            <TabsList>
              <TabsTrigger value="all">All ({transactions.length})</TabsTrigger>
              <TabsTrigger value="payment">Payments</TabsTrigger>
              <TabsTrigger value="refund">Refunds</TabsTrigger>
            </TabsList>

            <div className="flex gap-2 flex-wrap">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input 
                  placeholder="Search..." 
                  className="pl-9 w-[180px]"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
              </div>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-[130px]">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  <SelectItem value="captured">Paid</SelectItem>
                  <SelectItem value="authorized">Authorized</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
                  <SelectItem value="refunded">Refunded</SelectItem>
                </SelectContent>
              </Select>
              <Select value={methodFilter} onValueChange={setMethodFilter}>
                <SelectTrigger className="w-[130px]">
                  <SelectValue placeholder="Method" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Methods</SelectItem>
                  <SelectItem value="card">Card</SelectItem>
                  <SelectItem value="apple_pay">Apple Pay</SelectItem>
                  <SelectItem value="google_pay">Google Pay</SelectItem>
                  <SelectItem value="wallet">Wallet</SelectItem>
                  <SelectItem value="cash">Cash</SelectItem>
                </SelectContent>
              </Select>
              <Button variant="outline" size="icon" onClick={handleRefresh}>
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
                      <TableHead>Trip Code</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Route</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Method</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredTransactions.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                          No transactions found
                        </TableCell>
                      </TableRow>
                    ) : (
                      filteredTransactions.map((tx) => (
                        <TableRow key={tx.id}>
                          <TableCell className="font-mono text-sm">
                            {tx.tripCode || tx.id?.substring(0, 8)}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className={`flex items-center w-fit ${tx.type === 'refund' ? 'text-red-600' : 'text-green-600'}`}>
                              {tx.type === 'refund' ? <ArrowUpRight className="h-3 w-3 mr-1" /> : <ArrowDownLeft className="h-3 w-3 mr-1" />}
                              {tx.type}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <div>
                              <p className="text-sm truncate max-w-[200px]">
                                {tx.route || 'Unknown route'}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {tx.customer} {tx.driver && `• ${tx.driver}`}
                              </p>
                            </div>
                          </TableCell>
                          <TableCell className="text-right font-medium text-green-600">
                            {formatPence(tx.amount || 0)}
                          </TableCell>
                          <TableCell>{getStatusBadge(tx.status)}</TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              {getMethodIcon(tx.method)}
                              <span className="text-sm">{getMethodDisplay(tx.method)}</span>
                            </div>
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {tx.date ? format(new Date(tx.date), 'dd MMM yyyy') : '-'}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button 
                              variant="ghost" 
                              size="sm"
                              onClick={() => setViewingTripId(tx.id)}
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

        {/* Payment Detail Dialog */}
        <Dialog open={!!viewingTripId} onOpenChange={() => setViewingTripId(null)}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Transaction Details</DialogTitle>
              <DialogDescription>
                {paymentDetail?.trip?.trip_number || paymentDetail?.trip?.trip_code || viewingTripId}
              </DialogDescription>
            </DialogHeader>
            {isLoadingDetail ? (
              <div className="flex items-center justify-center py-8">
                <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : paymentDetail ? (
              <div className="space-y-4 py-4">
                {/* Trip Info */}
                <div className="grid gap-4 grid-cols-2">
                  <div>
                    <p className="text-sm text-muted-foreground">Status</p>
                    {getStatusBadge(paymentDetail.payment_info.payment_status)}
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Payment Method</p>
                    <div className="flex items-center gap-2 mt-1">
                      {getMethodIcon(paymentDetail.payment_info.payment_method)}
                      <span>{getMethodDisplay(paymentDetail.payment_info.payment_method)}</span>
                    </div>
                  </div>
                </div>

                <Separator />

                {/* Fare Breakdown */}
                <div>
                  <h4 className="font-medium mb-2">Fare Breakdown</h4>
                  <Card>
                    <CardContent className="pt-4 space-y-2">
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Base Fare</span>
                        <span>{formatPence(paymentDetail.fare_breakdown.final_fare_pence || 0)}</span>
                      </div>
                      {paymentDetail.fare_breakdown.extras_pence > 0 && (
                        <div className="flex justify-between text-sm">
                          <span className="text-muted-foreground">Extras</span>
                          <span>{formatPence(paymentDetail.fare_breakdown.extras_pence)}</span>
                        </div>
                      )}
                      {paymentDetail.fare_breakdown.tip_pence > 0 && (
                        <div className="flex justify-between text-sm">
                          <span className="text-muted-foreground">Tip</span>
                          <span>{formatPence(paymentDetail.fare_breakdown.tip_pence)}</span>
                        </div>
                      )}
                      <Separator />
                      <div className="flex justify-between font-medium">
                        <span>Gross Total</span>
                        <span className="text-green-600">{formatPence(paymentDetail.fare_breakdown.gross_fare_pence || 0)}</span>
                      </div>
                    </CardContent>
                  </Card>
                </div>

                {/* Commission Breakdown */}
                <div>
                  <h4 className="font-medium mb-2">Commission Breakdown</h4>
                  <Card>
                    <CardContent className="pt-4 space-y-2">
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Commission Rate</span>
                        <span>{paymentDetail.commission_breakdown.commission_percent}%</span>
                      </div>
                      {paymentDetail.commission_breakdown.commission_fixed_pence > 0 && (
                        <div className="flex justify-between text-sm">
                          <span className="text-muted-foreground">Fixed Fee</span>
                          <span>{formatPence(paymentDetail.commission_breakdown.commission_fixed_pence)}</span>
                        </div>
                      )}
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Platform Commission</span>
                        <span className="text-blue-600">{formatPence(paymentDetail.commission_breakdown.platform_commission_pence || 0)}</span>
                      </div>
                      {paymentDetail.commission_breakdown.stripe_processing_fee_pence > 0 && (
                        <div className="flex justify-between text-sm">
                          <span className="text-muted-foreground">Stripe Fee</span>
                          <span className="text-red-500">-{formatPence(paymentDetail.commission_breakdown.stripe_processing_fee_pence)}</span>
                        </div>
                      )}
                      <Separator />
                      <div className="flex justify-between font-medium">
                        <span>Driver Net</span>
                        <span className="text-green-600">{formatPence(paymentDetail.commission_breakdown.driver_net_pence || 0)}</span>
                      </div>
                    </CardContent>
                  </Card>
                </div>

                {/* Stripe Info */}
                {paymentDetail.payment_info.stripe_payment_intent_id && (
                  <div>
                    <h4 className="font-medium mb-2">Stripe Details</h4>
                    <Card>
                      <CardContent className="pt-4 space-y-2 text-sm">
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Payment Intent</span>
                          <code className="bg-muted px-2 py-0.5 rounded text-xs">
                            {paymentDetail.payment_info.stripe_payment_intent_id}
                          </code>
                        </div>
                        {paymentDetail.payment_info.stripe_charge_id && (
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Charge ID</span>
                            <code className="bg-muted px-2 py-0.5 rounded text-xs">
                              {paymentDetail.payment_info.stripe_charge_id}
                            </code>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  </div>
                )}

                {/* Refund Info */}
                {paymentDetail.refund_info && paymentDetail.refund_info.refund_amount_pence > 0 && (
                  <div>
                    <h4 className="font-medium mb-2">Refund Details</h4>
                    <Card className="border-red-200">
                      <CardContent className="pt-4 space-y-2 text-sm">
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Refund Amount</span>
                          <span className="text-red-600">{formatPence(paymentDetail.refund_info.refund_amount_pence)}</span>
                        </div>
                        {paymentDetail.refund_info.refund_reason && (
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Reason</span>
                            <span>{paymentDetail.refund_info.refund_reason}</span>
                          </div>
                        )}
                        {paymentDetail.refund_info.refunded_at && (
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Refunded At</span>
                            <span>{format(new Date(paymentDetail.refund_info.refunded_at), 'dd MMM yyyy HH:mm')}</span>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  </div>
                )}

                {/* Customer & Driver */}
                <div className="grid gap-4 grid-cols-2">
                  <div>
                    <p className="text-sm text-muted-foreground">Customer</p>
                    <p className="font-medium">{paymentDetail.customer?.name || 'Guest'}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Driver</p>
                    <p className="font-medium">{paymentDetail.driver?.name || 'Unassigned'}</p>
                  </div>
                </div>
              </div>
            ) : null}
            <DialogFooter>
              <Button variant="outline" onClick={() => setViewingTripId(null)}>
                Close
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </AdminLayout>
  );
}
