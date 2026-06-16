import { useState } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { 
  Building2, 
  Search, 
  Edit, 
  Users, 
  CreditCard, 
  MapPin, 
  Phone, 
  Mail,
  DollarSign,
  Eye,
  MoreHorizontal,
  RefreshCw,
  Download,
  Loader2,
  Ban,
  PlayCircle,
  ShieldAlert,
  CheckCircle2
} from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { format } from 'date-fns';

export default function CorporateAccounts() {
  const queryClient = useQueryClient();
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [regionFilter, setRegionFilter] = useState<string>('all');
  const [serviceAreaFilter, setServiceAreaFilter] = useState<string>('all');
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<any>(null);
  const [viewingAccount, setViewingAccount] = useState<any>(null);
  const [confirmAction, setConfirmAction] = useState<{ type: 'suspend' | 'reactivate'; account: any } | null>(null);

  const defaultFormData = {
    company_name: '',
    contact_name: '',
    contact_email: '',
    contact_phone: '',
    billing_email: '',
    address: '',
    city: '',
    country: '',
    tax_id: '',
    payment_terms: 'net30',
    credit_limit: 10000,
    discount_percentage: 0,
    notes: '',
    employee_count: 10,
    monthly_budget: 1000,
    region_id: '',
    service_area_id: '',
    payment_cash_enabled: false,
    payment_card_enabled: true,
    payment_apple_pay_enabled: true,
    payment_google_pay_enabled: true,
    payment_invoice_enabled: false,
    payment_wallet_enabled: true,
  };

  const [formData, setFormData] = useState(defaultFormData);

  const { data: regions = [] } = useQuery({
    queryKey: ['regions'],
    queryFn: async () => {
      const { data, error } = await supabase.from('regions').select('*').order('name');
      if (error) throw error;
      return data;
    },
  });

  const { data: serviceAreas = [] } = useQuery({
    queryKey: ['service-areas'],
    queryFn: async () => {
      const { data, error } = await supabase.from('service_areas').select('*, region:regions(name)').order('name');
      if (error) throw error;
      return data;
    },
  });

  const filteredServiceAreas = serviceAreas.filter(
    (sa: any) => regionFilter === 'all' || sa.region_id === regionFilter
  );

  // Only fetch approved/active + suspended accounts (not pending — those are in Account Requests)
  const { data: accounts = [], isLoading } = useQuery({
    queryKey: ['corporate-accounts', regionFilter, serviceAreaFilter],
    queryFn: async () => {
      let query = supabase
        .from('corporate_accounts')
        .select('*, region:regions(name), service_area:service_areas(name)')
        .in('status', ['active', 'suspended'])
        .order('created_at', { ascending: false });
      if (regionFilter !== 'all') query = query.eq('region_id', regionFilter);
      if (serviceAreaFilter !== 'all') query = query.eq('service_area_id', serviceAreaFilter);
      const { data, error } = await query;
      if (error) throw error;
      return data;
    },
  });

  // Update mutation (edit)
  const saveMutation = useMutation({
    mutationFn: async (account: any) => {
      const { error } = await supabase
        .from('corporate_accounts')
        .update(account)
        .eq('id', editingAccount.id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['corporate-accounts'] });
      toast.success('Account updated successfully');
      setIsEditOpen(false);
      setEditingAccount(null);
    },
    onError: (error: Error) => toast.error(error.message || 'Failed to save'),
  });

  // Suspend
  const suspendMutation = useMutation({
    mutationFn: async (accountId: string) => {
      const { error } = await supabase.rpc('suspend_corporate_account', { p_account_id: accountId });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['corporate-accounts'] });
      toast.success('Account suspended');
      setConfirmAction(null);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // Reactivate
  const reactivateMutation = useMutation({
    mutationFn: async (accountId: string) => {
      const { error } = await supabase.rpc('reactivate_corporate_account', { p_account_id: accountId });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['corporate-accounts'] });
      toast.success('Account reactivated');
      setConfirmAction(null);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const handleEdit = (account: any) => {
    setEditingAccount(account);
    setFormData({
      company_name: account.company_name,
      contact_name: account.contact_name,
      contact_email: account.contact_email,
      contact_phone: account.contact_phone || '',
      billing_email: account.billing_email || '',
      address: account.address || '',
      city: account.city || '',
      country: account.country || '',
      tax_id: account.tax_id || '',
      payment_terms: account.payment_terms || 'net30',
      credit_limit: account.credit_limit || 10000,
      discount_percentage: account.discount_percentage || 0,
      notes: account.notes || '',
      employee_count: account.employee_count || 0,
      monthly_budget: account.monthly_budget || 0,
      region_id: account.region_id || '',
      service_area_id: account.service_area_id || '',
      payment_cash_enabled: account.payment_cash_enabled ?? false,
      payment_card_enabled: account.payment_card_enabled ?? true,
      payment_apple_pay_enabled: account.payment_apple_pay_enabled ?? true,
      payment_google_pay_enabled: account.payment_google_pay_enabled ?? true,
      payment_invoice_enabled: account.payment_invoice_enabled ?? false,
      payment_wallet_enabled: account.payment_wallet_enabled ?? true,
    });
    setIsEditOpen(true);
  };

  const handleSave = () => {
    saveMutation.mutate({
      company_name: formData.company_name,
      contact_name: formData.contact_name,
      contact_email: formData.contact_email,
      contact_phone: formData.contact_phone || null,
      billing_email: formData.billing_email || null,
      address: formData.address || null,
      city: formData.city || null,
      country: formData.country || null,
      tax_id: formData.tax_id || null,
      payment_terms: formData.payment_terms,
      credit_limit: formData.credit_limit,
      discount_percentage: formData.discount_percentage,
      notes: formData.notes || null,
      employee_count: formData.employee_count,
      monthly_budget: formData.monthly_budget,
      region_id: formData.region_id || null,
      service_area_id: formData.service_area_id || null,
      payment_cash_enabled: formData.payment_cash_enabled,
      payment_card_enabled: formData.payment_card_enabled,
      payment_apple_pay_enabled: formData.payment_apple_pay_enabled,
      payment_google_pay_enabled: formData.payment_google_pay_enabled,
      payment_invoice_enabled: formData.payment_invoice_enabled,
      payment_wallet_enabled: formData.payment_wallet_enabled,
    });
  };

  const filteredAccounts = accounts.filter((account: any) => {
    const matchesSearch = account.company_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         account.contact_email.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         (account.contact_name || '').toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = statusFilter === 'all' || account.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const getStatusBadge = (status: string) => {
    if (status === 'active') {
      return <Badge variant="default" className="flex items-center w-fit"><CheckCircle2 className="h-3 w-3 mr-1" />Active</Badge>;
    }
    if (status === 'suspended') {
      return <Badge variant="outline" className="flex items-center w-fit border-orange-500 text-orange-500"><ShieldAlert className="h-3 w-3 mr-1" />Suspended</Badge>;
    }
    return <Badge variant="outline" className="capitalize">{status}</Badge>;
  };

  const activeAccounts = accounts.filter((a: any) => a.status === 'active').length;
  const suspendedAccounts = accounts.filter((a: any) => a.status === 'suspended').length;
  const totalBalance = accounts.reduce((sum: number, a: any) => sum + (a.current_balance || 0), 0);
  const totalCreditLimit = accounts.reduce((sum: number, a: any) => sum + (a.credit_limit || 0), 0);

  return (
    <AdminLayout title="Corporate Accounts" description="Manage approved corporate client accounts">
      <div className="space-y-6">
        {/* Stats */}
        <div className="grid gap-4 md:grid-cols-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Active Accounts</CardTitle>
              <CheckCircle2 className="h-4 w-4 text-green-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-500">{activeAccounts}</div>
              <p className="text-xs text-muted-foreground">Full portal access</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Suspended</CardTitle>
              <ShieldAlert className="h-4 w-4 text-orange-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-orange-500">{suspendedAccounts}</div>
              <p className="text-xs text-muted-foreground">Access restricted</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Balance</CardTitle>
              <DollarSign className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">£{totalBalance.toLocaleString()}</div>
              <p className="text-xs text-muted-foreground">Outstanding</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Credit Limit</CardTitle>
              <CreditCard className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">£{totalCreditLimit.toLocaleString()}</div>
              <p className="text-xs text-muted-foreground">Total available</p>
            </CardContent>
          </Card>
        </div>

        {/* Toolbar */}
        <div className="flex flex-col gap-4">
          <div className="flex flex-col sm:flex-row gap-2 flex-wrap">
            <div className="relative flex-1 max-w-md">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input 
                placeholder="Search accounts..." 
                className="pl-9"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>
            <Select value={regionFilter} onValueChange={(v) => { setRegionFilter(v); setServiceAreaFilter('all'); }}>
              <SelectTrigger className="w-[160px]">
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
                <SelectValue placeholder="All Service Areas" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Service Areas</SelectItem>
                {filteredServiceAreas.map((sa: any) => (
                  <SelectItem key={sa.id} value={sa.id}>{sa.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-[130px]">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="suspended">Suspended</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex gap-2 justify-end">
            <Button variant="outline">
              <Download className="h-4 w-4 mr-2" />
              Export
            </Button>
          </div>
        </div>

        {/* Table */}
        <Card>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="flex items-center justify-center h-64">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : filteredAccounts.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
                <Building2 className="h-12 w-12 mb-4" />
                <p>No corporate accounts found</p>
                <p className="text-sm">Approved accounts from Account Requests appear here</p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Company</TableHead>
                    <TableHead>Contact</TableHead>
                    <TableHead>Region</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Credit Limit</TableHead>
                    <TableHead>Balance</TableHead>
                    <TableHead>Employees</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredAccounts.map((account: any) => (
                    <TableRow key={account.id}>
                      <TableCell>
                        <div className="font-medium">{account.company_name}</div>
                        <div className="text-xs text-muted-foreground">{[account.city, account.country].filter(Boolean).join(', ')}</div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <Mail className="h-3 w-3 text-muted-foreground" />
                          <span className="text-sm">{account.contact_email}</span>
                        </div>
                        {account.contact_phone && (
                          <div className="flex items-center gap-1 text-muted-foreground">
                            <Phone className="h-3 w-3" />
                            <span className="text-xs">{account.contact_phone}</span>
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <MapPin className="h-3 w-3 text-muted-foreground" />
                          <span className="text-sm">{account.region?.name || '—'}</span>
                        </div>
                        <div className="text-xs text-muted-foreground">{account.service_area?.name || '—'}</div>
                      </TableCell>
                      <TableCell>{getStatusBadge(account.status)}</TableCell>
                      <TableCell>£{(account.credit_limit || 0).toLocaleString()}</TableCell>
                      <TableCell>£{(account.current_balance || 0).toLocaleString()}</TableCell>
                      <TableCell>{account.employee_count || 0}</TableCell>
                      <TableCell className="text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => setViewingAccount(account)}>
                              <Eye className="h-4 w-4 mr-2" />
                              View Details
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handleEdit(account)}>
                              <Edit className="h-4 w-4 mr-2" />
                              Edit
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            {account.status === 'active' ? (
                              <DropdownMenuItem 
                                className="text-orange-500"
                                onClick={() => setConfirmAction({ type: 'suspend', account })}
                              >
                                <Ban className="h-4 w-4 mr-2" />
                                Suspend
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem 
                                className="text-green-500"
                                onClick={() => setConfirmAction({ type: 'reactivate', account })}
                              >
                                <PlayCircle className="h-4 w-4 mr-2" />
                                Reactivate
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

        {/* View Details Dialog */}
        <Dialog open={!!viewingAccount} onOpenChange={() => setViewingAccount(null)}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>{viewingAccount?.company_name}</DialogTitle>
              <DialogDescription>Corporate Account Details</DialogDescription>
            </DialogHeader>
            {viewingAccount && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label className="text-muted-foreground">Status</Label>
                    <div className="mt-1">{getStatusBadge(viewingAccount.status)}</div>
                  </div>
                  <div>
                    <Label className="text-muted-foreground">Payment Terms</Label>
                    <p className="font-medium">{viewingAccount.payment_terms}</p>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label className="text-muted-foreground">Credit Limit</Label>
                    <p className="font-medium">£{(viewingAccount.credit_limit || 0).toLocaleString()}</p>
                  </div>
                  <div>
                    <Label className="text-muted-foreground">Current Balance</Label>
                    <p className="font-medium">£{(viewingAccount.current_balance || 0).toLocaleString()}</p>
                  </div>
                </div>
                <div>
                  <Label className="text-muted-foreground">Contact</Label>
                  <p className="font-medium">{viewingAccount.contact_name}</p>
                  <p className="text-sm text-muted-foreground">{viewingAccount.contact_email}</p>
                  {viewingAccount.contact_phone && <p className="text-sm text-muted-foreground">{viewingAccount.contact_phone}</p>}
                </div>
                <div>
                  <Label className="text-muted-foreground">Location</Label>
                  <p className="text-sm">{viewingAccount.address}</p>
                  <p className="text-sm">{[viewingAccount.city, viewingAccount.country].filter(Boolean).join(', ')}</p>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label className="text-muted-foreground">Region</Label>
                    <p className="font-medium">{viewingAccount.region?.name || '—'}</p>
                  </div>
                  <div>
                    <Label className="text-muted-foreground">Service Area</Label>
                    <p className="font-medium">{viewingAccount.service_area?.name || '—'}</p>
                  </div>
                </div>
                <div>
                  <Label className="text-muted-foreground">Created</Label>
                  <p className="text-sm">{format(new Date(viewingAccount.created_at), 'PPP')}</p>
                </div>
              </div>
            )}
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => setViewingAccount(null)}>Close</Button>
              <Button onClick={() => { handleEdit(viewingAccount); setViewingAccount(null); }}>
                <Edit className="h-4 w-4 mr-2" />
                Edit
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Edit Dialog */}
        <Dialog open={isEditOpen} onOpenChange={(open) => { setIsEditOpen(open); if (!open) setEditingAccount(null); }}>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Edit Corporate Account</DialogTitle>
              <DialogDescription>Update the corporate account details.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>Company Name *</Label>
                  <Input value={formData.company_name} onChange={(e) => setFormData({ ...formData, company_name: e.target.value })} />
                </div>
                <div className="space-y-2">
                  <Label>Tax ID</Label>
                  <Input value={formData.tax_id} onChange={(e) => setFormData({ ...formData, tax_id: e.target.value })} />
                </div>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>Region</Label>
                  <Select value={formData.region_id} onValueChange={(v) => setFormData({ ...formData, region_id: v, service_area_id: '' })}>
                    <SelectTrigger><SelectValue placeholder="Select region" /></SelectTrigger>
                    <SelectContent>
                      {regions.map((r: any) => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Service Area</Label>
                  <Select value={formData.service_area_id} onValueChange={(v) => setFormData({ ...formData, service_area_id: v })}>
                    <SelectTrigger><SelectValue placeholder="Select service area" /></SelectTrigger>
                    <SelectContent>
                      {serviceAreas.filter((sa: any) => !formData.region_id || sa.region_id === formData.region_id).map((sa: any) => (
                        <SelectItem key={sa.id} value={sa.id}>{sa.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>Contact Name *</Label>
                  <Input value={formData.contact_name} onChange={(e) => setFormData({ ...formData, contact_name: e.target.value })} />
                </div>
                <div className="space-y-2">
                  <Label>Contact Phone</Label>
                  <Input value={formData.contact_phone} onChange={(e) => setFormData({ ...formData, contact_phone: e.target.value })} />
                </div>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>Contact Email *</Label>
                  <Input type="email" value={formData.contact_email} onChange={(e) => setFormData({ ...formData, contact_email: e.target.value })} />
                </div>
                <div className="space-y-2">
                  <Label>Billing Email</Label>
                  <Input type="email" value={formData.billing_email} onChange={(e) => setFormData({ ...formData, billing_email: e.target.value })} />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Address</Label>
                <Input value={formData.address} onChange={(e) => setFormData({ ...formData, address: e.target.value })} />
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>City</Label>
                  <Input value={formData.city} onChange={(e) => setFormData({ ...formData, city: e.target.value })} />
                </div>
                <div className="space-y-2">
                  <Label>Country</Label>
                  <Input value={formData.country} onChange={(e) => setFormData({ ...formData, country: e.target.value })} />
                </div>
              </div>
              <div className="grid gap-4 md:grid-cols-3">
                <div className="space-y-2">
                  <Label>Payment Terms</Label>
                  <Select value={formData.payment_terms} onValueChange={(v) => setFormData({ ...formData, payment_terms: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="prepaid">Prepaid</SelectItem>
                      <SelectItem value="net7">Net 7</SelectItem>
                      <SelectItem value="net15">Net 15</SelectItem>
                      <SelectItem value="net30">Net 30</SelectItem>
                      <SelectItem value="net45">Net 45</SelectItem>
                      <SelectItem value="net60">Net 60</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Credit Limit (£)</Label>
                  <Input type="number" min="0" value={formData.credit_limit} onChange={(e) => setFormData({ ...formData, credit_limit: parseFloat(e.target.value) || 0 })} />
                </div>
                <div className="space-y-2">
                  <Label>Discount (%)</Label>
                  <Input type="number" min="0" max="100" value={formData.discount_percentage} onChange={(e) => setFormData({ ...formData, discount_percentage: parseFloat(e.target.value) || 0 })} />
                </div>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>Employee Count</Label>
                  <Input type="number" min="1" value={formData.employee_count} onChange={(e) => setFormData({ ...formData, employee_count: parseInt(e.target.value) || 0 })} />
                </div>
                <div className="space-y-2">
                  <Label>Monthly Budget (£)</Label>
                  <Input type="number" min="0" value={formData.monthly_budget} onChange={(e) => setFormData({ ...formData, monthly_budget: parseFloat(e.target.value) || 0 })} />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Notes</Label>
                <Textarea value={formData.notes} onChange={(e) => setFormData({ ...formData, notes: e.target.value })} rows={3} />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setIsEditOpen(false)}>Cancel</Button>
              <Button onClick={handleSave} disabled={saveMutation.isPending}>
                {saveMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Update Account
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Confirm Suspend/Reactivate */}
        <Dialog open={!!confirmAction} onOpenChange={() => setConfirmAction(null)}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>
                {confirmAction?.type === 'suspend' ? 'Suspend Account' : 'Reactivate Account'}
              </DialogTitle>
              <DialogDescription>
                {confirmAction?.type === 'suspend'
                  ? `This will suspend "${confirmAction?.account?.company_name}" and restrict their portal access.`
                  : `This will reactivate "${confirmAction?.account?.company_name}" and restore full portal access.`}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => setConfirmAction(null)}>Cancel</Button>
              <Button
                variant={confirmAction?.type === 'suspend' ? 'destructive' : 'default'}
                onClick={() => {
                  if (confirmAction?.type === 'suspend') {
                    suspendMutation.mutate(confirmAction.account.id);
                  } else {
                    reactivateMutation.mutate(confirmAction!.account.id);
                  }
                }}
                disabled={suspendMutation.isPending || reactivateMutation.isPending}
              >
                {confirmAction?.type === 'suspend' ? (
                  <><Ban className="h-4 w-4 mr-2" /> Confirm Suspend</>
                ) : (
                  <><PlayCircle className="h-4 w-4 mr-2" /> Confirm Reactivate</>
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </AdminLayout>
  );
}
