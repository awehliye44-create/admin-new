import { useState, useEffect } from 'react';
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
  Building2,
  MapPin,
  Globe
} from 'lucide-react';

import { getCurrencySymbol } from '@/lib/regionSettings';
import { enrichCorporateReportTrip } from '@/lib/corporateReportFinance';
import { sumPaymentCapturedPenceForTrip } from '@/lib/serviceAreaTripFinance';
import {
  formatDriverNetPence,
  formatSettlementPence,
  getQuotedContractFareMajor,
  sumCompletedCustomerPaidPence,
  type CorporateBillingTripRow,
} from '@/lib/corporateBillingFinance';

interface Invoice {
  id: string;
  invoice_number: string;
  corporate_account_id: string;
  amount: number;
  tax_amount: number | null;
  total_amount: number;
  status: string;
  due_date: string;
  paid_at: string | null;
  billing_period_start: string | null;
  billing_period_end: string | null;
  trip_count: number | null;
  notes: string | null;
  created_at: string;
  region_id: string | null;
  service_area_id: string | null;
  corporate_account?: { id: string; company_name: string } | null;
  region?: { id: string; name: string } | null;
  service_area?: { id: string; name: string } | null;
}

interface CorporateTrip extends CorporateBillingTripRow {
  trip_number: string | null;
  trip_code: string | null;
  fare: number | null;
  estimated_fare: number | null;
  waiting_charge_pence: number | null;
  total_waiting_charge_pence: number | null;
  fare_breakdown: Record<string, number> | null;
  currency_code: string | null;
  pickup_address: string | null;
  dropoff_address: string | null;
  completed_at: string | null;
  corporate_account?: { id: string; company_name: string } | null;
}

interface CorporateAccount {
  id: string;
  company_name: string;
  contact_name: string;
  contact_email: string;
  status: string;
  current_balance: number | null;
}

interface Region {
  id: string;
  name: string;
}

interface ServiceArea {
  id: string;
  name: string;
  region_id: string;
}

