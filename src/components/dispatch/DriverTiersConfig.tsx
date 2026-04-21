import { useEffect, useState, useCallback } from 'react';
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
import { Loader2, Pencil, RefreshCw, Star, Crown, Shield, Sparkles, Info } from 'lucide-react';
import { toast } from 'sonner';

interface DriverTier {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  commission_pct: number;
  category_priority: number;
  trip_target: number | null;
  level_order: number;
  is_active: boolean;
  display_order: number | null;
}

const TIER_ICONS: Record<string, typeof Star> = {
  shield: Shield,
  star: Star,
  crown: Crown,
  sparkles: Sparkles,
};

export function DriverTiersConfig() {
  const [tiers, setTiers] = useState<DriverTier[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [selectedTier, setSelectedTier] = useState<DriverTier | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const [formData, setFormData] = useState({
    category_priority: '',
    commission_pct: '',
    trip_target: '',
    description: '',
    is_active: true,
    display_order: '',
  });

  const fetchTiers = useCallback(async () => {
    try {
      setIsLoading(true);
      const { data, error } = await supabase
        .from('driver_categories')
        .select('*')
        .order('level_order', { ascending: true });

      if (error) throw error;
      setTiers((data as any[]) || []);
    } catch (err) {
      console.error('Error fetching tiers:', err);
      toast.error('Failed to load driver tiers');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTiers();
  }, [fetchTiers]);

  const openEditDialog = (tier: DriverTier) => {
    setSelectedTier(tier);
    setFormData({
      category_priority: tier.category_priority?.toString() || '10',
      commission_pct: tier.commission_pct?.toString() || '',
      trip_target: tier.trip_target?.toString() || '',
      description: tier.description || '',
      is_active: tier.is_active,
      display_order: tier.display_order?.toString() || '',
    });
    setIsFormOpen(true);
  };

  const handleSave = async () => {
    if (!selectedTier) return;

    setIsSaving(true);
    try {
      const updateData: Record<string, any> = {
        category_priority: formData.category_priority ? parseInt(formData.category_priority) : 10,
        commission_pct: formData.commission_pct ? parseFloat(formData.commission_pct) : null,
        trip_target: formData.trip_target ? parseInt(formData.trip_target) : null,
        description: formData.description.trim() || null,
        is_active: formData.is_active,
        display_order: formData.display_order ? parseInt(formData.display_order) : selectedTier.level_order,
      };

      const { error } = await supabase
        .from('driver_categories')
        .update(updateData)
        .eq('id', selectedTier.id);

      if (error) throw error;
      toast.success('Tier updated successfully');
      setIsFormOpen(false);
      fetchTiers();
    } catch (err: any) {
      console.error('Error saving tier:', err);
      toast.error(err.message || 'Failed to save tier');
    } finally {
      setIsSaving(false);
    }
  };

  const getIconComponent = (iconName: string | null) => {
    return TIER_ICONS[iconName || 'shield'] || Shield;
  };

  return (
    <>
      <Card className="border-primary/50">
        <CardHeader className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <Crown className="h-5 w-5 text-primary" />
            <div>
              <CardTitle>Driver Tiers Configuration</CardTitle>
              <CardDescription>
                Single source of truth for tier priority, commission rates, and dispatch scoring weights
              </CardDescription>
            </div>
            <Badge className="ml-2 bg-primary text-primary-foreground">Primary</Badge>
          </div>
          <Button variant="outline" size="sm" onClick={fetchTiers} disabled={isLoading}>
            <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Info banner */}
          <div className="flex items-start gap-2 p-3 bg-muted/50 rounded-lg">
            <Info className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
            <div className="text-sm text-muted-foreground">
              <p><strong>Category Priority</strong> is used directly in the dispatch scoring formula:</p>
              <code className="text-xs block mt-1">
                score = category_priority + waiting_bonus + fairness_boost − distance_penalty
              </code>
              <p className="mt-1"><strong>Commission %</strong> is applied during trip settlement.</p>
              <p className="mt-1"><strong>Trip Target</strong> drives <strong>automatic promotion</strong>: when a driver finishes a trip and their completed-trip count reaches a tier's target, they are promoted to the next active tier on the spot. Upgrades only — drivers are never auto-demoted.</p>
            </div>
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tier</TableHead>
                  <TableHead>Category Priority</TableHead>
                  <TableHead>Commission %</TableHead>
                  <TableHead>Trip Target</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Order</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tiers.map((tier) => {
                  const IconComponent = getIconComponent(tier.icon);
                  return (
                    <TableRow key={tier.id}>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <div
                            className="h-10 w-10 rounded-lg flex items-center justify-center"
                            style={{ backgroundColor: `${tier.color}20` }}
                          >
                            <IconComponent
                              className="h-5 w-5"
                              style={{ color: tier.color || '#3B82F6' }}
                            />
                          </div>
                          <div>
                            <div className="font-medium">{tier.name}</div>
                            {tier.description && (
                              <div className="text-xs text-muted-foreground max-w-[200px] truncate">
                                {tier.description}
                              </div>
                            )}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="font-mono">
                          {tier.category_priority}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="font-mono">
                          {tier.commission_pct}%
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {tier.trip_target ? (
                          <span className="font-mono">{tier.trip_target} trips</span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant={tier.is_active ? 'default' : 'secondary'}>
                          {tier.is_active ? 'Active' : 'Inactive'}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {tier.display_order || tier.level_order}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => openEditDialog(tier)}
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
            <DialogTitle>Edit {selectedTier?.name} Tier</DialogTitle>
            <DialogDescription>
              Update priority, commission rate, and trip target
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="category_priority">Category Priority (dispatch weight)</Label>
              <Input
                id="category_priority"
                type="number"
                min="0"
                max="100"
                value={formData.category_priority}
                onChange={(e) => setFormData(prev => ({ ...prev, category_priority: e.target.value }))}
                placeholder="e.g., 10"
              />
              <p className="text-xs text-muted-foreground mt-1">Higher value = higher ranking in dispatch scoring</p>
            </div>
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
              <p className="text-xs text-muted-foreground mt-1">Applied to commissionable subtotal on trip completion</p>
            </div>
            <div>
              <Label htmlFor="trip_target">Trip Target (auto-promotion threshold)</Label>
              <Input
                id="trip_target"
                type="number"
                min="0"
                value={formData.trip_target}
                onChange={(e) => setFormData(prev => ({ ...prev, trip_target: e.target.value }))}
                placeholder="e.g., 20"
              />
              <p className="text-xs text-muted-foreground mt-1">When a driver in this tier reaches this many completed trips, they auto-promote to the next active tier.</p>
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
    </>
  );
}
