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
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';

interface DispatchSettings {
  // Core Dispatch Settings
  maxOffersPerRequest: number;
  searchRadiusMeters: number;
  offerExpirySeconds: number;
  batchMode: 'parallel' | 'cascade';

  // Driver Filtering
  minimumRating: number;
  maxCancelRate: number;

  // Anti-Spam & Cooldown
  cooldownAfterRejectSeconds: number;
  maxConcurrentOffersPerDriver: number;

  // Cascade Settings
  cascadeBatchSize: number;
  cascadeStepDelaySeconds: number;

  // Driver Priority & Sorting
  priorityOrder: 'nearest' | 'rating' | 'acceptance' | 'waiting';
  suppressRecentOffersSeconds: number;

  // Stacked Rides
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

  // Scheduled Rides
  scheduledRidesEnabled: boolean;
  minAdvanceTimeMinutes: number;
  maxAdvanceDays: number;
  waitingTimeGracePeriodMinutes: number;
  scheduledRideIncentivesEnabled: boolean;

  // Retry & Timeout
  acceptTimeoutSeconds: number;
  globalTimeoutMinutes: number;
  maxOfferHops: number;
  autoRetryAttempts: number;
  autoReassignEnabled: boolean;
  instantRetryEnabled: boolean;

  // System Settings
  enableLogging: boolean;
  simulateMode: boolean;
  blockMultipleActiveRides: boolean;
  cancelProtection: boolean;

  // Driver Fare Visibility
  driverFareDisplay: 'net_earnings' | 'full_breakdown';

  // Maximum Time to Find Driver
  maxDriverFindTimeMinutes: number;

  // PostGIS Dispatch Scoring
  searchRadiusStartKm: number;
  searchRadiusExpandKm: number;
  searchRadiusMaxKm: number;
  shortlistLimit: number;
  wave1Size: number;
  wave2Size: number;
  wave3Size: number;
  distancePenaltyPerKm: number;
  waitingBonusPerMinute: number;
  maxWaitingBonusMinutes: number;
  fairnessIdleMinutes: number;
  fairnessBoostScore: number;
}

const defaultSettings: DispatchSettings = {
  maxOffersPerRequest: 5,
  searchRadiusMeters: 3000,
  offerExpirySeconds: 20,
  batchMode: 'parallel',
  minimumRating: 0,
  maxCancelRate: 0,
  cooldownAfterRejectSeconds: 180,
  maxConcurrentOffersPerDriver: 1,
  cascadeBatchSize: 3,
  cascadeStepDelaySeconds: 8,
  priorityOrder: 'nearest',
  suppressRecentOffersSeconds: 60,
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
  acceptTimeoutSeconds: 12,
  globalTimeoutMinutes: 15,
  maxOfferHops: 10,
  autoRetryAttempts: 3,
  autoReassignEnabled: false,
  instantRetryEnabled: false,
  enableLogging: false,
  simulateMode: false,
  blockMultipleActiveRides: false,
  cancelProtection: false,
  driverFareDisplay: 'net_earnings',
  maxDriverFindTimeMinutes: 3,
  // PostGIS Dispatch Scoring
  searchRadiusStartKm: 3,
  searchRadiusExpandKm: 5,
  searchRadiusMaxKm: 8,
  shortlistLimit: 100,
  wave1Size: 3,
  wave2Size: 5,
  wave3Size: 10,
  distancePenaltyPerKm: 2.0,
  waitingBonusPerMinute: 0.5,
  maxWaitingBonusMinutes: 20,
  fairnessIdleMinutes: 20,
  fairnessBoostScore: 10,
};

interface ServiceArea {
  id: string;
  name: string;
}

