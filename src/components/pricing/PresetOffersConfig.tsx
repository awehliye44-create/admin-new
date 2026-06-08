import { useEffect, useState, useCallback } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { Loader2, Plus, Trash2, Tag, Timer, Sparkles, Calendar, Clock } from 'lucide-react';
import { toast } from 'sonner';

interface PresetOffer {
  id?: string;
  offer_key: string;
  label: string;
  description: string;
  multiplier: number;
  fixed_amount_pence: number;
  icon: string;
  color: string;
  display_order: number;
  is_active: boolean;
}

interface OfferSchedule {
  enabled: boolean;
  days: number[]; // 1=Mon..7=Sun
  startLocalHHmm: string;
  endLocalHHmm: string;
}

interface PresetConfig {
  id?: string;
  is_enabled: boolean;
  price_mode: 'multiplier' | 'fixed';
  default_selected_offer_id: string;
  countdown_enabled: boolean;
  countdown_seconds: number;
  countdown_auto_select: boolean;
  countdown_auto_select_offer_id: string;
  schedule: OfferSchedule;
}

const DAY_LABELS = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 7, label: 'Sun' },
];

const DEFAULT_OFFERS: PresetOffer[] = [
  {
    offer_key: 'offer_1',
    label: 'Offer 1',
    description: '',
    multiplier: 1.0,
    fixed_amount_pence: 0,
    icon: 'tag',
    color: '#22C55E',
    display_order: 0,
    is_active: true,
  },
  {
    offer_key: 'offer_2',
    label: 'Offer 2',
    description: '',
    multiplier: 1.0,
    fixed_amount_pence: 0,
    icon: 'sparkles',
    color: '#3B82F6',
    display_order: 1,
    is_active: true,
  },
  {
    offer_key: 'offer_3',
    label: 'Offer 3',
    description: '',
    multiplier: 1.0,
    fixed_amount_pence: 0,
    icon: 'zap',
    color: '#F59E0B',
    display_order: 2,
    is_active: true,
  },
];

const DEFAULT_CONFIG: PresetConfig = {
  is_enabled: false,
  price_mode: 'multiplier',
  default_selected_offer_id: 'offer_2',
  countdown_enabled: false,
  countdown_seconds: 30,
  countdown_auto_select: false,
  countdown_auto_select_offer_id: 'offer_2',
  schedule: {
    enabled: false,
    days: [1, 2, 3, 4, 5, 6, 7],
    startLocalHHmm: '08:00',
    endLocalHHmm: '22:00',
  },
};

interface PresetOffersConfigProps {
  serviceAreaId: string;
  currencySymbol: string;
}

