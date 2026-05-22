import { useState, useEffect } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { RotateCcw, Save, Globe, Layers, Loader2, CheckCircle2, Radio } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';

interface GlobalDispatchSettings {
  driver_response_timeout_seconds: number;
  start_radius_meters: number;
  expand_radius_meters: number;
  max_radius_meters: number;
  drivers_per_wave: number;
  wave_delay_seconds: number;
  dispatch_mode: string;
  stacked_rides_enabled: boolean;
  max_active_rides_per_driver: number;
  allow_same_direction_only: boolean;
  allow_new_ride_while_driver_active: boolean;
  max_pickup_detour_meters: number;
  max_dropoff_detour_meters: number;
}

const DEFAULTS: GlobalDispatchSettings = {
  driver_response_timeout_seconds: 180,
  start_radius_meters: 4000,
  expand_radius_meters: 8000,
  max_radius_meters: 13000,
  drivers_per_wave: 3,
  wave_delay_seconds: 15,
  dispatch_mode: 'smart_score',
  stacked_rides_enabled: true,
  max_active_rides_per_driver: 2,
  allow_same_direction_only: true,
  allow_new_ride_while_driver_active: true,
  max_pickup_detour_meters: 3000,
  max_dropoff_detour_meters: 5000,
};

const mToKm = (m: number) => Math.round((m / 1000) * 100) / 100;
const kmToM = (km: number) => Math.round(km * 1000);

