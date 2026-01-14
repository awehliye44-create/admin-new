import { useState } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { 
  CreditCard, 
  Search, 
  Download, 
  DollarSign,
  TrendingUp,
  TrendingDown,
  Eye,
  RefreshCw,
  ArrowUpRight,
  ArrowDownLeft,
  Wallet,
  Clock,
  CheckCircle2,
  XCircle,
  Calendar
} from 'lucide-react';

interface Transaction {
  id: string;
  transaction_id: string;
  type: 'payment' | 'refund' | 'payout' | 'adjustment';
  amount: number;
  currency: string;
  status: 'completed' | 'pending' | 'failed' | 'processing';
  description: string;
  customer_name: string | null;
  driver_name: string | null;
  trip_id: string | null;
  payment_method: string;
  created_at: string;
}

const defaultTransactions: Transaction[] = [
  {
    id: '1',
    transaction_id: 'TXN-2024-0001',
    type: 'payment',
    amount: 45.50,
    currency: 'USD',
    status: 'completed',
    description: 'Trip payment - Downtown to Airport',
    customer_name: 'John Smith',
    driver_name: 'Mike Johnson',
    trip_id: 'TRIP-001',
    payment_method: 'Credit Card',
    created_at: '2024-01-14T10:30:00Z',
  },
  {
    id: '2',
    transaction_id: 'TXN-2024-0002',
    type: 'payment',
    amount: 28.00,
    currency: 'USD',
    status: 'completed',
    description: 'Trip payment - Office to Home',
    customer_name: 'Sarah Davis',
    driver_name: 'Alex Turner',
    trip_id: 'TRIP-002',
    payment_method: 'Apple Pay',
    created_at: '2024-01-14T09:15:00Z',
  },
  {
    id: '3',
    transaction_id: 'TXN-2024-0003',
    type: 'refund',
    amount: -15.00,
    currency: 'USD',
    status: 'completed',
    description: 'Partial refund - Trip cancellation',
    customer_name: 'Emily Chen',
    driver_name: null,
    trip_id: 'TRIP-003',
    payment_method: 'Credit Card',
    created_at: '2024-01-14T08:45:00Z',
  },
  {
    id: '4',
    transaction_id: 'TXN-2024-0004',
    type: 'payment',
    amount: 120.00,
    currency: 'USD',
    status: 'pending',
    description: 'Corporate trip - Client meeting',
    customer_name: 'TechCorp Solutions',
    driver_name: 'James Wilson',
    trip_id: 'TRIP-004',
    payment_method: 'Invoice',
    created_at: '2024-01-14T07:30:00Z',
  },
  {
    id: '5',
    transaction_id: 'TXN-2024-0005',
    type: 'payout',
    amount: -350.00,
    currency: 'USD',
    status: 'processing',
    description: 'Weekly driver payout',
    customer_name: null,
    driver_name: 'Mike Johnson',
    trip_id: null,
    payment_method: 'Bank Transfer',
    created_at: '2024-01-13T18:00:00Z',
  },
  {
    id: '6',
    transaction_id: 'TXN-2024-0006',
    type: 'payment',
    amount: 55.75,
    currency: 'USD',
    status: 'failed',
    description: 'Trip payment - Failed card',
    customer_name: 'Robert Brown',
    driver_name: 'Lisa Anderson',
    trip_id: 'TRIP-005',
    payment_method: 'Credit Card',
    created_at: '2024-01-13T16:20:00Z',
  },
];

