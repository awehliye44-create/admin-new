import { useState, useEffect } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { 
  RotateCcw, 
  Save, 
  Globe, 
  Layers, 
  Clock, 
  Info,
  Percent,
  Timer,
  Loader2,
  CheckCircle2
} from 'lucide-react';
import { DriverTiersConfig } from '@/components/dispatch/DriverTiersConfig';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
// useServiceAreas removed — dispatch config is global
import { useRegions } from '@/hooks/useRegions';
import { convertDistance, convertToKm, getDistanceUnitShort } from '@/lib/regionSettings';

interface DispatchSettings {
  // PostGIS Dispatch Scoring (single source of truth for all dispatch execution)
  searchRadiusStartKm: number;
  searchRadiusExpandKm: number;
  searchRadiusMaxKm: number;
  wave1Size: number;
  wave2Size: number;
  wave3Size: number;
  wave1OfferExpirySeconds: number;
  wave2OfferExpirySeconds: number;
  wave3OfferExpirySeconds: number;
  distancePenaltyPerKm: number;
  waitingBonusPerMinute: number;
  maxWaitingBonusMinutes: number;
  fairnessIdleMinutes: number;
  fairnessBoostScore: number;

  // Newly promoted from hardcoded constants
  maxDispatchRounds: number;
  degradedDriverPenalty: number;
  presenceMaxAgeSeconds: number;

  // Maximum Time to Find Driver
  maxDriverFindTimeMinutes: number;

  // Stacked Rides (policy layer)
  stackedRidesEnabled: boolean;
  maxStackedRides: number;
  stackedSearchRadiusMeters: number;
  stackedMinTripDistanceKm: number;
  stackedMaxDetourMinutes: number;
  stackedOfferWindowMinutes: number;
  stackedPriorityMode: 'same_direction' | 'nearest' | 'highest_fare';
  stackedDriverIncentive: number;
  stackedRiderDiscount: number;
  stackedShowEtaToDriver: boolean;
  stackedAllowRiderOptOut: boolean;

  // Scheduled Rides (policy layer)
  scheduledRidesEnabled: boolean;
  minAdvanceTimeMinutes: number;
  maxAdvanceDays: number;
  waitingTimeGracePeriodMinutes: number;
  scheduledRideIncentivesEnabled: boolean;
  scheduledResponseWindowMinutes: number;
  urgentDispatchTriggerMinutesBeforePickup: number;
  lockedDriverResponseMinutes: number;
  scheduledUrgentCardLabel: string;
  enableScheduledToUrgentConversion: boolean;

  // System Settings (operational flags, not dispatch execution)
  enableLogging: boolean;
  simulateMode: boolean;
  blockMultipleActiveRides: boolean;
  cancelProtection: boolean;
}

const defaultSettings: DispatchSettings = {
  searchRadiusStartKm: 3,
  searchRadiusExpandKm: 5,
  searchRadiusMaxKm: 8,
  wave1Size: 3,
  wave2Size: 5,
  wave3Size: 10,
  wave1OfferExpirySeconds: 40,
  wave2OfferExpirySeconds: 45,
  wave3OfferExpirySeconds: 50,
  distancePenaltyPerKm: 2.0,
  waitingBonusPerMinute: 0.5,
  maxWaitingBonusMinutes: 20,
  fairnessIdleMinutes: 20,
  fairnessBoostScore: 10,
  maxDispatchRounds: 3,
  degradedDriverPenalty: 100,
  presenceMaxAgeSeconds: 60,
  maxDriverFindTimeMinutes: 3,
  stackedRidesEnabled: false,
  maxStackedRides: 1,
  stackedSearchRadiusMeters: 2000,
  stackedMinTripDistanceKm: 3,
  stackedMaxDetourMinutes: 10,
  stackedOfferWindowMinutes: 5,
  stackedPriorityMode: 'same_direction',
  stackedDriverIncentive: 5,
  stackedRiderDiscount: 10,
  stackedShowEtaToDriver: true,
  stackedAllowRiderOptOut: true,
  scheduledRidesEnabled: true,
  minAdvanceTimeMinutes: 15,
  maxAdvanceDays: 30,
  waitingTimeGracePeriodMinutes: 5,
  scheduledRideIncentivesEnabled: false,
  scheduledResponseWindowMinutes: 10,
  urgentDispatchTriggerMinutesBeforePickup: 5,
  lockedDriverResponseMinutes: 3,
  scheduledUrgentCardLabel: 'Scheduled • Urgent',
  enableScheduledToUrgentConversion: true,
  enableLogging: false,
  simulateMode: false,
  blockMultipleActiveRides: false,
  cancelProtection: false,
};

