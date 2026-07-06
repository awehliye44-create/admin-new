import { useEffect, useState, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { supabase } from '@/integrations/supabase/client';
import { 
  Calendar, Loader2, Search, RefreshCw, Clock, MapPin, Phone,
  MoreHorizontal, UserPlus, XCircle, Eye, Play, CalendarClock,
  AlertTriangle, CheckCircle2, Car, CreditCard, Users, Briefcase,
  Mail, Navigation, Timer, ArrowRightLeft, Globe, Star
} from 'lucide-react';
import { Separator } from '@/components/ui/separator';
import { format, formatDistanceToNow, isPast, isToday, isTomorrow, addHours } from 'date-fns';
import { getCurrencySymbol, getDistanceUnitShort, convertDistance } from '@/lib/regionSettings';
import { getTripDisplayId } from '@/lib/tripUtils';
import { toast } from 'sonner';

interface ScheduledTrip {
  id: string;
  trip_number: string | null;
  trip_code: string | null;
  status: string | null;
  scheduled_status: string | null;
  passenger_name: string | null;
  passenger_phone: string | null;
  customer_id?: string | null;
  pickup_address: string;
  dropoff_address: string;
  pickup_latitude: number | null;
  pickup_longitude: number | null;
  dropoff_latitude: number | null;
  dropoff_longitude: number | null;
  estimated_fare: number | null;
  estimated_distance_km: number | null;
  estimated_duration_minutes: number | null;
  currency_code: string | null;
  scheduled_at: string | null;
  created_at: string;
  special_instructions: string | null;
  payment_method: string | null;
  vehicle_type: string | null;
  driver_id: string | null;
  service_area_id: string | null;
  driver?: {
    id: string;
    first_name: string;
    last_name: string;
    phone: string;
    profile_photo_url: string | null;
    rating: number | null;
  } | null;
  service_area?: {
    id: string;
    name: string;
    region?: {
      currency_code: string;
      distance_unit: string;
    } | null;
  } | null;
}

interface Driver {
  id: string;
  first_name: string;
  last_name: string;
  phone: string;
  is_online: boolean;
  rating: number | null;
  profile_photo_url: string | null;
}

export default function ScheduledRides() {
  const [searchQuery, setSearchQuery] = useState('');
  const [timeFilter, setTimeFilter] = useState('all');

  // Dialog states
  const [isViewOpen, setIsViewOpen] = useState(false);
  const [isAssignOpen, setIsAssignOpen] = useState(false);
  const [isCancelOpen, setIsCancelOpen] = useState(false);
  const [isDispatchOpen, setIsDispatchOpen] = useState(false);
  const [selectedTrip, setSelectedTrip] = useState<ScheduledTrip | null>(null);
  const [selectedDriverId, setSelectedDriverId] = useState('');
  const [cancelReason, setCancelReason] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const queryClient = useQueryClient();

  // React Query: scheduled trips + available drivers in parallel
  const { data: scheduledData, isLoading } = useQuery({
    queryKey: ['scheduled-rides'],
    queryFn: async () => {
      const [tripsRes, driversRes] = await Promise.all([
        supabase
          .from('trips')
          .select(`
            id,
            trip_number,
            trip_code,
            status,
            scheduled_status,
            passenger_name,
            passenger_phone,
            pickup_address,
            dropoff_address,
            pickup_latitude,
            pickup_longitude,
            dropoff_latitude,
            dropoff_longitude,
            estimated_fare,
            estimated_distance_km,
            estimated_duration_minutes,
            currency_code,
            scheduled_at,
            created_at,
            special_instructions,
            payment_method,
            vehicle_type,
            driver_id,
            service_area_id,
            driver:drivers!trips_driver_id_fkey(id, first_name, last_name, phone, profile_photo_url, rating),
            service_area:service_areas!trips_service_area_id_fkey(id, name, region:regions(currency_code, distance_unit))
          `)
          .eq('is_scheduled', true)
          .not('status', 'in', '(completed,cancelled)')
          .order('scheduled_at', { ascending: true }),
        supabase
          .from('drivers')
          .select('id, first_name, last_name, phone, is_online, rating, profile_photo_url')
          .eq('approval_status', 'approved'),
      ]);

      if (tripsRes.error) throw tripsRes.error;
      if (driversRes.error) throw driversRes.error;

      return {
        trips: (tripsRes.data as unknown as ScheduledTrip[]) || [],
        drivers: (driversRes.data as unknown as Driver[]) || [],
      };
    },
    staleTime: 15_000,
  });

  const trips = scheduledData?.trips ?? [];
  const availableDrivers = scheduledData?.drivers ?? [];

  const fetchData = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['scheduled-rides'] });
  }, [queryClient]);

  // Subscribe to real-time updates — silently invalidate cache
  useEffect(() => {
    const channel = supabase
      .channel('scheduled-rides-changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'trips' },
        () => queryClient.invalidateQueries({ queryKey: ['scheduled-rides'] })
      )
      .subscribe();
    
    return () => {
      supabase.removeChannel(channel);
    };
  }, [queryClient]);

  const handleAssignDriver = async () => {
    if (!selectedTrip || !selectedDriverId) {
      toast.error('Please select a driver');
      return;
    }

    setIsSaving(true);
    try {
      // Lock the driver to the scheduled booking WITHOUT converting to live.
      // The booking stays "scheduled" with scheduled_status = 'driver_assigned'.
      // Only when the driver accepts the live dispatch offer does status become 'accepted'.
      const { error } = await supabase
        .from('trips')
        .update({ 
          confirmed_driver_id: selectedDriverId,
          scheduled_status: 'driver_assigned',
          scheduled_accepted_at: new Date().toISOString(),
        })
        .eq('id', selectedTrip.id);

      if (error) throw error;

      toast.success('Driver assigned successfully');
      setIsAssignOpen(false);
      setSelectedTrip(null);
      setSelectedDriverId('');
      fetchData();
    } catch (err: any) {
      console.error('Error assigning driver:', err);
      toast.error(err.message || 'Failed to assign driver');
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancelTrip = async (e?: React.MouseEvent) => {
    e?.preventDefault();
    if (!selectedTrip) return;

    setIsSaving(true);
    try {
      const { error } = await supabase
        .from('trips')
        .update({ 
          status: 'cancelled',
          scheduled_status: 'cancelled',
          special_instructions: cancelReason 
            ? `Admin cancelled: ${cancelReason}. ${selectedTrip.special_instructions || ''}`
            : `Admin cancelled. ${selectedTrip.special_instructions || ''}`,
        })
        .eq('id', selectedTrip.id);

      if (error) throw error;

      toast.success('Scheduled ride cancelled');
      setIsCancelOpen(false);
      setSelectedTrip(null);
      setCancelReason('');
      fetchData();
    } catch (err: any) {
      console.error('Error cancelling trip:', err);
      toast.error(err.message || 'Failed to cancel ride');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDispatchNow = async () => {
    if (!selectedTrip) return;

    setIsSaving(true);
    try {
      // Mark booking as dispatching — alerts go to drivers.
      // The booking stays scheduled; customer sees "Upcoming" until a driver ACCEPTS.
      // Only driver acceptance (accept-trip or accept_scheduled_ride) changes status to live.
      const { error } = await supabase
        .from('trips')
        .update({ 
          scheduled_status: 'dispatching',
          dispatch_mode: 'scheduled',
        })
        .eq('id', selectedTrip.id);

      if (error) throw error;

      toast.success('Ride dispatched successfully');
      setIsDispatchOpen(false);
      setSelectedTrip(null);
      fetchData();
    } catch (err: any) {
      console.error('Error dispatching ride:', err);
      toast.error(err.message || 'Failed to dispatch ride');
    } finally {
      setIsSaving(false);
    }
  };

  /** Resolve currency: trip snapshot → region (single source of truth) */
  const resolveTripCurrency = (trip: ScheduledTrip): string =>
    trip.currency_code || trip.service_area?.region?.currency_code || '';

  /** Resolve distance unit from region */
  const resolveTripDistanceUnit = (trip: ScheduledTrip): string =>
    trip.service_area?.region?.distance_unit || 'km';


  const getScheduleStatus = (scheduledAt: string | null) => {
    if (!scheduledAt) return { label: 'No Date', color: 'bg-gray-100 text-gray-700', urgent: false };
    
    const date = new Date(scheduledAt);
    if (isPast(date)) {
      return { label: 'Overdue', color: 'bg-red-100 text-red-700', urgent: true };
    }
    if (isToday(date)) {
      return { label: 'Today', color: 'bg-amber-100 text-amber-700', urgent: true };
    }
    if (isTomorrow(date)) {
      return { label: 'Tomorrow', color: 'bg-blue-100 text-blue-700', urgent: false };
    }
    return { label: 'Upcoming', color: 'bg-green-100 text-green-700', urgent: false };
  };

  const filteredTrips = trips.filter(trip => {
    const matchesSearch = 
      getTripDisplayId(trip).toLowerCase().includes(searchQuery.toLowerCase()) ||
      trip.trip_code?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      trip.passenger_name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      trip.passenger_phone?.includes(searchQuery) ||
      trip.pickup_address?.toLowerCase().includes(searchQuery.toLowerCase());
    
    if (timeFilter === 'all') return matchesSearch;
    if (timeFilter === 'today' && trip.scheduled_at) return matchesSearch && isToday(new Date(trip.scheduled_at));
    if (timeFilter === 'tomorrow' && trip.scheduled_at) return matchesSearch && isTomorrow(new Date(trip.scheduled_at));
    if (timeFilter === 'overdue' && trip.scheduled_at) return matchesSearch && isPast(new Date(trip.scheduled_at));
    if (timeFilter === 'unassigned') return matchesSearch && !trip.driver_id;
    
    return matchesSearch;
  });

  const todayCount = trips.filter(t => t.scheduled_at && isToday(new Date(t.scheduled_at))).length;
  const tomorrowCount = trips.filter(t => t.scheduled_at && isTomorrow(new Date(t.scheduled_at))).length;
  const overdueCount = trips.filter(t => t.scheduled_at && isPast(new Date(t.scheduled_at))).length;
  const unassignedCount = trips.filter(t => !t.driver_id).length;

  return (
    <AdminLayout 
      title="Scheduled Rides" 
      description="Manage pre-booked and scheduled trips"
    >
      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Total Scheduled</p>
                <p className="text-2xl font-bold">{trips.length}</p>
              </div>
              <Calendar className="h-8 w-8 text-primary opacity-80" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-amber-500/30 bg-amber-500/5">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Today</p>
                <p className="text-2xl font-bold text-amber-600">{todayCount}</p>
              </div>
              <Clock className="h-8 w-8 text-amber-500" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-red-500/30 bg-red-500/5">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Overdue</p>
                <p className="text-2xl font-bold text-red-600">{overdueCount}</p>
              </div>
              <AlertTriangle className="h-8 w-8 text-red-500" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-blue-500/30 bg-blue-500/5">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Unassigned</p>
                <p className="text-2xl font-bold text-blue-600">{unassignedCount}</p>
              </div>
              <UserPlus className="h-8 w-8 text-blue-500" />
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <CalendarClock className="h-5 w-5 text-primary" />
              Scheduled Rides
            </CardTitle>
            <CardDescription>
              Pre-booked rides awaiting dispatch
            </CardDescription>
          </div>
          <div className="flex flex-col gap-2 md:flex-row md:items-center">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search rides..."
                className="pl-9 w-full md:w-[200px]"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
            <Select value={timeFilter} onValueChange={setTimeFilter}>
              <SelectTrigger className="w-full md:w-[150px]">
                <SelectValue placeholder="All Times" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Scheduled</SelectItem>
                <SelectItem value="today">Today</SelectItem>
                <SelectItem value="tomorrow">Tomorrow</SelectItem>
                <SelectItem value="overdue">Overdue</SelectItem>
                <SelectItem value="unassigned">Unassigned</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" onClick={() => fetchData()} disabled={isLoading}>
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
          ) : filteredTrips.length === 0 ? (
            <div className="py-12 text-center">
              <Calendar className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-medium mb-2">No scheduled rides</h3>
              <p className="text-muted-foreground">
                {searchQuery || timeFilter !== 'all' 
                  ? 'Try adjusting your filters' 
                  : 'There are no pre-booked rides at the moment'}
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Scheduled For</TableHead>
                  <TableHead>Booking ID</TableHead>
                  <TableHead>Passenger</TableHead>
                  <TableHead>Route</TableHead>
                  <TableHead>Vehicle / Payment</TableHead>
                  <TableHead>Driver</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Fare</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredTrips.map((trip) => {
                  const scheduleStatus = getScheduleStatus(trip.scheduled_at);
                  return (
                    <TableRow key={trip.id} className={scheduleStatus.urgent ? 'bg-red-50/50' : ''}>
                      <TableCell>
                        <div>
                          <div className="font-medium">
                            {trip.scheduled_at 
                              ? format(new Date(trip.scheduled_at), 'MMM d, yyyy')
                              : 'Not set'}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {trip.scheduled_at 
                              ? format(new Date(trip.scheduled_at), 'h:mm a')
                              : ''}
                          </div>
                          <Badge variant="outline" className={`mt-1 ${scheduleStatus.color}`}>
                            {scheduleStatus.label}
                          </Badge>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div>
                          <div className="font-mono text-sm font-medium">
                            {getTripDisplayId(trip)}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {format(new Date(trip.created_at), 'MMM d, h:mm a')}
                          </div>
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
                        <div className="max-w-[220px]">
                          <div className="flex items-start gap-1 text-xs">
                            <MapPin className="h-3 w-3 text-green-500 mt-0.5 shrink-0" />
                            <span className="line-clamp-2">{trip.pickup_address}</span>
                          </div>
                          <div className="flex items-start gap-1 text-xs mt-1">
                            <MapPin className="h-3 w-3 text-red-500 mt-0.5 shrink-0" />
                            <span className="line-clamp-2">{trip.dropoff_address}</span>
                          </div>
                          <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                            {trip.estimated_distance_km && (
                              <span className="flex items-center gap-0.5">
                                <Navigation className="h-3 w-3" />
                                {convertDistance(trip.estimated_distance_km, resolveTripDistanceUnit(trip)).toFixed(1)} {getDistanceUnitShort(resolveTripDistanceUnit(trip))}
                              </span>
                            )}
                            {trip.estimated_duration_minutes && (
                              <span className="flex items-center gap-0.5">
                                <Timer className="h-3 w-3" />
                                {trip.estimated_duration_minutes} min
                              </span>
                            )}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="space-y-1">
                          {trip.vehicle_type ? (
                            <Badge variant="outline" className="text-xs">
                              <Car className="h-3 w-3 mr-1" />
                              {trip.vehicle_type}
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="text-xs bg-gray-100">
                              <Car className="h-3 w-3 mr-1" />
                              Any
                            </Badge>
                          )}
                          {trip.payment_method && (
                            <Badge variant="outline" className="text-xs block w-fit bg-blue-100 text-blue-700">
                              <CreditCard className="h-3 w-3 mr-1" />
                              {trip.payment_method}
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        {trip.driver ? (
                          <div>
                            <div className="font-medium text-sm">
                              {trip.driver.first_name} {trip.driver.last_name}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {trip.driver.phone}
                            </div>
                            {trip.driver.rating && (
                              <div className="text-xs text-muted-foreground flex items-center gap-0.5 mt-0.5">
                                <Star className="h-3 w-3 text-yellow-500 fill-yellow-500" />
                                {trip.driver.rating.toFixed(1)}
                              </div>
                            )}
                          </div>
                        ) : (
                          <Badge variant="outline" className="bg-yellow-100 text-yellow-700">
                            Unassigned
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={
                          trip.scheduled_status === 'driver_assigned'
                            ? 'bg-green-100 text-green-700'
                            : trip.scheduled_status === 'dispatching'
                            ? 'bg-blue-100 text-blue-700'
                            : trip.status === 'accepted'
                            ? 'bg-green-100 text-green-700' 
                            : 'bg-gray-100 text-gray-700'
                        }>
                          {trip.scheduled_status === 'driver_assigned' ? 'Driver Assigned'
                            : trip.scheduled_status === 'dispatching' ? 'Dispatching'
                            : trip.status === 'accepted' ? 'Confirmed'
                            : 'Pending'}
                        </Badge>
                        {trip.service_area && (
                          <div className="text-xs text-muted-foreground mt-1">
                            {trip.service_area.name}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="font-medium">
                        <div>
                          {getCurrencySymbol(resolveTripCurrency(trip))}
                          {(trip.estimated_fare || 0).toFixed(2)}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => { setSelectedTrip(trip); setIsViewOpen(true); }}>
                              <Eye className="h-4 w-4 mr-2" />
                              View Details
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => { setSelectedTrip(trip); setSelectedDriverId(''); setIsAssignOpen(true); }}>
                              <UserPlus className="h-4 w-4 mr-2" />
                              {trip.driver ? 'Reassign Driver' : 'Assign Driver'}
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => { setSelectedTrip(trip); setIsDispatchOpen(true); }}>
                              <Play className="h-4 w-4 mr-2" />
                              Dispatch Now
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem 
                              onClick={() => { setSelectedTrip(trip); setCancelReason(''); setIsCancelOpen(true); }}
                              className="text-red-600"
                            >
                              <XCircle className="h-4 w-4 mr-2" />
                              Cancel Ride
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* View Details Dialog */}
      <Dialog open={isViewOpen} onOpenChange={setIsViewOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CalendarClock className="h-5 w-5 text-primary" />
              Scheduled Ride Details
            </DialogTitle>
            <DialogDescription className="flex items-center gap-2">
              <span className="font-mono font-medium">
                #{selectedTrip ? getTripDisplayId(selectedTrip) : ''}
              </span>
            </DialogDescription>
          </DialogHeader>
          {selectedTrip && (
            <div className="space-y-6">

              {/* Passenger Section */}
              <div>
                <Label className="text-xs text-muted-foreground mb-2 flex items-center gap-1">
                  <Users className="h-3 w-3" />
                  Passenger Details
                </Label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-2">
                  <div>
                    <p className="font-medium">{selectedTrip.passenger_name || 'Unknown'}</p>
                    <div className="text-sm text-muted-foreground flex items-center gap-1 mt-1">
                      <Phone className="h-3 w-3" />
                      {selectedTrip.passenger_phone || 'No phone'}
                    </div>
                  </div>
                </div>
              </div>

              <Separator />

              {/* Route Section */}
              <div>
                <Label className="text-xs text-muted-foreground mb-2 flex items-center gap-1">
                  <MapPin className="h-3 w-3" />
                  Route Details
                </Label>
                <div className="space-y-3 mt-2">
                  <div className="flex items-start gap-2 p-3 bg-green-50 rounded-lg border border-green-200">
                    <MapPin className="h-4 w-4 text-green-600 mt-0.5 shrink-0" />
                    <div>
                      <p className="text-xs text-green-600 font-medium">Pickup</p>
                      <p className="text-sm">{selectedTrip.pickup_address}</p>
                      {selectedTrip.pickup_latitude != null && selectedTrip.pickup_longitude != null && (
                        <p className="text-xs text-muted-foreground mt-1">
                          {selectedTrip.pickup_latitude.toFixed(6)}, {selectedTrip.pickup_longitude.toFixed(6)}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-start gap-2 p-3 bg-red-50 rounded-lg border border-red-200">
                    <MapPin className="h-4 w-4 text-red-600 mt-0.5 shrink-0" />
                    <div>
                      <p className="text-xs text-red-600 font-medium">Dropoff</p>
                      <p className="text-sm">{selectedTrip.dropoff_address}</p>
                      {selectedTrip.dropoff_latitude != null && selectedTrip.dropoff_longitude != null && (
                        <p className="text-xs text-muted-foreground mt-1">
                          {selectedTrip.dropoff_latitude.toFixed(6)}, {selectedTrip.dropoff_longitude.toFixed(6)}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              <Separator />

              {/* Vehicle & Payment Section */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label className="text-xs text-muted-foreground flex items-center gap-1">
                    <Car className="h-3 w-3" />
                    Vehicle Type
                  </Label>
                  <p className="font-medium text-sm mt-1">
                    {selectedTrip.vehicle_type || 'Any Available'}
                  </p>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground flex items-center gap-1">
                    <CreditCard className="h-3 w-3" />
                    Payment Method
                  </Label>
                  <Badge variant="outline" className="mt-1 bg-blue-100 text-blue-700">
                    {selectedTrip.payment_method || 'Not specified'}
                  </Badge>
                </div>
              </div>

              {/* Service Area */}
              {selectedTrip.service_area && (
                <div>
                  <Label className="text-xs text-muted-foreground flex items-center gap-1">
                    <Globe className="h-3 w-3" />
                    Service Area
                  </Label>
                  <p className="font-medium text-sm mt-1">{selectedTrip.service_area.name}</p>
                </div>
              )}

              <Separator />

              {/* Driver Section */}
              {selectedTrip.driver ? (
                <div>
                  <Label className="text-xs text-muted-foreground mb-2">Assigned Driver</Label>
                  <div className="flex items-center gap-3 mt-2 p-3 bg-muted/50 rounded-lg">
                    <div className="h-10 w-10 bg-primary/10 rounded-full flex items-center justify-center">
                      {selectedTrip.driver.profile_photo_url ? (
                        <img 
                          src={selectedTrip.driver.profile_photo_url} 
                          alt="Driver" 
                          className="h-10 w-10 rounded-full object-cover"
                        />
                      ) : (
                        <Users className="h-5 w-5 text-primary" />
                      )}
                    </div>
                    <div className="flex-1">
                      <p className="font-medium">
                        {selectedTrip.driver.first_name} {selectedTrip.driver.last_name}
                      </p>
                      <div className="flex items-center gap-3 text-sm text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <Phone className="h-3 w-3" />
                          {selectedTrip.driver.phone}
                        </span>
                        {selectedTrip.driver.rating && (
                          <span className="flex items-center gap-0.5">
                            <Star className="h-3 w-3 text-yellow-500 fill-yellow-500" />
                            {selectedTrip.driver.rating.toFixed(1)}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
                  <div className="flex items-center gap-2 text-yellow-700">
                    <UserPlus className="h-4 w-4" />
                    <span className="font-medium">No driver assigned</span>
                  </div>
                  <p className="text-sm text-yellow-600 mt-1">
                    Click "Assign Driver" to assign a driver to this scheduled ride.
                  </p>
                </div>
              )}

              {/* Special Instructions */}
              {selectedTrip.special_instructions && (
                <>
                  <Separator />
                  <div>
                    <Label className="text-xs text-muted-foreground">Special Instructions</Label>
                    <p className="text-sm mt-1 p-3 bg-muted/50 rounded-lg">
                      {selectedTrip.special_instructions}
                    </p>
                  </div>
                </>
              )}

              {/* Booking Metadata */}
              <div className="text-xs text-muted-foreground pt-2 border-t">
                <p>Booked on: {format(new Date(selectedTrip.created_at), 'PPP p')}</p>
                {selectedTrip.customer_id && (
                  <p className="mt-0.5">Customer ID: {selectedTrip.customer_id.slice(0, 8)}...</p>
                )}
              </div>
            </div>
          )}
          <DialogFooter className="flex gap-2">
            <Button variant="outline" onClick={() => setIsViewOpen(false)}>Close</Button>
            <Button 
              variant="default"
              onClick={() => { 
                setIsViewOpen(false);
                setSelectedDriverId(''); 
                setIsAssignOpen(true); 
              }}
            >
              <UserPlus className="h-4 w-4 mr-2" />
              {selectedTrip?.driver ? 'Reassign' : 'Assign Driver'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Assign Driver Dialog */}
      <Dialog open={isAssignOpen} onOpenChange={setIsAssignOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Assign Driver</DialogTitle>
            <DialogDescription>
              Select a driver for this scheduled ride
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Select Driver</Label>
              <Select value={selectedDriverId} onValueChange={setSelectedDriverId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a driver..." />
                </SelectTrigger>
                <SelectContent>
                  {availableDrivers.map(driver => (
                    <SelectItem key={driver.id} value={driver.id}>
                      <div className="flex items-center gap-2">
                        <span>{driver.first_name} {driver.last_name}</span>
                        {driver.is_online && (
                          <Badge variant="outline" className="bg-green-100 text-green-700 text-xs">
                            Online
                          </Badge>
                        )}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsAssignOpen(false)}>Cancel</Button>
            <Button onClick={handleAssignDriver} disabled={isSaving || !selectedDriverId}>
              {isSaving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Assign Driver
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cancel Ride Dialog */}
      <AlertDialog open={isCancelOpen} onOpenChange={setIsCancelOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel Scheduled Ride?</AlertDialogTitle>
            <AlertDialogDescription>
              This will cancel the scheduled ride. The passenger will be notified.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="py-4">
            <Label>Reason (optional)</Label>
            <Textarea
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              placeholder="Enter cancellation reason..."
              className="mt-2"
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isSaving}>Keep Ride</AlertDialogCancel>
            <AlertDialogAction 
              onClick={(e) => {
                e.preventDefault();
                handleCancelTrip(e);
              }}
              disabled={isSaving}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isSaving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Cancel Ride
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Dispatch Now Dialog */}
      <AlertDialog open={isDispatchOpen} onOpenChange={setIsDispatchOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Dispatch Ride Now?</AlertDialogTitle>
            <AlertDialogDescription>
              This will immediately dispatch this ride and start searching for available drivers.
              The scheduled time will be ignored.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep Scheduled</AlertDialogCancel>
            <AlertDialogAction onClick={handleDispatchNow}>
              {isSaving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Dispatch Now
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AdminLayout>
  );
}
