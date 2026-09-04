import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { supabase } from '@/integrations/supabase/client';
import {
  Phone, Calendar, CreditCard, Car, Clock,
  Loader2, History, Wallet, Ban, ShieldOff, CheckCircle, Trash2, ShieldCheck, Unlock,
} from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';

const IDENTITY_BUCKET = 'customer-identity-documents';

type PendingIdentityRow = {
  id: string;
  status: string;
  document_type: string | null;
  id_front_path: string | null;
  id_back_path: string | null;
  selfie_path: string | null;
  submitted_at: string | null;
  created_at: string;
};

function documentTypeLabel(type: string | null): string {
  switch (type) {
    case 'driving_licence':
      return 'Driving licence';
    case 'passport':
      return 'Passport';
    case 'residence_permit':
      return 'Residence permit';
    default:
      return type || 'Unknown ID';
  }
}

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
  rider_status: 'active' | 'disabled' | 'suspended' | 'deleted' | 'pending_verification';
  wallet_balance?: number;
  default_payment_method?: string | null;
  identity_verified_at?: string | null;
  identity_provider?: string | null;
  name_edit_locked?: boolean | null;
  name_unlocked_at?: string | null;
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
  const [decideFirstName, setDecideFirstName] = useState('');
  const [decideLastName, setDecideLastName] = useState('');
  const [decideNote, setDecideNote] = useState('');
  const [signedUrls, setSignedUrls] = useState<{
    front: string | null;
    back: string | null;
    selfie: string | null;
  }>({ front: null, back: null, selfie: null });

  const { data: trips = [], isLoading } = useQuery({
    queryKey: ['rider-trips', rider?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('trips')
        .select(`id, pickup_address, dropoff_address, status, fare, created_at, driver:drivers!trips_driver_id_fkey(first_name, last_name)`)
        .eq('passenger_id', rider!.id)
        .order('created_at', { ascending: false })
        .limit(20);
      if (error) throw error;
      return (data || []) as unknown as RiderTrip[];
    },
    enabled: open && !!rider?.id && activeTab === 'history',
    staleTime: 60_000,
  });

  const {
    data: pendingIdentity,
    isLoading: identityLoading,
    refetch: refetchIdentity,
  } = useQuery({
    queryKey: ['rider-identity-pending', rider?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('customer_identity_verifications' as never)
        .select(
          'id, status, document_type, id_front_path, id_back_path, selfie_path, submitted_at, created_at',
        )
        .eq('customer_id', rider!.id)
        .in('status', ['submitted', 'processing'] as never)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data as PendingIdentityRow | null) ?? null;
    },
    enabled: open && !!rider?.id,
    staleTime: 15_000,
  });

  useEffect(() => {
    if (!rider) return;
    setDecideFirstName(rider.first_name ?? '');
    setDecideLastName(rider.last_name ?? '');
    setDecideNote('');
  }, [rider]);

  useEffect(() => {
    let cancelled = false;
    const loadSigned = async () => {
      if (!pendingIdentity) {
        setSignedUrls({ front: null, back: null, selfie: null });
        return;
      }
      const sign = async (path: string | null) => {
        if (!path) return null;
        const { data, error } = await supabase.storage
          .from(IDENTITY_BUCKET)
          .createSignedUrl(path, 3600);
        if (error || !data?.signedUrl) return null;
        return data.signedUrl;
      };
      const [front, back, selfie] = await Promise.all([
        sign(pendingIdentity.id_front_path),
        sign(pendingIdentity.id_back_path),
        sign(pendingIdentity.selfie_path),
      ]);
      if (!cancelled) setSignedUrls({ front, back, selfie });
    };
    void loadSigned();
    return () => {
      cancelled = true;
    };
  }, [pendingIdentity]);

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
      case 'pending_verification': return <Badge className="bg-blue-500/10 text-blue-600 border-blue-500/30">Pending Verification</Badge>;
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

  const handleUnlockName = async () => {
    setIsUpdating(true);
    try {
      const { data, error } = await supabase.rpc(
        'admin_unlock_customer_name_edit' as never,
        { p_customer_id: rider.id } as never,
      );
      if (error) throw error;
      const result = data as { ok?: boolean } | null;
      if (!result?.ok) {
        toast.error('Could not unlock name edits');
        return;
      }
      toast.success('Name edits unlocked for this rider');
      if (onRiderUpdate) {
        onRiderUpdate({
          ...rider,
          name_edit_locked: false,
          name_unlocked_at: new Date().toISOString(),
        });
      }
    } catch (err) {
      console.error('Error unlocking rider name:', err);
      toast.error('Failed to unlock name edits');
    } finally {
      setIsUpdating(false);
    }
  };

  const handleDecideIdentity = async (
    decision: 'approved' | 'declined' | 'resubmission_requested',
  ) => {
    if (!pendingIdentity) return;
    setIsUpdating(true);
    try {
      const { data, error } = await supabase.rpc(
        'admin_decide_customer_identity' as never,
        {
          p_verification_id: pendingIdentity.id,
          p_decision: decision,
          p_first_name: decideFirstName.trim() || null,
          p_last_name: decideLastName.trim() || null,
          p_note: decideNote.trim() || null,
        } as never,
      );
      if (error) throw error;
      const result = data as { ok?: boolean; code?: string } | null;
      if (!result?.ok) {
        toast.error(result?.code || 'Could not save identity decision');
        return;
      }
      if (decision === 'approved') {
        toast.success('Identity approved — name locked');
        if (onRiderUpdate) {
          onRiderUpdate({
            ...rider,
            first_name: decideFirstName.trim() || rider.first_name,
            last_name: decideLastName.trim() || rider.last_name,
            identity_verified_at: new Date().toISOString(),
            identity_provider: 'manual',
            name_edit_locked: true,
          });
        }
      } else if (decision === 'declined') {
        toast.success('Identity declined');
      } else {
        toast.success('Asked rider to resubmit');
      }
      setDecideNote('');
      await refetchIdentity();
    } catch (err) {
      console.error('Error deciding identity:', err);
      toast.error('Failed to save identity decision');
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
              <div className="flex items-center gap-2 mt-2 flex-wrap">
                {getRiderStatusBadge()}
                {rider.identity_verified_at ? (
                  <Badge className="bg-emerald-500/10 text-emerald-700 border-emerald-500/30">
                    <ShieldCheck className="h-3 w-3 mr-1" />
                    ID verified
                  </Badge>
                ) : null}
                {rider.name_edit_locked ? (
                  <Badge className="bg-amber-500/10 text-amber-700 border-amber-500/30">
                    Name locked
                  </Badge>
                ) : null}
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
              {identityLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground p-3 border rounded-lg">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading identity review…
                </div>
              ) : pendingIdentity ? (
                <div className="space-y-3 p-4 border rounded-lg bg-amber-500/5 border-amber-500/30">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div>
                      <p className="text-sm font-semibold flex items-center gap-2">
                        <ShieldCheck className="h-4 w-4" />
                        Identity pending review
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        {documentTypeLabel(pendingIdentity.document_type)}
                        {pendingIdentity.submitted_at
                          ? ` · submitted ${formatDistanceToNow(new Date(pendingIdentity.submitted_at), { addSuffix: true })}`
                          : null}
                      </p>
                    </div>
                    <Badge className="bg-amber-500/10 text-amber-700 border-amber-500/30">
                      {pendingIdentity.status}
                    </Badge>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    {[
                      { label: 'ID front', url: signedUrls.front },
                      { label: 'ID back', url: signedUrls.back },
                      { label: 'Selfie', url: signedUrls.selfie },
                    ].map((item) =>
                      item.url ? (
                        <a
                          key={item.label}
                          href={item.url}
                          target="_blank"
                          rel="noreferrer"
                          className="block rounded-md overflow-hidden border bg-background"
                        >
                          <img
                            src={item.url}
                            alt={item.label}
                            className="w-full h-36 object-cover"
                          />
                          <p className="text-xs text-center py-1 text-muted-foreground">
                            {item.label}
                          </p>
                        </a>
                      ) : item.label === 'ID back' && !pendingIdentity.id_back_path ? null : (
                        <div
                          key={item.label}
                          className="h-36 rounded-md border flex items-center justify-center text-xs text-muted-foreground"
                        >
                          {item.label} unavailable
                        </div>
                      ),
                    )}
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label htmlFor="identity-first-name">First name (on approve)</Label>
                      <Input
                        id="identity-first-name"
                        value={decideFirstName}
                        onChange={(e) => setDecideFirstName(e.target.value)}
                        disabled={isUpdating}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="identity-last-name">Last name (on approve)</Label>
                      <Input
                        id="identity-last-name"
                        value={decideLastName}
                        onChange={(e) => setDecideLastName(e.target.value)}
                        disabled={isUpdating}
                      />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="identity-note">Note (optional)</Label>
                    <Input
                      id="identity-note"
                      value={decideNote}
                      onChange={(e) => setDecideNote(e.target.value)}
                      placeholder="Shown internally on decline / resubmit"
                      disabled={isUpdating}
                    />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      onClick={() => void handleDecideIdentity('approved')}
                      disabled={isUpdating}
                      className="bg-emerald-600 hover:bg-emerald-700"
                    >
                      <CheckCircle className="mr-2 h-4 w-4" />
                      Approve
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => void handleDecideIdentity('resubmission_requested')}
                      disabled={isUpdating}
                    >
                      Ask to resubmit
                    </Button>
                    <Button
                      variant="destructive"
                      onClick={() => void handleDecideIdentity('declined')}
                      disabled={isUpdating}
                    >
                      Decline
                    </Button>
                  </div>
                </div>
              ) : null}

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
                {rider.name_edit_locked ? (
                  <Button
                    variant="outline"
                    className="text-emerald-700 hover:text-emerald-800"
                    onClick={() => void handleUnlockName()}
                    disabled={isUpdating}
                  >
                    <Unlock className="mr-2 h-4 w-4" />
                    Unlock name edits
                  </Button>
                ) : null}
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
