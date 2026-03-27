import { useEffect, useState, useCallback } from 'react';
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
  MapPin, Loader2, Search, RefreshCw, Car, Users, Navigation, 
  MoreHorizontal, UserX, XCircle, CheckCircle2, Clock, Phone,
  ArrowRight, AlertTriangle, Ban, Play, Square
} from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import { getCurrencySymbol, getDistanceUnitShort, convertDistance } from '@/lib/regionSettings';
import { getTripDisplayId } from '@/lib/tripUtils';

interface Trip {
  id: string;
  trip_code: string;
  status: string;
  passenger_name: string;
  passenger_phone: string;
  pickup_address: string;
  dropoff_address: string;
  estimated_fare: number;
  fare: number;
  currency_code: string;
  created_at: string;
  started_at: string | null;
  driver_id: string | null;
  // Fare Engine source-of-truth fields
  pricing_mode: string | null;
  fare_locked: boolean | null;
  vehicle_type: string | null;
  vehicle_type_id: string | null;
  service_area_id: string | null;
  driver?: {
    id: string;
    first_name: string;
    last_name: string;
    phone: string;
  } | null;
  service_area?: {
    region?: {
      currency_code: string;
      distance_unit: string;
    } | null;
  } | null;
}

interface Driver {
  id: string;
  driver_code: string | null;
  first_name: string;
  last_name: string;
  phone: string;
  is_online: boolean;
  rating: number;
}

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: any }> = {
  pending: { label: 'Pending', color: 'bg-gray-100 text-gray-700 border-gray-200', icon: Clock },
  searching: { label: 'Searching', color: 'bg-blue-100 text-blue-700 border-blue-200', icon: Search },
  offered: { label: 'Offered', color: 'bg-cyan-100 text-cyan-700 border-cyan-200', icon: Users },
  driver_assigned: { label: 'Driver Assigned', color: 'bg-teal-100 text-teal-700 border-teal-200', icon: Car },
  accepted: { label: 'Accepted', color: 'bg-purple-100 text-purple-700 border-purple-200', icon: CheckCircle2 },
  arrived: { label: 'Arrived', color: 'bg-indigo-100 text-indigo-700 border-indigo-200', icon: MapPin },
  in_progress: { label: 'In Progress', color: 'bg-amber-100 text-amber-700 border-amber-200', icon: Car },
  started: { label: 'Started', color: 'bg-amber-100 text-amber-700 border-amber-200', icon: Play },
  on_trip: { label: 'On Trip', color: 'bg-orange-100 text-orange-700 border-orange-200', icon: Navigation },
  ongoing: { label: 'Ongoing', color: 'bg-orange-100 text-orange-700 border-orange-200', icon: Navigation },
  completed: { label: 'Completed', color: 'bg-green-100 text-green-700 border-green-200', icon: CheckCircle2 },
  cancelled: { label: 'Cancelled', color: 'bg-red-100 text-red-700 border-red-200', icon: XCircle },
};

