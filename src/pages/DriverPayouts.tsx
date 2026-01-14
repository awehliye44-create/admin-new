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
import { Checkbox } from '@/components/ui/checkbox';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { 
  Search, 
  Download, 
  DollarSign,
  TrendingUp,
  Eye,
  RefreshCw,
  Wallet,
  Clock,
  CheckCircle2,
  XCircle,
  User,
  Car,
  Calendar,
  Send,
  AlertCircle,
  Banknote
} from 'lucide-react';

interface DriverPayout {
  id: string;
  payout_id: string;
  driver_id: string;
  driver_name: string;
  driver_email: string;
  total_earnings: number;
  total_trips: number;
  deductions: number;
  net_payout: number;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'on_hold';
  payout_method: string;
  bank_account: string;
  period_start: string;
  period_end: string;
  processed_at: string | null;
  notes: string;
}

const defaultPayouts: DriverPayout[] = [
  {
    id: '1',
    payout_id: 'PAY-DRV-2024-001',
    driver_id: 'drv-001',
    driver_name: 'Mike Johnson',
    driver_email: 'mike@email.com',
    total_earnings: 1250.00,
    total_trips: 48,
    deductions: 62.50,
    net_payout: 1187.50,
    status: 'pending',
    payout_method: 'Bank Transfer',
    bank_account: '****4521',
    period_start: '2024-01-08T00:00:00Z',
    period_end: '2024-01-14T23:59:59Z',
    processed_at: null,
    notes: '',
  },
  {
    id: '2',
    payout_id: 'PAY-DRV-2024-002',
    driver_id: 'drv-002',
    driver_name: 'Alex Turner',
    driver_email: 'alex@email.com',
    total_earnings: 980.00,
    total_trips: 42,
    deductions: 49.00,
    net_payout: 931.00,
    status: 'pending',
    payout_method: 'Bank Transfer',
    bank_account: '****7832',
    period_start: '2024-01-08T00:00:00Z',
    period_end: '2024-01-14T23:59:59Z',
    processed_at: null,
    notes: '',
  },
  {
    id: '3',
    payout_id: 'PAY-DRV-2024-003',
    driver_id: 'drv-003',
    driver_name: 'James Wilson',
    driver_email: 'james@email.com',
    total_earnings: 1520.00,
    total_trips: 55,
    deductions: 76.00,
    net_payout: 1444.00,
    status: 'processing',
    payout_method: 'Bank Transfer',
    bank_account: '****9156',
    period_start: '2024-01-08T00:00:00Z',
    period_end: '2024-01-14T23:59:59Z',
    processed_at: null,
    notes: 'Processing initiated',
  },
  {
    id: '4',
    payout_id: 'PAY-DRV-2024-004',
    driver_id: 'drv-004',
    driver_name: 'Lisa Anderson',
    driver_email: 'lisa@email.com',
    total_earnings: 890.00,
    total_trips: 35,
    deductions: 44.50,
    net_payout: 845.50,
    status: 'completed',
    payout_method: 'Bank Transfer',
    bank_account: '****2847',
    period_start: '2024-01-01T00:00:00Z',
    period_end: '2024-01-07T23:59:59Z',
    processed_at: '2024-01-09T10:00:00Z',
    notes: 'Paid successfully',
  },
  {
    id: '5',
    payout_id: 'PAY-DRV-2024-005',
    driver_id: 'drv-005',
    driver_name: 'David Brown',
    driver_email: 'david@email.com',
    total_earnings: 450.00,
    total_trips: 18,
    deductions: 22.50,
    net_payout: 427.50,
    status: 'on_hold',
    payout_method: 'Bank Transfer',
    bank_account: '****6193',
    period_start: '2024-01-08T00:00:00Z',
    period_end: '2024-01-14T23:59:59Z',
    processed_at: null,
    notes: 'Pending document verification',
  },
];

