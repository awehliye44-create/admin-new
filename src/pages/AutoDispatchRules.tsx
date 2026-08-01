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
import { Link } from 'react-router-dom';
import { StackedRidesHelpPanel } from '@/components/dispatch/StackedRidesHelpPanel';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
// useServiceAreas removed — dispatch config is global
import { useRegions } from '@/hooks/useRegions';
import { convertDistance, convertToKm, getDistanceUnitShort } from '@/lib/regionSettings';
import {
  SCHEDULED_COMMITMENT_POLICY_DEFAULTS,
  SCHEDULED_REMINDER_POLICY_LINKS,
  STACKING_SCHEDULED_COMMITMENT_HELP,
  STACKING_SCHEDULED_COMMITMENT_LABEL,
  mapCommitmentPolicyFromDb,
  mapCommitmentPolicyToDb,
  validateScheduledBookingPolicy,
  validateScheduledCommitmentPolicy,
  type ScheduledCommitmentPolicy,
} from '../../shared/scheduledRidesPolicySSOT';

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
  allowAirportStacking: boolean;
  allowScheduledStacking: boolean;
  allowStackingDuringPickupWaiting: boolean;
  allowStackingDuringStopWaiting: boolean;

  // Scheduled Rides (policy layer)
  scheduledRidesEnabled: boolean;
  minAdvanceTimeMinutes: number;
  maxAdvanceDays: number;
  scheduledRideIncentivesEnabled: boolean;
  scheduledResponseWindowMinutes: number;
  /** Fallback only — no pre-confirmed driver. */
  urgentDispatchTriggerMinutesBeforePickup: number;
  lockedDriverResponseMinutes: number;
  scheduledUrgentCardLabel: string;
  enableScheduledToUrgentConversion: boolean;

  // Confirmed-driver dynamic commitment policy knobs (Admin stores only)
  checkInMinLeadMinutes: number;
  checkInGraceMinutes: number;
  earlyArrivalBufferMinutes: number;
  safetyBufferMinutes: number;
  startJourneyGraceMinutes: number;
  driverLocationFreshnessSeconds: number;
  notMovingDetectionMinutes: number;
  rescueSearchLeadMinutes: number;
  adminEscalationLeadMinutes: number;
  scheduledTurnaroundBufferMinutes: number;
  minGapBetweenScheduledMinutes: number;
  expectedPickupWaitingMinutes: number;
  expectedStopWaitingMinutes: number;
  etaRiskToleranceMinutes: number;
  pickupAccessAllowanceMinutes: number;

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
  allowAirportStacking: false,
  allowScheduledStacking: false,
  allowStackingDuringPickupWaiting: false,
  allowStackingDuringStopWaiting: false,

  scheduledRidesEnabled: true,
  minAdvanceTimeMinutes: 15,
  maxAdvanceDays: 30,
  scheduledRideIncentivesEnabled: false,
  scheduledResponseWindowMinutes: 10,
  urgentDispatchTriggerMinutesBeforePickup: 5,
  lockedDriverResponseMinutes: SCHEDULED_COMMITMENT_POLICY_DEFAULTS.driver_response_timeout_minutes,
  scheduledUrgentCardLabel: 'Scheduled • Urgent',
  enableScheduledToUrgentConversion: true,
  checkInMinLeadMinutes: SCHEDULED_COMMITMENT_POLICY_DEFAULTS.check_in_min_lead_minutes,
  checkInGraceMinutes: SCHEDULED_COMMITMENT_POLICY_DEFAULTS.check_in_grace_minutes,
  earlyArrivalBufferMinutes: SCHEDULED_COMMITMENT_POLICY_DEFAULTS.early_arrival_buffer_minutes,
  safetyBufferMinutes: SCHEDULED_COMMITMENT_POLICY_DEFAULTS.safety_buffer_minutes,
  startJourneyGraceMinutes: SCHEDULED_COMMITMENT_POLICY_DEFAULTS.start_journey_grace_minutes,
  driverLocationFreshnessSeconds: SCHEDULED_COMMITMENT_POLICY_DEFAULTS.driver_location_freshness_seconds,
  notMovingDetectionMinutes: SCHEDULED_COMMITMENT_POLICY_DEFAULTS.not_moving_detection_minutes,
  rescueSearchLeadMinutes: SCHEDULED_COMMITMENT_POLICY_DEFAULTS.rescue_search_lead_minutes,
  adminEscalationLeadMinutes: SCHEDULED_COMMITMENT_POLICY_DEFAULTS.admin_escalation_lead_minutes,
  scheduledTurnaroundBufferMinutes: SCHEDULED_COMMITMENT_POLICY_DEFAULTS.scheduled_turnaround_buffer_minutes,
  minGapBetweenScheduledMinutes: SCHEDULED_COMMITMENT_POLICY_DEFAULTS.min_gap_between_scheduled_minutes,
  expectedPickupWaitingMinutes: SCHEDULED_COMMITMENT_POLICY_DEFAULTS.expected_pickup_waiting_minutes,
  expectedStopWaitingMinutes: SCHEDULED_COMMITMENT_POLICY_DEFAULTS.expected_stop_waiting_minutes,
  etaRiskToleranceMinutes: SCHEDULED_COMMITMENT_POLICY_DEFAULTS.eta_risk_tolerance_minutes,
  pickupAccessAllowanceMinutes: SCHEDULED_COMMITMENT_POLICY_DEFAULTS.pickup_access_allowance_minutes,
  enableLogging: false,
  simulateMode: false,
  blockMultipleActiveRides: false,
  cancelProtection: false,

};

