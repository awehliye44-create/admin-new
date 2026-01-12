import { useEffect, useState, useCallback } from 'react';
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { supabase } from '@/integrations/supabase/client';
import { 
  Users, Loader2, Plus, Pencil, Trash2, RefreshCw, Star, Car, Crown,
  Shield, Sparkles, Award, CheckCircle2
} from 'lucide-react';
import { toast } from 'sonner';

interface DriverCategory {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  requirements: string[] | null;
  min_rating: number | null;
  min_trips: number | null;
  is_active: boolean;
  display_order: number | null;
  created_at: string;
}

const ICON_OPTIONS = [
  { value: 'car', label: 'Car', icon: Car },
  { value: 'star', label: 'Star', icon: Star },
  { value: 'crown', label: 'Crown', icon: Crown },
  { value: 'shield', label: 'Shield', icon: Shield },
  { value: 'sparkles', label: 'Sparkles', icon: Sparkles },
  { value: 'award', label: 'Award', icon: Award },
];

const COLOR_OPTIONS = [
  { value: '#6B7280', label: 'Gray' },
  { value: '#3B82F6', label: 'Blue' },
  { value: '#10B981', label: 'Green' },
  { value: '#F59E0B', label: 'Amber' },
  { value: '#8B5CF6', label: 'Purple' },
  { value: '#EF4444', label: 'Red' },
  { value: '#EC4899', label: 'Pink' },
  { value: '#14B8A6', label: 'Teal' },
];

