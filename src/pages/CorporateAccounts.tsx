import { useState } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { 
  Building2, 
  Plus, 
  Search, 
  Edit, 
  Trash2, 
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
  Loader2
} from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { format } from 'date-fns';

export default function CorporateAccounts() {
  const queryClient = useQueryClient();
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [regionFilter, setRegionFilter] = useState<string>('all');
  const [serviceAreaFilter, setServiceAreaFilter] = useState<string>('all');
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<any>(null);
  const [viewingAccount, setViewingAccount] = useState<any>(null);

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
    status: 'pending',
    payment_terms: 'net30',
    credit_limit: 10000,
    discount_percentage: 0,
    notes: '',
    employee_count: 10,
    monthly_budget: 1000,
    region_id: '',
    service_area_id: '',
  };

  const [formData, setFormData] = useState(defaultFormData);

  // Fetch corporate settings to apply defaults
  const { data: corporateSettings } = useQuery({
    queryKey: ['corporate-settings-config'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('admin_settings')
        .select('setting_value')
        .eq('setting_key', 'corporate_settings_config')
        .maybeSingle();
      
      if (error) throw error;
      return data?.setting_value as any;
    },
  });

  // Apply corporate settings defaults when creating new account
  const getDefaultsFromSettings = () => {
    if (corporateSettings) {
      return {
        ...defaultFormData,
        payment_terms: corporateSettings.billing?.default_payment_terms || 'net30',
        credit_limit: corporateSettings.limits?.default_credit_limit || 10000,
        monthly_budget: corporateSettings.limits?.default_monthly_budget || 5000,
      };
    }
    return defaultFormData;
  };

  // Fetch regions
  const { data: regions = [] } = useQuery({
    queryKey: ['regions'],
    queryFn: async () => {
      const { data, error } = await supabase.from('regions').select('*').order('name');
      if (error) throw error;
      return data;
    },
  });

  // Fetch service areas
  const { data: serviceAreas = [] } = useQuery({
    queryKey: ['service-areas'],
    queryFn: async () => {
      const { data, error } = await supabase.from('service_areas').select('*, region:regions(name)').order('name');
      if (error) throw error;
      return data;
    },
  });

  // Filter service areas by selected region
  const filteredServiceAreas = serviceAreas.filter(
    (sa: any) => regionFilter === 'all' || sa.region_id === regionFilter
  );

  // Fetch accounts from database
  const { data: accounts = [], isLoading } = useQuery({
    queryKey: ['corporate-accounts', regionFilter, serviceAreaFilter],
    queryFn: async () => {
      let query = supabase
        .from('corporate_accounts')
        .select('*, region:regions(name), service_area:service_areas(name)')
        .order('created_at', { ascending: false });
      
      if (regionFilter !== 'all') {
        query = query.eq('region_id', regionFilter);
      }
      if (serviceAreaFilter !== 'all') {
        query = query.eq('service_area_id', serviceAreaFilter);
      }
      
      const { data, error } = await query;
      if (error) throw error;
      return data;
    },
  });

  // Create/Update mutation
  const saveMutation = useMutation({
    mutationFn: async (account: any) => {
      if (editingAccount) {
        const { error } = await supabase
          .from('corporate_accounts')
          .update(account)
          .eq('id', editingAccount.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('corporate_accounts')
          .insert([account]);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['corporate-accounts'] });
      toast.success(editingAccount ? 'Account updated successfully' : 'Account created successfully');
      setIsDialogOpen(false);
      resetForm();
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to save account');
    },
  });

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('corporate_accounts').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['corporate-accounts'] });
      toast.success('Account deleted successfully');
    },
  });

  const handleSave = async () => {
    const accountData = {
      company_name: formData.company_name,
      contact_name: formData.contact_name,
      contact_email: formData.contact_email,
      contact_phone: formData.contact_phone || null,
      billing_email: formData.billing_email || null,
      address: formData.address || null,
      city: formData.city || null,
      country: formData.country || null,
      tax_id: formData.tax_id || null,
      status: formData.status,
      payment_terms: formData.payment_terms,
      credit_limit: formData.credit_limit,
      discount_percentage: formData.discount_percentage,
      notes: formData.notes || null,
      employee_count: formData.employee_count,
      monthly_budget: formData.monthly_budget,
      region_id: formData.region_id || null,
      service_area_id: formData.service_area_id || null,
    };

    saveMutation.mutate(accountData);
  };

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
      status: account.status,
      payment_terms: account.payment_terms || 'net30',
      credit_limit: account.credit_limit || 10000,
      discount_percentage: account.discount_percentage || 0,
      notes: account.notes || '',
      employee_count: account.employee_count || 0,
      monthly_budget: account.monthly_budget || 0,
      region_id: account.region_id || '',
      service_area_id: account.service_area_id || '',
    });
    setIsDialogOpen(true);
  };

  const resetForm = () => {
    setEditingAccount(null);
    setFormData(getDefaultsFromSettings());
  };

  const filteredAccounts = accounts.filter((account: any) => {
    const matchesSearch = account.company_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         account.contact_email.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = statusFilter === 'all' || account.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const getStatusBadge = (status: string) => {
    const variants: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
      active: 'default',
      pending: 'secondary',
      suspended: 'destructive',
      inactive: 'outline',
    };
    return <Badge variant={variants[status] || 'outline'}>{status}</Badge>;
  };

  const totalAccounts = accounts.length;
  const activeAccounts = accounts.filter((a: any) => a.status === 'active').length;
  const totalBalance = accounts.reduce((sum: number, a: any) => sum + (a.current_balance || 0), 0);
  const totalCreditLimit = accounts.reduce((sum: number, a: any) => sum + (a.credit_limit || 0), 0);

  return (
    <AdminLayout 
      title="Corporate Accounts" 
      description="Manage corporate client accounts and billing"
    >
      <div className="space-y-6">
        {/* Stats */}
        <div className="grid gap-4 md:grid-cols-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Accounts</CardTitle>
              <Building2 className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{totalAccounts}</div>
              <p className="text-xs text-muted-foreground">{activeAccounts} active</p>
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
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Employees</CardTitle>
              <Users className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{accounts.reduce((sum: number, a: any) => sum + (a.employee_count || 0), 0)}</div>
              <p className="text-xs text-muted-foreground">Total riders</p>
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
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="suspended">Suspended</SelectItem>
                <SelectItem value="inactive">Inactive</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex gap-2 justify-end">
            <Button variant="outline">
              <Download className="h-4 w-4 mr-2" />
              Export
            </Button>
            <Dialog open={isDialogOpen} onOpenChange={(open) => { setIsDialogOpen(open); if (!open) resetForm(); }}>
              <DialogTrigger asChild>
                <Button onClick={() => setFormData(getDefaultsFromSettings())}>
                  <Plus className="h-4 w-4 mr-2" />
                  Add Account
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>{editingAccount ? 'Edit Account' : 'Add Corporate Account'}</DialogTitle>
                  <DialogDescription>
                    {editingAccount ? 'Update the corporate account details.' : 'Create a new corporate client account.'}
                  </DialogDescription>
                </DialogHeader>
                <div className="grid gap-4 py-4">
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="company_name">Company Name *</Label>
                      <Input
                        id="company_name"
                        value={formData.company_name}
                        onChange={(e) => setFormData({ ...formData, company_name: e.target.value })}
                        placeholder="Company Name"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="tax_id">Tax ID</Label>
                      <Input
                        id="tax_id"
                        value={formData.tax_id}
                        onChange={(e) => setFormData({ ...formData, tax_id: e.target.value })}
                        placeholder="Tax ID"
                      />
                    </div>
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <Label>Region</Label>
                      <Select value={formData.region_id} onValueChange={(v) => setFormData({ ...formData, region_id: v, service_area_id: '' })}>
                        <SelectTrigger>
                          <SelectValue placeholder="Select region" />
                        </SelectTrigger>
                        <SelectContent>
                          {regions.map((region: any) => (
                            <SelectItem key={region.id} value={region.id}>{region.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label>Service Area</Label>
                      <Select value={formData.service_area_id} onValueChange={(v) => setFormData({ ...formData, service_area_id: v })}>
                        <SelectTrigger>
                          <SelectValue placeholder="Select service area" />
                        </SelectTrigger>
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
                      <Label htmlFor="contact_name">Contact Name *</Label>
                      <Input
                        id="contact_name"
                        value={formData.contact_name}
                        onChange={(e) => setFormData({ ...formData, contact_name: e.target.value })}
                        placeholder="Contact Name"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="contact_phone">Contact Phone</Label>
                      <Input
                        id="contact_phone"
                        value={formData.contact_phone}
                        onChange={(e) => setFormData({ ...formData, contact_phone: e.target.value })}
                        placeholder="+44 20 1234 5678"
                      />
                    </div>
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="contact_email">Contact Email *</Label>
                      <Input
                        id="contact_email"
                        type="email"
                        value={formData.contact_email}
                        onChange={(e) => setFormData({ ...formData, contact_email: e.target.value })}
                        placeholder="contact@company.com"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="billing_email">Billing Email</Label>
                      <Input
                        id="billing_email"
                        type="email"
                        value={formData.billing_email}
                        onChange={(e) => setFormData({ ...formData, billing_email: e.target.value })}
                        placeholder="billing@company.com"
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="address">Address</Label>
                    <Input
                      id="address"
                      value={formData.address}
                      onChange={(e) => setFormData({ ...formData, address: e.target.value })}
                      placeholder="Street Address"
                    />
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="city">City</Label>
                      <Input
                        id="city"
                        value={formData.city}
                        onChange={(e) => setFormData({ ...formData, city: e.target.value })}
                        placeholder="City"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="country">Country</Label>
                      <Input
                        id="country"
                        value={formData.country}
                        onChange={(e) => setFormData({ ...formData, country: e.target.value })}
                        placeholder="Country"
                      />
                    </div>
                  </div>

                  <div className="grid gap-4 md:grid-cols-3">
                    <div className="space-y-2">
                      <Label htmlFor="status">Status</Label>
                      <Select value={formData.status} onValueChange={(value) => setFormData({ ...formData, status: value })}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="active">Active</SelectItem>
                          <SelectItem value="pending">Pending</SelectItem>
                          <SelectItem value="suspended">Suspended</SelectItem>
                          <SelectItem value="inactive">Inactive</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="payment_terms">Payment Terms</Label>
                      <Select value={formData.payment_terms} onValueChange={(value) => setFormData({ ...formData, payment_terms: value })}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
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
                      <Label htmlFor="credit_limit">Credit Limit (£)</Label>
                      <Input
                        id="credit_limit"
                        type="number"
                        min="0"
                        value={formData.credit_limit}
                        onChange={(e) => setFormData({ ...formData, credit_limit: parseFloat(e.target.value) || 0 })}
                      />
                    </div>
                  </div>

                  <div className="grid gap-4 md:grid-cols-3">
                    <div className="space-y-2">
                      <Label htmlFor="discount_percentage">Discount (%)</Label>
                      <Input
                        id="discount_percentage"
                        type="number"
                        min="0"
                        max="100"
                        value={formData.discount_percentage}
                        onChange={(e) => setFormData({ ...formData, discount_percentage: parseFloat(e.target.value) || 0 })}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="employee_count">Employee Count</Label>
                      <Input
                        id="employee_count"
                        type="number"
                        min="1"
                        value={formData.employee_count}
                        onChange={(e) => setFormData({ ...formData, employee_count: parseInt(e.target.value) || 0 })}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="monthly_budget">Monthly Budget (£)</Label>
                      <Input
                        id="monthly_budget"
                        type="number"
                        min="0"
                        value={formData.monthly_budget}
                        onChange={(e) => setFormData({ ...formData, monthly_budget: parseFloat(e.target.value) || 0 })}
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="notes">Notes</Label>
                    <Textarea
                      id="notes"
                      value={formData.notes}
                      onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                      placeholder="Additional notes..."
                      rows={3}
                    />
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setIsDialogOpen(false)}>Cancel</Button>
                  <Button onClick={handleSave} disabled={saveMutation.isPending}>
                    {saveMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                    {editingAccount ? 'Update Account' : 'Create Account'}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
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
                <p className="text-sm">Create your first account to get started</p>
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
                        <div className="text-xs text-muted-foreground">{account.city}, {account.country}</div>
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
                            <DropdownMenuItem 
                              className="text-destructive" 
                              onClick={() => { if (confirm('Delete this account?')) deleteMutation.mutate(account.id); }}
                            >
                              <Trash2 className="h-4 w-4 mr-2" />
                              Delete
                            </DropdownMenuItem>
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
                  <p className="text-sm">{viewingAccount.city}, {viewingAccount.country}</p>
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
            <DialogFooter>
              <Button variant="outline" onClick={() => setViewingAccount(null)}>Close</Button>
              <Button onClick={() => { handleEdit(viewingAccount); setViewingAccount(null); }}>
                <Edit className="h-4 w-4 mr-2" />
                Edit
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </AdminLayout>
  );
}
