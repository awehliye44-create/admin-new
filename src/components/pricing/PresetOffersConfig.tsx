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
import { Loader2, Timer, Sparkles, Calendar, Clock } from 'lucide-react';
import { toast } from 'sonner';

const PRESET_SLOT_COUNT = 3;
const SLOT_KEYS = ['offer_1', 'offer_2', 'offer_3'] as const;
const SLOT_TITLES = ['Preset 1', 'Preset 2', 'Preset 3'] as const;

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
  days: number[];
  startLocalHHmm: string;
  endLocalHHmm: string;
}

interface PresetConfig {
  id?: string;
  is_enabled: boolean;
  price_mode: 'multiplier' | 'fixed';
  countdown_enabled: boolean;
  countdown_seconds: number;
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

const SLOT_COLORS = ['#22C55E', '#3B82F6', '#F59E0B'] as const;

function emptySlot(index: number): PresetOffer {
  return {
    offer_key: SLOT_KEYS[index],
    label: SLOT_TITLES[index],
    description: '',
    multiplier: 1.0,
    fixed_amount_pence: 0,
    icon: 'tag',
    color: SLOT_COLORS[index],
    display_order: index,
    is_active: true,
  };
}

function padToThreeSlots(rows: PresetOffer[]): PresetOffer[] {
  const ordered = [...rows].sort((a, b) => a.display_order - b.display_order);
  const slots: PresetOffer[] = [];
  for (let i = 0; i < PRESET_SLOT_COUNT; i++) {
    const existing = ordered[i];
    slots.push(existing ? { ...existing, display_order: i } : emptySlot(i));
  }
  return slots;
}

const DEFAULT_CONFIG: PresetConfig = {
  is_enabled: false,
  price_mode: 'multiplier',
  countdown_enabled: false,
  countdown_seconds: 30,
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
  const [offers, setOffers] = useState<PresetOffer[]>(() => padToThreeSlots([]));
  const [legacyExcessCount, setLegacyExcessCount] = useState(0);
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
        const seconds = Number(configData.countdown_seconds);
        setConfig({
          id: configData.id,
          is_enabled: configData.is_enabled,
          price_mode: configData.price_mode === 'fixed' ? 'fixed' : 'multiplier',
          countdown_enabled: configData.countdown_enabled,
          countdown_seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : 30,
          schedule: {
            enabled: (configData as { schedule_enabled?: boolean }).schedule_enabled ?? false,
            days: (configData as { schedule_days?: number[] }).schedule_days ?? [1, 2, 3, 4, 5, 6, 7],
            startLocalHHmm: (configData as { schedule_start_time?: string }).schedule_start_time ?? '08:00',
            endLocalHHmm: (configData as { schedule_end_time?: string }).schedule_end_time ?? '22:00',
          },
        });

        const { data: offersData } = await supabase
          .from('preset_offers')
          .select('*')
          .eq('config_id', configData.id)
          .order('display_order');

        const mapped = (offersData ?? []).map((o) => ({
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
        }));
        setLegacyExcessCount(Math.max(0, mapped.length - PRESET_SLOT_COUNT));
        setOffers(padToThreeSlots(mapped));
      } else {
        setConfig(DEFAULT_CONFIG);
        setOffers(padToThreeSlots([]));
        setLegacyExcessCount(0);
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

  const updateConfig = (field: keyof PresetConfig, value: unknown) => {
    setConfig((prev) => ({ ...prev, [field]: value }));
    setHasChanges(true);
  };

  const updateSchedule = (patch: Partial<OfferSchedule>) => {
    setConfig((prev) => ({
      ...prev,
      schedule: { ...prev.schedule, ...patch },
    }));
    setHasChanges(true);
  };

  const updateOffer = (index: number, field: keyof PresetOffer, value: unknown) => {
    setOffers((prev) => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      return updated;
    });
    setHasChanges(true);
  };

