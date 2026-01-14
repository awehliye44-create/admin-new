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
import { Switch } from '@/components/ui/switch';
import { 
  Search, 
  Grid3X3, 
  RefreshCw, 
  Edit, 
  Trash2, 
  Plus,
  MoreVertical,
  Tag,
  Folder,
  MessageSquare,
  AlertTriangle,
  Settings
} from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface SupportCategory {
  id: string;
  name: string;
  slug: string;
  description: string;
  type: 'ticket' | 'complaint' | 'both';
  parent_id: string | null;
  icon: string;
  color: string;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  sla_hours: number;
  is_active: boolean;
  display_order: number;
  auto_assign_team: string | null;
}

const defaultCategories: SupportCategory[] = [
  {
    id: '1',
    name: 'Payment Issues',
    slug: 'payment-issues',
    description: 'Issues related to payments, refunds, and billing',
    type: 'both',
    parent_id: null,
    icon: 'credit-card',
    color: '#22c55e',
    priority: 'high',
    sla_hours: 24,
    is_active: true,
    display_order: 1,
    auto_assign_team: 'Finance Team',
  },
  {
    id: '2',
    name: 'App Issues',
    slug: 'app-issues',
    description: 'Technical issues with the mobile or web application',
    type: 'ticket',
    parent_id: null,
    icon: 'smartphone',
    color: '#3b82f6',
    priority: 'normal',
    sla_hours: 48,
    is_active: true,
    display_order: 2,
    auto_assign_team: 'Tech Support',
  },
  {
    id: '3',
    name: 'Driver Behavior',
    slug: 'driver-behavior',
    description: 'Complaints about driver conduct or behavior',
    type: 'complaint',
    parent_id: null,
    icon: 'user',
    color: '#ef4444',
    priority: 'high',
    sla_hours: 12,
    is_active: true,
    display_order: 3,
    auto_assign_team: 'Safety Team',
  },
  {
    id: '4',
    name: 'Rider Behavior',
    slug: 'rider-behavior',
    description: 'Complaints about rider conduct or behavior',
    type: 'complaint',
    parent_id: null,
    icon: 'users',
    color: '#f97316',
    priority: 'high',
    sla_hours: 12,
    is_active: true,
    display_order: 4,
    auto_assign_team: 'Safety Team',
  },
  {
    id: '5',
    name: 'Account Issues',
    slug: 'account-issues',
    description: 'Issues related to account access, verification, or settings',
    type: 'ticket',
    parent_id: null,
    icon: 'user-circle',
    color: '#8b5cf6',
    priority: 'normal',
    sla_hours: 24,
    is_active: true,
    display_order: 5,
    auto_assign_team: 'Support Team',
  },
  {
    id: '6',
    name: 'Safety Concerns',
    slug: 'safety-concerns',
    description: 'Urgent safety-related issues or emergencies',
    type: 'both',
    parent_id: null,
    icon: 'shield',
    color: '#dc2626',
    priority: 'urgent',
    sla_hours: 4,
    is_active: true,
    display_order: 6,
    auto_assign_team: 'Safety Team',
  },
  {
    id: '7',
    name: 'Document Issues',
    slug: 'document-issues',
    description: 'Issues with document upload or verification',
    type: 'ticket',
    parent_id: null,
    icon: 'file',
    color: '#6366f1',
    priority: 'normal',
    sla_hours: 48,
    is_active: true,
    display_order: 7,
    auto_assign_team: 'Document Team',
  },
  {
    id: '8',
    name: 'Fare Disputes',
    slug: 'fare-disputes',
    description: 'Disputes related to trip fares or charges',
    type: 'both',
    parent_id: null,
    icon: 'dollar-sign',
    color: '#10b981',
    priority: 'high',
    sla_hours: 24,
    is_active: true,
    display_order: 8,
    auto_assign_team: 'Finance Team',
  },
];