export default function CorporateBilling() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState('trips');
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [regionFilter, setRegionFilter] = useState<string>('all');
  const [serviceAreaFilter, setServiceAreaFilter] = useState<string>('all');
  const [companyFilter, setCompanyFilter] = useState<string>('all');
  const [viewingInvoice, setViewingInvoice] = useState<Invoice | null>(null);

  // Fetch corporate accounts
  const { data: corporateAccounts = [] } = useQuery({
    queryKey: ['corporate-accounts'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('corporate_accounts')
        .select('id, company_name, contact_name, contact_email, status, current_balance')
        .eq('status', 'active')
        .order('company_name');
      if (error) throw error;
      return data as CorporateAccount[];
    },
  });

  // Fetch corporate trips
  const { data: corporateTrips = [], isLoading: loadingTrips } = useQuery<CorporateTrip[]>({
    queryKey: ['corporate-trips'],
    queryFn: async () => {
      const { data: trips, error } = await supabase
        .from('trips')
        .select(`
          id, trip_number, trip_code, status, fare, estimated_fare, gross_fare_pence,
          final_fare_pence, capture_amount_pence, driver_net_pence, payment_method, payment_status,
          waiting_charge_pence, total_waiting_charge_pence, fare_breakdown,
          currency_code, pickup_address, dropoff_address, created_at, completed_at, corporate_account_id,
          corporate_account:corporate_accounts(id, company_name)
        `)
        .not('corporate_account_id', 'is', null)
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw error;

      const tripRows = trips || [];
      const tripIds = tripRows.map((trip) => trip.id);
      const paymentsByTripId = new Map<string, number>();
      const ledgerNetByTripId = new Map<string, number>();

      if (tripIds.length > 0) {
        const [paymentsRes, ledgerRes] = await Promise.all([
          supabase
            .from('payments')
            .select('trip_id, captured_amount_pence, amount_pence, status')
            .in('trip_id', tripIds),
          supabase
            .from('driver_wallet_ledger')
            .select('related_trip_id, amount_pence')
            .in('related_trip_id', tripIds)
            .eq('type', 'TRIP_EARNING_NET'),
        ]);

        if (paymentsRes.error) throw paymentsRes.error;
        if (ledgerRes.error) throw ledgerRes.error;

        const paymentsGrouped = new Map<string, Array<{
          captured_amount_pence: number | null;
          amount_pence: number | null;
          status: string | null;
        }>>();

        for (const payment of paymentsRes.data ?? []) {
          if (!payment.trip_id) continue;
          const list = paymentsGrouped.get(payment.trip_id) ?? [];
          list.push(payment);
          paymentsGrouped.set(payment.trip_id, list);
        }

        for (const [tripId, paymentRows] of paymentsGrouped) {
          const captured = sumPaymentCapturedPenceForTrip(paymentRows);
          if (captured > 0) paymentsByTripId.set(tripId, captured);
        }

        for (const entry of ledgerRes.data ?? []) {
          if (!entry.related_trip_id) continue;
          ledgerNetByTripId.set(entry.related_trip_id, entry.amount_pence);
        }
      }

      return tripRows.map((trip) =>
        enrichCorporateReportTrip(trip, paymentsByTripId, ledgerNetByTripId),
      ) as CorporateTrip[];
    },
  });

  // Fetch regions
  const { data: regions = [] } = useQuery({
    queryKey: ['regions'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('regions')
        .select('id, name')
        .order('name');
      if (error) throw error;
      return data as Region[];
    },
  });

  // Fetch service areas based on region filter
  const { data: serviceAreas = [] } = useQuery({
    queryKey: ['service-areas', regionFilter],
    queryFn: async () => {
      let query = supabase.from('service_areas').select('id, name, region_id').order('name');
      if (regionFilter !== 'all') {
        query = query.eq('region_id', regionFilter);
      }
      const { data, error } = await query;
      if (error) throw error;
      return data as ServiceArea[];
    },
  });

  // Reset service area filter when region changes
  useEffect(() => {
    setServiceAreaFilter('all');
  }, [regionFilter]);

  // Fetch invoices from database
  const { data: invoices = [], isLoading: loadingInvoices } = useQuery({
    queryKey: ['corporate-invoices', regionFilter, serviceAreaFilter],
    queryFn: async () => {
      let query = supabase
        .from('corporate_invoices')
        .select(`
          *,
          corporate_account:corporate_accounts(id, company_name),
          region:regions(id, name),
          service_area:service_areas(id, name)
        `)
        .order('created_at', { ascending: false });
      
      if (regionFilter !== 'all') {
        query = query.eq('region_id', regionFilter);
      }
      if (serviceAreaFilter !== 'all') {
        query = query.eq('service_area_id', serviceAreaFilter);
      }
      
      const { data, error } = await query;
      if (error) throw error;
      return data as Invoice[];
    },
  });

  // Update invoice mutation
  const updateInvoiceMutation = useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: Partial<Invoice> }) => {
      const { error } = await supabase
        .from('corporate_invoices')
        .update(updates)
        .eq('id', id);
      
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['corporate-invoices'] });
    },
  });

  const handleSendInvoice = async (invoice: Invoice) => {
    await updateInvoiceMutation.mutateAsync({ 
      id: invoice.id, 
      updates: { status: 'sent' } 
    });
    toast.success(`Invoice ${invoice.invoice_number} sent to ${invoice.corporate_account?.company_name}`);
  };

  const handleMarkPaid = async (invoice: Invoice) => {
    await updateInvoiceMutation.mutateAsync({ 
      id: invoice.id, 
      updates: { status: 'paid', paid_at: new Date().toISOString() } 
    });
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

  const filteredInvoices = invoices.filter(invoice => {
    const matchesSearch = invoice.invoice_number.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         invoice.corporate_account?.company_name?.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = statusFilter === 'all' || invoice.status === statusFilter;
    const matchesCompany = companyFilter === 'all' || invoice.corporate_account_id === companyFilter;
    return matchesSearch && matchesStatus && matchesCompany;
  });

  const filteredCorporateTrips = corporateTrips.filter(trip => {
    if (companyFilter !== 'all' && trip.corporate_account_id !== companyFilter) return false;
    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      const hay = `${trip.trip_number || ''} ${trip.trip_code || ''} ${trip.corporate_account?.company_name || ''} ${trip.pickup_address || ''} ${trip.dropoff_address || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  // Trip stats
  const totalCorpTrips = corporateTrips.length;
  const completedCorpTrips = corporateTrips.filter(t => t.status === 'completed').length;
  const totalCorpRevenue = sumCompletedCustomerPaidPence(corporateTrips) / 100;

  // Invoice Stats
  const totalRevenue = invoices.filter(i => i.status === 'paid').reduce((sum, i) => sum + i.total_amount, 0);
  const pendingInvoices = invoices.filter(i => i.status === 'sent').reduce((sum, i) => sum + i.total_amount, 0);
  const overdueAmount = invoices.filter(i => i.status === 'overdue').reduce((sum, i) => sum + i.total_amount, 0);
  const draftCount = invoices.filter(i => i.status === 'draft').length;

  const getTripStatusBadge = (status: string) => {
    const config: Record<string, { variant: 'default' | 'secondary' | 'destructive' | 'outline', className?: string }> = {
      pending: { variant: 'outline' },
      accepted: { variant: 'secondary' },
      arrived: { variant: 'secondary', className: 'bg-blue-500 text-white' },
      in_progress: { variant: 'default', className: 'bg-amber-500' },
      completed: { variant: 'default', className: 'bg-green-500' },
      cancelled: { variant: 'destructive' },
    };
    const { variant, className } = config[status] || { variant: 'outline' };
    return <Badge variant={variant} className={className}>{status.replace('_', ' ')}</Badge>;
  };

  if (loadingInvoices || loadingTrips) {
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
        {/* Stats - Conditional based on active tab */}
        {activeTab === 'trips' ? (
          <div className="grid gap-4 md:grid-cols-4">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Corporate Trips</CardTitle>
                <CreditCard className="h-4 w-4 text-primary" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{totalCorpTrips}</div>
                <p className="text-xs text-muted-foreground">Total bookings</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Completed</CardTitle>
                <CheckCircle2 className="h-4 w-4 text-green-500" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-green-500">{completedCorpTrips}</div>
                <p className="text-xs text-muted-foreground">Finished trips</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Settlement Revenue</CardTitle>
                <TrendingUp className="h-4 w-4 text-green-500" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-green-500">{getCurrencySymbol('')}{totalCorpRevenue.toFixed(2)}</div>
                <p className="text-xs text-muted-foreground">Customer paid — completed corporate trips</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Accounts</CardTitle>
                <Building2 className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{corporateAccounts.length}</div>
                <p className="text-xs text-muted-foreground">Active accounts</p>
              </CardContent>
            </Card>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-4">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Total Revenue</CardTitle>
                <DollarSign className="h-4 w-4 text-green-500" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-green-500">${totalRevenue.toLocaleString()}</div>
                <p className="text-xs text-muted-foreground">From paid invoices</p>
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
        )}

        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
          <div className="flex flex-col sm:flex-row justify-between gap-4">
            <TabsList>
              <TabsTrigger value="trips" className="flex items-center gap-2">
                <CreditCard className="h-4 w-4" />
                Trips
              </TabsTrigger>
              <TabsTrigger value="invoices" className="flex items-center gap-2">
                <Receipt className="h-4 w-4" />
                Invoices
              </TabsTrigger>
            </TabsList>

            <div className="flex flex-wrap gap-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input 
                  placeholder="Search..." 
                  className="pl-9 w-[200px]"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
              </div>
              <Select value={regionFilter} onValueChange={setRegionFilter}>
                <SelectTrigger className="w-[150px]">
                  <Globe className="h-4 w-4 mr-2" />
                  <SelectValue placeholder="Region" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Regions</SelectItem>
                  {regions.map((region) => (
                    <SelectItem key={region.id} value={region.id}>{region.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={serviceAreaFilter} onValueChange={setServiceAreaFilter}>
                <SelectTrigger className="w-[160px]">
                  <MapPin className="h-4 w-4 mr-2" />
                  <SelectValue placeholder="Service Area" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Areas</SelectItem>
                  {serviceAreas.map((area) => (
                    <SelectItem key={area.id} value={area.id}>{area.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={companyFilter} onValueChange={setCompanyFilter}>
                <SelectTrigger className="w-[200px]">
                  <Building2 className="h-4 w-4 mr-2" />
                  <SelectValue placeholder="Organization" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Organizations</SelectItem>
                  {corporateAccounts.map((acc) => (
                    <SelectItem key={acc.id} value={acc.id}>{acc.company_name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
                      <TableHead>Region</TableHead>
                      <TableHead>Amount</TableHead>
                      <TableHead>Status</TableHead>
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
                              {invoice.corporate_account?.company_name || 'Unknown'}
                            </div>
                          </TableCell>
                          <TableCell>
                            <span className="text-sm">
                              {invoice.region?.name || '—'}
                              {invoice.service_area?.name && <span className="text-muted-foreground"> / {invoice.service_area.name}</span>}
                            </span>
                          </TableCell>
                          <TableCell className="font-medium">${invoice.total_amount.toLocaleString()}</TableCell>
                          <TableCell>{getInvoiceStatusBadge(invoice.status)}</TableCell>
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

          {/* Corporate Trips Tab */}
          <TabsContent value="trips">
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Trip #</TableHead>
                      <TableHead>Company</TableHead>
                      <TableHead>Pickup</TableHead>
                      <TableHead>Dropoff</TableHead>
                      <TableHead>Customer Paid</TableHead>
                      <TableHead>Driver Net</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Date</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredCorporateTrips.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                          No corporate trips found. Trips linked to corporate accounts will appear here.
                        </TableCell>
                      </TableRow>
                    ) : (
                      filteredCorporateTrips.map((trip) => {
                        const currencyFmt = (amount: number) =>
                          `${getCurrencySymbol(trip.currency_code || '')}${amount.toFixed(2)}`;
                        const quotedFare = getQuotedContractFareMajor(trip);
                        const showQuoted =
                          trip.status !== 'completed'
                          && quotedFare != null
                          && quotedFare > 0;

                        return (
                        <TableRow key={trip.id}>
                          <TableCell className="font-medium">
                            {trip.trip_number || trip.trip_code || trip.id.slice(0, 8)}
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <Building2 className="h-4 w-4 text-muted-foreground" />
                              {trip.corporate_account?.company_name || 'Unknown'}
                            </div>
                          </TableCell>
                          <TableCell>
                            <span className="text-sm truncate max-w-[150px] block">
                              {trip.pickup_address || '—'}
                            </span>
                          </TableCell>
                          <TableCell>
                            <span className="text-sm truncate max-w-[150px] block">
                              {trip.dropoff_address || '—'}
                            </span>
                          </TableCell>
                          <TableCell className="font-medium">
                            {trip.status === 'completed' && trip.customerPaidPence > 0
                              ? formatSettlementPence(trip.customerPaidPence, currencyFmt)
                              : '—'}
                            {showQuoted && (
                              <span className="block text-[10px] text-muted-foreground">
                                Quoted / Contract Fare {currencyFmt(quotedFare!)}
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-green-600">
                            {trip.status === 'completed'
                              ? formatDriverNetPence(trip.driverNetPence, currencyFmt)
                              : '—'}
                          </TableCell>
                          <TableCell>{getTripStatusBadge(trip.status)}</TableCell>
                          <TableCell>
                            {new Date(trip.created_at).toLocaleDateString()}
                          </TableCell>
                        </TableRow>
                        );
                      })
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
              <DialogDescription>{viewingInvoice?.corporate_account?.company_name}</DialogDescription>
            </DialogHeader>
            {viewingInvoice && (
              <div className="space-y-4 py-4">
                <div className="grid gap-4 md:grid-cols-3">
                  <div>
                    <p className="text-sm text-muted-foreground">Status</p>
                    {getInvoiceStatusBadge(viewingInvoice.status)}
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Due Date</p>
                    <p className="font-medium">{new Date(viewingInvoice.due_date).toLocaleDateString()}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Trip Count</p>
                    <p className="font-medium">{viewingInvoice.trip_count || '—'}</p>
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <p className="text-sm text-muted-foreground">Region</p>
                    <p className="font-medium">{viewingInvoice.region?.name || 'Not specified'}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Service Area</p>
                    <p className="font-medium">{viewingInvoice.service_area?.name || 'Not specified'}</p>
                  </div>
                </div>

                {viewingInvoice.billing_period_start && viewingInvoice.billing_period_end && (
                  <div>
                    <p className="text-sm text-muted-foreground">Billing Period</p>
                    <p className="font-medium">
                      {new Date(viewingInvoice.billing_period_start).toLocaleDateString()} - {new Date(viewingInvoice.billing_period_end).toLocaleDateString()}
                    </p>
                  </div>
                )}

                <div className="border rounded-lg p-4 space-y-2">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Subtotal</span>
                    <span>${viewingInvoice.amount.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Tax</span>
                    <span>${(viewingInvoice.tax_amount || 0).toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between font-bold border-t pt-2">
                    <span>Total</span>
                    <span>${viewingInvoice.total_amount.toLocaleString()}</span>
                  </div>
                </div>

                {viewingInvoice.notes && (
                  <div>
                    <p className="text-sm text-muted-foreground">Notes</p>
                    <p className="text-sm bg-muted p-3 rounded-md">{viewingInvoice.notes}</p>
                  </div>
                )}

                {viewingInvoice.paid_at && (
                  <div className="text-sm text-muted-foreground">
                    Paid on {new Date(viewingInvoice.paid_at).toLocaleString()}
                  </div>
                )}
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => setViewingInvoice(null)}>
                Close
              </Button>
              {viewingInvoice?.status === 'draft' && (
                <Button onClick={() => { handleSendInvoice(viewingInvoice); setViewingInvoice(null); }}>
                  <Send className="h-4 w-4 mr-2" />
                  Send Invoice
                </Button>
              )}
              {(viewingInvoice?.status === 'sent' || viewingInvoice?.status === 'overdue') && (
                <Button onClick={() => { handleMarkPaid(viewingInvoice); setViewingInvoice(null); }}>
                  <CheckCircle2 className="h-4 w-4 mr-2" />
                  Mark as Paid
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </AdminLayout>
  );
}
