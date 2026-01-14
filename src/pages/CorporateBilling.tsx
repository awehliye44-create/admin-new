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
  Send,
  DollarSign,
  Calendar,
  FileText,
  Eye,
  RefreshCw,
  CheckCircle2,
  Clock,
  AlertCircle,
  Receipt,
  Banknote,
  TrendingUp,
  Building2
} from 'lucide-react';

interface Invoice {
  id: string;
  invoice_number: string;
  company_id: string;
  company_name: string;
  amount: number;
  tax: number;
  total: number;
  status: 'draft' | 'sent' | 'paid' | 'overdue' | 'cancelled';
  issue_date: string;
  due_date: string;
  paid_date: string | null;
  payment_method: string | null;
  items: { description: string; quantity: number; unit_price: number; total: number }[];
  notes: string;
}

interface Payment {
  id: string;
  payment_number: string;
  company_name: string;
  invoice_number: string;
  amount: number;
  payment_method: string;
  status: 'completed' | 'pending' | 'failed' | 'refunded';
  payment_date: string;
  transaction_id: string;
}

const defaultInvoices: Invoice[] = [
  {
    id: '1',
    invoice_number: 'INV-2024-001',
    company_id: '1',
    company_name: 'TechCorp Solutions',
    amount: 5000,
    tax: 500,
    total: 5500,
    status: 'paid',
    issue_date: '2024-01-01T00:00:00Z',
    due_date: '2024-01-31T00:00:00Z',
    paid_date: '2024-01-15T00:00:00Z',
    payment_method: 'Bank Transfer',
    items: [
      { description: 'Corporate Rides - January 2024', quantity: 150, unit_price: 33.33, total: 5000 }
    ],
    notes: 'Thank you for your business!'
  },
  {
    id: '2',
    invoice_number: 'INV-2024-002',
    company_id: '2',
    company_name: 'Global Finance Ltd',
    amount: 12000,
    tax: 1200,
    total: 13200,
    status: 'sent',
    issue_date: '2024-01-10T00:00:00Z',
    due_date: '2024-02-09T00:00:00Z',
    paid_date: null,
    payment_method: null,
    items: [
      { description: 'Executive Rides - January 2024', quantity: 80, unit_price: 100, total: 8000 },
      { description: 'Airport Transfers', quantity: 20, unit_price: 200, total: 4000 }
    ],
    notes: 'Payment due within 30 days'
  },
  {
    id: '3',
    invoice_number: 'INV-2024-003',
    company_id: '1',
    company_name: 'TechCorp Solutions',
    amount: 4500,
    tax: 450,
    total: 4950,
    status: 'overdue',
    issue_date: '2023-12-01T00:00:00Z',
    due_date: '2023-12-31T00:00:00Z',
    paid_date: null,
    payment_method: null,
    items: [
      { description: 'Corporate Rides - December 2023', quantity: 135, unit_price: 33.33, total: 4500 }
    ],
    notes: 'OVERDUE - Please remit payment immediately'
  },
  {
    id: '4',
    invoice_number: 'INV-2024-004',
    company_id: '3',
    company_name: 'Startup Hub Inc',
    amount: 800,
    tax: 80,
    total: 880,
    status: 'draft',
    issue_date: '2024-01-14T00:00:00Z',
    due_date: '2024-02-13T00:00:00Z',
    paid_date: null,
    payment_method: null,
    items: [
      { description: 'Standard Rides - January 2024', quantity: 40, unit_price: 20, total: 800 }
    ],
    notes: ''
  },
];

