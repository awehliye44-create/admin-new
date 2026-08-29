import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { useRoleCapabilities } from '@/hooks/useRoleCapabilities';
import { Loader2, RotateCcw } from 'lucide-react';
import {
  ALL_SERVICE_AREAS,
  ALL_SERVICE_AREAS_MESSAGE,
  DEMAND_ZONE_ACTION_KEYS,
  DEMAND_ZONE_SETTINGS_DEFAULTS,
  DEFAULT_LEVEL_COLOURS,
  canConfigureForSelection,
  normaliseHexColour,
  validateDemandZoneSettings,
  type DemandZoneSettings,
} from '../../../shared/demandZoneSurgeSSOT';

type FormState = Omit<DemandZoneSettings, 'service_area_id'>;

const BLANK: FormState = { ...DEMAND_ZONE_SETTINGS_DEFAULTS };

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serviceAreaId: string;
  serviceAreaName: string;
}

function numField(value: string, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function DemandZoneSettingsDialog({
  open,
  onOpenChange,
  serviceAreaId,
  serviceAreaName,
}: Props) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { actor, isLoading: capsLoading } = useRoleCapabilities();
  const [form, setForm] = useState<FormState>(BLANK);

  const isAllAreas = !serviceAreaId || serviceAreaId === ALL_SERVICE_AREAS;

  const can = (actionKey: (typeof DEMAND_ZONE_ACTION_KEYS)[keyof typeof DEMAND_ZONE_ACTION_KEYS]) =>
    canConfigureForSelection({
      selectedServiceAreaId: serviceAreaId,
      isSuperAdmin: actor.isSuperAdmin,
      allowedActions: actor.allowedActions,
      actionKey,
    });

  const canHeatMap = can(DEMAND_ZONE_ACTION_KEYS.configureHeatMap);
  const canColours = can(DEMAND_ZONE_ACTION_KEYS.configureColours);
  const canSurge = can(DEMAND_ZONE_ACTION_KEYS.configureSurge);
  const readOnly = !canHeatMap && !canColours && !canSurge;

  const { data: settings, isLoading } = useQuery({
    queryKey: ['demand-zone-settings', serviceAreaId],
    enabled: open && !isAllAreas,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('service_area_demand_zone_settings')
        .select('id,service_area_id,surge_enabled,heat_map_enabled,manual_zones_enabled,recompute_interval_minutes,consecutive_checks_required,zone_radius_meters,open_trip_max_lifetime_minutes,low_min_trips,low_max_trips,medium_min_trips,medium_max_trips,high_min_trips,multiplier_low,multiplier_medium,multiplier_high,max_multiplier,colour_low,colour_medium,colour_high,updated_by,created_at,updated_at')
        .eq('service_area_id', serviceAreaId)
        .maybeSingle();
      if (error) throw error;
      return (data as DemandZoneSettings | null) ?? null;
    },
  });

  useEffect(() => {
    if (!open) return;
    setForm(settings ? { ...BLANK, ...settings } : BLANK);
  }, [open, settings]);

  const validation = useMemo(
    () => validateDemandZoneSettings({ ...form, service_area_id: serviceAreaId }),
    [form, serviceAreaId],
  );

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!validation.valid) throw new Error(validation.errors.join(' · '));
      const { error } = await supabase.rpc('admin_save_demand_zone_settings', {
        _service_area_id: serviceAreaId,
        _settings: JSON.parse(JSON.stringify(form)),
      });
      if (error) throw error;
    },
    onSuccess: async () => {
      toast({ title: 'Settings saved', description: `${serviceAreaName} demand-zone settings updated.` });
      await queryClient.invalidateQueries({ queryKey: ['demand-zone-settings', serviceAreaId] });
      await queryClient.invalidateQueries({ queryKey: ['driver-demand-zones'] });
      onOpenChange(false);
    },
    onError: (err: Error) => {
      toast({ title: 'Save failed', description: err.message, variant: 'destructive' });
    },
  });

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const colourRow = (
    label: string,
    key: 'colour_low' | 'colour_medium' | 'colour_high',
    fallback: string,
  ) => (
    <div className="flex items-center gap-3">
      <Label className="w-28 text-xs">{label}</Label>
      <input
        type="color"
        aria-label={`${label} colour`}
        className="h-9 w-12 cursor-pointer rounded border bg-background p-1 disabled:cursor-not-allowed"
        value={normaliseHexColour(form[key] || fallback)}
        disabled={!canColours}
        onChange={(e) => set(key, normaliseHexColour(e.target.value))}
      />
      <Input
        className="w-32 font-mono text-xs"
        value={form[key] ?? ''}
        disabled={!canColours}
        onChange={(e) => set(key, e.target.value)}
      />
      <span
        className="h-6 flex-1 rounded border"
        style={{ backgroundColor: normaliseHexColour(form[key] || fallback) }}
        aria-hidden
      />
      <Button
        type="button"
        size="icon"
        variant="ghost"
        disabled={!canColours}
        onClick={() => set(key, fallback)}
        title="Reset to default"
      >
        <RotateCcw className="h-4 w-4" />
      </Button>
    </div>
  );

  const numberRow = (
    label: string,
    key: keyof FormState,
    enabled: boolean,
    step = '1',
  ) => (
    <div className="flex items-center justify-between gap-3">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Input
        type="number"
        step={step}
        className="w-28"
        disabled={!enabled}
        value={String(form[key] ?? '')}
        onChange={(e) =>
          set(key, numField(e.target.value, Number(DEMAND_ZONE_SETTINGS_DEFAULTS[key as keyof typeof DEMAND_ZONE_SETTINGS_DEFAULTS] ?? 0)) as never)
        }
      />
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Heat map &amp; surge settings</DialogTitle>
          <DialogDescription>
            {isAllAreas ? ALL_SERVICE_AREAS_MESSAGE : `Applies only to ${serviceAreaName}.`}
          </DialogDescription>
        </DialogHeader>

        {isAllAreas ? null : isLoading || capsLoading ? (
          <div className="py-10 text-center text-muted-foreground">
            <Loader2 className="mx-auto h-5 w-5 animate-spin" />
          </div>
        ) : (
          <div className="space-y-5">
            {readOnly && (
              <p className="rounded-md border border-amber-300/60 bg-amber-50/70 p-3 text-xs text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
                You have read-only access to these settings.
              </p>
            )}

            <section className="space-y-3">
              <h3 className="text-sm font-semibold">Heat map</h3>
              <div className="flex items-center justify-between">
                <Label className="text-xs text-muted-foreground">Heat map enabled</Label>
                <Switch
                  checked={form.heat_map_enabled}
                  disabled={!canHeatMap}
                  onCheckedChange={(v) => set('heat_map_enabled', v)}
                />
              </div>
              <div className="flex items-center justify-between">
                <Label className="text-xs text-muted-foreground">Manual zones enabled</Label>
                <Switch
                  checked={form.manual_zones_enabled}
                  disabled={!canHeatMap}
                  onCheckedChange={(v) => set('manual_zones_enabled', v)}
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {numberRow('Recompute interval (min)', 'recompute_interval_minutes', canHeatMap)}
                {numberRow('Open trip lifetime (min)', 'open_trip_max_lifetime_minutes', canHeatMap)}
                {numberRow('Zone radius (m)', 'zone_radius_meters', canHeatMap)}
                {numberRow('Consecutive checks required', 'consecutive_checks_required', canHeatMap)}
                {numberRow('Low: min trips', 'low_min_trips', canHeatMap)}
                {numberRow('Low: max trips', 'low_max_trips', canHeatMap)}
                {numberRow('Medium: min trips', 'medium_min_trips', canHeatMap)}
                {numberRow('Medium: max trips', 'medium_max_trips', canHeatMap)}
                {numberRow('High: min trips', 'high_min_trips', canHeatMap)}
              </div>
            </section>

            <Separator />

            <section className="space-y-3">
              <h3 className="text-sm font-semibold">Colours</h3>
              <p className="text-xs text-muted-foreground">
                Colours are display-only and never affect pricing.
              </p>
              {colourRow('Low demand', 'colour_low', DEFAULT_LEVEL_COLOURS.LOW)}
              {colourRow('Medium demand', 'colour_medium', DEFAULT_LEVEL_COLOURS.MEDIUM)}
              {colourRow('High demand', 'colour_high', DEFAULT_LEVEL_COLOURS.HIGH)}
            </section>

            <Separator />

            <section className="space-y-3">
              <h3 className="text-sm font-semibold">Automatic zone surge</h3>
              <div className="flex items-center justify-between">
                <Label className="text-xs text-muted-foreground">Surge enabled</Label>
                <Switch
                  checked={form.surge_enabled}
                  disabled={!canSurge}
                  onCheckedChange={(v) => set('surge_enabled', v)}
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {numberRow('Low multiplier', 'multiplier_low', canSurge, '0.01')}
                {numberRow('Medium multiplier', 'multiplier_medium', canSurge, '0.01')}
                {numberRow('High multiplier', 'multiplier_high', canSurge, '0.01')}
                {numberRow('Max multiplier', 'max_multiplier', canSurge, '0.01')}
              </div>
              <p className="text-xs text-muted-foreground">
                Surge applies only to the confirmed demand level of the pickup zone. It never
                applies service-area wide.
              </p>
            </section>

            {!validation.valid && (
              <ul className="list-disc space-y-1 rounded-md border border-destructive/40 bg-destructive/5 p-3 pl-6 text-xs text-destructive">
                {validation.errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button
            onClick={() => saveMutation.mutate()}
            disabled={isAllAreas || readOnly || !validation.valid || saveMutation.isPending}
          >
            {saveMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save settings
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
