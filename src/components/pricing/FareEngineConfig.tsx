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
  Clock, Settings2, AlertCircle, CheckCircle2, TrendingUp, Car
} from 'lucide-react';
import { toast } from 'sonner';
import { getCurrencySymbol } from '@/lib/regionSettings';
import { FareSimulatorCard } from '@/components/pricing/FareSimulatorCard';

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
}

const DEFAULT_SETTINGS: Omit<FarePricingSettings, 'service_area_id'> = {
  pricing_mode: 'fixed',
  currency_code: 'GBP',
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
};

interface VehicleType {
  id: string;
  name: string;
  slug: string;
}

interface FareEngineConfigProps {
  serviceAreaId: string;
  regionCurrencyCode?: string;
}

export function FareEngineConfig({ serviceAreaId, regionCurrencyCode }: FareEngineConfigProps) {
  const [settings, setSettings] = useState<FarePricingSettings | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  // Vehicle type selector
  const [assignedVehicleTypes, setAssignedVehicleTypes] = useState<VehicleType[]>([]);
  const [selectedVehicleTypeId, setSelectedVehicleTypeId] = useState<string>('__default__');
  const [configuredVtIds, setConfiguredVtIds] = useState<Set<string>>(new Set());

  const currencyCode = regionCurrencyCode || settings?.currency_code || 'GBP';
  const symbol = getCurrencySymbol(currencyCode);

  // Fetch assigned vehicle types for this service area
  useEffect(() => {
    fetchAssignedVehicleTypes();
  }, [serviceAreaId]);

  // Fetch fare settings when vehicle type changes
  useEffect(() => {
    fetchSettings();
  }, [serviceAreaId, selectedVehicleTypeId]);

  const fetchAssignedVehicleTypes = async () => {
    const { data: assignments } = await supabase
      .from('service_area_vehicle_types')
      .select('vehicle_type_id')
      .eq('service_area_id', serviceAreaId)
      .eq('is_active', true);

    if (assignments && assignments.length > 0) {
      const vtIds = assignments.map((a: any) => a.vehicle_type_id);
      const { data: vtData } = await supabase
        .from('vehicle_types')
        .select('id, name, slug')
        .in('id', vtIds)
        .eq('is_active', true)
        .order('name');
      setAssignedVehicleTypes(vtData || []);
    } else {
      setAssignedVehicleTypes([]);
    }

    // Check which vehicle types already have fare configs
    const { data: configs } = await supabase
      .from('fare_pricing_settings')
      .select('vehicle_type_id')
      .eq('service_area_id', serviceAreaId);

    const ids = new Set<string>();
    (configs || []).forEach((c: any) => {
      if (c.vehicle_type_id) ids.add(c.vehicle_type_id);
      else ids.add('__default__');
    });
    setConfiguredVtIds(ids);
  };

  const fetchSettings = async () => {
    setIsLoading(true);
    const vehicleTypeId = selectedVehicleTypeId === '__default__' ? null : selectedVehicleTypeId;

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
      setSettings(data as unknown as FarePricingSettings);
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
      const vehicleTypeId = selectedVehicleTypeId === '__default__' ? null : selectedVehicleTypeId;
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
      setHasChanges(false);
      // Update configured set
      setConfiguredVtIds(prev => {
        const next = new Set(prev);
        next.add(selectedVehicleTypeId);
        return next;
      });

      const vtName = selectedVehicleTypeId === '__default__' 
        ? 'Default' 
        : assignedVehicleTypes.find(v => v.id === selectedVehicleTypeId)?.name || 'Vehicle';
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

  if (!settings) return null;

  return (
    <div className="space-y-6">
      {/* Vehicle Type Selector */}
      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="flex items-center gap-2">
            <Car className="h-5 w-5 text-primary" />
            Vehicle Type Pricing
          </CardTitle>
          <CardDescription>
            Configure fare settings per vehicle type. Each vehicle type can have its own pricing mode, rates, and fees.
            The "Default" config applies when no vehicle-type-specific config exists.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-4">
            <div className="flex-1 max-w-xs">
              <Label className="text-sm mb-1.5 block">Select Vehicle Type</Label>
              <Select value={selectedVehicleTypeId} onValueChange={setSelectedVehicleTypeId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__default__">
                    <span className="flex items-center gap-2">
                      Default (Area-wide)
                      {configuredVtIds.has('__default__') && (
                        <CheckCircle2 className="h-3 w-3 text-green-500" />
                      )}
                    </span>
                  </SelectItem>
                  {assignedVehicleTypes.map(vt => (
                    <SelectItem key={vt.id} value={vt.id}>
                      <span className="flex items-center gap-2">
                        {vt.name}
                        {configuredVtIds.has(vt.id) && (
                          <CheckCircle2 className="h-3 w-3 text-green-500" />
                        )}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2 mt-5">
              {configuredVtIds.has(selectedVehicleTypeId) ? (
                <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200">
                  <CheckCircle2 className="h-3 w-3 mr-1" />
                  Configured
                </Badge>
              ) : selectedVehicleTypeId === '__default__' ? (
                <Badge variant="outline" className="bg-muted text-muted-foreground border-border">
                  <AlertCircle className="h-3 w-3 mr-1" />
                  No area-wide default set
                </Badge>
              ) : (
                <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200">
                  <AlertCircle className="h-3 w-3 mr-1" />
                  Not configured — will use Default
                </Badge>
              )}
            </div>
          </div>
          {assignedVehicleTypes.length === 0 && (
            <p className="text-xs text-muted-foreground mt-3">
              No vehicle types assigned to this service area. Assign vehicle types in the Vehicle Types tab first.
            </p>
          )}
        </CardContent>
      </Card>

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
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                {penceField('base_fare_pence', 'Base Fare', 'Starting fare for every trip')}
                {penceField('per_km_rate_pence', 'Per Km Rate', 'Charge per kilometre')}
                {penceField('per_min_rate_pence', 'Per Minute Rate', 'Charge per minute')}
                {penceField('booking_fee_pence', 'Booking Fee', 'Platform booking fee')}
                {penceField('minimum_fare_pence', 'Minimum Fare', 'Floor fare amount')}
              </div>
            </CardContent>
          </Card>

          {/* Waiting & Stop Charges */}
          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-2">
                <Clock className="h-5 w-5 text-primary" />
                Waiting & Stop Charges
              </CardTitle>
              <CardDescription>Additional fare adjustments</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                <div className="space-y-1">
                  <Label className="text-sm">Free Waiting (minutes)</Label>
                  <Input
                    type="number"
                    min="0"
                    value={settings.free_waiting_minutes}
                    onChange={(e) => updateField('free_waiting_minutes', parseInt(e.target.value) || 0)}
                  />
                </div>
                {penceField('waiting_per_minute_pence', 'Waiting Per Minute', 'After free minutes expire')}
                {penceField('extra_stop_flat_fee_pence', 'Extra Stop Fee', 'Flat fee per added stop')}
              </div>

              <Separator />

              <div className="space-y-3">
                <p className="text-sm font-medium">Fare Adjustment Rules</p>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
                    <div>
                      <Label className="text-sm font-medium">Waiting Charge</Label>
                      <p className="text-xs text-muted-foreground">Apply after free minutes</p>
                    </div>
                    <Switch
                      checked={settings.recalculate_on_waiting}
                      onCheckedChange={(v) => updateField('recalculate_on_waiting', v)}
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
          <FareSimulatorCard settings={settings} currencySymbol={symbol} />

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
                  {selectedVehicleTypeId === '__default__' 
                    ? 'Default' 
                    : assignedVehicleTypes.find(v => v.id === selectedVehicleTypeId)?.name || 'Unknown'}
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
                <span className="text-muted-foreground">Per Km</span>
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
              <div className="flex justify-between">
                <span className="text-muted-foreground">Stop Fee</span>
                <span className="font-mono">{symbol}{(settings.extra_stop_flat_fee_pence / 100).toFixed(2)}</span>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
