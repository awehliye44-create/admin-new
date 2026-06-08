import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { 
  Save, Loader2, Calculator, Zap, Lock, 
  Settings2, AlertCircle, CheckCircle2, TrendingUp, Car
} from 'lucide-react';
import { toast } from 'sonner';
import { getCurrencySymbol } from '@/lib/regionSettings';
import { FareSimulatorCard } from '@/components/pricing/FareSimulatorCard';
import { TripLifecycleTimeline } from '@/components/pricing/TripLifecycleTimeline';
import { DistanceBandsEditor } from '@/components/pricing/DistanceBandsEditor';

export interface DistanceBand {
  from: number;
  to: number | null;
  rate_pence: number;
}

interface FarePricingSettings {
  id?: string;
  service_area_id: string;
  vehicle_type_id?: string | null;
  pricing_mode: 'fixed' | 'dynamic';
  currency_code: string;
  base_fare_pence: number;
  per_km_rate_pence: number;
  per_min_rate_pence: number;
  booking_fee_pence: number;
  minimum_fare_pence: number;
  free_waiting_minutes: number;
  waiting_per_minute_pence: number;
  extra_stop_flat_fee_pence: number;
  recalculate_on_waiting: boolean;
  recalculate_on_stop_added: boolean;
  recalculate_on_dropoff_changed: boolean;
  enable_surge: boolean;
  surge_multiplier_default: number;
  peak_hour_multiplier: number;
  zone_multiplier: number;
  traffic_multiplier: number;
  demand_supply_multiplier: number;
  distance_pricing_bands: DistanceBand[];
  // Cancellation
  cancellation_grace_period_minutes: number;
  cancellation_fee_pence: number;
  cancellation_apply_after_arrival_only: boolean;
  // Late Passenger Cancellation
  late_cancel_enabled: boolean;
  late_cancel_threshold_minutes: number;
  late_cancel_fee_pence: number;
  // No-Show
  no_show_wait_time_minutes: number;
  no_show_fee_pence: number;
  no_show_apply_after_arrival_only: boolean;
  // Arrival Cancellation
  arrival_cancellation_enabled: boolean;
  arrival_cancellation_fee_pence: number;
  arrival_cancellation_apply_after_free_waiting_expired: boolean;
  arrival_cancellation_after_arrival_only: boolean;
}

const DEFAULT_SETTINGS: Omit<FarePricingSettings, 'service_area_id'> = {
  pricing_mode: 'fixed',
  currency_code: '',
  base_fare_pence: 300,
  per_km_rate_pence: 150,
  per_min_rate_pence: 20,
  booking_fee_pence: 100,
  minimum_fare_pence: 500,
  free_waiting_minutes: 3,
  waiting_per_minute_pence: 30,
  extra_stop_flat_fee_pence: 200,
  recalculate_on_waiting: true,
  recalculate_on_stop_added: true,
  recalculate_on_dropoff_changed: true,
  enable_surge: false,
  surge_multiplier_default: 1.0,
  peak_hour_multiplier: 1.0,
  zone_multiplier: 1.0,
  traffic_multiplier: 1.0,
  demand_supply_multiplier: 1.0,
  distance_pricing_bands: [],
  cancellation_grace_period_minutes: 3,
  cancellation_fee_pence: 0,
  cancellation_apply_after_arrival_only: true,
  late_cancel_enabled: false,
  late_cancel_threshold_minutes: 30,
  late_cancel_fee_pence: 500,
  no_show_wait_time_minutes: 5,
  no_show_fee_pence: 500,
  no_show_apply_after_arrival_only: true,
  arrival_cancellation_enabled: true,
  arrival_cancellation_fee_pence: 400,
  arrival_cancellation_apply_after_free_waiting_expired: true,
  arrival_cancellation_after_arrival_only: true,
};

interface VehicleType {
  id: string;
  name: string;
  slug: string;
}

interface FareEngineConfigProps {
  serviceAreaId: string;
  /** Currency code from Region — the SINGLE SOURCE OF TRUTH for currency. Required. */
  regionCurrencyCode: string;
  /** Distance unit from Region — 'mile' or 'km'. SSOT for unit labels. */
  regionDistanceUnit?: string;
}

