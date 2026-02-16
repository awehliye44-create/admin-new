import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
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
import { Zap, Plus, Trash2, Loader2, Save, GripVertical } from 'lucide-react';
import { toast } from 'sonner';

interface PresetOffer {
  id?: string;
  offer_key: string;
  label: string;
  enabled: boolean;
  sort_order: number;
  multiplier: number;
  rounding_step: number;
  rounding_mode: string;
  fixed_base: number;
  fixed_per_km: number;
  fixed_per_min: number;
  fixed_min_fare: number;
  fixed_booking_fee: number;
}

interface PresetOfferConfig {
  id?: string;
  enabled: boolean;
  mode: 'fixed' | 'multiplier';
  currency: string;
  show_badges: boolean;
  default_selected_offer_id: string;
}

interface PresetOffersConfigProps {
  serviceAreaId: string;
  currencyCode: string;
  currencySymbol: string;
  distanceLabel: string;
}

const DEFAULT_OFFERS: PresetOffer[] = [
  {
    offer_key: 'cheapest',
    label: 'Cheaper',
    enabled: true,
    sort_order: 0,
    multiplier: 0.90,
    rounding_step: 0.10,
    rounding_mode: 'nearest',
    fixed_base: 3.00,
    fixed_per_km: 1.00,
    fixed_per_min: 0.15,
    fixed_min_fare: 4.00,
    fixed_booking_fee: 0.50,
  },
  {
    offer_key: 'recommended',
    label: 'Recommended',
    enabled: true,
    sort_order: 1,
    multiplier: 1.00,
    rounding_step: 0.10,
    rounding_mode: 'nearest',
    fixed_base: 4.00,
    fixed_per_km: 1.50,
    fixed_per_min: 0.20,
    fixed_min_fare: 5.00,
    fixed_booking_fee: 1.00,
  },
  {
    offer_key: 'faster',
    label: 'Faster',
    enabled: true,
    sort_order: 2,
    multiplier: 1.20,
    rounding_step: 0.10,
    rounding_mode: 'nearest',
    fixed_base: 5.00,
    fixed_per_km: 2.00,
    fixed_per_min: 0.30,
    fixed_min_fare: 6.00,
    fixed_booking_fee: 1.50,
  },
];