const defaultPayments: Payment[] = [
  {
    id: '1',
    payment_number: 'PAY-2024-001',
    company_name: 'TechCorp Solutions',
    invoice_number: 'INV-2024-001',
    amount: 5500,
    payment_method: 'Bank Transfer',
    status: 'completed',
    payment_date: '2024-01-15T10:30:00Z',
    transaction_id: 'TXN-ABC123456',
  },
  {
    id: '2',
    payment_number: 'PAY-2024-002',
    company_name: 'Global Finance Ltd',
    invoice_number: 'INV-2023-050',
    amount: 15000,
    payment_method: 'Credit Card',
    status: 'completed',
    payment_date: '2024-01-10T14:20:00Z',
    transaction_id: 'TXN-DEF789012',
  },
  {
    id: '3',
    payment_number: 'PAY-2024-003',
    company_name: 'Startup Hub Inc',
    invoice_number: 'INV-2023-048',
    amount: 500,
    payment_method: 'Credit Card',
    status: 'refunded',
    payment_date: '2024-01-05T09:00:00Z',
    transaction_id: 'TXN-GHI345678',
  },
];

export default function CorporateBilling() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState('invoices');
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [viewingInvoice, setViewingInvoice] = useState<Invoice | null>(null);

  // Fetch data
  const { data: invoices = [], isLoading: loadingInvoices } = useQuery({
    queryKey: ['corporate-invoices'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('admin_settings')
        .select('*')
        .eq('setting_key', 'corporate_invoices')
        .maybeSingle();
      
      if (error) throw error;
      return (data?.setting_value as unknown as Invoice[]) || defaultInvoices;
    },
  });

  const { data: payments = [], isLoading: loadingPayments } = useQuery({
    queryKey: ['corporate-payments'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('admin_settings')
        .select('*')
        .eq('setting_key', 'corporate_payments')
        .maybeSingle();
      
      if (error) throw error;
      return (data?.setting_value as unknown as Payment[]) || defaultPayments;
    },
  });

  // Save mutations
  const saveInvoicesMutation = useMutation({
    mutationFn: async (newInvoices: Invoice[]) => {
      const { error } = await supabase
        .from('admin_settings')
        .upsert([{
          setting_key: 'corporate_invoices',
          setting_value: JSON.parse(JSON.stringify(newInvoices)),
          description: 'Corporate invoices',
          updated_at: new Date().toISOString(),
        }], { onConflict: 'setting_key' });
      
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['corporate-invoices'] });
    },
  });

  const handleSendInvoice = async (invoice: Invoice) => {
    const updatedInvoices = invoices.map(inv => 
      inv.id === invoice.id ? { ...inv, status: 'sent' as const } : inv
    );
    await saveInvoicesMutation.mutateAsync(updatedInvoices);
    toast.success(`Invoice ${invoice.invoice_number} sent to ${invoice.company_name}`);
  };

  const handleMarkPaid = async (invoice: Invoice) => {
    const updatedInvoices = invoices.map(inv => 
      inv.id === invoice.id 
        ? { ...inv, status: 'paid' as const, paid_date: new Date().toISOString(), payment_method: 'Manual' } 
        : inv
    );
    await saveInvoicesMutation.mutateAsync(updatedInvoices);
    toast.success(`Invoice ${invoice.invoice_number} marked as paid`);
  };

  const getInvoiceStatusBadge = (status: string) => {
    const config: Record<string, { variant: 'default' | 'secondary' | 'destructive' | 'outline', className?: string }> = {
      draft: { variant: 'outline' },
      sent: { variant: 'secondary' },
      paid: { variant: 'default', className: 'bg-green-500' },
      overdue: { variant: 'destructive' },
      cancelled: { variant: 'outline', className: 'line-through' },
    };
    const { variant, className } = config[status] || { variant: 'outline' };
    return <Badge variant={variant} className={className}>{status}</Badge>;
  };

  const getPaymentStatusBadge = (status: string) => {
    const config: Record<string, { variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
      completed: { variant: 'default' },
      pending: { variant: 'secondary' },
      failed: { variant: 'destructive' },
      refunded: { variant: 'outline' },
    };
    return <Badge variant={config[status]?.variant || 'outline'}>{status}</Badge>;
  };

  const filteredInvoices = invoices.filter(invoice => {
    const matchesSearch = invoice.invoice_number.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         invoice.company_name.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = statusFilter === 'all' || invoice.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const filteredPayments = payments.filter(payment => {
    const matchesSearch = payment.payment_number.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         payment.company_name.toLowerCase().includes(searchTerm.toLowerCase());
    return matchesSearch;
  });

  // Stats
  const totalRevenue = payments.filter(p => p.status === 'completed').reduce((sum, p) => sum + p.amount, 0);
  const pendingInvoices = invoices.filter(i => i.status === 'sent').reduce((sum, i) => sum + i.total, 0);
  const overdueAmount = invoices.filter(i => i.status === 'overdue').reduce((sum, i) => sum + i.total, 0);
  const draftCount = invoices.filter(i => i.status === 'draft').length;

  const isLoading = loadingInvoices || loadingPayments;

  if (isLoading) {
    return (
      <AdminLayout title="Corporate Billing" description="Manage corporate billing and invoices">
        <div className="flex items-center justify-center h-64">
          <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout 
      title="Corporate Billing" 
      description="Manage invoices, payments, and billing for corporate accounts"
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
              <div className="text-2xl font-bold text-green-500">${totalRevenue.toLocaleString()}</div>
              <p className="text-xs text-muted-foreground">This month</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Pending</CardTitle>
              <Clock className="h-4 w-4 text-amber-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-amber-500">${pendingInvoices.toLocaleString()}</div>
              <p className="text-xs text-muted-foreground">Awaiting payment</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Overdue</CardTitle>
              <AlertCircle className="h-4 w-4 text-destructive" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-destructive">${overdueAmount.toLocaleString()}</div>
              <p className="text-xs text-muted-foreground">Past due date</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Drafts</CardTitle>
              <FileText className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{draftCount}</div>
              <p className="text-xs text-muted-foreground">Ready to send</p>
            </CardContent>
          </Card>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
          <div className="flex flex-col sm:flex-row justify-between gap-4">
            <TabsList>
              <TabsTrigger value="invoices" className="flex items-center gap-2">
                <Receipt className="h-4 w-4" />
                Invoices
              </TabsTrigger>
              <TabsTrigger value="payments" className="flex items-center gap-2">
                <Banknote className="h-4 w-4" />
                Payments
              </TabsTrigger>
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
              {activeTab === 'invoices' && (
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger className="w-[130px]">
                    <SelectValue placeholder="Status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All</SelectItem>
                    <SelectItem value="draft">Draft</SelectItem>
                    <SelectItem value="sent">Sent</SelectItem>
                    <SelectItem value="paid">Paid</SelectItem>
                    <SelectItem value="overdue">Overdue</SelectItem>
                  </SelectContent>
                </Select>
              )}
              <Button variant="outline">
                <Download className="h-4 w-4 mr-2" />
                Export
              </Button>
            </div>
          </div>

          <TabsContent value="invoices">
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Invoice #</TableHead>
                      <TableHead>Company</TableHead>
                      <TableHead>Amount</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Issue Date</TableHead>
                      <TableHead>Due Date</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredInvoices.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                          No invoices found
                        </TableCell>
                      </TableRow>
                    ) : (
                      filteredInvoices.map((invoice) => (
                        <TableRow key={invoice.id}>
                          <TableCell className="font-medium">{invoice.invoice_number}</TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <Building2 className="h-4 w-4 text-muted-foreground" />
                              {invoice.company_name}
                            </div>
                          </TableCell>
                          <TableCell className="font-medium">${invoice.total.toLocaleString()}</TableCell>
                          <TableCell>{getInvoiceStatusBadge(invoice.status)}</TableCell>
                          <TableCell>{new Date(invoice.issue_date).toLocaleDateString()}</TableCell>
                          <TableCell>{new Date(invoice.due_date).toLocaleDateString()}</TableCell>
                          <TableCell className="text-right">
                            <div className="flex items-center justify-end gap-2">
                              <Button 
                                variant="ghost" 
                                size="sm"
                                onClick={() => setViewingInvoice(invoice)}
                              >
                                <Eye className="h-4 w-4" />
                              </Button>
                              {invoice.status === 'draft' && (
                                <Button 
                                  variant="ghost" 
                                  size="sm"
                                  onClick={() => handleSendInvoice(invoice)}
                                >
                                  <Send className="h-4 w-4" />
                                </Button>
                              )}
                              {(invoice.status === 'sent' || invoice.status === 'overdue') && (
                                <Button 
                                  variant="ghost" 
                                  size="sm"
                                  onClick={() => handleMarkPaid(invoice)}
                                >
                                  <CheckCircle2 className="h-4 w-4" />
                                </Button>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="payments">
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Payment #</TableHead>
                      <TableHead>Company</TableHead>
                      <TableHead>Invoice</TableHead>
                      <TableHead>Amount</TableHead>
                      <TableHead>Method</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Date</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredPayments.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                          No payments found
                        </TableCell>
                      </TableRow>
                    ) : (
                      filteredPayments.map((payment) => (
                        <TableRow key={payment.id}>
                          <TableCell className="font-medium">{payment.payment_number}</TableCell>
                          <TableCell>{payment.company_name}</TableCell>
                          <TableCell className="text-muted-foreground">{payment.invoice_number}</TableCell>
                          <TableCell className="font-medium">${payment.amount.toLocaleString()}</TableCell>
                          <TableCell>{payment.payment_method}</TableCell>
                          <TableCell>{getPaymentStatusBadge(payment.status)}</TableCell>
                          <TableCell>{new Date(payment.payment_date).toLocaleDateString()}</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        {/* Invoice Detail Dialog */}
        <Dialog open={!!viewingInvoice} onOpenChange={() => setViewingInvoice(null)}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Invoice {viewingInvoice?.invoice_number}</DialogTitle>
              <DialogDescription>{viewingInvoice?.company_name}</DialogDescription>
            </DialogHeader>
            {viewingInvoice && (
              <div className="space-y-4 py-4">
                <div className="grid gap-4 md:grid-cols-3">
                  <div>
                    <p className="text-sm text-muted-foreground">Status</p>
                    {getInvoiceStatusBadge(viewingInvoice.status)}
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Issue Date</p>
                    <p className="font-medium">{new Date(viewingInvoice.issue_date).toLocaleDateString()}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Due Date</p>
                    <p className="font-medium">{new Date(viewingInvoice.due_date).toLocaleDateString()}</p>
                  </div>
                </div>

                <div className="border rounded-lg overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Description</TableHead>
                        <TableHead className="text-right">Qty</TableHead>
                        <TableHead className="text-right">Unit Price</TableHead>
                        <TableHead className="text-right">Total</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {viewingInvoice.items.map((item, idx) => (
                        <TableRow key={idx}>
                          <TableCell>{item.description}</TableCell>
                          <TableCell className="text-right">{item.quantity}</TableCell>
                          <TableCell className="text-right">${item.unit_price.toFixed(2)}</TableCell>
                          <TableCell className="text-right">${item.total.toFixed(2)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>

                <div className="flex justify-end">
                  <div className="w-64 space-y-2">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Subtotal</span>
                      <span>${viewingInvoice.amount.toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Tax</span>
                      <span>${viewingInvoice.tax.toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between font-bold text-lg border-t pt-2">
                      <span>Total</span>
                      <span>${viewingInvoice.total.toFixed(2)}</span>
                    </div>
                  </div>
                </div>

                {viewingInvoice.notes && (
                  <div className="bg-muted p-3 rounded-md">
                    <p className="text-sm text-muted-foreground">Notes</p>
                    <p className="text-sm">{viewingInvoice.notes}</p>
                  </div>
                )}
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => setViewingInvoice(null)}>
                Close
              </Button>
              <Button variant="outline">
                <Download className="h-4 w-4 mr-2" />
                Download PDF
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </AdminLayout>
  );
}