// DB stores all distances in METERS. UI keeps km-named state for display conversion.
const mapDbToSettings = (data: Record<string, unknown>): DispatchSettings => ({
  searchRadiusStartKm: Number(data.start_radius_meters ?? 4000) / 1000,
  searchRadiusExpandKm: Number(data.expand_radius_meters ?? 8000) / 1000,
  searchRadiusMaxKm: Number(data.max_radius_meters ?? 13000) / 1000,
  wave1Size: (data.wave1_size as number) ?? defaultSettings.wave1Size,
  wave2Size: (data.wave2_size as number) ?? defaultSettings.wave2Size,
  wave3Size: (data.wave3_size as number) ?? defaultSettings.wave3Size,
  wave1OfferExpirySeconds: (data.wave1_offer_expiry_seconds as number) ?? defaultSettings.wave1OfferExpirySeconds,
  wave2OfferExpirySeconds: (data.wave2_offer_expiry_seconds as number) ?? defaultSettings.wave2OfferExpirySeconds,
  wave3OfferExpirySeconds: (data.wave3_offer_expiry_seconds as number) ?? defaultSettings.wave3OfferExpirySeconds,
  distancePenaltyPerKm: Number(data.distance_penalty_per_meter ?? 0.002) * 1000,
  waitingBonusPerMinute: (data.waiting_bonus_per_minute as number) ?? defaultSettings.waitingBonusPerMinute,
  maxWaitingBonusMinutes: (data.max_waiting_bonus_minutes as number) ?? defaultSettings.maxWaitingBonusMinutes,
  fairnessIdleMinutes: (data.fairness_idle_minutes as number) ?? defaultSettings.fairnessIdleMinutes,
  fairnessBoostScore: (data.fairness_boost_score as number) ?? defaultSettings.fairnessBoostScore,
  maxDispatchRounds: (data.max_dispatch_rounds as number) ?? defaultSettings.maxDispatchRounds,
  degradedDriverPenalty: (data.degraded_driver_penalty as number) ?? defaultSettings.degradedDriverPenalty,
  presenceMaxAgeSeconds: (data.presence_max_age_seconds as number) ?? defaultSettings.presenceMaxAgeSeconds,
  maxDriverFindTimeMinutes: (data.max_driver_find_time_minutes as number) ?? defaultSettings.maxDriverFindTimeMinutes,
  stackedRidesEnabled: Boolean(data.stacked_rides_enabled),
  maxStackedRides: Number(data.max_stacked_rides ?? defaultSettings.maxStackedRides),
  stackedSearchRadiusMeters: Number(data.stacked_search_radius_meters ?? defaultSettings.stackedSearchRadiusMeters),
  stackedMinTripDistanceKm: Number(data.stacked_min_trip_distance_meters ?? 3000) / 1000,
  stackedMaxDetourMinutes: Number(data.stacked_max_detour_minutes ?? defaultSettings.stackedMaxDetourMinutes),
  stackedOfferWindowMinutes: Number(data.stacked_offer_window_minutes ?? defaultSettings.stackedOfferWindowMinutes),
  stackedPriorityMode: (data.stacked_priority_mode as 'same_direction' | 'nearest' | 'highest_fare') ?? 'same_direction',
  stackedDriverIncentive: Number(data.stacked_driver_incentive ?? 0),
  stackedRiderDiscount: Number(data.stacked_rider_discount ?? 0),
  stackedShowEtaToDriver: Boolean(data.stacked_show_eta_to_driver),
  stackedAllowRiderOptOut: Boolean(data.stacked_allow_rider_opt_out),
  scheduledRidesEnabled: (data.scheduled_rides_enabled as boolean) ?? defaultSettings.scheduledRidesEnabled,
  minAdvanceTimeMinutes: (data.min_advance_time_minutes as number) ?? defaultSettings.minAdvanceTimeMinutes,
  maxAdvanceDays: (data.max_advance_days as number) ?? defaultSettings.maxAdvanceDays,
  waitingTimeGracePeriodMinutes: (data.waiting_time_grace_period_minutes as number) ?? defaultSettings.waitingTimeGracePeriodMinutes,
  scheduledRideIncentivesEnabled: (data.scheduled_ride_incentives_enabled as boolean) ?? defaultSettings.scheduledRideIncentivesEnabled,
  scheduledResponseWindowMinutes: (data.scheduled_response_window_minutes as number) ?? defaultSettings.scheduledResponseWindowMinutes,
  urgentDispatchTriggerMinutesBeforePickup: (data.urgent_dispatch_trigger_minutes_before_pickup as number) ?? defaultSettings.urgentDispatchTriggerMinutesBeforePickup,
  lockedDriverResponseMinutes: (data.locked_driver_response_minutes as number) ?? defaultSettings.lockedDriverResponseMinutes,
  scheduledUrgentCardLabel: (data.scheduled_urgent_card_label as string) ?? defaultSettings.scheduledUrgentCardLabel,
  enableScheduledToUrgentConversion: (data.enable_scheduled_to_urgent_conversion as boolean) ?? defaultSettings.enableScheduledToUrgentConversion,
  enableLogging: (data.enable_logging as boolean) ?? defaultSettings.enableLogging,
  simulateMode: (data.simulate_mode as boolean) ?? defaultSettings.simulateMode,
  blockMultipleActiveRides: (data.block_multiple_active_rides as boolean) ?? defaultSettings.blockMultipleActiveRides,
  cancelProtection: (data.cancel_protection as boolean) ?? defaultSettings.cancelProtection,
});

const mapSettingsToDb = (settings: DispatchSettings) => ({
  start_radius_meters: Math.round(settings.searchRadiusStartKm * 1000),
  expand_radius_meters: Math.round(settings.searchRadiusExpandKm * 1000),
  max_radius_meters: Math.round(settings.searchRadiusMaxKm * 1000),
  wave1_size: settings.wave1Size,
  wave2_size: settings.wave2Size,
  wave3_size: settings.wave3Size,
  wave1_offer_expiry_seconds: settings.wave1OfferExpirySeconds,
  wave2_offer_expiry_seconds: settings.wave2OfferExpirySeconds,
  wave3_offer_expiry_seconds: settings.wave3OfferExpirySeconds,
  distance_penalty_per_meter: settings.distancePenaltyPerKm / 1000,
  waiting_bonus_per_minute: settings.waitingBonusPerMinute,
  max_waiting_bonus_minutes: settings.maxWaitingBonusMinutes,
  fairness_idle_minutes: settings.fairnessIdleMinutes,
  fairness_boost_score: settings.fairnessBoostScore,
  max_dispatch_rounds: settings.maxDispatchRounds,
  degraded_driver_penalty: settings.degradedDriverPenalty,
  presence_max_age_seconds: settings.presenceMaxAgeSeconds,
  max_driver_find_time_minutes: settings.maxDriverFindTimeMinutes,
  stacked_rides_enabled: !!settings.stackedRidesEnabled,
  max_stacked_rides: settings.maxStackedRides,
  max_active_rides_per_driver: settings.maxStackedRides + 1,
  stacked_search_radius_meters: settings.stackedSearchRadiusMeters,
  stacked_min_trip_distance_meters: Math.round(settings.stackedMinTripDistanceKm * 1000),
  stacked_max_detour_minutes: settings.stackedMaxDetourMinutes,
  stacked_offer_window_minutes: settings.stackedOfferWindowMinutes,
  stacked_priority_mode: settings.stackedPriorityMode,
  stacked_driver_incentive: settings.stackedDriverIncentive,
  stacked_rider_discount: settings.stackedRiderDiscount,
  stacked_show_eta_to_driver: !!settings.stackedShowEtaToDriver,
  stacked_allow_rider_opt_out: !!settings.stackedAllowRiderOptOut,
  scheduled_rides_enabled: settings.scheduledRidesEnabled,
  min_advance_time_minutes: settings.minAdvanceTimeMinutes,
  max_advance_days: settings.maxAdvanceDays,
  waiting_time_grace_period_minutes: settings.waitingTimeGracePeriodMinutes,
  scheduled_ride_incentives_enabled: settings.scheduledRideIncentivesEnabled,
  scheduled_response_window_minutes: settings.scheduledResponseWindowMinutes,
  urgent_dispatch_trigger_minutes_before_pickup: settings.urgentDispatchTriggerMinutesBeforePickup,
  locked_driver_response_minutes: settings.lockedDriverResponseMinutes,
  scheduled_urgent_card_label: settings.scheduledUrgentCardLabel,
  enable_scheduled_to_urgent_conversion: settings.enableScheduledToUrgentConversion,
  enable_logging: settings.enableLogging,
  simulate_mode: settings.simulateMode,
  block_multiple_active_rides: settings.blockMultipleActiveRides,
  cancel_protection: settings.cancelProtection,
});