// DB stores all distances in METERS. UI keeps km-named state for display conversion.
const mapDbToSettings = (data: Record<string, unknown>): DispatchSettings => {
  const commitment = mapCommitmentPolicyFromDb(data);
  return {
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
  allowAirportStacking: Boolean(data.allow_airport_stacking),
  allowScheduledStacking: Boolean(data.allow_scheduled_stacking),
  allowStackingDuringPickupWaiting: Boolean(data.allow_stacking_during_pickup_waiting),
  allowStackingDuringStopWaiting: Boolean(data.allow_stacking_during_stop_waiting),

  scheduledRidesEnabled: (data.scheduled_rides_enabled as boolean) ?? defaultSettings.scheduledRidesEnabled,
  minAdvanceTimeMinutes: (data.min_advance_time_minutes as number) ?? defaultSettings.minAdvanceTimeMinutes,
  maxAdvanceDays: (data.max_advance_days as number) ?? defaultSettings.maxAdvanceDays,
  scheduledRideIncentivesEnabled: (data.scheduled_ride_incentives_enabled as boolean) ?? defaultSettings.scheduledRideIncentivesEnabled,
  scheduledResponseWindowMinutes: (data.scheduled_response_window_minutes as number) ?? defaultSettings.scheduledResponseWindowMinutes,
  urgentDispatchTriggerMinutesBeforePickup: (data.urgent_dispatch_trigger_minutes_before_pickup as number) ?? defaultSettings.urgentDispatchTriggerMinutesBeforePickup,
  lockedDriverResponseMinutes: commitment.driver_response_timeout_minutes,
  scheduledUrgentCardLabel: (data.scheduled_urgent_card_label as string) ?? defaultSettings.scheduledUrgentCardLabel,
  enableScheduledToUrgentConversion: (data.enable_scheduled_to_urgent_conversion as boolean) ?? defaultSettings.enableScheduledToUrgentConversion,
  checkInMinLeadMinutes: commitment.check_in_min_lead_minutes,
  checkInGraceMinutes: commitment.check_in_grace_minutes,
  earlyArrivalBufferMinutes: commitment.early_arrival_buffer_minutes,
  safetyBufferMinutes: commitment.safety_buffer_minutes,
  startJourneyGraceMinutes: commitment.start_journey_grace_minutes,
  driverLocationFreshnessSeconds: commitment.driver_location_freshness_seconds,
  notMovingDetectionMinutes: commitment.not_moving_detection_minutes,
  rescueSearchLeadMinutes: commitment.rescue_search_lead_minutes,
  adminEscalationLeadMinutes: commitment.admin_escalation_lead_minutes,
  scheduledTurnaroundBufferMinutes: commitment.scheduled_turnaround_buffer_minutes,
  minGapBetweenScheduledMinutes: commitment.min_gap_between_scheduled_minutes,
  expectedPickupWaitingMinutes: commitment.expected_pickup_waiting_minutes,
  expectedStopWaitingMinutes: commitment.expected_stop_waiting_minutes,
  etaRiskToleranceMinutes: commitment.eta_risk_tolerance_minutes,
  pickupAccessAllowanceMinutes: commitment.pickup_access_allowance_minutes,
  enableLogging: (data.enable_logging as boolean) ?? defaultSettings.enableLogging,
  simulateMode: (data.simulate_mode as boolean) ?? defaultSettings.simulateMode,
  blockMultipleActiveRides: (data.block_multiple_active_rides as boolean) ?? defaultSettings.blockMultipleActiveRides,
  cancelProtection: (data.cancel_protection as boolean) ?? defaultSettings.cancelProtection,
  };
};

