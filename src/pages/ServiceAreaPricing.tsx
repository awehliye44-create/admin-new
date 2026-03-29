import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { supabase } from '@/integrations/supabase/client';
import { 
  ArrowLeft, 
  Save, 
  Loader2, 
  Car, 
  
  Banknote,
  Users,
  FileText,
  Globe,
  Calculator,
  CheckCircle2,
  XCircle
} from 'lucide-react';
import { toast } from 'sonner';
import { ServiceAreaPaymentConfig } from '@/components/payment/ServiceAreaPaymentConfig';
import { getCurrencySymbol } from '@/lib/regionSettings';
import { PresetOffersConfig } from '@/components/pricing/PresetOffersConfig';
import { FareEngineConfig } from '@/components/pricing/FareEngineConfig';

interface VehicleType {
  id: string;
  name: string;
  slug: string;
  capacity: number;
  features: string[];
  is_active: boolean;
}

interface VehiclePricingAssignment {
  id?: string;
  vehicle_type_id: string;
  is_enabled: boolean;
}

interface ServiceArea {
  id: string;
  name: string;
  region_id: string;
  is_active: boolean;
  per_booking_fee_enabled: boolean;
  per_booking_fee_pence: number;
  region?: { 
    name: string;
    currency_code: string;
    distance_unit: string;
  };
}

