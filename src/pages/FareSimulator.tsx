import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { adminPageSelect, adminServiceAreasLookup } from '@/lib/adminPageGatedData';
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
  center_lat: number | null;
  center_lng: number | null;
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
  airportCharge: number;
  tripFare: number;
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
      const { rows } = await adminServiceAreasLookup<{
        id: string;
        name: string;
        region_id: string;
      }>('fare-simulator', { active_only: true });
      return rows as ServiceArea[];
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
      const { rows: assignments } = await adminPageSelect<{ vehicle_type_id: string }>(
        'fare-simulator',
        'service_area_vehicle_pricing',
        {
          columns: ['vehicle_type_id'],
          filters: [
            { op: 'eq', col: 'service_area_id', val: formData.service_area_id },
            { op: 'eq', col: 'is_enabled', val: true },
          ],
          limit: 500,
        },
      );
      if (assignments.length === 0) return [];
      const vtIds = assignments.map((a) => a.vehicle_type_id);
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

      const cols = [
        'id', 'service_area_id', 'vehicle_type_id', 'pricing_mode', 'currency_code',
        'base_fare_pence', 'per_km_rate_pence', 'per_min_rate_pence', 'booking_fee_pence',
        'minimum_fare_pence', 'free_waiting_minutes', 'waiting_per_minute_pence',
        'extra_stop_flat_fee_pence', 'recalculate_on_waiting', 'recalculate_on_stop_added',
        'recalculate_on_dropoff_changed', 'enable_surge', 'surge_multiplier_default',
        'peak_hour_multiplier', 'zone_multiplier', 'traffic_multiplier',
        'demand_supply_multiplier', 'distance_pricing_bands',
      ];
      if (formData.vehicle_type_id) {
        const { rows } = await adminPageSelect<FarePricingSettings>('fare-simulator', 'fare_pricing_settings', {
          columns: cols,
          filters: [
            { op: 'eq', col: 'service_area_id', val: formData.service_area_id },
            { op: 'eq', col: 'vehicle_type_id', val: formData.vehicle_type_id },
          ],
          limit: 1,
        });
        if (rows[0]) return rows[0];
      }
      const { rows } = await adminPageSelect<FarePricingSettings>('fare-simulator', 'fare_pricing_settings', {
        columns: cols,
        filters: [
          { op: 'eq', col: 'service_area_id', val: formData.service_area_id },
          { op: 'is_null', col: 'vehicle_type_id' },
        ],
        limit: 1,
      });
      return rows[0] ?? null;
    },
    enabled: !!formData.service_area_id,
  });

  const { data: customZones = [] } = useQuery({
    queryKey: ['custom-zones-with-centers'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('custom_zones')
        .select('id, name, zone_type, color, center_lat, center_lng')
        .eq('is_active', true)
        .order('name');
      if (error) throw error;
      return data as CustomZone[];
    },
  });

  const currencySymbol = getCurrencySymbol(currentRegionSettings.currencyCode);
  const fmt = (pence: number) => `${currencySymbol}${(pence / 100).toFixed(2)}`;

  const pointForZone = (zoneId: string): { lat: number; lng: number } | null => {
    const zone = customZones.find((z) => z.id === zoneId);
    if (!zone) return null;
    if (zone.center_lat != null && zone.center_lng != null) {
      return { lat: Number(zone.center_lat), lng: Number(zone.center_lng) };
    }
    return null;
  };

  const calculateFare = async () => {
    if (!formData.service_area_id) {
      toast({ title: "Please select a service area", variant: "destructive" });
      return;
    }

    // Live booking SSOT — no client-side meter / zone arithmetic.
    setIsCalculating(true);
    try {
      const pickup =
        (formData.pickup_zone_id && pointForZone(formData.pickup_zone_id)) ||
        (formData.dropoff_zone_id && pointForZone(formData.dropoff_zone_id)) ||
        null;
      const dropoff =
        (formData.dropoff_zone_id && pointForZone(formData.dropoff_zone_id)) ||
        pickup;

      if (!pickup || !dropoff) {
        toast({
          title: "Select pickup/dropoff zones with map centres",
          description: "The live fare engine needs coordinates. Zones without a centre cannot be simulated.",
          variant: "destructive",
        });
        setIsCalculating(false);
        return;
      }

      const { data, error } = await supabase.functions.invoke("calculate-fare", {
        body: {
          service_area_id: formData.service_area_id,
          vehicle_type_id: formData.vehicle_type_id || undefined,
          estimated_distance_km: formData.distance_km,
          estimated_duration_min: formData.duration_minutes,
          pickup,
          dropoff,
          source: "admin_fare_simulator",
        },
      });
      if (error) throw error;
      if (!data?.success) {
        throw new Error(data?.error || "calculate-fare failed");
      }

      const rows = Array.isArray(data.vehicleFares) ? data.vehicleFares : [];
      const row =
        (formData.vehicle_type_id
          ? rows.find((r: { vehicleTypeId?: string }) => r.vehicleTypeId === formData.vehicle_type_id)
          : null) ??
        rows.find((r: { hasFareConfig?: boolean; fare?: unknown }) => r.hasFareConfig !== false && r.fare) ??
        rows[0];
      const fare = row?.fare;
      const breakdown = row?.breakdown;
      if (!fare) {
        throw new Error("No priced vehicle returned from calculate-fare");
      }

      const appliedRules: string[] = [
        "Source: calculate-fare (pricing-engine SSOT)",
      ];
      if (Array.isArray(fare.fareDetails)) {
        for (const line of fare.fareDetails as Array<{ label?: string; amount?: number }>) {
          if (line?.label != null && line?.amount != null) {
            appliedRules.push(`${line.label}: ${currencySymbol}${Number(line.amount).toFixed(2)}`);
          }
        }
      }
      if (fare.fixedFareApplied || fare.fareSource === "route_fixed") {
        appliedRules.push(`Fixed route pricing applied (${fare.zoneApplied || fare.matchedRouteId || "route"})`);
      }
      if (Number(fare.surcharge ?? 0) > 0) {
        appliedRules.push(`Zone flat addition: ${currencySymbol}${Number(fare.surcharge).toFixed(2)} (once per trip)`);
      }

      const totalFarePence = Math.round(Number(fare.totalFarePence ?? 0));
      const tripFarePence = Math.round(Number(fare.tripFare ?? 0) * 100);
      const airportPence = Math.round(Number(fare.airportCharge ?? 0) * 100);
      const zoneSurcharge = Math.round(Number(fare.surcharge ?? breakdown?.surcharge ?? 0) * 100);
      const baseFare = Math.round(Number(fare.baseFare ?? breakdown?.base_fare ?? 0) * 100);
      const distanceFare = Math.round(Number(fare.distanceCost ?? breakdown?.distance_cost ?? 0) * 100);
      const timeFare = Math.round(Number(fare.timeCost ?? breakdown?.time_cost ?? 0) * 100);
      const bookingFee = Math.round(Number(fare.bookingFee ?? breakdown?.booking_fee ?? 0) * 100);
      const minimumFare = Math.round(Number(fare.minimumFare ?? breakdown?.minimum_fare ?? 0) * 100);
      const surgeMultiplier = Number(fare.appliedSurgeMultiplier ?? 1) || 1;

      // Optional simulator-only overlays (not part of live booking SSOT).
      let corporateDiscount = 0;
      let promoDiscount = 0;
      let fareAfterSsot = totalFarePence;
      if (formData.is_corporate && formData.corporate_discount > 0) {
        corporateDiscount = Math.round(fareAfterSsot * (formData.corporate_discount / 100));
        appliedRules.push(`Simulator overlay — corporate ${formData.corporate_discount}% (-${fmt(corporateDiscount)})`);
      }
      if (formData.promo_code && formData.promo_discount > 0) {
        promoDiscount = Math.round((fareAfterSsot - corporateDiscount) * (formData.promo_discount / 100));
        appliedRules.push(`Simulator overlay — promo "${formData.promo_code}" ${formData.promo_discount}% (-${fmt(promoDiscount)})`);
      }
      const finalFare = Math.max(0, fareAfterSsot - corporateDiscount - promoDiscount);

      setFareBreakdown({
        baseFare,
        distanceFare,
        timeFare,
        bookingFee,
        zoneSurcharge,
        zoneDiscount: 0,
        corporateDiscount,
        promoDiscount,
        waitingCharge: 0,
        stopCharge: 0,
        subtotal: tripFarePence,
        minimumFare,
        finalFare,
        pricingMode: String(fare.tripPricingMode || fare.fareSource || "NORMAL_DISTANCE_TIME"),
        surgeMultiplier,
        appliedRules,
        currencyCode: data.currencyCode || currentRegionSettings.currencyCode,
        distanceUnit: data.distanceUnit || currentRegionSettings.distanceUnit,
        airportCharge: airportPence,
        tripFare: tripFarePence,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Fare calculation failed";
      toast({ title: "Fare calculation failed", description: message, variant: "destructive" });
      setFareBreakdown(null);
    } finally {
      setIsCalculating(false);
    }
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
              Test live booking fares via <strong>calculate-fare</strong> — the same pricing-engine SSOT used by Customer, WhatsApp, website, and corporate.
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
            <p className="font-semibold text-sm">Powered by calculate-fare</p>
           <p className="text-sm text-muted-foreground">
              Invokes the live Edge function (meter + fixed zone routes + zone Flat Rate Addition once per trip).
              Select zones that have map centres so the engine can detect containment.
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
                  {fareBreakdown ? `calculate-fare SSOT (${fareBreakdown.pricingMode})` : "Configure trip details and click Calculate"}
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
                          <span>Zone Flat Addition</span>
                          <span>+{fmt(fareBreakdown.zoneSurcharge)}</span>
                        </div>
                      )}

                      {fareBreakdown.airportCharge > 0 && (
                        <div className="flex justify-between text-sm text-orange-500">
                          <span>Airport Charge</span>
                          <span>+{fmt(fareBreakdown.airportCharge)}</span>
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
                  <CardDescription>Lines returned by calculate-fare for this quote</CardDescription>
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
