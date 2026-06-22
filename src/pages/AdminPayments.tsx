import { useEffect, useMemo, useState } from 'react';
import { usePageLoadTelemetry } from '@/hooks/useAdminTelemetry';
import { getCurrencySymbol } from '@/lib/regionSettings';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { supabase } from '@/integrations/supabase/client';
import { keepPreviousData, useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { getTripDisplayId } from '@/lib/tripUtils';
import {
  CreditCard, Search, Download, Eye, RefreshCw,
  ArrowUpRight, ArrowDownLeft, Wallet, Clock, CheckCircle2, XCircle,
  Banknote, Smartphone, CalendarIcon,
} from 'lucide-react';
import { PaymentControlsCard } from '@/components/payment/PaymentControlsCard';
import { OnecabCommissionVisibility } from '@/components/finance/OnecabCommissionVisibility';
import { FinanceSSOTBadge } from '@/components/finance/FinanceSSOTBadge';
import {
  DEFAULT_SERVICE_AREA_SELECTION,
  ServiceAreaFinanceFilter,
  type ServiceAreaFinanceSelection,
} from '@/components/finance/ServiceAreaFinanceFilter';
import { useFinancialReconciliationSSOT } from '@/hooks/useFinancialReconciliationSSOT';
import {
  financePeriodLabel,
  resolveFinancePeriodRange,
  type FinancePeriod,
} from '@/lib/financePeriodRange';
import { cn } from '@/lib/utils';

interface PaymentTransaction {
  id: string;
  tripCode: string;
  type: 'payment' | 'refund';
  route: string;
  amount: number;
  customerPaid?: number;
  estimatedFare?: number;
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
  driverNet: number | null;
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
    customer_paid_pence: number;
    final_settlement_total_pence: number;
    waiting_charge_pence: number;
    extras_pence: number;
    tip_pence: number;
    /** @deprecated Legacy gross — quote comparison only */
    gross_fare_pence: number;
  };
  commission_breakdown: {
    commission_percent: number;
    commission_fixed_pence: number;
    platform_commission_pence: number;
    driver_net_pence: number | null;
    /** Stripe fee is absorbed inside commission — shown for transparency only, NOT deducted from driver */
    stripe_processing_fee_pence: number;
    /** ONECAB net after Stripe (commission - stripe fee). Read from DB. */
    onecab_net_pence: number;
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

const formatPence = (pence: number, currencyCode?: string): string => {
  const symbol = getCurrencySymbol(currencyCode || '');
  return `${symbol}${(pence / 100).toFixed(2)}`;
};

const formatPenceOrUnknown = (pence: number | null | undefined, currencyCode?: string): string => {
  if (pence == null) return 'Unknown';
  return formatPence(pence, currencyCode);
};

export default function AdminPayments() {
  usePageLoadTelemetry('PaymentsPage');
  const [activeTab, setActiveTab] = useState('all');
  const [period, setPeriod] = useState<FinancePeriod>('daily');
  const [customDateFrom, setCustomDateFrom] = useState<Date | undefined>(undefined);
  const [customDateTo, setCustomDateTo] = useState<Date | undefined>(undefined);
  const [serviceFilter, setServiceFilter] = useState<ServiceAreaFinanceSelection>(DEFAULT_SERVICE_AREA_SELECTION);
  const [tripSearchInput, setTripSearchInput] = useState('');
  const [tripSearchMode, setTripSearchMode] = useState<'code' | 'id'>('code');
  const [debouncedTripSearch, setDebouncedTripSearch] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedTripSearch(tripSearchInput.trim()), 350);
    return () => clearTimeout(timer);
  }, [tripSearchInput]);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [methodFilter, setMethodFilter] = useState<string>('all');
  const [viewingTripId, setViewingTripId] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const { startDate, endDate } = useMemo(
    () => resolveFinancePeriodRange(period, customDateFrom, customDateTo),
    [period, customDateFrom, customDateTo],
  );
  const periodFrom = startDate.toISOString();
  const periodTo = endDate.toISOString();
  const periodLabel = financePeriodLabel(period, startDate, endDate);

  const financeSSOT = useFinancialReconciliationSSOT({
    filter: serviceFilter,
    from: periodFrom,
    to: periodTo,
  });
  const activeCurrency = serviceFilter.currencyCode || financeSSOT.currencyCode || 'gbp';

  // Fetch transactions — same service area + completed_at window as SSOT totals
  const { data: transactions = [], isLoading: isLoadingList, isFetching: isFetchingList, isError: isListError, error: listError, refetch: refetchList } = useQuery<PaymentTransaction[]>({
    queryKey: [
      'admin-payments-list',
      statusFilter,
      methodFilter,
      debouncedTripSearch,
      tripSearchMode,
      activeTab,
      periodFrom,
      periodTo,
      serviceFilter.serviceAreaId,
      serviceFilter.regionId,
    ],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set('from', periodFrom);
      params.set('to', periodTo);
      params.set('limit', '500');
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (methodFilter !== 'all') params.set('method', methodFilter);
      if (debouncedTripSearch) {
        params.set('search', debouncedTripSearch);
        if (tripSearchMode === 'id') params.set('search_type', 'id');
      }
      if (activeTab === 'payment' || activeTab === 'refund') params.set('type', activeTab);
      if (serviceFilter.serviceAreaId) params.set('service_area_id', serviceFilter.serviceAreaId);
      if (serviceFilter.regionId) params.set('region_id', serviceFilter.regionId);

      const { data, error } = await supabase.functions.invoke(`admin-payments-list?${params.toString()}`, {
        method: 'GET',
      });
      if (error) throw new Error(data?.error || error.message || 'Failed to load payments list');
      if (data?.error) throw new Error(data.error);
      return data.transactions || [];
    },
  });

  // Fetch payment detail
  const { data: paymentDetail, isLoading: isLoadingDetail, error: detailError } = useQuery<PaymentDetail>({
    queryKey: ['admin-payment-detail', viewingTripId],
    enabled: !!viewingTripId,
    retry: false,
    queryFn: async () => {
      const path = `admin-payment-detail?trip_id=${viewingTripId}`;
      const { data, error } = await supabase.functions.invoke(path, { method: 'GET' });
      if (error) throw new Error(data?.error || error.message || 'Failed to load payment details');
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
          customer_paid_pence: data.fareBreakdown?.customerPaidPence ?? data.fareBreakdown?.finalSettlementTotalPence ?? 0,
          final_settlement_total_pence: data.fareBreakdown?.finalSettlementTotalPence ?? data.fareBreakdown?.customerPaidPence ?? 0,
          waiting_charge_pence: data.fareBreakdown?.waitingChargePence || 0,
          final_fare_pence: data.fareBreakdown?.finalSettlementTotalPence ?? data.fareBreakdown?.customerPaidPence ?? 0,
          extras_pence: data.fareBreakdown?.extras || 0,
          tip_pence: data.fareBreakdown?.tip || 0,
          gross_fare_pence: data.fareBreakdown?.grossFare || 0,
        },
        commission_breakdown: {
          commission_percent: data.commissionBreakdown?.commissionPercent || 0,
          commission_fixed_pence: data.commissionBreakdown?.commissionFixed || 0,
          platform_commission_pence: data.commissionBreakdown?.platformCommission || 0,
          driver_net_pence: data.commissionBreakdown?.driverNet ?? null,
          stripe_processing_fee_pence: data.commissionBreakdown?.stripeFee || 0,
          onecab_net_pence: data.commissionBreakdown?.onecabNet ?? (data.commissionBreakdown?.platformCommission || 0),
        },
        payment_info: {
          payment_method: data.trip?.paymentMethod || 'unknown',
          payment_status: data.trip?.paymentStatus || 'unknown',
          stripe_payment_intent_id: data.stripe?.paymentIntentId || null,
          stripe_charge_id: data.stripe?.chargeId || null,
        },
        refund_info: data.refund
          ? { refund_amount_pence: data.refund.amount || 0, refund_reason: data.refund.reason || null, refunded_at: data.refund.refundedAt || null }
          : null,
      };
    },
  });

  // Confirm payment mutation
  const confirmPaymentMutation = useMutation({
    mutationFn: async (tripId: string) => {
      const { data, error } = await supabase.functions.invoke('admin-payment-detail', {
        body: { trip_id: tripId, action: 'confirm_payment' },
      });
      if (error) throw new Error(data?.error || error.message || 'Failed to confirm payment');
      if (!data.success) throw new Error(data.error || 'Failed to confirm payment');
      return data;
    },
    onSuccess: (data) => {
      toast.success(`Payment ${data.newStatus || 'confirmed'} successfully`);
      queryClient.invalidateQueries({ queryKey: ['admin-payment-detail', viewingTripId] });
      queryClient.invalidateQueries({ queryKey: ['admin-payments-list'] });
    },
    onError: (error: Error) => toast.error(`Failed to confirm: ${error.message}`),
  });

  const handleRefresh = () => { refetchList(); financeSSOT.refetch(); };

  const filteredTransactions = transactions;

  const getStatusBadge = (status: string) => {
    const config: Record<string, { variant: 'default' | 'secondary' | 'destructive' | 'outline', icon: React.ReactNode, label: string }> = {
      captured: { variant: 'default', icon: <CheckCircle2 className="h-3 w-3 mr-1" />, label: 'Paid' },
      confirmed: { variant: 'default', icon: <CheckCircle2 className="h-3 w-3 mr-1" />, label: 'Confirmed' },
      completed: { variant: 'default', icon: <CheckCircle2 className="h-3 w-3 mr-1" />, label: 'Completed' },
      collected_cash: { variant: 'default', icon: <Banknote className="h-3 w-3 mr-1" />, label: 'Cash Collected' },
      authorized: { variant: 'secondary', icon: <Clock className="h-3 w-3 mr-1" />, label: 'Authorized' },
      pending: { variant: 'secondary', icon: <Clock className="h-3 w-3 mr-1" />, label: 'Pending' },
      failed: { variant: 'destructive', icon: <XCircle className="h-3 w-3 mr-1" />, label: 'Failed' },
      refunded: { variant: 'outline', icon: <ArrowUpRight className="h-3 w-3 mr-1" />, label: 'Refunded' },
    };
    const { variant, icon, label } = config[status] || { variant: 'outline' as const, icon: null, label: status };
    return <Badge variant={variant} className="flex items-center w-fit">{icon}{label}</Badge>;
  };

  const getMethodIcon = (method: string) => {
    switch (method?.toLowerCase()) {
      case 'card': return <CreditCard className="h-4 w-4" />;
      case 'apple_pay': case 'google_pay': return <Smartphone className="h-4 w-4" />;
      case 'wallet': return <Wallet className="h-4 w-4" />;
      case 'cash': return <Banknote className="h-4 w-4" />;
      default: return <CreditCard className="h-4 w-4" />;
    }
  };

  const getMethodDisplay = (method: string) => {
    const methods: Record<string, string> = { cash: 'Cash', card: 'Card', apple_pay: 'Apple Pay', google_pay: 'Google Pay', wallet: 'Wallet' };
    return methods[method?.toLowerCase()] || method || 'Unknown';
  };

  const isInitialLoad = isLoadingList && transactions.length === 0 && !isListError;

  if (isInitialLoad) {
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
      description="Financial Reconciliation SSOT — official revenue, commission, liability, and provider balances. Trip list is operational detail only."
    >
      <div className="space-y-6">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Filters</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-2">
              <Label>Service area</Label>
              <ServiceAreaFinanceFilter value={serviceFilter} onChange={setServiceFilter} className="w-full" />
            </div>
            <div className="space-y-2">
              <Label>Period</Label>
              <Select value={period} onValueChange={(v) => setPeriod(v as FinancePeriod)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="daily">Today</SelectItem>
                  <SelectItem value="weekly">This week</SelectItem>
                  <SelectItem value="monthly">This month</SelectItem>
                  <SelectItem value="custom">Custom range</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {period === 'custom' && (
              <div className="space-y-2 lg:col-span-2">
                <Label>Custom dates</Label>
                <div className="flex flex-wrap items-center gap-2">
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button variant="outline" className={cn('justify-start text-left font-normal', !customDateFrom && 'text-muted-foreground')}>
                        <CalendarIcon className="mr-2 h-4 w-4" />
                        {customDateFrom ? format(customDateFrom, 'MMM d, yyyy') : 'From'}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <Calendar mode="single" selected={customDateFrom} onSelect={setCustomDateFrom} initialFocus />
                    </PopoverContent>
                  </Popover>
                  <span className="text-muted-foreground text-sm">to</span>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button variant="outline" className={cn('justify-start text-left font-normal', !customDateTo && 'text-muted-foreground')}>
                        <CalendarIcon className="mr-2 h-4 w-4" />
                        {customDateTo ? format(customDateTo, 'MMM d, yyyy') : 'To'}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <Calendar
                        mode="single"
                        selected={customDateTo}
                        onSelect={setCustomDateTo}
                        disabled={(date) => (customDateFrom ? date < customDateFrom : false) || date > new Date()}
                        initialFocus
                      />
                    </PopoverContent>
                  </Popover>
                </div>
              </div>
            )}
          </CardContent>
          <CardContent className="pt-0 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span>{periodLabel}</span>
            <span>·</span>
            <span>{serviceFilter.serviceAreaId ? 'Selected service area' : 'All service areas'}</span>
            <FinanceSSOTBadge badge={financeSSOT.badge} />
            <Button variant="ghost" size="sm" className="ml-auto h-8" onClick={handleRefresh} disabled={financeSSOT.isFetching}>
              <RefreshCw className={cn('h-4 w-4 mr-1', financeSSOT.isFetching && 'animate-spin')} />
              Refresh
            </Button>
          </CardContent>
        </Card>

        <FinanceReconciliationTotalsCards ssot={financeSSOT} />
        <OnecabCommissionVisibility
          summary={financeSSOT.summary}
          currencyCode={serviceFilter.currencyCode || 'GBP'}
          filter={serviceFilter}
          dataBadge={financeSSOT.badge}
        />

        {isListError && (
          <Alert variant="destructive">
            <AlertTitle>Payments list failed to load</AlertTitle>
            <AlertDescription>
              {(listError as Error)?.message || 'The admin-payments-list API returned an error. Try Refresh or contact engineering.'}
            </AlertDescription>
          </Alert>
        )}

        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
          <div className="flex flex-col sm:flex-row justify-between gap-4">
            <TabsList>
              <TabsTrigger value="all">All ({transactions.length})</TabsTrigger>
              <TabsTrigger value="payment">Payments</TabsTrigger>
              <TabsTrigger value="refund">Refunds</TabsTrigger>
            </TabsList>

            <div className="flex gap-2 flex-wrap">
              <Select
                value={tripSearchMode}
                onValueChange={(v) => {
                  setTripSearchMode(v as 'code' | 'id');
                  setTripSearchInput('');
                  setDebouncedTripSearch('');
                }}
              >
                <SelectTrigger className="w-[110px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="code">Trip code</SelectItem>
                  <SelectItem value="id">Trip ID</SelectItem>
                </SelectContent>
              </Select>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder={
                    tripSearchMode === 'id'
                      ? 'Trip ID (UUID)'
                      : 'Trip code (e.g. MK-260616-016)'
                  }
                  className={cn('pl-9 pr-9', tripSearchMode === 'id' ? 'w-[280px]' : 'w-[240px]')}
                  value={tripSearchInput}
                  onChange={(e) => setTripSearchInput(e.target.value)}
                  aria-label={tripSearchMode === 'id' ? 'Search by trip ID' : 'Search by trip code or route'}
                />
                {isFetchingList && debouncedTripSearch !== tripSearchInput.trim() && (
                  <RefreshCw className="absolute right-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 animate-spin text-muted-foreground" />
                )}
              </div>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-[130px]"><SelectValue placeholder="Status" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  <SelectItem value="captured">Paid (Captured)</SelectItem>
                  <SelectItem value="confirmed">Confirmed</SelectItem>
                  <SelectItem value="collected_cash">Cash Collected</SelectItem>
                  <SelectItem value="authorized">Authorized</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
                  <SelectItem value="refunded">Refunded</SelectItem>
                </SelectContent>
              </Select>
              <Select value={methodFilter} onValueChange={setMethodFilter}>
                <SelectTrigger className="w-[130px]"><SelectValue placeholder="Method" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Methods</SelectItem>
                  <SelectItem value="card">Card</SelectItem>
                  <SelectItem value="apple_pay">Apple Pay</SelectItem>
                  <SelectItem value="google_pay">Google Pay</SelectItem>
                  <SelectItem value="wallet">Wallet</SelectItem>
                  <SelectItem value="cash">Cash</SelectItem>
                </SelectContent>
              </Select>
              <Button variant="outline" size="icon" onClick={handleRefresh}><RefreshCw className="h-4 w-4" /></Button>
              <Button variant="outline"><Download className="h-4 w-4 mr-2" />Export</Button>
            </div>
          </div>

          <TabsContent value={activeTab} className="m-0">
            <Card className={cn(isFetchingList && !isInitialLoad && 'opacity-80')}>
              <CardContent className="p-0 relative">
                {isFetchingList && !isInitialLoad && (
                  <div className="absolute top-3 right-3 z-10 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                    Updating…
                  </div>
                )}
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Trip Code</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Route</TableHead>
                      <TableHead className="text-right">Customer Paid</TableHead>
                      <TableHead className="text-right">Commission</TableHead>
                      <TableHead className="text-right">Driver Net</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Method</TableHead>
                      <TableHead>Completed</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredTransactions.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={10} className="text-center py-8 text-muted-foreground">
                          {debouncedTripSearch
                            ? `No transactions matching "${debouncedTripSearch}"`
                            : 'No transactions found'}
                        </TableCell>
                      </TableRow>
                    ) : (
                      filteredTransactions.map((tx) => (
                        <TableRow key={tx.id}>
                          <TableCell className="font-mono text-sm">
                            {getTripDisplayId({ trip_number: tx.tripCode, trip_code: tx.tripCode, id: tx.id })}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className={`flex items-center w-fit ${tx.type === 'refund' ? 'text-red-600' : 'text-green-600'}`}>
                              {tx.type === 'refund' ? <ArrowUpRight className="h-3 w-3 mr-1" /> : <ArrowDownLeft className="h-3 w-3 mr-1" />}
                              {tx.type}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <div>
                              <p className="text-sm truncate max-w-[200px]">{tx.route || 'Unknown route'}</p>
                              <p className="text-xs text-muted-foreground">{tx.customer} {tx.driver && `• ${tx.driver}`}</p>
                            </div>
                          </TableCell>
                          <TableCell className="text-right font-medium">
                            {formatPence(tx.customerPaid ?? tx.amount ?? 0, activeCurrency)}
                          </TableCell>
                          <TableCell className="text-right text-blue-600">{formatPence(tx.commission || 0, activeCurrency)}</TableCell>
                          <TableCell className="text-right text-green-600">
                            {formatPenceOrUnknown(tx.driverNet, activeCurrency)}
                          </TableCell>
                          <TableCell>{getStatusBadge(tx.status)}</TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              {getMethodIcon(tx.method)}
                              <span className="text-sm">{getMethodDisplay(tx.method)}</span>
                            </div>
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {tx.completedAt
                              ? format(new Date(tx.completedAt), 'dd MMM yyyy HH:mm')
                              : tx.date
                                ? format(new Date(tx.date), 'dd MMM yyyy')
                                : '-'}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button variant="ghost" size="sm" onClick={() => setViewingTripId(tx.id)}><Eye className="h-4 w-4" /></Button>
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
              <DialogDescription>{paymentDetail?.trip?.trip_number || paymentDetail?.trip?.trip_code || viewingTripId}</DialogDescription>
            </DialogHeader>
            {isLoadingDetail ? (
              <div className="flex items-center justify-center py-8"><RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" /></div>
            ) : detailError ? (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <XCircle className="h-10 w-10 text-destructive mb-3" />
                <p className="font-medium">Failed to load payment details</p>
                <p className="text-sm text-muted-foreground mt-1">{detailError.message}</p>
              </div>
            ) : paymentDetail ? (
              <div className="space-y-4 py-4 max-h-[70vh] overflow-y-auto">
                {viewingTripId && <PaymentControlsCard tripId={viewingTripId} />}
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
                  <h4 className="font-medium mb-2">Settlement Breakdown</h4>
                  <Card>
                    <CardContent className="pt-4 space-y-2">
                      {paymentDetail.fare_breakdown.estimated_total_pence > 0 && (
                        <div className="flex justify-between text-sm">
                          <span className="text-muted-foreground">Quoted / Estimated</span>
                          <span>{formatPence(paymentDetail.fare_breakdown.estimated_total_pence)}</span>
                        </div>
                      )}
                      {paymentDetail.fare_breakdown.waiting_charge_pence > 0 && (
                        <div className="flex justify-between text-sm">
                          <span className="text-muted-foreground">Waiting Time</span>
                          <span>{formatPence(paymentDetail.fare_breakdown.waiting_charge_pence)}</span>
                        </div>
                      )}
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
                        <span>Customer Paid</span>
                        <span>{formatPence(paymentDetail.fare_breakdown.customer_paid_pence || 0)}</span>
                      </div>
                      <div className="flex justify-between font-medium">
                        <span>Final Settlement Total</span>
                        <span>{formatPence(paymentDetail.fare_breakdown.final_settlement_total_pence || 0)}</span>
                      </div>
                    </CardContent>
                  </Card>
                </div>

                {/* Commission Breakdown */}
                <div>
                  <h4 className="font-medium mb-2">Commission & Settlement</h4>
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
                      <Separator />
                      <div className="flex justify-between font-medium">
                        <span>Driver Net</span>
                        <span className="text-green-600">
                          {formatPenceOrUnknown(paymentDetail.commission_breakdown.driver_net_pence)}
                        </span>
                      </div>

                      {/* ONECAB net-after-Stripe breakdown — read from DB, never recomputed */}
                      <Separator />
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Gross commission</span>
                        <span>{formatPence(paymentDetail.commission_breakdown.platform_commission_pence || 0)}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Stripe fee</span>
                        <span className="text-orange-600">
                          {paymentDetail.commission_breakdown.stripe_processing_fee_pence > 0
                            ? `−${formatPence(paymentDetail.commission_breakdown.stripe_processing_fee_pence)}`
                            : '—'}
                        </span>
                      </div>
                      <Separator />
                      <div className="flex justify-between font-medium">
                        <span>ONECAB net</span>
                        <span className="text-blue-600">{formatPence(paymentDetail.commission_breakdown.onecab_net_pence || 0)}</span>
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
                          <code className="bg-muted px-2 py-0.5 rounded text-xs">{paymentDetail.payment_info.stripe_payment_intent_id}</code>
                        </div>
                        {paymentDetail.payment_info.stripe_charge_id && (
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Charge ID</span>
                            <code className="bg-muted px-2 py-0.5 rounded text-xs">{paymentDetail.payment_info.stripe_charge_id}</code>
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
            <DialogFooter className="gap-2">
              {paymentDetail && paymentDetail.payment_info.payment_status === 'pending' && (
                <Button onClick={() => viewingTripId && confirmPaymentMutation.mutate(viewingTripId)} disabled={confirmPaymentMutation.isPending}>
                  {confirmPaymentMutation.isPending ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : <CheckCircle2 className="h-4 w-4 mr-2" />}
                  Confirm Payment
                </Button>
              )}
              <Button variant="outline" onClick={() => setViewingTripId(null)}>Close</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </AdminLayout>
  );
}