export default function Payments() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [dateFilter, setDateFilter] = useState<string>('all');
  const [viewingTransaction, setViewingTransaction] = useState<Transaction | null>(null);

  const { data: transactions = [], isLoading } = useQuery({
    queryKey: ['payments-transactions'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('admin_settings')
        .select('*')
        .eq('setting_key', 'payments_transactions')
        .maybeSingle();
      
      if (error) throw error;
      return (data?.setting_value as unknown as Transaction[]) || defaultTransactions;
    },
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

  const getTypeBadge = (type: string) => {
    const config: Record<string, { className: string, icon: React.ReactNode }> = {
      payment: { className: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-100', icon: <ArrowDownLeft className="h-3 w-3 mr-1" /> },
      refund: { className: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-100', icon: <ArrowUpRight className="h-3 w-3 mr-1" /> },
      payout: { className: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-100', icon: <Wallet className="h-3 w-3 mr-1" /> },
      adjustment: { className: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-100', icon: <DollarSign className="h-3 w-3 mr-1" /> },
    };
    const { className, icon } = config[type] || { className: '', icon: null };
    return (
      <Badge variant="outline" className={`flex items-center w-fit ${className}`}>
        {icon}
        {type}
      </Badge>
    );
  };

  const filteredTransactions = transactions.filter(tx => {
    const matchesSearch = tx.transaction_id.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         tx.description.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         tx.customer_name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         tx.driver_name?.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = statusFilter === 'all' || tx.status === statusFilter;
    const matchesTab = activeTab === 'all' || tx.type === activeTab;
    return matchesSearch && matchesStatus && matchesTab;
  });

  // Stats
  const totalRevenue = transactions.filter(t => t.type === 'payment' && t.status === 'completed').reduce((sum, t) => sum + t.amount, 0);
  const totalRefunds = Math.abs(transactions.filter(t => t.type === 'refund').reduce((sum, t) => sum + t.amount, 0));
  const pendingAmount = transactions.filter(t => t.status === 'pending').reduce((sum, t) => sum + Math.abs(t.amount), 0);
  const todayTransactions = transactions.filter(t => new Date(t.created_at).toDateString() === new Date().toDateString()).length;

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
              <div className="text-2xl font-bold text-green-500">${totalRevenue.toFixed(2)}</div>
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <TrendingUp className="h-3 w-3 text-green-500" />
                +12% from last week
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Refunds</CardTitle>
              <ArrowUpRight className="h-4 w-4 text-red-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-red-500">${totalRefunds.toFixed(2)}</div>
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <TrendingDown className="h-3 w-3 text-green-500" />
                -5% from last week
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Pending</CardTitle>
              <Clock className="h-4 w-4 text-amber-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-amber-500">${pendingAmount.toFixed(2)}</div>
              <p className="text-xs text-muted-foreground">Awaiting processing</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Today's Transactions</CardTitle>
              <CreditCard className="h-4 w-4 text-muted-foreground" />
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
              <TabsTrigger value="all">All</TabsTrigger>
              <TabsTrigger value="payment">Payments</TabsTrigger>
              <TabsTrigger value="refund">Refunds</TabsTrigger>
              <TabsTrigger value="payout">Payouts</TabsTrigger>
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
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="processing">Processing</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
                </SelectContent>
              </Select>
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
                      <TableHead>Transaction ID</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Description</TableHead>
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
                          <TableCell className="font-mono text-sm">{tx.transaction_id}</TableCell>
                          <TableCell>{getTypeBadge(tx.type)}</TableCell>
                          <TableCell>
                            <div>
                              <p className="text-sm">{tx.description}</p>
                              <p className="text-xs text-muted-foreground">
                                {tx.customer_name || tx.driver_name}
                              </p>
                            </div>
                          </TableCell>
                          <TableCell className={`font-medium ${tx.amount >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                            {tx.amount >= 0 ? '+' : ''}{tx.currency} {tx.amount.toFixed(2)}
                          </TableCell>
                          <TableCell>{getStatusBadge(tx.status)}</TableCell>
                          <TableCell>{tx.payment_method}</TableCell>
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
              <DialogDescription>{viewingTransaction?.transaction_id}</DialogDescription>
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
                  <p className="text-sm text-muted-foreground">Description</p>
                  <p>{viewingTransaction.description}</p>
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
                    <p>{viewingTransaction.payment_method}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Date</p>
                    <p>{new Date(viewingTransaction.created_at).toLocaleString()}</p>
                  </div>
                </div>
                {viewingTransaction.trip_id && (
                  <div>
                    <p className="text-sm text-muted-foreground">Trip ID</p>
                    <p className="font-mono">{viewingTransaction.trip_id}</p>
                  </div>
                )}
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
