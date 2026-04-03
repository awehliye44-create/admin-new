import { useState } from 'react';
import { usePageLoadTelemetry } from '@/hooks/useAdminTelemetry';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { supabase } from '@/integrations/supabase/client';
import {
  Users, Loader2, Search, MoreVertical, Eye,
  Phone, Car, RefreshCw, UserCheck, UserX, Clock, Calendar,
  Ban, ShieldOff, Trash2, CheckCircle,
} from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import { RiderDetailsDialog } from '@/components/riders/RiderDetailsDialog';

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

type StatusFilter = 'all' | 'active' | 'disabled' | 'suspended' | 'deleted';
type ActionType = 'disable' | 'suspend' | 'enable' | 'delete';

export default function Riders() {
  usePageLoadTelemetry('RidersPage');
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [selectedRider, setSelectedRider] = useState<Rider | null>(null);
  const [isViewDialogOpen, setIsViewDialogOpen] = useState(false);
  const [actionDialogOpen, setActionDialogOpen] = useState(false);
  const [actionTarget, setActionTarget] = useState<Rider | null>(null);
  const [actionType, setActionType] = useState<ActionType>('disable');
  const [actionReason, setActionReason] = useState('');
  const [isActing, setIsActing] = useState(false);

  const { data: riders = [], isLoading } = useQuery({
    queryKey: ['riders'],
    queryFn: async () => {
      const { data: ridersData, error: ridersError } = await supabase
        .from('customers')
        .select('id, user_id, customer_code, first_name, last_name, phone, created_at, updated_at, rider_status')
        .order('created_at', { ascending: false });

      if (ridersError) throw ridersError;

      const ridersWithStats = await Promise.all(
        (ridersData || []).map(async (rider) => {
          const { count, data: trips } = await supabase
            .from('trips')
            .select('id, created_at', { count: 'exact' })
            .eq('passenger_id', rider.user_id)
            .order('created_at', { ascending: false })
            .limit(1);

          return {
            ...rider,
            trip_count: count || 0,
            last_trip_at: trips?.[0]?.created_at || null,
            rider_status: (rider as any).rider_status || 'active',
          };
        })
      );

      return ridersWithStats as Rider[];
    },
    staleTime: 30_000,
  });

  const refreshData = () => queryClient.invalidateQueries({ queryKey: ['riders'] });

  const handleViewRider = (rider: Rider) => {
    setSelectedRider(rider);
    setIsViewDialogOpen(true);
  };

  const openActionDialog = (rider: Rider, type: ActionType) => {
    setActionTarget(rider);
    setActionType(type);
    setActionReason('');
    setActionDialogOpen(true);
  };

  const handleActionConfirm = async () => {
    if (!actionTarget) return;
    setIsActing(true);

    try {
      const statusMap: Record<ActionType, string> = {
        disable: 'disabled',
        suspend: 'suspended',
        enable: 'active',
        delete: 'deleted',
      };
      const newStatus = statusMap[actionType];

      const { error } = await supabase
        .from('customers')
        .update({ rider_status: newStatus, updated_at: new Date().toISOString() } as any)
        .eq('id', actionTarget.id);

      if (error) {
        if (error.message?.includes('active trip')) {
          toast.error('Cannot change status: rider has an active trip');
        } else {
          throw error;
        }
        return;
      }

      // Audit log
      await supabase.from('audit_logs').insert({
        event_type: `rider_${actionType}`,
        user_id: actionTarget.user_id,
        details: { rider_id: actionTarget.id, reason: actionReason || null, new_status: newStatus },
      } as any);

      const labels: Record<ActionType, string> = {
        disable: 'disabled', suspend: 'suspended', enable: 'enabled', delete: 'deleted (soft)',
      };
      toast.success(`Rider ${labels[actionType]} successfully`);
      refreshData();
    } catch (err) {
      console.error('Error updating rider status:', err);
      toast.error('Failed to update rider status');
    } finally {
      setIsActing(false);
      setActionDialogOpen(false);
      setActionTarget(null);
    }
  };

  const handleRiderUpdate = (updatedRider: Rider) => {
    setSelectedRider(updatedRider);
    refreshData();
  };

  const getInitials = (firstName: string | null, lastName: string | null) => {
    const first = firstName?.charAt(0)?.toUpperCase() || '';
    const last = lastName?.charAt(0)?.toUpperCase() || '';
    return first + last || '?';
  };

  const getFullName = (rider: Rider) => {
    if (rider.first_name || rider.last_name) {
      return `${rider.first_name || ''} ${rider.last_name || ''}`.trim();
    }
    return 'Unknown';
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'active':
        return <Badge className="bg-green-500/10 text-green-600 border-green-500/30">Active</Badge>;
      case 'disabled':
        return <Badge className="bg-red-500/10 text-red-600 border-red-500/30">Disabled</Badge>;
      case 'suspended':
        return <Badge className="bg-amber-500/10 text-amber-600 border-amber-500/30">Suspended</Badge>;
      case 'deleted':
        return <Badge className="bg-muted text-muted-foreground border-muted">Deleted</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const filteredRiders = riders.filter(rider => {
    const fullName = getFullName(rider).toLowerCase();
    const phone = rider.phone?.toLowerCase() || '';
    const code = rider.customer_code?.toLowerCase() || '';
    const query = searchQuery.toLowerCase();
    const matchesSearch = fullName.includes(query) || phone.includes(query) || code.includes(query);
    const matchesStatus = statusFilter === 'all' || rider.rider_status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const counts = {
    all: riders.length,
    active: riders.filter(r => r.rider_status === 'active').length,
    disabled: riders.filter(r => r.rider_status === 'disabled').length,
    suspended: riders.filter(r => r.rider_status === 'suspended').length,
    deleted: riders.filter(r => r.rider_status === 'deleted').length,
  };

  const totalRiders = counts.active;
  const activeRiders = riders.filter(r => r.rider_status === 'active' && (r.trip_count ?? 0) > 0).length;
  const newThisMonth = riders.filter(r => {
    const created = new Date(r.created_at);
    const now = new Date();
    return created.getMonth() === now.getMonth() && created.getFullYear() === now.getFullYear();
  }).length;

  const actionLabels: Record<ActionType, { title: string; description: string; buttonLabel: string; buttonClass: string }> = {
    disable: {
      title: 'Disable Rider',
      description: `Are you sure you want to disable ${actionTarget ? getFullName(actionTarget) : ''}? They will be blocked from using the app.`,
      buttonLabel: 'Disable',
      buttonClass: 'bg-destructive hover:bg-destructive/90',
    },
    suspend: {
      title: 'Suspend Rider',
      description: `Are you sure you want to suspend ${actionTarget ? getFullName(actionTarget) : ''}? They can still log in but cannot book rides.`,
      buttonLabel: 'Suspend',
      buttonClass: 'bg-amber-600 hover:bg-amber-700 text-white',
    },
    enable: {
      title: 'Enable Rider',
      description: `Are you sure you want to re-enable ${actionTarget ? getFullName(actionTarget) : ''}? They will regain full access.`,
      buttonLabel: 'Enable',
      buttonClass: 'bg-green-600 hover:bg-green-700 text-white',
    },
    delete: {
      title: 'Delete Rider (Soft)',
      description: `Are you sure you want to soft-delete ${actionTarget ? getFullName(actionTarget) : ''}? They will be permanently blocked. This cannot be undone easily.`,
      buttonLabel: 'Delete',
      buttonClass: 'bg-destructive hover:bg-destructive/90',
    },
  };

  const currentAction = actionLabels[actionType];

  return (
    <AdminLayout title="Riders" description="Manage registered riders (customers) from your apps">
      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Active Riders</p>
                <p className="text-2xl font-bold">{counts.active}</p>
              </div>
              <Users className="h-8 w-8 text-primary opacity-80" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-green-500/30 bg-green-500/5">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">With Trips</p>
                <p className="text-2xl font-bold text-green-600">{activeRiders}</p>
              </div>
              <UserCheck className="h-8 w-8 text-green-500" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-blue-500/30 bg-blue-500/5">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">New This Month</p>
                <p className="text-2xl font-bold text-blue-600">{newThisMonth}</p>
              </div>
              <Calendar className="h-8 w-8 text-blue-500" />
            </div>
          </CardContent>
        </Card>
        <Card className={counts.suspended + counts.disabled > 0 ? "border-amber-500/30 bg-amber-500/5" : "border-muted"}>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Restricted</p>
                <p className="text-2xl font-bold text-amber-600">{counts.suspended + counts.disabled}</p>
              </div>
              <UserX className="h-8 w-8 text-amber-400" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Status Tabs */}
      <Tabs value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)} className="mb-4">
        <TabsList>
          <TabsTrigger value="all">All ({counts.all})</TabsTrigger>
          <TabsTrigger value="active">Active ({counts.active})</TabsTrigger>
          <TabsTrigger value="disabled">Disabled ({counts.disabled})</TabsTrigger>
          <TabsTrigger value="suspended">Suspended ({counts.suspended})</TabsTrigger>
          <TabsTrigger value="deleted">Deleted ({counts.deleted})</TabsTrigger>
        </TabsList>
      </Tabs>

      {/* Main Table */}
      <Card>
        <CardHeader className="pb-4">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Users className="h-5 w-5 text-primary" />
                Riders
              </CardTitle>
              <CardDescription>{filteredRiders.length} riders</CardDescription>
            </div>
            <div className="flex items-center gap-3">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search by name, phone, or CU ID..."
                  className="pl-9 w-[250px]"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
              <Button variant="outline" size="icon" onClick={refreshData}>
                <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          ) : filteredRiders.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              {searchQuery ? 'No riders match your search' : 'No riders found'}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Rider</TableHead>
                  <TableHead>Customer ID</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Trips</TableHead>
                  <TableHead>Last Trip</TableHead>
                  <TableHead>Joined</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredRiders.map((rider) => (
                  <TableRow key={rider.id} className={rider.rider_status === 'deleted' ? 'opacity-50' : ''}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <Avatar className="h-9 w-9">
                          <AvatarFallback className="bg-primary/10 text-primary text-sm">
                            {getInitials(rider.first_name, rider.last_name)}
                          </AvatarFallback>
                        </Avatar>
                        <p className="font-medium">{getFullName(rider)}</p>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="font-mono text-xs">{rider.customer_code}</Badge>
                    </TableCell>
                    <TableCell>{getStatusBadge(rider.rider_status)}</TableCell>
                    <TableCell>
                      {rider.phone ? (
                        <div className="flex items-center gap-1">
                          <Phone className="h-3 w-3 text-muted-foreground" />
                          <span>{rider.phone}</span>
                        </div>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={rider.trip_count && rider.trip_count > 0 ? 'default' : 'secondary'}>
                        <Car className="h-3 w-3 mr-1" />
                        {rider.trip_count || 0}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {rider.last_trip_at ? (
                        <span className="text-sm">
                          {formatDistanceToNow(new Date(rider.last_trip_at), { addSuffix: true })}
                        </span>
                      ) : (
                        <span className="text-muted-foreground text-sm">Never</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1 text-sm text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        {format(new Date(rider.created_at), 'MMM d, yyyy')}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon">
                            <MoreVertical className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => handleViewRider(rider)}>
                            <Eye className="h-4 w-4 mr-2" />
                            View Details
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />

                          {rider.rider_status === 'active' && (
                            <>
                              <DropdownMenuItem onClick={() => openActionDialog(rider, 'suspend')}>
                                <ShieldOff className="h-4 w-4 mr-2 text-amber-600" />
                                Suspend Rider
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => openActionDialog(rider, 'disable')}>
                                <Ban className="h-4 w-4 mr-2 text-red-600" />
                                Disable Rider
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => openActionDialog(rider, 'delete')} className="text-destructive">
                                <Trash2 className="h-4 w-4 mr-2" />
                                Delete Rider
                              </DropdownMenuItem>
                            </>
                          )}

                          {rider.rider_status === 'disabled' && (
                            <DropdownMenuItem onClick={() => openActionDialog(rider, 'enable')}>
                              <CheckCircle className="h-4 w-4 mr-2 text-green-600" />
                              Enable Rider
                            </DropdownMenuItem>
                          )}

                          {rider.rider_status === 'suspended' && (
                            <DropdownMenuItem onClick={() => openActionDialog(rider, 'enable')}>
                              <CheckCircle className="h-4 w-4 mr-2 text-green-600" />
                              Unsuspend Rider
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <RiderDetailsDialog
        open={isViewDialogOpen}
        onOpenChange={setIsViewDialogOpen}
        rider={selectedRider}
        onRiderUpdate={handleRiderUpdate}
      />

      {/* Action Confirmation Dialog */}
      <AlertDialog open={actionDialogOpen} onOpenChange={setActionDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{currentAction.title}</AlertDialogTitle>
            <AlertDialogDescription>{currentAction.description}</AlertDialogDescription>
          </AlertDialogHeader>
          {actionType !== 'enable' && (
            <div className="py-2">
              <Textarea
                placeholder="Reason (optional but recommended for audit)"
                value={actionReason}
                onChange={(e) => setActionReason(e.target.value)}
                rows={2}
              />
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isActing}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleActionConfirm}
              disabled={isActing}
              className={currentAction.buttonClass}
            >
              {isActing && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              {currentAction.buttonLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AdminLayout>
  );
}
