import { useEffect, useState, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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

interface ServiceAreaDriverTier {
  id: string;
  service_area_id: string;
  tier_name: string;
  category_priority: number;
  commission_percent: number;
  trip_target: number | null;
  is_active: boolean;
  display_order: number;
}

const TIER_ICONS: Record<string, typeof Star> = {
  shield: Shield,
  star: Star,
  crown: Crown,
  sparkles: Sparkles,
};

const TIER_COLORS: Record<string, string> = {
  bronze: '#CD7F32',
  silver: '#C0C0C0',
  gold: '#FFD700',
  platinum: '#E5E4E2',
  diamond: '#B9F2FF',
};

interface ServiceAreaDriverTiersConfigProps {
  serviceAreaId: string;
  serviceAreaName?: string;
}

export function ServiceAreaDriverTiersConfig({
  serviceAreaId,
  serviceAreaName,
}: ServiceAreaDriverTiersConfigProps) {
  const [tiers, setTiers] = useState<ServiceAreaDriverTier[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [selectedTier, setSelectedTier] = useState<ServiceAreaDriverTier | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const [formData, setFormData] = useState({
    category_priority: '',
    commission_percent: '',
    trip_target: '',
    is_active: true,
    display_order: '',
  });

  const fetchTiers = useCallback(async () => {
    if (!serviceAreaId) return;

    try {
      setIsLoading(true);
      const { data, error } = await supabase
        .from('service_area_driver_tiers')
        .select('*')
        .eq('service_area_id', serviceAreaId)
        .order('display_order', { ascending: true });

      if (error) throw error;
      setTiers((data as ServiceAreaDriverTier[]) || []);
    } catch (err) {
      console.error('Error fetching service area tiers:', err);
      toast.error('Failed to load driver tiers for this service area');
    } finally {
      setIsLoading(false);
    }
  }, [serviceAreaId]);

  useEffect(() => {
    fetchTiers();
  }, [fetchTiers]);

  const openEditDialog = (tier: ServiceAreaDriverTier) => {
    setSelectedTier(tier);
    setFormData({
      category_priority: tier.category_priority?.toString() || '10',
      commission_percent: tier.commission_percent?.toString() || '',
      trip_target: tier.trip_target?.toString() || '',
      is_active: tier.is_active,
      display_order: tier.display_order?.toString() || '',
    });
    setIsFormOpen(true);
  };

  const handleSave = async () => {
    if (!selectedTier) return;

    setIsSaving(true);
    try {
      const updateData = {
        category_priority: formData.category_priority ? parseInt(formData.category_priority, 10) : 10,
        commission_percent: formData.commission_percent ? parseFloat(formData.commission_percent) : 0,
        trip_target: formData.trip_target ? parseInt(formData.trip_target, 10) : null,
        is_active: formData.is_active,
        display_order: formData.display_order
          ? parseInt(formData.display_order, 10)
          : selectedTier.display_order,
      };

      const { error } = await supabase
        .from('service_area_driver_tiers')
        .update(updateData)
        .eq('id', selectedTier.id)
        .eq('service_area_id', serviceAreaId);

      if (error) throw error;
      toast.success(`${selectedTier.tier_name} tier updated for ${serviceAreaName ?? 'service area'}`);
      setIsFormOpen(false);
      fetchTiers();
    } catch (err: unknown) {
      console.error('Error saving tier:', err);
      toast.error(err instanceof Error ? err.message : 'Failed to save tier');
    } finally {
      setIsSaving(false);
    }
  };

  const getIconForTier = (tierName: string) => {
    const key = tierName.toLowerCase();
    if (key === 'gold') return Star;
    if (key === 'platinum') return Crown;
    if (key === 'diamond') return Sparkles;
    return Shield;
  };

  const getColorForTier = (tierName: string) =>
    TIER_COLORS[tierName.toLowerCase()] || '#3B82F6';

  return (
    <>
      <Card className="border-primary/50">
        <CardHeader className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <Crown className="h-5 w-5 text-primary" />
            <div>
              <CardTitle>Driver Tiers Configuration</CardTitle>
              <CardDescription>
                Per service area: commission rates, dispatch priority, and auto-promotion targets
                {serviceAreaName ? ` for ${serviceAreaName}` : ''}
              </CardDescription>
            </div>
            <Badge className="ml-2 bg-primary text-primary-foreground">SSOT</Badge>
          </div>
          <Button variant="outline" size="sm" onClick={fetchTiers} disabled={isLoading}>
            <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-start gap-2 p-3 bg-muted/50 rounded-lg">
            <Info className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
            <div className="text-sm text-muted-foreground">
              <p>
                <strong>Commission %</strong> is resolved at trip settlement from this service area
                and the driver&apos;s current tier (Bronze → Diamond).
              </p>
              <p className="mt-1">
                <strong>Category Priority</strong> feeds dispatch scoring for trips in this service area.
              </p>
              <p className="mt-1">
                <strong>Trip Target</strong> triggers automatic tier promotion when a driver completes
                enough trips — upgrades only, never demotions.
              </p>
            </div>
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          ) : tiers.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <p>No tier configuration found for this service area.</p>
              <p className="text-sm mt-1">Run the service_area_driver_tiers migration to backfill tiers.</p>
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
                  const IconComponent = getIconForTier(tier.tier_name);
                  const color = getColorForTier(tier.tier_name);
                  return (
                    <TableRow key={tier.id}>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <div
                            className="h-10 w-10 rounded-lg flex items-center justify-center"
                            style={{ backgroundColor: `${color}20` }}
                          >
                            <IconComponent className="h-5 w-5" style={{ color }} />
                          </div>
                          <div className="font-medium">{tier.tier_name}</div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="font-mono">
                          {tier.category_priority}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="font-mono">
                          {tier.commission_percent}%
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
                      <TableCell className="text-muted-foreground">{tier.display_order}</TableCell>
                      <TableCell className="text-right">
                        <Button variant="ghost" size="icon" onClick={() => openEditDialog(tier)}>
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

      <Dialog open={isFormOpen} onOpenChange={setIsFormOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Edit {selectedTier?.tier_name} Tier</DialogTitle>
            <DialogDescription>
              Updates apply only to {serviceAreaName ?? 'this service area'}
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
                onChange={(e) => setFormData((prev) => ({ ...prev, category_priority: e.target.value }))}
              />
              <p className="text-xs text-muted-foreground mt-1">
                Higher value = higher ranking in dispatch scoring for this service area
              </p>
            </div>
            <div>
              <Label htmlFor="commission_percent">Commission %</Label>
              <Input
                id="commission_percent"
                type="number"
                step="0.5"
                min="0"
                max="100"
                value={formData.commission_percent}
                onChange={(e) => setFormData((prev) => ({ ...prev, commission_percent: e.target.value }))}
              />
              <p className="text-xs text-muted-foreground mt-1">
                Applied to commissionable subtotal on trip completion in this service area
              </p>
            </div>
            <div>
              <Label htmlFor="trip_target">Trip Target (auto-promotion threshold)</Label>
              <Input
                id="trip_target"
                type="number"
                min="0"
                value={formData.trip_target}
                onChange={(e) => setFormData((prev) => ({ ...prev, trip_target: e.target.value }))}
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
                  onChange={(e) => setFormData((prev) => ({ ...prev, display_order: e.target.value }))}
                  className="w-20"
                />
              </div>
              <div className="flex items-center gap-2 pt-5">
                <Switch
                  id="is_active"
                  checked={formData.is_active}
                  onCheckedChange={(checked) => setFormData((prev) => ({ ...prev, is_active: checked }))}
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