export function PresetOffersConfig({
  serviceAreaId,
  currencyCode,
  currencySymbol,
  distanceLabel,
}: PresetOffersConfigProps) {
  const [config, setConfig] = useState<PresetOfferConfig>({
    enabled: false,
    mode: 'multiplier',
    currency: currencyCode,
    show_badges: true,
    default_selected_offer_id: 'recommended',
  });
  const [offers, setOffers] = useState<PresetOffer[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [deleteOfferId, setDeleteOfferId] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      setIsLoading(true);

      // Fetch config
      const { data: configData, error: configError } = await supabase
        .from('preset_offer_configs')
        .select('*')
        .eq('service_area_id', serviceAreaId)
        .maybeSingle();

      if (configError) throw configError;

      if (configData) {
        setConfig({
          id: configData.id,
          enabled: configData.enabled,
          mode: configData.mode as 'fixed' | 'multiplier',
          currency: configData.currency,
          show_badges: configData.show_badges,
          default_selected_offer_id: configData.default_selected_offer_id || 'recommended',
        });

        // Fetch offers
        const { data: offersData, error: offersError } = await supabase
          .from('preset_offers')
          .select('*')
          .eq('config_id', configData.id)
          .order('sort_order');

        if (offersError) throw offersError;

        if (offersData && offersData.length > 0) {
          setOffers(offersData.map(o => ({
            id: o.id,
            offer_key: o.offer_key,
            label: o.label,
            enabled: o.enabled,
            sort_order: o.sort_order,
            multiplier: Number(o.multiplier),
            rounding_step: Number(o.rounding_step),
            rounding_mode: o.rounding_mode || 'nearest',
            fixed_base: Number(o.fixed_base),
            fixed_per_km: Number(o.fixed_per_km),
            fixed_per_min: Number(o.fixed_per_min),
            fixed_min_fare: Number(o.fixed_min_fare),
            fixed_booking_fee: Number(o.fixed_booking_fee),
          })));
        } else {
          setOffers([]);
        }
      } else {
        setConfig(prev => ({ ...prev, currency: currencyCode }));
        setOffers([]);
      }
    } catch (err) {
      console.error('Error fetching preset offers:', err);
      toast.error('Failed to load preset offers');
    } finally {
      setIsLoading(false);
    }
  }, [serviceAreaId, currencyCode]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleSave = async () => {
    try {
      setIsSaving(true);

      // Upsert config
      let configId = config.id;
      if (configId) {
        const { error } = await supabase
          .from('preset_offer_configs')
          .update({
            enabled: config.enabled,
            mode: config.mode,
            currency: config.currency,
            show_badges: config.show_badges,
            default_selected_offer_id: config.default_selected_offer_id,
          })
          .eq('id', configId);
        if (error) throw error;
      } else {
        const { data, error } = await supabase
          .from('preset_offer_configs')
          .insert({
            service_area_id: serviceAreaId,
            enabled: config.enabled,
            mode: config.mode,
            currency: config.currency,
            show_badges: config.show_badges,
            default_selected_offer_id: config.default_selected_offer_id,
          })
          .select('id')
          .single();
        if (error) throw error;
        configId = data.id;
        setConfig(prev => ({ ...prev, id: configId }));
      }

      // Upsert offers
      for (const offer of offers) {
        const offerData = {
          config_id: configId!,
          offer_key: offer.offer_key,
          label: offer.label,
          enabled: offer.enabled,
          sort_order: offer.sort_order,
          multiplier: offer.multiplier,
          rounding_step: offer.rounding_step,
          rounding_mode: offer.rounding_mode,
          fixed_base: offer.fixed_base,
          fixed_per_km: offer.fixed_per_km,
          fixed_per_min: offer.fixed_per_min,
          fixed_min_fare: offer.fixed_min_fare,
          fixed_booking_fee: offer.fixed_booking_fee,
        };

        if (offer.id) {
          const { error } = await supabase
            .from('preset_offers')
            .update(offerData)
            .eq('id', offer.id);
          if (error) throw error;
        } else {
          const { data, error } = await supabase
            .from('preset_offers')
            .insert(offerData)
            .select('id')
            .single();
          if (error) throw error;
          offer.id = data.id;
        }
      }

      setHasChanges(false);
      toast.success('Preset offers saved successfully');
    } catch (err) {
      console.error('Error saving preset offers:', err);
      toast.error('Failed to save preset offers');
    } finally {
      setIsSaving(false);
    }
  };

  const addDefaultOffers = () => {
    setOffers(DEFAULT_OFFERS);
    setHasChanges(true);
  };

  const addOffer = () => {
    const nextOrder = offers.length > 0 ? Math.max(...offers.map(o => o.sort_order)) + 1 : 0;
    setOffers(prev => [...prev, {
      offer_key: `custom_${nextOrder}`,
      label: 'Custom Offer',
      enabled: true,
      sort_order: nextOrder,
      multiplier: 1.00,
      rounding_step: 0.10,
      rounding_mode: 'nearest',
      fixed_base: 0,
      fixed_per_km: 0,
      fixed_per_min: 0,
      fixed_min_fare: 0,
      fixed_booking_fee: 0,
    }]);
    setHasChanges(true);
  };

  const removeOffer = async (index: number) => {
    const offer = offers[index];
    if (offer.id) {
      const { error } = await supabase
        .from('preset_offers')
        .delete()
        .eq('id', offer.id);
      if (error) {
        toast.error('Failed to delete offer');
        return;
      }
    }
    setOffers(prev => prev.filter((_, i) => i !== index));
    setHasChanges(true);
    setDeleteOfferId(null);
  };

  const updateOffer = (index: number, field: keyof PresetOffer, value: any) => {
    setOffers(prev => prev.map((o, i) => i === index ? { ...o, [field]: value } : o));
    setHasChanges(true);
  };

  const updateConfig = (field: keyof PresetOfferConfig, value: any) => {
    setConfig(prev => ({ ...prev, [field]: value }));
    setHasChanges(true);
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="p-6 flex items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card className="mb-6">
        <CardContent className="p-6">
          {/* Header with toggle */}
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
                <Zap className="h-5 w-5 text-primary" />
              </div>
              <div>
                <h3 className="text-lg font-semibold">Preset Offers</h3>
                <p className="text-sm text-muted-foreground">
                  Configure fixed price suggestions shown to drivers and riders
                </p>
              </div>
            </div>
            <div className="flex items-center gap-4">
              {hasChanges && (
                <Button onClick={handleSave} disabled={isSaving} size="sm">
                  {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                  Save
                </Button>
              )}
              <div className="flex flex-col items-end gap-1">
                <div className="flex items-center gap-2">
                  <Label htmlFor="preset-enabled" className="text-sm">Enabled</Label>
                  <Switch
                    id="preset-enabled"
                    checked={config.enabled}
                    onCheckedChange={(v) => updateConfig('enabled', v)}
                  />
                </div>
                <p className="text-xs text-muted-foreground">When off, no preset offer chips are shown in the app.</p>
              </div>
            </div>
          </div>

          {config.enabled && (
            <div className="space-y-6">
              {/* Config settings */}
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4 p-4 bg-muted/30 rounded-lg">
                <div className="space-y-2">
                  <Label>Pricing Mode</Label>
                  <Select
                    value={config.mode}
                    onValueChange={(v) => updateConfig('mode', v)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="multiplier">Multiplier (× base fare)</SelectItem>
                      <SelectItem value="fixed">Fixed Prices</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">Multiplier applies a factor to the computed base fare. Fixed uses absolute per-km/per-min rates.</p>
                </div>
                <div className="space-y-2">
                  <Label>Currency</Label>
                  <Input value={config.currency} disabled className="bg-muted" />
                  <p className="text-xs text-muted-foreground">Inherited from the service area's region currency.</p>
                </div>
                <div className="space-y-2">
                  <Label>Default Selected</Label>
                  <Select
                    value={config.default_selected_offer_id}
                    onValueChange={(v) => updateConfig('default_selected_offer_id', v)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {offers.filter(o => o.enabled).map(o => (
                        <SelectItem key={o.offer_key} value={o.offer_key}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">The offer pre-selected by default when chips are shown to drivers/riders.</p>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Switch
                      id="show-badges"
                      checked={config.show_badges}
                      onCheckedChange={(v) => updateConfig('show_badges', v)}
                    />
                    <Label htmlFor="show-badges" className="text-sm">Show Badges</Label>
                  </div>
                  <p className="text-xs text-muted-foreground">Display visual badges (e.g. "Best Value") on offer chips in the app.</p>
                </div>
              </div>

              {/* Offers table */}
              {offers.length === 0 ? (
                <div className="text-center py-8 border rounded-lg border-dashed">
                  <Zap className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
                  <p className="text-sm text-muted-foreground mb-3">No preset offers configured</p>
                  <div className="flex items-center justify-center gap-2">
                    <Button variant="outline" size="sm" onClick={addDefaultOffers}>
                      Add Default Offers (Cheaper / Recommended / Faster)
                    </Button>
                    <Button variant="outline" size="sm" onClick={addOffer}>
                      <Plus className="mr-1 h-4 w-4" />
                      Add Custom
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="border rounded-lg overflow-hidden">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-10">
                            <span title="Sort order — lower numbers appear first">#</span>
                          </TableHead>
                          <TableHead>
                            <span title="Unique identifier used in API responses">Key</span>
                          </TableHead>
                          <TableHead>
                            <span title="Display name shown on the offer chip">Label</span>
                          </TableHead>
                          <TableHead className="w-20">
                            <span title="Toggle this offer on/off without deleting it">Enabled</span>
                          </TableHead>
                          {config.mode === 'multiplier' ? (
                            <>
                              <TableHead>
                                <span title="Factor applied to base fare (e.g. 0.90 = 10% cheaper)">Multiplier</span>
                              </TableHead>
                              <TableHead>
                                <span title="Round the final price to the nearest step (e.g. 0.10 = nearest 10p)">Rounding</span>
                              </TableHead>
                              <TableHead>
                                <span title="Rounding direction: nearest, always up, or always down">Mode</span>
                              </TableHead>
                            </>
                          ) : (
                            <>
                              <TableHead>
                                <span title="Base fare charged before distance/time">Base ({currencySymbol})</span>
                              </TableHead>
                              <TableHead>
                                <span title="Rate charged per unit of distance">Per {distanceLabel} ({currencySymbol})</span>
                              </TableHead>
                              <TableHead>
                                <span title="Rate charged per minute of travel time">Per Min ({currencySymbol})</span>
                              </TableHead>
                              <TableHead>
                                <span title="Minimum fare — the lowest amount this offer can charge">Min Fare ({currencySymbol})</span>
                              </TableHead>
                              <TableHead>
                                <span title="Flat fee added on top of the calculated fare">Booking Fee ({currencySymbol})</span>
                              </TableHead>
                            </>
                          )}
                          <TableHead className="w-10"></TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {offers.sort((a, b) => a.sort_order - b.sort_order).map((offer, index) => (
                          <TableRow key={offer.offer_key + index}>
                            <TableCell>
                              <Input
                                type="number"
                                className="w-14 h-8"
                                value={offer.sort_order}
                                onChange={e => updateOffer(index, 'sort_order', parseInt(e.target.value) || 0)}
                              />
                            </TableCell>
                            <TableCell>
                              <Input
                                className="h-8 w-28"
                                value={offer.offer_key}
                                onChange={e => updateOffer(index, 'offer_key', e.target.value)}
                              />
                            </TableCell>
                            <TableCell>
                              <Input
                                className="h-8 w-32"
                                value={offer.label}
                                onChange={e => updateOffer(index, 'label', e.target.value)}
                              />
                            </TableCell>
                            <TableCell>
                              <Switch
                                checked={offer.enabled}
                                onCheckedChange={v => updateOffer(index, 'enabled', v)}
                              />
                            </TableCell>
                            {config.mode === 'multiplier' ? (
                              <>
                                <TableCell>
                                  <Input
                                    type="number"
                                    step="0.01"
                                    className="h-8 w-20"
                                    value={offer.multiplier}
                                    onChange={e => updateOffer(index, 'multiplier', parseFloat(e.target.value) || 0)}
                                  />
                                </TableCell>
                                <TableCell>
                                  <Input
                                    type="number"
                                    step="0.01"
                                    className="h-8 w-20"
                                    value={offer.rounding_step}
                                    onChange={e => updateOffer(index, 'rounding_step', parseFloat(e.target.value) || 0)}
                                  />
                                </TableCell>
                                <TableCell>
                                  <Select
                                    value={offer.rounding_mode}
                                    onValueChange={v => updateOffer(index, 'rounding_mode', v)}
                                  >
                                    <SelectTrigger className="h-8 w-24">
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="nearest">Nearest</SelectItem>
                                      <SelectItem value="up">Up</SelectItem>
                                      <SelectItem value="down">Down</SelectItem>
                                    </SelectContent>
                                  </Select>
                                </TableCell>
                              </>
                            ) : (
                              <>
                                <TableCell>
                                  <Input
                                    type="number"
                                    step="0.01"
                                    className="h-8 w-20"
                                    value={offer.fixed_base}
                                    onChange={e => updateOffer(index, 'fixed_base', parseFloat(e.target.value) || 0)}
                                  />
                                </TableCell>
                                <TableCell>
                                  <Input
                                    type="number"
                                    step="0.01"
                                    className="h-8 w-20"
                                    value={offer.fixed_per_km}
                                    onChange={e => updateOffer(index, 'fixed_per_km', parseFloat(e.target.value) || 0)}
                                  />
                                </TableCell>
                                <TableCell>
                                  <Input
                                    type="number"
                                    step="0.01"
                                    className="h-8 w-20"
                                    value={offer.fixed_per_min}
                                    onChange={e => updateOffer(index, 'fixed_per_min', parseFloat(e.target.value) || 0)}
                                  />
                                </TableCell>
                                <TableCell>
                                  <Input
                                    type="number"
                                    step="0.01"
                                    className="h-8 w-20"
                                    value={offer.fixed_min_fare}
                                    onChange={e => updateOffer(index, 'fixed_min_fare', parseFloat(e.target.value) || 0)}
                                  />
                                </TableCell>
                                <TableCell>
                                  <Input
                                    type="number"
                                    step="0.01"
                                    className="h-8 w-20"
                                    value={offer.fixed_booking_fee}
                                    onChange={e => updateOffer(index, 'fixed_booking_fee', parseFloat(e.target.value) || 0)}
                                  />
                                </TableCell>
                              </>
                            )}
                            <TableCell>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                                onClick={() => setDeleteOfferId(String(index))}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>

                  <div className="flex items-center justify-between">
                    <Button variant="outline" size="sm" onClick={addOffer}>
                      <Plus className="mr-1 h-4 w-4" />
                      Add Offer
                    </Button>
                    {offers.length > 0 && (
                      <div className="flex items-center gap-2">
                        {offers.filter(o => o.enabled).map(o => (
                          <Badge
                            key={o.offer_key}
                            variant={o.offer_key === config.default_selected_offer_id ? 'default' : 'outline'}
                            className="text-xs"
                          >
                            {o.label}
                            {config.mode === 'multiplier' && (
                              <span className="ml-1 opacity-70">×{o.multiplier}</span>
                            )}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Delete confirmation */}
      <AlertDialog open={deleteOfferId !== null} onOpenChange={() => setDeleteOfferId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Offer</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to remove this preset offer? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteOfferId !== null && removeOffer(parseInt(deleteOfferId))}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