export default function AutoDispatchRules() {
  const [settings, setSettings] = useState<DispatchSettings>(defaultSettings);
  const { data: regions = [] } = useRegions();
  const [scheduledTab, setScheduledTab] = useState('booking');
  const [stackedTab, setStackedTab] = useState('general');
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [hasChanges, setHasChanges] = useState(false);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);

  // Global config — display unit is the most common region distance_unit (fallback km)
  const distanceUnit: 'mile' | 'km' = (() => {
    const counts = regions.reduce<Record<string, number>>((acc, r) => {
      const u = r.distance_unit || 'km';
      acc[u] = (acc[u] || 0) + 1;
      return acc;
    }, {});
    const winner = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
    return winner === 'mile' ? 'mile' : 'km';
  })();

  const unitShort = getDistanceUnitShort(distanceUnit);
  const fromKm = (km: number) => Number(convertDistance(km, distanceUnit).toFixed(2));
  const toKm = (val: number) => Number(convertToKm(val, distanceUnit).toFixed(4));

  useEffect(() => {
    const loadDispatchSettings = async () => {
      setIsLoading(true);
      try {
        const { data, error } = await supabase
          .from('global_dispatch_settings')
          .select('*')
          .eq('singleton', true)
          .maybeSingle();
        if (error) throw error;
        if (data) {
          setSettings(mapDbToSettings(data as Record<string, unknown>));
        } else {
          setSettings(defaultSettings);
        }
        setHasChanges(false);
      } catch (err) {
        console.error('Error loading dispatch settings:', err);
        toast.error('Failed to load dispatch settings');
      } finally {
        setIsLoading(false);
      }
    };
    loadDispatchSettings();
  }, []);

  const updateSetting = <K extends keyof DispatchSettings>(key: K, value: DispatchSettings[K]) => {
    setSettings(prev => ({ ...prev, [key]: value }));
    setHasChanges(true);
  };

  const handleReset = () => {
    setSettings(defaultSettings);
    setHasChanges(true);
    toast.info('Settings reset to defaults. Click Save to apply.');
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const dbData = mapSettingsToDb(settings);
      const { error } = await supabase
        .from('global_dispatch_settings')
        .update(dbData)
        .eq('singleton', true);
      if (error) throw error;

      setHasChanges(false);
      setLastSaved(new Date());
      toast.success('Global dispatch settings saved');
    } catch (err) {
      console.error('Error saving settings:', err);
      toast.error('Failed to save settings');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <AdminLayout
      title="Auto-Dispatch Rules"
      description="Global dispatch configuration — applies to all service areas and countries"
    >
      {/* Header — single global config, no service area selector */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-6">
        <div className="flex items-center gap-3">
          <Globe className="h-5 w-5 text-primary" />
          <div>
            <p className="text-sm font-medium">Global Configuration</p>
            <p className="text-xs text-muted-foreground">One shared dispatch policy across every service area</p>
          </div>
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
            <Badge variant="outline" className="text-amber-600 border-amber-600">
              Unsaved changes
            </Badge>
          )}
          <Button variant="outline" onClick={handleReset} disabled={isLoading}>
            <RotateCcw className="mr-2 h-4 w-4" />
            Reset
          </Button>
          <Button onClick={handleSave} disabled={isSaving || isLoading || !hasChanges}>
            {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
            {isSaving ? 'Saving...' : 'Save Changes'}
          </Button>
        </div>
      </div>

      <div className="space-y-6">
        {/* Driver Finding Time */}
        <Card className="border-primary/50">
          <CardHeader>
            <div className="flex items-center gap-3">
              <Timer className="h-5 w-5 text-primary" />
              <div>
                <CardTitle>Maximum Time to Find Driver</CardTitle>
                <CardDescription>Set how long the system searches for a driver before timing out</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <Label>Maximum Search Time (minutes)</Label>
                <Input
                  type="number" min="1" max="15"
                  value={settings.maxDriverFindTimeMinutes}
                  onChange={(e) => updateSetting('maxDriverFindTimeMinutes', Math.max(1, Math.min(15, parseInt(e.target.value) || 3)))}
                  disabled={isLoading}
                />
                <p className="text-xs text-muted-foreground">Default: 3 minutes. Range: 1-15 minutes.</p>
              </div>
              <div className="flex items-center">
                <div className="p-4 bg-muted/50 rounded-lg w-full">
                  <p className="text-sm font-medium">Current Setting</p>
                  <p className="text-2xl font-bold text-primary">{settings.maxDriverFindTimeMinutes} min</p>
                  <p className="text-xs text-muted-foreground mt-1">Trips will expire if no driver accepts within this time</p>
                </div>
              </div>
            </div>
            <div className="flex items-start gap-2 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
              <Info className="h-4 w-4 text-blue-600 mt-0.5" />
              <div className="text-sm text-blue-700 dark:text-blue-400">
                <p className="font-medium">How it works:</p>
                <ul className="list-disc list-inside mt-1 space-y-1">
                  <li>Customer sees a countdown timer while searching</li>
                  <li>If no driver accepts, trip is marked as "No Driver Found"</li>
                  <li>Customer receives: "No drivers available right now. Please try again."</li>
                  <li>Late acceptances are blocked after timeout</li>
                </ul>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* PostGIS Dispatch Scoring — SINGLE SOURCE OF TRUTH */}
        <Card className="border-primary/50">
          <CardHeader>
            <div className="flex items-center gap-3">
              <Globe className="h-5 w-5 text-primary" />
              <div>
                <CardTitle>Dispatch Scoring & Execution</CardTitle>
                <CardDescription>
                  Single source of truth for all driver ranking, radius expansion, wave dispatch, and offer assignment
                </CardDescription>
              </div>
              <Badge className="ml-auto bg-primary text-primary-foreground">Primary</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Radius Expansion */}
            <div>
              <h4 className="text-sm font-semibold mb-3">Radius Expansion ({unitShort})</h4>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label>Start Radius ({unitShort})</Label>
                  <Input type="number" step="0.5" min="0.5" value={fromKm(settings.searchRadiusStartKm)}
                    onChange={(e) => updateSetting('searchRadiusStartKm', toKm(parseFloat(e.target.value) || fromKm(3)))} disabled={isLoading} />
                  <p className="text-xs text-muted-foreground">Initial search radius</p>
                </div>
                <div className="space-y-2">
                  <Label>Expand Radius ({unitShort})</Label>
                  <Input type="number" step="0.5" min="1" value={fromKm(settings.searchRadiusExpandKm)}
                    onChange={(e) => updateSetting('searchRadiusExpandKm', toKm(parseFloat(e.target.value) || fromKm(5)))} disabled={isLoading} />
                  <p className="text-xs text-muted-foreground">2nd expansion step</p>
                </div>
                <div className="space-y-2">
                  <Label>Max Radius ({unitShort})</Label>
                  <Input type="number" step="0.5" min="1" value={fromKm(settings.searchRadiusMaxKm)}
                    onChange={(e) => updateSetting('searchRadiusMaxKm', toKm(parseFloat(e.target.value) || fromKm(8)))} disabled={isLoading} />
                  <p className="text-xs text-muted-foreground">Final expansion limit</p>
                </div>
              </div>
            </div>

            {/* Wave Sizes */}
            <div>
              <h4 className="text-sm font-semibold mb-3">Wave Sizes</h4>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label>Wave 1 Size</Label>
                  <Input type="number" min="1" max="20" value={settings.wave1Size}
                    onChange={(e) => updateSetting('wave1Size', parseInt(e.target.value) || 3)} disabled={isLoading} />
                  <p className="text-xs text-muted-foreground">1st batch</p>
                </div>
                <div className="space-y-2">
                  <Label>Wave 2 Size</Label>
                  <Input type="number" min="1" max="20" value={settings.wave2Size}
                    onChange={(e) => updateSetting('wave2Size', parseInt(e.target.value) || 5)} disabled={isLoading} />
                  <p className="text-xs text-muted-foreground">2nd batch</p>
                </div>
                <div className="space-y-2">
                  <Label>Wave 3 Size</Label>
                  <Input type="number" min="1" max="30" value={settings.wave3Size}
                    onChange={(e) => updateSetting('wave3Size', parseInt(e.target.value) || 10)} disabled={isLoading} />
                  <p className="text-xs text-muted-foreground">3rd batch</p>
                </div>
              </div>
            </div>

            {/* Offer Timing */}
            <div>
              <h4 className="text-sm font-semibold mb-3">Per-Wave Offer Expiry</h4>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label>Wave 1 Expiry (seconds)</Label>
                  <Input type="number" min="10" max="120" value={settings.wave1OfferExpirySeconds}
                    onChange={(e) => updateSetting('wave1OfferExpirySeconds', parseInt(e.target.value) || 40)} disabled={isLoading} />
                  <p className="text-xs text-muted-foreground">Time Wave 1 waits before expanding</p>
                </div>
                <div className="space-y-2">
                  <Label>Wave 2 Expiry (seconds)</Label>
                  <Input type="number" min="10" max="120" value={settings.wave2OfferExpirySeconds}
                    onChange={(e) => updateSetting('wave2OfferExpirySeconds', parseInt(e.target.value) || 45)} disabled={isLoading} />
                  <p className="text-xs text-muted-foreground">Time Wave 2 waits before expanding</p>
                </div>
                <div className="space-y-2">
                  <Label>Wave 3 Expiry (seconds)</Label>
                  <Input type="number" min="10" max="120" value={settings.wave3OfferExpirySeconds}
                    onChange={(e) => updateSetting('wave3OfferExpirySeconds', parseInt(e.target.value) || 50)} disabled={isLoading} />
                  <p className="text-xs text-muted-foreground">Time Wave 3 waits before marking unassigned</p>
                </div>
              </div>
            </div>

            {/* Dispatcher Internals — promoted from hardcoded values */}
            <div>
              <h4 className="text-sm font-semibold mb-3">Dispatcher Internals</h4>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label>Max Dispatch Rounds</Label>
                  <Input type="number" min="1" max="6" value={settings.maxDispatchRounds}
                    onChange={(e) => updateSetting('maxDispatchRounds', parseInt(e.target.value) || 3)} disabled={isLoading} />
                  <p className="text-xs text-muted-foreground">Wave cascade limit before marking trip unassigned</p>
                </div>
                <div className="space-y-2">
                  <Label>Degraded Driver Penalty</Label>
                  <Input type="number" min="0" max="500" value={settings.degradedDriverPenalty}
                    onChange={(e) => updateSetting('degradedDriverPenalty', parseInt(e.target.value) || 100)} disabled={isLoading} />
                  <p className="text-xs text-muted-foreground">Score penalty for degraded presence drivers</p>
                </div>
                <div className="space-y-2">
                  <Label>Presence Max Age (seconds)</Label>
                  <Input type="number" min="15" max="300" value={settings.presenceMaxAgeSeconds}
                    onChange={(e) => updateSetting('presenceMaxAgeSeconds', parseInt(e.target.value) || 60)} disabled={isLoading} />
                  <p className="text-xs text-muted-foreground">Max heartbeat age to be considered live</p>
                </div>
              </div>
            </div>


            {/* Scoring Weights */}
            <div>
              <h4 className="text-sm font-semibold mb-3">Scoring Formula Weights</h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Distance Penalty (per {unitShort})</Label>
                  <Input type="number" step="0.1" min="0" value={Number((distanceUnit === 'mile' ? settings.distancePenaltyPerKm * 1.609344 : settings.distancePenaltyPerKm).toFixed(3))}
                    onChange={(e) => {
                      const entered = parseFloat(e.target.value) || 0;
                      const perKm = distanceUnit === 'mile' ? entered / 1.609344 : entered;
                      updateSetting('distancePenaltyPerKm', Number(perKm.toFixed(4)));
                    }} disabled={isLoading} />
                  <p className="text-xs text-muted-foreground">Score deduction per {unitShort} from pickup</p>
                </div>
                <div className="space-y-2">
                  <Label>Waiting Bonus (per minute)</Label>
                  <Input type="number" step="0.1" min="0" max="5" value={settings.waitingBonusPerMinute}
                    onChange={(e) => updateSetting('waitingBonusPerMinute', parseFloat(e.target.value) || 0.5)} disabled={isLoading} />
                  <p className="text-xs text-muted-foreground">Score bonus per idle minute</p>
                </div>
                <div className="space-y-2">
                  <Label>Max Waiting Bonus (minutes)</Label>
                  <Input type="number" min="1" max="60" value={settings.maxWaitingBonusMinutes}
                    onChange={(e) => updateSetting('maxWaitingBonusMinutes', parseInt(e.target.value) || 20)} disabled={isLoading} />
                  <p className="text-xs text-muted-foreground">Cap on waiting bonus</p>
                </div>
                <div className="space-y-2">
                  <Label>Fairness Boost Score</Label>
                  <Input type="number" step="0.5" min="0" max="50" value={settings.fairnessBoostScore}
                    onChange={(e) => updateSetting('fairnessBoostScore', parseFloat(e.target.value) || 10)} disabled={isLoading} />
                  <p className="text-xs text-muted-foreground">Bonus for drivers idle beyond threshold</p>
                </div>
                <div className="space-y-2">
                  <Label>Fairness Idle Threshold (minutes)</Label>
                  <Input type="number" min="1" max="60" value={settings.fairnessIdleMinutes}
                    onChange={(e) => updateSetting('fairnessIdleMinutes', parseInt(e.target.value) || 20)} disabled={isLoading} />
                  <p className="text-xs text-muted-foreground">Minutes without offer to trigger fairness boost</p>
                </div>
              </div>
            </div>

            {/* Formula explanation */}
            <div className="flex items-start gap-2 p-3 bg-muted/50 rounded-lg">
              <Info className="h-4 w-4 text-muted-foreground mt-0.5" />
              <div className="text-sm text-muted-foreground">
                <p className="font-medium text-foreground">Dispatch Score Formula:</p>
                <code className="text-xs block mt-1">
                  score = category_priority + (waiting_min × waiting_bonus) + fairness_boost − (distance_{unitShort} × distance_penalty)
                </code>
                <p className="mt-1">Category priority values are configured in the Driver Tiers section below.</p>
                <p className="mt-2 font-medium text-foreground">Dispatch Execution Flow:</p>
                <ol className="list-decimal list-inside mt-1 space-y-1">
                  <li>Filter all eligible drivers within search radius</li>
                  <li>Calculate final dispatch score per driver</li>
                  <li>Rank by score descending — split into waves</li>
                  <li>Send Wave 1 → if no acceptance → Wave 2 → Wave 3</li>
                  <li>First driver to accept wins (atomic via <code>accept_ride_offer</code> RPC)</li>
                </ol>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Driver Tiers Configuration — single source of truth */}
        <DriverTiersConfig />

        {/* Stacked Rides Configuration */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <Layers className="h-5 w-5 text-muted-foreground" />
              <div>
                <CardTitle>Stacked Rides Configuration</CardTitle>
                <CardDescription>Policy layer — does not affect dispatch ranking or scoring</CardDescription>
              </div>
              <Badge variant="outline" className="ml-auto">Policy</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="flex items-center justify-between p-4 border rounded-lg">
              <div>
                <p className="font-medium">Stacked Rides</p>
                <p className="text-sm text-muted-foreground">Enable or disable stacked ride offers system-wide</p>
              </div>
              <Switch checked={settings.stackedRidesEnabled} onCheckedChange={(checked) => updateSetting('stackedRidesEnabled', checked)} disabled={isLoading} />
            </div>

            <Tabs value={stackedTab} onValueChange={setStackedTab}>
              <TabsList className="grid w-full grid-cols-4">
                <TabsTrigger value="general">General</TabsTrigger>
                <TabsTrigger value="matching">Matching Rules</TabsTrigger>
                <TabsTrigger value="incentives">Incentives</TabsTrigger>
                <TabsTrigger value="display">Display Options</TabsTrigger>
              </TabsList>

              <TabsContent value="general" className="space-y-6 pt-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-2">
                    <Label>Max Stacked Rides</Label>
                    <Input type="number" min="1" max="3" value={settings.maxStackedRides}
                      onChange={(e) => updateSetting('maxStackedRides', Math.min(3, Math.max(1, parseInt(e.target.value) || 1)))}
                      disabled={isLoading || !settings.stackedRidesEnabled} />
                    <p className="text-xs text-muted-foreground">Maximum queued rides per driver (1-3)</p>
                  </div>
                  <div className="space-y-2">
                    <Label>Stacked Search Radius (meters)</Label>
                    <Input type="number" min="500" max="10000" step="100" value={settings.stackedSearchRadiusMeters}
                      onChange={(e) => updateSetting('stackedSearchRadiusMeters', parseInt(e.target.value) || 2000)}
                      disabled={isLoading || !settings.stackedRidesEnabled} />
                    <p className="text-xs text-muted-foreground">Search radius for finding stackable rides ({fromKm(settings.stackedSearchRadiusMeters / 1000).toFixed(2)} {unitShort})</p>
                  </div>
                  <div className="space-y-2">
                    <Label>Offer Window (minutes)</Label>
                    <Input type="number" min="1" max="15" value={settings.stackedOfferWindowMinutes}
                      onChange={(e) => updateSetting('stackedOfferWindowMinutes', parseInt(e.target.value) || 5)}
                      disabled={isLoading || !settings.stackedRidesEnabled} />
                    <p className="text-xs text-muted-foreground">Time before current trip ends to offer stacked ride</p>
                  </div>
                  <div className="space-y-2">
                    <Label>Priority Mode</Label>
                    <Select value={settings.stackedPriorityMode} 
                      onValueChange={(value: 'same_direction' | 'nearest' | 'highest_fare') => updateSetting('stackedPriorityMode', value)}
                      disabled={isLoading || !settings.stackedRidesEnabled}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="same_direction">Same Direction First</SelectItem>
                        <SelectItem value="nearest">Nearest Pickup First</SelectItem>
                        <SelectItem value="highest_fare">Highest Fare First</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">How to prioritize stacked ride offers</p>
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="matching" className="space-y-6 pt-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-2">
                    <Label>Minimum Trip Distance ({unitShort})</Label>
                    <Input type="number" step="0.5" min="0" value={fromKm(settings.stackedMinTripDistanceKm)}
                      onChange={(e) => updateSetting('stackedMinTripDistanceKm', toKm(parseFloat(e.target.value) || 0))}
                      disabled={isLoading || !settings.stackedRidesEnabled} />
                    <p className="text-xs text-muted-foreground">Minimum trip distance to qualify for stacking</p>
                  </div>
                  <div className="space-y-2">
                    <Label>Max Detour Time (minutes)</Label>
                    <Input type="number" min="1" max="30" value={settings.stackedMaxDetourMinutes}
                      onChange={(e) => updateSetting('stackedMaxDetourMinutes', parseInt(e.target.value) || 10)}
                      disabled={isLoading || !settings.stackedRidesEnabled} />
                    <p className="text-xs text-muted-foreground">Maximum detour allowed for stacked pickup</p>
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="incentives" className="space-y-6 pt-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-2">
                    <Label>Driver Incentive (%)</Label>
                    <Input type="number" min="0" max="100" value={settings.stackedDriverIncentive}
                      onChange={(e) => updateSetting('stackedDriverIncentive', Math.min(100, Math.max(0, parseInt(e.target.value) || 0)))}
                      disabled={isLoading || !settings.stackedRidesEnabled} />
                    <p className="text-xs text-muted-foreground">Bonus percentage for accepting stacked rides</p>
                  </div>
                  <div className="space-y-2">
                    <Label>Rider Discount (%)</Label>
                    <Input type="number" min="0" max="50" value={settings.stackedRiderDiscount}
                      onChange={(e) => updateSetting('stackedRiderDiscount', Math.min(50, Math.max(0, parseInt(e.target.value) || 0)))}
                      disabled={isLoading || !settings.stackedRidesEnabled} />
                    <p className="text-xs text-muted-foreground">Discount for riders who opt into stacked rides</p>
                  </div>
                </div>
                <div className="flex items-start gap-2 p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg">
                  <Percent className="h-4 w-4 text-green-600 mt-0.5" />
                  <p className="text-sm text-green-700 dark:text-green-400">
                    Incentives help increase stacked ride acceptance rates and rider participation.
                  </p>
                </div>
              </TabsContent>

              <TabsContent value="display" className="space-y-4 pt-4">
                <div className="flex items-center justify-between p-4 border rounded-lg">
                  <div>
                    <p className="font-medium">Show ETA to Driver</p>
                    <p className="text-sm text-muted-foreground">Display estimated pickup time for stacked ride</p>
                  </div>
                  <Switch checked={settings.stackedShowEtaToDriver} onCheckedChange={(checked) => updateSetting('stackedShowEtaToDriver', checked)}
                    disabled={isLoading || !settings.stackedRidesEnabled} />
                </div>
                <div className="flex items-center justify-between p-4 border rounded-lg">
                  <div>
                    <p className="font-medium">Allow Rider Opt-Out</p>
                    <p className="text-sm text-muted-foreground">Let riders choose to not be part of stacked rides</p>
                  </div>
                  <Switch checked={settings.stackedAllowRiderOptOut} onCheckedChange={(checked) => updateSetting('stackedAllowRiderOptOut', checked)}
                    disabled={isLoading || !settings.stackedRidesEnabled} />
                </div>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>

        {/* Scheduled Rides Configuration */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <Clock className="h-5 w-5 text-muted-foreground" />
              <div>
                <CardTitle>Scheduled Rides Configuration</CardTitle>
                <CardDescription>Policy layer for advance scheduled bookings — does not affect dispatch ranking</CardDescription>
              </div>
              <Badge variant="outline" className="ml-auto">Policy</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="flex items-center justify-between p-4 border rounded-lg">
              <div>
                <p className="font-medium">Scheduled Rides</p>
                <p className="text-sm text-muted-foreground">Enable or disable scheduled ride bookings system-wide</p>
              </div>
              <Switch checked={settings.scheduledRidesEnabled} onCheckedChange={(checked) => updateSetting('scheduledRidesEnabled', checked)} disabled={isLoading} />
            </div>

            <Tabs value={scheduledTab} onValueChange={setScheduledTab}>
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="booking">Booking Window</TabsTrigger>
                <TabsTrigger value="dispatch">Dispatch</TabsTrigger>
                <TabsTrigger value="reminders">Reminders</TabsTrigger>
              </TabsList>
              
              <TabsContent value="booking" className="space-y-6 pt-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-2">
                    <Label>Minimum Advance Time (minutes)</Label>
                    <Input type="number" min="5" max="120" value={settings.minAdvanceTimeMinutes}
                      onChange={(e) => updateSetting('minAdvanceTimeMinutes', parseInt(e.target.value) || 15)}
                      disabled={isLoading || !settings.scheduledRidesEnabled} />
                    <p className="text-xs text-muted-foreground">Minimum time before a ride can be scheduled</p>
                  </div>
                  <div className="space-y-2">
                    <Label>Maximum Advance Days</Label>
                    <Input type="number" min="1" max="90" value={settings.maxAdvanceDays}
                      onChange={(e) => updateSetting('maxAdvanceDays', parseInt(e.target.value) || 30)}
                      disabled={isLoading || !settings.scheduledRidesEnabled} />
                    <p className="text-xs text-muted-foreground">How far in advance rides can be booked</p>
                  </div>
                  <div className="space-y-2">
                    <Label>Waiting Time Grace Period (minutes)</Label>
                    <Input type="number" min="0" max="30" value={settings.waitingTimeGracePeriodMinutes}
                      onChange={(e) => updateSetting('waitingTimeGracePeriodMinutes', parseInt(e.target.value) || 5)}
                      disabled={isLoading || !settings.scheduledRidesEnabled} />
                    <p className="text-xs text-muted-foreground">Free waiting time before charges apply</p>
                  </div>
                </div>
                <div className="flex items-center justify-between p-4 border rounded-lg">
                  <div>
                    <p className="font-medium">Scheduled Ride Incentives</p>
                    <p className="text-sm text-muted-foreground">Offer bonus for early acceptance</p>
                  </div>
                  <Switch checked={settings.scheduledRideIncentivesEnabled}
                    onCheckedChange={(checked) => updateSetting('scheduledRideIncentivesEnabled', checked)}
                    disabled={isLoading || !settings.scheduledRidesEnabled} />
                </div>
              </TabsContent>

              <TabsContent value="dispatch" className="space-y-6 pt-4">
                <div className="p-4 bg-muted/50 rounded-lg">
                  <p className="text-sm text-muted-foreground">
                    Scheduled rides use the same <span className="font-medium text-foreground">Dispatch Scoring & Execution</span> settings above for driver ranking, radius expansion, and wave dispatch.
                    The settings below control when a scheduled ride converts to urgent and begins per-wave broadcasting.
                  </p>
                </div>

                <div className="flex items-center justify-between p-4 border rounded-lg">
                  <div>
                    <p className="font-medium">Enable Scheduled → Urgent Auto Conversion</p>
                    <p className="text-sm text-muted-foreground">Automatically convert unaccepted scheduled rides to urgent dispatch</p>
                  </div>
                  <Switch
                    checked={settings.enableScheduledToUrgentConversion}
                    onCheckedChange={(checked) => updateSetting('enableScheduledToUrgentConversion', checked)}
                    disabled={isLoading || !settings.scheduledRidesEnabled}
                  />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-2">
                    <Label>Scheduled Response Window (minutes)</Label>
                    <Input
                      type="number" min="1" max="60"
                      value={settings.scheduledResponseWindowMinutes}
                      onChange={(e) => updateSetting('scheduledResponseWindowMinutes', Math.max(1, Math.min(60, parseInt(e.target.value) || 10)))}
                      disabled={isLoading || !settings.scheduledRidesEnabled || !settings.enableScheduledToUrgentConversion}
                    />
                    <p className="text-xs text-muted-foreground">If no driver accepts within this window, convert to urgent. Default: 10</p>
                  </div>
                  <div className="space-y-2">
                    <Label>Urgent Dispatch Trigger Before Pickup (minutes)</Label>
                    <Input
                      type="number" min="1" max="30"
                      value={settings.urgentDispatchTriggerMinutesBeforePickup}
                      onChange={(e) => updateSetting('urgentDispatchTriggerMinutesBeforePickup', Math.max(1, Math.min(30, parseInt(e.target.value) || 5)))}
                      disabled={isLoading || !settings.scheduledRidesEnabled || !settings.enableScheduledToUrgentConversion}
                    />
                    <p className="text-xs text-muted-foreground">Convert to urgent when current time reaches pickup_time minus this value. Default: 5</p>
                  </div>
                  <div className="space-y-2">
                    <Label>Locked Driver Response Time (minutes)</Label>
                    <Input
                      type="number" min="1" max="15"
                      value={settings.lockedDriverResponseMinutes}
                      onChange={(e) => updateSetting('lockedDriverResponseMinutes', Math.max(1, Math.min(15, parseInt(e.target.value) || 3)))}
                      disabled={isLoading || !settings.scheduledRidesEnabled}
                    />
                    <p className="text-xs text-muted-foreground">Time the locked (accepted) driver has to confirm before reassignment. Default: 3</p>
                  </div>
                  <div className="space-y-2">
                    <Label>Scheduled Urgent Card Label</Label>
                    <Input
                      type="text"
                      value={settings.scheduledUrgentCardLabel}
                      onChange={(e) => updateSetting('scheduledUrgentCardLabel', e.target.value || 'Scheduled • Urgent')}
                      disabled={isLoading || !settings.scheduledRidesEnabled || !settings.enableScheduledToUrgentConversion}
                    />
                    <p className="text-xs text-muted-foreground">Label shown on the ride offer card after conversion. Default: Scheduled • Urgent</p>
                  </div>
                </div>

                <div className="flex items-start gap-2 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
                  <Info className="h-4 w-4 text-amber-600 mt-0.5" />
                  <div className="text-sm text-amber-700 dark:text-amber-400 space-y-1">
                    <p className="font-medium">Scheduled → Urgent Workflow</p>
                    <p>Before acceptance: job stays in the Scheduled Jobs banner. Conversion triggers (whichever first): response window expires OR pickup time minus trigger minutes is reached. After conversion: normal ride alert with per-wave broadcasting. After acceptance: driver becomes locked, broadcast stops.</p>
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="reminders" className="pt-4">
                <div className="p-4 bg-muted/50 rounded-lg">
                  <p className="text-sm text-muted-foreground">
                    Reminder notifications are configured in the Notifications & Alerts settings page.
                  </p>
                </div>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>

        {/* System Settings */}
        <Card>
          <CardHeader>
            <CardTitle>System Settings</CardTitle>
            <CardDescription>Operational flags — do not affect dispatch ranking or scoring</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between p-4 border rounded-lg">
              <div>
                <p className="font-medium">Enable Logging</p>
                <p className="text-sm text-muted-foreground">Log all dispatch events for debugging</p>
              </div>
              <Switch checked={settings.enableLogging} onCheckedChange={(checked) => updateSetting('enableLogging', checked)} disabled={isLoading} />
            </div>
            <div className="flex items-center justify-between p-4 border rounded-lg">
              <div>
                <p className="font-medium">Simulate Mode</p>
                <p className="text-sm text-muted-foreground">Test dispatch without actual driver assignments</p>
              </div>
              <Switch checked={settings.simulateMode} onCheckedChange={(checked) => updateSetting('simulateMode', checked)} disabled={isLoading} />
            </div>
            <div className="flex items-center justify-between p-4 border rounded-lg">
              <div>
                <p className="font-medium">Block Multiple Active Rides</p>
                <p className="text-sm text-muted-foreground">Prevent drivers from having multiple active rides</p>
              </div>
              <Switch checked={settings.blockMultipleActiveRides} onCheckedChange={(checked) => updateSetting('blockMultipleActiveRides', checked)} disabled={isLoading} />
            </div>
            <div className="flex items-center justify-between p-4 border rounded-lg">
              <div>
                <p className="font-medium">Cancel Protection</p>
                <p className="text-sm text-muted-foreground">Protect against frequent cancellations</p>
              </div>
              <Switch checked={settings.cancelProtection} onCheckedChange={(checked) => updateSetting('cancelProtection', checked)} disabled={isLoading} />
            </div>
          </CardContent>
        </Card>


        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Driver Fare Display
              {settings.driverFareDisplay === 'smart_display' && (
                <Badge className="bg-green-500/10 text-green-600 border-green-200">Recommended</Badge>
              )}
            </CardTitle>
            <CardDescription>Control what fare information drivers see in ride offers, trip summaries, and wallet</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Display Mode Selection */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {([
                {
                  value: 'net_earnings' as const,
                  label: 'Net Earnings Only',
                  description: 'Drivers always see their net earnings after commission, regardless of payment method.',
                },
                {
                  value: 'gross_fare' as const,
                  label: 'Gross Fare Only',
                  description: 'Drivers always see the full customer fare, regardless of payment method.',
                },
                {
                  value: 'smart_display' as const,
                  label: 'Smart Display',
                  description: 'Adapts based on payment method — shows gross for cash, net for digital payments.',
                  recommended: true,
                },
              ]).map((mode) => (
                <button
                  key={mode.value}
                  type="button"
                  onClick={() => updateSetting('driverFareDisplay', mode.value)}
                  disabled={isLoading}
                  className={`relative p-4 border-2 rounded-lg text-left transition-all ${
                    settings.driverFareDisplay === mode.value
                      ? 'border-primary bg-primary/5 ring-1 ring-primary/20'
                      : 'border-border hover:border-muted-foreground/30'
                  } disabled:opacity-50`}
                >
                  {'recommended' in mode && mode.recommended && (
                    <Badge className="absolute -top-2 right-3 bg-primary text-primary-foreground text-[10px] px-1.5 py-0">
                      Recommended
                    </Badge>
                  )}
                  <div className="flex items-center gap-2 mb-1">
                    <div className={`h-3 w-3 rounded-full border-2 ${
                      settings.driverFareDisplay === mode.value ? 'border-primary bg-primary' : 'border-muted-foreground/40'
                    }`} />
                    <p className="font-medium text-sm">{mode.label}</p>
                  </div>
                  <p className="text-xs text-muted-foreground ml-5">{mode.description}</p>
                </button>
              ))}
            </div>

            {/* Smart Display Preview */}
            {settings.driverFareDisplay === 'smart_display' && (
              <div className="space-y-4">
                <div className="flex items-start gap-2 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
                  <Info className="h-4 w-4 text-blue-600 mt-0.5 shrink-0" />
                  <div className="text-sm text-blue-700 dark:text-blue-400">
                    <p className="font-medium">Smart Display Logic</p>
                    <p className="mt-1"><strong>Cash trips:</strong> Show gross fare (driver collects cash) + commission breakdown in details.</p>
                    <p><strong>Digital trips</strong> (Card, Apple Pay, Google Pay): Show net earnings (what arrives in wallet).</p>
                  </div>
                </div>

                {/* Ride Offer Card Previews */}
                <div>
                  <p className="text-sm font-medium mb-3">Ride Offer Card Preview</p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* Cash Trip Preview */}
                    <div className="border rounded-lg overflow-hidden">
                      <div className="bg-muted/50 px-4 py-2 flex items-center justify-between">
                        <span className="text-xs font-medium text-muted-foreground">Cash Trip</span>
                        <Badge className="bg-green-500/10 text-green-600 border-green-200 text-[10px]">CASH</Badge>
                      </div>
                      <div className="p-4 space-y-2">
                        <div className="flex items-baseline gap-1">
                          <span className="text-xs text-muted-foreground">Fare</span>
                          <span className="text-xl font-bold">£70.00</span>
                        </div>
                        <p className="text-xs text-muted-foreground">You keep £59.50</p>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground pt-1 border-t">
                          <span>📍 Pickup → Dropoff</span>
                          <span>•</span>
                          <span>4.2 mi</span>
                        </div>
                      </div>
                    </div>
                    {/* Digital Trip Preview */}
                    <div className="border rounded-lg overflow-hidden">
                      <div className="bg-muted/50 px-4 py-2 flex items-center justify-between">
                        <span className="text-xs font-medium text-muted-foreground">Digital Trip</span>
                        <Badge className="bg-blue-500/10 text-blue-600 border-blue-200 text-[10px]">CARD</Badge>
                      </div>
                      <div className="p-4 space-y-2">
                        <div className="flex items-baseline gap-1">
                          <span className="text-xs text-muted-foreground">You earn</span>
                          <span className="text-xl font-bold">£59.50</span>
                        </div>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground pt-1 border-t">
                          <span>📍 Pickup → Dropoff</span>
                          <span>•</span>
                          <span>4.2 mi</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Completed Trip Summary Previews */}
                <div>
                  <p className="text-sm font-medium mb-3">Completed Trip Summary Preview</p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* Cash Completed */}
                    <div className="border rounded-lg overflow-hidden">
                      <div className="bg-muted/50 px-4 py-2">
                        <span className="text-xs font-medium text-muted-foreground">Cash — Completed</span>
                      </div>
                      <div className="p-4 space-y-1.5 text-sm">
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Payment Method</span>
                          <Badge className="bg-green-500/10 text-green-600 border-green-200 text-[10px]">Cash</Badge>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Fare Collected</span>
                          <span className="font-medium">£70.00</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">ONECAB Commission</span>
                          <span className="text-red-500">−£10.50</span>
                        </div>
                        <div className="flex justify-between pt-1.5 border-t font-medium">
                          <span>Your Net Earnings</span>
                          <span className="text-green-600">£59.50</span>
                        </div>
                      </div>
                    </div>
                    {/* Digital Completed */}
                    <div className="border rounded-lg overflow-hidden">
                      <div className="bg-muted/50 px-4 py-2">
                        <span className="text-xs font-medium text-muted-foreground">Digital — Completed</span>
                      </div>
                      <div className="p-4 space-y-1.5 text-sm">
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Payment Method</span>
                          <Badge className="bg-blue-500/10 text-blue-600 border-blue-200 text-[10px]">Card</Badge>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Customer Paid Digitally</span>
                          <span className="font-medium">£70.00</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">ONECAB Commission</span>
                          <span className="text-red-500">−£10.50</span>
                        </div>
                        <div className="flex justify-between pt-1.5 border-t font-medium">
                          <span>Your Net Earnings</span>
                          <span className="text-green-600">£59.50</span>
                        </div>
                        <p className="text-xs text-muted-foreground pt-1">Paid to wallet/payout</p>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Wallet Page Breakdown */}
                <div>
                  <p className="text-sm font-medium mb-3">Wallet Page Breakdown</p>
                  <div className="border rounded-lg p-4 max-w-sm">
                    <div className="space-y-2 text-sm">
                      <div className="flex justify-between font-medium text-base">
                        <span>Today's Earnings</span>
                        <span>£189.50</span>
                      </div>
                      <div className="border-t pt-2 space-y-1.5">
                        <div className="flex justify-between text-muted-foreground">
                          <span>💳 Card Total</span>
                          <span>£119.50</span>
                        </div>
                        <div className="flex justify-between text-muted-foreground">
                          <span>💵 Cash Total</span>
                          <span>£70.00</span>
                        </div>
                      </div>
                      <div className="border-t pt-2">
                        <div className="flex justify-between font-medium text-green-600">
                          <span>Available Payout</span>
                          <span>£119.50</span>
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">Digital earnings only — cash already collected</p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AdminLayout>
  );
}