export default function AutoDispatchRules() {
  const [settings, setSettings] = useState<GlobalDispatchSettings>(DEFAULTS);
  const [recordId, setRecordId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);

  useEffect(() => {
    (async () => {
      setIsLoading(true);
      try {
        const { data, error } = await (supabase as any)
          .from('global_dispatch_settings')
          .select('*')
          .eq('singleton', true)
          .maybeSingle();
        if (error) throw error;
        if (data) {
          setRecordId(data.id);
          setSettings({
            driver_response_timeout_seconds: data.driver_response_timeout_seconds,
            start_radius_meters: data.start_radius_meters,
            expand_radius_meters: data.expand_radius_meters,
            max_radius_meters: data.max_radius_meters,
            drivers_per_wave: data.drivers_per_wave,
            wave_delay_seconds: data.wave_delay_seconds,
            dispatch_mode: data.dispatch_mode,
            stacked_rides_enabled: data.stacked_rides_enabled,
            max_active_rides_per_driver: data.max_active_rides_per_driver,
            allow_same_direction_only: data.allow_same_direction_only,
            allow_new_ride_while_driver_active: data.allow_new_ride_while_driver_active,
            max_pickup_detour_meters: data.max_pickup_detour_meters,
            max_dropoff_detour_meters: data.max_dropoff_detour_meters,
          });
        }
        setHasChanges(false);
      } catch (e) {
        console.error('[dispatch-rules] load error', e);
        toast.error('Failed to load dispatch rules');
      } finally {
        setIsLoading(false);
      }
    })();
  }, []);

  const update = <K extends keyof GlobalDispatchSettings>(k: K, v: GlobalDispatchSettings[K]) => {
    setSettings((p) => ({ ...p, [k]: v }));
    setHasChanges(true);
  };

  const validate = (): string | null => {
    const s = settings;
    if (s.driver_response_timeout_seconds < 60 || s.driver_response_timeout_seconds > 900)
      return 'Driver response timeout must be between 1 and 15 minutes';
    if (s.start_radius_meters <= 0) return 'Start radius must be greater than 0';
    if (s.expand_radius_meters <= s.start_radius_meters) return 'Expand radius must be greater than start radius';
    if (s.max_radius_meters < s.expand_radius_meters) return 'Max radius must be ≥ expand radius';
    if (s.drivers_per_wave < 1) return 'Drivers per wave must be ≥ 1';
    if (s.wave_delay_seconds < 0) return 'Wave delay must be ≥ 0';
    if (s.max_active_rides_per_driver < 1 || s.max_active_rides_per_driver > 5)
      return 'Max active rides per driver must be between 1 and 5';
    if (s.max_pickup_detour_meters <= 0) return 'Pickup detour must be greater than 0';
    if (s.max_dropoff_detour_meters <= 0) return 'Dropoff detour must be greater than 0';
    return null;
  };

  const handleSave = async () => {
    const err = validate();
    if (err) {
      toast.error(err);
      return;
    }
    setIsSaving(true);
    try {
      const payload = { ...settings, singleton: true };
      const client = supabase as any;
      let result;
      if (recordId) {
        result = await client.from('global_dispatch_settings').update(payload).eq('id', recordId).select().single();
      } else {
        result = await client.from('global_dispatch_settings').upsert(payload, { onConflict: 'singleton' }).select().single();
      }
      if (result.error) throw result.error;
      if (result.data?.id) setRecordId(result.data.id);
      setHasChanges(false);
      setLastSaved(new Date());
      toast.success('Global dispatch rules saved');
    } catch (e) {
      console.error('[dispatch-rules] save error', e);
      toast.error('Failed to save dispatch rules');
    } finally {
      setIsSaving(false);
    }
  };

  const handleReset = () => {
    setSettings(DEFAULTS);
    setHasChanges(true);
    toast.info('Reset to recommended defaults. Click Save to apply.');
  };

  return (
    <AdminLayout
      title="Dispatch Rules"
      description="Configure the global dispatch engine used across all service areas."
    >
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-6">
        <div className="flex items-center gap-3">
          <Badge variant="outline" className="border-primary text-primary gap-1">
            <Globe className="h-3 w-3" /> GLOBAL RULES
          </Badge>
          {isLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        </div>
        <div className="flex items-center gap-3">
          {lastSaved && (
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <CheckCircle2 className="h-3 w-3 text-green-500" />
              Saved {lastSaved.toLocaleTimeString()}
            </span>
          )}
          {hasChanges && (
            <Badge variant="outline" className="text-amber-600 border-amber-600">Unsaved changes</Badge>
          )}
          <Button variant="outline" size="sm" onClick={handleReset} disabled={isSaving}>
            <RotateCcw className="h-4 w-4 mr-2" /> Reset Defaults
          </Button>
          <Button size="sm" onClick={handleSave} disabled={isSaving || !hasChanges}>
            {isSaving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
            Save Changes
          </Button>
        </div>
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Radio className="h-5 w-5 text-primary" /> Dispatch Engine
          </CardTitle>
          <CardDescription>
            Distances shown in kilometers (km). Stored internally in meters. Smart Dispatch Score uses PostGIS ranking.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="space-y-2">
            <Label>Driver Response Timeout (minutes)</Label>
            <Input
              type="number"
              min={1}
              max={15}
              step={1}
              value={Math.round(settings.driver_response_timeout_seconds / 60)}
              onChange={(e) => update('driver_response_timeout_seconds', Math.max(60, Math.min(900, Number(e.target.value) * 60)))}
            />
            <p className="text-xs text-muted-foreground">1–15 minutes. Late accepts after timeout are rejected.</p>
          </div>
          <div className="space-y-2">
            <Label>Drivers Per Wave</Label>
            <Input type="number" min={1} value={settings.drivers_per_wave}
              onChange={(e) => update('drivers_per_wave', Math.max(1, Number(e.target.value)))} />
          </div>
          <div className="space-y-2">
            <Label>Start Radius (km)</Label>
            <Input type="number" min={0.1} step={0.1} value={mToKm(settings.start_radius_meters)}
              onChange={(e) => update('start_radius_meters', kmToM(Number(e.target.value)))} />
          </div>
          <div className="space-y-2">
            <Label>Expand Radius (km)</Label>
            <Input type="number" min={0.1} step={0.1} value={mToKm(settings.expand_radius_meters)}
              onChange={(e) => update('expand_radius_meters', kmToM(Number(e.target.value)))} />
          </div>
          <div className="space-y-2">
            <Label>Max Radius (km)</Label>
            <Input type="number" min={0.1} step={0.1} value={mToKm(settings.max_radius_meters)}
              onChange={(e) => update('max_radius_meters', kmToM(Number(e.target.value)))} />
            <p className="text-xs text-muted-foreground">Search expands Start → Expand → Max before failing.</p>
          </div>
          <div className="space-y-2">
            <Label>Wave Delay (seconds)</Label>
            <Input type="number" min={0} value={settings.wave_delay_seconds}
              onChange={(e) => update('wave_delay_seconds', Math.max(0, Number(e.target.value)))} />
          </div>
          <div className="flex items-center justify-between md:col-span-2 rounded-lg border p-4">
            <div>
              <Label className="text-base">Smart Dispatch Score</Label>
              <p className="text-xs text-muted-foreground">Rank drivers by distance, rating, idle time, and category. Disable to use distance only.</p>
            </div>
            <Switch
              checked={settings.dispatch_mode === 'smart_score'}
              onCheckedChange={(v) => update('dispatch_mode', v ? 'smart_score' : 'nearest')}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Layers className="h-5 w-5 text-primary" /> Stacked Rides Configuration
          </CardTitle>
          <CardDescription>Allow active drivers to receive additional rides while on a trip.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between rounded-lg border p-4">
            <div>
              <Label className="text-base">Enable Stacked Rides</Label>
              <p className="text-xs text-muted-foreground">When off, only idle drivers receive dispatch requests.</p>
            </div>
            <Switch
              checked={settings.stacked_rides_enabled}
              onCheckedChange={(v) => update('stacked_rides_enabled', v)}
            />
          </div>

          <Separator />

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <Label>Max Active Rides Per Driver</Label>
              <Input
                type="number"
                min={1}
                max={5}
                value={settings.max_active_rides_per_driver}
                onChange={(e) => update('max_active_rides_per_driver', Math.max(1, Math.min(5, Number(e.target.value))))}
                disabled={!settings.stacked_rides_enabled}
              />
              <p className="text-xs text-muted-foreground">Between 1 and 5. Includes the current trip.</p>
            </div>
            <div className="space-y-2">
              <Label>Max Pickup Detour (km)</Label>
              <Input type="number" min={0.1} step={0.1}
                value={mToKm(settings.max_pickup_detour_meters)}
                onChange={(e) => update('max_pickup_detour_meters', kmToM(Number(e.target.value)))}
                disabled={!settings.stacked_rides_enabled}
              />
            </div>
            <div className="space-y-2">
              <Label>Max Dropoff Detour (km)</Label>
              <Input type="number" min={0.1} step={0.1}
                value={mToKm(settings.max_dropoff_detour_meters)}
                onChange={(e) => update('max_dropoff_detour_meters', kmToM(Number(e.target.value)))}
                disabled={!settings.stacked_rides_enabled}
              />
            </div>
            <div className="flex items-center justify-between rounded-lg border p-4">
              <div>
                <Label className="text-base">Allow Same Direction Only</Label>
                <p className="text-xs text-muted-foreground">Only offer rides heading the same way as the current trip.</p>
              </div>
              <Switch
                checked={settings.allow_same_direction_only}
                onCheckedChange={(v) => update('allow_same_direction_only', v)}
                disabled={!settings.stacked_rides_enabled}
              />
            </div>
            <div className="flex items-center justify-between rounded-lg border p-4 md:col-span-2">
              <div>
                <Label className="text-base">Allow New Ride While Driver Active</Label>
                <p className="text-xs text-muted-foreground">When off, active drivers never receive offers (overrides stacked).</p>
              </div>
              <Switch
                checked={settings.allow_new_ride_while_driver_active}
                onCheckedChange={(v) => update('allow_new_ride_while_driver_active', v)}
                disabled={!settings.stacked_rides_enabled}
              />
            </div>
          </div>
        </CardContent>
      </Card>
    </AdminLayout>
  );
}
