import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
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
import { ADMIN_RIDERS_PAGE_SIZE } from '@/lib/adminQueryBounds';
import {
  Users, Loader2, Search, MoreVertical, Eye,
  Phone, Car, RefreshCw, UserCheck, UserX, Clock, Calendar,
  Ban, ShieldOff, Trash2, CheckCircle,
} from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import { RiderDetailsDialog } from '@/components/riders/RiderDetailsDialog';
import { PersonalVoucherDialog } from '@/components/riders/PersonalVoucherDialog';

interface Rider {
  id: string;
  user_id: string;
  customer_code: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  email: string | null;
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

type StatusFilter = 'all' | 'active' | 'disabled' | 'suspended' | 'deleted';
type ActionType = 'disable' | 'suspend' | 'enable' | 'delete';

export default function Riders() {
  usePageLoadTelemetry('RidersPage');
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const deepLinkCustomerId = searchParams.get('customerId');
  const [searchQuery, setSearchQuery] = useState('');
  const [listPage, setListPage] = useState(0);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [selectedRider, setSelectedRider] = useState<Rider | null>(null);
  const [isViewDialogOpen, setIsViewDialogOpen] = useState(false);
  const [actionDialogOpen, setActionDialogOpen] = useState(false);
  const [actionTarget, setActionTarget] = useState<Rider | null>(null);
  const [actionType, setActionType] = useState<ActionType>('disable');
  const [actionReason, setActionReason] = useState('');
  const [isActing, setIsActing] = useState(false);
  const [voucherRider, setVoucherRider] = useState<Rider | null>(null);
  const [isVoucherDialogOpen, setIsVoucherDialogOpen] = useState(false);

  const { data: ridersPage, isLoading } = useQuery({
    queryKey: ['riders', listPage, statusFilter, searchQuery],
    queryFn: async () => {
      const from = listPage * ADMIN_RIDERS_PAGE_SIZE;
      const to = from + ADMIN_RIDERS_PAGE_SIZE - 1;
      const q = searchQuery.trim();

      let ridersQ = supabase
        .from('admin_riders_with_trip_stats')
        .select(
          'id, user_id, customer_code, first_name, last_name, phone, email, created_at, updated_at, rider_status, trip_count, last_trip_at, identity_verified_at, identity_provider, name_edit_locked, name_unlocked_at',
          { count: 'exact' },
        )
        .order('created_at', { ascending: false })
        .range(from, to);

      if (statusFilter !== 'all') {
        ridersQ = ridersQ.eq('rider_status', statusFilter);
      }
      if (q) {
        ridersQ = ridersQ.or(
          `first_name.ilike.%${q}%,last_name.ilike.%${q}%,phone.ilike.%${q}%,customer_code.ilike.%${q}%`,
        );
      }

      const { data: ridersData, error: ridersError, count } = await ridersQ;
      if (ridersError) throw ridersError;

      const riders = (ridersData || []).map((rider) => ({
        ...rider,
        trip_count: rider.trip_count ?? 0,
        last_trip_at: rider.last_trip_at ?? null,
        rider_status: rider.rider_status || 'active',
      })) as Rider[];
      return { riders, totalCount: count ?? riders.length };
    },
    staleTime: 30_000,
  });

  const riders = ridersPage?.riders ?? [];
  const ridersTotalCount = ridersPage?.totalCount ?? 0;

  const { data: riderStatusCounts } = useQuery({
    queryKey: ['riders-status-counts'],
    queryFn: async () => {
      const head = async (status?: StatusFilter) => {
        let q = supabase
          .from('admin_riders_with_trip_stats')
          .select('id', { count: 'exact', head: true });
        if (status && status !== 'all') q = q.eq('rider_status', status);
        const { count, error } = await q;
        if (error) throw error;
        return count ?? 0;
      };
      const [all, active, disabled, suspended, deleted] = await Promise.all([
        head('all'),
        head('active'),
        head('disabled'),
        head('suspended'),
        head('deleted'),
      ]);
      return { all, active, disabled, suspended, deleted };
    },
    staleTime: 60_000,
  });

  const { data: riderStatCards } = useQuery({
    queryKey: ['riders-stat-cards'],
    queryFn: async () => {
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      const [withTrips, newThisMonth] = await Promise.all([
        supabase
          .from('admin_riders_with_trip_stats')
          .select('id', { count: 'exact', head: true })
          .eq('rider_status', 'active')
          .gt('trip_count', 0),
        supabase
          .from('admin_riders_with_trip_stats')
          .select('id', { count: 'exact', head: true })
          .gte('created_at', monthStart),
      ]);
      if (withTrips.error) throw withTrips.error;
      if (newThisMonth.error) throw newThisMonth.error;
      return {
        withTrips: withTrips.count ?? 0,
        newThisMonth: newThisMonth.count ?? 0,
      };
    },
    staleTime: 60_000,
  });

  // Payment Sessions (and other finance pages) deep-link: /riders?customerId=<uuid>
  useEffect(() => {
    if (!deepLinkCustomerId || isLoading) return;
    const match = riders.find((r) => r.id === deepLinkCustomerId);
    if (match) {
      setSelectedRider(match);
      setIsViewDialogOpen(true);
      setSearchQuery(
        [match.first_name, match.last_name, match.customer_code, match.phone]
          .filter(Boolean)
          .join(' '),
      );
      const next = new URLSearchParams(searchParams);
      next.delete('customerId');
      setSearchParams(next, { replace: true });
      return;
    }

    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('admin_riders_with_trip_stats')
        .select(
          'id, user_id, customer_code, first_name, last_name, phone, email, created_at, updated_at, rider_status, trip_count, last_trip_at, identity_verified_at, identity_provider, name_edit_locked, name_unlocked_at',
        )
        .eq('id', deepLinkCustomerId)
        .maybeSingle();
      if (cancelled || error || !data) return;
      const rider = {
        ...data,
        trip_count: data.trip_count ?? 0,
        last_trip_at: data.last_trip_at ?? null,
        rider_status: data.rider_status || 'active',
      } as Rider;
      setSelectedRider(rider);
      setIsViewDialogOpen(true);
      setSearchQuery(
        [rider.first_name, rider.last_name, rider.customer_code, rider.phone]
          .filter(Boolean)
          .join(' '),
      );
      const next = new URLSearchParams(searchParams);
      next.delete('customerId');
      setSearchParams(next, { replace: true });
    })();
    return () => {
      cancelled = true;
    };
  }, [deepLinkCustomerId, isLoading, riders, searchParams, setSearchParams]);

  useEffect(() => {
    setListPage(0);
  }, [statusFilter, searchQuery]);

  const refreshData = () => {
    queryClient.invalidateQueries({ queryKey: ['riders'] });
    queryClient.invalidateQueries({ queryKey: ['riders-status-counts'] });
    queryClient.invalidateQueries({ queryKey: ['riders-stat-cards'] });
  };

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

  const openPersonalVoucherDialog = (rider: Rider) => {
    setVoucherRider(rider);
    setIsVoucherDialogOpen(true);
  };

  const handleActionConfirm = async () => {
    if (!actionTarget) return;
    setIsActing(true);

    try {
      // Hard delete: route through admin-delete-account edge function so the
      // Supabase Auth user is also removed when no other profiles remain.
      if (actionType === 'delete') {
        const { data, error } = await supabase.functions.invoke('admin-delete-account', {
          body: {
            target: 'customer',
            profile_id: actionTarget.id,
            reason: actionReason || null,
          },
        });

        if (error) {
          console.error('Hard delete failed:', error);
          toast.error(error.message || 'Failed to delete rider');
          return;
        }

        const authDeleted = (data as { auth_user_deleted?: boolean } | null)?.auth_user_deleted;
        toast.success(
          authDeleted
            ? 'Rider permanently deleted (auth account removed)'
            : 'Rider profile deleted (auth account kept — other roles remain)',
        );
        refreshData();
        return;
      }

      // Status changes (disable / suspend / enable) — soft state changes only
      const statusMap: Record<Exclude<ActionType, 'delete'>, string> = {
        disable: 'disabled',
        suspend: 'suspended',
        enable: 'active',
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

      await supabase.from('audit_logs').insert({
        event_type: `rider_${actionType}`,
        user_id: actionTarget.user_id,
        details: { rider_id: actionTarget.id, reason: actionReason || null, new_status: newStatus },
      } as any);

      const labels: Record<Exclude<ActionType, 'delete'>, string> = {
        disable: 'disabled', suspend: 'suspended', enable: 'enabled',
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
      case 'pending_verification':
        return <Badge className="bg-blue-500/10 text-blue-600 border-blue-500/30">Pending Verification</Badge>;
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

  const filteredRiders = riders;
  const counts = riderStatusCounts || {
    all: 0,
    active: 0,
    disabled: 0,
    suspended: 0,
    deleted: 0,
  };
  const activeRiders = riderStatCards?.withTrips ?? 0;
  const newThisMonth = riderStatCards?.newThisMonth ?? 0;

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
      title: 'Permanently Delete Rider',
      description: `Permanently delete ${actionTarget ? getFullName(actionTarget) : ''}? This removes their profile and — if they have no other roles (driver/admin) — also deletes their login account so they cannot sign in again. They would need to sign up as a new user. This cannot be undone.`,
      buttonLabel: 'Delete Permanently',
      buttonClass: 'bg-destructive hover:bg-destructive/90',
    },
  };

  const currentAction = actionLabels[actionType];

  return (
    <AdminLayout title="Riders" description="Active rider accounts only — incomplete signups are under Pending Signups">
      <div className="mb-4 text-sm text-muted-foreground">
        Showing activated customers with a customer ID.
        {' '}
        <Link to="/pending-customer-signups" className="font-medium text-primary underline-offset-2 hover:underline">
          View pending signups
        </Link>
      </div>
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
            <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Rider</TableHead>
                  <TableHead>Customer ID</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Email</TableHead>
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
                        <div>
                          <p className="font-medium">{getFullName(rider)}</p>
                          <div className="flex flex-wrap gap-1 mt-1">
                            {rider.identity_verified_at ? (
                              <Badge className="bg-emerald-500/10 text-emerald-700 border-emerald-500/30 text-[10px] px-1.5 py-0">
                                ID verified
                              </Badge>
                            ) : null}
                            {rider.name_edit_locked ? (
                              <Badge className="bg-amber-500/10 text-amber-700 border-amber-500/30 text-[10px] px-1.5 py-0">
                                Name locked
                              </Badge>
                            ) : null}
                          </div>
                        </div>
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
                      {rider.email ? (
                        <span className="text-sm">{rider.email}</span>
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
                          <DropdownMenuItem onClick={() => openPersonalVoucherDialog(rider)}>
                            <span className="mr-2" aria-hidden>🎟</span>
                            Personal Voucher
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
            <div className="flex items-center justify-between mt-4 gap-2 flex-wrap">
              <p className="text-sm text-muted-foreground">
                Page {listPage + 1}
                {ridersTotalCount ? ` · ${ridersTotalCount} matching` : ''}
                {` · ${ADMIN_RIDERS_PAGE_SIZE} per page`}
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
                  disabled={isLoading || riders.length < ADMIN_RIDERS_PAGE_SIZE}
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

      <RiderDetailsDialog
        open={isViewDialogOpen}
        onOpenChange={setIsViewDialogOpen}
        rider={selectedRider}
        onRiderUpdate={handleRiderUpdate}
      />

      <PersonalVoucherDialog
        open={isVoucherDialogOpen}
        onOpenChange={setIsVoucherDialogOpen}
        rider={voucherRider}
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