export function FareEngineConfig({ serviceAreaId, regionCurrencyCode, regionDistanceUnit }: FareEngineConfigProps) {
  const [settings, setSettings] = useState<FarePricingSettings | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  // Vehicle type selector
  const [assignedVehicleTypes, setAssignedVehicleTypes] = useState<VehicleType[]>([]);
  const [selectedVehicleTypeId, setSelectedVehicleTypeId] = useState<string>('');
  const [configuredVtIds, setConfiguredVtIds] = useState<Set<string>>(new Set());

  // Stop Waiting & Get Paid (from stop_waiting_settings)
  const [stopWaiting, setStopWaiting] = useState({
    stopRadiusEnabled: false,
    stopRadiusMeters: 100,
    stopWaitingChargeIntervalSeconds: 10,
    stopWaitingGracePeriodMinutes: 1,
    stopWaitingRatePencePerMinute: 30,
    stopWaitingMaxMinutes: null as number | null,
  });
  const [stopWaitingHasChanges, setStopWaitingHasChanges] = useState(false);

  // Region is the single source of truth for currency — never use settings.currency_code
  const currencyCode = regionCurrencyCode;
  const symbol = getCurrencySymbol(currencyCode);
  const isMiles = (regionDistanceUnit || 'mile').toLowerCase().startsWith('mi');
  const distanceUnitShort = isMiles ? 'Mile' : 'Km';
  const distanceUnitLong = isMiles ? 'mile' : 'kilometre';

  // Fetch assigned vehicle types for this service area
  useEffect(() => {
    fetchAssignedVehicleTypes();
    fetchStopWaitingSettings();
  }, [serviceAreaId]);

  // Fetch fare settings when vehicle type changes
  useEffect(() => {
    if (!selectedVehicleTypeId) {
      setSettings(null);
      setIsLoading(false);
      return;
    }
    fetchSettings();
  }, [serviceAreaId, selectedVehicleTypeId]);

  const fetchAssignedVehicleTypes = async () => {
    const { data: assignments } = await supabase
      .from('service_area_vehicle_pricing')
      .select('vehicle_type_id')
      .eq('service_area_id', serviceAreaId)
      .eq('is_enabled', true);

    let vtList: VehicleType[] = [];
    if (assignments && assignments.length > 0) {
      const vtIds = assignments.map((a: any) => a.vehicle_type_id);
      const { data: vtData } = await supabase
        .from('vehicle_types')
        .select('id, name, slug')
        .in('id', vtIds)
        .eq('is_active', true)
        .order('name');
      vtList = vtData || [];
    }
    setAssignedVehicleTypes(vtList);
    // Auto-select first vehicle type if none selected (or current selection no longer valid)
    setSelectedVehicleTypeId(prev => {
      if (prev && vtList.some(v => v.id === prev)) return prev;
      return vtList[0]?.id ?? '';
    });

    // Check which vehicle types already have fare configs
    const { data: configs } = await supabase
      .from('fare_pricing_settings')
      .select('vehicle_type_id')
      .eq('service_area_id', serviceAreaId);

    const ids = new Set<string>();
    (configs || []).forEach((c: any) => {
      if (c.vehicle_type_id) ids.add(c.vehicle_type_id);
    });
    setConfiguredVtIds(ids);
  };

  const fetchSettings = async () => {
    setIsLoading(true);
    const vehicleTypeId = selectedVehicleTypeId || null;

    let query = supabase
      .from('fare_pricing_settings')
      .select('*')
      .eq('service_area_id', serviceAreaId);

    if (vehicleTypeId) {
      query = query.eq('vehicle_type_id', vehicleTypeId);
    } else {
      query = query.is('vehicle_type_id', null);
    }

    const { data } = await query.maybeSingle();

    if (data) {
      setSettings({
        ...DEFAULT_SETTINGS,
        ...(data as unknown as FarePricingSettings),
        service_area_id: serviceAreaId,
        vehicle_type_id: vehicleTypeId,
        arrival_cancellation_enabled: (data as any).arrival_cancellation_enabled ?? true,
        arrival_cancellation_fee_pence: (data as any).arrival_cancellation_fee_pence ?? 400,
        arrival_cancellation_apply_after_free_waiting_expired:
          (data as any).arrival_cancellation_apply_after_free_waiting_expired ?? true,
        arrival_cancellation_after_arrival_only:
          (data as any).arrival_cancellation_after_arrival_only ?? true,
      });
    } else {
      setSettings({
        ...DEFAULT_SETTINGS,
        service_area_id: serviceAreaId,
        vehicle_type_id: vehicleTypeId,
        currency_code: currencyCode,
      });
    }
    setHasChanges(false);
    setIsLoading(false);
  };

  const fetchStopWaitingSettings = async () => {
    const { data } = await supabase
      .from('stop_waiting_settings')
      .select('stop_radius_enabled, stop_radius_meters, stop_waiting_charge_interval_seconds, stop_waiting_grace_period_seconds, stop_waiting_rate_pence_per_minute, stop_waiting_max_minutes')
      .eq('service_area_id', serviceAreaId)
      .maybeSingle();

    if (data) {
      setStopWaiting({
        stopRadiusEnabled: (data as any).stop_radius_enabled ?? false,
        stopRadiusMeters: (data as any).stop_radius_meters ?? 100,
        stopWaitingChargeIntervalSeconds: (data as any).stop_waiting_charge_interval_seconds ?? 10,
        stopWaitingGracePeriodMinutes:
          typeof (data as any).stop_waiting_grace_period_seconds === 'number'
            ? (data as any).stop_waiting_grace_period_seconds / 60
            : 1,
        stopWaitingRatePencePerMinute: (data as any).stop_waiting_rate_pence_per_minute ?? 30,
        stopWaitingMaxMinutes: (data as any).stop_waiting_max_minutes ?? null,
      });
    }
    setStopWaitingHasChanges(false);
  };


  const updateStopWaitingField = (key: string, value: number | boolean | null) => {
    setStopWaiting(prev => ({ ...prev, [key]: value }));
    setStopWaitingHasChanges(true);
    setHasChanges(true);
  };

  const updateField = <K extends keyof FarePricingSettings>(key: K, value: FarePricingSettings[K]) => {
    if (!settings) return;
    setSettings({ ...settings, [key]: value });
    setHasChanges(true);
  };

  const penceField = (key: keyof FarePricingSettings, label: string, helpText?: string) => {
    const val = (settings?.[key] as number) ?? 0;
    return (
      <div className="space-y-1">
        <Label className="text-sm">{label}</Label>
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">{symbol}</span>
          <Input
            type="number"
            step="0.01"
            min="0"
            value={(val / 100).toFixed(2)}
            onChange={(e) => updateField(key, Math.round(parseFloat(e.target.value || '0') * 100) as never)}
            className="pl-7"
          />
        </div>
        {helpText && <p className="text-xs text-muted-foreground">{helpText}</p>}
      </div>
    );
  };

  const handleSave = async () => {
    if (!settings) return;
    setIsSaving(true);
    try {
      const vehicleTypeId = selectedVehicleTypeId || null;
      const payload = {
        pricing_mode: settings.pricing_mode,
        currency_code: currencyCode,
        base_fare_pence: settings.base_fare_pence,
        per_km_rate_pence: settings.per_km_rate_pence,
        per_min_rate_pence: settings.per_min_rate_pence,
        booking_fee_pence: settings.booking_fee_pence,
        minimum_fare_pence: settings.minimum_fare_pence,
        free_waiting_minutes: settings.free_waiting_minutes,
        waiting_per_minute_pence: settings.waiting_per_minute_pence,
        extra_stop_flat_fee_pence: settings.extra_stop_flat_fee_pence,
        recalculate_on_waiting: settings.recalculate_on_waiting,
        recalculate_on_stop_added: settings.recalculate_on_stop_added,
        recalculate_on_dropoff_changed: settings.recalculate_on_dropoff_changed,
        enable_surge: settings.enable_surge,
        surge_multiplier_default: settings.surge_multiplier_default,
        peak_hour_multiplier: settings.peak_hour_multiplier,
        zone_multiplier: settings.zone_multiplier,
        traffic_multiplier: settings.traffic_multiplier,
        demand_supply_multiplier: settings.demand_supply_multiplier,
        distance_pricing_bands: (settings.distance_pricing_bands ?? []) as any,
        cancellation_grace_period_minutes: settings.cancellation_grace_period_minutes,
        cancellation_fee_pence: settings.cancellation_fee_pence,
        cancellation_apply_after_arrival_only: settings.cancellation_apply_after_arrival_only,
        late_cancel_enabled: settings.late_cancel_enabled,
        late_cancel_threshold_minutes: settings.late_cancel_threshold_minutes,
        late_cancel_fee_pence: settings.late_cancel_fee_pence,
        no_show_wait_time_minutes: settings.no_show_wait_time_minutes,
        no_show_fee_pence: settings.no_show_fee_pence,
        no_show_apply_after_arrival_only: settings.no_show_apply_after_arrival_only,
        arrival_cancellation_enabled: settings.arrival_cancellation_enabled,
        arrival_cancellation_fee_pence: settings.arrival_cancellation_fee_pence,
        arrival_cancellation_apply_after_free_waiting_expired: settings.arrival_cancellation_apply_after_free_waiting_expired,
        arrival_cancellation_after_arrival_only: settings.arrival_cancellation_after_arrival_only,
      };

      if (settings.id) {
        const { error } = await supabase
          .from('fare_pricing_settings')
          .update(payload)
          .eq('id', settings.id);
        if (error) throw error;
      } else {
        const { data, error } = await supabase
          .from('fare_pricing_settings')
          .insert({ 
            service_area_id: serviceAreaId, 
            vehicle_type_id: vehicleTypeId,
            ...payload 
          })
          .select()
          .single();
        if (error) throw error;
        if (data) setSettings(data as unknown as FarePricingSettings);
      }

      // Save stop waiting settings to stop_waiting_settings if changed
      if (stopWaitingHasChanges) {
        const stopPayload = {
          service_area_id: serviceAreaId,
          stop_radius_enabled: stopWaiting.stopRadiusEnabled,
          stop_radius_meters: stopWaiting.stopRadiusMeters,
          stop_waiting_charge_interval_seconds: stopWaiting.stopWaitingChargeIntervalSeconds,
          stop_waiting_grace_period_seconds: Math.round(stopWaiting.stopWaitingGracePeriodMinutes * 60),
          stop_waiting_rate_pence_per_minute: stopWaiting.stopWaitingRatePencePerMinute,
          stop_waiting_max_minutes: stopWaiting.stopWaitingMaxMinutes,
        };

        const { data: existing } = await supabase
          .from('stop_waiting_settings')
          .select('id')
          .eq('service_area_id', serviceAreaId)
          .maybeSingle();

        if (existing) {
          await supabase
            .from('stop_waiting_settings')
            .update(stopPayload)
            .eq('service_area_id', serviceAreaId);
        } else {
          await supabase
            .from('stop_waiting_settings')
            .insert(stopPayload);
        }

        // Keep dispatch_settings in sync — stop-workflow reads both tables every check.
        const dispatchRadiusPayload = {
          stop_radius_enabled: stopWaiting.stopRadiusEnabled,
          stop_radius_meters: stopWaiting.stopRadiusMeters,
          stop_waiting_charge_interval_seconds: stopWaiting.stopWaitingChargeIntervalSeconds,
          stop_waiting_grace_period_seconds: Math.round(stopWaiting.stopWaitingGracePeriodMinutes * 60),
          stop_waiting_rate_pence_per_minute: stopWaiting.stopWaitingRatePencePerMinute,
          stop_waiting_max_minutes: stopWaiting.stopWaitingMaxMinutes,
          updated_at: new Date().toISOString(),
        };
        const { data: dispatchExisting } = await supabase
          .from('dispatch_settings')
          .select('id')
          .eq('service_area_id', serviceAreaId)
          .maybeSingle();
        if (dispatchExisting?.id) {
          await supabase
            .from('dispatch_settings')
            .update(dispatchRadiusPayload)
            .eq('service_area_id', serviceAreaId);
        } else {
          await supabase
            .from('dispatch_settings')
            .insert({ service_area_id: serviceAreaId, ...dispatchRadiusPayload });
        }
        console.log('WAITING_RADIUS_CACHE_INVALIDATED', {
          service_area_id: serviceAreaId,
          stop_radius_meters: stopWaiting.stopRadiusMeters,
          source: 'admin_fare_engine_save',
        });

        setStopWaitingHasChanges(false);
      }


      setHasChanges(false);
      // Update configured set
      setConfiguredVtIds(prev => {
        const next = new Set(prev);
        next.add(selectedVehicleTypeId);
        return next;
      });

      const vtName = assignedVehicleTypes.find(v => v.id === selectedVehicleTypeId)?.name || 'Vehicle';
      toast.success(`Fare settings saved for ${vtName}`);
    } catch (err) {
      console.error('Error saving fare settings:', err);
      toast.error('Failed to save fare pricing settings');
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Vehicle Type Selector */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            <Car className="h-5 w-5 text-primary" />
            Vehicle Type Pricing
          </CardTitle>
          <CardDescription>
            Select a vehicle type to configure its fare settings.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
            {/* Vehicle type cards */}
            {assignedVehicleTypes.map(vt => {
              const isSelected = selectedVehicleTypeId === vt.id;
              const isConfigured = configuredVtIds.has(vt.id);
              return (
                <button
                  key={vt.id}
                  type="button"
                  onClick={() => setSelectedVehicleTypeId(vt.id)}
                  className={`relative flex flex-col items-center gap-2 rounded-xl border-2 p-4 transition-all text-center cursor-pointer
                    ${isSelected
                      ? 'border-primary bg-primary/5 shadow-sm ring-1 ring-primary/20'
                      : 'border-border hover:border-primary/40 hover:bg-accent/50'
                    }`}
                >
                  <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
                    isSelected ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground'
                  }`}>
                    <Car className="h-5 w-5" />
                  </div>
                  <span className="text-sm font-medium leading-tight">{vt.name}</span>
                  <span className="text-[10px] text-muted-foreground leading-tight">{vt.slug}</span>
                  {isConfigured ? (
                    <span className="absolute top-1.5 right-1.5">
                      <CheckCircle2 className="h-4 w-4 text-green-500" />
                    </span>
                  ) : (
                    <span className="absolute top-1.5 right-1.5">
                      <AlertCircle className="h-4 w-4 text-amber-400" />
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {assignedVehicleTypes.length === 0 && (
            <p className="text-xs text-muted-foreground mt-3">
              No vehicle types assigned to this service area. Assign vehicle types in the Vehicle Types tab first.
            </p>
          )}

          {/* Status legend */}
          {assignedVehicleTypes.length > 0 && (
            <div className="flex items-center gap-4 mt-4 pt-3 border-t text-xs text-muted-foreground">
              <span className="flex items-center gap-1"><CheckCircle2 className="h-3 w-3 text-green-500" /> Configured</span>
              <span className="flex items-center gap-1"><AlertCircle className="h-3 w-3 text-amber-400" /> Not set</span>
            </div>
          )}
        </CardContent>
      </Card>

      {settings && (<>
      {hasChanges && (
        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={isSaving}>
            {isSaving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Save className="h-4 w-4 mr-2" />}
            Save Fare Engine Settings
          </Button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left column: Settings */}
        <div className="lg:col-span-2 space-y-6">
          {/* Pricing Mode Toggle */}
          <Card>
            <CardHeader className="pb-4">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <Settings2 className="h-5 w-5 text-primary" />
                    Pricing Mode
                  </CardTitle>
                  <CardDescription>Choose the active pricing strategy</CardDescription>
                </div>
                <Badge 
                  variant="outline"
                  className={settings.pricing_mode === 'fixed' 
                    ? 'bg-blue-100 text-blue-700 border-blue-300' 
                    : 'bg-amber-100 text-amber-700 border-amber-300'}
                >
                  {settings.pricing_mode === 'fixed' ? (
                    <><Lock className="h-3 w-3 mr-1" /> Fixed Pricing</>
                  ) : (
                    <><TrendingUp className="h-3 w-3 mr-1" /> Dynamic Pricing</>
                  )}
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-4 p-4 bg-muted/50 rounded-lg">
                <div className={`flex-1 p-3 rounded-lg border-2 cursor-pointer transition-colors ${
                  settings.pricing_mode === 'fixed' 
                    ? 'border-primary bg-primary/5' 
                    : 'border-transparent hover:border-muted-foreground/20'
                }`}
                  onClick={() => updateField('pricing_mode', 'fixed')}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <Lock className="h-4 w-4" />
                    <span className="font-medium">Fixed</span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Fare locked at booking. No changes from route differences.
                  </p>
                </div>
                <div className={`flex-1 p-3 rounded-lg border-2 cursor-pointer transition-colors ${
                  settings.pricing_mode === 'dynamic' 
                    ? 'border-primary bg-primary/5' 
                    : 'border-transparent hover:border-muted-foreground/20'
                }`}
                  onClick={() => updateField('pricing_mode', 'dynamic')}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <Zap className="h-4 w-4" />
                    <span className="font-medium">Dynamic</span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Fare adjusts with surge, zone, and demand multipliers.
                  </p>
                </div>
              </div>
              {settings.pricing_mode === 'fixed' && (
                <div className="mt-3 flex items-start gap-2 p-3 border rounded-lg bg-blue-500/5 border-blue-500/20">
                  <AlertCircle className="h-4 w-4 text-blue-600 mt-0.5 shrink-0" />
                  <p className="text-xs text-blue-700">
                    <strong>Startup Mode:</strong> Fixed pricing is active. Fares are locked at booking and only change for waiting, added stops, or destination changes.
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Base Fare Configuration */}
          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-2">
                <Calculator className="h-5 w-5 text-primary" />
                Base Fare Configuration
              </CardTitle>
              <CardDescription>Core fare calculation parameters</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                {penceField('base_fare_pence', 'Base Fare', 'Starting fare for every trip')}
                {penceField('per_min_rate_pence', 'Per Minute Rate', 'Charge per minute')}
                {penceField('booking_fee_pence', 'Booking Fee', 'Platform booking fee')}
                {penceField('minimum_fare_pence', 'Minimum Fare', 'Floor fare amount')}
                {(!settings.distance_pricing_bands || settings.distance_pricing_bands.length === 0) &&
                  penceField('per_km_rate_pence', `Per ${distanceUnitShort} Rate`, `Flat rate — used when no bands configured`)}
              </div>

              <DistanceBandsEditor
                bands={settings.distance_pricing_bands ?? []}
                unitShort={distanceUnitShort}
                unitLong={distanceUnitLong}
                currencySymbol={symbol}
                currencyCode={currencyCode}
                onChange={(next) => updateField('distance_pricing_bands', next)}
              />
            </CardContent>
          </Card>

          {/* Trip Lifecycle Timeline */}
          <TripLifecycleTimeline
            graceMinutes={settings.cancellation_grace_period_minutes}
            freeWaitingMinutes={settings.free_waiting_minutes}
            waitingPerMinutePence={settings.waiting_per_minute_pence}
            cancellationFeePence={settings.cancellation_fee_pence}
            noShowWaitMinutes={settings.no_show_wait_time_minutes}
            noShowFeePence={settings.no_show_fee_pence}
            lateCancelEnabled={settings.late_cancel_enabled}
            lateCancelThresholdMinutes={settings.late_cancel_threshold_minutes}
            lateCancelFeePence={settings.late_cancel_fee_pence}
            cancellationApplyAfterArrivalOnly={settings.cancellation_apply_after_arrival_only}
            noShowApplyAfterArrivalOnly={settings.no_show_apply_after_arrival_only}
            arrivalCancellationEnabled={settings.arrival_cancellation_enabled}
            arrivalCancellationFeePence={settings.arrival_cancellation_fee_pence}
            arrivalCancellationApplyAfterFreeWaitingExpired={settings.arrival_cancellation_apply_after_free_waiting_expired}
            arrivalCancellationAfterArrivalOnly={settings.arrival_cancellation_after_arrival_only}
            recalculateOnWaiting={settings.recalculate_on_waiting}
            currencySymbol={symbol}
            onUpdate={(key, value) => updateField(key as keyof FarePricingSettings, value as never)}
            stopRadiusEnabled={stopWaiting.stopRadiusEnabled}
            stopRadiusMeters={stopWaiting.stopRadiusMeters}
            stopWaitingChargeIntervalSeconds={stopWaiting.stopWaitingChargeIntervalSeconds}
            stopWaitingGracePeriodMinutes={stopWaiting.stopWaitingGracePeriodMinutes}
            stopWaitingRatePencePerMinute={stopWaiting.stopWaitingRatePencePerMinute}
            stopWaitingMaxMinutes={stopWaiting.stopWaitingMaxMinutes}
            onStopWaitingUpdate={updateStopWaitingField}
          />



          {/* Fare Adjustment Rules */}
          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-2">
                <Settings2 className="h-5 w-5 text-primary" />
                Fare Adjustment Rules
              </CardTitle>
              <CardDescription>Controls for mid-trip fare recalculations</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
                  <div>
                    <Label className="text-sm font-medium">Destination Change</Label>
                    <p className="text-xs text-muted-foreground">Recalculate on dropoff change</p>
                  </div>
                  <Switch
                    checked={settings.recalculate_on_dropoff_changed}
                    onCheckedChange={(v) => updateField('recalculate_on_dropoff_changed', v)}
                  />
                </div>
                <div className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
                  <div>
                    <Label className="text-sm font-medium">Stop Added</Label>
                    <p className="text-xs text-muted-foreground">Charge for extra stops</p>
                  </div>
                  <Switch
                    checked={settings.recalculate_on_stop_added}
                    onCheckedChange={(v) => updateField('recalculate_on_stop_added', v)}
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Dynamic Pricing Settings */}
          <Card className={settings.pricing_mode === 'fixed' ? 'opacity-60' : ''}>
            <CardHeader className="pb-4">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <Zap className="h-5 w-5 text-amber-500" />
                    Dynamic Pricing
                  </CardTitle>
                  <CardDescription>
                    {settings.pricing_mode === 'fixed' 
                      ? 'Currently inactive — switch to Dynamic mode to enable' 
                      : 'Surge and multiplier configuration'}
                  </CardDescription>
                </div>
                {settings.pricing_mode === 'dynamic' && (
                  <div className="flex items-center gap-2">
                    <Label className="text-sm">Enable Surge</Label>
                    <Switch
                      checked={settings.enable_surge}
                      onCheckedChange={(v) => updateField('enable_surge', v)}
                    />
                  </div>
                )}
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                {[
                  { key: 'surge_multiplier_default' as const, label: 'Surge Multiplier' },
                  { key: 'peak_hour_multiplier' as const, label: 'Peak Hour Multiplier' },
                  { key: 'zone_multiplier' as const, label: 'Zone Multiplier' },
                  { key: 'traffic_multiplier' as const, label: 'Traffic Multiplier' },
                  { key: 'demand_supply_multiplier' as const, label: 'Demand/Supply Multiplier' },
                ].map(({ key, label }) => (
                  <div key={key} className="space-y-1">
                    <Label className="text-sm">{label}</Label>
                    <Input
                      type="number"
                      step="0.01"
                      min="0.1"
                      max="10"
                      value={settings[key]}
                      onChange={(e) => updateField(key, parseFloat(e.target.value) || 1)}
                      disabled={settings.pricing_mode === 'fixed'}
                    />
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

        </div>

        {/* Right column: Simulator */}
        <div className="space-y-6">
          <FareSimulatorCard settings={settings} currencySymbol={symbol} distanceUnit={regionDistanceUnit} />

          {/* Settings Summary */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-green-500" />
                Active Configuration
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Vehicle Type</span>
                <Badge variant="outline">
                  {assignedVehicleTypes.find(v => v.id === selectedVehicleTypeId)?.name || '—'}
                </Badge>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Mode</span>
                <Badge variant="outline">{settings.pricing_mode}</Badge>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Base Fare</span>
                <span className="font-mono">{symbol}{(settings.base_fare_pence / 100).toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Per {distanceUnitShort}</span>
                <span className="font-mono">{symbol}{(settings.per_km_rate_pence / 100).toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Per Min</span>
                <span className="font-mono">{symbol}{(settings.per_min_rate_pence / 100).toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Min Fare</span>
                <span className="font-mono">{symbol}{(settings.minimum_fare_pence / 100).toFixed(2)}</span>
              </div>
              <Separator />
              <div className="flex justify-between">
                <span className="text-muted-foreground">Free Waiting</span>
                <span>{settings.free_waiting_minutes} min</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Waiting/Min</span>
                <span className="font-mono">{symbol}{(settings.waiting_per_minute_pence / 100).toFixed(2)}</span>
              </div>
              <Separator />
              <div className="flex justify-between">
                <span className="text-muted-foreground">Cancel Grace</span>
                <span>{settings.cancellation_grace_period_minutes} min</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Cancel Fee</span>
                <span className="font-mono">{symbol}{(settings.cancellation_fee_pence / 100).toFixed(2)}</span>
              </div>
              {settings.late_cancel_enabled && (
                <>
                  <Separator />
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Late Cancel</span>
                    <Badge variant="outline" className="text-[10px]">Enabled</Badge>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Threshold</span>
                    <span>{settings.late_cancel_threshold_minutes} min</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Late Fee</span>
                    <span className="font-mono">{symbol}{(settings.late_cancel_fee_pence / 100).toFixed(2)}</span>
                  </div>
                </>
              )}
              <Separator />
              <div className="flex justify-between">
                <span className="text-muted-foreground">No-Show Wait</span>
                <span>{settings.no_show_wait_time_minutes} min</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">No-Show Fee</span>
                <span className="font-mono">{symbol}{(settings.no_show_fee_pence / 100).toFixed(2)}</span>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
      </>)}
    </div>
  );
}