// Map database column names to frontend property names
const mapDbToSettings = (data: Record<string, unknown>): DispatchSettings => ({
  maxOffersPerRequest: (data.max_offers_per_request as number) ?? defaultSettings.maxOffersPerRequest,
  searchRadiusMeters: (data.search_radius_meters as number) ?? defaultSettings.searchRadiusMeters,
  offerExpirySeconds: (data.offer_expiry_seconds as number) ?? defaultSettings.offerExpirySeconds,
  batchMode: (data.batch_mode as 'parallel' | 'cascade') ?? defaultSettings.batchMode,
  minimumRating: Number(data.minimum_rating) ?? defaultSettings.minimumRating,
  maxCancelRate: (data.max_cancel_rate as number) ?? defaultSettings.maxCancelRate,
  cooldownAfterRejectSeconds: (data.cooldown_after_reject_seconds as number) ?? defaultSettings.cooldownAfterRejectSeconds,
  maxConcurrentOffersPerDriver: (data.max_concurrent_offers_per_driver as number) ?? defaultSettings.maxConcurrentOffersPerDriver,
  cascadeBatchSize: (data.cascade_batch_size as number) ?? defaultSettings.cascadeBatchSize,
  cascadeStepDelaySeconds: (data.cascade_step_delay_seconds as number) ?? defaultSettings.cascadeStepDelaySeconds,
  priorityOrder: (data.priority_order as 'nearest' | 'rating' | 'acceptance' | 'waiting') ?? defaultSettings.priorityOrder,
  suppressRecentOffersSeconds: (data.suppress_recent_offers_seconds as number) ?? defaultSettings.suppressRecentOffersSeconds,
  stackedRidesEnabled: (data.stacked_rides_enabled as boolean) ?? defaultSettings.stackedRidesEnabled,
  maxStackedRides: (data.max_stacked_rides as number) ?? defaultSettings.maxStackedRides,
  stackedSearchRadiusMeters: (data.stacked_search_radius_meters as number) ?? defaultSettings.stackedSearchRadiusMeters,
  stackedMinTripDistanceKm: Number(data.stacked_min_trip_distance_km) ?? defaultSettings.stackedMinTripDistanceKm,
  stackedMaxDetourMinutes: (data.stacked_max_detour_minutes as number) ?? defaultSettings.stackedMaxDetourMinutes,
  stackedOfferWindowMinutes: (data.stacked_offer_window_minutes as number) ?? defaultSettings.stackedOfferWindowMinutes,
  stackedPriorityMode: (data.stacked_priority_mode as 'same_direction' | 'nearest' | 'highest_fare') ?? defaultSettings.stackedPriorityMode,
  stackedDriverIncentive: (data.stacked_driver_incentive as number) ?? defaultSettings.stackedDriverIncentive,
  stackedRiderDiscount: (data.stacked_rider_discount as number) ?? defaultSettings.stackedRiderDiscount,
  stackedShowEtaToDriver: (data.stacked_show_eta_to_driver as boolean) ?? defaultSettings.stackedShowEtaToDriver,
  stackedAllowRiderOptOut: (data.stacked_allow_rider_opt_out as boolean) ?? defaultSettings.stackedAllowRiderOptOut,
  scheduledRidesEnabled: (data.scheduled_rides_enabled as boolean) ?? defaultSettings.scheduledRidesEnabled,
  minAdvanceTimeMinutes: (data.min_advance_time_minutes as number) ?? defaultSettings.minAdvanceTimeMinutes,
  maxAdvanceDays: (data.max_advance_days as number) ?? defaultSettings.maxAdvanceDays,
  waitingTimeGracePeriodMinutes: (data.waiting_time_grace_period_minutes as number) ?? defaultSettings.waitingTimeGracePeriodMinutes,
  scheduledRideIncentivesEnabled: (data.scheduled_ride_incentives_enabled as boolean) ?? defaultSettings.scheduledRideIncentivesEnabled,
  acceptTimeoutSeconds: (data.accept_timeout_seconds as number) ?? defaultSettings.acceptTimeoutSeconds,
  globalTimeoutMinutes: (data.global_timeout_minutes as number) ?? defaultSettings.globalTimeoutMinutes,
  maxOfferHops: (data.max_offer_hops as number) ?? defaultSettings.maxOfferHops,
  autoRetryAttempts: (data.auto_retry_attempts as number) ?? defaultSettings.autoRetryAttempts,
  autoReassignEnabled: (data.auto_reassign_enabled as boolean) ?? defaultSettings.autoReassignEnabled,
  instantRetryEnabled: (data.instant_retry_enabled as boolean) ?? defaultSettings.instantRetryEnabled,
  enableLogging: (data.enable_logging as boolean) ?? defaultSettings.enableLogging,
  simulateMode: (data.simulate_mode as boolean) ?? defaultSettings.simulateMode,
  blockMultipleActiveRides: (data.block_multiple_active_rides as boolean) ?? defaultSettings.blockMultipleActiveRides,
  cancelProtection: (data.cancel_protection as boolean) ?? defaultSettings.cancelProtection,
  driverFareDisplay: (data.driver_fare_display as 'net_earnings' | 'full_breakdown') ?? defaultSettings.driverFareDisplay,
  maxDriverFindTimeMinutes: (data.max_driver_find_time_minutes as number) ?? defaultSettings.maxDriverFindTimeMinutes,
  // PostGIS Dispatch Scoring
  searchRadiusStartKm: (data.search_radius_start_km as number) ?? defaultSettings.searchRadiusStartKm,
  searchRadiusExpandKm: (data.search_radius_expand_km as number) ?? defaultSettings.searchRadiusExpandKm,
  searchRadiusMaxKm: (data.search_radius_max_km as number) ?? defaultSettings.searchRadiusMaxKm,
  shortlistLimit: (data.shortlist_limit as number) ?? defaultSettings.shortlistLimit,
  wave1Size: (data.wave1_size as number) ?? defaultSettings.wave1Size,
  wave2Size: (data.wave2_size as number) ?? defaultSettings.wave2Size,
  wave3Size: (data.wave3_size as number) ?? defaultSettings.wave3Size,
  distancePenaltyPerKm: (data.distance_penalty_per_km as number) ?? defaultSettings.distancePenaltyPerKm,
  waitingBonusPerMinute: (data.waiting_bonus_per_minute as number) ?? defaultSettings.waitingBonusPerMinute,
  maxWaitingBonusMinutes: (data.max_waiting_bonus_minutes as number) ?? defaultSettings.maxWaitingBonusMinutes,
  fairnessIdleMinutes: (data.fairness_idle_minutes as number) ?? defaultSettings.fairnessIdleMinutes,
  fairnessBoostScore: (data.fairness_boost_score as number) ?? defaultSettings.fairnessBoostScore,
});

