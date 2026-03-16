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
  Ban,
  Banknote,
  AlertCircle,
  Users,
  FileText,
  Globe,
  Calculator,
  Info,
  ShieldAlert
} from 'lucide-react';
import { toast } from 'sonner';
import { ServiceAreaPaymentConfig } from '@/components/payment/ServiceAreaPaymentConfig';
import { getCurrencySymbol } from '@/lib/regionSettings';
import { PresetOffersConfig } from '@/components/pricing/PresetOffersConfig';
import { FareEngineConfig } from '@/components/pricing/FareEngineConfig';

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

interface CancellationFees {
  free_cancellation_window_minutes: number;
  cancellation_fee: number;
  no_show_fee: number;
  currency_code: string;
}

export default function ServiceAreaPricing() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const serviceAreaIdFromParams = searchParams.get('id');

  const [serviceAreas, setServiceAreas] = useState<ServiceArea[]>([]);
  const [selectedServiceAreaId, setSelectedServiceAreaId] = useState<string>(serviceAreaIdFromParams || '');
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
  const regionCurrency = selectedServiceArea?.region?.currency_code || 'GBP';

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
      const { data, error } = await supabase
        .from('service_areas')
        .select('id, name, region_id, is_active, per_booking_fee_enabled, per_booking_fee_pence, region:regions(name, currency_code, distance_unit)')
        .order('name');

      if (error) throw error;

      setServiceAreas(data || []);

      if (serviceAreaIdFromParams && data?.some(sa => sa.id === serviceAreaIdFromParams)) {
        setSelectedServiceAreaId(serviceAreaIdFromParams);
      } else if (data && data.length > 0) {
        setSelectedServiceAreaId(data[0].id);
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
      const { data: feesData } = await supabase
        .from('service_area_cancellation_fees')
        .select('*')
        .eq('service_area_id', serviceAreaId)
        .single();

      if (feesData) {
        setCancellationFees({
          free_cancellation_window_minutes: feesData.free_cancellation_window_minutes,
          cancellation_fee: Number(feesData.cancellation_fee),
          no_show_fee: Number(feesData.no_show_fee),
          currency_code: feesData.currency_code,
        });
      } else {
        const serviceArea = serviceAreas.find(sa => sa.id === serviceAreaId);
        const defaultCurrency = serviceArea?.region?.currency_code || 'GBP';
        setCancellationFees({
          free_cancellation_window_minutes: 5,
          cancellation_fee: 5,
          no_show_fee: 10,
          currency_code: defaultCurrency,
        });
      }
      
      setHasChanges(false);
    } catch (err) {
      console.error('Error fetching pricing:', err);
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
          <TabsTrigger value="fees" className="flex items-center gap-2">
            <Ban className="h-4 w-4" />
            Fees & Charges
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

        {/* Fees & Charges Tab */}
        <TabsContent value="fees" className="space-y-6">
          {/* Cancellation & No-Show Fees */}
          <Card>
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
                  <Label>Cancellation Fee ({getCurrencySymbol(regionCurrency)})</Label>
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
                  <Label>No-Show Fee ({getCurrencySymbol(regionCurrency)})</Label>
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
          {/* Preset Fare Offers */}
          {selectedServiceAreaId && (
            <PresetOffersConfig
              serviceAreaId={selectedServiceAreaId}
              currencySymbol={getCurrencySymbol(regionCurrency)}
            />
          )}

          {/* Payment Methods */}
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
