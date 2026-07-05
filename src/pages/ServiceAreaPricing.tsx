import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';

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
  Phone,
  Globe,
  Calculator,
  Gift,
  Crown,
} from 'lucide-react';
import { toast } from 'sonner';
import { ServiceAreaPaymentConfig } from '@/components/payment/ServiceAreaPaymentConfig';
import { ServiceAreaPaymentGatewayConfig } from '@/components/payment/ServiceAreaPaymentGatewayConfig';
import { ServiceAreaMobileWalletMethodsConfig } from '@/components/payment/ServiceAreaMobileWalletMethodsConfig';
import { ServiceAreaDriverWalletConfig } from '@/components/finance/ServiceAreaDriverWalletConfig';
import { PreauthBufferConfig } from '@/components/payment/PreauthBufferConfig';
import { getCurrencySymbol } from '@/lib/regionSettings';
import { PresetOffersConfig } from '@/components/pricing/PresetOffersConfig';
import { FareEngineConfig } from '@/components/pricing/FareEngineConfig';
import { ServiceAreaTripsTab } from '@/components/payment/ServiceAreaTripsTab';
import { VehicleTypePricingRow } from '@/components/pricing/VehicleTypePricingRow';
import { ServiceAreaDriverTiersConfig } from '@/components/pricing/ServiceAreaDriverTiersConfig';
import { ServiceAreaCommunicationConfig } from '@/components/communication/ServiceAreaCommunicationConfig';

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
  tips_enabled: boolean;
  early_cashout_enabled: boolean;
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
  // Only used here to compute the "assigned" badge count; the row component owns its own state.
  const [allVehicleTypes, setAllVehicleTypes] = useState<VehicleType[]>([]);
  const [pricingAssignments, setPricingAssignments] = useState<Record<string, VehiclePricingAssignment>>({});
  const [vehicleTypesLoading, setVehicleTypesLoading] = useState(false);

  
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [customerPaymentGateway, setCustomerPaymentGateway] = useState<string | null>(null);

  const selectedServiceArea = serviceAreas.find(sa => sa.id === selectedServiceAreaId);
  // Region is the SINGLE SOURCE OF TRUTH for currency — never read from service_area
  const regionCurrency = selectedServiceArea?.region?.currency_code || '';

  useEffect(() => {
    fetchInitialData();
  }, []);

  useEffect(() => {
    if (selectedServiceAreaId) {
      fetchPricingData(selectedServiceAreaId);
      fetchPricingAssignments(selectedServiceAreaId);
    }
  }, [selectedServiceAreaId]);

  const fetchInitialData = async (isBackground = false) => {
    try {
      if (!isBackground) setIsLoading(true);
      const [areasRes, vtRes] = await Promise.all([
        supabase
          .from('service_areas')
          .select('id, name, region_id, is_active, tips_enabled, early_cashout_enabled, region:regions(name, currency_code, distance_unit)')
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

  // SSOT: Read vehicle assignments from service_area_vehicle_pricing
  const fetchPricingAssignments = async (serviceAreaId: string) => {
    try {
      setVehicleTypesLoading(true);
      const { data, error } = await supabase
        .from('service_area_vehicle_pricing')
        .select('id, vehicle_type_id, is_enabled')
        .eq('service_area_id', serviceAreaId);

      if (error) throw error;

      const map: Record<string, VehiclePricingAssignment> = {};
      (data || []).forEach((row: any) => {
        map[row.vehicle_type_id] = {
          id: row.id,
          vehicle_type_id: row.vehicle_type_id,
          is_enabled: row.is_enabled,
        };
      });
      setPricingAssignments(map);
    } catch (err) {
      console.error('Error fetching pricing assignments:', err);
    } finally {
      setVehicleTypesLoading(false);
    }
  };

  // Per-vehicle toggle + pricing is owned by <VehicleTypePricingRow />.


  const updateTipsEnabled = (enabled: boolean) => {
    setServiceAreas(prev => prev.map(sa =>
      sa.id === selectedServiceAreaId
        ? { ...sa, tips_enabled: enabled }
        : sa
    ));
    setHasChanges(true);
  };

  const updateEarlyCashoutEnabled = (enabled: boolean) => {
    setServiceAreas(prev => prev.map(sa =>
      sa.id === selectedServiceAreaId
        ? { ...sa, early_cashout_enabled: enabled }
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
            tips_enabled: selectedServiceArea.tips_enabled,
            early_cashout_enabled: selectedServiceArea.early_cashout_enabled ?? false,
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

  const assignedCount = Object.values(pricingAssignments).filter(a => a.is_enabled).length;

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
          <TabsTrigger value="driver-tiers" className="flex items-center gap-2">
            <Crown className="h-4 w-4" />
            Driver Tiers
          </TabsTrigger>
          <TabsTrigger value="offers" className="flex items-center gap-2">
            <Banknote className="h-4 w-4" />
            Offers & Payment
          </TabsTrigger>
          <TabsTrigger value="communication" className="flex items-center gap-2">
            <Phone className="h-4 w-4" />
            Communication (SSOT)
          </TabsTrigger>
          <TabsTrigger value="trips" className="flex items-center gap-2">
            <Banknote className="h-4 w-4" />
            Trips & Payments
          </TabsTrigger>
        </TabsList>

        {/* Fare Engine Tab (PRIMARY) */}
        <TabsContent value="fare-engine">
          {selectedServiceAreaId && (
            <FareEngineConfig 
              serviceAreaId={selectedServiceAreaId}
              regionCurrencyCode={regionCurrency}
              regionDistanceUnit={selectedServiceArea?.region?.distance_unit}
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
                    Toggle vehicle types on/off for this service area. All pricing — base fare,
                    per-distance rates, distance bands, minimum fare, airport charge and driver offer
                    chips — is configured exclusively in the <strong>Fare Engine</strong> tab.
                  </p>
                </div>
              </div>

              {vehicleTypesLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-6 w-6 animate-spin text-primary" />
                </div>
              ) : (
                <div className="space-y-3">
                  {allVehicleTypes.map(vt => (
                    <VehicleTypePricingRow
                      key={vt.id}
                      serviceAreaId={selectedServiceAreaId}
                      vehicleType={vt}
                      currencyCode={regionCurrency}
                      onChanged={() => fetchPricingAssignments(selectedServiceAreaId)}
                    />
                  ))}

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
                  All fare calculations are powered by the Fare Engine.
                </p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Driver Tiers Tab */}
        <TabsContent value="driver-tiers" className="space-y-6">
          {selectedServiceAreaId && (
            <ServiceAreaDriverTiersConfig
              serviceAreaId={selectedServiceAreaId}
              serviceAreaName={selectedServiceArea?.name}
            />
          )}
        </TabsContent>

        {/* Offers & Payment Tab */}
        <TabsContent value="offers" className="space-y-6">
          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
                    <Gift className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold">Passenger tips</h3>
                    <p className="text-sm text-muted-foreground">
                      When enabled, card trips show a tip step after completion and defer fare capture for the 2-minute tip window.
                      When disabled, passengers rate only and fare captures immediately at trip end.
                    </p>
                  </div>
                </div>
                <Switch
                  checked={selectedServiceArea?.tips_enabled ?? false}
                  onCheckedChange={updateTipsEnabled}
                />
              </div>
            </CardContent>
          </Card>
          {selectedServiceAreaId && (
            <PresetOffersConfig
              serviceAreaId={selectedServiceAreaId}
              currencySymbol={getCurrencySymbol(regionCurrency)}
            />
          )}
          {selectedServiceAreaId && (
            <ServiceAreaDriverWalletConfig
              enabled={selectedServiceArea?.early_cashout_enabled ?? false}
              onChange={updateEarlyCashoutEnabled}
              serviceAreaName={selectedServiceArea?.name}
              disabled={isSaving}
            />
          )}
          {selectedServiceAreaId && (
            <ServiceAreaPaymentGatewayConfig
              serviceAreaId={selectedServiceAreaId}
              serviceAreaName={selectedServiceArea?.name}
              onCustomerGatewayChange={setCustomerPaymentGateway}
            />
          )}
          {selectedServiceAreaId && (
            <ServiceAreaPaymentConfig
              serviceAreaId={selectedServiceAreaId}
              serviceAreaName={selectedServiceArea?.name}
            />
          )}
          {selectedServiceAreaId && (
            <ServiceAreaMobileWalletMethodsConfig
              serviceAreaId={selectedServiceAreaId}
              serviceAreaName={selectedServiceArea?.name}
              customerPaymentGateway={customerPaymentGateway}
            />
          )}
          {selectedServiceAreaId && regionCurrency && (
            <PreauthBufferConfig
              serviceAreaId={selectedServiceAreaId}
              serviceAreaName={selectedServiceArea?.name}
              regionCurrencyCode={regionCurrency}
            />
          )}
        </TabsContent>

        <TabsContent value="communication">
          {selectedServiceAreaId && (
            <ServiceAreaCommunicationConfig
              serviceAreaId={selectedServiceAreaId}
              serviceAreaName={selectedServiceArea?.name}
              currencyCode={regionCurrency}
            />
          )}
        </TabsContent>

        <TabsContent value="trips">
          {selectedServiceAreaId && (
            <ServiceAreaTripsTab serviceAreaId={selectedServiceAreaId} currencyCode={regionCurrency} />
          )}
        </TabsContent>
      </Tabs>
    </AdminLayout>
  );
}