// Map frontend property names to database column names
const mapSettingsToDb = (settings: DispatchSettings, serviceAreaId: string | null) => ({
  service_area_id: serviceAreaId,
  max_offers_per_request: settings.maxOffersPerRequest,
  search_radius_meters: settings.searchRadiusMeters,
  offer_expiry_seconds: settings.offerExpirySeconds,
  batch_mode: settings.batchMode,
  minimum_rating: settings.minimumRating,
  max_cancel_rate: settings.maxCancelRate,
  cooldown_after_reject_seconds: settings.cooldownAfterRejectSeconds,
  max_concurrent_offers_per_driver: settings.maxConcurrentOffersPerDriver,
  cascade_batch_size: settings.cascadeBatchSize,
  cascade_step_delay_seconds: settings.cascadeStepDelaySeconds,
  priority_order: settings.priorityOrder,
  suppress_recent_offers_seconds: settings.suppressRecentOffersSeconds,
  stacked_rides_enabled: settings.stackedRidesEnabled,
  max_stacked_rides: settings.maxStackedRides,
  stacked_search_radius_meters: settings.stackedSearchRadiusMeters,
  stacked_min_trip_distance_km: settings.stackedMinTripDistanceKm,
  stacked_max_detour_minutes: settings.stackedMaxDetourMinutes,
  stacked_offer_window_minutes: settings.stackedOfferWindowMinutes,
  stacked_priority_mode: settings.stackedPriorityMode,
  stacked_driver_incentive: settings.stackedDriverIncentive,
  stacked_rider_discount: settings.stackedRiderDiscount,
  stacked_show_eta_to_driver: settings.stackedShowEtaToDriver,
  stacked_allow_rider_opt_out: settings.stackedAllowRiderOptOut,
  scheduled_rides_enabled: settings.scheduledRidesEnabled,
  min_advance_time_minutes: settings.minAdvanceTimeMinutes,
  max_advance_days: settings.maxAdvanceDays,
  waiting_time_grace_period_minutes: settings.waitingTimeGracePeriodMinutes,
  scheduled_ride_incentives_enabled: settings.scheduledRideIncentivesEnabled,
  accept_timeout_seconds: settings.acceptTimeoutSeconds,
  global_timeout_minutes: settings.globalTimeoutMinutes,
  max_offer_hops: settings.maxOfferHops,
  auto_retry_attempts: settings.autoRetryAttempts,
  auto_reassign_enabled: settings.autoReassignEnabled,
  instant_retry_enabled: settings.instantRetryEnabled,
  enable_logging: settings.enableLogging,
  simulate_mode: settings.simulateMode,
  block_multiple_active_rides: settings.blockMultipleActiveRides,
  cancel_protection: settings.cancelProtection,
  driver_fare_display: settings.driverFareDisplay,
  max_driver_find_time_minutes: settings.maxDriverFindTimeMinutes,
  // PostGIS Dispatch Scoring
  search_radius_start_km: settings.searchRadiusStartKm,
  search_radius_expand_km: settings.searchRadiusExpandKm,
  search_radius_max_km: settings.searchRadiusMaxKm,
  shortlist_limit: settings.shortlistLimit,
  wave1_size: settings.wave1Size,
  wave2_size: settings.wave2Size,
  wave3_size: settings.wave3Size,
  distance_penalty_per_km: settings.distancePenaltyPerKm,
  waiting_bonus_per_minute: settings.waitingBonusPerMinute,
  max_waiting_bonus_minutes: settings.maxWaitingBonusMinutes,
  fairness_idle_minutes: settings.fairnessIdleMinutes,
  fairness_boost_score: settings.fairnessBoostScore,
});

