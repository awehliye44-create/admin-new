import { useState } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { 
  Scale, 
  Search, 
  Download, 
  DollarSign,
  Eye,
  RefreshCw,
  Clock,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  MessageSquare,
  User,
  Calendar,
  FileText,
  ArrowUpRight,
  ArrowDownLeft
} from 'lucide-react';

interface Dispute {
  id: string;
  dispute_id: string;
  type: 'fare_dispute' | 'refund_request' | 'driver_complaint' | 'rider_complaint' | 'billing_error' | 'service_issue';
  trip_id: string;
  customer_name: string;
  customer_email: string;
  driver_name: string | null;
  amount: number;
  status: 'open' | 'investigating' | 'resolved' | 'rejected' | 'escalated';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  description: string;
  resolution: string | null;
  resolution_amount: number | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  assigned_to: string | null;
}

const defaultDisputes: Dispute[] = [
  {
    id: '1',
    dispute_id: 'DSP-2024-001',
    type: 'fare_dispute',
    trip_id: 'TRIP-001',
    customer_name: 'John Smith',
    customer_email: 'john@email.com',
    driver_name: 'Mike Johnson',
    amount: 45.50,
    status: 'open',
    priority: 'medium',
    description: 'Customer claims the fare was higher than the estimated amount shown in the app.',
    resolution: null,
    resolution_amount: null,
    created_at: '2024-01-14T10:30:00Z',
    updated_at: '2024-01-14T10:30:00Z',
    resolved_at: null,
    assigned_to: null,
  },
  {
    id: '2',
    dispute_id: 'DSP-2024-002',
    type: 'refund_request',
    trip_id: 'TRIP-002',
    customer_name: 'Sarah Davis',
    customer_email: 'sarah@email.com',
    driver_name: 'Alex Turner',
    amount: 28.00,
    status: 'investigating',
    priority: 'high',
    description: 'Driver took a longer route. Customer requesting full refund.',
    resolution: null,
    resolution_amount: null,
    created_at: '2024-01-13T14:20:00Z',
    updated_at: '2024-01-14T09:00:00Z',
    resolved_at: null,
    assigned_to: 'Support Team',
  },
  {
    id: '3',
    dispute_id: 'DSP-2024-003',
    type: 'driver_complaint',
    trip_id: 'TRIP-003',
    customer_name: 'Emily Chen',
    customer_email: 'emily@email.com',
    driver_name: 'James Wilson',
    amount: 0,
    status: 'escalated',
    priority: 'urgent',
    description: 'Customer reports unsafe driving behavior. Multiple lane changes without signaling.',
    resolution: null,
    resolution_amount: null,
    created_at: '2024-01-12T16:45:00Z',
    updated_at: '2024-01-14T11:00:00Z',
    resolved_at: null,
    assigned_to: 'Safety Team',
  },
  {
    id: '4',
    dispute_id: 'DSP-2024-004',
    type: 'billing_error',
    trip_id: 'TRIP-004',
    customer_name: 'Robert Brown',
    customer_email: 'robert@email.com',
    driver_name: null,
    amount: 75.00,
    status: 'resolved',
    priority: 'medium',
    description: 'Customer was charged twice for the same trip.',
    resolution: 'Duplicate charge confirmed. Full refund processed.',
    resolution_amount: 75.00,
    created_at: '2024-01-10T08:00:00Z',
    updated_at: '2024-01-11T15:30:00Z',
    resolved_at: '2024-01-11T15:30:00Z',
    assigned_to: 'Billing Team',
  },
  {
    id: '5',
    dispute_id: 'DSP-2024-005',
    type: 'service_issue',
    trip_id: 'TRIP-005',
    customer_name: 'Lisa Anderson',
    customer_email: 'lisa@email.com',
    driver_name: 'David Brown',
    amount: 35.00,
    status: 'rejected',
    priority: 'low',
    description: 'Customer claims driver arrived late. Requesting refund.',
    resolution: 'GPS data shows driver arrived within acceptable timeframe. Dispute rejected.',
    resolution_amount: 0,
    created_at: '2024-01-09T12:00:00Z',
    updated_at: '2024-01-10T10:00:00Z',
    resolved_at: '2024-01-10T10:00:00Z',
    assigned_to: 'Support Team',
  },
];

