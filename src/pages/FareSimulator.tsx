import { useState } from "react";
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
import { Calculator, MapPin, Navigation, Car, Clock, Percent, DollarSign, ArrowRight, RotateCcw, Info, TrendingUp, Building2 } from "lucide-react";

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

interface VehiclePricing {
  id: string;
  service_area_id: string;
  vehicle_type_id: string;
  base_fare: number;
  minimum_fare: number;
  distance_pricing: any;
  time_pricing: any;
  currency_code: string;
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
  zoneSurcharge: number;
  zoneDiscount: number;
  corporateDiscount: number;
  promoDiscount: number;
  subtotal: number;
  minimumFare: number;
  finalFare: number;
  appliedRules: string[];
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
    pickup_zone_id: "",
    dropoff_zone_id: "",
    is_corporate: false,
    corporate_discount: 0,
    promo_code: "",
    promo_discount: 0,
    surge_multiplier: 1.0,
  });

  const { data: vehicleTypes = [] } = useQuery({
    queryKey: ['vehicle-types'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('vehicle_types')
        .select('id, name, slug')
        .eq('is_active', true)
        .order('display_order');
      if (error) throw error;
      return data as VehicleType[];
    },
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

  const { data: vehiclePricing = [] } = useQuery({
    queryKey: ['vehicle-pricing'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('service_area_vehicle_pricing')
        .select('*')
        .eq('is_enabled', true);
      if (error) throw error;
      return data as VehiclePricing[];
    },
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

  const calculateFare = () => {
    if (!formData.service_area_id || !formData.vehicle_type_id) {
      toast({ title: "Please select a service area and vehicle type", variant: "destructive" });
      return;
    }

    setIsCalculating(true);

    // Simulate calculation delay for UX
    setTimeout(() => {
      const pricing = vehiclePricing.find(
        p => p.service_area_id === formData.service_area_id && p.vehicle_type_id === formData.vehicle_type_id
      );

      if (!pricing) {
        toast({ title: "No pricing found for this combination", variant: "destructive" });
        setIsCalculating(false);
        return;
      }

      const appliedRules: string[] = [];

      // Base fare
      const baseFare = pricing.base_fare;
      appliedRules.push(`Base fare: £${baseFare.toFixed(2)}`);

      // Calculate distance fare (simplified - using first tier)
      const distancePricing = pricing.distance_pricing as { rate: number; from_km: number }[];
      let distanceFare = 0;
      if (distancePricing && distancePricing.length > 0) {
        const rate = distancePricing[0].rate || 1.5;
        distanceFare = formData.distance_km * rate;
        appliedRules.push(`Distance: ${formData.distance_km}km × £${rate.toFixed(2)} = £${distanceFare.toFixed(2)}`);
      }

      // Calculate time fare (simplified - using first tier)
      const timePricing = pricing.time_pricing as { rate: number; from_min: number }[];
      let timeFare = 0;
      if (timePricing && timePricing.length > 0) {
        const rate = timePricing[0].rate || 0.25;
        timeFare = formData.duration_minutes * rate;
        appliedRules.push(`Time: ${formData.duration_minutes}min × £${rate.toFixed(2)} = £${timeFare.toFixed(2)}`);
      }

      // Zone adjustments
      let zoneSurcharge = 0;
      let zoneDiscount = 0;

      // Pickup zone rules
      if (formData.pickup_zone_id) {
        const pickupZone = customZones.find(z => z.id === formData.pickup_zone_id);
        const pickupRules = zonePricingRules.filter(
          r => r.zone_id === formData.pickup_zone_id && 
          (!r.vehicle_type_id || r.vehicle_type_id === formData.vehicle_type_id) &&
          (r.applies_to === 'both' || r.applies_to === 'pickup')
        );

        pickupRules.forEach(rule => {
          if (rule.rule_type === 'multiplier' && rule.value > 1) {
            const surcharge = (baseFare + distanceFare + timeFare) * (rule.value - 1);
            zoneSurcharge += surcharge;
            appliedRules.push(`Pickup zone "${pickupZone?.name}": ${rule.value}x multiplier (+£${surcharge.toFixed(2)})`);
          } else if (rule.rule_type === 'flat_rate') {
            zoneSurcharge += rule.value;
            appliedRules.push(`Pickup zone "${pickupZone?.name}": +£${rule.value.toFixed(2)} flat rate`);
          } else if (rule.rule_type === 'percentage_discount') {
            const discount = (baseFare + distanceFare + timeFare) * (rule.value / 100);
            zoneDiscount += discount;
            appliedRules.push(`Pickup zone "${pickupZone?.name}": ${rule.value}% discount (-£${discount.toFixed(2)})`);
          }
        });
      }

      // Dropoff zone rules
      if (formData.dropoff_zone_id) {
        const dropoffZone = customZones.find(z => z.id === formData.dropoff_zone_id);
        const dropoffRules = zonePricingRules.filter(
          r => r.zone_id === formData.dropoff_zone_id && 
          (!r.vehicle_type_id || r.vehicle_type_id === formData.vehicle_type_id) &&
          (r.applies_to === 'both' || r.applies_to === 'dropoff')
        );

        dropoffRules.forEach(rule => {
          if (rule.rule_type === 'multiplier' && rule.value > 1) {
            const surcharge = (baseFare + distanceFare + timeFare) * (rule.value - 1);
            zoneSurcharge += surcharge;
            appliedRules.push(`Dropoff zone "${dropoffZone?.name}": ${rule.value}x multiplier (+£${surcharge.toFixed(2)})`);
          } else if (rule.rule_type === 'flat_rate') {
            zoneSurcharge += rule.value;
            appliedRules.push(`Dropoff zone "${dropoffZone?.name}": +£${rule.value.toFixed(2)} flat rate`);
          } else if (rule.rule_type === 'percentage_discount') {
            const discount = (baseFare + distanceFare + timeFare) * (rule.value / 100);
            zoneDiscount += discount;
            appliedRules.push(`Dropoff zone "${dropoffZone?.name}": ${rule.value}% discount (-£${discount.toFixed(2)})`);
          }
        });
      }

      // Surge multiplier
      let subtotal = baseFare + distanceFare + timeFare + zoneSurcharge - zoneDiscount;
      if (formData.surge_multiplier > 1) {
        const surgePremium = subtotal * (formData.surge_multiplier - 1);
        subtotal += surgePremium;
        appliedRules.push(`Surge pricing: ${formData.surge_multiplier}x (+£${surgePremium.toFixed(2)})`);
      }

      // Corporate discount
      let corporateDiscount = 0;
      if (formData.is_corporate && formData.corporate_discount > 0) {
        corporateDiscount = subtotal * (formData.corporate_discount / 100);
        appliedRules.push(`Corporate discount: ${formData.corporate_discount}% (-£${corporateDiscount.toFixed(2)})`);
      }

      // Promo discount
      let promoDiscount = 0;
      if (formData.promo_code && formData.promo_discount > 0) {
        promoDiscount = (subtotal - corporateDiscount) * (formData.promo_discount / 100);
        appliedRules.push(`Promo code "${formData.promo_code}": ${formData.promo_discount}% (-£${promoDiscount.toFixed(2)})`);
      }

      // Calculate final fare
      let finalFare = subtotal - corporateDiscount - promoDiscount;
      const minimumFare = pricing.minimum_fare;

      if (finalFare < minimumFare) {
        appliedRules.push(`Minimum fare applied: £${minimumFare.toFixed(2)}`);
        finalFare = minimumFare;
      }

      setFareBreakdown({
        baseFare,
        distanceFare,
        timeFare,
        zoneSurcharge,
        zoneDiscount,
        corporateDiscount,
        promoDiscount,
        subtotal,
        minimumFare,
        finalFare,
        appliedRules,
      });

      setIsCalculating(false);
    }, 500);
  };

  const resetSimulator = () => {
    setFormData({
      service_area_id: "",
      vehicle_type_id: "",
      distance_km: 5,
      duration_minutes: 15,
      pickup_zone_id: "",
      dropoff_zone_id: "",
      is_corporate: false,
      corporate_discount: 0,
      promo_code: "",
      promo_discount: 0,
      surge_multiplier: 1.0,
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
            <p className="text-muted-foreground">Test and preview fare calculations with different parameters</p>
          </div>
          <Button variant="outline" onClick={resetSimulator}>
            <RotateCcw className="mr-2 h-4 w-4" />
            Reset
          </Button>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          {/* Input Form */}
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Car className="h-5 w-5" />
                  Trip Details
                </CardTitle>
                <CardDescription>Configure the trip parameters</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="grid gap-2">
                    <Label>Service Area *</Label>
                    <Select
                      value={formData.service_area_id}
                      onValueChange={(value) => setFormData({ ...formData, service_area_id: value })}
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
                  <div className="grid gap-2">
                    <Label>Vehicle Type *</Label>
                    <Select
                      value={formData.vehicle_type_id}
                      onValueChange={(value) => setFormData({ ...formData, vehicle_type_id: value })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select vehicle" />
                      </SelectTrigger>
                      <SelectContent>
                        {vehicleTypes.map((type) => (
                          <SelectItem key={type.id} value={type.id}>{type.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

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

                <div className="grid gap-2">
                  <Label className="flex items-center gap-2">
                    <TrendingUp className="h-4 w-4" />
                    Surge Multiplier
                  </Label>
                  <div className="flex items-center gap-4">
                    <Input
                      type="number"
                      step="0.1"
                      value={formData.surge_multiplier}
                      onChange={(e) => setFormData({ ...formData, surge_multiplier: parseFloat(e.target.value) || 1 })}
                      min={1}
                      max={5}
                      className="max-w-[120px]"
                    />
                    <div className="flex gap-2">
                      {[1, 1.5, 2, 2.5].map((mult) => (
                        <Button
                          key={mult}
                          type="button"
                          variant={formData.surge_multiplier === mult ? "default" : "outline"}
                          size="sm"
                          onClick={() => setFormData({ ...formData, surge_multiplier: mult })}
                        >
                          {mult}x
                        </Button>
                      ))}
                    </div>
                  </div>
                </div>
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
                  {fareBreakdown ? "Calculated fare estimate" : "Configure trip details and click Calculate"}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {!fareBreakdown ? (
                  <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
                    <Calculator className="h-12 w-12 mb-4 opacity-50" />
                    <p>No calculation yet</p>
                    <p className="text-sm">Fill in the trip details and click Calculate Fare</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {/* Summary */}
                    <div className="rounded-lg bg-primary/10 p-6 text-center">
                      <p className="text-sm text-muted-foreground mb-1">Estimated Fare</p>
                      <p className="text-4xl font-bold text-primary">
                        £{fareBreakdown.finalFare.toFixed(2)}
                      </p>
                    </div>

                    <Separator />

                    {/* Breakdown */}
                    <div className="space-y-3">
                      <div className="flex justify-between text-sm">
                        <span>Base Fare</span>
                        <span>£{fareBreakdown.baseFare.toFixed(2)}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span>Distance ({formData.distance_km}km)</span>
                        <span>£{fareBreakdown.distanceFare.toFixed(2)}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span>Time ({formData.duration_minutes}min)</span>
                        <span>£{fareBreakdown.timeFare.toFixed(2)}</span>
                      </div>
                      
                      {fareBreakdown.zoneSurcharge > 0 && (
                        <div className="flex justify-between text-sm text-orange-500">
                          <span>Zone Surcharges</span>
                          <span>+£{fareBreakdown.zoneSurcharge.toFixed(2)}</span>
                        </div>
                      )}
                      
                      {fareBreakdown.zoneDiscount > 0 && (
                        <div className="flex justify-between text-sm text-green-500">
                          <span>Zone Discounts</span>
                          <span>-£{fareBreakdown.zoneDiscount.toFixed(2)}</span>
                        </div>
                      )}

                      <Separator />

                      <div className="flex justify-between font-medium">
                        <span>Subtotal</span>
                        <span>£{fareBreakdown.subtotal.toFixed(2)}</span>
                      </div>

                      {fareBreakdown.corporateDiscount > 0 && (
                        <div className="flex justify-between text-sm text-green-500">
                          <span>Corporate Discount</span>
                          <span>-£{fareBreakdown.corporateDiscount.toFixed(2)}</span>
                        </div>
                      )}

                      {fareBreakdown.promoDiscount > 0 && (
                        <div className="flex justify-between text-sm text-green-500">
                          <span>Promo Discount</span>
                          <span>-£{fareBreakdown.promoDiscount.toFixed(2)}</span>
                        </div>
                      )}

                      <Separator />

                      <div className="flex justify-between text-lg font-bold">
                        <span>Final Fare</span>
                        <span className="text-primary">£{fareBreakdown.finalFare.toFixed(2)}</span>
                      </div>

                      {fareBreakdown.finalFare === fareBreakdown.minimumFare && (
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Info className="h-3 w-3" />
                          <span>Minimum fare of £{fareBreakdown.minimumFare.toFixed(2)} applied</span>
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
                  <CardDescription>Pricing rules that affected this calculation</CardDescription>
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