export default function AutoDispatchRules() {
  const [settings, setSettings] = useState<DispatchSettings>(defaultSettings);
  const [serviceAreaId, setServiceAreaId] = useState<string | null>(null);
  const [serviceAreas, setServiceAreas] = useState<ServiceArea[]>([]);
  const [scheduledTab, setScheduledTab] = useState('booking');
  const [stackedTab, setStackedTab] = useState('general');
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [hasChanges, setHasChanges] = useState(false);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);

  // Load service areas
  useEffect(() => {
    const loadServiceAreas = async () => {
      try {
        const { data, error } = await supabase
          .from('service_areas')
          .select('id, name')
          .eq('is_active', true)
          .order('name');

        if (error) throw error;
        setServiceAreas(data || []);
      } catch (err) {
        console.error('Error loading service areas:', err);
      }
    };

    loadServiceAreas();
  }, []);

  // Load dispatch settings from database
  useEffect(() => {
    const loadDispatchSettings = async () => {
      setIsLoading(true);
      try {
        let query = supabase
          .from('dispatch_settings')
          .select('*');

        if (serviceAreaId === null) {
          query = query.is('service_area_id', null);
        } else {
          query = query.eq('service_area_id', serviceAreaId);
        }

        const { data, error } = await query.maybeSingle();

        if (error) throw error;

        if (data) {
          setSettings(mapDbToSettings(data as Record<string, unknown>));
        } else {
          // No settings exist for this service area, use defaults
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
  }, [serviceAreaId]);

  const updateSetting = <K extends keyof DispatchSettings>(
    key: K,
    value: DispatchSettings[K]
  ) => {
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
      const dbData = mapSettingsToDb(settings, serviceAreaId);

      // Check if a record already exists for this service area
      let existingQuery = supabase
        .from('dispatch_settings')
        .select('id');

      if (serviceAreaId === null) {
        existingQuery = existingQuery.is('service_area_id', null);
      } else {
        existingQuery = existingQuery.eq('service_area_id', serviceAreaId);
      }

      const { data: existing } = await existingQuery.maybeSingle();

      let error;
      if (existing) {
        // Update existing record
        let updateQuery = supabase
          .from('dispatch_settings')
          .update(dbData);

        if (serviceAreaId === null) {
          updateQuery = updateQuery.is('service_area_id', null);
        } else {
          updateQuery = updateQuery.eq('service_area_id', serviceAreaId);
        }

        const result = await updateQuery;
        error = result.error;
      } else {
        // Insert new record
        const result = await supabase
          .from('dispatch_settings')
          .insert(dbData);
        error = result.error;
      }

      if (error) throw error;

      setHasChanges(false);
      setLastSaved(new Date());
      toast.success('Auto-dispatch settings saved successfully');
    } catch (err) {
      console.error('Error saving settings:', err);
      toast.error('Failed to save settings');
    } finally {
      setIsSaving(false);
    }
  };

  const handleServiceAreaChange = (value: string) => {
    if (hasChanges) {
      const confirm = window.confirm('You have unsaved changes. Are you sure you want to switch service areas?');
      if (!confirm) return;
    }
    setServiceAreaId(value === 'all' ? null : value);
  };

  return (
    <AdminLayout 
      title="Auto-Dispatch Rules" 
      description="Configure automatic dispatch settings"
    >
      {/* Header with Service Area selector and action buttons */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-6">
        <div className="flex items-center gap-3">
          <Label className="text-sm text-muted-foreground">Service Area:</Label>
          <Select 
            value={serviceAreaId || 'all'} 
            onValueChange={handleServiceAreaChange}
          >
            <SelectTrigger className="w-[200px]">
              <Globe className="h-4 w-4 mr-2" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Service Areas (Global)</SelectItem>
              {serviceAreas.map((area) => (
                <SelectItem key={area.id} value={area.id}>
                  {area.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
            {isSaving ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            {isSaving ? 'Saving...' : 'Save Changes'}
          </Button>
        </div>
      </div>

      <div className="space-y-6">
        {/* Driver Finding Time - Priority Setting */}
        <Card className="border-primary/50">
          <CardHeader>
            <div className="flex items-center gap-3">
              <Timer className="h-5 w-5 text-primary" />
              <div>
                <CardTitle>Maximum Time to Find Driver</CardTitle>
                <CardDescription>
                  Set how long the system searches for a driver before timing out
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <Label>Maximum Search Time (minutes)</Label>
                <Input
                  type="number"
                  min="1"
                  max="15"
                  value={settings.maxDriverFindTimeMinutes}
                  onChange={(e) => updateSetting('maxDriverFindTimeMinutes', Math.max(1, Math.min(15, parseInt(e.target.value) || 3)))}
                  disabled={isLoading}
                />
                <p className="text-xs text-muted-foreground">
                  Default: 3 minutes. Range: 1-15 minutes.
                </p>
              </div>
              <div className="flex items-center">
                <div className="p-4 bg-muted/50 rounded-lg w-full">
                  <p className="text-sm font-medium">Current Setting</p>
                  <p className="text-2xl font-bold text-primary">{settings.maxDriverFindTimeMinutes} min</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Trips will expire if no driver accepts within this time
                  </p>
                </div>
              </div>
            </div>

            {/* Info box */}
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

        {/* Core Dispatch Settings */}
        <Card>
          <CardHeader>
            <CardTitle>Core Dispatch Settings</CardTitle>
            <CardDescription>Configure how rides are dispatched to drivers</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <Label>Max Offers Per Request</Label>
                <Input
                  type="number"
                  min="1"
                  max="20"
                  value={settings.maxOffersPerRequest}
                  onChange={(e) => updateSetting('maxOffersPerRequest', parseInt(e.target.value) || 5)}
                  disabled={isLoading}
                />
                <p className="text-xs text-muted-foreground">
                  Maximum drivers to send offers simultaneously
                </p>
              </div>
              <div className="space-y-2">
                <Label>Search Radius (meters)</Label>
                <Input
                  type="number"
                  min="500"
                  max="50000"
                  step="100"
                  value={settings.searchRadiusMeters}
                  onChange={(e) => updateSetting('searchRadiusMeters', parseInt(e.target.value) || 3000)}
                  disabled={isLoading}
                />
                <p className="text-xs text-muted-foreground">
                  How far to search for available drivers ({(settings.searchRadiusMeters / 1000).toFixed(1)} km)
                </p>
              </div>
              <div className="space-y-2">
                <Label>Offer Expiry (seconds)</Label>
                <Input
                  type="number"
                  min="5"
                  max="120"
                  value={settings.offerExpirySeconds}
                  onChange={(e) => updateSetting('offerExpirySeconds', parseInt(e.target.value) || 20)}
                  disabled={isLoading}
                />
                <p className="text-xs text-muted-foreground">
                  Time driver has to accept before offer expires
                </p>
              </div>
              <div className="space-y-2">
                <Label>Batch Mode</Label>
                <Select 
                  value={settings.batchMode} 
                  onValueChange={(value: 'parallel' | 'cascade') => updateSetting('batchMode', value)}
                  disabled={isLoading}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="parallel">Parallel (All at once)</SelectItem>
                    <SelectItem value="cascade">Cascade (Sequential batches)</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  How to send offers to multiple drivers
                </p>
              </div>
            </div>

            {/* Batch Mode Info */}
            <div className="mt-4 flex items-start gap-2 p-3 bg-muted/50 rounded-lg">
              <Info className="h-4 w-4 text-muted-foreground mt-0.5" />
              <p className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">Parallel:</span> Send to all eligible drivers at once. First to accept wins.{' '}
                <span className="font-medium text-foreground">Cascade:</span> Send in batches, waiting between rounds.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Driver Filtering */}
        <Card>
          <CardHeader>
            <CardTitle>Driver Filtering</CardTitle>
            <CardDescription>Set minimum requirements for drivers to receive ride offers</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <Label>Minimum Rating</Label>
                <Input
                  type="number"
                  step="0.1"
                  min="0"
                  max="5"
                  value={settings.minimumRating}
                  onChange={(e) => updateSetting('minimumRating', Math.min(5, Math.max(0, parseFloat(e.target.value) || 0)))}
                  disabled={isLoading}
                />
                <p className="text-xs text-muted-foreground">
                  {settings.minimumRating === 0 ? 'No minimum (all drivers eligible)' : `Drivers must have ${settings.minimumRating}+ rating`}
                </p>
              </div>
              <div className="space-y-2">
                <Label>Max Cancel Rate (%)</Label>
                <Input
                  type="number"
                  min="0"
                  max="100"
                  value={settings.maxCancelRate}
                  onChange={(e) => updateSetting('maxCancelRate', Math.min(100, Math.max(0, parseInt(e.target.value) || 0)))}
                  disabled={isLoading}
                />
                <p className="text-xs text-muted-foreground">
                  {settings.maxCancelRate === 0 ? 'No limit (all drivers eligible)' : `Exclude drivers with >${settings.maxCancelRate}% cancel rate`}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Anti-Spam & Cooldown */}
        <Card>
          <CardHeader>
            <CardTitle>Anti-Spam & Cooldown</CardTitle>
            <CardDescription>Prevent driver spam and manage offer cooldowns</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <Label>Cooldown After Reject (seconds)</Label>
                <Input
                  type="number"
                  min="0"
                  max="600"
                  value={settings.cooldownAfterRejectSeconds}
                  onChange={(e) => updateSetting('cooldownAfterRejectSeconds', parseInt(e.target.value) || 0)}
                  disabled={isLoading}
                />
                <p className="text-xs text-muted-foreground">
                  Wait time before sending another offer after rejection ({Math.floor(settings.cooldownAfterRejectSeconds / 60)}m {settings.cooldownAfterRejectSeconds % 60}s)
                </p>
              </div>
              <div className="space-y-2">
                <Label>Max Concurrent Offers Per Driver</Label>
                <Input
                  type="number"
                  min="1"
                  max="5"
                  value={settings.maxConcurrentOffersPerDriver}
                  onChange={(e) => updateSetting('maxConcurrentOffersPerDriver', parseInt(e.target.value) || 1)}
                  disabled={isLoading}
                />
                <p className="text-xs text-muted-foreground">
                  Maximum pending ride offers a driver can have at once
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Cascade Settings */}
        <Card>
          <CardHeader>
            <CardTitle>Cascade Settings</CardTitle>
            <CardDescription>Configure cascade batch dispatch behavior (when Batch Mode is Cascade)</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <Label>Cascade Batch Size</Label>
                <Input
                  type="number"
                  min="1"
                  max="10"
                  value={settings.cascadeBatchSize}
                  onChange={(e) => updateSetting('cascadeBatchSize', parseInt(e.target.value) || 3)}
                  disabled={isLoading || settings.batchMode !== 'cascade'}
                />
                <p className="text-xs text-muted-foreground">
                  Number of drivers per cascade batch
                </p>
              </div>
              <div className="space-y-2">
                <Label>Cascade Step Delay (seconds)</Label>
                <Input
                  type="number"
                  min="3"
                  max="30"
                  value={settings.cascadeStepDelaySeconds}
                  onChange={(e) => updateSetting('cascadeStepDelaySeconds', parseInt(e.target.value) || 8)}
                  disabled={isLoading || settings.batchMode !== 'cascade'}
                />
                <p className="text-xs text-muted-foreground">
                  Wait time between cascade batches
                </p>
              </div>
            </div>
            {settings.batchMode !== 'cascade' && (
              <p className="mt-4 text-sm text-muted-foreground italic">
                These settings apply only when Batch Mode is set to "Cascade"
              </p>
            )}
          </CardContent>
        </Card>

        {/* PostGIS Dispatch Scoring */}
        <Card className="border-primary/50">
          <CardHeader>
            <div className="flex items-center gap-3">
              <Globe className="h-5 w-5 text-primary" />
              <div>
                <CardTitle>PostGIS Dispatch Scoring</CardTitle>
                <CardDescription>
                  Advanced radius expansion, wave dispatch, and category-weighted scoring for 5000+ driver scale
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Radius Expansion */}
            <div>
              <h4 className="text-sm font-semibold mb-3">Radius Expansion (km)</h4>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label>Start Radius</Label>
                  <Input type="number" step="0.5" min="0.5" max="20" value={settings.searchRadiusStartKm}
                    onChange={(e) => updateSetting('searchRadiusStartKm', parseFloat(e.target.value) || 3)} disabled={isLoading} />
                  <p className="text-xs text-muted-foreground">Initial search radius</p>
                </div>
                <div className="space-y-2">
                  <Label>Expand Radius</Label>
                  <Input type="number" step="0.5" min="1" max="30" value={settings.searchRadiusExpandKm}
                    onChange={(e) => updateSetting('searchRadiusExpandKm', parseFloat(e.target.value) || 5)} disabled={isLoading} />
                  <p className="text-xs text-muted-foreground">2nd expansion step</p>
                </div>
                <div className="space-y-2">
                  <Label>Max Radius</Label>
                  <Input type="number" step="0.5" min="1" max="50" value={settings.searchRadiusMaxKm}
                    onChange={(e) => updateSetting('searchRadiusMaxKm', parseFloat(e.target.value) || 8)} disabled={isLoading} />
                  <p className="text-xs text-muted-foreground">Final expansion limit</p>
                </div>
              </div>
            </div>

            {/* Shortlist & Waves */}
            <div>
              <h4 className="text-sm font-semibold mb-3">Shortlist & Wave Sizes</h4>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="space-y-2">
                  <Label>Shortlist Limit</Label>
                  <Input type="number" min="10" max="500" value={settings.shortlistLimit}
                    onChange={(e) => updateSetting('shortlistLimit', parseInt(e.target.value) || 100)} disabled={isLoading} />
                  <p className="text-xs text-muted-foreground">Top N to score</p>
                </div>
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

            {/* Scoring Weights */}
            <div>
              <h4 className="text-sm font-semibold mb-3">Scoring Formula Weights</h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Distance Penalty (per km)</Label>
                  <Input type="number" step="0.1" min="0" max="10" value={settings.distancePenaltyPerKm}
                    onChange={(e) => updateSetting('distancePenaltyPerKm', parseFloat(e.target.value) || 2)} disabled={isLoading} />
                  <p className="text-xs text-muted-foreground">Score deduction per km from pickup</p>
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
                  score = category_weight + (waiting_min × waiting_bonus) + fairness_boost − (distance_km × distance_penalty)
                </code>
                <p className="mt-1">Category weights (Bronze=10, Silver=20, Gold=30, Platinum=40, Diamond=50) are set on the Driver Categories page.</p>
              </div>
            </div>
          </CardContent>
        </Card>


        <Card>
          <CardHeader>
            <CardTitle>Driver Priority & Sorting</CardTitle>
            <CardDescription>Configure how drivers are prioritized for ride offers</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <Label>Priority Order</Label>
                <Select 
                  value={settings.priorityOrder} 
                  onValueChange={(value: 'nearest' | 'rating' | 'acceptance' | 'waiting') => updateSetting('priorityOrder', value)}
                  disabled={isLoading}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="nearest">Nearest First</SelectItem>
                    <SelectItem value="rating">Highest Rating First</SelectItem>
                    <SelectItem value="acceptance">Best Acceptance Rate</SelectItem>
                    <SelectItem value="waiting">Longest Waiting First</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  How to order drivers when sending offers
                </p>
              </div>
              <div className="space-y-2">
                <Label>Suppress Recent Offers Within (seconds)</Label>
                <Input
                  type="number"
                  min="0"
                  max="300"
                  value={settings.suppressRecentOffersSeconds}
                  onChange={(e) => updateSetting('suppressRecentOffersSeconds', parseInt(e.target.value) || 0)}
                  disabled={isLoading}
                />
                <p className="text-xs text-muted-foreground">
                  Don't resend offers to drivers who recently received one
                </p>
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
                <CardDescription>Configure chained/stacked ride offers to drivers</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Stacked Rides Toggle */}
            <div className="flex items-center justify-between p-4 border rounded-lg">
              <div>
                <p className="font-medium">Stacked Rides</p>
                <p className="text-sm text-muted-foreground">Enable or disable stacked ride offers system-wide</p>
              </div>
              <Switch
                checked={settings.stackedRidesEnabled}
                onCheckedChange={(checked) => updateSetting('stackedRidesEnabled', checked)}
                disabled={isLoading}
              />
            </div>

            {/* Tabs for Stacked Rides */}
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
                    <Input
                      type="number"
                      min="1"
                      max="3"
                      value={settings.maxStackedRides}
                      onChange={(e) => updateSetting('maxStackedRides', Math.min(3, Math.max(1, parseInt(e.target.value) || 1)))}
                      disabled={isLoading || !settings.stackedRidesEnabled}
                    />
                    <p className="text-xs text-muted-foreground">Maximum queued rides per driver (1-3)</p>
                  </div>
                  <div className="space-y-2">
                    <Label>Stacked Search Radius (meters)</Label>
                    <Input
                      type="number"
                      min="500"
                      max="10000"
                      step="100"
                      value={settings.stackedSearchRadiusMeters}
                      onChange={(e) => updateSetting('stackedSearchRadiusMeters', parseInt(e.target.value) || 2000)}
                      disabled={isLoading || !settings.stackedRidesEnabled}
                    />
                    <p className="text-xs text-muted-foreground">Search radius for finding stackable rides ({(settings.stackedSearchRadiusMeters / 1000).toFixed(1)} km)</p>
                  </div>
                  <div className="space-y-2">
                    <Label>Offer Window (minutes)</Label>
                    <Input
                      type="number"
                      min="1"
                      max="15"
                      value={settings.stackedOfferWindowMinutes}
                      onChange={(e) => updateSetting('stackedOfferWindowMinutes', parseInt(e.target.value) || 5)}
                      disabled={isLoading || !settings.stackedRidesEnabled}
                    />
                    <p className="text-xs text-muted-foreground">Time before current trip ends to offer stacked ride</p>
                  </div>
                  <div className="space-y-2">
                    <Label>Priority Mode</Label>
                    <Select 
                      value={settings.stackedPriorityMode} 
                      onValueChange={(value: 'same_direction' | 'nearest' | 'highest_fare') => updateSetting('stackedPriorityMode', value)}
                      disabled={isLoading || !settings.stackedRidesEnabled}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="same_direction">Same Direction First</SelectItem>
                        <SelectItem value="nearest">Nearest Pickup First</SelectItem>
                        <SelectItem value="highest_fare">Highest Fare First</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">How to prioritize stacked ride offers</p>
                  </div>
                </div>

                {/* Info box */}
                <div className="flex items-start gap-2 p-3 bg-muted/50 rounded-lg">
                  <Info className="h-4 w-4 text-muted-foreground mt-0.5" />
                  <p className="text-sm text-muted-foreground">
                    <span className="font-medium text-foreground">OFF:</span> Single-ride mode only.{' '}
                    <span className="font-medium text-foreground">ON:</span> Drivers may receive queued rides while on an active trip.
                  </p>
                </div>
              </TabsContent>

              <TabsContent value="matching" className="space-y-6 pt-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-2">
                    <Label>Minimum Trip Distance (km)</Label>
                    <Input
                      type="number"
                      step="0.5"
                      min="0"
                      max="50"
                      value={settings.stackedMinTripDistanceKm}
                      onChange={(e) => updateSetting('stackedMinTripDistanceKm', parseFloat(e.target.value) || 0)}
                      disabled={isLoading || !settings.stackedRidesEnabled}
                    />
                    <p className="text-xs text-muted-foreground">Minimum trip distance to qualify for stacking</p>
                  </div>
                  <div className="space-y-2">
                    <Label>Max Detour Time (minutes)</Label>
                    <Input
                      type="number"
                      min="1"
                      max="30"
                      value={settings.stackedMaxDetourMinutes}
                      onChange={(e) => updateSetting('stackedMaxDetourMinutes', parseInt(e.target.value) || 10)}
                      disabled={isLoading || !settings.stackedRidesEnabled}
                    />
                    <p className="text-xs text-muted-foreground">Maximum detour allowed for stacked pickup</p>
                  </div>
                </div>

                {/* Matching info */}
                <div className="flex items-start gap-2 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
                  <Info className="h-4 w-4 text-amber-600 mt-0.5" />
                  <p className="text-sm text-amber-700 dark:text-amber-400">
                    Rides are matched based on proximity to current drop-off, travel direction, and ETA compatibility.
                  </p>
                </div>
              </TabsContent>

              <TabsContent value="incentives" className="space-y-6 pt-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-2">
                    <Label>Driver Incentive (%)</Label>
                    <Input
                      type="number"
                      min="0"
                      max="100"
                      value={settings.stackedDriverIncentive}
                      onChange={(e) => updateSetting('stackedDriverIncentive', Math.min(100, Math.max(0, parseInt(e.target.value) || 0)))}
                      disabled={isLoading || !settings.stackedRidesEnabled}
                    />
                    <p className="text-xs text-muted-foreground">Bonus percentage for accepting stacked rides</p>
                  </div>
                  <div className="space-y-2">
                    <Label>Rider Discount (%)</Label>
                    <Input
                      type="number"
                      min="0"
                      max="50"
                      value={settings.stackedRiderDiscount}
                      onChange={(e) => updateSetting('stackedRiderDiscount', Math.min(50, Math.max(0, parseInt(e.target.value) || 0)))}
                      disabled={isLoading || !settings.stackedRidesEnabled}
                    />
                    <p className="text-xs text-muted-foreground">Discount for riders who opt into stacked rides</p>
                  </div>
                </div>

                {/* Incentive info */}
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
                  <Switch
                    checked={settings.stackedShowEtaToDriver}
                    onCheckedChange={(checked) => updateSetting('stackedShowEtaToDriver', checked)}
                    disabled={isLoading || !settings.stackedRidesEnabled}
                  />
                </div>
                <div className="flex items-center justify-between p-4 border rounded-lg">
                  <div>
                    <p className="font-medium">Allow Rider Opt-Out</p>
                    <p className="text-sm text-muted-foreground">Let riders choose to not be part of stacked rides</p>
                  </div>
                  <Switch
                    checked={settings.stackedAllowRiderOptOut}
                    onCheckedChange={(checked) => updateSetting('stackedAllowRiderOptOut', checked)}
                    disabled={isLoading || !settings.stackedRidesEnabled}
                  />
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
                <CardDescription>Complete settings for advance scheduled rides dispatch</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Scheduled Rides Toggle */}
            <div className="flex items-center justify-between p-4 border rounded-lg">
              <div>
                <p className="font-medium">Scheduled Rides</p>
                <p className="text-sm text-muted-foreground">Enable or disable scheduled ride bookings system-wide</p>
              </div>
              <Switch
                checked={settings.scheduledRidesEnabled}
                onCheckedChange={(checked) => updateSetting('scheduledRidesEnabled', checked)}
                disabled={isLoading}
              />
            </div>

            {/* Tabs for Scheduled Rides */}
            <Tabs value={scheduledTab} onValueChange={setScheduledTab}>
              <TabsList className="grid w-full grid-cols-5">
                <TabsTrigger value="booking">Booking Window</TabsTrigger>
                <TabsTrigger value="dispatch">Dispatch</TabsTrigger>
                <TabsTrigger value="search">Search & Radius</TabsTrigger>
                <TabsTrigger value="reminders">Reminders</TabsTrigger>
                <TabsTrigger value="timeout">Timeout & Retry</TabsTrigger>
              </TabsList>
              
              <TabsContent value="booking" className="space-y-6 pt-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-2">
                    <Label>Minimum Advance Time (minutes)</Label>
                    <Input
                      type="number"
                      min="5"
                      max="120"
                      value={settings.minAdvanceTimeMinutes}
                      onChange={(e) => updateSetting('minAdvanceTimeMinutes', parseInt(e.target.value) || 15)}
                      disabled={isLoading || !settings.scheduledRidesEnabled}
                    />
                    <p className="text-xs text-muted-foreground">Minimum time before a ride can be scheduled</p>
                  </div>
                  <div className="space-y-2">
                    <Label>Maximum Advance Days</Label>
                    <Input
                      type="number"
                      min="1"
                      max="90"
                      value={settings.maxAdvanceDays}
                      onChange={(e) => updateSetting('maxAdvanceDays', parseInt(e.target.value) || 30)}
                      disabled={isLoading || !settings.scheduledRidesEnabled}
                    />
                    <p className="text-xs text-muted-foreground">How far in advance rides can be booked</p>
                  </div>
                  <div className="space-y-2">
                    <Label>Waiting Time Grace Period (minutes)</Label>
                    <Input
                      type="number"
                      min="0"
                      max="30"
                      value={settings.waitingTimeGracePeriodMinutes}
                      onChange={(e) => updateSetting('waitingTimeGracePeriodMinutes', parseInt(e.target.value) || 5)}
                      disabled={isLoading || !settings.scheduledRidesEnabled}
                    />
                    <p className="text-xs text-muted-foreground">Free waiting time before charges apply</p>
                  </div>
                </div>

                {/* Scheduled Ride Incentives */}
                <div className="flex items-center justify-between p-4 border rounded-lg">
                  <div>
                    <p className="font-medium">Scheduled Ride Incentives</p>
                    <p className="text-sm text-muted-foreground">Offer bonus for early acceptance</p>
                  </div>
                  <Switch
                    checked={settings.scheduledRideIncentivesEnabled}
                    onCheckedChange={(checked) => updateSetting('scheduledRideIncentivesEnabled', checked)}
                    disabled={isLoading || !settings.scheduledRidesEnabled}
                  />
                </div>
              </TabsContent>

              <TabsContent value="dispatch" className="pt-4">
                <div className="p-4 bg-muted/50 rounded-lg">
                  <p className="text-sm text-muted-foreground">
                    Scheduled rides use the same dispatch settings as regular rides. Configure the core dispatch settings above to control how scheduled rides are dispatched to drivers.
                  </p>
                </div>
              </TabsContent>

              <TabsContent value="search" className="pt-4">
                <div className="p-4 bg-muted/50 rounded-lg">
                  <p className="text-sm text-muted-foreground">
                    Scheduled rides use the Search Radius configured in Core Dispatch Settings above.
                  </p>
                </div>
              </TabsContent>

              <TabsContent value="reminders" className="pt-4">
                <div className="p-4 bg-muted/50 rounded-lg">
                  <p className="text-sm text-muted-foreground">
                    Reminder notifications are configured in the Notifications & Alerts settings page.
                  </p>
                </div>
              </TabsContent>

              <TabsContent value="timeout" className="pt-4">
                <div className="p-4 bg-muted/50 rounded-lg">
                  <p className="text-sm text-muted-foreground">
                    Scheduled rides use the timeout and retry settings configured in the "Retry & Timeout Configuration" section below.
                  </p>
                </div>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>

        {/* Retry & Timeout Configuration */}
        <Card>
          <CardHeader>
            <CardTitle>Retry & Timeout Configuration</CardTitle>
            <CardDescription>Configure retry logic and timeout behaviors</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <Label>Accept Timeout (seconds)</Label>
                <Input
                  type="number"
                  min="5"
                  max="60"
                  value={settings.acceptTimeoutSeconds}
                  onChange={(e) => updateSetting('acceptTimeoutSeconds', parseInt(e.target.value) || 12)}
                  disabled={isLoading}
                />
                <p className="text-xs text-muted-foreground">
                  Time driver has to accept/reject before auto-expire
                </p>
              </div>
              <div className="space-y-2">
                <Label>Global Timeout (minutes)</Label>
                <Input
                  type="number"
                  min="1"
                  max="30"
                  value={settings.globalTimeoutMinutes}
                  onChange={(e) => updateSetting('globalTimeoutMinutes', parseInt(e.target.value) || 15)}
                  disabled={isLoading}
                />
                <p className="text-xs text-muted-foreground">
                  Maximum time to find any driver before giving up
                </p>
              </div>
              <div className="space-y-2">
                <Label>Max Offer Hops</Label>
                <Input
                  type="number"
                  min="1"
                  max="50"
                  value={settings.maxOfferHops}
                  onChange={(e) => updateSetting('maxOfferHops', parseInt(e.target.value) || 10)}
                  disabled={isLoading}
                />
                <p className="text-xs text-muted-foreground">
                  Maximum drivers to try before giving up
                </p>
              </div>
              <div className="space-y-2">
                <Label>Auto Retry Attempts</Label>
                <Input
                  type="number"
                  min="0"
                  max="10"
                  value={settings.autoRetryAttempts}
                  onChange={(e) => updateSetting('autoRetryAttempts', parseInt(e.target.value) || 3)}
                  disabled={isLoading}
                />
                <p className="text-xs text-muted-foreground">
                  Times to retry dispatch after all drivers reject
                </p>
              </div>
            </div>

            {/* Toggle options */}
            <div className="space-y-4">
              <div className="flex items-center justify-between p-4 border rounded-lg">
                <div>
                  <p className="font-medium">Auto Reassign Enabled</p>
                  <p className="text-sm text-muted-foreground">Automatically reassign rejected rides to next driver</p>
                </div>
                <Switch
                  checked={settings.autoReassignEnabled}
                  onCheckedChange={(checked) => updateSetting('autoReassignEnabled', checked)}
                  disabled={isLoading}
                />
              </div>
              <div className="flex items-center justify-between p-4 border rounded-lg">
                <div>
                  <p className="font-medium">Instant Retry Enabled</p>
                  <p className="text-sm text-muted-foreground">Retry immediately on rejection (no delay)</p>
                </div>
                <Switch
                  checked={settings.instantRetryEnabled}
                  onCheckedChange={(checked) => updateSetting('instantRetryEnabled', checked)}
                  disabled={isLoading}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* System Settings */}
        <Card>
          <CardHeader>
            <CardTitle>System Settings</CardTitle>
            <CardDescription>Advanced dispatch system configuration</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between p-4 border rounded-lg">
              <div>
                <p className="font-medium">Enable Logging</p>
                <p className="text-sm text-muted-foreground">Log all dispatch events for debugging</p>
              </div>
              <Switch
                checked={settings.enableLogging}
                onCheckedChange={(checked) => updateSetting('enableLogging', checked)}
                disabled={isLoading}
              />
            </div>
            <div className="flex items-center justify-between p-4 border rounded-lg">
              <div>
                <p className="font-medium">Simulate Mode</p>
                <p className="text-sm text-muted-foreground">Test dispatch without actual driver assignments</p>
              </div>
              <Switch
                checked={settings.simulateMode}
                onCheckedChange={(checked) => updateSetting('simulateMode', checked)}
                disabled={isLoading}
              />
            </div>
            <div className="flex items-center justify-between p-4 border rounded-lg">
              <div>
                <p className="font-medium">Block Multiple Active Rides</p>
                <p className="text-sm text-muted-foreground">Prevent drivers from having multiple active rides</p>
              </div>
              <Switch
                checked={settings.blockMultipleActiveRides}
                onCheckedChange={(checked) => updateSetting('blockMultipleActiveRides', checked)}
                disabled={isLoading}
              />
            </div>
            <div className="flex items-center justify-between p-4 border rounded-lg">
              <div>
                <p className="font-medium">Cancel Protection</p>
                <p className="text-sm text-muted-foreground">Protect against frequent cancellations</p>
              </div>
              <Switch
                checked={settings.cancelProtection}
                onCheckedChange={(checked) => updateSetting('cancelProtection', checked)}
                disabled={isLoading}
              />
            </div>
            <div className="p-4 border rounded-lg space-y-2">
              <Label>Driver Fare Display</Label>
              <Select 
                value={settings.driverFareDisplay} 
                onValueChange={(value: 'net_earnings' | 'full_breakdown') => updateSetting('driverFareDisplay', value)}
                disabled={isLoading}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="net_earnings">Net Earnings Only</SelectItem>
                  <SelectItem value="full_breakdown">Full Fare Breakdown</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                What fare information drivers see in ride offers
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </AdminLayout>
  );
}