export default function Disputes() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState('open');
  const [searchTerm, setSearchTerm] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [viewingDispute, setViewingDispute] = useState<Dispute | null>(null);
  const [resolutionNotes, setResolutionNotes] = useState('');
  const [resolutionAmount, setResolutionAmount] = useState('');

  const { data: disputes = [], isLoading } = useQuery({
    queryKey: ['disputes'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('admin_settings')
        .select('*')
        .eq('setting_key', 'disputes_data')
        .maybeSingle();
      
      if (error) throw error;
      return (data?.setting_value as unknown as Dispute[]) || defaultDisputes;
    },
  });

  const saveMutation = useMutation({
    mutationFn: async (newDisputes: Dispute[]) => {
      const { error } = await supabase
        .from('admin_settings')
        .upsert([{
          setting_key: 'disputes_data',
          setting_value: JSON.parse(JSON.stringify(newDisputes)),
          description: 'Disputes data',
          updated_at: new Date().toISOString(),
        }], { onConflict: 'setting_key' });
      
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['disputes'] });
    },
  });

  const handleUpdateStatus = async (disputeId: string, newStatus: Dispute['status']) => {
    const now = new Date().toISOString();
    const updatedDisputes = disputes.map(d => 
      d.id === disputeId 
        ? { 
            ...d, 
            status: newStatus, 
            updated_at: now,
            resolved_at: ['resolved', 'rejected'].includes(newStatus) ? now : d.resolved_at,
            resolution: resolutionNotes || d.resolution,
            resolution_amount: resolutionAmount ? parseFloat(resolutionAmount) : d.resolution_amount,
          }
        : d
    );
    await saveMutation.mutateAsync(updatedDisputes);
    toast.success(`Dispute status updated to ${newStatus}`);
    setViewingDispute(null);
    setResolutionNotes('');
    setResolutionAmount('');
  };

  const getStatusBadge = (status: string) => {
    const config: Record<string, { variant: 'default' | 'secondary' | 'destructive' | 'outline', icon: React.ReactNode, className?: string }> = {
      open: { variant: 'secondary', icon: <Clock className="h-3 w-3 mr-1" /> },
      investigating: { variant: 'outline', icon: <Search className="h-3 w-3 mr-1" /> },
      resolved: { variant: 'default', icon: <CheckCircle2 className="h-3 w-3 mr-1" />, className: 'bg-green-500' },
      rejected: { variant: 'destructive', icon: <XCircle className="h-3 w-3 mr-1" /> },
      escalated: { variant: 'outline', icon: <AlertTriangle className="h-3 w-3 mr-1" />, className: 'border-orange-500 text-orange-500' },
    };
    const { variant, icon, className } = config[status] || { variant: 'outline', icon: null };
    return (
      <Badge variant={variant} className={`flex items-center w-fit ${className || ''}`}>
        {icon}
        {status}
      </Badge>
    );
  };

  const getPriorityBadge = (priority: string) => {
    const config: Record<string, string> = {
      low: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-100',
      medium: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-100',
      high: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-100',
      urgent: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-100',
    };
    return <Badge variant="outline" className={config[priority]}>{priority}</Badge>;
  };

  const getTypeBadge = (type: string) => {
    return <Badge variant="outline">{type.replace('_', ' ')}</Badge>;
  };

  const filteredDisputes = disputes.filter(dispute => {
    const matchesSearch = dispute.dispute_id.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         dispute.customer_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         dispute.description.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesType = typeFilter === 'all' || dispute.type === typeFilter;
    const matchesTab = activeTab === 'all' || dispute.status === activeTab;
    return matchesSearch && matchesType && matchesTab;
  });

  // Stats
  const openCount = disputes.filter(d => d.status === 'open').length;
  const investigatingCount = disputes.filter(d => d.status === 'investigating').length;
  const escalatedCount = disputes.filter(d => d.status === 'escalated').length;
  const resolvedThisMonth = disputes.filter(d => d.status === 'resolved').length;

  if (isLoading) {
    return (
      <AdminLayout title="Disputes & Adjustments" description="Manage disputes">
        <div className="flex items-center justify-center h-64">
          <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout 
      title="Disputes & Adjustments" 
      description="Handle payment disputes and fare adjustments"
    >
      <div className="space-y-6">
        {/* Stats */}
        <div className="grid gap-4 md:grid-cols-4">
          <Card className="border-amber-500/50">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Open Disputes</CardTitle>
              <Clock className="h-4 w-4 text-amber-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-amber-500">{openCount}</div>
              <p className="text-xs text-muted-foreground">Awaiting review</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Investigating</CardTitle>
              <Search className="h-4 w-4 text-blue-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-blue-500">{investigatingCount}</div>
              <p className="text-xs text-muted-foreground">In progress</p>
            </CardContent>
          </Card>
          <Card className="border-orange-500/50">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Escalated</CardTitle>
              <AlertTriangle className="h-4 w-4 text-orange-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-orange-500">{escalatedCount}</div>
              <p className="text-xs text-muted-foreground">Needs attention</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Resolved</CardTitle>
              <CheckCircle2 className="h-4 w-4 text-green-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-500">{resolvedThisMonth}</div>
              <p className="text-xs text-muted-foreground">This month</p>
            </CardContent>
          </Card>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
          <div className="flex flex-col sm:flex-row justify-between gap-4">
            <TabsList>
              <TabsTrigger value="open" className="flex items-center gap-1">
                Open
                {openCount > 0 && (
                  <Badge variant="secondary" className="ml-1 h-5 w-5 rounded-full p-0 flex items-center justify-center text-xs">
                    {openCount}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="investigating">Investigating</TabsTrigger>
              <TabsTrigger value="escalated">Escalated</TabsTrigger>
              <TabsTrigger value="resolved">Resolved</TabsTrigger>
              <TabsTrigger value="all">All</TabsTrigger>
            </TabsList>

            <div className="flex gap-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input 
                  placeholder="Search..." 
                  className="pl-9 w-[200px]"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
              </div>
              <Select value={typeFilter} onValueChange={setTypeFilter}>
                <SelectTrigger className="w-[150px]">
                  <SelectValue placeholder="Type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  <SelectItem value="fare_dispute">Fare Dispute</SelectItem>
                  <SelectItem value="refund_request">Refund Request</SelectItem>
                  <SelectItem value="driver_complaint">Driver Complaint</SelectItem>
                  <SelectItem value="billing_error">Billing Error</SelectItem>
                  <SelectItem value="service_issue">Service Issue</SelectItem>
                </SelectContent>
              </Select>
              <Button variant="outline">
                <Download className="h-4 w-4 mr-2" />
                Export
              </Button>
            </div>
          </div>

          <TabsContent value={activeTab} className="m-0">
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Dispute ID</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Customer</TableHead>
                      <TableHead>Amount</TableHead>
                      <TableHead>Priority</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Created</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredDisputes.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                          No disputes found
                        </TableCell>
                      </TableRow>
                    ) : (
                      filteredDisputes.map((dispute) => (
                        <TableRow key={dispute.id}>
                          <TableCell className="font-mono text-sm">{dispute.dispute_id}</TableCell>
                          <TableCell>{getTypeBadge(dispute.type)}</TableCell>
                          <TableCell>
                            <div>
                              <p className="font-medium">{dispute.customer_name}</p>
                              <p className="text-xs text-muted-foreground">{dispute.trip_id}</p>
                            </div>
                          </TableCell>
                          <TableCell className="font-medium">
                            {dispute.amount > 0 ? `$${dispute.amount.toFixed(2)}` : '-'}
                          </TableCell>
                          <TableCell>{getPriorityBadge(dispute.priority)}</TableCell>
                          <TableCell>{getStatusBadge(dispute.status)}</TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {new Date(dispute.created_at).toLocaleDateString()}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button 
                              variant="ghost" 
                              size="sm"
                              onClick={() => setViewingDispute(dispute)}
                            >
                              <Eye className="h-4 w-4" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        {/* Dispute Detail Dialog */}
        <Dialog open={!!viewingDispute} onOpenChange={() => { setViewingDispute(null); setResolutionNotes(''); setResolutionAmount(''); }}>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Scale className="h-5 w-5" />
                Dispute Details
              </DialogTitle>
              <DialogDescription>{viewingDispute?.dispute_id}</DialogDescription>
            </DialogHeader>
            {viewingDispute && (
              <div className="space-y-4 py-4">
                <div className="grid gap-4 md:grid-cols-3">
                  <div>
                    <p className="text-sm text-muted-foreground">Type</p>
                    {getTypeBadge(viewingDispute.type)}
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Status</p>
                    {getStatusBadge(viewingDispute.status)}
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Priority</p>
                    {getPriorityBadge(viewingDispute.priority)}
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <p className="text-sm text-muted-foreground">Customer</p>
                    <p className="font-medium">{viewingDispute.customer_name}</p>
                    <p className="text-sm text-muted-foreground">{viewingDispute.customer_email}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Driver</p>
                    <p className="font-medium">{viewingDispute.driver_name || '-'}</p>
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <p className="text-sm text-muted-foreground">Trip ID</p>
                    <p className="font-mono">{viewingDispute.trip_id}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Dispute Amount</p>
                    <p className="text-lg font-bold">
                      {viewingDispute.amount > 0 ? `$${viewingDispute.amount.toFixed(2)}` : '-'}
                    </p>
                  </div>
                </div>

                <div>
                  <p className="text-sm text-muted-foreground">Description</p>
                  <p className="bg-muted p-3 rounded-md text-sm">{viewingDispute.description}</p>
                </div>

                {viewingDispute.resolution && (
                  <div>
                    <p className="text-sm text-muted-foreground">Resolution</p>
                    <p className="bg-green-50 dark:bg-green-900/20 p-3 rounded-md text-sm">{viewingDispute.resolution}</p>
                    {viewingDispute.resolution_amount !== null && viewingDispute.resolution_amount > 0 && (
                      <p className="text-sm mt-1">Refund amount: <span className="font-medium">${viewingDispute.resolution_amount.toFixed(2)}</span></p>
                    )}
                  </div>
                )}

                {!['resolved', 'rejected'].includes(viewingDispute.status) && (
                  <div className="space-y-4 border-t pt-4">
                    <h4 className="font-medium">Resolve Dispute</h4>
                    <div className="space-y-2">
                      <Label htmlFor="resolution">Resolution Notes</Label>
                      <Textarea
                        id="resolution"
                        value={resolutionNotes}
                        onChange={(e) => setResolutionNotes(e.target.value)}
                        placeholder="Describe the resolution..."
                        rows={3}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="amount">Refund Amount (if applicable)</Label>
                      <Input
                        id="amount"
                        type="number"
                        step="0.01"
                        value={resolutionAmount}
                        onChange={(e) => setResolutionAmount(e.target.value)}
                        placeholder="0.00"
                      />
                    </div>
                  </div>
                )}

                <div className="text-sm text-muted-foreground">
                  <p>Created: {new Date(viewingDispute.created_at).toLocaleString()}</p>
                  <p>Last Updated: {new Date(viewingDispute.updated_at).toLocaleString()}</p>
                  {viewingDispute.assigned_to && <p>Assigned to: {viewingDispute.assigned_to}</p>}
                </div>
              </div>
            )}
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => setViewingDispute(null)}>
                Close
              </Button>
              {viewingDispute && !['resolved', 'rejected'].includes(viewingDispute.status) && (
                <>
                  {viewingDispute.status === 'open' && (
                    <Button variant="outline" onClick={() => handleUpdateStatus(viewingDispute.id, 'investigating')}>
                      Start Investigation
                    </Button>
                  )}
                  <Button variant="destructive" onClick={() => handleUpdateStatus(viewingDispute.id, 'rejected')}>
                    <XCircle className="h-4 w-4 mr-2" />
                    Reject
                  </Button>
                  <Button onClick={() => handleUpdateStatus(viewingDispute.id, 'resolved')}>
                    <CheckCircle2 className="h-4 w-4 mr-2" />
                    Resolve
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
