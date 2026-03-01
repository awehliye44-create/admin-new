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
import { supabase } from '@/integrations/supabase/client';
import { useQuery } from '@tanstack/react-query';
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
  XCircle
} from 'lucide-react';

interface Transaction {
  id: string;
  trip_code: string | null;
  trip_number: string | null;
  type: 'payment' | 'refund';
  amount: number;
  currency: string;
  status: string;
  description: string;
  customer_name: string | null;
  driver_name: string | null;
  trip_id: string;
  payment_method: string;
  created_at: string;
}

export default function Payments() {
  const [activeTab, setActiveTab] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [viewingTransaction, setViewingTransaction] = useState<Transaction | null>(null);

  // Fetch real trip payment data
  const { data: transactions = [], isLoading, refetch } = useQuery({
    queryKey: ['payments-transactions'],
    queryFn: async () => {
      const { data: trips, error } = await supabase
        .from('trips')
        .select(`
          id,
          trip_code,
          trip_number,
          fare,
          estimated_fare,
          currency_code,
          payment_status,
          payment_method,
          pickup_address,
          dropoff_address,
          passenger_name,
          created_at,
          status,
          driver_id
        `)
        .not('fare', 'is', null)
        .order('created_at', { ascending: false })
        .limit(100);
      
      if (error) throw error;

      // Get driver names for trips with drivers
      const driverIds = [...new Set(trips?.filter(t => t.driver_id).map(t => t.driver_id) || [])];
      let driversMap: Record<string, string> = {};
      
      if (driverIds.length > 0) {
        const { data: drivers } = await supabase
          .from('drivers')
          .select('id, first_name, last_name')
          .in('id', driverIds);
        
        driversMap = (drivers || []).reduce((acc, d) => {
          acc[d.id] = `${d.first_name} ${d.last_name}`;
          return acc;
        }, {} as Record<string, string>);
      }

      return (trips || []).map(trip => ({
        id: trip.id,
        trip_code: trip.trip_code,
        trip_number: trip.trip_number,
        type: 'payment' as const,
        amount: trip.fare || trip.estimated_fare || 0,
        currency: trip.currency_code?.toUpperCase() || 'GBP',
        status: trip.payment_status || 'pending',
        description: `${trip.pickup_address?.substring(0, 30)}... → ${trip.dropoff_address?.substring(0, 30)}...`,
        customer_name: trip.passenger_name || 'Guest',
        driver_name: trip.driver_id ? driversMap[trip.driver_id] || 'Unknown' : null,
        trip_id: trip.id,
        payment_method: trip.payment_method || 'cash',
        created_at: trip.created_at,
      }));
    },
  });

  const getStatusBadge = (status: string) => {
    const config: Record<string, { variant: 'default' | 'secondary' | 'destructive' | 'outline', icon: React.ReactNode }> = {
      completed: { variant: 'default', icon: <CheckCircle2 className="h-3 w-3 mr-1" /> },
      paid: { variant: 'default', icon: <CheckCircle2 className="h-3 w-3 mr-1" /> },
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

  const getTypeBadge = (type: string) => {
    const config: Record<string, { className: string, icon: React.ReactNode }> = {
      payment: { className: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-100', icon: <ArrowDownLeft className="h-3 w-3 mr-1" /> },
      refund: { className: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-100', icon: <ArrowUpRight className="h-3 w-3 mr-1" /> },
    };
    const { className, icon } = config[type] || { className: '', icon: null };
    return (
      <Badge variant="outline" className={`flex items-center w-fit ${className}`}>
        {icon}
        {type}
      </Badge>
    );
  };

  const getPaymentMethodDisplay = (method: string) => {
    const methods: Record<string, string> = {
      cash: 'Cash',
      card: 'Card',
      apple_pay: 'Apple Pay',
      google_pay: 'Google Pay',
      wallet: 'Wallet',
    };
    return methods[method] || method;
  };

  const filteredTransactions = transactions.filter(tx => {
    const matchesSearch = 
      tx.trip_code?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      tx.description.toLowerCase().includes(searchTerm.toLowerCase()) ||
      tx.customer_name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      tx.driver_name?.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = statusFilter === 'all' || tx.status === statusFilter;
    const matchesTab = activeTab === 'all' || tx.type === activeTab;
    return matchesSearch && matchesStatus && matchesTab;
  });

  // Stats from real data
  const totalRevenue = transactions
    .filter(t => t.type === 'payment' && (t.status === 'completed' || t.status === 'paid'))
    .reduce((sum, t) => sum + t.amount, 0);
  const pendingAmount = transactions
    .filter(t => t.status === 'pending')
    .reduce((sum, t) => sum + Math.abs(t.amount), 0);
  const todayTransactions = transactions
    .filter(t => new Date(t.created_at).toDateString() === new Date().toDateString()).length;
  const totalTransactions = transactions.length;

  if (isLoading) {
    return (
      <AdminLayout title="Payments & Payouts" description="Manage payments">
        <div className="flex items-center justify-center h-64">
          <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout 
      title="Payments & Payouts" 
      description="View and manage all payment transactions"
    >
      <div className="space-y-6">
        {/* Stats */}
        <div className="grid gap-4 md:grid-cols-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Revenue</CardTitle>
              <DollarSign className="h-4 w-4 text-green-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-500">£{totalRevenue.toFixed(2)}</div>
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <TrendingUp className="h-3 w-3 text-green-500" />
                From completed trips
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Transactions</CardTitle>
              <CreditCard className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{totalTransactions}</div>
              <p className="text-xs text-muted-foreground">All time</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Pending</CardTitle>
              <Clock className="h-4 w-4 text-amber-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-amber-500">£{pendingAmount.toFixed(2)}</div>
              <p className="text-xs text-muted-foreground">Awaiting payment</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Today's Transactions</CardTitle>
              <Wallet className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{todayTransactions}</div>
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

            <div className="flex gap-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input 
                  placeholder="Search..." 
                  className="pl-9 w-[200px]"
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
                  <SelectItem value="completed">Completed</SelectItem>
                  <SelectItem value="paid">Paid</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
                </SelectContent>
              </Select>
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
                      <TableHead>Trip Code</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Route</TableHead>
                      <TableHead>Amount</TableHead>
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
                          <TableCell className="font-mono text-sm">{tx.trip_number || tx.trip_code || tx.id.substring(0, 8).toUpperCase()}</TableCell>
                          <TableCell>{getTypeBadge(tx.type)}</TableCell>
                          <TableCell>
                            <div>
                              <p className="text-sm truncate max-w-[200px]">{tx.description}</p>
                              <p className="text-xs text-muted-foreground">
                                {tx.customer_name} {tx.driver_name && `• ${tx.driver_name}`}
                              </p>
                            </div>
                          </TableCell>
                          <TableCell className={`font-medium ${tx.amount >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                            {tx.currency} {tx.amount.toFixed(2)}
                          </TableCell>
                          <TableCell>{getStatusBadge(tx.status)}</TableCell>
                          <TableCell>{getPaymentMethodDisplay(tx.payment_method)}</TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {new Date(tx.created_at).toLocaleDateString()}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button 
                              variant="ghost" 
                              size="sm"
                              onClick={() => setViewingTransaction(tx)}
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

        {/* Transaction Detail Dialog */}
        <Dialog open={!!viewingTransaction} onOpenChange={() => setViewingTransaction(null)}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Transaction Details</DialogTitle>
              <DialogDescription>{viewingTransaction?.trip_number || viewingTransaction?.trip_code || viewingTransaction?.id}</DialogDescription>
            </DialogHeader>
            {viewingTransaction && (
              <div className="space-y-4 py-4">
                <div className="grid gap-4 grid-cols-2">
                  <div>
                    <p className="text-sm text-muted-foreground">Type</p>
                    {getTypeBadge(viewingTransaction.type)}
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Status</p>
                    {getStatusBadge(viewingTransaction.status)}
                  </div>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Amount</p>
                  <p className={`text-2xl font-bold ${viewingTransaction.amount >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {viewingTransaction.currency} {viewingTransaction.amount.toFixed(2)}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Route</p>
                  <p className="text-sm">{viewingTransaction.description}</p>
                </div>
                <div className="grid gap-4 grid-cols-2">
                  <div>
                    <p className="text-sm text-muted-foreground">Customer</p>
                    <p>{viewingTransaction.customer_name || '-'}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Driver</p>
                    <p>{viewingTransaction.driver_name || '-'}</p>
                  </div>
                </div>
                <div className="grid gap-4 grid-cols-2">
                  <div>
                    <p className="text-sm text-muted-foreground">Payment Method</p>
                    <p>{getPaymentMethodDisplay(viewingTransaction.payment_method)}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Date</p>
                    <p>{new Date(viewingTransaction.created_at).toLocaleString()}</p>
                  </div>
                </div>
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => setViewingTransaction(null)}>
                Close
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </AdminLayout>
  );
}
