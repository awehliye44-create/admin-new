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
  Search, 
  AlertTriangle, 
  RefreshCw, 
  Eye, 
  MessageSquare, 
  Clock, 
  CheckCircle,
  XCircle,
  MoreVertical,
  User,
  Car,
  AlertCircle,
  TrendingUp
} from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { format } from 'date-fns';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface Complaint {
  id: string;
  complaint_number: string;
  reporter_type: 'rider' | 'driver';
  reporter_name: string;
  reporter_email: string;
  reported_user_type: 'rider' | 'driver';
  reported_user_name: string;
  trip_id: string | null;
  category: string;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  status: 'new' | 'in_progress' | 'resolved' | 'dismissed';
  subject: string;
  description: string;
  created_at: string;
  updated_at: string;
  assigned_to: string | null;
  resolution: string | null;
  resolved_at: string | null;
}

const defaultComplaints: Complaint[] = [
  {
    id: '1',
    complaint_number: 'CMP-2024-001',
    reporter_type: 'rider',
    reporter_name: 'John Smith',
    reporter_email: 'john.s@email.com',
    reported_user_type: 'driver',
    reported_user_name: 'Michael Brown',
    trip_id: 'TRIP-12345',
    category: 'Driver Behavior',
    priority: 'high',
    status: 'new',
    subject: 'Rude driver during trip',
    description: 'The driver was very rude and made inappropriate comments during the ride.',
    created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    updated_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    assigned_to: null,
    resolution: null,
    resolved_at: null,
  },
  {
    id: '2',
    complaint_number: 'CMP-2024-002',
    reporter_type: 'driver',
    reporter_name: 'Sarah Johnson',
    reporter_email: 'sarah.j@email.com',
    reported_user_type: 'rider',
    reported_user_name: 'Emily Davis',
    trip_id: 'TRIP-12346',
    category: 'Rider Behavior',
    priority: 'medium',
    status: 'in_progress',
    subject: 'Rider left mess in vehicle',
    description: 'The rider left food and trash in the backseat of my vehicle.',
    created_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    updated_at: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
    assigned_to: 'Support Agent 1',
    resolution: null,
    resolved_at: null,
  },
  {
    id: '3',
    complaint_number: 'CMP-2024-003',
    reporter_type: 'rider',
    reporter_name: 'Alice Williams',
    reporter_email: 'alice.w@email.com',
    reported_user_type: 'driver',
    reported_user_name: 'James Carter',
    trip_id: 'TRIP-12347',
    category: 'Safety Concern',
    priority: 'urgent',
    status: 'new',
    subject: 'Unsafe driving behavior',
    description: 'Driver was speeding and running red lights. I felt unsafe during the entire trip.',
    created_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    updated_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    assigned_to: null,
    resolution: null,
    resolved_at: null,
  },
  {
    id: '4',
    complaint_number: 'CMP-2024-004',
    reporter_type: 'rider',
    reporter_name: 'Robert Lee',
    reporter_email: 'robert.l@email.com',
    reported_user_type: 'driver',
    reported_user_name: 'David Wilson',
    trip_id: 'TRIP-12340',
    category: 'Fare Dispute',
    priority: 'low',
    status: 'resolved',
    subject: 'Overcharged for trip',
    description: 'I was charged more than the estimated fare without explanation.',
    created_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    updated_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    assigned_to: 'Support Agent 2',
    resolution: 'Refund issued for the difference. Driver reminded about fare transparency.',
    resolved_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
  },
];