export default function DriverCategories() {
  const [categories, setCategories] = useState<DriverCategory[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Dialog states
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<DriverCategory | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Form state
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    icon: 'car',
    color: '#3B82F6',
    requirements: '',
    min_rating: '',
    min_trips: '',
    is_active: true,
    display_order: '',
  });

  const fetchCategories = useCallback(async () => {
    try {
      setIsLoading(true);
      const { data, error } = await supabase
        .from('driver_categories')
        .select('*')
        .order('display_order', { ascending: true });

      if (error) throw error;
      setCategories(data || []);
    } catch (err) {
      console.error('Error fetching categories:', err);
      toast.error('Failed to load categories');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCategories();
  }, [fetchCategories]);

  const resetForm = () => {
    setFormData({
      name: '',
      description: '',
      icon: 'car',
      color: '#3B82F6',
      requirements: '',
      min_rating: '',
      min_trips: '',
      is_active: true,
      display_order: '',
    });
    setSelectedCategory(null);
  };

  const openCreateDialog = () => {
    resetForm();
    setIsFormOpen(true);
  };

  const openEditDialog = (category: DriverCategory) => {
    setSelectedCategory(category);
    setFormData({
      name: category.name,
      description: category.description || '',
      icon: category.icon || 'car',
      color: category.color || '#3B82F6',
      requirements: category.requirements?.join('\n') || '',
      min_rating: category.min_rating?.toString() || '',
      min_trips: category.min_trips?.toString() || '',
      is_active: category.is_active,
      display_order: category.display_order?.toString() || '',
    });
    setIsFormOpen(true);
  };

  const openDeleteDialog = (category: DriverCategory) => {
    setSelectedCategory(category);
    setIsDeleteOpen(true);
  };

  const handleSave = async () => {
    if (!formData.name.trim()) {
      toast.error('Please enter a category name');
      return;
    }

    setIsSaving(true);
    try {
      const requirements = formData.requirements
        .split('\n')
        .map(r => r.trim())
        .filter(r => r.length > 0);

      const categoryData = {
        name: formData.name.trim(),
        description: formData.description.trim() || null,
        icon: formData.icon,
        color: formData.color,
        requirements,
        min_rating: formData.min_rating ? parseFloat(formData.min_rating) : 0,
        min_trips: formData.min_trips ? parseInt(formData.min_trips) : 0,
        is_active: formData.is_active,
        display_order: formData.display_order ? parseInt(formData.display_order) : 0,
      };

      if (selectedCategory) {
        // Update existing
        const { error } = await supabase
          .from('driver_categories')
          .update(categoryData)
          .eq('id', selectedCategory.id);

        if (error) throw error;
        toast.success('Category updated successfully');
      } else {
        // Create new
        const { error } = await supabase
          .from('driver_categories')
          .insert([categoryData]);

        if (error) throw error;
        toast.success('Category created successfully');
      }

      setIsFormOpen(false);
      resetForm();
      fetchCategories();
    } catch (err: any) {
      console.error('Error saving category:', err);
      toast.error(err.message || 'Failed to save category');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedCategory) return;

    setIsSaving(true);
    try {
      const { error } = await supabase
        .from('driver_categories')
        .delete()
        .eq('id', selectedCategory.id);

      if (error) throw error;

      toast.success('Category deleted successfully');
      setIsDeleteOpen(false);
      setSelectedCategory(null);
      fetchCategories();
    } catch (err: any) {
      console.error('Error deleting category:', err);
      toast.error(err.message || 'Failed to delete category');
    } finally {
      setIsSaving(false);
    }
  };

  const getIconComponent = (iconName: string | null) => {
    const found = ICON_OPTIONS.find(i => i.value === iconName);
    return found ? found.icon : Car;
  };

  const activeCount = categories.filter(c => c.is_active).length;

  return (
    <AdminLayout 
      title="Driver Categories" 
      description="Manage driver tiers and qualification levels"
    >
      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Total Categories</p>
                <p className="text-2xl font-bold">{categories.length}</p>
              </div>
              <Users className="h-8 w-8 text-primary opacity-80" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-green-500/30 bg-green-500/5">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Active Categories</p>
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
                <p className="text-sm text-muted-foreground">Premium Tiers</p>
                <p className="text-2xl font-bold text-purple-600">
                  {categories.filter(c => (c.min_rating || 0) >= 4.5).length}
                </p>
              </div>
              <Crown className="h-8 w-8 text-purple-500" />
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Users className="h-5 w-5 text-primary" />
              Driver Categories
            </CardTitle>
            <CardDescription>
              Define driver tiers with requirements and benefits
            </CardDescription>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={fetchCategories} disabled={isLoading}>
              <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            <Button onClick={openCreateDialog}>
              <Plus className="h-4 w-4 mr-2" />
              Add Category
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          ) : categories.length === 0 ? (
            <div className="py-12 text-center">
              <Users className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-medium mb-2">No categories yet</h3>
              <p className="text-muted-foreground mb-4">
                Create driver categories to classify your drivers
              </p>
              <Button onClick={openCreateDialog}>
                <Plus className="h-4 w-4 mr-2" />
                Add First Category
              </Button>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Category</TableHead>
                  <TableHead>Requirements</TableHead>
                  <TableHead>Min Rating</TableHead>
                  <TableHead>Min Trips</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Order</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {categories.map((category) => {
                  const IconComponent = getIconComponent(category.icon);
                  return (
                    <TableRow key={category.id}>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <div 
                            className="h-10 w-10 rounded-lg flex items-center justify-center"
                            style={{ backgroundColor: `${category.color}20` }}
                          >
                            <IconComponent 
                              className="h-5 w-5" 
                              style={{ color: category.color || '#3B82F6' }}
                            />
                          </div>
                          <div>
                            <div className="font-medium">{category.name}</div>
                            {category.description && (
                              <div className="text-xs text-muted-foreground max-w-[200px] truncate">
                                {category.description}
                              </div>
                            )}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1 max-w-[200px]">
                          {category.requirements?.slice(0, 2).map((req, i) => (
                            <Badge key={i} variant="outline" className="text-xs">
                              {req}
                            </Badge>
                          ))}
                          {(category.requirements?.length || 0) > 2 && (
                            <Badge variant="outline" className="text-xs">
                              +{category.requirements!.length - 2} more
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        {category.min_rating ? (
                          <div className="flex items-center gap-1">
                            <Star className="h-3 w-3 text-yellow-500 fill-yellow-500" />
                            {category.min_rating}+
                          </div>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {category.min_trips ? `${category.min_trips}+` : <span className="text-muted-foreground">-</span>}
                      </TableCell>
                      <TableCell>
                        <Badge variant={category.is_active ? 'default' : 'secondary'}>
                          {category.is_active ? 'Active' : 'Inactive'}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {category.display_order || 0}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button 
                            variant="ghost" 
                            size="icon"
                            onClick={() => openEditDialog(category)}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button 
                            variant="ghost" 
                            size="icon"
                            onClick={() => openDeleteDialog(category)}
                            className="text-destructive hover:text-destructive"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Create/Edit Dialog */}
      <Dialog open={isFormOpen} onOpenChange={setIsFormOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {selectedCategory ? 'Edit Category' : 'Create Category'}
            </DialogTitle>
            <DialogDescription>
              {selectedCategory ? 'Update driver category details' : 'Add a new driver category'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-2">
            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2">
                <Label htmlFor="name">Category Name *</Label>
                <Input
                  id="name"
                  value={formData.name}
                  onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                  placeholder="e.g., Premium, Executive"
                />
              </div>
              <div className="col-span-2">
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  value={formData.description}
                  onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                  placeholder="Brief description of this category"
                  rows={2}
                />
              </div>
              <div>
                <Label>Icon</Label>
                <div className="flex flex-wrap gap-2 mt-2">
                  {ICON_OPTIONS.map((option) => {
                    const Icon = option.icon;
                    return (
                      <Button
                        key={option.value}
                        type="button"
                        variant={formData.icon === option.value ? 'default' : 'outline'}
                        size="icon"
                        onClick={() => setFormData(prev => ({ ...prev, icon: option.value }))}
                      >
                        <Icon className="h-4 w-4" />
                      </Button>
                    );
                  })}
                </div>
              </div>
              <div>
                <Label>Color</Label>
                <div className="flex flex-wrap gap-2 mt-2">
                  {COLOR_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={`h-8 w-8 rounded-full border-2 ${formData.color === option.value ? 'border-foreground ring-2 ring-offset-2' : 'border-transparent'}`}
                      style={{ backgroundColor: option.value }}
                      onClick={() => setFormData(prev => ({ ...prev, color: option.value }))}
                      title={option.label}
                    />
                  ))}
                </div>
              </div>
              <div className="col-span-2">
                <Label htmlFor="requirements">Requirements (one per line)</Label>
                <Textarea
                  id="requirements"
                  value={formData.requirements}
                  onChange={(e) => setFormData(prev => ({ ...prev, requirements: e.target.value }))}
                  placeholder="Valid license&#10;Background check&#10;Minimum 1 year experience"
                  rows={3}
                />
              </div>
              <div>
                <Label htmlFor="min_rating">Minimum Rating</Label>
                <Input
                  id="min_rating"
                  type="number"
                  step="0.1"
                  min="0"
                  max="5"
                  value={formData.min_rating}
                  onChange={(e) => setFormData(prev => ({ ...prev, min_rating: e.target.value }))}
                  placeholder="e.g., 4.5"
                />
              </div>
              <div>
                <Label htmlFor="min_trips">Minimum Trips</Label>
                <Input
                  id="min_trips"
                  type="number"
                  min="0"
                  value={formData.min_trips}
                  onChange={(e) => setFormData(prev => ({ ...prev, min_trips: e.target.value }))}
                  placeholder="e.g., 100"
                />
              </div>
              <div>
                <Label htmlFor="display_order">Display Order</Label>
                <Input
                  id="display_order"
                  type="number"
                  min="0"
                  value={formData.display_order}
                  onChange={(e) => setFormData(prev => ({ ...prev, display_order: e.target.value }))}
                  placeholder="0"
                />
              </div>
              <div className="flex items-center gap-2">
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
              {selectedCategory ? 'Update' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Category?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{selectedCategory?.name}"? This action cannot be undone.
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