export default function ActiveTrips() {
  const [trips, setTrips] = useState<Trip[]>([]);
  const [availableDrivers, setAvailableDrivers] = useState<Driver[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [lastRefresh, setLastRefresh] = useState(new Date());

  // Dialog states
  const [isReassignOpen, setIsReassignOpen] = useState(false);
  const [isCancelOpen, setIsCancelOpen] = useState(false);
  const [isForceEndOpen, setIsForceEndOpen] = useState(false);
  const [isViewOpen, setIsViewOpen] = useState(false);
  const [selectedTrip, setSelectedTrip] = useState<Trip | null>(null);
  const [selectedDriverId, setSelectedDriverId] = useState('');
  const [cancelReason, setCancelReason] = useState('');
  const [forceEndFare, setForceEndFare] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const fetchData = useCallback(async (isBackground = false) => {
    try {
      if (!isBackground) setIsLoading(true);
      
      const [tripsRes, driversRes] = await Promise.all([
        supabase
          .from('trips')
          .select(`
            *,
            driver:drivers!trips_driver_id_fkey(id, first_name, last_name, phone),
            service_area:service_areas!trips_service_area_id_fkey(region:regions(currency_code, distance_unit))
          `)
          .in('status', ['pending', 'searching', 'offered', 'driver_assigned', 'accepted', 'arrived', 'in_progress', 'started', 'on_trip', 'ongoing'])
          .order('created_at', { ascending: false }),
        supabase
          .from('drivers')
          .select('id, driver_code, first_name, last_name, phone, is_online, rating')
          .eq('is_online', true)
          .eq('approval_status', 'approved'),
      ]);

      if (tripsRes.error) throw tripsRes.error;
      if (driversRes.error) throw driversRes.error;

      setTrips(tripsRes.data || []);
      setAvailableDrivers(driversRes.data || []);
      setLastRefresh(new Date());
    } catch (err) {
      console.error('Error fetching trips:', err);
      if (!isBackground) toast.error('Failed to load active trips');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    
    // Subscribe to real-time updates — no polling needed
    const channel = supabase
      .channel('active-trips-changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'trips' },
        () => {
          fetchData(true); // background refresh, no spinner
        }
      )
      .subscribe();
    
    return () => {
      supabase.removeChannel(channel);
    };
  }, [fetchData]);

  const handleReassign = async () => {
    if (!selectedTrip || !selectedDriverId) {
      toast.error('Please select a driver');
      return;
    }

    setIsSaving(true);
    try {
      const { error } = await supabase
        .from('trips')
        .update({ 
          driver_id: selectedDriverId,
          status: 'accepted',
        })
        .eq('id', selectedTrip.id);

      if (error) throw error;

      toast.success('Trip reassigned successfully');
      setIsReassignOpen(false);
      setSelectedTrip(null);
      setSelectedDriverId('');
      fetchData();
    } catch (err: any) {
      console.error('Error reassigning trip:', err);
      toast.error(err.message || 'Failed to reassign trip');
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancel = async () => {
    if (!selectedTrip) return;

    setIsSaving(true);
    try {
      const { error } = await supabase
        .from('trips')
        .update({ 
          status: 'cancelled',
          special_instructions: cancelReason ? `Cancelled by admin: ${cancelReason}` : 'Cancelled by admin',
        })
        .eq('id', selectedTrip.id);

      if (error) throw error;

      toast.success('Trip cancelled successfully');
      setIsCancelOpen(false);
      setSelectedTrip(null);
      setCancelReason('');
      fetchData();
    } catch (err: any) {
      console.error('Error cancelling trip:', err);
      toast.error(err.message || 'Failed to cancel trip');
    } finally {
      setIsSaving(false);
    }
  };

  const handleForceEnd = async () => {
    if (!selectedTrip) return;

    const fareAmount = parseFloat(forceEndFare) || selectedTrip.estimated_fare || 0;

    setIsSaving(true);
    try {
      const { error } = await supabase
        .from('trips')
        .update({ 
          status: 'completed',
          fare: fareAmount,
          completed_at: new Date().toISOString(),
          special_instructions: `Force ended by admin. Final fare: ${fareAmount}`,
        })
        .eq('id', selectedTrip.id);

      if (error) throw error;

      toast.success('Trip force ended successfully');
      setIsForceEndOpen(false);
      setSelectedTrip(null);
      setForceEndFare('');
      fetchData();
    } catch (err: any) {
      console.error('Error force ending trip:', err);
      toast.error(err.message || 'Failed to force end trip');
    } finally {
      setIsSaving(false);
    }
  };

  const openReassignDialog = (trip: Trip) => {
    setSelectedTrip(trip);
    setSelectedDriverId('');
    setIsReassignOpen(true);
  };

  const openCancelDialog = (trip: Trip) => {
    setSelectedTrip(trip);
    setCancelReason('');
    setIsCancelOpen(true);
  };

  const openForceEndDialog = (trip: Trip) => {
    setSelectedTrip(trip);
    setForceEndFare(trip.estimated_fare?.toString() || '');
    setIsForceEndOpen(true);
  };

  const openViewDialog = (trip: Trip) => {
    setSelectedTrip(trip);
    setIsViewOpen(true);
  };

  /** Resolve currency: trip snapshot → region (single source of truth) */
  const resolveTripCurrency = (trip: Trip): string =>
    trip.currency_code || trip.service_area?.region?.currency_code || '';
  const filteredTrips = trips.filter(trip => {
    const matchesSearch = 
      getTripDisplayId(trip).toLowerCase().includes(searchQuery.toLowerCase()) ||
      trip.trip_code?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      trip.passenger_name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      trip.passenger_phone?.includes(searchQuery) ||
      trip.pickup_address?.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = statusFilter === 'all' || trip.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const pendingCount = trips.filter(t => t.status === 'pending' || t.status === 'searching' || t.status === 'offered').length;
  const acceptedCount = trips.filter(t => t.status === 'accepted' || t.status === 'arrived' || t.status === 'driver_assigned').length;
  const inProgressCount = trips.filter(t => ['in_progress', 'started', 'on_trip', 'ongoing'].includes(t.status)).length;

  return (
    <AdminLayout 
      title="Active Trips" 
      description="Manage and monitor active trips in real-time"
    >
      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Total Active</p>
                <p className="text-2xl font-bold">{trips.length}</p>
              </div>
              <Car className="h-8 w-8 text-primary opacity-80" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-blue-500/30 bg-blue-500/5">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Pending/Searching</p>
                <p className="text-2xl font-bold text-blue-600">{pendingCount}</p>
              </div>
              <Search className="h-8 w-8 text-blue-500" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-purple-500/30 bg-purple-500/5">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Accepted/Arrived</p>
                <p className="text-2xl font-bold text-purple-600">{acceptedCount}</p>
              </div>
              <CheckCircle2 className="h-8 w-8 text-purple-500" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-amber-500/30 bg-amber-500/5">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">In Progress</p>
                <p className="text-2xl font-bold text-amber-600">{inProgressCount}</p>
              </div>
              <Play className="h-8 w-8 text-amber-500" />
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Navigation className="h-5 w-5 text-primary" />
              Active Trips
            </CardTitle>
            <CardDescription>
              Last updated: {lastRefresh.toLocaleTimeString()}
            </CardDescription>
          </div>
          <div className="flex flex-col gap-2 md:flex-row md:items-center">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search trips..."
                className="pl-9 w-full md:w-[200px]"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-full md:w-[150px]">
                <SelectValue placeholder="All Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="searching">Searching</SelectItem>
                <SelectItem value="offered">Offered</SelectItem>
                <SelectItem value="driver_assigned">Driver Assigned</SelectItem>
                <SelectItem value="accepted">Accepted</SelectItem>
                <SelectItem value="arrived">Arrived</SelectItem>
                <SelectItem value="in_progress">In Progress</SelectItem>
                <SelectItem value="started">Started</SelectItem>
                <SelectItem value="on_trip">On Trip</SelectItem>
                <SelectItem value="ongoing">Ongoing</SelectItem>
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
              <Car className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-medium mb-2">No active trips</h3>
              <p className="text-muted-foreground">
                {searchQuery || statusFilter !== 'all' 
                  ? 'Try adjusting your filters' 
                  : 'All trips are completed or there are no active trips at the moment'}
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Trip</TableHead>
                  <TableHead>Passenger</TableHead>
                  <TableHead>Route</TableHead>
                  <TableHead>Driver</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Fare</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredTrips.map((trip) => {
                  const statusConfig = STATUS_CONFIG[trip.status] || STATUS_CONFIG.pending;
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
                        <div className="max-w-[200px]">
                          <div className="flex items-start gap-1 text-xs">
                            <MapPin className="h-3 w-3 text-green-500 mt-0.5 shrink-0" />
                            <span className="truncate">{trip.pickup_address?.slice(0, 30)}...</span>
                          </div>
                          <div className="flex items-start gap-1 text-xs mt-1">
                            <MapPin className="h-3 w-3 text-red-500 mt-0.5 shrink-0" />
                            <span className="truncate">{trip.dropoff_address?.slice(0, 30)}...</span>
                          </div>
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
                          </div>
                        ) : (
                          <Badge variant="outline" className="bg-gray-100 text-gray-600">
                            Unassigned
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={statusConfig.color}>
                          <StatusIcon className="h-3 w-3 mr-1" />
                          {statusConfig.label}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1 text-sm text-muted-foreground">
                          <Clock className="h-3 w-3" />
                          {formatDistanceToNow(new Date(trip.created_at), { addSuffix: false })}
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className="font-medium">
                          {getCurrencySymbol(resolveTripCurrency(trip))}
                          {(trip.fare || trip.estimated_fare || 0).toFixed(2)}
                        </span>
                      </TableCell>
                      <TableCell className="text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => openViewDialog(trip)}>
                              <MapPin className="mr-2 h-4 w-4" />
                              View Details
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onClick={() => openReassignDialog(trip)}>
                              <UserX className="mr-2 h-4 w-4" />
                              Reassign Driver
                            </DropdownMenuItem>
                            {trip.status === 'in_progress' && (
                              <DropdownMenuItem onClick={() => openForceEndDialog(trip)}>
                                <Square className="mr-2 h-4 w-4" />
                                Force End Trip
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuSeparator />
                            <DropdownMenuItem 
                              onClick={() => openCancelDialog(trip)}
                              className="text-red-600"
                            >
                              <Ban className="mr-2 h-4 w-4" />
                              Cancel Trip
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

      {/* Reassign Driver Dialog */}
      <Dialog open={isReassignOpen} onOpenChange={setIsReassignOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <UserX className="h-5 w-5" />
              Reassign Driver
            </DialogTitle>
            <DialogDescription>
              Select a new driver for trip {selectedTrip ? getTripDisplayId(selectedTrip) : ''}
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            {selectedTrip?.driver && (
              <div className="p-3 bg-muted/50 rounded-lg">
                <p className="text-sm text-muted-foreground">Current Driver</p>
                <p className="font-medium">
                  {selectedTrip.driver.first_name} {selectedTrip.driver.last_name}
                </p>
              </div>
            )}

            <div className="space-y-2">
              <Label>Select New Driver</Label>
              <Select value={selectedDriverId} onValueChange={setSelectedDriverId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a driver" />
                </SelectTrigger>
                <SelectContent>
                  {availableDrivers
                    .filter(d => d.id !== selectedTrip?.driver_id)
                    .map(driver => (
                      <SelectItem key={driver.id} value={driver.id}>
                        <span className="flex items-center gap-2">
                          {driver.first_name} {driver.last_name}
                          <span className="text-muted-foreground">
                            ({driver.phone}) ★{driver.rating?.toFixed(1) || '5.0'}
                          </span>
                        </span>
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              {availableDrivers.filter(d => d.id !== selectedTrip?.driver_id).length === 0 && (
                <p className="text-sm text-muted-foreground">No available drivers online</p>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsReassignOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleReassign} disabled={isSaving || !selectedDriverId}>
              {isSaving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Reassign
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cancel Trip Dialog */}
      <AlertDialog open={isCancelOpen} onOpenChange={setIsCancelOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-red-500" />
              Cancel Trip
            </AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to cancel trip {selectedTrip ? getTripDisplayId(selectedTrip) : ''}? 
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          
          <div className="py-4">
            <Label htmlFor="cancel_reason">Reason (optional)</Label>
            <Textarea
              id="cancel_reason"
              placeholder="Enter reason for cancellation..."
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              className="mt-2"
            />
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel>Keep Trip</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleCancel}
              className="bg-red-600 hover:bg-red-700"
              disabled={isSaving}
            >
              {isSaving ? 'Cancelling...' : 'Cancel Trip'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Force End Trip Dialog */}
      <Dialog open={isForceEndOpen} onOpenChange={setIsForceEndOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Square className="h-5 w-5" />
              Force End Trip
            </DialogTitle>
            <DialogDescription>
              Force end trip {selectedTrip ? getTripDisplayId(selectedTrip) : ''} and set the final fare
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg">
              <p className="text-sm text-amber-800">
                <AlertTriangle className="h-4 w-4 inline mr-1" />
                This will immediately end the trip and charge the passenger the specified fare.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="fare">Final Fare ({getCurrencySymbol(resolveTripCurrency(selectedTrip!))})</Label>
              <Input
                id="fare"
                type="number"
                step="0.01"
                placeholder="Enter final fare"
                value={forceEndFare}
                onChange={(e) => setForceEndFare(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Estimated fare: {getCurrencySymbol(resolveTripCurrency(selectedTrip!))}
                {selectedTrip?.estimated_fare?.toFixed(2) || '0.00'}
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsForceEndOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleForceEnd} disabled={isSaving}>
              {isSaving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Force End
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* View Trip Details Dialog */}
      <Dialog open={isViewOpen} onOpenChange={setIsViewOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Car className="h-5 w-5" />
              Trip Details
            </DialogTitle>
          </DialogHeader>
          
          {selectedTrip && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="font-mono text-lg font-medium">
                  {selectedTrip.trip_code || selectedTrip.id.slice(0, 8)}
                </span>
                <div className="flex items-center gap-2">
                  {selectedTrip.pricing_mode && (
                    <Badge 
                      variant="outline" 
                      className={selectedTrip.pricing_mode === 'fixed' 
                        ? 'bg-blue-100 text-blue-700 border-blue-300' 
                        : 'bg-amber-100 text-amber-700 border-amber-300'}
                    >
                      {selectedTrip.pricing_mode === 'fixed' ? '🔒 Fixed Fare' : '⚡ Dynamic Fare'}
                    </Badge>
                  )}
                  <Badge variant="outline" className={STATUS_CONFIG[selectedTrip.status]?.color}>
                    {STATUS_CONFIG[selectedTrip.status]?.label || selectedTrip.status}
                  </Badge>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="p-3 bg-muted/50 rounded-lg">
                  <p className="text-xs text-muted-foreground">Passenger</p>
                  <p className="font-medium">{selectedTrip.passenger_name || 'Unknown'}</p>
                  <p className="text-sm text-muted-foreground">{selectedTrip.passenger_phone}</p>
                </div>
                <div className="p-3 bg-muted/50 rounded-lg">
                  <p className="text-xs text-muted-foreground">Driver</p>
                  {selectedTrip.driver ? (
                    <>
                      <p className="font-medium">{selectedTrip.driver.first_name} {selectedTrip.driver.last_name}</p>
                      <p className="text-sm text-muted-foreground">{selectedTrip.driver.phone}</p>
                    </>
                  ) : (
                    <p className="text-muted-foreground">Unassigned</p>
                  )}
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-start gap-2 p-3 bg-green-50 rounded-lg border border-green-100">
                  <MapPin className="h-4 w-4 text-green-600 mt-0.5" />
                  <div>
                    <p className="text-xs text-green-600 font-medium">Pickup</p>
                    <p className="text-sm">{selectedTrip.pickup_address}</p>
                  </div>
                </div>
                <div className="flex justify-center">
                  <ArrowRight className="h-4 w-4 text-muted-foreground" />
                </div>
                <div className="flex items-start gap-2 p-3 bg-red-50 rounded-lg border border-red-100">
                  <MapPin className="h-4 w-4 text-red-600 mt-0.5" />
                  <div>
                    <p className="text-xs text-red-600 font-medium">Dropoff</p>
                    <p className="text-sm">{selectedTrip.dropoff_address}</p>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div className="p-3 bg-muted/50 rounded-lg text-center">
                  <p className="text-xs text-muted-foreground">Est. Fare</p>
                  <p className="font-medium">
                    {getCurrencySymbol(resolveTripCurrency(selectedTrip))}
                    {selectedTrip.estimated_fare?.toFixed(2) || '0.00'}
                  </p>
                </div>
                <div className="p-3 bg-muted/50 rounded-lg text-center">
                  <p className="text-xs text-muted-foreground">Final Fare</p>
                  <p className="font-medium">
                    {getCurrencySymbol(resolveTripCurrency(selectedTrip))}
                    {selectedTrip.fare?.toFixed(2) || '—'}
                  </p>
                </div>
                <div className="p-3 bg-muted/50 rounded-lg text-center">
                  <p className="text-xs text-muted-foreground">Created</p>
                  <p className="font-medium text-sm">
                    {format(new Date(selectedTrip.created_at), 'HH:mm')}
                  </p>
                </div>
              </div>
              {/* Fare Source Info */}
              <div className="grid grid-cols-3 gap-4">
                <div className="p-3 bg-muted/50 rounded-lg text-center">
                  <p className="text-xs text-muted-foreground">Fare Source</p>
                  <p className="font-medium text-xs">Fare Engine</p>
                </div>
                <div className="p-3 bg-muted/50 rounded-lg text-center">
                  <p className="text-xs text-muted-foreground">Fare Locked</p>
                  <p className="font-medium text-xs">{selectedTrip.fare_locked ? 'Yes' : 'No'}</p>
                </div>
                <div className="p-3 bg-muted/50 rounded-lg text-center">
                  <p className="text-xs text-muted-foreground">Vehicle Type</p>
                  <p className="font-medium text-xs">{selectedTrip.vehicle_type || 'N/A'}</p>
                </div>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsViewOpen(false)}>
              Close
            </Button>
            <Button variant="destructive" onClick={() => {
              setIsViewOpen(false);
              if (selectedTrip) openCancelDialog(selectedTrip);
            }}>
              Cancel Trip
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}