export function PresetOffersConfig({ serviceAreaId, currencySymbol }: PresetOffersConfigProps) {
  const [config, setConfig] = useState<PresetConfig>(DEFAULT_CONFIG);
  const [offers, setOffers] = useState<PresetOffer[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      const { data: configData } = await supabase
        .from('preset_offer_configs')
        .select('*')
        .eq('service_area_id', serviceAreaId)
        .maybeSingle();

      if (configData) {
        setConfig({
          id: configData.id,
          is_enabled: configData.is_enabled,
          price_mode: configData.price_mode as 'multiplier' | 'fixed',
          default_selected_offer_id: configData.default_selected_offer_id || 'recommended',
          countdown_enabled: configData.countdown_enabled,
          countdown_seconds: configData.countdown_seconds,
          countdown_auto_select: configData.countdown_auto_select,
          countdown_auto_select_offer_id: configData.countdown_auto_select_offer_id || 'recommended',
          schedule: {
            enabled: (configData as any).schedule_enabled ?? false,
            days: (configData as any).schedule_days ?? [1, 2, 3, 4, 5, 6, 7],
            startLocalHHmm: (configData as any).schedule_start_time ?? '08:00',
            endLocalHHmm: (configData as any).schedule_end_time ?? '22:00',
          },
        });

        const { data: offersData } = await supabase
          .from('preset_offers')
          .select('*')
          .eq('config_id', configData.id)
          .order('display_order');

        if (offersData && offersData.length > 0) {
          setOffers(offersData.map(o => ({
            id: o.id,
            offer_key: o.offer_key,
            label: o.label,
            description: o.description || '',
            multiplier: Number(o.multiplier),
            fixed_amount_pence: o.fixed_amount_pence || 0,
            icon: o.icon || 'tag',
            color: o.color || '#3B82F6',
            display_order: o.display_order,
            is_active: o.is_active,
          })));
        } else {
          setOffers(DEFAULT_OFFERS);
        }
      } else {
        setConfig(DEFAULT_CONFIG);
        setOffers(DEFAULT_OFFERS);
      }
    } catch (err) {
      console.error('Error loading preset offers:', err);
    } finally {
      setIsLoading(false);
    }
  }, [serviceAreaId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const updateConfig = (field: keyof PresetConfig, value: any) => {
    setConfig(prev => ({ ...prev, [field]: value }));
    setHasChanges(true);
  };

  const updateOffer = (index: number, field: keyof PresetOffer, value: any) => {
    setOffers(prev => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      return updated;
    });
    setHasChanges(true);
  };

  const addOffer = () => {
    const newOrder = offers.length;
    setOffers(prev => [...prev, {
      offer_key: `custom_${Date.now()}`,
      label: 'New Offer',
      description: '',
      multiplier: 1.0,
      fixed_amount_pence: 0,
      icon: 'tag',
      color: '#6B7280',
      display_order: newOrder,
      is_active: true,
    }]);
    setHasChanges(true);
  };

  const removeOffer = (index: number) => {
    if (offers.length <= 1) {
      toast.error('You need at least one offer');
      return;
    }
    setOffers(prev => prev.filter((_, i) => i !== index));
    setHasChanges(true);
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      let configId = config.id;

      // Upsert config
      if (configId) {
        await supabase
          .from('preset_offer_configs')
          .update({
            is_enabled: config.is_enabled,
            price_mode: config.price_mode,
            default_selected_offer_id: config.default_selected_offer_id,
            countdown_enabled: config.countdown_enabled,
            countdown_seconds: config.countdown_seconds,
            countdown_auto_select: config.countdown_auto_select,
            countdown_auto_select_offer_id: config.countdown_auto_select_offer_id,
            schedule_enabled: config.schedule.enabled,
            schedule_days: config.schedule.days,
            schedule_start_time: config.schedule.startLocalHHmm,
            schedule_end_time: config.schedule.endLocalHHmm,
          } as any)
          .eq('id', configId);
      } else {
        const { data: newConfig } = await supabase
          .from('preset_offer_configs')
          .insert({
            service_area_id: serviceAreaId,
            is_enabled: config.is_enabled,
            price_mode: config.price_mode,
            default_selected_offer_id: config.default_selected_offer_id,
            countdown_enabled: config.countdown_enabled,
            countdown_seconds: config.countdown_seconds,
            countdown_auto_select: config.countdown_auto_select,
            countdown_auto_select_offer_id: config.countdown_auto_select_offer_id,
            schedule_enabled: config.schedule.enabled,
            schedule_days: config.schedule.days,
            schedule_start_time: config.schedule.startLocalHHmm,
            schedule_end_time: config.schedule.endLocalHHmm,
          } as any)
          .select()
          .single();

        if (newConfig) {
          configId = newConfig.id;
          setConfig(prev => ({ ...prev, id: configId }));
        }
      }

      if (!configId) throw new Error('Failed to save config');

      // Delete existing offers and re-insert
      await supabase.from('preset_offers').delete().eq('config_id', configId);

      const offersToInsert = offers.map((o, i) => ({
        config_id: configId!,
        offer_key: o.offer_key,
        label: o.label,
        description: o.description,
        multiplier: o.multiplier,
        fixed_amount_pence: o.fixed_amount_pence,
        icon: o.icon,
        color: o.color,
        display_order: i,
        is_active: o.is_active,
      }));

      const { data: savedOffers } = await supabase
        .from('preset_offers')
        .insert(offersToInsert)
        .select();

      if (savedOffers) {
        setOffers(savedOffers.map(o => ({
          id: o.id,
          offer_key: o.offer_key,
          label: o.label,
          description: o.description || '',
          multiplier: Number(o.multiplier),
          fixed_amount_pence: o.fixed_amount_pence || 0,
          icon: o.icon || 'tag',
          color: o.color || '#3B82F6',
          display_order: o.display_order,
          is_active: o.is_active,
        })));
      }

      toast.success('Preset offers saved');
      setHasChanges(false);
    } catch (err: any) {
      console.error('Error saving preset offers:', err);
      toast.error(err.message || 'Failed to save preset offers');
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="p-6 flex items-center justify-center py-10">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
              <Sparkles className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h3 className="text-lg font-semibold">Preset Fare Offers</h3>
              <p className="text-sm text-muted-foreground">
                Configure 3 preset pricing options shown to drivers when a ride request comes in
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Switch
              checked={config.is_enabled}
              onCheckedChange={(v) => updateConfig('is_enabled', v)}
            />
            <Button onClick={handleSave} disabled={isSaving || !hasChanges} size="sm">
              {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Save Offers
            </Button>
          </div>
        </div>

        {config.is_enabled && (
          <>
            {/* Config settings */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-4 bg-muted/30 rounded-lg border">
              <div className="space-y-2">
                <Label>Price Mode</Label>
                <Select
                  value={config.price_mode}
                  onValueChange={(v) => updateConfig('price_mode', v)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="multiplier">Multiplier (e.g. 0.85x, 1.0x, 1.2x)</SelectItem>
                    <SelectItem value="fixed">Fixed Amount (pence)</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Multiplier applies to calculated fare; Fixed sets exact amounts
                </p>
              </div>

              <div className="space-y-2">
                <Label>Default Selected Offer</Label>
                <Select
                  value={config.default_selected_offer_id}
                  onValueChange={(v) => updateConfig('default_selected_offer_id', v)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {offers.map(o => (
                      <SelectItem key={o.offer_key} value={o.offer_key}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Pre-selected offer when the driver opens the offers panel
                </p>
              </div>
            </div>

            {/* Countdown settings */}
            <div className="p-4 bg-muted/30 rounded-lg border space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Timer className="h-4 w-4 text-muted-foreground" />
                  <Label className="font-medium">Countdown Timer</Label>
                </div>
                <Switch
                  checked={config.countdown_enabled}
                  onCheckedChange={(v) => updateConfig('countdown_enabled', v)}
                />
              </div>

              {config.countdown_enabled && (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="space-y-2">
                    <Label>Countdown Duration (seconds)</Label>
                    <Input
                      type="number"
                      min={5}
                      max={120}
                      value={config.countdown_seconds}
                      onChange={(e) => updateConfig('countdown_seconds', parseInt(e.target.value) || 30)}
                    />
                  </div>
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <Label>Auto-select on expiry</Label>
                      <Switch
                        checked={config.countdown_auto_select}
                        onCheckedChange={(v) => updateConfig('countdown_auto_select', v)}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Automatically accept the default offer when countdown ends
                    </p>
                  </div>
                  {config.countdown_auto_select && (
                    <div className="space-y-2">
                      <Label>Auto-select Offer</Label>
                      <Select
                        value={config.countdown_auto_select_offer_id}
                        onValueChange={(v) => updateConfig('countdown_auto_select_offer_id', v)}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {offers.map(o => (
                            <SelectItem key={o.offer_key} value={o.offer_key}>
                              {o.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Schedule Window */}
            <div className="p-4 bg-muted/30 rounded-lg border space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Calendar className="h-4 w-4 text-muted-foreground" />
                  <Label className="font-medium">Scheduled Availability Window</Label>
                </div>
                <Switch
                  checked={config.schedule.enabled}
                  onCheckedChange={(v) => setConfig(prev => ({
                    ...prev,
                    schedule: { ...prev.schedule, enabled: v }
                  }))}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                When enabled, preset offers are only available during the configured days and time window (using the service area timezone). Outside this window, drivers see standard fare only.
              </p>

              {config.schedule.enabled && (
                <div className="space-y-4">
                  {/* Days selection */}
                  <div className="space-y-2">
                    <Label className="text-sm">Active Days</Label>
                    <div className="flex flex-wrap gap-2">
                      {DAY_LABELS.map(day => (
                        <label
                          key={day.value}
                          className="flex items-center gap-1.5 cursor-pointer"
                        >
                          <Checkbox
                            checked={config.schedule.days.includes(day.value)}
                            onCheckedChange={(checked) => {
                              setConfig(prev => {
                                const days = checked
                                  ? [...prev.schedule.days, day.value].sort()
                                  : prev.schedule.days.filter(d => d !== day.value);
                                return {
                                  ...prev,
                                  schedule: { ...prev.schedule, days },
                                };
                              });
                              setHasChanges(true);
                            }}
                          />
                          <span className="text-sm">{day.label}</span>
                        </label>
                      ))}
                    </div>
                  </div>

                  {/* Time window */}
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label className="text-sm flex items-center gap-1">
                        <Clock className="h-3.5 w-3.5" />
                        Start Time (local)
                      </Label>
                      <Input
                        type="time"
                        value={config.schedule.startLocalHHmm}
                        onChange={(e) => {
                          setConfig(prev => ({
                            ...prev,
                            schedule: { ...prev.schedule, startLocalHHmm: e.target.value },
                          }));
                          setHasChanges(true);
                        }}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label className="text-sm flex items-center gap-1">
                        <Clock className="h-3.5 w-3.5" />
                        End Time (local)
                      </Label>
                      <Input
                        type="time"
                        value={config.schedule.endLocalHHmm}
                        onChange={(e) => {
                          setConfig(prev => ({
                            ...prev,
                            schedule: { ...prev.schedule, endLocalHHmm: e.target.value },
                          }));
                          setHasChanges(true);
                        }}
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Offers list */}
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h4 className="font-medium">Offer Options</h4>
                <Button variant="outline" size="sm" onClick={addOffer}>
                  <Plus className="mr-2 h-4 w-4" />
                  Add Offer
                </Button>
              </div>

              {offers.map((offer, index) => (
                <div
                  key={offer.offer_key}
                  className="p-4 border rounded-lg space-y-4"
                  style={{ borderLeftColor: offer.color, borderLeftWidth: 4 }}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Badge
                        style={{ backgroundColor: offer.color, color: 'white' }}
                      >
                        {offer.label}
                      </Badge>
                      <span className="text-sm text-muted-foreground">({offer.offer_key})</span>
                      {config.default_selected_offer_id === offer.offer_key && (
                        <Badge variant="outline" className="text-xs">Default</Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={offer.is_active}
                        onCheckedChange={(v) => updateOffer(index, 'is_active', v)}
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => removeOffer(index)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div className="space-y-1">
                      <Label className="text-xs">Label</Label>
                      <Input
                        value={offer.label}
                        onChange={(e) => updateOffer(index, 'label', e.target.value)}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Offer Key</Label>
                      <Input
                        value={offer.offer_key}
                        onChange={(e) => updateOffer(index, 'offer_key', e.target.value)}
                      />
                    </div>
                    {config.price_mode === 'multiplier' ? (
                      <div className="space-y-1">
                        <Label className="text-xs">Multiplier</Label>
                        <Input
                          type="number"
                          step="0.01"
                          min="0.01"
                          value={offer.multiplier}
                          onChange={(e) => updateOffer(index, 'multiplier', parseFloat(e.target.value) || 1)}
                        />
                        <p className="text-xs text-muted-foreground">
                          {offer.multiplier < 1 ? `${((1 - offer.multiplier) * 100).toFixed(0)}% discount` :
                           offer.multiplier > 1 ? `${((offer.multiplier - 1) * 100).toFixed(0)}% surcharge` :
                           'Standard fare'}
                        </p>
                      </div>
                    ) : (
                      <div className="space-y-1">
                        <Label className="text-xs">Fixed Amount ({currencySymbol})</Label>
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          value={(offer.fixed_amount_pence / 100).toFixed(2)}
                          onChange={(e) => updateOffer(index, 'fixed_amount_pence', Math.round((parseFloat(e.target.value) || 0) * 100))}
                        />
                      </div>
                    )}
                    <div className="space-y-1">
                      <Label className="text-xs">Color</Label>
                      <div className="flex items-center gap-2">
                        <input
                          type="color"
                          value={offer.color}
                          onChange={(e) => updateOffer(index, 'color', e.target.value)}
                          className="w-8 h-8 rounded border cursor-pointer"
                        />
                        <Input
                          value={offer.color}
                          onChange={(e) => updateOffer(index, 'color', e.target.value)}
                          className="flex-1"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="space-y-1">
                    <Label className="text-xs">Description</Label>
                    <Input
                      value={offer.description}
                      onChange={(e) => updateOffer(index, 'description', e.target.value)}
                      placeholder="Short description shown to driver"
                    />
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
