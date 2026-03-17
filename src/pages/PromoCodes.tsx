import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { supabase } from '@/integrations/supabase/client';
import { 
  Ticket, Loader2, Plus, Search, RefreshCw, MoreHorizontal, Pencil, 
  Trash2, Eye, Copy, CheckCircle2, XCircle, Clock, Percent, DollarSign,
  Calendar, Users, TrendingUp
} from 'lucide-react';
import { format, isPast, isFuture, isWithinInterval } from 'date-fns';
import { toast } from 'sonner';

interface PromoCode {
  id: string;
  code: string;
  description: string | null;
  discount_type: string;
  discount_value: number;
  min_fare: number | null;
  max_discount: number | null;
  usage_limit: number | null;
  usage_count: number;
  per_user_limit: number | null;
  valid_from: string;
  valid_until: string | null;
  is_active: boolean;
  created_at: string;
}

export default function PromoCodes() {
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  // Dialog states
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isViewOpen, setIsViewOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [selectedPromo, setSelectedPromo] = useState<PromoCode | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Form state
  const [formData, setFormData] = useState({
    code: '',
    description: '',
    discount_type: 'percentage',
    discount_value: '',
    min_fare: '',
    max_discount: '',
    usage_limit: '',
    per_user_limit: '1',
    valid_from: '',
    valid_until: '',
    is_active: true,
  });

  const { data: promoCodes = [], isLoading } = useQuery({
    queryKey: ['promo-codes'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('promo_codes')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) throw error;
      return (data || []) as PromoCode[];
    },
    staleTime: 30_000,
  });

  const refreshData = () => queryClient.invalidateQueries({ queryKey: ['promo-codes'] });

  const resetForm = () => {
    setFormData({
      code: '',
      description: '',
      discount_type: 'percentage',
      discount_value: '',
      min_fare: '',
      max_discount: '',
      usage_limit: '',
      per_user_limit: '1',
      valid_from: format(new Date(), "yyyy-MM-dd'T'HH:mm"),
      valid_until: '',
      is_active: true,
    });
    setSelectedPromo(null);
  };

  const generateCode = () => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 8; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    setFormData(prev => ({ ...prev, code }));
  };

  const openCreateDialog = () => {
    resetForm();
    setFormData(prev => ({
      ...prev,
      valid_from: format(new Date(), "yyyy-MM-dd'T'HH:mm"),
    }));
    setIsFormOpen(true);
  };

  const openEditDialog = (promo: PromoCode) => {
    setSelectedPromo(promo);
    setFormData({
      code: promo.code,
      description: promo.description || '',
      discount_type: promo.discount_type,
      discount_value: promo.discount_value.toString(),
      min_fare: promo.min_fare?.toString() || '',
      max_discount: promo.max_discount?.toString() || '',
      usage_limit: promo.usage_limit?.toString() || '',
      per_user_limit: promo.per_user_limit?.toString() || '1',
      valid_from: format(new Date(promo.valid_from), "yyyy-MM-dd'T'HH:mm"),
      valid_until: promo.valid_until ? format(new Date(promo.valid_until), "yyyy-MM-dd'T'HH:mm") : '',
      is_active: promo.is_active,
    });
    setIsFormOpen(true);
  };

  const handleSave = async () => {
    if (!formData.code.trim()) {
      toast.error('Please enter a promo code');
      return;
    }
    if (!formData.discount_value || parseFloat(formData.discount_value) <= 0) {
      toast.error('Please enter a valid discount value');
      return;
    }

    setIsSaving(true);
    try {
      const promoData = {
        code: formData.code.toUpperCase().trim(),
        description: formData.description.trim() || null,
        discount_type: formData.discount_type,
        discount_value: parseFloat(formData.discount_value),
        min_fare: formData.min_fare ? parseFloat(formData.min_fare) : 0,
        max_discount: formData.max_discount ? parseFloat(formData.max_discount) : null,
        usage_limit: formData.usage_limit ? parseInt(formData.usage_limit) : null,
        per_user_limit: formData.per_user_limit ? parseInt(formData.per_user_limit) : 1,
        valid_from: new Date(formData.valid_from).toISOString(),
        valid_until: formData.valid_until ? new Date(formData.valid_until).toISOString() : null,
        is_active: formData.is_active,
      };

      if (selectedPromo) {
        const { error } = await supabase
          .from('promo_codes')
          .update(promoData)
          .eq('id', selectedPromo.id);

        if (error) throw error;
        toast.success('Promo code updated successfully');
      } else {
        const { error } = await supabase
          .from('promo_codes')
          .insert([promoData]);

        if (error) throw error;
        toast.success('Promo code created successfully');
      }

      setIsFormOpen(false);
      resetForm();
      refreshData();
    } catch (err: any) {
      console.error('Error saving promo code:', err);
      if (err.message?.includes('duplicate')) {
        toast.error('This promo code already exists');
      } else {
        toast.error(err.message || 'Failed to save promo code');
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedPromo) return;

    setIsSaving(true);
    try {
      const { error } = await supabase
        .from('promo_codes')
        .delete()
        .eq('id', selectedPromo.id);

      if (error) throw error;

      toast.success('Promo code deleted successfully');
      setIsDeleteOpen(false);
      setSelectedPromo(null);
      fetchPromoCodes();
    } catch (err: any) {
      console.error('Error deleting promo code:', err);
      toast.error(err.message || 'Failed to delete promo code');
    } finally {
      setIsSaving(false);
    }
  };

  const copyCode = (code: string) => {
    navigator.clipboard.writeText(code);
    toast.success('Code copied to clipboard');
  };

  const getPromoStatus = (promo: PromoCode) => {
    if (!promo.is_active) {
      return { label: 'Inactive', color: 'bg-gray-100 text-gray-700', icon: XCircle };
    }
    
    const now = new Date();
    const validFrom = new Date(promo.valid_from);
    const validUntil = promo.valid_until ? new Date(promo.valid_until) : null;

    if (isFuture(validFrom)) {
      return { label: 'Scheduled', color: 'bg-blue-100 text-blue-700', icon: Clock };
    }
    
    if (validUntil && isPast(validUntil)) {
      return { label: 'Expired', color: 'bg-red-100 text-red-700', icon: XCircle };
    }

    if (promo.usage_limit && promo.usage_count >= promo.usage_limit) {
      return { label: 'Exhausted', color: 'bg-orange-100 text-orange-700', icon: XCircle };
    }

    return { label: 'Active', color: 'bg-green-100 text-green-700', icon: CheckCircle2 };
  };

  const filteredPromoCodes = promoCodes.filter(promo => {
    const matchesSearch = 
      promo.code.toLowerCase().includes(searchQuery.toLowerCase()) ||
      promo.description?.toLowerCase().includes(searchQuery.toLowerCase());
    
    if (statusFilter === 'all') return matchesSearch;
    
    const status = getPromoStatus(promo);
    return matchesSearch && status.label.toLowerCase() === statusFilter;
  });

  const activeCount = promoCodes.filter(p => getPromoStatus(p).label === 'Active').length;
  const totalUsage = promoCodes.reduce((sum, p) => sum + p.usage_count, 0);

  return (
    <AdminLayout 
      title="Promo Codes" 
      description="Create and manage promotional discounts"
    >
      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Total Codes</p>
                <p className="text-2xl font-bold">{promoCodes.length}</p>
              </div>
              <Ticket className="h-8 w-8 text-primary opacity-80" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-green-500/30 bg-green-500/5">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Active</p>
                <p className="text-2xl font-bold text-green-600">{activeCount}</p>
              </div>
              <CheckCircle2 className="h-8 w-8 text-green-500" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-purple-500/30 bg-purple-500/5">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Total Redemptions</p>
                <p className="text-2xl font-bold text-purple-600">{totalUsage}</p>
              </div>
              <TrendingUp className="h-8 w-8 text-purple-500" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-amber-500/30 bg-amber-500/5">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Avg Discount</p>
                <p className="text-2xl font-bold text-amber-600">
                  {promoCodes.length > 0 
                    ? `${(promoCodes.filter(p => p.discount_type === 'percentage').reduce((sum, p) => sum + p.discount_value, 0) / Math.max(1, promoCodes.filter(p => p.discount_type === 'percentage').length)).toFixed(0)}%`
                    : '0%'}
                </p>
              </div>
              <Percent className="h-8 w-8 text-amber-500" />
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Ticket className="h-5 w-5 text-primary" />
              Promo Codes
            </CardTitle>
            <CardDescription>
              Manage promotional discounts for your riders
            </CardDescription>
          </div>
          <div className="flex flex-col gap-2 md:flex-row md:items-center">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search codes..."
                className="pl-9 w-full md:w-[180px]"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-full md:w-[130px]">
                <SelectValue placeholder="All Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="scheduled">Scheduled</SelectItem>
                <SelectItem value="expired">Expired</SelectItem>
                <SelectItem value="inactive">Inactive</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" onClick={() => fetchPromoCodes()} disabled={isLoading}>
              <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            <Button onClick={openCreateDialog}>
              <Plus className="h-4 w-4 mr-2" />
              New Code
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          ) : filteredPromoCodes.length === 0 ? (
            <div className="py-12 text-center">
              <Ticket className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-medium mb-2">No promo codes found</h3>
              <p className="text-muted-foreground mb-4">
                {searchQuery || statusFilter !== 'all'
                  ? 'Try adjusting your filters' 
                  : 'Create your first promotional code'}
              </p>
              <Button onClick={openCreateDialog}>
                <Plus className="h-4 w-4 mr-2" />
                Create Promo Code
              </Button>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Discount</TableHead>
                  <TableHead>Usage</TableHead>
                  <TableHead>Valid Period</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredPromoCodes.map((promo) => {
                  const status = getPromoStatus(promo);
                  const StatusIcon = status.icon;
                  return (
                    <TableRow key={promo.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <code className="font-mono font-bold text-primary bg-primary/10 px-2 py-1 rounded">
                            {promo.code}
                          </code>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6"
                            onClick={() => copyCode(promo.code)}
                          >
                            <Copy className="h-3 w-3" />
                          </Button>
                        </div>
                        {promo.description && (
                          <div className="text-xs text-muted-foreground mt-1 max-w-[200px] truncate">
                            {promo.description}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1 font-medium">
                          {promo.discount_type === 'percentage' ? (
                            <>
                              <Percent className="h-3 w-3" />
                              {promo.discount_value}% off
                            </>
                          ) : (
                            <>
                              <DollarSign className="h-3 w-3" />
                              £{promo.discount_value} off
                            </>
                          )}
                        </div>
                        {promo.max_discount && promo.discount_type === 'percentage' && (
                          <div className="text-xs text-muted-foreground">
                            Max: £{promo.max_discount}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <Users className="h-3 w-3 text-muted-foreground" />
                          {promo.usage_count}
                          {promo.usage_limit && (
                            <span className="text-muted-foreground">/ {promo.usage_limit}</span>
                          )}
                        </div>
                        {promo.per_user_limit && (
                          <div className="text-xs text-muted-foreground">
                            {promo.per_user_limit} per user
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="text-sm">
                          <div className="flex items-center gap-1">
                            <Calendar className="h-3 w-3 text-muted-foreground" />
                            {format(new Date(promo.valid_from), 'MMM d, yyyy')}
                          </div>
                          {promo.valid_until && (
                            <div className="text-xs text-muted-foreground">
                              to {format(new Date(promo.valid_until), 'MMM d, yyyy')}
                            </div>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={status.color}>
                          <StatusIcon className="h-3 w-3 mr-1" />
                          {status.label}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => { setSelectedPromo(promo); setIsViewOpen(true); }}>
                              <Eye className="h-4 w-4 mr-2" />
                              View Details
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => openEditDialog(promo)}>
                              <Pencil className="h-4 w-4 mr-2" />
                              Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => copyCode(promo.code)}>
                              <Copy className="h-4 w-4 mr-2" />
                              Copy Code
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem 
                              onClick={() => { setSelectedPromo(promo); setIsDeleteOpen(true); }}
                              className="text-destructive"
                            >
                              <Trash2 className="h-4 w-4 mr-2" />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* View Details Dialog */}
      <Dialog open={isViewOpen} onOpenChange={setIsViewOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Promo Code Details</DialogTitle>
            <DialogDescription>
              <code className="font-mono font-bold">{selectedPromo?.code}</code>
            </DialogDescription>
          </DialogHeader>
          {selectedPromo && (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                {(() => {
                  const status = getPromoStatus(selectedPromo);
                  const Icon = status.icon;
                  return (
                    <Badge variant="outline" className={status.color}>
                      <Icon className="h-3 w-3 mr-1" />
                      {status.label}
                    </Badge>
                  );
                })()}
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label className="text-muted-foreground">Discount</Label>
                  <p className="font-medium">
                    {selectedPromo.discount_type === 'percentage' 
                      ? `${selectedPromo.discount_value}%`
                      : `£${selectedPromo.discount_value}`}
                  </p>
                </div>
                {selectedPromo.max_discount && (
                  <div>
                    <Label className="text-muted-foreground">Max Discount</Label>
                    <p className="font-medium">£{selectedPromo.max_discount}</p>
                  </div>
                )}
                <div>
                  <Label className="text-muted-foreground">Usage</Label>
                  <p className="font-medium">
                    {selectedPromo.usage_count}
                    {selectedPromo.usage_limit && ` / ${selectedPromo.usage_limit}`}
                  </p>
                </div>
                {selectedPromo.per_user_limit && (
                  <div>
                    <Label className="text-muted-foreground">Per User Limit</Label>
                    <p className="font-medium">{selectedPromo.per_user_limit}</p>
                  </div>
                )}
                {selectedPromo.min_fare && selectedPromo.min_fare > 0 && (
                  <div>
                    <Label className="text-muted-foreground">Min Fare</Label>
                    <p className="font-medium">£{selectedPromo.min_fare}</p>
                  </div>
                )}
              </div>

              <div>
                <Label className="text-muted-foreground">Valid From</Label>
                <p className="font-medium">{format(new Date(selectedPromo.valid_from), 'PPP p')}</p>
              </div>

              {selectedPromo.valid_until && (
                <div>
                  <Label className="text-muted-foreground">Valid Until</Label>
                  <p className="font-medium">{format(new Date(selectedPromo.valid_until), 'PPP p')}</p>
                </div>
              )}

              {selectedPromo.description && (
                <div>
                  <Label className="text-muted-foreground">Description</Label>
                  <p className="text-sm bg-muted p-2 rounded">{selectedPromo.description}</p>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsViewOpen(false)}>Close</Button>
            <Button onClick={() => { setIsViewOpen(false); openEditDialog(selectedPromo!); }}>
              <Pencil className="h-4 w-4 mr-2" />
              Edit
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create/Edit Dialog */}
      <Dialog open={isFormOpen} onOpenChange={setIsFormOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {selectedPromo ? 'Edit Promo Code' : 'Create Promo Code'}
            </DialogTitle>
            <DialogDescription>
              {selectedPromo ? 'Update promotional discount' : 'Create a new promotional discount'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-2">
            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2">
                <Label htmlFor="code">Promo Code *</Label>
                <div className="flex gap-2">
                  <Input
                    id="code"
                    value={formData.code}
                    onChange={(e) => setFormData(prev => ({ ...prev, code: e.target.value.toUpperCase() }))}
                    placeholder="e.g., SAVE20"
                    className="font-mono"
                  />
                  <Button type="button" variant="outline" onClick={generateCode}>
                    Generate
                  </Button>
                </div>
              </div>
              <div className="col-span-2">
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  value={formData.description}
                  onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                  placeholder="Brief description of this promo"
                  rows={2}
                />
              </div>
              <div>
                <Label htmlFor="discount_type">Discount Type</Label>
                <Select
                  value={formData.discount_type}
                  onValueChange={(value) => setFormData(prev => ({ ...prev, discount_type: value }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="percentage">Percentage (%)</SelectItem>
                    <SelectItem value="fixed">Fixed Amount (£)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="discount_value">
                  Discount Value *
                </Label>
                <Input
                  id="discount_value"
                  type="number"
                  step={formData.discount_type === 'percentage' ? '1' : '0.01'}
                  min="0"
                  max={formData.discount_type === 'percentage' ? '100' : undefined}
                  value={formData.discount_value}
                  onChange={(e) => setFormData(prev => ({ ...prev, discount_value: e.target.value }))}
                  placeholder={formData.discount_type === 'percentage' ? '20' : '5.00'}
                />
              </div>
              <div>
                <Label htmlFor="min_fare">Min Fare (£)</Label>
                <Input
                  id="min_fare"
                  type="number"
                  step="0.01"
                  min="0"
                  value={formData.min_fare}
                  onChange={(e) => setFormData(prev => ({ ...prev, min_fare: e.target.value }))}
                  placeholder="0.00"
                />
              </div>
              {formData.discount_type === 'percentage' && (
                <div>
                  <Label htmlFor="max_discount">Max Discount (£)</Label>
                  <Input
                    id="max_discount"
                    type="number"
                    step="0.01"
                    min="0"
                    value={formData.max_discount}
                    onChange={(e) => setFormData(prev => ({ ...prev, max_discount: e.target.value }))}
                    placeholder="10.00"
                  />
                </div>
              )}
              <div>
                <Label htmlFor="usage_limit">Total Usage Limit</Label>
                <Input
                  id="usage_limit"
                  type="number"
                  min="0"
                  value={formData.usage_limit}
                  onChange={(e) => setFormData(prev => ({ ...prev, usage_limit: e.target.value }))}
                  placeholder="Unlimited"
                />
              </div>
              <div>
                <Label htmlFor="per_user_limit">Per User Limit</Label>
                <Input
                  id="per_user_limit"
                  type="number"
                  min="1"
                  value={formData.per_user_limit}
                  onChange={(e) => setFormData(prev => ({ ...prev, per_user_limit: e.target.value }))}
                  placeholder="1"
                />
              </div>
              <div>
                <Label htmlFor="valid_from">Valid From *</Label>
                <Input
                  id="valid_from"
                  type="datetime-local"
                  value={formData.valid_from}
                  onChange={(e) => setFormData(prev => ({ ...prev, valid_from: e.target.value }))}
                />
              </div>
              <div>
                <Label htmlFor="valid_until">Valid Until</Label>
                <Input
                  id="valid_until"
                  type="datetime-local"
                  value={formData.valid_until}
                  onChange={(e) => setFormData(prev => ({ ...prev, valid_until: e.target.value }))}
                />
              </div>
              <div className="col-span-2 flex items-center gap-2">
                <Switch
                  id="is_active"
                  checked={formData.is_active}
                  onCheckedChange={(checked) => setFormData(prev => ({ ...prev, is_active: checked }))}
                />
                <Label htmlFor="is_active">Active</Label>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsFormOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={isSaving}>
              {isSaving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              {selectedPromo ? 'Update' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Promo Code?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "<code className="font-mono">{selectedPromo?.code}</code>"? 
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction 
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isSaving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AdminLayout>
  );
}
