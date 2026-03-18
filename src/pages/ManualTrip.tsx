import { useState, useEffect, useCallback } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
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
  PlusCircle, Loader2, MapPin, User, Phone, Clock, Car,
  DollarSign, FileText, Calendar, CheckCircle2, AlertCircle,
  CreditCard, Banknote, Wallet, Smartphone, Globe, Navigation, Building2
} from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { getCurrencySymbol, getDistanceUnitShort, formatDistance } from '@/lib/regionSettings';
import { PlacesAutocomplete } from '@/components/places/PlacesAutocomplete';
import { useGeoLocation } from '@/hooks/useGeoLocation';
import { ALL_PAYMENT_METHODS, PaymentMethodType } from '@/hooks/useServiceAreaPaymentMethods';

interface Driver {
  id: string;
  first_name: string;
  last_name: string;
  phone: string;
  is_online: boolean;
  rating: number | null;
}

interface VehicleType {
  id: string;
  name: string;
  capacity: number;
  icon: string | null;
}

interface Customer {
  id: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  user_id: string;
}

interface ServiceArea {
  id: string;
  name: string;
  country: string | null;
  center_lat: number | null;
  center_lng: number | null;
  region_id: string;
  region?: {
    distance_unit: string | null;
    currency_code: string | null;
  };
}

interface CorporateAccount {
  id: string;
  company_name: string;
  status: string;
}

interface ServiceAreaPaymentConfig {
  cash_enabled: boolean;
  card_enabled: boolean;
  wallet_enabled: boolean;
  apple_pay_enabled: boolean;
  google_pay_enabled: boolean;
}

interface PlaceResult {
  address: string;
  lat: number;
  lng: number;
  placeId: string;
}

const PAYMENT_ICONS: Record<string, React.ReactNode> = {
  cash: <Banknote className="h-4 w-4" />,
  card: <CreditCard className="h-4 w-4" />,
  wallet: <Wallet className="h-4 w-4" />,
  apple_pay: <Smartphone className="h-4 w-4" />,
  google_pay: <Smartphone className="h-4 w-4" />,
};

