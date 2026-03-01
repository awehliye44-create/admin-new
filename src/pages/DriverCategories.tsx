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
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { supabase } from '@/integrations/supabase/client';
import { 
  Loader2, Pencil, RefreshCw, Star, Crown, Shield, Sparkles, Target, Percent,
} from 'lucide-react';
import { toast } from 'sonner';

interface DriverCategory {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  commission_pct: number;
  trip_target: number | null;
  level_order: number;
  is_active: boolean;
  display_order: number | null;
  created_at: string;
}

const TIER_ICONS: Record<string, typeof Star> = {
  shield: Shield,
  star: Star,
  crown: Crown,
  sparkles: Sparkles,
};

export default function DriverCategories() {
  const [categories, setCategories] = useState<DriverCategory[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<DriverCategory | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const [formData, setFormData] = useState({
    commission_pct: '',
    trip_target: '',
    description: '',
    is_active: true,
    display_order: '',
  });

  const fetchCategories = useCallback(async () => {
    try {
      setIsLoading(true);
      const { data, error } = await supabase
        .from('driver_categories')
        .select('*')
        .order('level_order', { ascending: true });

      if (error) throw error;
      setCategories((data as any[]) || []);
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

  const openEditDialog = (category: DriverCategory) => {
    setSelectedCategory(category);
    setFormData({
      commission_pct: category.commission_pct?.toString() || '20',
      trip_target: category.trip_target?.toString() || '',
      description: category.description || '',
      is_active: category.is_active,
      display_order: category.display_order?.toString() || '',
    });
    setIsFormOpen(true);
  };

  const handleSave = async () => {
    if (!selectedCategory) return;

    setIsSaving(true);
    try {
      const updateData: Record<string, any> = {
        commission_pct: formData.commission_pct ? parseFloat(formData.commission_pct) : 20,
        trip_target: formData.trip_target ? parseInt(formData.trip_target) : null,
        description: formData.description.trim() || null,
        is_active: formData.is_active,
        display_order: formData.display_order ? parseInt(formData.display_order) : selectedCategory.level_order,
      };

      const { error } = await supabase
        .from('driver_categories')
        .update(updateData)
        .eq('id', selectedCategory.id);

      if (error) throw error;
      toast.success('Category updated successfully');
      setIsFormOpen(false);
      fetchCategories();
    } catch (err: any) {
      console.error('Error saving category:', err);
      toast.error(err.message || 'Failed to save category');
    } finally {
      setIsSaving(false);
    }
  };

  const getIconComponent = (iconName: string | null) => {
    return TIER_ICONS[iconName || 'shield'] || Shield;
  };

  const activeCount = categories.filter(c => c.is_active).length;

  return (
    <AdminLayout 
      title="Driver Categories" 
      description="Manage driver tiers, commission rates, and trip targets"
    >
      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Total Tiers</p>
                <p className="text-2xl font-bold">{categories.length}</p>
              </div>
              <Shield className="h-8 w-8 text-primary opacity-80" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-green-500/30 bg-green-500/5">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Active Tiers</p>
                <p className="text-2xl font-bold text-green-600">{activeCount}</p>
              </div>
              <Target className="h-8 w-8 text-green-500" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-amber-500/30 bg-amber-500/5">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Commission Range</p>
                <p className="text-2xl font-bold text-amber-600">
                  {categories.length > 0
                    ? `${Math.min(...categories.map(c => c.commission_pct))}–${Math.max(...categories.map(c => c.commission_pct))}%`
                    : '—'}
                </p>
              </div>
              <Percent className="h-8 w-8 text-amber-500" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Info banner */}
      <div className="mb-4 p-3 bg-muted/50 border rounded-lg text-sm text-muted-foreground flex items-start gap-2">
        <Shield className="h-4 w-4 mt-0.5 shrink-0" />
        <span>
          Categories are <strong>manually assigned</strong> per driver. Trip targets are visual guidance only — the system will <strong>never</strong> auto-promote or auto-demote drivers.
        </span>
      </div>

      <Card>
        <CardHeader className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Crown className="h-5 w-5 text-primary" />
              Driver Tiers
            </CardTitle>
            <CardDescription>
              Edit commission rates and trip targets for each tier
            </CardDescription>
          </div>
          <Button variant="outline" onClick={fetchCategories} disabled={isLoading}>
            <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Category</TableHead>
                  <TableHead>Commission %</TableHead>
                  <TableHead>Trip Target</TableHead>
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
                        <Badge variant="outline" className="font-mono">
                          {category.commission_pct}%
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {category.trip_target ? (
                          <span className="font-mono">{category.trip_target} trips</span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant={category.is_active ? 'default' : 'secondary'}>
                          {category.is_active ? 'Active' : 'Inactive'}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {category.display_order || category.level_order}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button 
                          variant="ghost" 
                          size="icon"
                          onClick={() => openEditDialog(category)}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Edit Dialog */}
      <Dialog open={isFormOpen} onOpenChange={setIsFormOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              Edit {selectedCategory?.name} Tier
            </DialogTitle>
            <DialogDescription>
              Update commission rate and trip target for this tier
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="commission_pct">Commission %</Label>
              <Input
                id="commission_pct"
                type="number"
                step="0.5"
                min="0"
                max="100"
                value={formData.commission_pct}
                onChange={(e) => setFormData(prev => ({ ...prev, commission_pct: e.target.value }))}
                placeholder="e.g., 20"
              />
              <p className="text-xs text-muted-foreground mt-1">Applied to base fare on trip completion</p>
            </div>
            <div>
              <Label htmlFor="trip_target">Trip Target (guidance only)</Label>
              <Input
                id="trip_target"
                type="number"
                min="0"
                value={formData.trip_target}
                onChange={(e) => setFormData(prev => ({ ...prev, trip_target: e.target.value }))}
                placeholder="e.g., 500"
              />
              <p className="text-xs text-muted-foreground mt-1">Visual progress shown to admin — no auto-promotion</p>
            </div>
            <div>
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                value={formData.description}
                onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                placeholder="Brief description"
                rows={2}
              />
            </div>
            <div className="flex items-center gap-3">
              <div>
                <Label htmlFor="display_order">Display Order</Label>
                <Input
                  id="display_order"
                  type="number"
                  min="0"
                  value={formData.display_order}
                  onChange={(e) => setFormData(prev => ({ ...prev, display_order: e.target.value }))}
                  placeholder="1"
                  className="w-20"
                />
              </div>
              <div className="flex items-center gap-2 pt-5">
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
              Update
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}
