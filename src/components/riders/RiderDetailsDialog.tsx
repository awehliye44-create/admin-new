import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { supabase } from '@/integrations/supabase/client';
import { 
  Phone, Calendar, CreditCard, Car, Clock, 
  Loader2, Ban, CheckCircle, History, Wallet
} from 'lucide-react';
import { toast } from 'sonner';
import { format, formatDistanceToNow } from 'date-fns';

interface Rider {
  id: string;
  user_id: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  created_at: string;
  updated_at: string;
  trip_count?: number;
  last_trip_at?: string | null;
  status?: 'active' | 'suspended';
  wallet_balance?: number;
  default_payment_method?: string | null;
}

interface RiderTrip {
  id: string;
  pickup_address: string;
  dropoff_address: string;
  status: string;
  fare: number | null;
  created_at: string;
  driver?: {
    first_name: string;
    last_name: string;
  } | null;
}

interface RiderDetailsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rider: Rider | null;
  onRiderUpdate?: (rider: Rider) => void;
}

export function RiderDetailsDialog({
  open,
  onOpenChange,
  rider,
  onRiderUpdate,
}: RiderDetailsDialogProps) {
  const [activeTab, setActiveTab] = useState('overview');
  const [isSuspendDialogOpen, setIsSuspendDialogOpen] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);

  // React Query for trip history — only fetches when history tab is active
  const { data: trips = [], isLoading } = useQuery({
    queryKey: ['rider-trips', rider?.user_id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('trips')
        .select(`
          id, pickup_address, dropoff_address, status, fare, created_at,
          driver:drivers!trips_driver_id_fkey(first_name, last_name)
        `)
        .eq('passenger_id', rider!.user_id)
        .order('created_at', { ascending: false })
        .limit(20);

      if (error) throw error;
      return (data || []) as unknown as RiderTrip[];
    },
    enabled: open && !!rider?.user_id && activeTab === 'history',
    staleTime: 60_000,
  });

  const getInitials = (firstName: string | null, lastName: string | null) => {
    const first = firstName?.charAt(0)?.toUpperCase() || '';
    const last = lastName?.charAt(0)?.toUpperCase() || '';
    return first + last || '?';
  };

  const getFullName = (r: Rider) => {
    if (r.first_name || r.last_name) {
      return `${r.first_name || ''} ${r.last_name || ''}`.trim();
    }
    return 'Unknown';
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed':
        return 'bg-green-500/10 text-green-600';
      case 'cancelled':
        return 'bg-red-500/10 text-red-600';
      case 'in_progress':
        return 'bg-blue-500/10 text-blue-600';
      default:
        return 'bg-gray-500/10 text-gray-600';
    }
  };

  const handleSuspendToggle = async () => {
    if (!rider) return;
    
    setIsUpdating(true);
    try {
      const newStatus = rider.status === 'suspended' ? 'active' : 'suspended';
      toast.success(`Rider ${newStatus === 'suspended' ? 'suspended' : 'reactivated'} successfully`);
      
      if (onRiderUpdate) {
        onRiderUpdate({ ...rider, status: newStatus });
      }
    } catch (err) {
      console.error('Error updating rider status:', err);
      toast.error('Failed to update rider status');
    } finally {
      setIsUpdating(false);
      setIsSuspendDialogOpen(false);
    }
  };

  if (!rider) return null;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Rider Details</DialogTitle>
            <DialogDescription>
              View rider information and booking history
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-6">
            {/* Profile Header */}
            <div className="flex items-start gap-4">
              <Avatar className="h-16 w-16 border-2 border-border">
                <AvatarFallback className="text-xl bg-primary/10 text-primary">
                  {getInitials(rider.first_name, rider.last_name)}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1">
                <h3 className="text-xl font-semibold">{getFullName(rider)}</h3>
                <p className="text-sm text-muted-foreground font-mono">
                  ID: {rider.id.slice(0, 8)}...
                </p>
                <div className="flex items-center gap-2 mt-2">
                  <Badge className={rider.status === 'suspended' 
                    ? 'bg-red-500/10 text-red-600 border-red-500/30' 
                    : 'bg-green-500/10 text-green-600 border-green-500/30'
                  }>
                    {rider.status === 'suspended' ? 'Suspended' : 'Active'}
                  </Badge>
                  <Badge variant="outline">
                    <Car className="h-3 w-3 mr-1" />
                    {rider.trip_count || 0} trips
                  </Badge>
                </div>
              </div>
            </div>

            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="history">Trip History</TabsTrigger>
                <TabsTrigger value="payments">Payments</TabsTrigger>
              </TabsList>

              <TabsContent value="overview" className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="flex items-center gap-3 p-3 bg-muted/50 rounded-lg">
                    <Phone className="h-5 w-5 text-muted-foreground" />
                    <div>
                      <p className="text-xs text-muted-foreground">Phone</p>
                      <p className="text-sm font-medium">{rider.phone || 'Not provided'}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 p-3 bg-muted/50 rounded-lg">
                    <Calendar className="h-5 w-5 text-muted-foreground" />
                    <div>
                      <p className="text-xs text-muted-foreground">Member Since</p>
                      <p className="text-sm font-medium">
                        {format(new Date(rider.created_at), 'MMMM yyyy')}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 p-3 bg-muted/50 rounded-lg">
                    <Car className="h-5 w-5 text-muted-foreground" />
                    <div>
                      <p className="text-xs text-muted-foreground">Total Trips</p>
                      <p className="text-sm font-medium">{rider.trip_count || 0}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 p-3 bg-muted/50 rounded-lg">
                    <Clock className="h-5 w-5 text-muted-foreground" />
                    <div>
                      <p className="text-xs text-muted-foreground">Last Trip</p>
                      <p className="text-sm font-medium">
                        {rider.last_trip_at 
                          ? formatDistanceToNow(new Date(rider.last_trip_at), { addSuffix: true })
                          : 'Never'
                        }
                      </p>
                    </div>
                  </div>
                </div>

                <div className="flex gap-2 pt-4 border-t">
                  {rider.status === 'suspended' ? (
                    <Button 
                      variant="outline"
                      className="text-green-600 hover:text-green-700"
                      onClick={() => setIsSuspendDialogOpen(true)}
                    >
                      <CheckCircle className="mr-2 h-4 w-4" />
                      Reactivate Account
                    </Button>
                  ) : (
                    <Button 
                      variant="destructive"
                      onClick={() => setIsSuspendDialogOpen(true)}
                    >
                      <Ban className="mr-2 h-4 w-4" />
                      Suspend Account
                    </Button>
                  )}
                </div>
              </TabsContent>

              <TabsContent value="history" className="space-y-4">
                {isLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                  </div>
                ) : trips.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <History className="h-12 w-12 mx-auto mb-3 opacity-30" />
                    <p>No trip history found</p>
                  </div>
                ) : (
                  <div className="space-y-3 max-h-[300px] overflow-y-auto">
                    {trips.map((trip) => (
                      <div 
                        key={trip.id} 
                        className="p-3 border rounded-lg space-y-2"
                      >
                        <div className="flex items-center justify-between">
                          <Badge className={getStatusColor(trip.status)}>
                            {trip.status}
                          </Badge>
                          <span className="text-sm text-muted-foreground">
                            {format(new Date(trip.created_at), 'MMM d, yyyy HH:mm')}
                          </span>
                        </div>
                        <div className="text-sm">
                          <p className="text-muted-foreground">From: <span className="text-foreground">{trip.pickup_address}</span></p>
                          <p className="text-muted-foreground">To: <span className="text-foreground">{trip.dropoff_address}</span></p>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-muted-foreground">
                            Driver: {trip.driver ? `${trip.driver.first_name} ${trip.driver.last_name}` : 'N/A'}
                          </span>
                          <span className="font-medium">
                            {trip.fare ? `£${trip.fare.toFixed(2)}` : '—'}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </TabsContent>

              <TabsContent value="payments" className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="flex items-center gap-3 p-4 bg-muted/50 rounded-lg">
                    <Wallet className="h-6 w-6 text-muted-foreground" />
                    <div>
                      <p className="text-xs text-muted-foreground">Wallet Balance</p>
                      <p className="text-lg font-semibold">
                        £{(rider.wallet_balance || 0).toFixed(2)}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 p-4 bg-muted/50 rounded-lg">
                    <CreditCard className="h-6 w-6 text-muted-foreground" />
                    <div>
                      <p className="text-xs text-muted-foreground">Payment Method</p>
                      <p className="text-lg font-semibold">
                        {rider.default_payment_method || 'Not set'}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="p-4 bg-muted/30 rounded-lg">
                  <h4 className="text-sm font-medium mb-2">Payment History</h4>
                  <p className="text-sm text-muted-foreground">
                    Payment history will be displayed here based on completed trips.
                  </p>
                </div>
              </TabsContent>
            </Tabs>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={isSuspendDialogOpen} onOpenChange={setIsSuspendDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {rider?.status === 'suspended' ? 'Reactivate Account' : 'Suspend Account'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {rider?.status === 'suspended' 
                ? 'Are you sure you want to reactivate this rider account? They will be able to book rides again.'
                : 'Are you sure you want to suspend this rider? They will not be able to book any rides until reactivated.'
              }
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isUpdating}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleSuspendToggle}
              disabled={isUpdating}
              className={rider?.status === 'suspended' 
                ? 'bg-green-600 hover:bg-green-700' 
                : 'bg-destructive hover:bg-destructive/90'
              }
            >
              {isUpdating ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : null}
              {rider?.status === 'suspended' ? 'Reactivate' : 'Suspend'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
