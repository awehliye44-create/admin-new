import { useState, useCallback, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { ADMIN_MISSED_CANCELLED_PAGE_SIZE, ADMIN_MISSED_CANCELLED_STATS_ROW_CAP } from '@/lib/adminQueryBounds';
import { formatCancellationReason, resolveCancellationActor, resolveCancellationReasonText } from '@/lib/tripCancellationReason';
import { 
  XCircle, Loader2, Search, RefreshCw, Clock, MapPin, Phone,
  Eye, AlertTriangle, Ban, TrendingDown,
} from 'lucide-react';
import { subDays, startOfDay, endOfDay } from 'date-fns';
import { formatFinanceDateSafe } from '@/lib/financialReconciliationGuards';
import { getCurrencySymbol } from '@/lib/regionSettings';
import { getTripDisplayId } from '@/lib/tripUtils';
import { fetchPassengerDirectory, hydratePassengerIdentity } from '@/lib/tripPassengerDisplay';
import { ServiceAreaFinanceFilter, DEFAULT_SERVICE_AREA_SELECTION, type ServiceAreaFinanceSelection } from '@/components/finance/ServiceAreaFinanceFilter';
import { CurrencyGroupedStats, getSingleCurrency } from '@/components/finance/CurrencyGroupedStats';
import { resolveAdminCommittedCustomerFarePence } from '@/lib/adminTripCommittedFareDisplay';
import { enrichTripsWithPaymentDisposition } from '@/lib/adminTripPaymentDisposition';
import type { AdminTripPaymentDispositionRead } from '../../shared/adminTripPaymentDispositionSSOT';
import {
  MISSED_CANCELLED_STATUSES,
  belongsInMissedCancelled,
} from '@/lib/adminTripNoShowClassification';
import { tripHistoryStatusLabel } from '../../shared/adminTripPaymentDispositionSSOT';
import { resolveTripHistoryTerminalOutcomeDisplay } from '../../shared/tripHistoryTerminalOutcomeDisplaySSOT';
import { TripHistoryTerminalOutcomePanel } from '@/components/trips/TripHistoryTerminalOutcomePanel';
import {
  classifyMissedCancelledBucket,
  isChargeableTerminalBucket,
  MISSED_CANCELLED_STATS_EXTRA_STATUSES,
  missedCancelledQuotedFareImpactPence,
  resolveAdminArrivalCancellationFeePence,
  summarizeMissedCancelledStats,
} from '@/lib/missedCancelledTerminalStats';

interface CancelledTrip {
  id: string;
  trip_number: string | null;
  trip_code: string | null;
  status: string | null;
  passenger_id: string | null;
  passenger_name: string | null;
  passenger_phone: string | null;
  pickup_address: string;
  dropoff_address: string;
  estimated_fare: number | null;
  fare: number | null;
  final_fare_pence: number | null;
  final_customer_fare_pence: number | null;
  estimated_total_pence: number | null;
  gross_fare_pence: number | null;
  offer_discount_pence?: number | null;
  discount_pence?: number | null;
  customer_modification_charge_pence?: number | null;
  currency_code: string | null;
  created_at: string;
  completed_at: string | null;
  special_instructions: string | null;
  driver_id: string | null;
  service_area_id: string | null;
  arrived_at: string | null;
  pickup_waiting_started_at: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  cancelled_by: string | null;
  cancelled_by_role: string | null;
  cancel_reason: string | null;
  cancellation_note: string | null;
  arrival_cancellation_applied: boolean | null;
  arrival_cancellation_fee: number | null;
  arrival_cancellation_applied_at: string | null;
  arrival_cancellation_reason: string | null;
  capture_amount_pence?: number | null;
  provider_fee_pence?: number | null;
  late_cancel_fee_pence?: number | null;
  previous_driver_id?: string | null;
  financial_outcome?: string | null;
  financial_model?: string | null;
  terminal_reason?: string | null;
  cancellation_fee_pence?: number | null;
  payment_status?: string | null;
  no_show_charge_pence?: number | null;
  payment_disposition?: AdminTripPaymentDispositionRead;
  driver?: {
    id: string;
    first_name: string;
    last_name: string;
    phone: string;
    region_id: string | null;
  } | null;
  previous_driver?: {
    id: string;
    first_name: string;
    last_name: string;
    phone: string;
    region_id: string | null;
  } | null;
  service_area?: {
    id: string;
    name: string;
    region_id: string;
    region: {
      currency_code: string;
    } | null;
  } | null;
}

/** Resolve currency for a trip from the Region chain (Region is single source of truth) */
function assignedDriver(trip: CancelledTrip) {
  return trip.driver ?? trip.previous_driver ?? null;
}

function resolveTripCurrency(trip: CancelledTrip): string {
  // Region is the authoritative source; fall back to trip snapshot only for historical records
  if (trip.service_area?.region?.currency_code) return trip.service_area.region.currency_code;
  if (trip.currency_code) return trip.currency_code;
  return '';
}

export default function MissedCancelled() {
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [dateFilter, setDateFilter] = useState('7days');
  const [serviceFilter, setServiceFilter] = useState<ServiceAreaFinanceSelection>(DEFAULT_SERVICE_AREA_SELECTION);
  const [listPage, setListPage] = useState(0);

  // Dialog states
  const [isViewOpen, setIsViewOpen] = useState(false);
  const [selectedTrip, setSelectedTrip] = useState<CancelledTrip | null>(null);

  const getDateRange = useCallback(() => {
    const now = new Date();
    switch (dateFilter) {
      case 'today':
        return { start: startOfDay(now), end: endOfDay(now) };
      case '7days':
        return { start: startOfDay(subDays(now, 7)), end: endOfDay(now) };
      case '30days':
        return { start: startOfDay(subDays(now, 30)), end: endOfDay(now) };
      case '90days':
        return { start: startOfDay(subDays(now, 90)), end: endOfDay(now) };
      default:
        return { start: startOfDay(subDays(now, 7)), end: endOfDay(now) };
    }
  }, [dateFilter]);

  // Debounce search so server-side filtering doesn't fire per keystroke.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(searchQuery.trim());
      setListPage(0);
    }, 300);
    return () => clearTimeout(t);
  }, [searchQuery]);

  const fetchRegionServiceAreaIds = useCallback(async (regionId: string): Promise<string[]> => {
    const { data, error } = await supabase
      .from('service_areas')
      .select('id')
      .eq('region_id', regionId);
    if (error) throw error;
    return (data || []).map((r) => r.id as string);
  }, []);

  const { data: missedPage, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['missed-cancelled', dateFilter, listPage, statusFilter, serviceFilter.regionId, debouncedSearch],
    queryFn: async () => {
      const { start, end } = getDateRange();

      let query = supabase
        .from('trips')
        .select(`
          id, trip_number, trip_code, status, passenger_id, passenger_name, passenger_phone,
          pickup_address, dropoff_address, estimated_fare, fare,
          final_fare_pence, final_customer_fare_pence, estimated_total_pence, gross_fare_pence,
          offer_discount_pence, discount_pence, customer_modification_charge_pence,
          currency_code, financial_outcome, no_show_charge_pence,
          created_at, completed_at, special_instructions, driver_id, service_area_id,
          arrived_at, pickup_waiting_started_at, cancelled_at, cancellation_reason,
          cancelled_by, cancelled_by_role, cancel_reason, cancellation_note,
          arrival_cancellation_applied, arrival_cancellation_fee, arrival_cancellation_applied_at, arrival_cancellation_reason,
          financial_model, cancellation_fee_pence, payment_status,
          capture_amount_pence, provider_fee_pence, late_cancel_fee_pence, previous_driver_id,
          driver:drivers!trips_driver_id_fkey(id, first_name, last_name, phone, region_id),
          previous_driver:drivers!trips_previous_driver_id_fkey(id, first_name, last_name, phone, region_id),
          service_area:service_areas!trips_service_area_id_fkey(id, name, region_id, region:regions(currency_code))
        `, { count: 'exact' })
        .gte('created_at', start.toISOString())
        .lte('created_at', end.toISOString());

      if (statusFilter === 'all') {
        query = query.in('status', [...MISSED_CANCELLED_STATUSES]);
      } else if (statusFilter === 'expired') {
        query = query.in('status', ['expired', 'expired_no_driver']);
      } else {
        query = query.eq('status', statusFilter);
      }

      if (serviceFilter.regionId) {
        const saIds = await fetchRegionServiceAreaIds(serviceFilter.regionId);
        if (saIds.length === 0) return { rows: [] as CancelledTrip[], totalCount: 0 };
        query = query.in('service_area_id', saIds);
      }

      const term = debouncedSearch.replace(/[%(),.\\"]/g, ' ').trim();
      if (term) {
        const like = `%${term}%`;
        query = query.or(
          `trip_number.ilike.${like},trip_code.ilike.${like},passenger_name.ilike.${like},passenger_phone.ilike.${like},pickup_address.ilike.${like}`,
        );
      }

      const from = listPage * ADMIN_MISSED_CANCELLED_PAGE_SIZE;
      const to = from + ADMIN_MISSED_CANCELLED_PAGE_SIZE - 1;
      const { data, error, count } = await query
        .order('created_at', { ascending: false })
        .range(from, to);

      if (error) throw error;
      const rows = (data || []) as unknown as CancelledTrip[];
      const directory = await fetchPassengerDirectory(rows.map((row) => row.passenger_id));
      const withDisposition = await enrichTripsWithPaymentDisposition(rows, 'missed_cancelled');
      // Defense in depth: never surface no-show outcomes here (Trip History owns them).
      const filtered = hydratePassengerIdentity(withDisposition, directory).filter((row) => belongsInMissedCancelled(row));
      return { rows: filtered, totalCount: count ?? filtered.length };

    },
    staleTime: 30_000,
  });

  // Range-wide stats (date window + service area): head counts for the exact total plus a
  // bounded row fetch that classifies each trip into one canonical bucket and feeds the
  // quoted-fare-impact total.
  const { data: rangeStats } = useQuery({
    queryKey: ['missed-cancelled-stats', dateFilter, serviceFilter.regionId],
    queryFn: async () => {
      const { start, end } = getDateRange();
      let saIds: string[] | null = null;
      if (serviceFilter.regionId) {
        saIds = await fetchRegionServiceAreaIds(serviceFilter.regionId);
        if (saIds.length === 0) {
          return { cancelled: 0, missed: 0, noShowStatus: 0, fareRows: [] as CancelledTrip[] };
        }
      }
      let noShowStatusQ = supabase
        .from('trips')
        .select('id', { count: 'exact', head: true })
        .in('status', [...MISSED_CANCELLED_STATS_EXTRA_STATUSES])
        .gte('created_at', start.toISOString())
        .lte('created_at', end.toISOString());
      let cancelledQ = supabase
        .from('trips')
        .select('id', { count: 'exact', head: true })
        .in('status', ['cancelled', 'customer_cancelled'])
        .gte('created_at', start.toISOString())
        .lte('created_at', end.toISOString());
      let missedQ = supabase
        .from('trips')
        .select('id', { count: 'exact', head: true })
        .in('status', ['missed', 'expired', 'expired_no_driver'])
        .gte('created_at', start.toISOString())
        .lte('created_at', end.toISOString());
      let fareQ = supabase
        .from('trips')
        .select(`
          id, currency_code, status, financial_outcome, payment_status, cancellation_reason,
          no_show_charge_pence, capture_amount_pence, cancellation_fee_pence, late_cancel_fee_pence,
          arrival_cancellation_applied, arrival_cancellation_reason, arrival_cancellation_fee,
          final_customer_fare_pence, final_fare_pence, estimated_total_pence, gross_fare_pence,
          offer_discount_pence, voucher_discount_pence, promotion_discount_pence, discount_pence, discount_source,
          fare, estimated_fare, fare_snapshot_json,
          service_area:service_areas!trips_service_area_id_fkey(region:regions(currency_code))
        `)
        .in('status', [...MISSED_CANCELLED_STATUSES, ...MISSED_CANCELLED_STATS_EXTRA_STATUSES])
        .gte('created_at', start.toISOString())
        .lte('created_at', end.toISOString())
        .order('created_at', { ascending: false })
        .limit(ADMIN_MISSED_CANCELLED_STATS_ROW_CAP);
      if (saIds) {
        cancelledQ = cancelledQ.in('service_area_id', saIds);
        missedQ = missedQ.in('service_area_id', saIds);
        noShowStatusQ = noShowStatusQ.in('service_area_id', saIds);
        fareQ = fareQ.in('service_area_id', saIds);
      }
      const [cancelledRes, missedRes, noShowStatusRes, fareRes] = await Promise.all([
        cancelledQ,
        missedQ,
        noShowStatusQ,
        fareQ,
      ]);
      if (cancelledRes.error) throw cancelledRes.error;
      if (missedRes.error) throw missedRes.error;
      if (noShowStatusRes.error) throw noShowStatusRes.error;
      if (fareRes.error) throw fareRes.error;
      return {
        cancelled: cancelledRes.count ?? 0,
        missed: missedRes.count ?? 0,
        noShowStatus: noShowStatusRes.count ?? 0,
        fareRows: (fareRes.data || []) as unknown as CancelledTrip[],
      };
    },
    staleTime: 30_000,
  });

  const allTrips = missedPage?.rows ?? [];
  const totalCount = missedPage?.totalCount ?? 0;
  const statsFareRows = rangeStats?.fareRows ?? [];

  const statsCurrencies = statsFareRows
    .filter(t => resolveTripCurrency(t))
    .map(t => ({ currency_code: resolveTripCurrency(t) }));
  const resolvedCurrency = serviceFilter.currencyCode || getSingleCurrency(statsCurrencies) || '';
  const isMixedCurrency = !serviceFilter.currencyCode && !getSingleCurrency(statsCurrencies) && statsFareRows.length > 0;

  const getStatusConfig = (trip: CancelledTrip) => {
    const label = tripHistoryStatusLabel(trip);
    if (label === 'Arrival Cancellation') {
      return { label, color: 'bg-rose-100 text-rose-700', icon: XCircle };
    }
    if (label === 'Late Passenger Cancellation') {
      return { label, color: 'bg-orange-100 text-orange-800', icon: XCircle };
    }
    if (label === 'No-Show') {
      return { label, color: 'bg-amber-100 text-amber-700', icon: AlertTriangle };
    }
    switch (trip.status) {
      case 'cancelled':
      case 'customer_cancelled':
        return { label: 'Cancelled', color: 'bg-red-100 text-red-700', icon: XCircle };
      case 'missed':
        return { label: 'Missed', color: 'bg-yellow-100 text-yellow-700', icon: AlertTriangle };
      case 'expired':
      case 'expired_no_driver':
        return { label: 'Expired', color: 'bg-gray-100 text-gray-700', icon: Clock };
      default:
        return { label: label || trip.status || 'Unknown', color: 'bg-gray-100 text-gray-700', icon: Ban };
    }
  };

  const getCancellationReason = (trip: CancelledTrip) => formatCancellationReason(trip);

  // Status, service-area and search filters are applied server-side.
  const filteredTrips = allTrips;

  // Range-wide counters from head-count stats — never derived from the loaded page.
  const cancelledCount = rangeStats?.cancelled ?? 0;
  const missedCount = rangeStats?.missed ?? 0;
  const noShowStatusCount = rangeStats?.noShowStatus ?? 0;
  const totalIssues = cancelledCount + missedCount + noShowStatusCount;
  const quotedFareImpactPence = (trip: CancelledTrip) =>
    missedCancelledQuotedFareImpactPence(trip, resolveAdminCommittedCustomerFarePence);
  const bucketStats = summarizeMissedCancelledStats(statsFareRows);
  const bucketStatsPartial = statsFareRows.length < totalIssues;
  const quotedFareImpactMajor = statsFareRows.reduce(
    (sum, t) => sum + quotedFareImpactPence(t) / 100,
    0,
  );

  const formatPaymentDisposition = (trip: CancelledTrip) => {
    const disposition = trip.payment_disposition;
    const sym = getCurrencySymbol(resolveTripCurrency(trip));
    if (!disposition) return '—';
    const amount = disposition.amount_pence;
    if (amount != null && amount > 0) {
      return `${disposition.payment_label} · ${sym}${(amount / 100).toFixed(2)}`;
    }
    return disposition.payment_label;
  };

  const formatQuotedFareImpact = (trip: CancelledTrip) => {
    const pence = quotedFareImpactPence(trip);
    const sym = getCurrencySymbol(resolveTripCurrency(trip));
    if (pence <= 0) return '—';
    return `${sym}${(pence / 100).toFixed(2)}`;
  };

  const formatPence = (trip: CancelledTrip, pence: number) =>
    `${getCurrencySymbol(resolveTripCurrency(trip))}${(pence / 100).toFixed(2)}`;

  return (
    <AdminLayout 
      title="Missed & Cancelled" 
      description="Review cancelled, missed, and expired trips (no-shows live in Trip History)"
    >
      {/* Service Area Filter */}
      <div className="flex items-center gap-3 mb-6">
        <ServiceAreaFinanceFilter financialModel="ALL_OPERATIONAL" value={serviceFilter} onChange={setServiceFilter} />
        {isMixedCurrency && (
          <Badge variant="outline" className="text-amber-600 border-amber-300">
            <AlertTriangle className="h-3 w-3 mr-1" /> Mixed currencies — select a service for totals
          </Badge>
        )}
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-4 mb-6">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Total Issues</p>
                <p className="text-2xl font-bold">{totalIssues}</p>
                {bucketStatsPartial && (
                  <p className="text-[10px] text-muted-foreground">
                    Breakdown from latest {statsFareRows.length} trips
                  </p>
                )}
              </div>
              <AlertTriangle className="h-8 w-8 text-muted-foreground opacity-80" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-rose-500/30 bg-rose-500/5">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Chargeable outcomes</p>
                <p className="text-2xl font-bold text-rose-600">{bucketStats.chargeable_total}</p>
                <div className="mt-1 space-y-0.5 text-[11px] text-muted-foreground">
                  <p>Arrival Cancellation: {bucketStats.arrival_cancellation}</p>
                  <p>No-Show: {bucketStats.no_show} (listed in Trip History)</p>
                  <p>Late Passenger Cancellation: {bucketStats.late_passenger_cancellation}</p>
                </div>
              </div>
              <XCircle className="h-8 w-8 text-rose-500" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-red-500/30 bg-red-500/5">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Cancelled / No Fee</p>
                <p className="text-2xl font-bold text-red-600">{bucketStats.cancelled_no_fee}</p>
                {bucketStats.cancelled_legacy_fee_evidence > 0 && (
                  <p className="text-[10px] text-muted-foreground">
                    {bucketStats.cancelled_legacy_fee_evidence} with legacy fee evidence — review
                  </p>
                )}
              </div>
              <XCircle className="h-8 w-8 text-red-500" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-orange-500/30 bg-orange-500/5">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Missed / Expired</p>
                <p className="text-2xl font-bold text-orange-600">{missedCount}</p>
              </div>
              <AlertTriangle className="h-8 w-8 text-orange-500" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-amber-500/30 bg-amber-500/5">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Quoted fare impact</p>
                <p className="text-[10px] text-muted-foreground">
                  Not charged / not revenue · excludes chargeable outcomes
                </p>
                {isMixedCurrency ? (
                  <CurrencyGroupedStats
                    items={statsFareRows.map(t => ({
                      currency_code: resolveTripCurrency(t) || '???',
                      amount: quotedFareImpactPence(t),
                    }))}
                    className="text-lg font-bold text-amber-600"
                  />
                ) : (
                  <p className="text-2xl font-bold text-amber-600">
                    {getCurrencySymbol(resolvedCurrency)}{quotedFareImpactMajor.toFixed(2)}
                  </p>
                )}
              </div>
              <TrendingDown className="h-8 w-8 text-amber-500" />
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Ban className="h-5 w-5 text-destructive" />
              Missed & Cancelled Trips
            </CardTitle>
            <CardDescription>
              Review and analyze failed trips
            </CardDescription>
          </div>
          <div className="flex flex-col gap-2 md:flex-row md:items-center">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search trips..."
                className="pl-9 w-full md:w-[180px]"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-full md:w-[130px]">
                <SelectValue placeholder="All Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="cancelled">Cancelled</SelectItem>
                <SelectItem value="customer_cancelled">Customer Cancelled</SelectItem>
                <SelectItem value="missed">Missed</SelectItem>
                <SelectItem value="expired">Expired</SelectItem>
              </SelectContent>
            </Select>
            <Select value={dateFilter} onValueChange={(v) => { setDateFilter(v); setListPage(0); }}>
              <SelectTrigger className="w-full md:w-[130px]">
                <SelectValue placeholder="Date Range" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="today">Today</SelectItem>
                <SelectItem value="7days">Last 7 Days</SelectItem>
                <SelectItem value="30days">Last 30 Days</SelectItem>
                <SelectItem value="90days">Last 90 Days</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" onClick={() => queryClient.invalidateQueries({ queryKey: ['missed-cancelled'] })} disabled={isLoading}>
              <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          ) : isError ? (
            <div className="py-12 text-center space-y-4">
              <AlertTriangle className="h-12 w-12 text-destructive mx-auto" />
              <h3 className="text-lg font-medium">Could not load trips</h3>
              <p className="text-muted-foreground text-sm">
                {error instanceof Error ? error.message : 'An unexpected error occurred.'}
              </p>
              <Button variant="outline" onClick={() => void refetch()}>
                <RefreshCw className="h-4 w-4 mr-2" />
                Retry
              </Button>
            </div>
          ) : filteredTrips.length === 0 ? (
            <div className="py-12 text-center">
              <XCircle className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-medium mb-2">No cancelled or missed trips</h3>
              <p className="text-muted-foreground">
                {searchQuery || statusFilter !== 'all' 
                  ? 'Try adjusting your filters' 
                  : 'Great! No issues in the selected time period'}
              </p>
            </div>
          ) : (
            <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Trip</TableHead>
                  <TableHead>Passenger</TableHead>
                  <TableHead>Route</TableHead>
                  <TableHead>Driver</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Payment</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredTrips.map((trip) => {
                  const statusConfig = getStatusConfig(trip);
                  const StatusIcon = statusConfig.icon;
                  return (
                    <TableRow key={trip.id}>
                      <TableCell>
                        <div className="font-mono text-sm font-medium">
                          {getTripDisplayId(trip)}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div>
                          <div className="font-medium">{trip.passenger_name || 'Unknown'}</div>
                          <div className="text-xs text-muted-foreground flex items-center gap-1">
                            <Phone className="h-3 w-3" />
                            {trip.passenger_phone || 'N/A'}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="max-w-[180px]">
                          <div className="flex items-start gap-1 text-xs">
                            <MapPin className="h-3 w-3 text-green-500 mt-0.5 shrink-0" />
                            <span className="truncate">{trip.pickup_address?.slice(0, 25)}...</span>
                          </div>
                          <div className="flex items-start gap-1 text-xs mt-1">
                            <MapPin className="h-3 w-3 text-red-500 mt-0.5 shrink-0" />
                            <span className="truncate">{trip.dropoff_address?.slice(0, 25)}...</span>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        {assignedDriver(trip) ? (
                          <div className="text-sm">
                            {assignedDriver(trip)!.first_name} {assignedDriver(trip)!.last_name}
                          </div>
                        ) : (
                          <span className="text-muted-foreground text-sm">No driver</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={statusConfig.color}>
                          <StatusIcon className="h-3 w-3 mr-1" />
                          {statusConfig.label}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <span className="text-sm text-muted-foreground">
                          {getCancellationReason(trip)}
                        </span>
                      </TableCell>
                      <TableCell className="text-sm">
                        {formatPaymentDisposition(trip)}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {formatFinanceDateSafe(trip.created_at, 'MMM d, HH:mm')}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button 
                          variant="ghost" 
                          size="sm"
                          onClick={() => { setSelectedTrip(trip); setIsViewOpen(true); }}
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <div className="flex items-center justify-between mt-4 gap-2 flex-wrap">
              <p className="text-sm text-muted-foreground">
                Page {listPage + 1}
                {totalCount ? ` · ${totalCount} in date range` : ''}
                {` · up to ${ADMIN_MISSED_CANCELLED_PAGE_SIZE} per page`}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={listPage <= 0 || isLoading}
                  onClick={() => setListPage((p) => Math.max(0, p - 1))}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={isLoading || allTrips.length < ADMIN_MISSED_CANCELLED_PAGE_SIZE}
                  onClick={() => setListPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* View Details Dialog */}
      <Dialog open={isViewOpen} onOpenChange={setIsViewOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Trip Details</DialogTitle>
            <DialogDescription>
              Trip #{selectedTrip ? getTripDisplayId(selectedTrip) : ''}
            </DialogDescription>
          </DialogHeader>
          {selectedTrip && (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                {(() => {
                  const config = getStatusConfig(selectedTrip);
                  const Icon = config.icon;
                  return (
                    <Badge variant="outline" className={config.color}>
                      <Icon className="h-3 w-3 mr-1" />
                      {config.label}
                    </Badge>
                  );
                })()}
                <span className="text-sm text-muted-foreground">
                  {getCancellationReason(selectedTrip)}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label className="text-muted-foreground">Created</Label>
                  <p className="font-medium">
                    {formatFinanceDateSafe(selectedTrip.created_at, 'PPP p')}
                  </p>
                </div>
                <div>
                  <Label className="text-muted-foreground">Payment (Payment Sessions)</Label>
                  <p className="font-medium">
                    {formatPaymentDisposition(selectedTrip)}
                  </p>
                </div>
                {isChargeableTerminalBucket(classifyMissedCancelledBucket(selectedTrip)) ? (
                  <div>
                    <Label className="text-muted-foreground">Quoted fare impact</Label>
                    <p className="font-medium text-muted-foreground">—</p>
                    <p className="text-[10px] text-muted-foreground">
                      Terminal fee charged — see Payment outcome. Original quote is context only.
                    </p>
                  </div>
                ) : (
                  <div>
                    <Label className="text-muted-foreground">Quoted fare impact</Label>
                    <p className="font-medium text-muted-foreground">
                      {formatQuotedFareImpact(selectedTrip)}
                    </p>
                    <p className="text-[10px] text-muted-foreground">Not charged / not revenue</p>
                  </div>
                )}
              </div>

              <div>
                <Label className="text-muted-foreground">Passenger</Label>
                <p className="font-medium">{selectedTrip.passenger_name || 'Unknown'}</p>
                <p className="text-sm text-muted-foreground">{selectedTrip.passenger_phone || 'No phone'}</p>
              </div>

              <div>
                <Label className="text-muted-foreground">Pickup</Label>
                <p className="text-sm">{selectedTrip.pickup_address}</p>
              </div>

              <div>
                <Label className="text-muted-foreground">Dropoff</Label>
                <p className="text-sm">{selectedTrip.dropoff_address}</p>
              </div>

              {assignedDriver(selectedTrip) && (
                <div>
                  <Label className="text-muted-foreground">Assigned Driver</Label>
                  <p className="font-medium">
                    {assignedDriver(selectedTrip)!.first_name} {assignedDriver(selectedTrip)!.last_name}
                  </p>
                  <p className="text-sm text-muted-foreground">{assignedDriver(selectedTrip)!.phone}</p>
                </div>
              )}

              {(() => {
                const terminalOutcome = resolveTripHistoryTerminalOutcomeDisplay(selectedTrip);
                if (!terminalOutcome) return null;
                return (
                  <TripHistoryTerminalOutcomePanel
                    display={terminalOutcome}
                    currencySymbol={getCurrencySymbol(resolveTripCurrency(selectedTrip))}
                    tripId={selectedTrip.id}
                    tripCode={selectedTrip.trip_code}
                    tripNumber={selectedTrip.trip_number}
                  />
                );
              })()}

              <div>
                <Label className="text-muted-foreground">Cancelled by</Label>
                <p className="font-medium">
                  {resolveCancellationActor(selectedTrip) ?? 'Not recorded'}
                </p>
                <Label className="text-muted-foreground mt-2 block">Reason given</Label>
                <p className="text-sm bg-muted p-2 rounded">
                  {resolveCancellationReasonText(selectedTrip)}
                </p>
              </div>

              {selectedTrip.special_instructions && (
                <div>
                  <Label className="text-muted-foreground">Notes</Label>
                  <p className="text-sm bg-muted p-2 rounded">
                    {selectedTrip.special_instructions}
                  </p>
                </div>
              )}

              <div className="space-y-2">
                <Label className="text-muted-foreground">Trip Timeline</Label>
                <div className="bg-muted/50 rounded-lg p-3 space-y-2 text-sm">
                  <div className="flex justify-between gap-3">
                    <span className="text-muted-foreground">Created</span>
                    <span>{formatFinanceDateSafe(selectedTrip.created_at, 'PPp')}</span>
                  </div>
                  {selectedTrip.pickup_waiting_started_at && (
                    <div className="flex justify-between gap-3">
                      <span className="text-muted-foreground">Pickup waiting started</span>
                      <span>{formatFinanceDateSafe(selectedTrip.pickup_waiting_started_at, 'PPp')}</span>
                    </div>
                  )}
                  {selectedTrip.arrived_at && (
                    <div className="flex justify-between gap-3">
                      <span className="text-muted-foreground">Driver arrived</span>
                      <span>{formatFinanceDateSafe(selectedTrip.arrived_at, 'PPp')}</span>
                    </div>
                  )}
                  {selectedTrip.cancelled_at && (
                    <div className="flex justify-between gap-3">
                      <span className="text-muted-foreground">Cancelled</span>
                      <span>{formatFinanceDateSafe(selectedTrip.cancelled_at, 'PPp')}</span>
                    </div>
                  )}
                  {(() => {
                    const feePence = resolveAdminArrivalCancellationFeePence(selectedTrip);
                    if (feePence == null) return null;
                    return (
                      <div className="flex justify-between gap-3 text-rose-700 dark:text-rose-400 font-medium">
                        <span>Arrival cancellation fee</span>
                        <span>{formatPence(selectedTrip, feePence)}</span>
                      </div>
                    );
                  })()}
                  {selectedTrip.arrival_cancellation_applied_at && (
                    <div className="flex justify-between gap-3 text-xs text-muted-foreground">
                      <span>Fee applied at</span>
                      <span>{formatFinanceDateSafe(selectedTrip.arrival_cancellation_applied_at, 'PPp')}</span>
                    </div>
                  )}
                </div>
              </div>

              {(() => {
                const feePence = resolveAdminArrivalCancellationFeePence(selectedTrip);
                if (feePence == null) return null;
                return (
                  <div className="space-y-2">
                    <Label className="text-muted-foreground">Fee Breakdown</Label>
                    <div className="bg-rose-500/5 border border-rose-500/20 rounded-lg p-3">
                      <div className="flex justify-between text-sm font-medium">
                        <span>Arrival cancellation fee</span>
                        <span>{formatPence(selectedTrip, feePence)}</span>
                      </div>
                      {!selectedTrip.arrival_cancellation_applied && (
                        <p className="mt-1 text-[10px] text-muted-foreground">
                          Legacy arrival metadata missing — amount from Payment Sessions capture.
                        </p>
                      )}
                    </div>
                  </div>
                );
              })()}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsViewOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}