  const handleSave = async () => {
    const slots = padToThreeSlots(offers);
    if (slots.length !== PRESET_SLOT_COUNT) {
      toast.error('Exactly 3 preset slots are required');
      return;
    }

    setIsSaving(true);
    try {
      let configId = config.id;

      const configPayload = {
        is_enabled: config.is_enabled,
        price_mode: config.price_mode,
        countdown_enabled: config.countdown_enabled,
        countdown_seconds: Math.min(120, Math.max(5, Math.round(Number(config.countdown_seconds) || 30))),
        countdown_auto_select: false,
        schedule_enabled: config.schedule.enabled,
        schedule_days: config.schedule.days,
        schedule_start_time: config.schedule.startLocalHHmm,
        schedule_end_time: config.schedule.endLocalHHmm,
      };

      if (configId) {
        const { error } = await supabase
          .from('preset_offer_configs')
          .update(configPayload as never)
          .eq('id', configId);
        if (error) throw error;
      } else {
        const { data: newConfig, error } = await supabase
          .from('preset_offer_configs')
          .insert({
            service_area_id: serviceAreaId,
            ...configPayload,
          } as never)
          .select()
          .single();
        if (error) throw error;
        if (newConfig) {
          configId = newConfig.id;
          setConfig((prev) => ({ ...prev, id: configId }));
        }
      }

      if (!configId) throw new Error('Failed to save config');

      const savedSlots: PresetOffer[] = [];
      for (let i = 0; i < PRESET_SLOT_COUNT; i++) {
        const slot = slots[i];
        const row = {
          config_id: configId,
          offer_key: slot.offer_key || SLOT_KEYS[i],
          label: slot.label || SLOT_TITLES[i],
          description: slot.description,
          multiplier: slot.multiplier,
          fixed_amount_pence: slot.fixed_amount_pence,
          icon: slot.icon,
          color: slot.color,
          display_order: i,
          is_active: slot.is_active,
        };

        if (slot.id) {
          const { data, error } = await supabase
            .from('preset_offers')
            .update(row as never)
            .eq('id', slot.id)
            .select()
            .single();
          if (error) throw error;
          savedSlots.push({
            id: data.id,
            offer_key: data.offer_key,
            label: data.label,
            description: data.description || '',
            multiplier: Number(data.multiplier),
            fixed_amount_pence: data.fixed_amount_pence || 0,
            icon: data.icon || 'tag',
            color: data.color || '#3B82F6',
            display_order: data.display_order,
            is_active: data.is_active,
          });
        } else {
          const { data, error } = await supabase
            .from('preset_offers')
            .insert(row as never)
            .select()
            .single();
          if (error) throw error;
          savedSlots.push({
            id: data.id,
            offer_key: data.offer_key,
            label: data.label,
            description: data.description || '',
            multiplier: Number(data.multiplier),
            fixed_amount_pence: data.fixed_amount_pence || 0,
            icon: data.icon || 'tag',
            color: data.color || '#3B82F6',
            display_order: data.display_order,
            is_active: data.is_active,
          });
        }
      }

      const { count } = await supabase
        .from('preset_offers')
        .select('id', { count: 'exact', head: true })
        .eq('config_id', configId);

      setOffers(padToThreeSlots(savedSlots));
      setLegacyExcessCount(Math.max(0, (count ?? savedSlots.length) - PRESET_SLOT_COUNT));
      toast.success('Preset offers saved');
      setHasChanges(false);
    } catch (err: unknown) {
      console.error('Error saving preset offers:', err);
      const message = err instanceof Error ? err.message : 'Failed to save preset offers';
      toast.error(message);
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
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
              <Sparkles className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h3 className="text-lg font-semibold">Preset Fare Offers</h3>
              <p className="text-sm text-muted-foreground">
                Exactly 3 Admin-configured slots. Backend calculates chip fares from the original trip fare. Scheduled bookings never use these offers.
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

        {legacyExcessCount > 0 && (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            This service area has {legacyExcessCount} extra stored offer row{legacyExcessCount === 1 ? '' : 's'} beyond the 3 slots.
            Dispatch uses only the first 3 by display order. Extra rows were not deleted.
          </div>
        )}

        {config.is_enabled && (
          <>
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
                    <SelectItem value="multiplier">Percentage (% of fare)</SelectItem>
                    <SelectItem value="fixed">Fixed Amount (pence)</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Percentage: chip = original fare × (percent / 100). 100 keeps the original fare.
                  Fixed: chip = original fare + adjustment pence. 50 = +{currencySymbol}0.50.
                </p>
              </div>
            </div>

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
              <p className="text-xs text-muted-foreground">
                Driver offer countdown for this service area. Expiry fails the offer and rebroadcasts at the customer-committed fare. It does not auto-accept a negotiation.
              </p>

              {config.countdown_enabled && (
                <div className="space-y-2 max-w-xs">
                  <Label>Countdown Duration (seconds)</Label>
                  <Input
                    type="number"
                    min={5}
                    max={120}
                    value={config.countdown_seconds}
                    onChange={(e) => {
                      const parsed = parseInt(e.target.value, 10);
                      updateConfig(
                        'countdown_seconds',
                        Number.isFinite(parsed) ? parsed : 30,
                      );
                    }}
                  />
                </div>
              )}
            </div>

            <div className="p-4 bg-muted/30 rounded-lg border space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Calendar className="h-4 w-4 text-muted-foreground" />
                  <Label className="font-medium">Scheduled Availability Window</Label>
                </div>
                <Switch
                  checked={config.schedule.enabled}
                  onCheckedChange={(v) => updateSchedule({ enabled: v })}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                When enabled, preset negotiation is available only during these days and times in the service area timezone, for instant/on-demand trips. Outside this window, drivers receive the standard fare. Scheduled/pre-booked trips never negotiate.
              </p>

              {config.schedule.enabled && (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label className="text-sm">Active Days</Label>
                    <div className="flex flex-wrap gap-2">
                      {DAY_LABELS.map((day) => (
                        <label
                          key={day.value}
                          className="flex items-center gap-1.5 cursor-pointer"
                        >
                          <Checkbox
                            checked={config.schedule.days.includes(day.value)}
                            onCheckedChange={(checked) => {
                              const days = checked
                                ? [...config.schedule.days, day.value].sort()
                                : config.schedule.days.filter((d) => d !== day.value);
                              updateSchedule({ days });
                            }}
                          />
                          <span className="text-sm">{day.label}</span>
                        </label>
                      ))}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label className="text-sm flex items-center gap-1">
                        <Clock className="h-3.5 w-3.5" />
                        Start Time (local)
                      </Label>
                      <Input
                        type="time"
                        value={config.schedule.startLocalHHmm}
                        onChange={(e) => updateSchedule({ startLocalHHmm: e.target.value })}
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
                        onChange={(e) => updateSchedule({ endLocalHHmm: e.target.value })}
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="space-y-4">
              <h4 className="font-medium">Offer Options</h4>
              <p className="text-xs text-muted-foreground">
                Three fixed slots. Values are configuration only — actual chip fares are calculated by the backend from the trip fare.
              </p>

              {offers.map((offer, index) => (
                <div
                  key={offer.id ?? offer.offer_key}
                  className="p-4 border rounded-lg space-y-4"
                  style={{ borderLeftColor: offer.color, borderLeftWidth: 4 }}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Badge style={{ backgroundColor: offer.color, color: 'white' }}>
                        {SLOT_TITLES[index]}
                      </Badge>
                      <Switch
                        checked={offer.is_active}
                        onCheckedChange={(v) => updateOffer(index, 'is_active', v)}
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                    <div className="space-y-1">
                      <Label className="text-xs">Label</Label>
                      <Input
                        value={offer.label}
                        onChange={(e) => updateOffer(index, 'label', e.target.value)}
                      />
                    </div>
                    {config.price_mode === 'multiplier' ? (
                      <div className="space-y-1">
                        <Label className="text-xs">Percentage (%)</Label>
                        <Input
                          type="number"
                          step="1"
                          min="0"
                          value={Math.round((offer.multiplier ?? 0) * 100)}
                          onChange={(e) => {
                            const pct = parseFloat(e.target.value);
                            updateOffer(index, 'multiplier', isNaN(pct) ? 0 : pct / 100);
                          }}
                          placeholder="100"
                        />
                      </div>
                    ) : (
                      <div className="space-y-1">
                        <Label className="text-xs">Adjustment (pence)</Label>
                        <Input
                          type="number"
                          step="1"
                          min="0"
                          value={offer.fixed_amount_pence}
                          onChange={(e) =>
                            updateOffer(
                              index,
                              'fixed_amount_pence',
                              Math.round(parseFloat(e.target.value) || 0),
                            )
                          }
                          placeholder="50"
                        />
                        <p className="text-[11px] text-muted-foreground">
                          50 = +{currencySymbol}0.50 on the original fare
                        </p>
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