export default function ComplaintsDashboard() {
  const queryClient = useQueryClient();
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [priorityFilter, setPriorityFilter] = useState<string>('all');
  const [selectedComplaint, setSelectedComplaint] = useState<Complaint | null>(null);
  const [isViewOpen, setIsViewOpen] = useState(false);
  const [isResolveOpen, setIsResolveOpen] = useState(false);
  const [resolution, setResolution] = useState('');

  const { data: complaints = defaultComplaints, isLoading, refetch } = useQuery({
    queryKey: ['complaints'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('admin_settings')
        .select('*')
        .eq('setting_key', 'complaints_data')
        .single();

      if (error || !data) return defaultComplaints;
      return (data.setting_value as unknown as Complaint[]) || defaultComplaints;
    },
  });

  const saveMutation = useMutation({
    mutationFn: async (updatedComplaints: Complaint[]) => {
      const { error } = await supabase
        .from('admin_settings')
        .upsert({
          setting_key: 'complaints_data',
          setting_value: updatedComplaints as any,
          description: 'Complaints data',
        } as any, { onConflict: 'setting_key' });

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['complaints'] });
      toast.success('Complaint updated successfully');
    },
    onError: () => {
      toast.error('Failed to update complaint');
    },
  });

  const handleStatusChange = (complaintId: string, newStatus: Complaint['status']) => {
    const updated = complaints.map(c => 
      c.id === complaintId 
        ? { ...c, status: newStatus, updated_at: new Date().toISOString(), assigned_to: newStatus === 'in_progress' ? 'Support Agent' : c.assigned_to }
        : c
    );
    saveMutation.mutate(updated);
  };

  const handleResolve = () => {
    if (!selectedComplaint || !resolution.trim()) {
      toast.error('Please provide a resolution');
      return;
    }

    const updated = complaints.map(c => 
      c.id === selectedComplaint.id 
        ? { 
            ...c, 
            status: 'resolved' as const, 
            resolution, 
            resolved_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          }
        : c
    );
    saveMutation.mutate(updated);
    setIsResolveOpen(false);
    setResolution('');
    setSelectedComplaint(null);
  };

  const filteredComplaints = complaints.filter(complaint => {
    const matchesSearch = 
      complaint.complaint_number.toLowerCase().includes(searchTerm.toLowerCase()) ||
      complaint.subject.toLowerCase().includes(searchTerm.toLowerCase()) ||
      complaint.reporter_name.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = statusFilter === 'all' || complaint.status === statusFilter;
    const matchesPriority = priorityFilter === 'all' || complaint.priority === priorityFilter;
    return matchesSearch && matchesStatus && matchesPriority;
  });

  const newCount = complaints.filter(c => c.status === 'new').length;
  const inProgressCount = complaints.filter(c => c.status === 'in_progress').length;
  const urgentCount = complaints.filter(c => c.priority === 'urgent' && c.status !== 'resolved').length;

  const getPriorityBadge = (priority: string) => {
    switch (priority) {
      case 'urgent':
        return <Badge variant="destructive">Urgent</Badge>;
      case 'high':
        return <Badge className="bg-orange-500 hover:bg-orange-600">High</Badge>;
      case 'medium':
        return <Badge className="bg-yellow-500 hover:bg-yellow-600">Medium</Badge>;
      case 'low':
        return <Badge variant="secondary">Low</Badge>;
      default:
        return <Badge variant="outline">{priority}</Badge>;
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'new':
        return <Badge variant="destructive" className="gap-1"><AlertCircle className="h-3 w-3" />New</Badge>;
      case 'in_progress':
        return <Badge className="gap-1 bg-blue-500 hover:bg-blue-600"><Clock className="h-3 w-3" />In Progress</Badge>;
      case 'resolved':
        return <Badge variant="default" className="gap-1 bg-green-600"><CheckCircle className="h-3 w-3" />Resolved</Badge>;
      case 'dismissed':
        return <Badge variant="secondary" className="gap-1"><XCircle className="h-3 w-3" />Dismissed</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  return (
    <AdminLayout 
      title="Complaints Dashboard" 
      description="Handle and resolve customer complaints"
    >
      <div className="space-y-6">
        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">New Complaints</p>
                  <p className="text-2xl font-bold text-destructive">{newCount}</p>
                </div>
                <AlertTriangle className="h-8 w-8 text-destructive opacity-80" />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">In Progress</p>
                  <p className="text-2xl font-bold text-blue-600">{inProgressCount}</p>
                </div>
                <Clock className="h-8 w-8 text-blue-600 opacity-80" />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Urgent Priority</p>
                  <p className="text-2xl font-bold text-orange-600">{urgentCount}</p>
                </div>
                <AlertCircle className="h-8 w-8 text-orange-600 opacity-80" />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Total Complaints</p>
                  <p className="text-2xl font-bold">{complaints.length}</p>
                </div>
                <MessageSquare className="h-8 w-8 text-primary opacity-80" />
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
                  <AlertTriangle className="h-5 w-5 text-primary" />
                  Complaint Management
                </CardTitle>
                <CardDescription>Review and handle customer complaints</CardDescription>
              </div>
              <Button variant="outline" onClick={() => refetch()} disabled={isLoading}>
                <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
                Refresh
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {/* Filters */}
            <div className="flex flex-col md:flex-row gap-4 mb-6">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search complaints..."
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
                  <SelectItem value="new">New</SelectItem>
                  <SelectItem value="in_progress">In Progress</SelectItem>
                  <SelectItem value="resolved">Resolved</SelectItem>
                  <SelectItem value="dismissed">Dismissed</SelectItem>
                </SelectContent>
              </Select>
              <Select value={priorityFilter} onValueChange={setPriorityFilter}>
                <SelectTrigger className="w-full md:w-40">
                  <SelectValue placeholder="Priority" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Priority</SelectItem>
                  <SelectItem value="urgent">Urgent</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="low">Low</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Table */}
            <div className="border rounded-lg overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Complaint #</TableHead>
                    <TableHead>Subject</TableHead>
                    <TableHead>Reporter</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead>Priority</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredComplaints.map((complaint) => (
                    <TableRow key={complaint.id}>
                      <TableCell className="font-mono text-sm">{complaint.complaint_number}</TableCell>
                      <TableCell className="max-w-[200px] truncate font-medium">
                        {complaint.subject}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {complaint.reporter_type === 'rider' ? (
                            <User className="h-4 w-4 text-muted-foreground" />
                          ) : (
                            <Car className="h-4 w-4 text-muted-foreground" />
                          )}
                          <span>{complaint.reporter_name}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{complaint.category}</Badge>
                      </TableCell>
                      <TableCell>{getPriorityBadge(complaint.priority)}</TableCell>
                      <TableCell>{getStatusBadge(complaint.status)}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {format(new Date(complaint.created_at), 'MMM d, HH:mm')}
                      </TableCell>
                      <TableCell className="text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon">
                              <MoreVertical className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => {
                              setSelectedComplaint(complaint);
                              setIsViewOpen(true);
                            }}>
                              <Eye className="h-4 w-4 mr-2" />
                              View Details
                            </DropdownMenuItem>
                            {complaint.status === 'new' && (
                              <DropdownMenuItem onClick={() => handleStatusChange(complaint.id, 'in_progress')}>
                                <Clock className="h-4 w-4 mr-2" />
                                Start Processing
                              </DropdownMenuItem>
                            )}
                            {complaint.status !== 'resolved' && complaint.status !== 'dismissed' && (
                              <>
                                <DropdownMenuItem onClick={() => {
                                  setSelectedComplaint(complaint);
                                  setIsResolveOpen(true);
                                }}>
                                  <CheckCircle className="h-4 w-4 mr-2" />
                                  Resolve
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => handleStatusChange(complaint.id, 'dismissed')}>
                                  <XCircle className="h-4 w-4 mr-2" />
                                  Dismiss
                                </DropdownMenuItem>
                              </>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))}
                  {filteredComplaints.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                        No complaints found
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* View Details Dialog */}
      <Dialog open={isViewOpen} onOpenChange={setIsViewOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Complaint Details</DialogTitle>
            <DialogDescription>
              {selectedComplaint?.complaint_number}
            </DialogDescription>
          </DialogHeader>
          {selectedComplaint && (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                {getPriorityBadge(selectedComplaint.priority)}
                {getStatusBadge(selectedComplaint.status)}
              </div>
              <div>
                <Label className="text-muted-foreground">Subject</Label>
                <p className="font-medium">{selectedComplaint.subject}</p>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label className="text-muted-foreground">Reporter</Label>
                  <p className="font-medium">{selectedComplaint.reporter_name}</p>
                  <p className="text-sm text-muted-foreground capitalize">{selectedComplaint.reporter_type}</p>
                </div>
                <div>
                  <Label className="text-muted-foreground">Reported User</Label>
                  <p className="font-medium">{selectedComplaint.reported_user_name}</p>
                  <p className="text-sm text-muted-foreground capitalize">{selectedComplaint.reported_user_type}</p>
                </div>
              </div>
              <div>
                <Label className="text-muted-foreground">Description</Label>
                <p className="text-sm mt-1">{selectedComplaint.description}</p>
              </div>
              {selectedComplaint.trip_id && (
                <div>
                  <Label className="text-muted-foreground">Related Trip</Label>
                  <p className="font-mono text-sm">{selectedComplaint.trip_id}</p>
                </div>
              )}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label className="text-muted-foreground">Category</Label>
                  <p className="font-medium">{selectedComplaint.category}</p>
                </div>
                <div>
                  <Label className="text-muted-foreground">Created</Label>
                  <p className="font-medium">{format(new Date(selectedComplaint.created_at), 'PPP p')}</p>
                </div>
              </div>
              {selectedComplaint.assigned_to && (
                <div>
                  <Label className="text-muted-foreground">Assigned To</Label>
                  <p className="font-medium">{selectedComplaint.assigned_to}</p>
                </div>
              )}
              {selectedComplaint.resolution && (
                <div className="pt-4 border-t">
                  <Label className="text-muted-foreground">Resolution</Label>
                  <p className="text-sm mt-1">{selectedComplaint.resolution}</p>
                  {selectedComplaint.resolved_at && (
                    <p className="text-xs text-muted-foreground mt-2">
                      Resolved on {format(new Date(selectedComplaint.resolved_at), 'PPP p')}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsViewOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Resolve Dialog */}
      <Dialog open={isResolveOpen} onOpenChange={setIsResolveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Resolve Complaint</DialogTitle>
            <DialogDescription>
              Provide a resolution for complaint {selectedComplaint?.complaint_number}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Resolution *</Label>
              <Textarea
                placeholder="Describe how the complaint was resolved..."
                value={resolution}
                onChange={(e) => setResolution(e.target.value)}
                rows={4}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => {
              setIsResolveOpen(false);
              setResolution('');
            }}>Cancel</Button>
            <Button onClick={handleResolve}>
              <CheckCircle className="h-4 w-4 mr-2" />
              Mark Resolved
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}
