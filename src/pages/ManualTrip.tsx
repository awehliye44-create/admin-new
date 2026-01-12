import { useState, useEffect } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
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
  DollarSign, FileText, Calendar, CheckCircle2, AlertCircle
} from 'lucide-react';
import { format, addHours } from 'date-fns';
import { toast } from 'sonner';

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

export default function ManualTrip() {
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [vehicleTypes, setVehicleTypes] = useState<VehicleType[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);

  // Form state
  const [passengerName, setPassengerName] = useState('');
  const [passengerPhone, setPassengerPhone] = useState('');
  const [selectedCustomerId, setSelectedCustomerId] = useState('');
  const [pickupAddress, setPickupAddress] = useState('');
  const [dropoffAddress, setDropoffAddress] = useState('');
  const [selectedDriverId, setSelectedDriverId] = useState('');
  const [estimatedFare, setEstimatedFare] = useState('');
  const [specialInstructions, setSpecialInstructions] = useState('');
  const [isScheduled, setIsScheduled] = useState(false);
  const [scheduledDate, setScheduledDate] = useState('');
  const [scheduledTime, setScheduledTime] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [jobType, setJobType] = useState('ride');

  useEffect(() => {
    async function fetchData() {
      try {
        const [driversRes, vehicleTypesRes, customersRes] = await Promise.all([
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
        ]);

        if (driversRes.error) throw driversRes.error;
        if (vehicleTypesRes.error) throw vehicleTypesRes.error;

        setDrivers(driversRes.data || []);
        setVehicleTypes(vehicleTypesRes.data || []);
        setCustomers(customersRes.data || []);
      } catch (err) {
        console.error('Error fetching data:', err);
        toast.error('Failed to load data');
      } finally {
        setIsLoading(false);
      }
    }

    fetchData();
  }, []);

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

  const generateTripCode = () => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  };

  const resetForm = () => {
    setPassengerName('');
    setPassengerPhone('');
    setSelectedCustomerId('');
    setPickupAddress('');
    setDropoffAddress('');
    setSelectedDriverId('');
    setEstimatedFare('');
    setSpecialInstructions('');
    setIsScheduled(false);
    setScheduledDate('');
    setScheduledTime('');
    setPaymentMethod('cash');
    setJobType('ride');
    setIsSuccess(false);
  };

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

    // For scheduled trips, validate date/time
    if (isScheduled && (!scheduledDate || !scheduledTime)) {
      toast.error('Please select scheduled date and time');
      return;
    }

    setIsSubmitting(true);

    try {
      // Determine the passenger_id - use customer's user_id if selected, otherwise generate a placeholder
      let passengerId = '';
      if (selectedCustomerId && selectedCustomerId !== 'new') {
        const customer = customers.find(c => c.id === selectedCustomerId);
        if (customer) {
          passengerId = customer.user_id;
        }
      }

      // If no customer selected, we need a valid UUID for passenger_id
      // In a real scenario, you might want to create a guest customer or use an admin user
      if (!passengerId) {
        // Use the current admin user's ID as the passenger for manual bookings
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) {
          toast.error('You must be logged in to create trips');
          return;
        }
        passengerId = user.id;
      }

      const tripData = {
        passenger_id: passengerId,
        passenger_name: passengerName.trim(),
        passenger_phone: passengerPhone.trim() || null,
        pickup_address: pickupAddress.trim(),
        dropoff_address: dropoffAddress.trim(),
        driver_id: selectedDriverId || null,
        estimated_fare: parseFloat(estimatedFare) || 0,
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
        trip_code: generateTripCode(),
        currency_code: 'GBP',
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

  return (
    <AdminLayout 
      title="Manual Trip Creation" 
      description="Create a new trip manually for a customer"
    >
      <form onSubmit={handleSubmit}>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Main Form */}
          <div className="lg:col-span-2 space-y-6">
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
                  <div className="relative">
                    <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-green-500" />
                    <Input
                      id="pickupAddress"
                      value={pickupAddress}
                      onChange={(e) => setPickupAddress(e.target.value)}
                      placeholder="Enter pickup location"
                      className="pl-10"
                      required
                    />
                  </div>
                </div>
                <div>
                  <Label htmlFor="dropoffAddress">Dropoff Address *</Label>
                  <div className="relative">
                    <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-red-500" />
                    <Input
                      id="dropoffAddress"
                      value={dropoffAddress}
                      onChange={(e) => setDropoffAddress(e.target.value)}
                      placeholder="Enter destination"
                      className="pl-10"
                      required
                    />
                  </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
                  <div>
                    <Label htmlFor="paymentMethod">Payment Method</Label>
                    <Select value={paymentMethod} onValueChange={setPaymentMethod}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="cash">Cash</SelectItem>
                        <SelectItem value="card">Card</SelectItem>
                        <SelectItem value="wallet">Wallet</SelectItem>
                        <SelectItem value="corporate">Corporate</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
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
                  <Label htmlFor="estimatedFare">Estimated Fare (£)</Label>
                  <Input
                    id="estimatedFare"
                    type="number"
                    step="0.01"
                    min="0"
                    value={estimatedFare}
                    onChange={(e) => setEstimatedFare(e.target.value)}
                    placeholder="0.00"
                  />
                </div>
              </CardContent>
            </Card>

            {/* Submit */}
            <Card className="border-primary/20 bg-primary/5">
              <CardContent className="pt-6">
                <Button 
                  type="submit" 
                  className="w-full" 
                  size="lg"
                  disabled={isSubmitting}
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
