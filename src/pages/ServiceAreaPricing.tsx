import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { supabase } from '@/integrations/supabase/client';
import { 
  ArrowLeft, 
  Save, 
  Loader2, 
  Car, 
  ChevronUp, 
  ChevronDown,
  Plus, 
  Trash2, 
  Ban,
  AlertCircle,
  Users,
  FileText,
  Globe
} from 'lucide-react';
import { toast } from 'sonner';

interface VehicleType {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  display_order: number;
  is_active: boolean;
}

interface PricingTier {
  from_km?: number;
  from_min?: number;
  rate: number;
}

interface VehiclePricing {
  id?: string;
  vehicle_type_id: string;
  is_enabled: boolean;
  base_fare: number;
  minimum_fare: number;
  currency_code: string;
  distance_pricing: PricingTier[];
  time_pricing: PricingTier[];
  pickup_waiting_charges: PricingTier[];
  stops_waiting_charges: PricingTier[];
  isExpanded?: boolean;
}

interface CancellationFees {
  free_cancellation_window_minutes: number;
  cancellation_fee: number;
  no_show_fee: number;
  currency_code: string;
}

interface ServiceArea {
  id: string;
  name: string;
  region_id: string;
  is_active: boolean;
  region?: { name: string };
}

export default function ServiceAreaPricing() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const serviceAreaIdFromParams = searchParams.get('id');

  const [serviceAreas, setServiceAreas] = useState<ServiceArea[]>([]);
  const [selectedServiceAreaId, setSelectedServiceAreaId] = useState<string>(serviceAreaIdFromParams || '');
  const [vehicleTypes, setVehicleTypes] = useState<VehicleType[]>([]);
  const [vehiclePricing, setVehiclePricing] = useState<Record<string, VehiclePricing>>({});
  const [cancellationFees, setCancellationFees] = useState<CancellationFees>({
    free_cancellation_window_minutes: 5,
    cancellation_fee: 5,
    no_show_fee: 10,
    currency_code: 'GBP',
  });
  
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  const selectedServiceArea = serviceAreas.find(sa => sa.id === selectedServiceAreaId);

  useEffect(() => {
    fetchInitialData();
  }, []);

  useEffect(() => {
    if (selectedServiceAreaId) {
      fetchPricingData(selectedServiceAreaId);
    }
  }, [selectedServiceAreaId]);

  const fetchInitialData = async () => {
    try {
      setIsLoading(true);
      const [areasRes, typesRes] = await Promise.all([
        supabase
          .from('service_areas')
          .select('id, name, region_id, is_active, region:regions(name)')
          .order('name'),
        supabase
          .from('vehicle_types')
          .select('*')
          .eq('is_active', true)
          .order('display_order'),
      ]);

      if (areasRes.error) throw areasRes.error;
      if (typesRes.error) throw typesRes.error;

      setServiceAreas(areasRes.data || []);
      setVehicleTypes(typesRes.data || []);

      if (serviceAreaIdFromParams && areasRes.data?.some(sa => sa.id === serviceAreaIdFromParams)) {
        setSelectedServiceAreaId(serviceAreaIdFromParams);
      } else if (areasRes.data && areasRes.data.length > 0) {
        setSelectedServiceAreaId(areasRes.data[0].id);
      }
    } catch (err) {
      console.error('Error fetching data:', err);
      toast.error('Failed to load data');
    } finally {
      setIsLoading(false);
    }
  };

  const fetchPricingData = async (serviceAreaId: string) => {
    try {
      const [pricingRes, feesRes] = await Promise.all([
        supabase
          .from('service_area_vehicle_pricing')
          .select('*')
          .eq('service_area_id', serviceAreaId),
        supabase
          .from('service_area_cancellation_fees')
          .select('*')
          .eq('service_area_id', serviceAreaId)
          .single(),
      ]);

      // Build pricing map
      const pricingMap: Record<string, VehiclePricing> = {};
      vehicleTypes.forEach(vt => {
        const existingPricing = pricingRes.data?.find(p => p.vehicle_type_id === vt.id);
        if (existingPricing) {
          pricingMap[vt.id] = {
            id: existingPricing.id,
            vehicle_type_id: vt.id,
            is_enabled: existingPricing.is_enabled,
            base_fare: Number(existingPricing.base_fare),
            minimum_fare: Number(existingPricing.minimum_fare),
            currency_code: existingPricing.currency_code,
            distance_pricing: (existingPricing.distance_pricing as unknown as PricingTier[]) || [{ from_km: 0, rate: 1.5 }],
            time_pricing: (existingPricing.time_pricing as unknown as PricingTier[]) || [{ from_min: 0, rate: 0.25 }],
            pickup_waiting_charges: (existingPricing.pickup_waiting_charges as unknown as PricingTier[]) || [{ from_min: 0, rate: 0.2 }],
            stops_waiting_charges: (existingPricing.stops_waiting_charges as unknown as PricingTier[]) || [{ from_min: 0, rate: 0.3 }],
            isExpanded: existingPricing.is_enabled,
          };
        } else {
          pricingMap[vt.id] = {
            vehicle_type_id: vt.id,
            is_enabled: false,
            base_fare: 3,
            minimum_fare: 5,
            currency_code: 'GBP',
            distance_pricing: [{ from_km: 0, rate: 1.5 }],
            time_pricing: [{ from_min: 0, rate: 0.25 }],
            pickup_waiting_charges: [{ from_min: 0, rate: 0.2 }],
            stops_waiting_charges: [{ from_min: 0, rate: 0.3 }],
            isExpanded: false,
          };
        }
      });
      setVehiclePricing(pricingMap);

      // Set cancellation fees
      if (feesRes.data) {
        setCancellationFees({
          free_cancellation_window_minutes: feesRes.data.free_cancellation_window_minutes,
          cancellation_fee: Number(feesRes.data.cancellation_fee),
          no_show_fee: Number(feesRes.data.no_show_fee),
          currency_code: feesRes.data.currency_code,
        });
      } else {
        setCancellationFees({
          free_cancellation_window_minutes: 5,
          cancellation_fee: 5,
          no_show_fee: 10,
          currency_code: 'GBP',
        });
      }
      
      setHasChanges(false);
    } catch (err) {
      console.error('Error fetching pricing:', err);
    }
  };

  const toggleVehicleEnabled = (vehicleTypeId: string) => {
    setVehiclePricing(prev => ({
      ...prev,
      [vehicleTypeId]: {
        ...prev[vehicleTypeId],
        is_enabled: !prev[vehicleTypeId].is_enabled,
        isExpanded: !prev[vehicleTypeId].is_enabled,
      },
    }));
    setHasChanges(true);
  };

  const toggleExpanded = (vehicleTypeId: string) => {
    setVehiclePricing(prev => ({
      ...prev,
      [vehicleTypeId]: {
        ...prev[vehicleTypeId],
        isExpanded: !prev[vehicleTypeId].isExpanded,
      },
    }));
  };

  const updatePricing = (vehicleTypeId: string, field: keyof VehiclePricing, value: any) => {
    setVehiclePricing(prev => ({
      ...prev,
      [vehicleTypeId]: {
        ...prev[vehicleTypeId],
        [field]: value,
      },
    }));
    setHasChanges(true);
  };

  const addPricingTier = (vehicleTypeId: string, field: 'distance_pricing' | 'time_pricing' | 'pickup_waiting_charges' | 'stops_waiting_charges') => {
    const pricing = vehiclePricing[vehicleTypeId];
    const tiers = [...pricing[field]];
    const lastTier = tiers[tiers.length - 1];
    
    if (field === 'distance_pricing') {
      tiers.push({ from_km: (lastTier?.from_km || 0) + 5, rate: lastTier?.rate || 1.5 });
    } else {
      tiers.push({ from_min: (lastTier?.from_min || 0) + 5, rate: lastTier?.rate || 0.25 });
    }
    
    updatePricing(vehicleTypeId, field, tiers);
  };

  const removePricingTier = (vehicleTypeId: string, field: 'distance_pricing' | 'time_pricing' | 'pickup_waiting_charges' | 'stops_waiting_charges', index: number) => {
    const pricing = vehiclePricing[vehicleTypeId];
    const tiers = pricing[field].filter((_, i) => i !== index);
    updatePricing(vehicleTypeId, field, tiers);
  };

  const updatePricingTier = (
    vehicleTypeId: string, 
    field: 'distance_pricing' | 'time_pricing' | 'pickup_waiting_charges' | 'stops_waiting_charges', 
    index: number, 
    tierField: string, 
    value: number
  ) => {
    const pricing = vehiclePricing[vehicleTypeId];
    const tiers = [...pricing[field]];
    tiers[index] = { ...tiers[index], [tierField]: value };
    updatePricing(vehicleTypeId, field, tiers);
  };

  const handleSave = async () => {
    if (!selectedServiceAreaId) return;

    setIsSaving(true);
    try {
      // Save vehicle pricing
      for (const [vehicleTypeId, pricing] of Object.entries(vehiclePricing)) {
        if (pricing.is_enabled) {
          const data: Record<string, unknown> = {
            service_area_id: selectedServiceAreaId,
            vehicle_type_id: vehicleTypeId,
            is_enabled: pricing.is_enabled,
            base_fare: pricing.base_fare,
            minimum_fare: pricing.minimum_fare,
            currency_code: pricing.currency_code,
            distance_pricing: JSON.parse(JSON.stringify(pricing.distance_pricing)),
            time_pricing: JSON.parse(JSON.stringify(pricing.time_pricing)),
            pickup_waiting_charges: JSON.parse(JSON.stringify(pricing.pickup_waiting_charges)),
            stops_waiting_charges: JSON.parse(JSON.stringify(pricing.stops_waiting_charges)),
          };

          if (pricing.id) {
            await supabase
              .from('service_area_vehicle_pricing')
              .update(data as any)
              .eq('id', pricing.id);
          } else {
            const { data: newPricing } = await supabase
              .from('service_area_vehicle_pricing')
              .insert(data as any)
              .select()
              .single();
            
            if (newPricing) {
              setVehiclePricing(prev => ({
                ...prev,
                [vehicleTypeId]: { ...prev[vehicleTypeId], id: newPricing.id },
              }));
            }
          }
        } else if (pricing.id) {
          // Delete if disabled and exists
          await supabase
            .from('service_area_vehicle_pricing')
            .delete()
            .eq('id', pricing.id);
          
          setVehiclePricing(prev => ({
            ...prev,
            [vehicleTypeId]: { ...prev[vehicleTypeId], id: undefined },
          }));
        }
      }

      // Save cancellation fees
      const { data: existingFees } = await supabase
        .from('service_area_cancellation_fees')
        .select('id')
        .eq('service_area_id', selectedServiceAreaId)
        .single();

      const feesData = {
        service_area_id: selectedServiceAreaId,
        ...cancellationFees,
      };

      if (existingFees) {
        await supabase
          .from('service_area_cancellation_fees')
          .update(feesData)
          .eq('id', existingFees.id);
      } else {
        await supabase
          .from('service_area_cancellation_fees')
          .insert(feesData);
      }

      toast.success('Service area pricing saved successfully');
      setHasChanges(false);
    } catch (err: any) {
      console.error('Error saving:', err);
      toast.error(err.message || 'Failed to save pricing');
    } finally {
      setIsSaving(false);
    }
  };

  const getCurrencySymbol = (code: string) => {
    const symbols: Record<string, string> = { GBP: '£', USD: '$', EUR: '€', KES: 'KES' };
    return symbols[code] || code;
  };

  if (isLoading) {
    return (
      <AdminLayout title="Services" description="Loading...">
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout 
      title="Services" 
      description="Service Areas › Services"
    >
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
        <div className="flex items-center gap-4">
          <p className="text-sm text-muted-foreground">
            Create a new service area with pricing per vehicle type
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Service Area:</span>
            <Select value={selectedServiceAreaId} onValueChange={setSelectedServiceAreaId}>
              <SelectTrigger className="w-[200px]">
                <Globe className="h-4 w-4 mr-2" />
                <SelectValue placeholder="Select service area" />
              </SelectTrigger>
              <SelectContent>
                {serviceAreas.map(area => (
                  <SelectItem key={area.id} value={area.id}>
                    {area.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button variant="outline" onClick={() => navigate('/services')}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Services
          </Button>
          <Button onClick={handleSave} disabled={isSaving || !hasChanges}>
            {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
            Save Service Area
          </Button>
        </div>
      </div>

      {/* Vehicle Types Pricing */}
      <Card className="mb-6">
        <CardContent className="p-6 space-y-4">
          {vehicleTypes.map(vt => {
            const pricing = vehiclePricing[vt.id];
            if (!pricing) return null;

            const currencySymbol = getCurrencySymbol(pricing.currency_code);

            if (!pricing.is_enabled) {
              return (
                <div 
                  key={vt.id} 
                  className="flex items-center justify-between p-4 border rounded-lg bg-muted/30"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-muted rounded-lg flex items-center justify-center">
                      <Car className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <p className="font-medium">{vt.name}</p>
                      <p className="text-sm text-muted-foreground">{vt.slug}</p>
                    </div>
                  </div>
                  <Button variant="outline" onClick={() => toggleVehicleEnabled(vt.id)}>
                    <Plus className="mr-2 h-4 w-4" />
                    Enable
                  </Button>
                </div>
              );
            }

            return (
              <Collapsible key={vt.id} open={pricing.isExpanded} onOpenChange={() => toggleExpanded(vt.id)}>
                <div className="border rounded-lg overflow-hidden">
                  {/* Header */}
                  <div className="flex items-center justify-between p-4 bg-muted/30">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
                        <Car className="h-5 w-5 text-primary" />
                      </div>
                      <div>
                        <p className="font-medium">{vt.name}</p>
                        <p className="text-sm text-muted-foreground">{vt.slug}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <Badge variant="outline" className="bg-primary/5">
                        {currencySymbol}{pricing.base_fare.toFixed(2)} base
                      </Badge>
                      <CollapsibleTrigger asChild>
                        <Button variant="ghost" size="sm">
                          {pricing.isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                          {pricing.isExpanded ? 'Collapse' : 'Expand'}
                        </Button>
                      </CollapsibleTrigger>
                      <Button 
                        variant="ghost" 
                        size="icon"
                        className="text-destructive hover:text-destructive"
                        onClick={() => toggleVehicleEnabled(vt.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>

                  <CollapsibleContent>
                    <div className="p-6 space-y-6 border-t">
                      {/* Base Fare & Minimum Fare */}
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label>Base Fare ({pricing.currency_code})</Label>
                          <Input
                            type="number"
                            step="0.01"
                            value={pricing.base_fare}
                            onChange={e => updatePricing(vt.id, 'base_fare', parseFloat(e.target.value) || 0)}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>Minimum Fare ({pricing.currency_code})</Label>
                          <Input
                            type="number"
                            step="0.01"
                            value={pricing.minimum_fare}
                            onChange={e => updatePricing(vt.id, 'minimum_fare', parseFloat(e.target.value) || 0)}
                          />
                        </div>
                      </div>

                      {/* Distance Pricing */}
                      <PricingTierSection
                        title="Distance Pricing"
                        description="Rate per km at different distance ranges"
                        tiers={pricing.distance_pricing}
                        fromLabel="From km:"
                        fromField="from_km"
                        rateUnit="/km"
                        onAdd={() => addPricingTier(vt.id, 'distance_pricing')}
                        onRemove={(index) => removePricingTier(vt.id, 'distance_pricing', index)}
                        onUpdate={(index, field, value) => updatePricingTier(vt.id, 'distance_pricing', index, field, value)}
                      />

                      {/* Time Pricing */}
                      <PricingTierSection
                        title="Time Pricing"
                        description="Rate per minute at different duration ranges"
                        tiers={pricing.time_pricing}
                        fromLabel="From min:"
                        fromField="from_min"
                        rateUnit="/min"
                        onAdd={() => addPricingTier(vt.id, 'time_pricing')}
                        onRemove={(index) => removePricingTier(vt.id, 'time_pricing', index)}
                        onUpdate={(index, field, value) => updatePricingTier(vt.id, 'time_pricing', index, field, value)}
                      />

                      {/* Pickup Waiting Charges */}
                      <PricingTierSection
                        title="Pickup Waiting Charges"
                        description="Rate per minute for waiting at pickup location"
                        tiers={pricing.pickup_waiting_charges}
                        fromLabel="From min:"
                        fromField="from_min"
                        rateUnit="/min"
                        onAdd={() => addPricingTier(vt.id, 'pickup_waiting_charges')}
                        onRemove={(index) => removePricingTier(vt.id, 'pickup_waiting_charges', index)}
                        onUpdate={(index, field, value) => updatePricingTier(vt.id, 'pickup_waiting_charges', index, field, value)}
                      />

                      {/* Stops Waiting Charges */}
                      <PricingTierSection
                        title="Stops Waiting Charges"
                        description="Rate per minute for waiting at intermediate stops"
                        tiers={pricing.stops_waiting_charges}
                        fromLabel="From min:"
                        fromField="from_min"
                        rateUnit="/min"
                        onAdd={() => addPricingTier(vt.id, 'stops_waiting_charges')}
                        onRemove={(index) => removePricingTier(vt.id, 'stops_waiting_charges', index)}
                        onUpdate={(index, field, value) => updatePricingTier(vt.id, 'stops_waiting_charges', index, field, value)}
                      />

                      {/* Warning */}
                      <div className="flex items-center gap-2 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
                        <AlertCircle className="h-4 w-4 text-amber-600" />
                        <p className="text-sm text-amber-700 dark:text-amber-400">
                          <span className="font-semibold">NO grace period</span> – Charging for stops waiting starts immediately at minute 0.
                        </p>
                      </div>
                    </div>
                  </CollapsibleContent>
                </div>
              </Collapsible>
            );
          })}
        </CardContent>
      </Card>

      {/* Cancellation & No-Show Fees */}
      <Card className="mb-6">
        <CardContent className="p-6">
          <div className="flex items-center gap-2 mb-4">
            <Ban className="h-5 w-5 text-muted-foreground" />
            <h3 className="text-lg font-semibold">Cancellation & No-Show Fees</h3>
          </div>
          <p className="text-sm text-muted-foreground mb-6">
            Fees charged when a ride is cancelled or the rider doesn't show
          </p>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="space-y-2">
              <Label>Free Cancellation Window (minutes)</Label>
              <Input
                type="number"
                value={cancellationFees.free_cancellation_window_minutes}
                onChange={e => {
                  setCancellationFees(prev => ({ 
                    ...prev, 
                    free_cancellation_window_minutes: parseInt(e.target.value) || 0 
                  }));
                  setHasChanges(true);
                }}
              />
              <p className="text-xs text-muted-foreground">No fee if cancelled within this time</p>
            </div>
            <div className="space-y-2">
              <Label>Cancellation Fee ({cancellationFees.currency_code})</Label>
              <Input
                type="number"
                step="0.01"
                value={cancellationFees.cancellation_fee}
                onChange={e => {
                  setCancellationFees(prev => ({ 
                    ...prev, 
                    cancellation_fee: parseFloat(e.target.value) || 0 
                  }));
                  setHasChanges(true);
                }}
              />
              <p className="text-xs text-muted-foreground">Fee after free window expires</p>
            </div>
            <div className="space-y-2">
              <Label>No-Show Fee ({cancellationFees.currency_code})</Label>
              <Input
                type="number"
                step="0.01"
                value={cancellationFees.no_show_fee}
                onChange={e => {
                  setCancellationFees(prev => ({ 
                    ...prev, 
                    no_show_fee: parseFloat(e.target.value) || 0 
                  }));
                  setHasChanges(true);
                }}
              />
              <p className="text-xs text-muted-foreground">Fee when rider doesn't show</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Service Area Assignments */}
      <Card>
        <CardContent className="p-6">
          <h3 className="text-lg font-semibold mb-2">Service Area Assignments</h3>
          <p className="text-sm text-muted-foreground mb-4">
            Assign drivers and document requirements to this service area
          </p>

          <Tabs defaultValue="drivers">
            <TabsList>
              <TabsTrigger value="drivers" className="flex items-center gap-2">
                <Users className="h-4 w-4" />
                Drivers
              </TabsTrigger>
              <TabsTrigger value="documents" className="flex items-center gap-2">
                <FileText className="h-4 w-4" />
                Document Requirements
              </TabsTrigger>
            </TabsList>
            <TabsContent value="drivers" className="mt-4">
              <p className="text-sm text-muted-foreground">
                Driver assignments are managed from the Drivers page. Go to Drivers → Select a driver → Assign Service Areas.
              </p>
            </TabsContent>
            <TabsContent value="documents" className="mt-4">
              <p className="text-sm text-muted-foreground">
                Document requirements for this service area coming soon.
              </p>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </AdminLayout>
  );
}

// Pricing Tier Section Component
interface PricingTierSectionProps {
  title: string;
  description: string;
  tiers: PricingTier[];
  fromLabel: string;
  fromField: 'from_km' | 'from_min';
  rateUnit: string;
  onAdd: () => void;
  onRemove: (index: number) => void;
  onUpdate: (index: number, field: string, value: number) => void;
}

function PricingTierSection({ 
  title, 
  description, 
  tiers, 
  fromLabel, 
  fromField, 
  rateUnit, 
  onAdd, 
  onRemove, 
  onUpdate 
}: PricingTierSectionProps) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="font-medium">{title}</p>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        <Button variant="outline" size="sm" onClick={onAdd}>
          <Plus className="mr-2 h-4 w-4" />
          Add
        </Button>
      </div>
      
      {tiers.map((tier, index) => (
        <div key={index} className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground w-16">{fromLabel}</span>
            <Input
              type="number"
              className="w-24"
              value={tier[fromField] ?? 0}
              onChange={e => onUpdate(index, fromField, parseFloat(e.target.value) || 0)}
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Rate:</span>
            <Input
              type="number"
              step="0.01"
              className="w-24"
              value={tier.rate}
              onChange={e => onUpdate(index, 'rate', parseFloat(e.target.value) || 0)}
            />
            <span className="text-sm text-muted-foreground">{rateUnit}</span>
          </div>
          <Button 
            variant="ghost" 
            size="icon" 
            onClick={() => onRemove(index)}
            disabled={tiers.length === 1}
            className="text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
    </div>
  );
}
