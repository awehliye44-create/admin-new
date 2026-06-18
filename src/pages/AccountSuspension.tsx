import { useState } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { 
  Search, UserX, ShieldOff, RefreshCw, Eye, UserCheck, Clock, AlertTriangle,
  Ban, History, MoreVertical, Loader2
} from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { toast } from 'sonner';
import { format } from 'date-fns';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface Suspension {
  id: string;
  user_type: string;
  user_id: string;
  user_name: string;
  user_email: string;
  reason: string;
  status: string;
  suspended_at: string;
  suspended_by: string | null;
  suspended_by_name: string;
  duration_days: number | null;
  expires_at: string | null;
  lifted_at: string | null;
  lifted_by: string | null;
  lifted_by_name: string | null;
  notes: string;
}

export default function AccountSuspension() {
  const queryClient = useQueryClient();
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [userTypeFilter, setUserTypeFilter] = useState<string>('all');
  const [selectedSuspension, setSelectedSuspension] = useState<Suspension | null>(null);
  const [isViewOpen, setIsViewOpen] = useState(false);
  const [isNewSuspensionOpen, setIsNewSuspensionOpen] = useState(false);
  const [isLiftOpen, setIsLiftOpen] = useState(false);
  
  const [newSuspension, setNewSuspension] = useState({
    user_type: 'driver' as 'driver' | 'rider',
    user_name: '',
    user_email: '',
    reason: '',
    duration_days: '',
    notes: '',
  });

  const { data: suspensions = [], isLoading, refetch } = useQuery({
    queryKey: ['account-suspensions'],
    queryFn: async () => {
      // Auto-expire first
      await supabase
        .from('account_suspensions')
        .update({ status: 'expired' } as any)
        .eq('status', 'active')
        .not('expires_at', 'is', null)
        .lt('expires_at', new Date().toISOString());

      const { data, error } = await supabase
        .from('account_suspensions')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) throw error;
      return (data || []) as unknown as Suspension[];
    },
  });

  const createMutation = useMutation({
    mutationFn: async (suspension: typeof newSuspension) => {
      const expiresAt = suspension.duration_days 
        ? new Date(Date.now() + parseInt(suspension.duration_days) * 86400000).toISOString()
        : null;

      const { error } = await supabase
        .from('account_suspensions')
        .insert({
          user_type: suspension.user_type,
          user_id: crypto.randomUUID(), // placeholder – real integration would look up actual user
          user_name: suspension.user_name,
          user_email: suspension.user_email,
          reason: suspension.reason,
          duration_days: suspension.duration_days ? parseInt(suspension.duration_days) : null,
          expires_at: expiresAt,
          notes: suspension.notes || '',
          suspended_by_name: 'Admin',
        } as any);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['account-suspensions'] });
      toast.success('Account suspended successfully');
      setIsNewSuspensionOpen(false);
      setNewSuspension({ user_type: 'driver', user_name: '', user_email: '', reason: '', duration_days: '', notes: '' });
    },
    onError: () => toast.error('Failed to create suspension'),
  });

  const liftMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from('account_suspensions')
        .update({ 
          status: 'lifted', 
          lifted_at: new Date().toISOString(),
          lifted_by_name: 'Admin',
        } as any)
        .eq('id', id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['account-suspensions'] });
      toast.success('Suspension lifted successfully');
      setIsLiftOpen(false);
      setSelectedSuspension(null);
    },
    onError: () => toast.error('Failed to lift suspension'),
  });

  const handleCreateSuspension = () => {
    if (!newSuspension.user_name || !newSuspension.reason) {
      toast.error('Please fill in required fields');
      return;
    }
    createMutation.mutate(newSuspension);
  };

  const filteredSuspensions = suspensions.filter(s => {
    const matchesSearch = 
      s.user_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      s.user_email.toLowerCase().includes(searchTerm.toLowerCase()) ||
      s.reason.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = statusFilter === 'all' || s.status === statusFilter;
    const matchesType = userTypeFilter === 'all' || s.user_type === userTypeFilter;
    return matchesSearch && matchesStatus && matchesType;
  });

  const activeSuspensions = suspensions.filter(s => s.status === 'active');
  const driverSuspensions = suspensions.filter(s => s.user_type === 'driver' && s.status === 'active');
  const riderSuspensions = suspensions.filter(s => s.user_type === 'rider' && s.status === 'active');

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'active':
        return <Badge variant="destructive" className="gap-1"><Ban className="h-3 w-3" />Active</Badge>;
      case 'lifted':
        return <Badge variant="default" className="gap-1 bg-green-600"><UserCheck className="h-3 w-3" />Lifted</Badge>;
      case 'expired':
        return <Badge variant="secondary" className="gap-1"><Clock className="h-3 w-3" />Expired</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  return (
    <AdminLayout 
      title="Account Suspension" 
      description="Manage suspended driver and rider accounts"
    >
      <div className="space-y-6">
        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Active Suspensions</p>
                  <p className="text-2xl font-bold text-destructive">{activeSuspensions.length}</p>
                </div>
                <ShieldOff className="h-8 w-8 text-destructive opacity-80" />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Suspended Drivers</p>
                  <p className="text-2xl font-bold text-orange-600">{driverSuspensions.length}</p>
                </div>
                <UserX className="h-8 w-8 text-orange-600 opacity-80" />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Suspended Riders</p>
                  <p className="text-2xl font-bold text-yellow-600">{riderSuspensions.length}</p>
                </div>
                <UserX className="h-8 w-8 text-yellow-600 opacity-80" />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Total Records</p>
                  <p className="text-2xl font-bold">{suspensions.length}</p>
                </div>
                <History className="h-8 w-8 text-primary opacity-80" />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Main Content */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <ShieldOff className="h-5 w-5 text-primary" />
                  Suspension Management
                </CardTitle>
                <CardDescription>View and manage account suspensions</CardDescription>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => refetch()} disabled={isLoading}>
                  <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
                  Refresh
                </Button>
                <Button onClick={() => setIsNewSuspensionOpen(true)}>
                  <Ban className="h-4 w-4 mr-2" />
                  Suspend Account
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {/* Filters */}
            <div className="flex flex-col md:flex-row gap-4 mb-6">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search by name, email, or reason..."
                  className="pl-9"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
              </div>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-full md:w-40">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="lifted">Lifted</SelectItem>
                  <SelectItem value="expired">Expired</SelectItem>
                </SelectContent>
              </Select>
              <Select value={userTypeFilter} onValueChange={setUserTypeFilter}>
                <SelectTrigger className="w-full md:w-40">
                  <SelectValue placeholder="User Type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  <SelectItem value="driver">Drivers</SelectItem>
                  <SelectItem value="rider">Riders</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Table */}
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div className="border rounded-lg overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>User</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Reason</TableHead>
                      <TableHead>Suspended</TableHead>
                      <TableHead>Duration</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredSuspensions.map((suspension) => (
                      <TableRow key={suspension.id}>
                        <TableCell>
                          <div>
                            <p className="font-medium">{suspension.user_name}</p>
                            <p className="text-sm text-muted-foreground">{suspension.user_email}</p>
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="capitalize">
                            {suspension.user_type}
                          </Badge>
                        </TableCell>
                        <TableCell className="max-w-[200px] truncate">
                          {suspension.reason}
                        </TableCell>
                        <TableCell>
                          {format(new Date(suspension.suspended_at), 'MMM d, yyyy')}
                        </TableCell>
                        <TableCell>
                          {suspension.duration_days ? `${suspension.duration_days} days` : 'Permanent'}
                        </TableCell>
                        <TableCell>{getStatusBadge(suspension.status)}</TableCell>
                        <TableCell className="text-right">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon">
                                <MoreVertical className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => {
                                setSelectedSuspension(suspension);
                                setIsViewOpen(true);
                              }}>
                                <Eye className="h-4 w-4 mr-2" />
                                View Details
                              </DropdownMenuItem>
                              {suspension.status === 'active' && (
                                <DropdownMenuItem onClick={() => {
                                  setSelectedSuspension(suspension);
                                  setIsLiftOpen(true);
                                }}>
                                  <UserCheck className="h-4 w-4 mr-2" />
                                  Lift Suspension
                                </DropdownMenuItem>
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    ))}
                    {filteredSuspensions.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                          No suspensions found
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* View Details Dialog */}
      <Dialog open={isViewOpen} onOpenChange={setIsViewOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Suspension Details</DialogTitle>
            <DialogDescription>Full details of the account suspension</DialogDescription>
          </DialogHeader>
          {selectedSuspension && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label className="text-muted-foreground">User Name</Label>
                  <p className="font-medium">{selectedSuspension.user_name}</p>
                </div>
                <div>
                  <Label className="text-muted-foreground">Email</Label>
                  <p className="font-medium">{selectedSuspension.user_email}</p>
                </div>
                <div>
                  <Label className="text-muted-foreground">User Type</Label>
                  <p className="font-medium capitalize">{selectedSuspension.user_type}</p>
                </div>
                <div>
                  <Label className="text-muted-foreground">Status</Label>
                  <div className="mt-1">{getStatusBadge(selectedSuspension.status)}</div>
                </div>
                <div>
                  <Label className="text-muted-foreground">Suspended On</Label>
                  <p className="font-medium">{format(new Date(selectedSuspension.suspended_at), 'PPP')}</p>
                </div>
                <div>
                  <Label className="text-muted-foreground">Duration</Label>
                  <p className="font-medium">
                    {selectedSuspension.duration_days ? `${selectedSuspension.duration_days} days` : 'Permanent'}
                  </p>
                </div>
                {selectedSuspension.expires_at && (
                  <div>
                    <Label className="text-muted-foreground">Expires On</Label>
                    <p className="font-medium">{format(new Date(selectedSuspension.expires_at), 'PPP')}</p>
                  </div>
                )}
                <div>
                  <Label className="text-muted-foreground">Suspended By</Label>
                  <p className="font-medium">{selectedSuspension.suspended_by_name}</p>
                </div>
              </div>
              <div>
                <Label className="text-muted-foreground">Reason</Label>
                <p className="font-medium">{selectedSuspension.reason}</p>
              </div>
              {selectedSuspension.notes && (
                <div>
                  <Label className="text-muted-foreground">Notes</Label>
                  <p className="text-sm">{selectedSuspension.notes}</p>
                </div>
              )}
              {selectedSuspension.lifted_at && (
                <div className="pt-4 border-t">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Label className="text-muted-foreground">Lifted On</Label>
                      <p className="font-medium">{format(new Date(selectedSuspension.lifted_at), 'PPP')}</p>
                    </div>
                    <div>
                      <Label className="text-muted-foreground">Lifted By</Label>
                      <p className="font-medium">{selectedSuspension.lifted_by_name}</p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsViewOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New Suspension Dialog */}
      <Dialog open={isNewSuspensionOpen} onOpenChange={setIsNewSuspensionOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Suspend Account</DialogTitle>
            <DialogDescription>Create a new account suspension</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>User Type *</Label>
              <Select 
                value={newSuspension.user_type} 
                onValueChange={(v) => setNewSuspension({ ...newSuspension, user_type: v as 'driver' | 'rider' })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="driver">Driver</SelectItem>
                  <SelectItem value="rider">Rider</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>User Name *</Label>
              <Input
                placeholder="Full name"
                value={newSuspension.user_name}
                onChange={(e) => setNewSuspension({ ...newSuspension, user_name: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label>User Email</Label>
              <Input
                type="email"
                placeholder="user@example.com"
                value={newSuspension.user_email}
                onChange={(e) => setNewSuspension({ ...newSuspension, user_email: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label>Reason *</Label>
              <Select 
                value={newSuspension.reason} 
                onValueChange={(v) => setNewSuspension({ ...newSuspension, reason: v })}
              >
                <SelectTrigger><SelectValue placeholder="Select reason" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="Multiple complaints">Multiple complaints</SelectItem>
                  <SelectItem value="Fraudulent activity">Fraudulent activity</SelectItem>
                  <SelectItem value="Document verification failure">Document verification failure</SelectItem>
                  <SelectItem value="Inappropriate behavior">Inappropriate behavior</SelectItem>
                  <SelectItem value="Policy violation">Policy violation</SelectItem>
                  <SelectItem value="Safety concern">Safety concern</SelectItem>
                  <SelectItem value="Other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Duration (days)</Label>
              <Input
                type="number"
                placeholder="Leave empty for permanent"
                value={newSuspension.duration_days}
                onChange={(e) => setNewSuspension({ ...newSuspension, duration_days: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">Leave empty for permanent suspension</p>
            </div>
            <div className="space-y-2">
              <Label>Notes</Label>
              <Textarea
                placeholder="Additional notes..."
                value={newSuspension.notes}
                onChange={(e) => setNewSuspension({ ...newSuspension, notes: e.target.value })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsNewSuspensionOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={handleCreateSuspension} disabled={createMutation.isPending}>
              {createMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              <Ban className="h-4 w-4 mr-2" />
              Suspend Account
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Lift Suspension Dialog */}
      <Dialog open={isLiftOpen} onOpenChange={setIsLiftOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Lift Suspension</DialogTitle>
            <DialogDescription>
              Are you sure you want to lift the suspension for {selectedSuspension?.user_name}?
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <div className="flex items-center gap-3 p-4 bg-muted rounded-lg">
              <AlertTriangle className="h-5 w-5 text-yellow-500" />
              <div>
                <p className="font-medium">This will restore account access</p>
                <p className="text-sm text-muted-foreground">
                  The user will be able to use the platform immediately.
                </p>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsLiftOpen(false)}>Cancel</Button>
            <Button 
              onClick={() => selectedSuspension && liftMutation.mutate(selectedSuspension.id)}
              disabled={liftMutation.isPending}
            >
              {liftMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              <UserCheck className="h-4 w-4 mr-2" />
              Lift Suspension
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}
