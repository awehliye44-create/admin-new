import { useState } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
  FileText, 
  Search, 
  Check, 
  X, 
  Clock,
  Building2,
  Mail,
  Phone,
  Calendar,
  Eye,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  XCircle
} from 'lucide-react';

interface AccountRequest {
  id: string;
  company_name: string;
  contact_name: string;
  contact_email: string;
  contact_phone: string;
  company_size: string;
  industry: string;
  estimated_monthly_rides: number;
  message: string;
  status: 'pending' | 'approved' | 'rejected' | 'under_review';
  admin_notes: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
}

// No default placeholder data - start with empty list

export default function AccountRequests() {
  const queryClient = useQueryClient();
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [selectedRequest, setSelectedRequest] = useState<AccountRequest | null>(null);
  const [adminNotes, setAdminNotes] = useState('');

  // Fetch requests from database - no default placeholder data
  const { data: requests = [], isLoading } = useQuery({
    queryKey: ['account-requests'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('admin_settings')
        .select('*')
        .eq('setting_key', 'account_requests')
        .maybeSingle();
      
      if (error) throw error;
      return (data?.setting_value as unknown as AccountRequest[]) || [];
    },
  });

  // Save mutation
  const saveMutation = useMutation({
    mutationFn: async (newRequests: AccountRequest[]) => {
      const { error } = await supabase
        .from('admin_settings')
        .upsert([{
          setting_key: 'account_requests',
          setting_value: JSON.parse(JSON.stringify(newRequests)),
          description: 'Corporate account requests',
          updated_at: new Date().toISOString(),
        }], { onConflict: 'setting_key' });
      
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['account-requests'] });
    },
  });

  const handleStatusChange = async (requestId: string, newStatus: AccountRequest['status']) => {
    const updatedRequests = requests.map(r => {
      if (r.id === requestId) {
        return {
          ...r,
          status: newStatus,
          admin_notes: adminNotes || r.admin_notes,
          reviewed_by: 'Admin User',
          reviewed_at: new Date().toISOString(),
        };
      }
      return r;
    });

    await saveMutation.mutateAsync(updatedRequests);
    toast.success(`Request ${newStatus === 'approved' ? 'approved' : newStatus === 'rejected' ? 'rejected' : 'updated'}`);
    setSelectedRequest(null);
    setAdminNotes('');
  };

  const filteredRequests = requests.filter(request => {
    const matchesSearch = request.company_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         request.contact_email.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = statusFilter === 'all' || request.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const getStatusBadge = (status: string) => {
    const config: Record<string, { variant: 'default' | 'secondary' | 'destructive' | 'outline', icon: React.ReactNode }> = {
      pending: { variant: 'secondary', icon: <Clock className="h-3 w-3 mr-1" /> },
      under_review: { variant: 'outline', icon: <AlertCircle className="h-3 w-3 mr-1" /> },
      approved: { variant: 'default', icon: <CheckCircle2 className="h-3 w-3 mr-1" /> },
      rejected: { variant: 'destructive', icon: <XCircle className="h-3 w-3 mr-1" /> },
    };
    const { variant, icon } = config[status] || { variant: 'outline', icon: null };
    return (
      <Badge variant={variant} className="flex items-center w-fit">
        {icon}
        {status.replace('_', ' ')}
      </Badge>
    );
  };

  const pendingCount = requests.filter(r => r.status === 'pending').length;
  const underReviewCount = requests.filter(r => r.status === 'under_review').length;
  const approvedCount = requests.filter(r => r.status === 'approved').length;
  const rejectedCount = requests.filter(r => r.status === 'rejected').length;

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
    <AdminLayout 
      title="Account Requests" 
      description="Review and approve corporate account applications"
    >
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
              <CardTitle className="text-sm font-medium">Approved</CardTitle>
              <CheckCircle2 className="h-4 w-4 text-green-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-500">{approvedCount}</div>
              <p className="text-xs text-muted-foreground">This month</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Rejected</CardTitle>
              <XCircle className="h-4 w-4 text-destructive" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-destructive">{rejectedCount}</div>
              <p className="text-xs text-muted-foreground">This month</p>
            </CardContent>
          </Card>
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input 
              placeholder="Search requests..." 
              className="pl-9"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Filter by status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Requests</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="under_review">Under Review</SelectItem>
              <SelectItem value="approved">Approved</SelectItem>
              <SelectItem value="rejected">Rejected</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Requests Table */}
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Company</TableHead>
                  <TableHead>Contact</TableHead>
                  <TableHead>Industry</TableHead>
                  <TableHead>Company Size</TableHead>
                  <TableHead>Est. Rides/Mo</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Submitted</TableHead>
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
                      <TableCell>
                        <div className="space-y-1">
                          <p className="text-sm">{request.contact_name}</p>
                          <p className="text-xs text-muted-foreground">{request.contact_email}</p>
                        </div>
                      </TableCell>
                      <TableCell>{request.industry}</TableCell>
                      <TableCell>{request.company_size}</TableCell>
                      <TableCell>{request.estimated_monthly_rides}</TableCell>
                      <TableCell>{getStatusBadge(request.status)}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {new Date(request.created_at).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          <Button 
                            variant="ghost" 
                            size="sm"
                            onClick={() => {
                              setSelectedRequest(request);
                              setAdminNotes(request.admin_notes);
                            }}
                          >
                            <Eye className="h-4 w-4 mr-1" />
                            Review
                          </Button>
                          {request.status === 'pending' && (
                            <>
                              <Button 
                                variant="ghost" 
                                size="icon"
                                className="text-green-500 hover:text-green-600 hover:bg-green-50"
                                onClick={() => handleStatusChange(request.id, 'approved')}
                              >
                                <Check className="h-4 w-4" />
                              </Button>
                              <Button 
                                variant="ghost" 
                                size="icon"
                                className="text-destructive hover:text-destructive hover:bg-destructive/10"
                                onClick={() => handleStatusChange(request.id, 'rejected')}
                              >
                                <X className="h-4 w-4" />
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

        {/* Review Dialog */}
        <Dialog open={!!selectedRequest} onOpenChange={() => { setSelectedRequest(null); setAdminNotes(''); }}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Review Request: {selectedRequest?.company_name}</DialogTitle>
              <DialogDescription>Review the application details and take action</DialogDescription>
            </DialogHeader>
            {selectedRequest && (
              <div className="space-y-6 py-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-1">
                    <p className="text-sm text-muted-foreground flex items-center gap-1">
                      <Building2 className="h-3 w-3" /> Company
                    </p>
                    <p className="font-medium">{selectedRequest.company_name}</p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm text-muted-foreground">Industry</p>
                    <p className="font-medium">{selectedRequest.industry}</p>
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-1">
                    <p className="text-sm text-muted-foreground flex items-center gap-1">
                      <Mail className="h-3 w-3" /> Contact
                    </p>
                    <p>{selectedRequest.contact_name}</p>
                    <p className="text-sm text-muted-foreground">{selectedRequest.contact_email}</p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm text-muted-foreground flex items-center gap-1">
                      <Phone className="h-3 w-3" /> Phone
                    </p>
                    <p>{selectedRequest.contact_phone}</p>
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-3">
                  <div className="space-y-1">
                    <p className="text-sm text-muted-foreground">Company Size</p>
                    <p className="font-medium">{selectedRequest.company_size} employees</p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm text-muted-foreground">Est. Monthly Rides</p>
                    <p className="font-medium">{selectedRequest.estimated_monthly_rides}</p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm text-muted-foreground">Status</p>
                    {getStatusBadge(selectedRequest.status)}
                  </div>
                </div>

                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">Message</p>
                  <p className="bg-muted p-3 rounded-md text-sm">{selectedRequest.message}</p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="admin_notes">Admin Notes</Label>
                  <Textarea
                    id="admin_notes"
                    value={adminNotes}
                    onChange={(e) => setAdminNotes(e.target.value)}
                    placeholder="Add notes about this application..."
                    rows={3}
                  />
                </div>

                {selectedRequest.reviewed_at && (
                  <div className="text-sm text-muted-foreground">
                    Reviewed by {selectedRequest.reviewed_by} on {new Date(selectedRequest.reviewed_at).toLocaleString()}
                  </div>
                )}
              </div>
            )}
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => setSelectedRequest(null)}>
                Close
              </Button>
              {selectedRequest?.status !== 'approved' && selectedRequest?.status !== 'rejected' && (
                <>
                  <Button 
                    variant="outline"
                    onClick={() => handleStatusChange(selectedRequest!.id, 'under_review')}
                  >
                    Mark Under Review
                  </Button>
                  <Button 
                    variant="destructive"
                    onClick={() => handleStatusChange(selectedRequest!.id, 'rejected')}
                  >
                    <X className="h-4 w-4 mr-2" />
                    Reject
                  </Button>
                  <Button 
                    onClick={() => handleStatusChange(selectedRequest!.id, 'approved')}
                  >
                    <Check className="h-4 w-4 mr-2" />
                    Approve
                  </Button>
                </>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </AdminLayout>
  );
}