export default function DriverPayouts() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState('pending');
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedPayouts, setSelectedPayouts] = useState<string[]>([]);
  const [viewingPayout, setViewingPayout] = useState<DriverPayout | null>(null);
  const [processingBatch, setProcessingBatch] = useState(false);

  const { data: payouts = [], isLoading } = useQuery({
    queryKey: ['driver-payouts'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('admin_settings')
        .select('*')
        .eq('setting_key', 'driver_payouts')
        .maybeSingle();
      
      if (error) throw error;
      return (data?.setting_value as unknown as DriverPayout[]) || defaultPayouts;
    },
  });

  const saveMutation = useMutation({
    mutationFn: async (newPayouts: DriverPayout[]) => {
      const { error } = await supabase
        .from('admin_settings')
        .upsert([{
          setting_key: 'driver_payouts',
          setting_value: JSON.parse(JSON.stringify(newPayouts)),
          description: 'Driver payouts data',
          updated_at: new Date().toISOString(),
        }], { onConflict: 'setting_key' });
      
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['driver-payouts'] });
    },
  });

  const handleProcessPayout = async (payout: DriverPayout) => {
    const updatedPayouts = payouts.map(p => 
      p.id === payout.id 
        ? { ...p, status: 'processing' as const, notes: 'Processing initiated' }
        : p
    );
    await saveMutation.mutateAsync(updatedPayouts);
    toast.success(`Payout ${payout.payout_id} is now processing`);
  };

  const handleCompletePayout = async (payout: DriverPayout) => {
    const updatedPayouts = payouts.map(p => 
      p.id === payout.id 
        ? { ...p, status: 'completed' as const, processed_at: new Date().toISOString(), notes: 'Paid successfully' }
        : p
    );
    await saveMutation.mutateAsync(updatedPayouts);
    toast.success(`Payout ${payout.payout_id} marked as completed`);
  };

  const handleProcessBatch = async () => {
    if (selectedPayouts.length === 0) {
      toast.error('Please select payouts to process');
      return;
    }

    setProcessingBatch(true);
    const updatedPayouts = payouts.map(p => 
      selectedPayouts.includes(p.id) && p.status === 'pending'
        ? { ...p, status: 'processing' as const, notes: 'Batch processing initiated' }
        : p
    );
    await saveMutation.mutateAsync(updatedPayouts);
    toast.success(`${selectedPayouts.length} payouts are now processing`);
    setSelectedPayouts([]);
    setProcessingBatch(false);
  };

  const getStatusBadge = (status: string) => {
    const config: Record<string, { variant: 'default' | 'secondary' | 'destructive' | 'outline', icon: React.ReactNode, className?: string }> = {
      pending: { variant: 'secondary', icon: <Clock className="h-3 w-3 mr-1" /> },
      processing: { variant: 'outline', icon: <RefreshCw className="h-3 w-3 mr-1 animate-spin" /> },
      completed: { variant: 'default', icon: <CheckCircle2 className="h-3 w-3 mr-1" />, className: 'bg-green-500' },
      failed: { variant: 'destructive', icon: <XCircle className="h-3 w-3 mr-1" /> },
      on_hold: { variant: 'outline', icon: <AlertCircle className="h-3 w-3 mr-1" />, className: 'border-amber-500 text-amber-500' },
    };
    const { variant, icon, className } = config[status] || { variant: 'outline', icon: null };
    return (
      <Badge variant={variant} className={`flex items-center w-fit ${className || ''}`}>
        {icon}
        {status.replace('_', ' ')}
      </Badge>
    );
  };

  const filteredPayouts = payouts.filter(payout => {
    const matchesSearch = payout.payout_id.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         payout.driver_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         payout.driver_email.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesTab = activeTab === 'all' || payout.status === activeTab;
    return matchesSearch && matchesTab;
  });

  const toggleSelectAll = () => {
    if (selectedPayouts.length === filteredPayouts.filter(p => p.status === 'pending').length) {
      setSelectedPayouts([]);
    } else {
      setSelectedPayouts(filteredPayouts.filter(p => p.status === 'pending').map(p => p.id));
    }
  };

  const toggleSelect = (id: string) => {
    setSelectedPayouts(prev => 
      prev.includes(id) ? prev.filter(p => p !== id) : [...prev, id]
    );
  };

  // Stats
  const pendingCount = payouts.filter(p => p.status === 'pending').length;
  const pendingAmount = payouts.filter(p => p.status === 'pending').reduce((sum, p) => sum + p.net_payout, 0);
  const processedThisWeek = payouts.filter(p => p.status === 'completed').reduce((sum, p) => sum + p.net_payout, 0);
  const totalDrivers = new Set(payouts.map(p => p.driver_id)).size;

  if (isLoading) {
    return (
      <AdminLayout title="Driver Payouts" description="Manage driver payouts">
        <div className="flex items-center justify-center h-64">
          <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout 
      title="Driver Payouts & Settlements" 
      description="Process and manage driver earnings payouts"
    >
      <div className="space-y-6">
        {/* Stats */}
        <div className="grid gap-4 md:grid-cols-4">
          <Card className="border-amber-500/50">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Pending Payouts</CardTitle>
              <Clock className="h-4 w-4 text-amber-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-amber-500">{pendingCount}</div>
              <p className="text-xs text-muted-foreground">${pendingAmount.toFixed(2)} total</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Pending Amount</CardTitle>
              <DollarSign className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">${pendingAmount.toFixed(2)}</div>
              <p className="text-xs text-muted-foreground">Ready to process</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Processed This Week</CardTitle>
              <Banknote className="h-4 w-4 text-green-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-500">${processedThisWeek.toFixed(2)}</div>
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <TrendingUp className="h-3 w-3 text-green-500" />
                Completed payouts
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Active Drivers</CardTitle>
              <User className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{totalDrivers}</div>
              <p className="text-xs text-muted-foreground">With pending payouts</p>
            </CardContent>
          </Card>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
          <div className="flex flex-col sm:flex-row justify-between gap-4">
            <TabsList>
              <TabsTrigger value="pending" className="flex items-center gap-1">
                Pending
                {pendingCount > 0 && (
                  <Badge variant="secondary" className="ml-1 h-5 w-5 rounded-full p-0 flex items-center justify-center text-xs">
                    {pendingCount}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="processing">Processing</TabsTrigger>
              <TabsTrigger value="completed">Completed</TabsTrigger>
              <TabsTrigger value="on_hold">On Hold</TabsTrigger>
              <TabsTrigger value="all">All</TabsTrigger>
            </TabsList>

            <div className="flex gap-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input 
                  placeholder="Search drivers..." 
                  className="pl-9 w-[200px]"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
              </div>
              {selectedPayouts.length > 0 && (
                <Button onClick={handleProcessBatch} disabled={processingBatch}>
                  <Send className="h-4 w-4 mr-2" />
                  Process Selected ({selectedPayouts.length})
                </Button>
              )}
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
                      {activeTab === 'pending' && (
                        <TableHead className="w-12">
                          <Checkbox
                            checked={selectedPayouts.length === filteredPayouts.filter(p => p.status === 'pending').length && filteredPayouts.filter(p => p.status === 'pending').length > 0}
                            onCheckedChange={toggleSelectAll}
                          />
                        </TableHead>
                      )}
                      <TableHead>Payout ID</TableHead>
                      <TableHead>Driver</TableHead>
                      <TableHead>Period</TableHead>
                      <TableHead className="text-right">Trips</TableHead>
                      <TableHead className="text-right">Earnings</TableHead>
                      <TableHead className="text-right">Net Payout</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredPayouts.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={activeTab === 'pending' ? 9 : 8} className="text-center py-8 text-muted-foreground">
                          No payouts found
                        </TableCell>
                      </TableRow>
                    ) : (
                      filteredPayouts.map((payout) => (
                        <TableRow key={payout.id}>
                          {activeTab === 'pending' && (
                            <TableCell>
                              <Checkbox
                                checked={selectedPayouts.includes(payout.id)}
                                onCheckedChange={() => toggleSelect(payout.id)}
                                disabled={payout.status !== 'pending'}
                              />
                            </TableCell>
                          )}
                          <TableCell className="font-mono text-sm">{payout.payout_id}</TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center">
                                <User className="h-4 w-4" />
                              </div>
                              <div>
                                <p className="font-medium">{payout.driver_name}</p>
                                <p className="text-xs text-muted-foreground">{payout.driver_email}</p>
                              </div>
                            </div>
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {new Date(payout.period_start).toLocaleDateString()} - {new Date(payout.period_end).toLocaleDateString()}
                          </TableCell>
                          <TableCell className="text-right">{payout.total_trips}</TableCell>
                          <TableCell className="text-right">${payout.total_earnings.toFixed(2)}</TableCell>
                          <TableCell className="text-right font-medium">${payout.net_payout.toFixed(2)}</TableCell>
                          <TableCell>{getStatusBadge(payout.status)}</TableCell>
                          <TableCell className="text-right">
                            <div className="flex items-center justify-end gap-1">
                              <Button 
                                variant="ghost" 
                                size="sm"
                                onClick={() => setViewingPayout(payout)}
                              >
                                <Eye className="h-4 w-4" />
                              </Button>
                              {payout.status === 'pending' && (
                                <Button 
                                  variant="ghost" 
                                  size="sm"
                                  onClick={() => handleProcessPayout(payout)}
                                >
                                  <Send className="h-4 w-4" />
                                </Button>
                              )}
                              {payout.status === 'processing' && (
                                <Button 
                                  variant="ghost" 
                                  size="sm"
                                  onClick={() => handleCompletePayout(payout)}
                                >
                                  <CheckCircle2 className="h-4 w-4" />
                                </Button>
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
          </TabsContent>
        </Tabs>

        {/* Payout Detail Dialog */}
        <Dialog open={!!viewingPayout} onOpenChange={() => setViewingPayout(null)}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Payout Details</DialogTitle>
              <DialogDescription>{viewingPayout?.payout_id}</DialogDescription>
            </DialogHeader>
            {viewingPayout && (
              <div className="space-y-4 py-4">
                <div className="flex items-center gap-3">
                  <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center">
                    <User className="h-6 w-6" />
                  </div>
                  <div>
                    <p className="font-medium">{viewingPayout.driver_name}</p>
                    <p className="text-sm text-muted-foreground">{viewingPayout.driver_email}</p>
                  </div>
                </div>

                <div className="grid gap-4 grid-cols-2">
                  <div>
                    <p className="text-sm text-muted-foreground">Status</p>
                    {getStatusBadge(viewingPayout.status)}
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Payment Method</p>
                    <p>{viewingPayout.payout_method}</p>
                  </div>
                </div>

                <div className="grid gap-4 grid-cols-2">
                  <div>
                    <p className="text-sm text-muted-foreground">Period</p>
                    <p className="text-sm">
                      {new Date(viewingPayout.period_start).toLocaleDateString()} - {new Date(viewingPayout.period_end).toLocaleDateString()}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Total Trips</p>
                    <p>{viewingPayout.total_trips}</p>
                  </div>
                </div>

                <div className="border rounded-lg p-4 space-y-2">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Gross Earnings</span>
                    <span>${viewingPayout.total_earnings.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between text-red-500">
                    <span>Deductions</span>
                    <span>-${viewingPayout.deductions.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between font-bold text-lg border-t pt-2">
                    <span>Net Payout</span>
                    <span>${viewingPayout.net_payout.toFixed(2)}</span>
                  </div>
                </div>

                <div>
                  <p className="text-sm text-muted-foreground">Bank Account</p>
                  <p className="font-mono">{viewingPayout.bank_account}</p>
                </div>

                {viewingPayout.notes && (
                  <div className="bg-muted p-3 rounded-md">
                    <p className="text-sm text-muted-foreground">Notes</p>
                    <p className="text-sm">{viewingPayout.notes}</p>
                  </div>
                )}

                {viewingPayout.processed_at && (
                  <div>
                    <p className="text-sm text-muted-foreground">Processed At</p>
                    <p className="text-sm">{new Date(viewingPayout.processed_at).toLocaleString()}</p>
                  </div>
                )}
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => setViewingPayout(null)}>
                Close
              </Button>
              {viewingPayout?.status === 'pending' && (
                <Button onClick={() => { handleProcessPayout(viewingPayout); setViewingPayout(null); }}>
                  <Send className="h-4 w-4 mr-2" />
                  Process Payout
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </AdminLayout>
  );
}
