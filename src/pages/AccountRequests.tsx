import { useState, useEffect } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { 
  Search, 
  Check, 
  X, 
  Clock,
  Building2,
  Mail,
  Phone,
  Eye,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  XCircle,
  MapPin,
  Globe,
  Ban,
  ShieldAlert
} from 'lucide-react';

interface AccountRequest {
  id: string;
  company_name: string;
  contact_name: string;
  contact_email: string;
  contact_phone: string | null;
  address: string | null;
  city: string | null;
  country: string | null;
  tax_id: string | null;
  employee_count: number | null;
  estimated_monthly_trips: number | null;
  notes: string | null;
  status: string;
  rejection_reason: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  approved_at: string | null;
  suspended_at: string | null;
  created_at: string;
  region_id: string | null;
  service_area_id: string | null;
  region?: { id: string; name: string } | null;
  service_area?: { id: string; name: string } | null;
}

export default function AccountRequests() {
  const queryClient = useQueryClient();
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [regionFilter, setRegionFilter] = useState<string>('all');
  const [serviceAreaFilter, setServiceAreaFilter] = useState<string>('all');
  const [selectedRequest, setSelectedRequest] = useState<AccountRequest | null>(null);
  const [rejectionReason, setRejectionReason] = useState('');
  const [confirmAction, setConfirmAction] = useState<{ type: string; id: string } | null>(null);

  const { data: regions = [] } = useQuery({
    queryKey: ['regions'],
    queryFn: async () => {
      const { data, error } = await supabase.from('regions').select('id, name').order('name');
      if (error) throw error;
      return data;
    },
  });

  const { data: serviceAreas = [] } = useQuery({
    queryKey: ['service-areas', regionFilter],
    queryFn: async () => {
      let query = supabase.from('service_areas').select('id, name, region_id').order('name');
      if (regionFilter !== 'all') query = query.eq('region_id', regionFilter);
      const { data, error } = await query;
      if (error) throw error;
      return data;
    },
  });

  useEffect(() => { setServiceAreaFilter('all'); }, [regionFilter]);

  const { data: requests = [], isLoading } = useQuery({
    queryKey: ['corporate-account-requests', regionFilter, serviceAreaFilter],
    queryFn: async () => {
      let query = supabase
        .from('corporate_account_requests')
        .select(`*, region:regions(id, name), service_area:service_areas(id, name)`)
        .order('created_at', { ascending: false });
      if (regionFilter !== 'all') query = query.eq('region_id', regionFilter);
      if (serviceAreaFilter !== 'all') query = query.eq('service_area_id', serviceAreaFilter);
      const { data, error } = await query;
      if (error) throw error;
      return data as AccountRequest[];
    },
  });

  // Approve via RPC — creates corporate_account automatically
  const approveMutation = useMutation({
    mutationFn: async (requestId: string) => {
      const userId = (await supabase.auth.getUser()).data.user?.id;
      const { data, error } = await supabase.rpc('approve_corporate_request', {
        p_request_id: requestId,
        p_reviewed_by: userId,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['corporate-account-requests'] });
      queryClient.invalidateQueries({ queryKey: ['corporate-accounts'] });
      queryClient.invalidateQueries({ queryKey: ['sidebar-counts'] });
      toast.success('Request approved — corporate account created');
      setSelectedRequest(null);
      setConfirmAction(null);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // Reject
  const rejectMutation = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      const { error } = await supabase
        .from('corporate_account_requests')
        .update({
          status: 'rejected',
          rejection_reason: reason || null,
          reviewed_at: new Date().toISOString(),
          reviewed_by: 'Admin',
        })
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['corporate-account-requests'] });
      queryClient.invalidateQueries({ queryKey: ['sidebar-counts'] });
      toast.success('Request rejected');
      setSelectedRequest(null);
      setRejectionReason('');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // Suspend
  const suspendMutation = useMutation({
    mutationFn: async (requestId: string) => {
      const { error } = await supabase.rpc('suspend_corporate_request', {
        p_request_id: requestId,
        p_reviewed_by: 'Admin',
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['corporate-account-requests'] });
      queryClient.invalidateQueries({ queryKey: ['sidebar-counts'] });
      toast.success('Request suspended');
      setSelectedRequest(null);
      setConfirmAction(null);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const filteredRequests = requests.filter(request => {
    const matchesSearch = request.company_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         request.contact_email.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         request.contact_name.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = statusFilter === 'all' || request.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const getStatusBadge = (status: string) => {
    const config: Record<string, { variant: 'default' | 'secondary' | 'destructive' | 'outline'; icon: React.ReactNode; className?: string }> = {
      pending: { variant: 'secondary', icon: <Clock className="h-3 w-3 mr-1" /> },
      under_review: { variant: 'outline', icon: <AlertCircle className="h-3 w-3 mr-1" /> },
      approved: { variant: 'default', icon: <CheckCircle2 className="h-3 w-3 mr-1" /> },
      rejected: { variant: 'destructive', icon: <XCircle className="h-3 w-3 mr-1" /> },
      suspended: { variant: 'outline', icon: <ShieldAlert className="h-3 w-3 mr-1" />, className: 'border-orange-500 text-orange-500' },
    };
    const { variant, icon, className } = config[status] || { variant: 'outline' as const, icon: null };
    return (
      <Badge variant={variant} className={`flex items-center w-fit capitalize ${className || ''}`}>
        {icon}
        {status.replace('_', ' ')}
      </Badge>
    );
  };

  const pendingCount = requests.filter(r => r.status === 'pending').length;
  const underReviewCount = requests.filter(r => r.status === 'under_review').length;
  const rejectedCount = requests.filter(r => r.status === 'rejected').length;
  const suspendedCount = requests.filter(r => r.status === 'suspended').length;

  if (isLoading) {
    return (
      <AdminLayout title="Account Requests" description="Review and approve account requests">
        <div className="flex items-center justify-center h-64">
          <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout title="Account Requests" description="Review and approve corporate account applications">
      <div className="space-y-6">
        {/* Stats */}
        <div className="grid gap-4 md:grid-cols-4">
          <Card className="border-amber-500/50">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Pending</CardTitle>
              <Clock className="h-4 w-4 text-amber-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-amber-500">{pendingCount}</div>
              <p className="text-xs text-muted-foreground">Awaiting review</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Under Review</CardTitle>
              <AlertCircle className="h-4 w-4 text-blue-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{underReviewCount}</div>
              <p className="text-xs text-muted-foreground">Being processed</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Rejected</CardTitle>
              <XCircle className="h-4 w-4 text-destructive" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-destructive">{rejectedCount}</div>
              <p className="text-xs text-muted-foreground">Declined</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Suspended</CardTitle>
              <ShieldAlert className="h-4 w-4 text-orange-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-orange-500">{suspendedCount}</div>
              <p className="text-xs text-muted-foreground">On hold</p>
            </CardContent>
          </Card>
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input 
              placeholder="Search by company, name, or email..." 
              className="pl-9"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
          <Select value={regionFilter} onValueChange={setRegionFilter}>
            <SelectTrigger className="w-[180px]">
              <Globe className="h-4 w-4 mr-2" />
              <SelectValue placeholder="All Regions" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Regions</SelectItem>
              {regions.map((region: any) => (
                <SelectItem key={region.id} value={region.id}>{region.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={serviceAreaFilter} onValueChange={setServiceAreaFilter}>
            <SelectTrigger className="w-[180px]">
              <MapPin className="h-4 w-4 mr-2" />
              <SelectValue placeholder="All Service Areas" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Service Areas</SelectItem>
              {serviceAreas.map((area: any) => (
                <SelectItem key={area.id} value={area.id}>{area.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Filter by status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Requests</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="under_review">Under Review</SelectItem>
              <SelectItem value="rejected">Rejected</SelectItem>
              <SelectItem value="suspended">Suspended</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Requests Table */}
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Organisation</TableHead>
                  <TableHead>Responsible Person</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Address</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredRequests.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                      No requests found
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredRequests.map((request) => (
                    <TableRow key={request.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Building2 className="h-4 w-4 text-muted-foreground" />
                          <span className="font-medium">{request.company_name}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">{request.contact_name}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1 text-sm">
                          <Mail className="h-3 w-3 text-muted-foreground" />
                          {request.contact_email}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1 text-sm text-muted-foreground">
                          <Phone className="h-3 w-3" />
                          {request.contact_phone || '—'}
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className="text-sm text-muted-foreground">
                          {[request.address, request.city, request.country].filter(Boolean).join(', ') || '—'}
                        </span>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {new Date(request.created_at).toLocaleDateString()}
                      </TableCell>
                      <TableCell>{getStatusBadge(request.status)}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button 
                            variant="ghost" 
                            size="sm"
                            onClick={() => {
                              setSelectedRequest(request);
                              setRejectionReason(request.rejection_reason || '');
                            }}
                          >
                            <Eye className="h-4 w-4 mr-1" />
                            View
                          </Button>
                          {(request.status === 'pending' || request.status === 'under_review') && (
                            <>
                              <Button 
                                variant="ghost" 
                                size="icon"
                                className="text-green-500 hover:text-green-600 hover:bg-green-500/10"
                                onClick={() => setConfirmAction({ type: 'approve', id: request.id })}
                              >
                                <Check className="h-4 w-4" />
                              </Button>
                              <Button 
                                variant="ghost" 
                                size="icon"
                                className="text-destructive hover:text-destructive hover:bg-destructive/10"
                                onClick={() => {
                                  setSelectedRequest(request);
                                  setRejectionReason('');
                                }}
                              >
                                <X className="h-4 w-4" />
                              </Button>
                              <Button 
                                variant="ghost" 
                                size="icon"
                                className="text-orange-500 hover:text-orange-600 hover:bg-orange-500/10"
                                onClick={() => setConfirmAction({ type: 'suspend', id: request.id })}
                              >
                                <Ban className="h-4 w-4" />
                              </Button>
                            </>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* Review / Reject Dialog */}
        <Dialog open={!!selectedRequest} onOpenChange={() => { setSelectedRequest(null); setRejectionReason(''); }}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Review: {selectedRequest?.company_name}</DialogTitle>
              <DialogDescription>Review the application details and take action</DialogDescription>
            </DialogHeader>
            {selectedRequest && (
              <div className="space-y-6 py-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-1">
                    <p className="text-sm text-muted-foreground flex items-center gap-1"><Building2 className="h-3 w-3" /> Organisation</p>
                    <p className="font-medium">{selectedRequest.company_name}</p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm text-muted-foreground flex items-center gap-1"><Globe className="h-3 w-3" /> Region / Service Area</p>
                    <p className="font-medium">
                      {selectedRequest.region?.name || 'Not specified'}
                      {selectedRequest.service_area?.name && ` / ${selectedRequest.service_area.name}`}
                    </p>
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-1">
                    <p className="text-sm text-muted-foreground flex items-center gap-1"><Mail className="h-3 w-3" /> Contact</p>
                    <p>{selectedRequest.contact_name}</p>
                    <p className="text-sm text-muted-foreground">{selectedRequest.contact_email}</p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm text-muted-foreground flex items-center gap-1"><Phone className="h-3 w-3" /> Phone</p>
                    <p>{selectedRequest.contact_phone || 'Not provided'}</p>
                  </div>
                </div>

                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground flex items-center gap-1"><MapPin className="h-3 w-3" /> Address</p>
                  <p>{[selectedRequest.address, selectedRequest.city, selectedRequest.country].filter(Boolean).join(', ') || 'Not provided'}</p>
                </div>

                <div className="grid gap-4 md:grid-cols-3">
                  <div className="space-y-1">
                    <p className="text-sm text-muted-foreground">Employee Count</p>
                    <p className="font-medium">{selectedRequest.employee_count || 'Not specified'}</p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm text-muted-foreground">Est. Monthly Trips</p>
                    <p className="font-medium">{selectedRequest.estimated_monthly_trips || 'Not specified'}</p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm text-muted-foreground">Status</p>
                    {getStatusBadge(selectedRequest.status)}
                  </div>
                </div>

                {selectedRequest.notes && (
                  <div className="space-y-1">
                    <p className="text-sm text-muted-foreground">Notes</p>
                    <p className="bg-muted p-3 rounded-md text-sm">{selectedRequest.notes}</p>
                  </div>
                )}

                {selectedRequest.rejection_reason && selectedRequest.status === 'rejected' && (
                  <div className="space-y-1">
                    <p className="text-sm text-destructive font-medium">Rejection Reason</p>
                    <p className="bg-destructive/10 p-3 rounded-md text-sm border border-destructive/20">{selectedRequest.rejection_reason}</p>
                  </div>
                )}

                {(selectedRequest.status === 'pending' || selectedRequest.status === 'under_review') && (
                  <div className="space-y-2">
                    <Label htmlFor="rejection_reason">Rejection Reason (if rejecting)</Label>
                    <Textarea
                      id="rejection_reason"
                      value={rejectionReason}
                      onChange={(e) => setRejectionReason(e.target.value)}
                      placeholder="Enter reason for rejection..."
                      rows={3}
                    />
                  </div>
                )}

                {selectedRequest.reviewed_at && (
                  <div className="text-sm text-muted-foreground">
                    Reviewed by {selectedRequest.reviewed_by} on {new Date(selectedRequest.reviewed_at).toLocaleString()}
                  </div>
                )}
              </div>
            )}
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => setSelectedRequest(null)}>Close</Button>
              {selectedRequest && (selectedRequest.status === 'pending' || selectedRequest.status === 'under_review') && (
                <>
                  <Button 
                    variant="outline"
                    className="text-orange-500 border-orange-500/50 hover:bg-orange-500/10"
                    onClick={() => suspendMutation.mutate(selectedRequest.id)}
                    disabled={suspendMutation.isPending}
                  >
                    <Ban className="h-4 w-4 mr-2" />
                    Suspend
                  </Button>
                  <Button 
                    variant="destructive"
                    onClick={() => rejectMutation.mutate({ id: selectedRequest.id, reason: rejectionReason })}
                    disabled={rejectMutation.isPending}
                  >
                    <X className="h-4 w-4 mr-2" />
                    Reject
                  </Button>
                  <Button 
                    onClick={() => approveMutation.mutate(selectedRequest.id)}
                    disabled={approveMutation.isPending}
                  >
                    <Check className="h-4 w-4 mr-2" />
                    Approve
                  </Button>
                </>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Quick Confirm Dialog */}
        <Dialog open={!!confirmAction} onOpenChange={() => setConfirmAction(null)}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>
                {confirmAction?.type === 'approve' ? 'Approve Request' : 'Suspend Request'}
              </DialogTitle>
              <DialogDescription>
                {confirmAction?.type === 'approve'
                  ? 'This will create a new corporate account and grant full portal access.'
                  : 'This will suspend the request and prevent portal access.'}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => setConfirmAction(null)}>Cancel</Button>
              <Button
                variant={confirmAction?.type === 'approve' ? 'default' : 'destructive'}
                onClick={() => {
                  if (confirmAction?.type === 'approve') {
                    approveMutation.mutate(confirmAction.id);
                  } else if (confirmAction?.type === 'suspend') {
                    suspendMutation.mutate(confirmAction!.id);
                  }
                }}
                disabled={approveMutation.isPending || suspendMutation.isPending}
              >
                {confirmAction?.type === 'approve' ? (
                  <><Check className="h-4 w-4 mr-2" /> Confirm Approval</>
                ) : (
                  <><Ban className="h-4 w-4 mr-2" /> Confirm Suspend</>
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </AdminLayout>
  );
}
