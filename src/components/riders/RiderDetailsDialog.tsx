import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { supabase } from '@/integrations/supabase/client';
import {
  Phone, Calendar, CreditCard, Car, Clock,
  Loader2, History, Wallet, Ban, ShieldOff, CheckCircle, Trash2,
} from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';

interface Rider {
  id: string;
  user_id: string;
  customer_code: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  created_at: string;
  updated_at: string;
  trip_count?: number;
  last_trip_at?: string | null;
  rider_status: 'active' | 'disabled' | 'suspended' | 'deleted';
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
  driver?: { first_name: string; last_name: string } | null;
}

interface RiderDetailsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rider: Rider | null;
  onRiderUpdate?: (rider: Rider) => void;
}

export function RiderDetailsDialog({ open, onOpenChange, rider, onRiderUpdate }: RiderDetailsDialogProps) {
  const [activeTab, setActiveTab] = useState('overview');
  const [isUpdating, setIsUpdating] = useState(false);

  const { data: trips = [], isLoading } = useQuery({
    queryKey: ['rider-trips', rider?.user_id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('trips')
        .select(`id, pickup_address, dropoff_address, status, fare, created_at, driver:drivers!trips_driver_id_fkey(first_name, last_name)`)
        .eq('passenger_id', rider!.user_id)
        .order('created_at', { ascending: false })
        .limit(20);
      if (error) throw error;
      return (data || []) as unknown as RiderTrip[];
    },
    enabled: open && !!rider?.user_id && activeTab === 'history',
    staleTime: 60_000,
  });

  if (!rider) return null;

  const getInitials = (firstName: string | null, lastName: string | null) => {
    const first = firstName?.charAt(0)?.toUpperCase() || '';
    const last = lastName?.charAt(0)?.toUpperCase() || '';
    return first + last || '?';
  };

  const getFullName = (r: Rider) => {
    if (r.first_name || r.last_name) return `${r.first_name || ''} ${r.last_name || ''}`.trim();
    return 'Unknown';
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed': return 'bg-green-500/10 text-green-600';
      case 'cancelled': return 'bg-red-500/10 text-red-600';
      case 'in_progress': return 'bg-blue-500/10 text-blue-600';
      default: return 'bg-muted text-muted-foreground';
    }
  };

  const getRiderStatusBadge = () => {
    switch (rider.rider_status) {
      case 'active': return <Badge className="bg-green-500/10 text-green-600 border-green-500/30">Active</Badge>;
      case 'disabled': return <Badge className="bg-red-500/10 text-red-600 border-red-500/30">Disabled</Badge>;
      case 'suspended': return <Badge className="bg-amber-500/10 text-amber-600 border-amber-500/30">Suspended</Badge>;
      case 'deleted': return <Badge className="bg-muted text-muted-foreground border-muted">Deleted</Badge>;
      default: return <Badge variant="outline">{rider.rider_status}</Badge>;
    }
  };

  const handleStatusChange = async (newStatus: 'active' | 'disabled' | 'suspended' | 'deleted') => {
    setIsUpdating(true);
    try {
      const { error } = await supabase
        .from('customers')
        .update({ rider_status: newStatus, updated_at: new Date().toISOString() } as any)
        .eq('id', rider.id);

      if (error) {
        if (error.message?.includes('active trip')) {
          toast.error('Cannot change status: rider has an active trip');
        } else {
          throw error;
        }
        return;
      }

      const actionLabel = newStatus === 'active' ? 'enabled' : newStatus;
      toast.success(`Rider ${actionLabel} successfully`);

      if (onRiderUpdate) {
        onRiderUpdate({ ...rider, rider_status: newStatus });
      }
    } catch (err) {
      console.error('Error updating rider status:', err);
      toast.error('Failed to update rider status');
    } finally {
      setIsUpdating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Rider Details</DialogTitle>
          <DialogDescription>View rider information and booking history</DialogDescription>
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
              <p className="text-sm font-mono text-primary font-medium">{rider.customer_code}</p>
              <div className="flex items-center gap-2 mt-2">
                {getRiderStatusBadge()}
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
                    <p className="text-sm font-medium">{format(new Date(rider.created_at), 'MMMM yyyy')}</p>
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
                        : 'Never'}
                    </p>
                  </div>
                </div>
              </div>

              {/* Lifecycle Actions */}
              <div className="flex flex-wrap gap-2 pt-4 border-t">
                {rider.rider_status === 'active' && (
                  <>
                    <Button variant="outline" className="text-amber-600 hover:text-amber-700" onClick={() => handleStatusChange('suspended')} disabled={isUpdating}>
                      <ShieldOff className="mr-2 h-4 w-4" />
                      Suspend
                    </Button>
                    <Button variant="destructive" onClick={() => handleStatusChange('disabled')} disabled={isUpdating}>
                      <Ban className="mr-2 h-4 w-4" />
                      Disable
                    </Button>
                    <Button variant="destructive" onClick={() => handleStatusChange('deleted')} disabled={isUpdating}>
                      <Trash2 className="mr-2 h-4 w-4" />
                      Delete
                    </Button>
                  </>
                )}
                {rider.rider_status === 'disabled' && (
                  <Button variant="outline" className="text-green-600 hover:text-green-700" onClick={() => handleStatusChange('active')} disabled={isUpdating}>
                    <CheckCircle className="mr-2 h-4 w-4" />
                    Enable
                  </Button>
                )}
                {rider.rider_status === 'suspended' && (
                  <Button variant="outline" className="text-green-600 hover:text-green-700" onClick={() => handleStatusChange('active')} disabled={isUpdating}>
                    <CheckCircle className="mr-2 h-4 w-4" />
                    Unsuspend
                  </Button>
                )}
                {isUpdating && <Loader2 className="h-5 w-5 animate-spin text-muted-foreground self-center" />}
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
                    <div key={trip.id} className="p-3 border rounded-lg space-y-2">
                      <div className="flex items-center justify-between">
                        <Badge className={getStatusColor(trip.status)}>{trip.status}</Badge>
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
                    <p className="text-lg font-semibold">£{(rider.wallet_balance || 0).toFixed(2)}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3 p-4 bg-muted/50 rounded-lg">
                  <CreditCard className="h-6 w-6 text-muted-foreground" />
                  <div>
                    <p className="text-xs text-muted-foreground">Payment Method</p>
                    <p className="text-lg font-semibold">{rider.default_payment_method || 'Not set'}</p>
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
  );
}