export default function ServiceAreaPricing() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const serviceAreaIdFromParams = searchParams.get('id');

  const [serviceAreas, setServiceAreas] = useState<ServiceArea[]>([]);
  const [selectedServiceAreaId, setSelectedServiceAreaId] = useState<string>(serviceAreaIdFromParams || '');



  // Vehicle pricing assignments (SSOT: service_area_vehicle_pricing)
  const [allVehicleTypes, setAllVehicleTypes] = useState<VehicleType[]>([]);
  const [pricingAssignments, setPricingAssignments] = useState<Record<string, VehiclePricingAssignment>>({});
  const [vehicleTypesLoading, setVehicleTypesLoading] = useState(false);
  const [vehicleTypesSaving, setVehicleTypesSaving] = useState(false);
  
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  const selectedServiceArea = serviceAreas.find(sa => sa.id === selectedServiceAreaId);
  // Region is the SINGLE SOURCE OF TRUTH for currency — never read from service_area
  const regionCurrency = selectedServiceArea?.region?.currency_code || '';

  useEffect(() => {
    fetchInitialData();
  }, []);

  useEffect(() => {
    if (selectedServiceAreaId) {
      fetchPricingData(selectedServiceAreaId);
      fetchVehicleTypeAssignments(selectedServiceAreaId);
    }
  }, [selectedServiceAreaId]);

  const fetchInitialData = async (isBackground = false) => {
    try {
      if (!isBackground) setIsLoading(true);
      const [areasRes, vtRes] = await Promise.all([
        supabase
          .from('service_areas')
          .select('id, name, region_id, is_active, per_booking_fee_enabled, per_booking_fee_pence, region:regions(name, currency_code, distance_unit)')
          .order('name'),
        supabase
          .from('vehicle_types')
          .select('id, name, slug, capacity, features, is_active')
          .order('display_order'),
      ]);

      if (areasRes.error) throw areasRes.error;
      if (vtRes.error) throw vtRes.error;

      setServiceAreas(areasRes.data || []);
      setAllVehicleTypes(vtRes.data || []);

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

  const fetchPricingData = async (_serviceAreaId: string) => {
    setHasChanges(false);
  };

  const fetchVehicleTypeAssignments = async (serviceAreaId: string) => {
    try {
      setVehicleTypesLoading(true);
      const { data, error } = await supabase
        .from('service_area_vehicle_types')
        .select('*')
        .eq('service_area_id', serviceAreaId);

      if (error) throw error;

      const map: Record<string, ServiceAreaVehicleType> = {};
      (data || []).forEach((row: any) => {
        map[row.vehicle_type_id] = {
          id: row.id,
          vehicle_type_id: row.vehicle_type_id,
          is_active: row.is_active,
          display_order: row.display_order || 0,
        };
      });
      setAssignedVehicleTypes(map);
    } catch (err) {
      console.error('Error fetching vehicle type assignments:', err);
    } finally {
      setVehicleTypesLoading(false);
    }
  };

  const toggleVehicleType = (vehicleTypeId: string) => {
    setAssignedVehicleTypes(prev => {
      const existing = prev[vehicleTypeId];
      if (existing) {
        // Toggle active or remove
        return {
          ...prev,
          [vehicleTypeId]: { ...existing, is_active: !existing.is_active },
        };
      } else {
        // Add new assignment
        return {
          ...prev,
          [vehicleTypeId]: {
            vehicle_type_id: vehicleTypeId,
            is_active: true,
            display_order: Object.keys(prev).length,
          },
        };
      }
    });
    setHasChanges(true);
  };

  const saveVehicleTypeAssignments = async () => {
    if (!selectedServiceAreaId) return;
    setVehicleTypesSaving(true);
    try {
      // Get current DB state
      const { data: existing } = await supabase
        .from('service_area_vehicle_types')
        .select('id, vehicle_type_id')
        .eq('service_area_id', selectedServiceAreaId);

      const existingMap = new Map((existing || []).map((e: any) => [e.vehicle_type_id, e.id]));

      for (const [vtId, assignment] of Object.entries(assignedVehicleTypes)) {
        const existingId = existingMap.get(vtId);
        if (existingId) {
          // Update
          await supabase
            .from('service_area_vehicle_types')
            .update({ is_active: assignment.is_active, display_order: assignment.display_order })
            .eq('id', existingId);
        } else if (assignment.is_active) {
          // Insert only if active
          await supabase
            .from('service_area_vehicle_types')
            .insert({
              service_area_id: selectedServiceAreaId,
              vehicle_type_id: vtId,
              is_active: assignment.is_active,
              display_order: assignment.display_order,
            });
        }
      }

      toast.success('Vehicle type assignments saved');
      await fetchVehicleTypeAssignments(selectedServiceAreaId);
      setHasChanges(false);
    } catch (err: any) {
      console.error('Error saving vehicle type assignments:', err);
      toast.error(err.message || 'Failed to save');
    } finally {
      setVehicleTypesSaving(false);
    }
  };

  const updatePerBookingFee = (field: 'per_booking_fee_enabled' | 'per_booking_fee_pence', value: boolean | number) => {
    setServiceAreas(prev => prev.map(sa => 
      sa.id === selectedServiceAreaId 
        ? { ...sa, [field]: value }
        : sa
    ));
    setHasChanges(true);
  };

  const handleSave = async () => {
    if (!selectedServiceAreaId) return;

    setIsSaving(true);
    try {
      // Save per-booking fee settings
      if (selectedServiceArea) {
        await supabase
          .from('service_areas')
          .update({
            per_booking_fee_enabled: selectedServiceArea.per_booking_fee_enabled,
            per_booking_fee_pence: selectedServiceArea.per_booking_fee_pence,
          })
          .eq('id', selectedServiceAreaId);
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

  if (isLoading) {
    return (
      <AdminLayout title="Services" description="Loading...">
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </AdminLayout>
    );
  }

  const assignedCount = Object.values(assignedVehicleTypes).filter(a => a.is_active).length;

  return (
    <AdminLayout 
      title="Services" 
      description="Service Areas › Pricing & Fares"
    >
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
        <div className="flex items-center gap-4">
          <p className="text-sm text-muted-foreground">
            Configure pricing for each service area. <strong>Fare Engine</strong> is the single source of truth for all fare calculations.
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

      {/* Fare Engine Authority Banner */}
      <div className="mb-6 flex items-start gap-3 rounded-lg border border-primary/30 bg-primary/5 p-4">
        <Calculator className="h-5 w-5 text-primary mt-0.5 shrink-0" />
        <div>
          <p className="font-semibold text-sm text-foreground">Fare Engine is the single source of truth</p>
          <p className="text-sm text-muted-foreground mt-1">
            All fare calculations — for the Customer App, Driver App, Corporate Portal, and Admin Panel — are powered exclusively by the Fare Engine.
            Vehicle Types define metadata only (name, icon, capacity, features) and do not control pricing.
            <strong className="text-foreground"> Currency ({getCurrencySymbol(regionCurrency)} {regionCurrency}) and distance units are inherited from the parent Region.</strong>
          </p>
        </div>
      </div>

      {/* Main Tabs */}
      <Tabs defaultValue="fare-engine" className="space-y-6">
        <TabsList>
          <TabsTrigger value="fare-engine" className="flex items-center gap-2">
            <Calculator className="h-4 w-4" />
            Fare Engine
            <Badge variant="default" className="ml-1 text-[10px] px-1.5 py-0">PRIMARY</Badge>
          </TabsTrigger>
          <TabsTrigger value="vehicle-types" className="flex items-center gap-2">
            <Car className="h-4 w-4" />
            Vehicle Types
            {assignedCount > 0 && (
              <Badge variant="secondary" className="ml-1 text-[10px] px-1.5 py-0">{assignedCount}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="fees" className="flex items-center gap-2">
            <Banknote className="h-4 w-4" />
            Booking Fees
          </TabsTrigger>
          <TabsTrigger value="offers" className="flex items-center gap-2">
            <Banknote className="h-4 w-4" />
            Offers & Payment
          </TabsTrigger>
          <TabsTrigger value="assignments" className="flex items-center gap-2">
            <Users className="h-4 w-4" />
            Assignments
          </TabsTrigger>
        </TabsList>

        {/* Fare Engine Tab (PRIMARY) */}
        <TabsContent value="fare-engine">
          {selectedServiceAreaId && (
            <FareEngineConfig 
              serviceAreaId={selectedServiceAreaId}
              regionCurrencyCode={regionCurrency}
            />
          )}
        </TabsContent>

        {/* Vehicle Types Tab */}
        <TabsContent value="vehicle-types">
          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-lg font-semibold">Vehicle Types for this Service Area</h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    Select which vehicle types are available for riders to book in this service area. 
                    Pricing is controlled by the Fare Engine, not by vehicle type.
                  </p>
                </div>
                <Button 
                  onClick={saveVehicleTypeAssignments} 
                  disabled={vehicleTypesSaving}
                  size="sm"
                >
                  {vehicleTypesSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                  Save Assignments
                </Button>
              </div>

              {vehicleTypesLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-6 w-6 animate-spin text-primary" />
                </div>
              ) : (
                <div className="space-y-3">
                  {allVehicleTypes.map(vt => {
                    const assignment = assignedVehicleTypes[vt.id];
                    const isAssigned = assignment?.is_active ?? false;

                    return (
                      <div 
                        key={vt.id}
                        className={`flex items-center justify-between p-4 border rounded-lg transition-colors ${
                          isAssigned 
                            ? 'border-primary/30 bg-primary/5' 
                            : 'border-border bg-muted/30'
                        }`}
                      >
                        <div className="flex items-center gap-4">
                          <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                            isAssigned ? 'bg-primary/10' : 'bg-muted'
                          }`}>
                            <Car className={`h-5 w-5 ${isAssigned ? 'text-primary' : 'text-muted-foreground'}`} />
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <p className="font-medium">{vt.name}</p>
                              <Badge variant="outline" className="text-[10px]">{vt.slug}</Badge>
                              {!vt.is_active && (
                                <Badge variant="destructive" className="text-[10px]">Inactive</Badge>
                              )}
                            </div>
                            <div className="flex items-center gap-3 mt-1">
                              <span className="text-xs text-muted-foreground">
                                Capacity: {vt.capacity}
                              </span>
                              {vt.features && vt.features.length > 0 && (
                                <span className="text-xs text-muted-foreground">
                                  Features: {vt.features.join(', ')}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          {isAssigned ? (
                            <Badge variant="default" className="gap-1">
                              <CheckCircle2 className="h-3 w-3" />
                              Assigned
                            </Badge>
                          ) : (
                            <Badge variant="secondary" className="gap-1 text-muted-foreground">
                              <XCircle className="h-3 w-3" />
                              Not Assigned
                            </Badge>
                          )}
                          <Switch
                            checked={isAssigned}
                            onCheckedChange={() => toggleVehicleType(vt.id)}
                          />
                        </div>
                      </div>
                    );
                  })}

                  {allVehicleTypes.length === 0 && (
                    <div className="text-center py-8 text-muted-foreground">
                      <Car className="h-8 w-8 mx-auto mb-2 opacity-50" />
                      <p>No vehicle types configured yet.</p>
                      <p className="text-sm">Go to Vehicle Types to create some first.</p>
                    </div>
                  )}
                </div>
              )}

              <div className="mt-4 pt-4 border-t">
                <p className="text-xs text-muted-foreground">
                  <strong>Note:</strong> Only assigned and active vehicle types will appear in the Customer and Driver apps for this service area. 
                  Pricing for all vehicle types is determined by the Fare Engine settings above.
                </p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Booking Fees Tab */}
        <TabsContent value="fees" className="space-y-6">
          {/* Per Booking Fee */}
          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
                    <Banknote className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold">Per Booking Fee</h3>
                    <p className="text-sm text-muted-foreground">
                      Apply a fixed fee to each booking in this service area
                    </p>
                  </div>
                </div>
                <Switch
                  checked={selectedServiceArea?.per_booking_fee_enabled ?? false}
                  onCheckedChange={(checked) => updatePerBookingFee('per_booking_fee_enabled', checked)}
                />
              </div>
              
              {selectedServiceArea?.per_booking_fee_enabled && (
                <div className="mt-4 pt-4 border-t">
                  <div className="max-w-xs space-y-2">
                    <Label>Fee Amount ({getCurrencySymbol(regionCurrency)})</Label>
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      value={(selectedServiceArea?.per_booking_fee_pence ?? 0) / 100}
                      onChange={e => updatePerBookingFee('per_booking_fee_pence', Math.round((parseFloat(e.target.value) || 0) * 100))}
                    />
                    <p className="text-xs text-muted-foreground">
                      This fee is added to every trip in this service area
                    </p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Offers & Payment Tab */}
        <TabsContent value="offers" className="space-y-6">
          {selectedServiceAreaId && (
            <PresetOffersConfig
              serviceAreaId={selectedServiceAreaId}
              currencySymbol={getCurrencySymbol(regionCurrency)}
            />
          )}
          {selectedServiceAreaId && (
            <ServiceAreaPaymentConfig 
              serviceAreaId={selectedServiceAreaId} 
              serviceAreaName={selectedServiceArea?.name}
            />
          )}
        </TabsContent>

        {/* Assignments Tab */}
        <TabsContent value="assignments">
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
        </TabsContent>
      </Tabs>
    </AdminLayout>
  );
}