const settingsToCommitmentPolicy = (settings: DispatchSettings): ScheduledCommitmentPolicy => ({
  check_in_min_lead_minutes: settings.checkInMinLeadMinutes,
  check_in_grace_minutes: settings.checkInGraceMinutes,
  early_arrival_buffer_minutes: settings.earlyArrivalBufferMinutes,
  safety_buffer_minutes: settings.safetyBufferMinutes,
  start_journey_grace_minutes: settings.startJourneyGraceMinutes,
  driver_location_freshness_seconds: settings.driverLocationFreshnessSeconds,
  driver_response_timeout_minutes: settings.lockedDriverResponseMinutes,
  not_moving_detection_minutes: settings.notMovingDetectionMinutes,
  rescue_search_lead_minutes: settings.rescueSearchLeadMinutes,
  admin_escalation_lead_minutes: settings.adminEscalationLeadMinutes,
  scheduled_turnaround_buffer_minutes: settings.scheduledTurnaroundBufferMinutes,
  min_gap_between_scheduled_minutes: settings.minGapBetweenScheduledMinutes,
  expected_pickup_waiting_minutes: settings.expectedPickupWaitingMinutes,
  expected_stop_waiting_minutes: settings.expectedStopWaitingMinutes,
  eta_risk_tolerance_minutes: settings.etaRiskToleranceMinutes,
  pickup_access_allowance_minutes: settings.pickupAccessAllowanceMinutes,
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
  stacked_same_direction_only: false,
  allow_airport_stacking: !!settings.allowAirportStacking,
  allow_scheduled_stacking: !!settings.allowScheduledStacking,
  allow_stacking_during_pickup_waiting: !!settings.allowStackingDuringPickupWaiting,
  allow_stacking_during_stop_waiting: !!settings.allowStackingDuringStopWaiting,

  scheduled_rides_enabled: settings.scheduledRidesEnabled,
  min_advance_time_minutes: settings.minAdvanceTimeMinutes,
  max_advance_days: settings.maxAdvanceDays,
  scheduled_ride_incentives_enabled: settings.scheduledRideIncentivesEnabled,
  scheduled_response_window_minutes: settings.scheduledResponseWindowMinutes,
  urgent_dispatch_trigger_minutes_before_pickup: settings.urgentDispatchTriggerMinutesBeforePickup,
  locked_driver_response_minutes: settings.lockedDriverResponseMinutes,
  scheduled_urgent_card_label: settings.scheduledUrgentCardLabel,
  enable_scheduled_to_urgent_conversion: settings.enableScheduledToUrgentConversion,
  ...mapCommitmentPolicyToDb(settingsToCommitmentPolicy(settings)),
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
    const bookingIssues = validateScheduledBookingPolicy({
      min_advance_time_minutes: settings.minAdvanceTimeMinutes,
      max_advance_days: settings.maxAdvanceDays,
      urgent_dispatch_trigger_minutes_before_pickup:
        settings.urgentDispatchTriggerMinutesBeforePickup,
    });
    const commitmentIssues = validateScheduledCommitmentPolicy(
      settingsToCommitmentPolicy(settings),
    );
    const issues = [...bookingIssues, ...commitmentIssues];
    if (issues.length > 0) {
      toast.error(issues[0]?.message ?? 'Invalid scheduled rides policy');
      return;
    }

    setIsSaving(true);
    try {
      const dbData = mapSettingsToDb(settings);
      const { error } = await supabase
        .from('global_dispatch_settings')
        .update(dbData)
        .eq('singleton', true);
      if (error) throw error;

      // Keep legacy dispatch_settings aligned for older SQL readers.
      await supabase
        .from('dispatch_settings')
        .update({
          max_driver_find_time_minutes: settings.maxDriverFindTimeMinutes,
          stacked_rides_enabled: !!settings.stackedRidesEnabled,
          wave1_offer_expiry_seconds: settings.wave1OfferExpirySeconds,
          wave2_offer_expiry_seconds: settings.wave2OfferExpirySeconds,
          wave3_offer_expiry_seconds: settings.wave3OfferExpirySeconds,
          wave1_size: settings.wave1Size,
          wave2_size: settings.wave2Size,
          wave3_size: settings.wave3Size,
          search_radius_start_km: settings.searchRadiusStartKm,
          search_radius_expand_km: settings.searchRadiusExpandKm,
          search_radius_max_km: settings.searchRadiusMaxKm,
          updated_at: new Date().toISOString(),
        })
        .not('id', 'is', null);

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
                <p className="mt-1">Category priority values are configured per service area under Services → Pricing &amp; Fares → Driver Tiers.</p>
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

        {/* Driver Fare Display — Uber-style Smart Display */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <Percent className="h-5 w-5 text-muted-foreground" />
              <div>
                <CardTitle>Driver Fare Display</CardTitle>
                <CardDescription>How fare information appears to drivers on the ride offer card, trip summary, and wallet</CardDescription>
              </div>
              <Badge variant="outline" className="ml-auto">Display</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Ride Offer Card — Driver App Preview (Net Earnings Only) */}
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Label className="text-sm font-semibold">Ride Offer Card — Driver App Preview</Label>
                <Badge variant="outline" className="text-xs">Net Earnings Only</Badge>
              </div>
              <div className="rounded-lg border bg-card p-4 space-y-2 max-w-md">
                <div className="flex items-center justify-between">
                  <Badge variant="secondary" className="bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">CARD</Badge>
                  <span className="text-xs text-muted-foreground">4.2 km · 12 min</span>
                </div>
                <p className="text-2xl font-bold">You earn £59.50</p>
              </div>
            </div>

            {/* Completed Trip Summary preview — digital only */}
            <div className="space-y-3">
              <Label className="text-sm font-semibold">Completed Trip Summary — Driver App Preview</Label>
              <div className="rounded-lg border bg-muted/30 p-4 space-y-1 text-sm max-w-md">
                <p className="font-semibold mb-2">Digital Trip</p>
                <div className="flex justify-between"><span className="text-muted-foreground">Payment Method</span><span>Card</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Settlement</span><span>Provider SSOT Pipeline</span></div>
                <div className="flex justify-between font-semibold pt-1 border-t mt-1"><span>Driver Earnings</span><span>Calculated by Financial SSOT</span></div>
              </div>
            </div>

            <div className="flex items-start gap-2 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
              <Info className="h-4 w-4 text-blue-600 mt-0.5" />
              <div className="text-sm text-blue-700 dark:text-blue-400">
                Applies to all trips. ONECAB operates using a digital payment model. Driver earnings displayed throughout the platform are calculated by the backend Financial SSOT after commission and any applicable adjustments.
              </div>
            </div>
          </CardContent>
        </Card>


        {/* Stacked Rides Configuration */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <Layers className="h-5 w-5 text-muted-foreground" />
              <div>
                <CardTitle>Stacked Rides Configuration</CardTitle>
                <CardDescription>
                  Radius-only matching — queued offers require the new pickup within search radius of the driver or active dropoff
                </CardDescription>
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
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="general">Configuration</TabsTrigger>
                <TabsTrigger value="help">Help &amp; Rules</TabsTrigger>
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
                    <p className="text-xs text-muted-foreground">
                      New pickup must be within this radius of the driver or the active trip dropoff ({fromKm(settings.stackedSearchRadiusMeters / 1000).toFixed(2)} {unitShort}). Primary stacked matching gate.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label>Offer Window (minutes)</Label>
                    <Input type="number" min="1" max="60" value={settings.stackedOfferWindowMinutes}
                      onChange={(e) => updateSetting('stackedOfferWindowMinutes', parseInt(e.target.value) || 5)}
                      disabled={isLoading || !settings.stackedRidesEnabled} />
                    <p className="text-xs text-muted-foreground">Only stack when active trip&apos;s remaining time is within this window</p>
                  </div>
                </div>
                <p className="text-sm text-muted-foreground">
                  Additional matching rules run after the radius gate. Trips outside the search radius are never offered.
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

                  <div className="space-y-2">
                    <Label>Minimum Trip Distance ({unitShort})</Label>
                    <Input type="number" step="0.5" min="0" value={fromKm(settings.stackedMinTripDistanceKm)}
                      onChange={(e) => updateSetting('stackedMinTripDistanceKm', toKm(parseFloat(e.target.value) || 0))}
                      disabled={isLoading || !settings.stackedRidesEnabled} />
                    <p className="text-xs text-muted-foreground">New trip must be at least this long to qualify for stacking</p>
                  </div>
                  <div className="space-y-2">
                    <Label>Max Detour Time (minutes)</Label>
                    <Input type="number" min="1" max="30" value={settings.stackedMaxDetourMinutes}
                      onChange={(e) => updateSetting('stackedMaxDetourMinutes', parseInt(e.target.value) || 10)}
                      disabled={isLoading || !settings.stackedRidesEnabled} />
                    <p className="text-xs text-muted-foreground">Maximum detour (active drop → new pickup) at the active trip&apos;s speed</p>
                  </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="flex items-center justify-between p-3 border rounded-lg">
                    <div>
                      <p className="text-sm font-medium">Allow Airport Stacking</p>
                      <p className="text-xs text-muted-foreground">Permit stacked offers on airport trips — never bypasses scheduled commitment protection (default off)</p>
                    </div>
                    <Switch checked={settings.allowAirportStacking}
                      onCheckedChange={(checked) => updateSetting('allowAirportStacking', checked)}
                      disabled={isLoading || !settings.stackedRidesEnabled} />
                  </div>
                  <div className="flex items-center justify-between p-3 border rounded-lg">
                    <div>
                      <p className="text-sm font-medium">{STACKING_SCHEDULED_COMMITMENT_LABEL}</p>
                      <p className="text-xs text-muted-foreground">{STACKING_SCHEDULED_COMMITMENT_HELP}</p>
                    </div>
                    <Switch checked={settings.allowScheduledStacking}
                      onCheckedChange={(checked) => updateSetting('allowScheduledStacking', checked)}
                      disabled={isLoading || !settings.stackedRidesEnabled} />
                  </div>
                  <div className="flex items-center justify-between p-3 border rounded-lg">
                    <div>
                      <p className="text-sm font-medium">Stack During Pickup Waiting</p>
                      <p className="text-xs text-muted-foreground">Offer stacked rides while driver waits at pickup — never bypasses scheduled commitment protection (default off)</p>
                    </div>
                    <Switch checked={settings.allowStackingDuringPickupWaiting}
                      onCheckedChange={(checked) => updateSetting('allowStackingDuringPickupWaiting', checked)}
                      disabled={isLoading || !settings.stackedRidesEnabled} />
                  </div>
                  <div className="flex items-center justify-between p-3 border rounded-lg">
                    <div>
                      <p className="text-sm font-medium">Stack During Stop Waiting</p>
                      <p className="text-xs text-muted-foreground">Offer stacked rides during multi-stop paid waiting — never bypasses scheduled commitment protection (default off)</p>
                    </div>
                    <Switch checked={settings.allowStackingDuringStopWaiting}
                      onCheckedChange={(checked) => updateSetting('allowStackingDuringStopWaiting', checked)}
                      disabled={isLoading || !settings.stackedRidesEnabled} />
                  </div>
                </div>
              </TabsContent>


              <TabsContent value="help" className="pt-4">
                <StackedRidesHelpPanel
                  stackedRidesEnabled={settings.stackedRidesEnabled}
                  stackedSearchRadiusMeters={settings.stackedSearchRadiusMeters}
                  stackedMinTripDistanceKm={settings.stackedMinTripDistanceKm}
                  stackedOfferWindowMinutes={settings.stackedOfferWindowMinutes}
                  stackedMaxDetourMinutes={settings.stackedMaxDetourMinutes}
                  maxStackedRides={settings.maxStackedRides}
                  unitShort={unitShort}
                  fromKm={fromKm}
                />
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
              <TabsList className="grid w-full grid-cols-4">
                <TabsTrigger value="booking">Booking Window</TabsTrigger>
                <TabsTrigger value="dispatch">Dispatch</TabsTrigger>
                <TabsTrigger value="commitment">Commitment Policy</TabsTrigger>
                <TabsTrigger value="reminders">Reminders</TabsTrigger>
              </TabsList>
              
              <TabsContent value="booking" className="space-y-6 pt-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-2">
                    <Label>Minimum Advance Time (minutes)</Label>
                    <Input type="number" min="0" max="1440" value={settings.minAdvanceTimeMinutes}
                      onChange={(e) => updateSetting('minAdvanceTimeMinutes', parseInt(e.target.value) || 15)}
                      disabled={isLoading || !settings.scheduledRidesEnabled} />
                    <p className="text-xs text-muted-foreground">Minimum time before a ride can be scheduled</p>
                  </div>
                  <div className="space-y-2">
                    <Label>Maximum Advance Days</Label>
                    <Input type="number" min="1" max="365" value={settings.maxAdvanceDays}
                      onChange={(e) => updateSetting('maxAdvanceDays', parseInt(e.target.value) || 30)}
                      disabled={isLoading || !settings.scheduledRidesEnabled} />
                    <p className="text-xs text-muted-foreground">How far in advance rides can be booked</p>
                  </div>
                </div>
                <div className="flex items-start gap-2 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
                  <Info className="h-4 w-4 text-blue-600 mt-0.5" />
                  <p className="text-sm text-blue-700 dark:text-blue-400">
                    System-wide defaults apply to all service areas. Optional SA overrides use <code className="text-xs">dispatch_settings.scheduled_commitment_policy</code>; location access time can be set on Custom Zones. Disabling scheduled rides does not delete stored configuration.
                  </p>
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
                <div className="p-4 bg-muted/50 rounded-lg space-y-2">
                  <p className="text-sm text-muted-foreground">
                    Scheduled rides use the same <span className="font-medium text-foreground">Dispatch Scoring & Execution</span> settings above for driver ranking, radius expansion, and wave dispatch.
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Confirmed drivers use <span className="font-medium text-foreground">Commitment Policy</span> knobs for dynamic check-in / leave-by / Start journey / risk / rescue timing (runtime calculates from live location, traffic ETA, workload). The urgent trigger below is a fallback only.
                  </p>
                </div>

                <div className="flex items-center justify-between p-4 border rounded-lg">
                  <div>
                    <p className="font-medium">Enable Scheduled → Urgent Auto Conversion</p>
                    <p className="text-sm text-muted-foreground">Fallback path for bookings with no pre-confirmed driver</p>
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
                    <p className="text-xs text-muted-foreground">No-preconfirmed only: convert to urgent if no driver accepts within this window after broadcast. Default: 10</p>
                  </div>
                  <div className="space-y-2">
                    <Label>No-preconfirmed urgent fallback (minutes before pickup)</Label>
                    <Input
                      type="number" min="0" max="180"
                      value={settings.urgentDispatchTriggerMinutesBeforePickup}
                      onChange={(e) => updateSetting('urgentDispatchTriggerMinutesBeforePickup', Math.max(0, Math.min(180, parseInt(e.target.value) || 5)))}
                      disabled={isLoading || !settings.scheduledRidesEnabled || !settings.enableScheduledToUrgentConversion}
                    />
                    <p className="text-xs text-muted-foreground">
                      Does <span className="font-medium">not</span> activate confirmed drivers. Used only when <code className="text-xs">confirmed_driver_id</code> is empty — fixed pickup-minus fallback to start urgent search. Default: 5
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label>Driver response timeout (minutes)</Label>
                    <Input
                      type="number" min="0" max="30"
                      value={settings.lockedDriverResponseMinutes}
                      onChange={(e) => updateSetting('lockedDriverResponseMinutes', Math.max(0, Math.min(30, parseInt(e.target.value) || 3)))}
                      disabled={isLoading || !settings.scheduledRidesEnabled}
                    />
                    <p className="text-xs text-muted-foreground">Policy knob for how long a confirmed driver has to respond after activation / urgent card. Runtime owns enforcement. Default: 3</p>
                  </div>
                  <div className="space-y-2">
                    <Label>Scheduled Urgent Card Label</Label>
                    <Input
                      type="text"
                      value={settings.scheduledUrgentCardLabel}
                      onChange={(e) => updateSetting('scheduledUrgentCardLabel', e.target.value || 'Scheduled • Urgent')}
                      disabled={isLoading || !settings.scheduledRidesEnabled || !settings.enableScheduledToUrgentConversion}
                    />
                    <p className="text-xs text-muted-foreground">Label on the no-preconfirmed urgent offer card. Default: Scheduled • Urgent</p>
                  </div>
                </div>

                <div className="flex items-start gap-2 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
                  <Info className="h-4 w-4 text-amber-600 mt-0.5" />
                  <div className="text-sm text-amber-700 dark:text-amber-400 space-y-1">
                    <p className="font-medium">Two paths</p>
                    <p><span className="font-medium">No pre-confirmed driver:</span> urgent fallback trigger + response window start wave dispatch.</p>
                    <p><span className="font-medium">Confirmed driver:</span> dynamic commitment policy (check-in, leave-by, Start journey, risk, rescue) — not the fixed urgent trigger.</p>
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="commitment" className="space-y-6 pt-4">
                <div className="p-4 bg-muted/50 rounded-lg space-y-2">
                  <p className="text-sm text-muted-foreground">
                    Policy knobs only. Runtime consumers calculate check-in, leave-by, Start journey, risk, and rescue times from scheduled pickup, driver live location, traffic-aware ETA, access allowance, early-arrival buffer, full active+stacked workload, waiting/stop allowances, safety margin, and later confirmed commitments.
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Location overrides may add access time (Custom Zones → Access allowance) without creating separate workflows. Prefer SA defaults + optional zone overrides + these system fallbacks.
                  </p>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {([
                    ['checkInMinLeadMinutes', 'Check-in minimum lead time (minutes)', 'Earliest check-in may open relative to pickup (policy floor).'],
                    ['checkInGraceMinutes', 'Check-in grace period (minutes)', 'Grace after check-in due before missed handling.'],
                    ['earlyArrivalBufferMinutes', 'Required early-arrival buffer (minutes)', 'Buffer requiring arrival before scheduled pickup.'],
                    ['safetyBufferMinutes', 'General safety buffer (minutes)', 'Extra margin applied in commitment timing.'],
                    ['startJourneyGraceMinutes', 'Start journey grace period (minutes)', 'Grace after Start journey due before missed handling.'],
                    ['driverLocationFreshnessSeconds', 'Driver location freshness limit (seconds)', 'Max age of driver presence for commitment calculations.'],
                    ['notMovingDetectionMinutes', 'Not-moving detection period (minutes)', 'How long without movement before risk signals.'],
                    ['rescueSearchLeadMinutes', 'Rescue search lead time (minutes)', 'When rescue search may start before expected failure.'],
                    ['adminEscalationLeadMinutes', 'Admin escalation lead time (minutes)', 'Must be ≥ rescue lead — alert Admin early enough.'],
                    ['scheduledTurnaroundBufferMinutes', 'Scheduled turnaround buffer (minutes)', 'Turnaround between consecutive scheduled jobs.'],
                    ['minGapBetweenScheduledMinutes', 'Minimum gap between scheduled jobs (minutes)', 'Must be ≥ turnaround buffer.'],
                    ['expectedPickupWaitingMinutes', 'Expected pickup-waiting allowance (minutes)', 'Expected wait at pickup in feasibility math.'],
                    ['expectedStopWaitingMinutes', 'Expected stop-waiting allowance (minutes)', 'Expected wait at intermediate stops.'],
                    ['etaRiskToleranceMinutes', 'ETA risk tolerance (minutes)', 'How much ETA slip before at-risk signalling.'],
                    ['pickupAccessAllowanceMinutes', 'Pickup access allowance default (minutes)', 'System default for airports/stations/venues/restricted; zones may override.'],
                  ] as const).map(([key, label, help]) => (
                    <div key={key} className="space-y-2">
                      <Label>{label}</Label>
                      <Input
                        type="number"
                        min="0"
                        value={settings[key]}
                        onChange={(e) => updateSetting(key, Math.max(0, parseInt(e.target.value) || 0))}
                        disabled={isLoading || !settings.scheduledRidesEnabled}
                      />
                      <p className="text-xs text-muted-foreground">{help}</p>
                    </div>
                  ))}
                </div>
              </TabsContent>

              <TabsContent value="reminders" className="pt-4 space-y-4">
                <div className="p-4 bg-muted/50 rounded-lg">
                  <p className="text-sm text-muted-foreground">
                    Notification sound and content stay in{' '}
                    <Link to="/notifications" className="text-primary underline font-medium">Notifications &amp; Alerts</Link>
                    {' '}(SSOT). This tab links the effective scheduled-ride reminder policies — it does not duplicate templates.
                  </p>
                </div>
                <div className="space-y-2">
                  {SCHEDULED_REMINDER_POLICY_LINKS.map((item) => (
                    <div key={item.key} className="flex items-start justify-between gap-4 p-3 border rounded-lg">
                      <div>
                        <p className="text-sm font-medium">{item.label}</p>
                        <p className="text-xs text-muted-foreground">{item.description}</p>
                      </div>
                      <Button variant="outline" size="sm" asChild>
                        <Link to={item.href}>Open</Link>
                      </Button>
                    </div>
                  ))}
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
      </div>
    </AdminLayout>
  );
}
