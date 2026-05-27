import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { AdminLayout } from "@/components/layout/AdminLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { Calculator, MapPin, Navigation, Clock, Percent, DollarSign, ArrowRight, RotateCcw, Info, TrendingUp, Building2, Zap, Car } from "lucide-react";
import { getCurrencySymbol, getDistanceUnitShort } from "@/lib/regionSettings";

interface VehicleType {
  id: string;
  name: string;
  slug: string;
}

interface ServiceArea {
  id: string;
  name: string;
  region_id: string;
}

interface Region {
  id: string;
  name: string;
  currency_code: string;
  distance_unit: string;
}

interface FarePricingSettings {
  id: string;
  service_area_id: string;
  pricing_mode: string;
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
  distance_pricing_bands?: Array<{ from: number; to: number | null; rate_pence: number }> | null;
}

interface CustomZone {
  id: string;
  name: string;
  zone_type: string;
  color: string | null;
}

interface ZonePricingRule {
  id: string;
  zone_id: string;
  vehicle_type_id: string | null;
  rule_type: string;
  value: number;
  applies_to: string;
  is_active: boolean;
}

interface FareBreakdown {
  baseFare: number;
  distanceFare: number;
  timeFare: number;
  bookingFee: number;
  zoneSurcharge: number;
  zoneDiscount: number;
  corporateDiscount: number;
  promoDiscount: number;
  waitingCharge: number;
  stopCharge: number;
  subtotal: number;
  minimumFare: number;
  finalFare: number;
  pricingMode: string;
  surgeMultiplier: number;
  appliedRules: string[];
  currencyCode: string;
  distanceUnit: string;
}