export default function ManualTrip() {
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [vehicleTypes, setVehicleTypes] = useState<VehicleType[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [serviceAreas, setServiceAreas] = useState<ServiceArea[]>([]);
  const [corporateAccounts, setCorporateAccounts] = useState<CorporateAccount[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);

  // Service area settings
  const [selectedServiceAreaId, setSelectedServiceAreaId] = useState('');
  const [paymentConfig, setPaymentConfig] = useState<ServiceAreaPaymentConfig | null>(null);
  const [currencyCode, setCurrencyCode] = useState('GBP');
  const [distanceUnit, setDistanceUnit] = useState<'mile' | 'km'>('mile');
  const [serviceAreaCenter, setServiceAreaCenter] = useState<{ lat: number; lng: number } | null>(null);
  const [serviceAreaCountryCode, setServiceAreaCountryCode] = useState<string | null>(null);

  // User location
  const { location: userLocation, isLoading: isLocationLoading } = useGeoLocation({ watchPosition: false });

  // Form state
  const [passengerName, setPassengerName] = useState('');
  const [passengerPhone, setPassengerPhone] = useState('');
  const [passengerEmail, setPassengerEmail] = useState('');
  const [selectedCustomerId, setSelectedCustomerId] = useState('');
  const [pickupAddress, setPickupAddress] = useState('');
  const [pickupCoords, setPickupCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [dropoffAddress, setDropoffAddress] = useState('');
  const [dropoffCoords, setDropoffCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [selectedDriverId, setSelectedDriverId] = useState('');
  const [selectedVehicleTypeId, setSelectedVehicleTypeId] = useState('');
  const [estimatedFare, setEstimatedFare] = useState('');
  const [estimatedDistance, setEstimatedDistance] = useState<number | null>(null);
  const [estimatedDuration, setEstimatedDuration] = useState<number | null>(null);
  const [specialInstructions, setSpecialInstructions] = useState('');
  const [passengerCount, setPassengerCount] = useState('1');
  const [luggageCount, setLuggageCount] = useState('0');
  const [isScheduled, setIsScheduled] = useState(false);
  const [scheduledDate, setScheduledDate] = useState('');
  const [scheduledTime, setScheduledTime] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethodType>('cash');
  const [jobType, setJobType] = useState('ride');
  const [selectedCorporateAccountId, setSelectedCorporateAccountId] = useState('');
  const [isCorporateTrip, setIsCorporateTrip] = useState(false);

  // Fetch initial data
  useEffect(() => {
    async function fetchData() {
      try {
        const [driversRes, vehicleTypesRes, customersRes, serviceAreasRes, corporateRes] = await Promise.all([
          supabase
            .from('drivers')
            .select('id, first_name, last_name, phone, is_online, rating')
            .eq('approval_status', 'approved')
            .order('first_name'),
          supabase
            .from('vehicle_types')
            .select('id, name, capacity, icon')
            .eq('is_active', true)
            .order('display_order'),
          supabase
            .from('customers')
            .select('id, first_name, last_name, phone, user_id')
            .order('first_name')
            .limit(100),
          supabase
            .from('service_areas')
            .select('id, name, country, center_lat, center_lng, region_id, region:regions(distance_unit, currency_code)')
            .eq('is_active', true)
            .order('name'),
          supabase
            .from('corporate_accounts')
            .select('id, company_name, status')
            .eq('status', 'active')
            .order('company_name'),
        ]);

        if (driversRes.error) throw driversRes.error;
        if (vehicleTypesRes.error) throw vehicleTypesRes.error;
        if (serviceAreasRes.error) throw serviceAreasRes.error;
        if (corporateRes.error) throw corporateRes.error;

        setDrivers(driversRes.data || []);
        setCorporateAccounts(corporateRes.data || []);
        setVehicleTypes(vehicleTypesRes.data || []);
        setCustomers(customersRes.data || []);
        setServiceAreas(serviceAreasRes.data || []);

        // Auto-select first service area if available
        if (serviceAreasRes.data && serviceAreasRes.data.length > 0) {
          setSelectedServiceAreaId(serviceAreasRes.data[0].id);
        }
      } catch (err) {
        console.error('Error fetching data:', err);
        toast.error('Failed to load data');
      } finally {
        setIsLoading(false);
      }
    }

    fetchData();
  }, []);

  // Load service area settings when selection changes
  useEffect(() => {
    if (!selectedServiceAreaId) {
      setPaymentConfig(null);
      setCurrencyCode('GBP');
      setDistanceUnit('mile');
      setServiceAreaCenter(null);
      setServiceAreaCountryCode(null);
      return;
    }

    const serviceArea = serviceAreas.find(sa => sa.id === selectedServiceAreaId);
    if (serviceArea) {
      // Get currency from service area or fall back to region
      const currency = serviceArea.currency_code || serviceArea.region?.currency_code || 'GBP';
      setCurrencyCode(currency);
      
      // Get distance unit from parent region (regions own this setting)
      const regionUnit = serviceArea.region?.distance_unit;
      setDistanceUnit((regionUnit as 'mile' | 'km') || 'mile');
      
      if (serviceArea.center_lat && serviceArea.center_lng) {
        setServiceAreaCenter({ lat: serviceArea.center_lat, lng: serviceArea.center_lng });
      } else {
        setServiceAreaCenter(null);
      }
      
      setServiceAreaCountryCode(serviceArea.country || null);
    }

    // Fetch payment methods for this service area
    const fetchPaymentConfig = async () => {
      try {
        const { data, error } = await supabase
          .from('service_area_payment_methods')
          .select('*')
          .eq('service_area_id', selectedServiceAreaId)
          .single();

        if (error && error.code !== 'PGRST116') {
          throw error;
        }

        if (data) {
          setPaymentConfig({
            cash_enabled: data.cash_enabled,
            card_enabled: data.card_enabled,
            wallet_enabled: data.wallet_enabled,
            apple_pay_enabled: data.apple_pay_enabled,
            google_pay_enabled: data.google_pay_enabled,
          });
          
          // Reset payment method if current selection is not available
          const methodKey = `${paymentMethod}_enabled` as keyof typeof data;
          if (!data[methodKey]) {
            // Find first enabled method
            if (data.cash_enabled) setPaymentMethod('cash');
            else if (data.card_enabled) setPaymentMethod('card');
            else if (data.wallet_enabled) setPaymentMethod('wallet');
          }
        } else {
          // Default config if none exists
          setPaymentConfig({
            cash_enabled: true,
            card_enabled: true,
            wallet_enabled: false,
            apple_pay_enabled: false,
            google_pay_enabled: false,
          });
        }
      } catch (err) {
        console.error('Error fetching payment config:', err);
      }
    };

    fetchPaymentConfig();
  }, [selectedServiceAreaId, serviceAreas]);

  // Calculate route when both addresses are set
  useEffect(() => {
    if (!pickupCoords || !dropoffCoords) {
      setEstimatedDistance(null);
      setEstimatedDuration(null);
      return;
    }

    // Calculate straight-line distance as fallback
    const R = 6371; // Earth's radius in km
    const dLat = (dropoffCoords.lat - pickupCoords.lat) * Math.PI / 180;
    const dLng = (dropoffCoords.lng - pickupCoords.lng) * Math.PI / 180;
    const a = 
      Math.sin(dLat/2) * Math.sin(dLat/2) +
      Math.cos(pickupCoords.lat * Math.PI / 180) * Math.cos(dropoffCoords.lat * Math.PI / 180) *
      Math.sin(dLng/2) * Math.sin(dLng/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    const distanceKm = R * c;
    
    // Approximate road distance (typically 1.3x straight line)
    const roadDistanceKm = distanceKm * 1.3;
    // Approximate duration (assume 30 km/h average)
    const durationMinutes = Math.round((roadDistanceKm / 30) * 60);
    
    setEstimatedDistance(roadDistanceKm);
    setEstimatedDuration(durationMinutes);
  }, [pickupCoords, dropoffCoords]);

  const handleCustomerSelect = (customerId: string) => {
    setSelectedCustomerId(customerId);
    if (customerId && customerId !== 'new') {
      const customer = customers.find(c => c.id === customerId);
      if (customer) {
        setPassengerName(`${customer.first_name || ''} ${customer.last_name || ''}`.trim());
        setPassengerPhone(customer.phone || '');
      }
    } else {
      setPassengerName('');
      setPassengerPhone('');
    }
  };

  const handlePickupSelect = (place: PlaceResult) => {
    setPickupAddress(place.address);
    setPickupCoords({ lat: place.lat, lng: place.lng });
  };

  const handleDropoffSelect = (place: PlaceResult) => {
    setDropoffAddress(place.address);
    setDropoffCoords({ lat: place.lat, lng: place.lng });
  };

  // Resolve service area from pickup coordinates
  const resolvePickupServiceArea = useCallback(async (lat: number, lng: number): Promise<string | null> => {
    try {
      const { data, error } = await supabase.functions.invoke('resolve-service-area', {
        body: { pickup_lat: lat, pickup_lng: lng }
      });
      if (error || !data?.success) return null;
      return data.settings?.service_area_id || null;
    } catch {
      return null;
    }
  }, []);

  const resetForm = () => {
    setPassengerName('');
    setPassengerPhone('');
    setPassengerEmail('');
    setSelectedCustomerId('');
    setPickupAddress('');
    setPickupCoords(null);
    setDropoffAddress('');
    setDropoffCoords(null);
    setSelectedDriverId('');
    setSelectedVehicleTypeId('');
    setEstimatedFare('');
    setEstimatedDistance(null);
    setEstimatedDuration(null);
    setSpecialInstructions('');
    setPassengerCount('1');
    setLuggageCount('0');
    setIsScheduled(false);
    setScheduledDate('');
    setScheduledTime('');
    setPaymentMethod('cash');
    setJobType('ride');
    setIsCorporateTrip(false);
    setSelectedCorporateAccountId('');
    setIsSuccess(false);
  };

  const getEnabledPaymentMethods = useCallback(() => {
    if (!paymentConfig) {
      return ALL_PAYMENT_METHODS.filter(m => m.id === 'cash' || m.id === 'card');
    }
    
    return ALL_PAYMENT_METHODS.filter(method => {
      const key = `${method.id}_enabled` as keyof ServiceAreaPaymentConfig;
      return paymentConfig[key];
    });
  }, [paymentConfig]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Validation
    if (!passengerName.trim()) {
      toast.error('Please enter passenger name');
      return;
    }
    if (!pickupAddress.trim()) {
      toast.error('Please enter pickup address');
      return;
    }
    if (!dropoffAddress.trim()) {
      toast.error('Please enter dropoff address');
      return;
    }
    if (!selectedServiceAreaId) {
      toast.error('Please select a service area');
      return;
    }

    // For scheduled trips, validate date/time
    if (isScheduled && (!scheduledDate || !scheduledTime)) {
      toast.error('Please select scheduled date and time');
      return;
    }

    // For corporate trips, require account selection
    if (isCorporateTrip && !selectedCorporateAccountId) {
      toast.error('Please select a corporate account');
      return;
    }

    setIsSubmitting(true);

    try {
      // 1. Find or reuse existing customer
      let passengerId = '';
      if (selectedCustomerId && selectedCustomerId !== 'new') {
        const customer = customers.find(c => c.id === selectedCustomerId);
        if (customer) {
          passengerId = customer.user_id;
        }
      }

      // If no customer selected, use the current admin user's ID
      if (!passengerId) {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) {
          toast.error('You must be logged in to create trips');
          return;
        }
        passengerId = user.id;
      }

      // Use find_or_create_customer RPC to prevent duplicates
      const { data: customerId, error: custError } = await supabase.rpc('find_or_create_customer', {
        p_user_id: passengerId,
        p_phone: passengerPhone.trim() || null,
        p_first_name: passengerName.split(' ')[0] || null,
        p_last_name: passengerName.split(' ').slice(1).join(' ') || null,
      });

      if (custError) {
        console.error('Customer lookup error:', custError);
        // Non-fatal: continue with passengerId
      }

      // 2. Resolve pickup service area from coordinates (enforces polygon match)
      let resolvedServiceAreaId = selectedServiceAreaId;
      if (pickupCoords) {
        const saId = await resolvePickupServiceArea(pickupCoords.lat, pickupCoords.lng);
        if (saId) {
          resolvedServiceAreaId = saId;
        } else if (!selectedServiceAreaId) {
          toast.error('Pickup location is not inside any active service area. Please adjust the pickup location.');
          setIsSubmitting(false);
          return;
        }
      }

      // 3. Create trip — trip_number assigned via DB trigger (assign_trip_number)
      const tripData = {
        passenger_id: passengerId,
        passenger_name: passengerName.trim(),
        passenger_phone: passengerPhone.trim() || null,
        pickup_address: pickupAddress.trim(),
        pickup_latitude: pickupCoords?.lat || null,
        pickup_longitude: pickupCoords?.lng || null,
        dropoff_address: dropoffAddress.trim(),
        dropoff_latitude: dropoffCoords?.lat || null,
        dropoff_longitude: dropoffCoords?.lng || null,
        driver_id: selectedDriverId || null,
        vehicle_type_id: selectedVehicleTypeId || null,
        estimated_fare: parseFloat(estimatedFare) || 0,
        estimated_distance_km: estimatedDistance || null,
        estimated_duration_minutes: estimatedDuration || null,
        special_instructions: specialInstructions.trim() 
          ? `[Manual Booking] ${specialInstructions.trim()}`
          : '[Manual Booking]',
        is_scheduled: isScheduled,
        scheduled_at: isScheduled && scheduledDate && scheduledTime 
          ? new Date(`${scheduledDate}T${scheduledTime}`).toISOString()
          : null,
        payment_method: paymentMethod,
        payment_type: paymentMethod,
        job_type: jobType,
        trip_type: isScheduled ? 'scheduled' : 'immediate',
        status: selectedDriverId ? 'accepted' : (isScheduled ? 'pending' : 'searching'),
        currency_code: currencyCode,
        service_area_id: resolvedServiceAreaId,
        booking_source: isCorporateTrip ? 'corporate' : 'admin_manual',
        corporate_account_id: isCorporateTrip && selectedCorporateAccountId ? selectedCorporateAccountId : null,
      };

      const { error } = await supabase
        .from('trips')
        .insert([tripData]);

      if (error) throw error;

      setIsSuccess(true);
      toast.success('Trip created successfully!');
    } catch (err: any) {
      console.error('Error creating trip:', err);
      toast.error(err.message || 'Failed to create trip');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isLoading) {
    return (
      <AdminLayout title="Manual Trip Creation" description="Create a new trip manually">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </AdminLayout>
    );
  }

  if (isSuccess) {
    return (
      <AdminLayout title="Manual Trip Creation" description="Create a new trip manually">
        <Card className="max-w-2xl mx-auto">
          <CardContent className="pt-12 pb-8 text-center">
            <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-green-100">
              <CheckCircle2 className="h-10 w-10 text-green-600" />
            </div>
            <h2 className="text-2xl font-bold mb-2">Trip Created Successfully!</h2>
            <p className="text-muted-foreground mb-6">
              The trip has been created and {selectedDriverId ? 'assigned to the driver' : 'is now searching for drivers'}.
            </p>
            <div className="flex gap-4 justify-center">
              <Button variant="outline" onClick={resetForm}>
                <PlusCircle className="h-4 w-4 mr-2" />
                Create Another Trip
              </Button>
              <Button onClick={() => window.location.href = '/active-trips'}>
                View Active Trips
              </Button>
            </div>
          </CardContent>
        </Card>
      </AdminLayout>
    );
  }

  const enabledPaymentMethods = getEnabledPaymentMethods();
  const selectedServiceArea = serviceAreas.find(sa => sa.id === selectedServiceAreaId);

  return (
    <AdminLayout 
      title="Manual Trip Creation" 
      description="Create a new trip manually for a customer"
    >
      <form onSubmit={handleSubmit}>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Main Form */}
          <div className="lg:col-span-2 space-y-6">
            {/* Service Area Selection */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Globe className="h-5 w-5 text-primary" />
                  Service Area
                </CardTitle>
                <CardDescription>
                  Select the service area for this trip
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Select value={selectedServiceAreaId} onValueChange={setSelectedServiceAreaId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a service area..." />
                  </SelectTrigger>
                  <SelectContent>
                    {serviceAreas.map(area => (
                      <SelectItem key={area.id} value={area.id}>
                        <div className="flex items-center gap-2">
                          <span>{area.name}</span>
                          {area.country && (
                            <Badge variant="outline" className="text-xs">
                              {area.country}
                            </Badge>
                          )}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedServiceArea && (
                  <div className="mt-3 flex items-center gap-4 text-sm text-muted-foreground">
                    <span>Currency: <strong>{getCurrencySymbol(currencyCode)}</strong> ({currencyCode})</span>
                    <span>Units: <strong>{getDistanceUnitShort(distanceUnit)}</strong></span>
                    {userLocation && (
                      <span className="flex items-center gap-1 text-green-600">
                        <Navigation className="h-3 w-3" />
                        GPS active
                      </span>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Corporate Booking */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Building2 className="h-5 w-5 text-primary" />
                  Corporate Booking
                </CardTitle>
                <CardDescription>
                  Link this trip to a corporate account for billing
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="isCorporateTrip"
                    checked={isCorporateTrip}
                    onCheckedChange={(checked) => {
                      setIsCorporateTrip(checked === true);
                      if (!checked) setSelectedCorporateAccountId('');
                    }}
                  />
                  <Label htmlFor="isCorporateTrip" className="cursor-pointer">
                    This is a corporate trip
                  </Label>
                </div>
                
                {isCorporateTrip && (
                  <div>
                    <Label>Corporate Account *</Label>
                    <Select 
                      value={selectedCorporateAccountId} 
                      onValueChange={setSelectedCorporateAccountId}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select corporate account..." />
                      </SelectTrigger>
                      <SelectContent>
                        {corporateAccounts.map(account => (
                          <SelectItem key={account.id} value={account.id}>
                            <div className="flex items-center gap-2">
                              <Building2 className="h-4 w-4 text-muted-foreground" />
                              {account.company_name}
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {corporateAccounts.length === 0 && (
                      <p className="text-sm text-muted-foreground mt-2">
                        No active corporate accounts found. Create one in Corporate Accounts.
                      </p>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Passenger Information */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <User className="h-5 w-5 text-primary" />
                  Passenger Information
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Label>Select Existing Customer (Optional)</Label>
                  <Select value={selectedCustomerId} onValueChange={handleCustomerSelect}>
                    <SelectTrigger>
                      <SelectValue placeholder="Choose a customer or enter new..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="new">+ New Customer</SelectItem>
                      {customers.map(customer => (
                        <SelectItem key={customer.id} value={customer.id}>
                          {customer.first_name} {customer.last_name} - {customer.phone}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="passengerName">Passenger Name *</Label>
                    <Input
                      id="passengerName"
                      value={passengerName}
                      onChange={(e) => setPassengerName(e.target.value)}
                      placeholder="Enter passenger name"
                      required
                    />
                  </div>
                  <div>
                    <Label htmlFor="passengerPhone">Phone Number</Label>
                    <Input
                      id="passengerPhone"
                      value={passengerPhone}
                      onChange={(e) => setPassengerPhone(e.target.value)}
                      placeholder="+44 7XXX XXX XXX"
                    />
                  </div>
                </div>
                <div>
                  <Label htmlFor="passengerEmail">Email (Optional)</Label>
                  <Input
                    id="passengerEmail"
                    type="email"
                    value={passengerEmail}
                    onChange={(e) => setPassengerEmail(e.target.value)}
                    placeholder="passenger@email.com"
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="passengerCount">Passengers</Label>
                    <Select value={passengerCount} onValueChange={setPassengerCount}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {[1, 2, 3, 4, 5, 6, 7, 8].map(n => (
                          <SelectItem key={n} value={n.toString()}>{n}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label htmlFor="luggageCount">Luggage</Label>
                    <Select value={luggageCount} onValueChange={setLuggageCount}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {[0, 1, 2, 3, 4, 5, 6].map(n => (
                          <SelectItem key={n} value={n.toString()}>{n} bags</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Trip Details */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <MapPin className="h-5 w-5 text-primary" />
                  Trip Details
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Label htmlFor="pickupAddress">Pickup Address *</Label>
                  <PlacesAutocomplete
                    value={pickupAddress}
                    onChange={setPickupAddress}
                    onPlaceSelect={handlePickupSelect}
                    placeholder="Enter pickup location"
                    icon="pickup"
                    userLocation={userLocation}
                    serviceAreaCenter={serviceAreaCenter}
                    serviceAreaCountryCode={serviceAreaCountryCode}
                    radiusBiasMeters={30000}
                  />
                </div>
                <div>
                  <Label htmlFor="dropoffAddress">Dropoff Address *</Label>
                  <PlacesAutocomplete
                    value={dropoffAddress}
                    onChange={setDropoffAddress}
                    onPlaceSelect={handleDropoffSelect}
                    placeholder="Enter destination"
                    icon="dropoff"
                    userLocation={userLocation}
                    serviceAreaCenter={serviceAreaCenter}
                    serviceAreaCountryCode={serviceAreaCountryCode}
                    radiusBiasMeters={50000}
                  />
                </div>

                {/* Route Estimate */}
                {estimatedDistance && estimatedDuration && (
                  <div className="p-3 bg-muted/50 rounded-lg flex items-center gap-4">
                    <div className="flex items-center gap-2">
                      <MapPin className="h-4 w-4 text-muted-foreground" />
                      <span className="text-sm font-medium">
                        {formatDistance(estimatedDistance, distanceUnit)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Clock className="h-4 w-4 text-muted-foreground" />
                      <span className="text-sm font-medium">~{estimatedDuration} min</span>
                    </div>
                  </div>
                )}

                <Separator />

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="vehicleType">Vehicle Type</Label>
                    <Select value={selectedVehicleTypeId || 'any'} onValueChange={(val) => setSelectedVehicleTypeId(val === 'any' ? '' : val)}>
                      <SelectTrigger>
                        <SelectValue placeholder="Any available" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="any">Any Available</SelectItem>
                        {vehicleTypes.map(type => (
                          <SelectItem key={type.id} value={type.id}>
                            {type.name} (up to {type.capacity} passengers)
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label htmlFor="jobType">Job Type</Label>
                    <Select value={jobType} onValueChange={setJobType}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="ride">Ride</SelectItem>
                        <SelectItem value="delivery">Delivery</SelectItem>
                        <SelectItem value="parcel">Parcel</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {/* Payment Method */}
                <div>
                  <Label>Payment Method</Label>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-2">
                    {enabledPaymentMethods.map(method => (
                      <Button
                        key={method.id}
                        type="button"
                        variant={paymentMethod === method.id ? 'default' : 'outline'}
                        className="justify-start gap-2"
                        onClick={() => setPaymentMethod(method.id)}
                      >
                        {PAYMENT_ICONS[method.id]}
                        {method.name}
                      </Button>
                    ))}
                  </div>
                  {enabledPaymentMethods.length === 0 && (
                    <p className="text-sm text-muted-foreground mt-2">
                      No payment methods configured for this service area
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Scheduling */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Calendar className="h-5 w-5 text-primary" />
                  Scheduling
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="isScheduled"
                    checked={isScheduled}
                    onCheckedChange={(checked) => setIsScheduled(checked === true)}
                  />
                  <Label htmlFor="isScheduled" className="cursor-pointer">
                    Schedule for later
                  </Label>
                </div>
                {isScheduled && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
                    <div>
                      <Label htmlFor="scheduledDate">Date</Label>
                      <Input
                        id="scheduledDate"
                        type="date"
                        value={scheduledDate}
                        onChange={(e) => setScheduledDate(e.target.value)}
                        min={format(new Date(), 'yyyy-MM-dd')}
                      />
                    </div>
                    <div>
                      <Label htmlFor="scheduledTime">Time</Label>
                      <Input
                        id="scheduledTime"
                        type="time"
                        value={scheduledTime}
                        onChange={(e) => setScheduledTime(e.target.value)}
                      />
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Special Instructions */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <FileText className="h-5 w-5 text-primary" />
                  Additional Information
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div>
                  <Label htmlFor="specialInstructions">Special Instructions</Label>
                  <Textarea
                    id="specialInstructions"
                    value={specialInstructions}
                    onChange={(e) => setSpecialInstructions(e.target.value)}
                    placeholder="Any special requirements or notes..."
                    rows={3}
                  />
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Sidebar */}
          <div className="space-y-6">
            {/* Assign Driver */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Car className="h-5 w-5 text-primary" />
                  Assign Driver
                </CardTitle>
                <CardDescription>
                  Optionally pre-assign a driver
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Select value={selectedDriverId || 'auto'} onValueChange={(val) => setSelectedDriverId(val === 'auto' ? '' : val)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Auto-dispatch (no driver)" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Auto-dispatch</SelectItem>
                    {drivers.map(driver => (
                      <SelectItem key={driver.id} value={driver.id}>
                        <div className="flex items-center gap-2">
                          <span>{driver.first_name} {driver.last_name}</span>
                          {driver.is_online && (
                            <Badge variant="outline" className="bg-green-100 text-green-700 text-xs">
                              Online
                            </Badge>
                          )}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {drivers.filter(d => d.is_online).length === 0 && (
                  <div className="mt-2 flex items-center gap-2 text-sm text-amber-600">
                    <AlertCircle className="h-4 w-4" />
                    No drivers currently online
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Fare */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <DollarSign className="h-5 w-5 text-primary" />
                  Fare Estimate
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div>
                  <Label htmlFor="estimatedFare">
                    Estimated Fare ({getCurrencySymbol(currencyCode)})
                  </Label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                      {getCurrencySymbol(currencyCode)}
                    </span>
                    <Input
                      id="estimatedFare"
                      type="number"
                      step="0.01"
                      min="0"
                      value={estimatedFare}
                      onChange={(e) => setEstimatedFare(e.target.value)}
                      placeholder="0.00"
                      className="pl-8"
                    />
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Summary */}
            {(pickupAddress || dropoffAddress) && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Trip Summary</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  {pickupAddress && (
                    <div className="flex items-start gap-2">
                      <MapPin className="h-4 w-4 text-green-500 mt-0.5 shrink-0" />
                      <span className="text-muted-foreground line-clamp-2">{pickupAddress}</span>
                    </div>
                  )}
                  {dropoffAddress && (
                    <div className="flex items-start gap-2">
                      <MapPin className="h-4 w-4 text-red-500 mt-0.5 shrink-0" />
                      <span className="text-muted-foreground line-clamp-2">{dropoffAddress}</span>
                    </div>
                  )}
                  {estimatedDistance && (
                    <div className="flex items-center justify-between pt-2 border-t">
                      <span className="text-muted-foreground">Distance:</span>
                      <span className="font-medium">{formatDistance(estimatedDistance, distanceUnit)}</span>
                    </div>
                  )}
                  {estimatedDuration && (
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Est. Duration:</span>
                      <span className="font-medium">{estimatedDuration} min</span>
                    </div>
                  )}
                  {estimatedFare && (
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Fare:</span>
                      <span className="font-medium text-primary">
                        {getCurrencySymbol(currencyCode)}{parseFloat(estimatedFare).toFixed(2)}
                      </span>
                    </div>
                  )}
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Payment:</span>
                    <Badge variant="outline" className="flex items-center gap-1">
                      {PAYMENT_ICONS[paymentMethod]}
                      {ALL_PAYMENT_METHODS.find(m => m.id === paymentMethod)?.name || paymentMethod}
                    </Badge>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Submit */}
            <Card className="border-primary/20 bg-primary/5">
              <CardContent className="pt-6">
                <Button 
                  type="submit" 
                  className="w-full" 
                  size="lg"
                  disabled={isSubmitting || !selectedServiceAreaId}
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                      Creating Trip...
                    </>
                  ) : (
                    <>
                      <PlusCircle className="h-4 w-4 mr-2" />
                      Create Trip
                    </>
                  )}
                </Button>
                <p className="text-xs text-muted-foreground text-center mt-3">
                  {isScheduled 
                    ? 'Trip will be created and scheduled for the selected time'
                    : selectedDriverId 
                      ? 'Trip will be assigned directly to the selected driver'
                      : 'Trip will be dispatched to available drivers'}
                </p>
              </CardContent>
            </Card>
          </div>
        </div>
      </form>
    </AdminLayout>
  );
}