export default function SupportCategories() {
  const queryClient = useQueryClient();
  const [searchTerm, setSearchTerm] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [selectedCategory, setSelectedCategory] = useState<SupportCategory | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);

  const [formData, setFormData] = useState<Partial<SupportCategory>>({
    name: '',
    description: '',
    type: 'both',
    priority: 'normal',
    sla_hours: 24,
    is_active: true,
    color: '#3b82f6',
    auto_assign_team: '',
  });

  const { data: categories = defaultCategories, isLoading, refetch } = useQuery({
    queryKey: ['support-categories'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('admin_settings')
        .select('*')
        .eq('setting_key', 'support_categories')
        .single();

      if (error || !data) return defaultCategories;
      return (data.setting_value as unknown as SupportCategory[]) || defaultCategories;
    },
  });

  const saveMutation = useMutation({
    mutationFn: async (updatedCategories: SupportCategory[]) => {
      const { error } = await supabase
        .from('admin_settings')
        .upsert({
          setting_key: 'support_categories',
          setting_value: updatedCategories as any,
          description: 'Support categories configuration',
        } as any, { onConflict: 'setting_key' });

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['support-categories'] });
      toast.success('Category saved successfully');
    },
    onError: () => {
      toast.error('Failed to save category');
    },
  });

  const handleOpenForm = (category?: SupportCategory) => {
    if (category) {
      setSelectedCategory(category);
      setFormData(category);
    } else {
      setSelectedCategory(null);
      setFormData({
        name: '',
        description: '',
        type: 'both',
        priority: 'normal',
        sla_hours: 24,
        is_active: true,
        color: '#3b82f6',
        auto_assign_team: '',
      });
    }
    setIsFormOpen(true);
  };

  const handleSave = () => {
    if (!formData.name) {
      toast.error('Please enter a category name');
      return;
    }

    const slug = formData.name.toLowerCase().replace(/\s+/g, '-');

    if (selectedCategory) {
      // Update existing
      const updated = categories.map(c => 
        c.id === selectedCategory.id 
          ? { ...c, ...formData, slug }
          : c
      );
      saveMutation.mutate(updated);
    } else {
      // Create new
      const newCategory: SupportCategory = {
        id: Date.now().toString(),
        name: formData.name!,
        slug,
        description: formData.description || '',
        type: formData.type as 'ticket' | 'complaint' | 'both',
        parent_id: null,
        icon: 'tag',
        color: formData.color || '#3b82f6',
        priority: formData.priority as 'low' | 'normal' | 'high' | 'urgent',
        sla_hours: formData.sla_hours || 24,
        is_active: formData.is_active !== false,
        display_order: categories.length + 1,
        auto_assign_team: formData.auto_assign_team || null,
      };
      saveMutation.mutate([...categories, newCategory]);
    }

    setIsFormOpen(false);
  };

  const handleDelete = () => {
    if (!selectedCategory) return;
    
    const updated = categories.filter(c => c.id !== selectedCategory.id);
    saveMutation.mutate(updated);
    setIsDeleteOpen(false);
    setSelectedCategory(null);
  };

  const handleToggleActive = (categoryId: string) => {
    const updated = categories.map(c => 
      c.id === categoryId ? { ...c, is_active: !c.is_active } : c
    );
    saveMutation.mutate(updated);
  };

  const filteredCategories = categories.filter(category => {
    const matchesSearch = 
      category.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      category.description.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesType = typeFilter === 'all' || category.type === typeFilter;
    return matchesSearch && matchesType;
  });

  const ticketCategories = categories.filter(c => c.type === 'ticket' || c.type === 'both');
  const complaintCategories = categories.filter(c => c.type === 'complaint' || c.type === 'both');

  const getPriorityBadge = (priority: string) => {
    switch (priority) {
      case 'urgent':
        return <Badge variant="destructive">Urgent</Badge>;
      case 'high':
        return <Badge className="bg-orange-500 hover:bg-orange-600">High</Badge>;
      case 'normal':
        return <Badge variant="secondary">Normal</Badge>;
      case 'low':
        return <Badge variant="outline">Low</Badge>;
      default:
        return <Badge variant="outline">{priority}</Badge>;
    }
  };

  const getTypeBadge = (type: string) => {
    switch (type) {
      case 'ticket':
        return <Badge variant="outline" className="gap-1"><MessageSquare className="h-3 w-3" />Tickets</Badge>;
      case 'complaint':
        return <Badge variant="outline" className="gap-1"><AlertTriangle className="h-3 w-3" />Complaints</Badge>;
      case 'both':
        return <Badge variant="outline" className="gap-1"><Folder className="h-3 w-3" />Both</Badge>;
      default:
        return <Badge variant="outline">{type}</Badge>;
    }
  };

  return (
    <AdminLayout 
      title="Support Categories" 
      description="Manage ticket and complaint categories"
    >
      <div className="space-y-6">
        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Total Categories</p>
                  <p className="text-2xl font-bold">{categories.length}</p>
                </div>
                <Grid3X3 className="h-8 w-8 text-primary opacity-80" />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Ticket Categories</p>
                  <p className="text-2xl font-bold text-blue-600">{ticketCategories.length}</p>
                </div>
                <MessageSquare className="h-8 w-8 text-blue-600 opacity-80" />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Complaint Categories</p>
                  <p className="text-2xl font-bold text-orange-600">{complaintCategories.length}</p>
                </div>
                <AlertTriangle className="h-8 w-8 text-orange-600 opacity-80" />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Active</p>
                  <p className="text-2xl font-bold text-green-600">
                    {categories.filter(c => c.is_active).length}
                  </p>
                </div>
                <Tag className="h-8 w-8 text-green-600 opacity-80" />
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
                  <Grid3X3 className="h-5 w-5 text-primary" />
                  Category Management
                </CardTitle>
                <CardDescription>Configure support and complaint categories</CardDescription>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => refetch()} disabled={isLoading}>
                  <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
                  Refresh
                </Button>
                <Button onClick={() => handleOpenForm()}>
                  <Plus className="h-4 w-4 mr-2" />
                  Add Category
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
                  placeholder="Search categories..."
                  className="pl-9"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
              </div>
              <Select value={typeFilter} onValueChange={setTypeFilter}>
                <SelectTrigger className="w-full md:w-40">
                  <SelectValue placeholder="Type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  <SelectItem value="ticket">Tickets</SelectItem>
                  <SelectItem value="complaint">Complaints</SelectItem>
                  <SelectItem value="both">Both</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Table */}
            <div className="border rounded-lg overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Category</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Priority</TableHead>
                    <TableHead>SLA (hours)</TableHead>
                    <TableHead>Auto-assign</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredCategories.map((category) => (
                    <TableRow key={category.id}>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <div 
                            className="w-3 h-3 rounded-full" 
                            style={{ backgroundColor: category.color }}
                          />
                          <div>
                            <p className="font-medium">{category.name}</p>
                            <p className="text-sm text-muted-foreground truncate max-w-[200px]">
                              {category.description}
                            </p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>{getTypeBadge(category.type)}</TableCell>
                      <TableCell>{getPriorityBadge(category.priority)}</TableCell>
                      <TableCell>{category.sla_hours}h</TableCell>
                      <TableCell>
                        {category.auto_assign_team || <span className="text-muted-foreground">-</span>}
                      </TableCell>
                      <TableCell>
                        <Switch
                          checked={category.is_active}
                          onCheckedChange={() => handleToggleActive(category.id)}
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon">
                              <MoreVertical className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => handleOpenForm(category)}>
                              <Edit className="h-4 w-4 mr-2" />
                              Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem 
                              onClick={() => {
                                setSelectedCategory(category);
                                setIsDeleteOpen(true);
                              }}
                              className="text-destructive"
                            >
                              <Trash2 className="h-4 w-4 mr-2" />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))}
                  {filteredCategories.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                        No categories found
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Form Dialog */}
      <Dialog open={isFormOpen} onOpenChange={setIsFormOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{selectedCategory ? 'Edit Category' : 'Add Category'}</DialogTitle>
            <DialogDescription>
              {selectedCategory ? 'Update category details' : 'Create a new support category'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Name *</Label>
              <Input
                placeholder="Category name"
                value={formData.name || ''}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label>Description</Label>
              <Textarea
                placeholder="Category description"
                value={formData.description || ''}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Type</Label>
                <Select 
                  value={formData.type || 'both'} 
                  onValueChange={(v) => setFormData({ ...formData, type: v as any })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ticket">Tickets Only</SelectItem>
                    <SelectItem value="complaint">Complaints Only</SelectItem>
                    <SelectItem value="both">Both</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Default Priority</Label>
                <Select 
                  value={formData.priority || 'normal'} 
                  onValueChange={(v) => setFormData({ ...formData, priority: v as any })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="normal">Normal</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                    <SelectItem value="urgent">Urgent</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>SLA (hours)</Label>
                <Input
                  type="number"
                  placeholder="24"
                  value={formData.sla_hours || ''}
                  onChange={(e) => setFormData({ ...formData, sla_hours: parseInt(e.target.value) || 24 })}
                />
              </div>
              <div className="space-y-2">
                <Label>Color</Label>
                <div className="flex gap-2">
                  <Input
                    type="color"
                    value={formData.color || '#3b82f6'}
                    onChange={(e) => setFormData({ ...formData, color: e.target.value })}
                    className="w-12 h-10 p-1 cursor-pointer"
                  />
                  <Input
                    value={formData.color || '#3b82f6'}
                    onChange={(e) => setFormData({ ...formData, color: e.target.value })}
                    className="flex-1"
                  />
                </div>
              </div>
            </div>
            <div className="space-y-2">
              <Label>Auto-assign Team</Label>
              <Input
                placeholder="e.g., Support Team"
                value={formData.auto_assign_team || ''}
                onChange={(e) => setFormData({ ...formData, auto_assign_team: e.target.value })}
              />
            </div>
            <div className="flex items-center justify-between">
              <Label>Active</Label>
              <Switch
                checked={formData.is_active !== false}
                onCheckedChange={(checked) => setFormData({ ...formData, is_active: checked })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsFormOpen(false)}>Cancel</Button>
            <Button onClick={handleSave}>
              {selectedCategory ? 'Update' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Category</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{selectedCategory?.name}"? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsDeleteOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}