export default function FareSimulator() {
  const { toast } = useToast();
  const [isCalculating, setIsCalculating] = useState(false);
  const [fareBreakdown, setFareBreakdown] = useState<FareBreakdown | null>(null);

  const [formData, setFormData] = useState({
    service_area_id: "",
    vehicle_type_id: "",
    distance_km: 5,
    duration_minutes: 15,
    waiting_minutes: 0,
    extra_stops: 0,
    pickup_zone_id: "",
    dropoff_zone_id: "",
    is_corporate: false,
    corporate_discount: 0,
    promo_code: "",
    promo_discount: 0,
    surge_override: null as number | null,
  });

  const { data: serviceAreas = [] } = useQuery({
    queryKey: ['service-areas'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('service_areas')
        .select('id, name, region_id')
        .eq('is_active', true)
        .order('name');
      if (error) throw error;
      return data as ServiceArea[];
    },
  });

  const { data: regions = [] } = useQuery({
    queryKey: ['regions'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('regions')
        .select('id, name, currency_code, distance_unit')
        .eq('status', 'active');
      if (error) throw error;
      return data as Region[];
    },
  });

  const currentRegionSettings = useMemo(() => {
    const selectedArea = serviceAreas.find(sa => sa.id === formData.service_area_id);
    const region = regions.find(r => r.id === selectedArea?.region_id);
    if (region && !region.currency_code) {
      console.warn(`[FareSimulator] Region "${region.name}" is missing currency_code.`);
    }
    return {
      currencyCode: region?.currency_code || '',
      distanceUnit: region?.distance_unit || 'mile',
      regionName: region?.name || null,
    };
  }, [formData.service_area_id, serviceAreas, regions]);

  // Fetch assigned vehicle types for selected service area
  const { data: assignedVehicleTypes = [] } = useQuery({
    queryKey: ['assigned-vt', formData.service_area_id],
    queryFn: async () => {
      if (!formData.service_area_id) return [];
      const { data: assignments } = await supabase
        .from('service_area_vehicle_pricing')
        .select('vehicle_type_id')
        .eq('service_area_id', formData.service_area_id)
        .eq('is_enabled', true);
      if (!assignments || assignments.length === 0) return [];
      const vtIds = assignments.map((a: any) => a.vehicle_type_id);
      const { data: vtData } = await supabase
        .from('vehicle_types')
        .select('id, name, slug')
        .in('id', vtIds)
        .eq('is_active', true)
        .order('name');
      return (vtData || []) as VehicleType[];
    },
    enabled: !!formData.service_area_id,
  });

  const { data: fareSettings } = useQuery({
    queryKey: ['fare-pricing-settings', formData.service_area_id, formData.vehicle_type_id],
    queryFn: async () => {
      if (!formData.service_area_id) return null;

      // Try vehicle-type-specific config first
      if (formData.vehicle_type_id) {
        const { data } = await supabase
          .from('fare_pricing_settings')
          .select('*')
          .eq('service_area_id', formData.service_area_id)
          .eq('vehicle_type_id', formData.vehicle_type_id)
          .maybeSingle();
        if (data) return data as unknown as FarePricingSettings;
      }

      // Fall back to default (vehicle_type_id IS NULL)
      const { data } = await supabase
        .from('fare_pricing_settings')
        .select('*')
        .eq('service_area_id', formData.service_area_id)
        .is('vehicle_type_id', null)
        .maybeSingle();
      return data as unknown as FarePricingSettings | null;
    },
    enabled: !!formData.service_area_id,
  });

  const { data: customZones = [] } = useQuery({
    queryKey: ['custom-zones'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('custom_zones')
        .select('id, name, zone_type, color')
        .eq('is_active', true)
        .order('name');
      if (error) throw error;
      return data as CustomZone[];
    },
  });

  const { data: zonePricingRules = [] } = useQuery({
    queryKey: ['zone-pricing-rules'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('zone_pricing_rules')
        .select('*')
        .eq('is_active', true);
      if (error) throw error;
      return data as ZonePricingRule[];
    },
  });

  const currencySymbol = getCurrencySymbol(currentRegionSettings.currencyCode);
  const fmt = (pence: number) => `${currencySymbol}${(pence / 100).toFixed(2)}`;

  const calculateFare = () => {
    if (!formData.service_area_id) {
      toast({ title: "Please select a service area", variant: "destructive" });
      return;
    }

    if (!fareSettings) {
      toast({ title: "No Fare Engine settings found for this service area. Configure the Fare Engine first.", variant: "destructive" });
      return;
    }

    setIsCalculating(true);

    setTimeout(() => {
      const s = fareSettings;
      const appliedRules: string[] = [];

      // Base fare calculation (mirrors fareEngine.ts logic)
      const base = s.base_fare_pence;
      const bands = s.distance_pricing_bands ?? [];
      let distCharge: number;
      if (bands.length > 0) {
        const sorted = [...bands].sort((a, b) => (a.from ?? 0) - (b.from ?? 0));
        let charge = 0;
        for (const b of sorted) {
          const upper = b.to == null ? Infinity : b.to;
          const span = Math.max(0, Math.min(formData.distance_km, upper) - (b.from ?? 0));
          if (span > 0) charge += span * (b.rate_pence ?? 0);
        }
        distCharge = Math.round(charge);
      } else {
        distCharge = Math.round(formData.distance_km * s.per_km_rate_pence);
      }
      const timeCharge = Math.round(formData.duration_minutes * s.per_min_rate_pence);
      const booking = s.booking_fee_pence;

      appliedRules.push(`Base fare: ${fmt(base)}`);
      if (bands.length > 0) {
        appliedRules.push(`Distance (tiered ${bands.length} bands): ${formData.distance_km} → ${fmt(distCharge)}`);
      } else {
        appliedRules.push(`Distance: ${formData.distance_km} × ${fmt(s.per_km_rate_pence)} = ${fmt(distCharge)}`);
      }
      appliedRules.push(`Time: ${formData.duration_minutes}min × ${fmt(s.per_min_rate_pence)}/min = ${fmt(timeCharge)}`);
      appliedRules.push(`Booking fee: ${fmt(booking)}`);

      let subtotal: number;
      let surgeMultiplier = 1;

      if (s.pricing_mode === 'dynamic') {
        surgeMultiplier = s.enable_surge ? (formData.surge_override ?? s.surge_multiplier_default) : 1;
        const zoneMultiplier = s.zone_multiplier;
        const trafficMultiplier = s.traffic_multiplier;
        const rawSubtotal = base + distCharge + timeCharge;
        const multiplied = Math.round(rawSubtotal * surgeMultiplier * zoneMultiplier * trafficMultiplier);
        subtotal = multiplied + booking;

        if (surgeMultiplier > 1) appliedRules.push(`Surge multiplier: ${surgeMultiplier}x`);
        if (zoneMultiplier !== 1) appliedRules.push(`Zone multiplier: ${zoneMultiplier}x`);
        if (trafficMultiplier !== 1) appliedRules.push(`Traffic multiplier: ${trafficMultiplier}x`);
        appliedRules.push(`Pricing mode: Dynamic`);
      } else {
        subtotal = base + distCharge + timeCharge + booking;
        appliedRules.push(`Pricing mode: Fixed`);
      }

      const minimumApplied = subtotal < s.minimum_fare_pence;
      let quotedFare = Math.max(subtotal, s.minimum_fare_pence);
      if (minimumApplied) {
        appliedRules.push(`Minimum fare applied: ${fmt(s.minimum_fare_pence)}`);
      }

      // Zone adjustments (on top of Fare Engine)
      let zoneSurcharge = 0;
      let zoneDiscount = 0;

      if (formData.pickup_zone_id) {
        const pickupZone = customZones.find(z => z.id === formData.pickup_zone_id);
        const pickupRules = zonePricingRules.filter(
          r => r.zone_id === formData.pickup_zone_id && 
          (r.applies_to === 'both' || r.applies_to === 'pickup')
        );
        pickupRules.forEach(rule => {
          if (rule.rule_type === 'multiplier' && rule.value > 1) {
            const surcharge = Math.round(quotedFare * (rule.value - 1));
            zoneSurcharge += surcharge;
            appliedRules.push(`Pickup zone "${pickupZone?.name}": ${rule.value}x multiplier (+${fmt(surcharge)})`);
          } else if (rule.rule_type === 'flat_rate') {
            const flatPence = Math.round(rule.value * 100);
            zoneSurcharge += flatPence;
            appliedRules.push(`Pickup zone "${pickupZone?.name}": +${fmt(flatPence)} flat rate`);
          } else if (rule.rule_type === 'percentage_discount') {
            const discount = Math.round(quotedFare * (rule.value / 100));
            zoneDiscount += discount;
            appliedRules.push(`Pickup zone "${pickupZone?.name}": ${rule.value}% discount (-${fmt(discount)})`);
          }
        });
      }

      if (formData.dropoff_zone_id) {
        const dropoffZone = customZones.find(z => z.id === formData.dropoff_zone_id);
        const dropoffRules = zonePricingRules.filter(
          r => r.zone_id === formData.dropoff_zone_id && 
          (r.applies_to === 'both' || r.applies_to === 'dropoff')
        );
        dropoffRules.forEach(rule => {
          if (rule.rule_type === 'multiplier' && rule.value > 1) {
            const surcharge = Math.round(quotedFare * (rule.value - 1));
            zoneSurcharge += surcharge;
            appliedRules.push(`Dropoff zone "${dropoffZone?.name}": ${rule.value}x multiplier (+${fmt(surcharge)})`);
          } else if (rule.rule_type === 'flat_rate') {
            const flatPence = Math.round(rule.value * 100);
            zoneSurcharge += flatPence;
            appliedRules.push(`Dropoff zone "${dropoffZone?.name}": +${fmt(flatPence)} flat rate`);
          } else if (rule.rule_type === 'percentage_discount') {
            const discount = Math.round(quotedFare * (rule.value / 100));
            zoneDiscount += discount;
            appliedRules.push(`Dropoff zone "${dropoffZone?.name}": ${rule.value}% discount (-${fmt(discount)})`);
          }
        });
      }

      // Waiting charge
      let waitingCharge = 0;
      if (s.recalculate_on_waiting && formData.waiting_minutes > 0) {
        const billable = Math.max(0, formData.waiting_minutes - s.free_waiting_minutes);
        waitingCharge = Math.round(billable * s.waiting_per_minute_pence);
        if (billable > 0) {
          appliedRules.push(`Waiting: ${formData.waiting_minutes}min (free: ${s.free_waiting_minutes}min, billable: ${billable}min) = ${fmt(waitingCharge)}`);
        }
      }

      // Stop charges
      let stopCharge = 0;
      if (s.recalculate_on_stop_added && formData.extra_stops > 0) {
        stopCharge = formData.extra_stops * s.extra_stop_flat_fee_pence;
        appliedRules.push(`Extra stops: ${formData.extra_stops} × ${fmt(s.extra_stop_flat_fee_pence)} = ${fmt(stopCharge)}`);
      }

      let fareAfterZones = quotedFare + zoneSurcharge - zoneDiscount;

      // Corporate discount
      let corporateDiscount = 0;
      if (formData.is_corporate && formData.corporate_discount > 0) {
        corporateDiscount = Math.round(fareAfterZones * (formData.corporate_discount / 100));
        appliedRules.push(`Corporate discount: ${formData.corporate_discount}% (-${fmt(corporateDiscount)})`);
      }

      // Promo discount
      let promoDiscount = 0;
      if (formData.promo_code && formData.promo_discount > 0) {
        promoDiscount = Math.round((fareAfterZones - corporateDiscount) * (formData.promo_discount / 100));
        appliedRules.push(`Promo "${formData.promo_code}": ${formData.promo_discount}% (-${fmt(promoDiscount)})`);
      }

      const finalFare = Math.max(0, fareAfterZones - corporateDiscount - promoDiscount + waitingCharge + stopCharge);

      setFareBreakdown({
        baseFare: base,
        distanceFare: distCharge,
        timeFare: timeCharge,
        bookingFee: booking,
        zoneSurcharge,
        zoneDiscount,
        corporateDiscount,
        promoDiscount,
        waitingCharge,
        stopCharge,
        subtotal,
        minimumFare: s.minimum_fare_pence,
        finalFare,
        pricingMode: s.pricing_mode,
        surgeMultiplier,
        appliedRules,
        currencyCode: currentRegionSettings.currencyCode,
        distanceUnit: currentRegionSettings.distanceUnit,
      });

      setIsCalculating(false);
    }, 300);
  };

  const resetSimulator = () => {
    setFormData({
      service_area_id: "",
      vehicle_type_id: "",
      distance_km: 5,
      duration_minutes: 15,
      waiting_minutes: 0,
      extra_stops: 0,
      pickup_zone_id: "",
      dropoff_zone_id: "",
      is_corporate: false,
      corporate_discount: 0,
      promo_code: "",
      promo_discount: 0,
      surge_override: null,
    });
    setFareBreakdown(null);
  };

  return (
    <AdminLayout title="Fare Simulator">
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Fare Simulator</h1>
            <p className="text-muted-foreground">
              Test fare calculations powered by the <strong>Fare Engine</strong> — the single source of truth for all pricing.
            </p>
          </div>
          <Button variant="outline" onClick={resetSimulator}>
            <RotateCcw className="mr-2 h-4 w-4" />
            Reset
          </Button>
        </div>

        {/* Fare Engine info banner */}
        <div className="flex items-start gap-3 rounded-lg border border-primary/30 bg-primary/5 p-4">
          <Calculator className="h-5 w-5 text-primary mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold text-sm">Powered by Fare Engine</p>
           <p className="text-sm text-muted-foreground">
              This simulator uses <code className="text-xs bg-muted px-1 rounded">fare_pricing_settings</code> configured per service area.
              Vehicle Types no longer control pricing. Select a service area to begin.
              {currentRegionSettings.regionName && (
                <span className="block mt-1">
                  <strong>Currency ({currentRegionSettings.currencyCode}) and distance unit ({currentRegionSettings.distanceUnit}) are set by Region "{currentRegionSettings.regionName}".</strong>
                </span>
              )}
            </p>
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          {/* Input Form */}
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Navigation className="h-5 w-5" />
                  Trip Details
                </CardTitle>
                <CardDescription>Configure the trip parameters</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-2">
                  <Label>Service Area *</Label>
                  <Select
                    value={formData.service_area_id}
                    onValueChange={(value) => setFormData({ ...formData, service_area_id: value, vehicle_type_id: "" })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select area" />
                    </SelectTrigger>
                    <SelectContent>
                      {serviceAreas.map((area) => (
                        <SelectItem key={area.id} value={area.id}>{area.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {formData.service_area_id && assignedVehicleTypes.length > 0 && (
                  <div className="grid gap-2">
                    <Label className="flex items-center gap-2">
                      <Car className="h-4 w-4" />
                      Vehicle Type
                    </Label>
                    <Select
                      value={formData.vehicle_type_id || "any"}
                      onValueChange={(value) => setFormData({ ...formData, vehicle_type_id: value === "any" ? "" : value })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Any (default pricing)" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="any">Any (default pricing)</SelectItem>
                        {assignedVehicleTypes.map((vt) => (
                          <SelectItem key={vt.id} value={vt.id}>{vt.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {fareSettings && (
                  <div className="flex items-center gap-2">
                    <Badge variant={fareSettings.pricing_mode === 'fixed' ? 'secondary' : 'default'}>
                      <Zap className="h-3 w-3 mr-1" />
                      {fareSettings.pricing_mode === 'fixed' ? 'Fixed Pricing' : 'Dynamic Pricing'}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      Base: {fmt(fareSettings.base_fare_pence)} · Per km: {fmt(fareSettings.per_km_rate_pence)} · Per min: {fmt(fareSettings.per_min_rate_pence)}
                    </span>
                  </div>
                )}

                {formData.service_area_id && !fareSettings && (
                  <div className="flex items-center gap-2 text-sm text-destructive">
                    <Info className="h-4 w-4" />
                    No Fare Engine settings found. Configure the Fare Engine for this service area first.
                  </div>
                )}

                <Separator />

                <div className="grid grid-cols-2 gap-4">
                  <div className="grid gap-2">
                    <Label className="flex items-center gap-2">
                      <Navigation className="h-4 w-4" />
                      Distance (km)
                    </Label>
                    <Input
                      type="number"
                      step="0.1"
                      value={formData.distance_km}
                      onChange={(e) => setFormData({ ...formData, distance_km: parseFloat(e.target.value) || 0 })}
                      min={0}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label className="flex items-center gap-2">
                      <Clock className="h-4 w-4" />
                      Duration (min)
                    </Label>
                    <Input
                      type="number"
                      value={formData.duration_minutes}
                      onChange={(e) => setFormData({ ...formData, duration_minutes: parseInt(e.target.value) || 0 })}
                      min={0}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="grid gap-2">
                    <Label>Waiting Time (min)</Label>
                    <Input
                      type="number"
                      value={formData.waiting_minutes}
                      onChange={(e) => setFormData({ ...formData, waiting_minutes: parseInt(e.target.value) || 0 })}
                      min={0}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label>Extra Stops</Label>
                    <Input
                      type="number"
                      value={formData.extra_stops}
                      onChange={(e) => setFormData({ ...formData, extra_stops: parseInt(e.target.value) || 0 })}
                      min={0}
                    />
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <MapPin className="h-5 w-5" />
                  Zone Selection
                </CardTitle>
                <CardDescription>Apply zone-based pricing rules</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="grid gap-2">
                    <Label>Pickup Zone</Label>
                    <Select
                      value={formData.pickup_zone_id || "none"}
                      onValueChange={(value) => setFormData({ ...formData, pickup_zone_id: value === "none" ? "" : value })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="No zone" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">No special zone</SelectItem>
                        {customZones.map((zone) => (
                          <SelectItem key={zone.id} value={zone.id}>
                            <div className="flex items-center gap-2">
                              <div
                                className="h-3 w-3 rounded-full"
                                style={{ backgroundColor: zone.color || '#3B82F6' }}
                              />
                              {zone.name}
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-2">
                    <Label>Dropoff Zone</Label>
                    <Select
                      value={formData.dropoff_zone_id || "none"}
                      onValueChange={(value) => setFormData({ ...formData, dropoff_zone_id: value === "none" ? "" : value })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="No zone" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">No special zone</SelectItem>
                        {customZones.map((zone) => (
                          <SelectItem key={zone.id} value={zone.id}>
                            <div className="flex items-center gap-2">
                              <div
                                className="h-3 w-3 rounded-full"
                                style={{ backgroundColor: zone.color || '#3B82F6' }}
                              />
                              {zone.name}
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {fareSettings?.pricing_mode === 'dynamic' && fareSettings.enable_surge && (
                  <div className="grid gap-2">
                    <Label className="flex items-center gap-2">
                      <TrendingUp className="h-4 w-4" />
                      Surge Override
                    </Label>
                    <div className="flex items-center gap-4">
                      <Input
                        type="number"
                        step="0.1"
                        value={formData.surge_override ?? fareSettings.surge_multiplier_default}
                        onChange={(e) => setFormData({ ...formData, surge_override: parseFloat(e.target.value) || 1 })}
                        min={1}
                        max={5}
                        className="max-w-[120px]"
                      />
                      <div className="flex gap-2">
                        {[1, 1.5, 2, 2.5].map((mult) => (
                          <Button
                            key={mult}
                            type="button"
                            variant={(formData.surge_override ?? fareSettings.surge_multiplier_default) === mult ? "default" : "outline"}
                            size="sm"
                            onClick={() => setFormData({ ...formData, surge_override: mult })}
                          >
                            {mult}x
                          </Button>
                        ))}
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Default from Fare Engine: {fareSettings.surge_multiplier_default}x
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Percent className="h-5 w-5" />
                  Discounts
                </CardTitle>
                <CardDescription>Apply corporate or promotional discounts</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between rounded-lg border p-3">
                  <div className="flex items-center gap-2">
                    <Building2 className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <Label>Corporate Booking</Label>
                      <p className="text-xs text-muted-foreground">Apply corporate rates</p>
                    </div>
                  </div>
                  <Switch
                    checked={formData.is_corporate}
                    onCheckedChange={(checked) => setFormData({ ...formData, is_corporate: checked })}
                  />
                </div>

                {formData.is_corporate && (
                  <div className="grid gap-2">
                    <Label>Corporate Discount (%)</Label>
                    <Input
                      type="number"
                      value={formData.corporate_discount}
                      onChange={(e) => setFormData({ ...formData, corporate_discount: parseFloat(e.target.value) || 0 })}
                      min={0}
                      max={100}
                    />
                  </div>
                )}

                <Separator />

                <div className="grid grid-cols-2 gap-4">
                  <div className="grid gap-2">
                    <Label>Promo Code</Label>
                    <Input
                      value={formData.promo_code}
                      onChange={(e) => setFormData({ ...formData, promo_code: e.target.value.toUpperCase() })}
                      placeholder="SAVE20"
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label>Promo Discount (%)</Label>
                    <Input
                      type="number"
                      value={formData.promo_discount}
                      onChange={(e) => setFormData({ ...formData, promo_discount: parseFloat(e.target.value) || 0 })}
                      min={0}
                      max={100}
                      disabled={!formData.promo_code}
                    />
                  </div>
                </div>
              </CardContent>
            </Card>

            <Button onClick={calculateFare} className="w-full" size="lg" disabled={isCalculating}>
              <Calculator className="mr-2 h-5 w-5" />
              {isCalculating ? "Calculating..." : "Calculate Fare"}
            </Button>
          </div>

          {/* Results */}
          <div className="space-y-6">
            <Card className={fareBreakdown ? "border-primary" : ""}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <DollarSign className="h-5 w-5" />
                  Fare Breakdown
                </CardTitle>
                <CardDescription>
                  {fareBreakdown ? `Calculated using Fare Engine (${fareBreakdown.pricingMode} mode)` : "Configure trip details and click Calculate"}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {!fareBreakdown ? (
                  <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
                    <Calculator className="h-12 w-12 mb-4 opacity-50" />
                    <p>No calculation yet</p>
                    <p className="text-sm">Select a service area and click Calculate Fare</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {/* Summary */}
                    <div className="rounded-lg bg-primary/10 p-6 text-center">
                      <p className="text-sm text-muted-foreground mb-1">Estimated Fare</p>
                      <p className="text-4xl font-bold text-primary">
                        {fmt(fareBreakdown.finalFare)}
                      </p>
                      <Badge variant="outline" className="mt-2">
                        {fareBreakdown.pricingMode === 'fixed' ? '🔒 Fixed' : '⚡ Dynamic'}
                        {fareBreakdown.surgeMultiplier > 1 && ` · ${fareBreakdown.surgeMultiplier}x surge`}
                      </Badge>
                    </div>

                    <Separator />

                    {/* Breakdown */}
                    <div className="space-y-3">
                      <div className="flex justify-between text-sm">
                        <span>Base Fare</span>
                        <span>{fmt(fareBreakdown.baseFare)}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span>Distance ({formData.distance_km}km)</span>
                        <span>{fmt(fareBreakdown.distanceFare)}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span>Time ({formData.duration_minutes}min)</span>
                        <span>{fmt(fareBreakdown.timeFare)}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span>Booking Fee</span>
                        <span>{fmt(fareBreakdown.bookingFee)}</span>
                      </div>
                      
                      {fareBreakdown.zoneSurcharge > 0 && (
                        <div className="flex justify-between text-sm text-orange-500">
                          <span>Zone Surcharges</span>
                          <span>+{fmt(fareBreakdown.zoneSurcharge)}</span>
                        </div>
                      )}
                      
                      {fareBreakdown.zoneDiscount > 0 && (
                        <div className="flex justify-between text-sm text-green-500">
                          <span>Zone Discounts</span>
                          <span>-{fmt(fareBreakdown.zoneDiscount)}</span>
                        </div>
                      )}

                      {fareBreakdown.waitingCharge > 0 && (
                        <div className="flex justify-between text-sm text-orange-500">
                          <span>Waiting Charge</span>
                          <span>+{fmt(fareBreakdown.waitingCharge)}</span>
                        </div>
                      )}

                      {fareBreakdown.stopCharge > 0 && (
                        <div className="flex justify-between text-sm text-orange-500">
                          <span>Extra Stop Charges</span>
                          <span>+{fmt(fareBreakdown.stopCharge)}</span>
                        </div>
                      )}

                      <Separator />

                      <div className="flex justify-between font-medium">
                        <span>Subtotal</span>
                        <span>{fmt(fareBreakdown.subtotal)}</span>
                      </div>

                      {fareBreakdown.corporateDiscount > 0 && (
                        <div className="flex justify-between text-sm text-green-500">
                          <span>Corporate Discount</span>
                          <span>-{fmt(fareBreakdown.corporateDiscount)}</span>
                        </div>
                      )}

                      {fareBreakdown.promoDiscount > 0 && (
                        <div className="flex justify-between text-sm text-green-500">
                          <span>Promo Discount</span>
                          <span>-{fmt(fareBreakdown.promoDiscount)}</span>
                        </div>
                      )}

                      <Separator />

                      <div className="flex justify-between text-lg font-bold">
                        <span>Final Fare</span>
                        <span className="text-primary">{fmt(fareBreakdown.finalFare)}</span>
                      </div>

                      {fareBreakdown.finalFare <= fareBreakdown.minimumFare && (
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Info className="h-3 w-3" />
                          <span>Minimum fare of {fmt(fareBreakdown.minimumFare)} applied</span>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {fareBreakdown && fareBreakdown.appliedRules.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Info className="h-5 w-5" />
                    Applied Rules
                  </CardTitle>
                  <CardDescription>Fare Engine rules that affected this calculation</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {fareBreakdown.appliedRules.map((rule, index) => (
                      <div key={index} className="flex items-start gap-2 text-sm">
                        <ArrowRight className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                        <span>{rule}</span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
