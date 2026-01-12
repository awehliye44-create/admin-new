import { useEffect, useState, useCallback } from 'react';
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
import { 
  XCircle, Loader2, Search, RefreshCw, Clock, MapPin, Phone,
  Eye, AlertTriangle, Ban, UserX, DollarSign, TrendingDown,
  Calendar
} from 'lucide-react';
import { format, subDays, startOfDay, endOfDay } from 'date-fns';
import { toast } from 'sonner';

interface CancelledTrip {
  id: string;
  trip_code: string | null;
  status: string | null;
  passenger_name: string | null;
  passenger_phone: string | null;
  pickup_address: string;
  dropoff_address: string;
  estimated_fare: number | null;
  fare: number | null;
  currency_code: string | null;
  created_at: string;
  completed_at: string | null;
  special_instructions: string | null;
  driver_id: string | null;
  driver?: {
    id: string;
    first_name: string;
    last_name: string;
    phone: string;
  } | null;
}

export default function MissedCancelled() {
  const [trips, setTrips] = useState<CancelledTrip[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [dateFilter, setDateFilter] = useState('7days');

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

  const fetchData = useCallback(async () => {
    try {
      setIsLoading(true);
      const { start, end } = getDateRange();
      
      const { data, error } = await supabase
        .from('trips')
        .select(`
          *,
          driver:drivers(id, first_name, last_name, phone)
        `)
        .in('status', ['cancelled', 'no_show', 'missed', 'expired'])
        .gte('created_at', start.toISOString())
        .lte('created_at', end.toISOString())
        .order('created_at', { ascending: false });

      if (error) throw error;

      setTrips(data || []);
    } catch (err) {
      console.error('Error fetching cancelled trips:', err);
      toast.error('Failed to load cancelled trips');
    } finally {
      setIsLoading(false);
    }
  }, [getDateRange]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const getCurrencySymbol = (code: string | null) => {
    const symbols: Record<string, string> = {
      GBP: '£', USD: '$', EUR: '€', INR: '₹', AED: 'د.إ'
    };
    return symbols[code || 'GBP'] || code || '£';
  };

  const getStatusConfig = (status: string | null) => {
    switch (status) {
      case 'cancelled':
        return { label: 'Cancelled', color: 'bg-red-100 text-red-700', icon: XCircle };
      case 'no_show':
        return { label: 'No Show', color: 'bg-orange-100 text-orange-700', icon: UserX };
      case 'missed':
        return { label: 'Missed', color: 'bg-yellow-100 text-yellow-700', icon: AlertTriangle };
      case 'expired':
        return { label: 'Expired', color: 'bg-gray-100 text-gray-700', icon: Clock };
      default:
        return { label: status || 'Unknown', color: 'bg-gray-100 text-gray-700', icon: Ban };
    }
  };

  const getCancellationReason = (trip: CancelledTrip) => {
    if (trip.special_instructions) {
      if (trip.special_instructions.includes('Admin cancelled')) {
        return 'Cancelled by Admin';
      }
      if (trip.special_instructions.includes('Cancelled by admin')) {
        return 'Cancelled by Admin';
      }
      if (trip.special_instructions.includes('Driver cancelled')) {
        return 'Cancelled by Driver';
      }
      if (trip.special_instructions.includes('Passenger cancelled')) {
        return 'Cancelled by Passenger';
      }
      if (trip.special_instructions.includes('No drivers available')) {
        return 'No Drivers Available';
      }
      return 'Customer Cancelled';
    }
    return 'Unknown Reason';
  };

  const filteredTrips = trips.filter(trip => {
    const matchesSearch = 
      trip.trip_code?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      trip.passenger_name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      trip.passenger_phone?.includes(searchQuery) ||
      trip.pickup_address?.toLowerCase().includes(searchQuery.toLowerCase());
    
    if (statusFilter === 'all') return matchesSearch;
    return matchesSearch && trip.status === statusFilter;
  });

  const cancelledCount = trips.filter(t => t.status === 'cancelled').length;
  const noShowCount = trips.filter(t => t.status === 'no_show').length;
  const missedCount = trips.filter(t => t.status === 'missed' || t.status === 'expired').length;
  const lostRevenue = trips.reduce((sum, t) => sum + (t.estimated_fare || 0), 0);

  return (
    <AdminLayout 
      title="Missed & Cancelled" 
      description="Review cancelled, missed, and no-show trips"
    >
      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Total Issues</p>
                <p className="text-2xl font-bold">{trips.length}</p>
              </div>
              <AlertTriangle className="h-8 w-8 text-muted-foreground opacity-80" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-red-500/30 bg-red-500/5">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Cancelled</p>
                <p className="text-2xl font-bold text-red-600">{cancelledCount}</p>
              </div>
              <XCircle className="h-8 w-8 text-red-500" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-orange-500/30 bg-orange-500/5">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">No Shows</p>
                <p className="text-2xl font-bold text-orange-600">{noShowCount}</p>
              </div>
              <UserX className="h-8 w-8 text-orange-500" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-amber-500/30 bg-amber-500/5">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Lost Revenue</p>
                <p className="text-2xl font-bold text-amber-600">
                  £{lostRevenue.toFixed(2)}
                </p>
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
                <SelectItem value="no_show">No Show</SelectItem>
                <SelectItem value="missed">Missed</SelectItem>
                <SelectItem value="expired">Expired</SelectItem>
              </SelectContent>
            </Select>
            <Select value={dateFilter} onValueChange={setDateFilter}>
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
            <Button variant="outline" onClick={fetchData} disabled={isLoading}>
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
              <XCircle className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-medium mb-2">No cancelled or missed trips</h3>
              <p className="text-muted-foreground">
                {searchQuery || statusFilter !== 'all' 
                  ? 'Try adjusting your filters' 
                  : 'Great! No issues in the selected time period'}
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
                  <TableHead>Reason</TableHead>
                  <TableHead>Lost Fare</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredTrips.map((trip) => {
                  const statusConfig = getStatusConfig(trip.status);
                  const StatusIcon = statusConfig.icon;
                  return (
                    <TableRow key={trip.id}>
                      <TableCell>
                        <div className="font-mono text-sm font-medium">
                          {trip.trip_code || trip.id.slice(0, 8)}
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
                        {trip.driver ? (
                          <div className="text-sm">
                            {trip.driver.first_name} {trip.driver.last_name}
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
                      <TableCell className="font-medium text-red-600">
                        {getCurrencySymbol(trip.currency_code)}
                        {(trip.estimated_fare || 0).toFixed(2)}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {format(new Date(trip.created_at), 'MMM d, HH:mm')}
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
          )}
        </CardContent>
      </Card>

      {/* View Details Dialog */}
      <Dialog open={isViewOpen} onOpenChange={setIsViewOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Trip Details</DialogTitle>
            <DialogDescription>
              Trip #{selectedTrip?.trip_code || selectedTrip?.id.slice(0, 8)}
            </DialogDescription>
          </DialogHeader>
          {selectedTrip && (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                {(() => {
                  const config = getStatusConfig(selectedTrip.status);
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
                    {format(new Date(selectedTrip.created_at), 'PPP p')}
                  </p>
                </div>
                <div>
                  <Label className="text-muted-foreground">Lost Fare</Label>
                  <p className="font-medium text-red-600">
                    {getCurrencySymbol(selectedTrip.currency_code)}
                    {(selectedTrip.estimated_fare || 0).toFixed(2)}
                  </p>
                </div>
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

              {selectedTrip.driver && (
                <div>
                  <Label className="text-muted-foreground">Assigned Driver</Label>
                  <p className="font-medium">
                    {selectedTrip.driver.first_name} {selectedTrip.driver.last_name}
                  </p>
                  <p className="text-sm text-muted-foreground">{selectedTrip.driver.phone}</p>
                </div>
              )}

              {selectedTrip.special_instructions && (
                <div>
                  <Label className="text-muted-foreground">Notes / Reason</Label>
                  <p className="text-sm bg-muted p-2 rounded">
                    {selectedTrip.special_instructions}
                  </p>
                </div>
              )}
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
