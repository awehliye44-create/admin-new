import { useEffect, useState, useRef, useCallback } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { supabase } from '@/integrations/supabase/client';
import { 
  Car, 
  MapPin, 
  PoundSterling,
  CircleDollarSign,
  RefreshCw,
  Clock,
  ArrowRight,
  Navigation,
  CalendarIcon,
  Send,
  UserPlus,
  Route,
  FileText,
  Settings,
  AlertTriangle,
  CreditCard,
  BarChart3
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useNavigate } from 'react-router-dom';
import { format, subDays, subWeeks, subMonths, startOfDay, endOfDay, startOfWeek, startOfMonth } from 'date-fns';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PieChart, Pie, Cell, ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, BarChart, Bar } from 'recharts';
import { getEnhancedCarIcon, preloadMarkerImage } from '@/lib/mapMarkers';
import { getCurrencySymbol } from '@/lib/regionSettings';

interface Stats {
  totalDrivers: number;
  onlineDrivers: number;
  offlineDrivers: number;
  pendingDrivers: number;
  inactiveDrivers: number;
  totalRiders: number;
  totalTrips: number;
  activeTrips: number;
  inProgressTrips: number;
  completedTrips: number;
  cancelledTrips: number;
  totalRevenue: number;
  commissionRevenue: number;
  previousRevenue: number;
  previousCommission: number;
}

interface ServiceAreaRevenue {
  name: string;
  revenue: number;
  trips: number;
  commission: number;
  currency_code: string;
}

interface RecentTrip {
  id: string;
  passenger_name: string | null;
  pickup_address: string;
  dropoff_address: string;
  driver?: {
    first_name: string;
    last_name: string;
  } | null;
}

interface ServiceArea {
  id: string;
  name: string;
  region_id: string;
  region?: { currency_code: string } | null;
}

interface Driver {
  id: string;
  first_name: string;
  last_name: string;
  is_online: boolean;
  current_lat: number | null;
  current_lng: number | null;
  heading: number | null;
  current_trip_id: string | null;
}

interface BookingDataPoint {
  label: string;
  completed: number;
  cancelled: number;
}

declare global {
  interface Window {
    google: any;
  }
}

export default function Dashboard() {
  const navigate = useNavigate();
  const [stats, setStats] = useState<Stats>({
    totalDrivers: 0,
    onlineDrivers: 0,
    offlineDrivers: 0,
    pendingDrivers: 0,
    inactiveDrivers: 0,
    totalRiders: 0,
    totalTrips: 0,
    activeTrips: 0,
    inProgressTrips: 0,
    completedTrips: 0,
    cancelledTrips: 0,
    totalRevenue: 0,
    commissionRevenue: 0,
    previousRevenue: 0,
    previousCommission: 0,
  });
  const [recentTrips, setRecentTrips] = useState<RecentTrip[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [period, setPeriod] = useState<'daily' | 'weekly' | 'monthly' | 'custom'>('daily');
  const [serviceAreas, setServiceAreas] = useState<ServiceArea[]>([]);
  const [selectedServiceArea, setSelectedServiceArea] = useState<string>('all');
  const [userStatsPeriod, setUserStatsPeriod] = useState<'daily' | 'weekly' | 'monthly'>('weekly');
  const [bookingChartData, setBookingChartData] = useState<BookingDataPoint[]>([]);
  const [bookingStatType, setBookingStatType] = useState<'completed' | 'ongoing' | 'cancelled'>('completed');
  const [customDateFrom, setCustomDateFrom] = useState<Date | undefined>(undefined);
  const [customDateTo, setCustomDateTo] = useState<Date | undefined>(undefined);
  const [serviceAreaRevenues, setServiceAreaRevenues] = useState<ServiceAreaRevenue[]>([]);
  // Map state
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [isMapLoaded, setIsMapLoaded] = useState(false);
  const mapRef = useRef<HTMLDivElement>(null);
  const googleMapRef = useRef<any>(null);
  const markersRef = useRef<Map<string, any>>(new Map());

  // Preload marker image
  useEffect(() => {
    preloadMarkerImage();
  }, []);

  // Load Google Maps
  useEffect(() => {
    if (window.google?.maps) {
      setIsMapLoaded(true);
      return;
    }

    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${import.meta.env.VITE_GOOGLE_MAPS_API_KEY}&libraries=geometry`;
    script.async = true;
    script.defer = true;
    script.onload = () => setIsMapLoaded(true);
    document.head.appendChild(script);
  }, []);

  // Initialize map
  useEffect(() => {
    if (!isMapLoaded || !mapRef.current || googleMapRef.current) return;

    googleMapRef.current = new window.google.maps.Map(mapRef.current, {
      center: { lat: 52.0406, lng: -0.7594 },
      zoom: 10,
      mapTypeId: 'roadmap',
      styles: [
        { featureType: 'poi', elementType: 'labels', stylers: [{ visibility: 'off' }] },
      ],
    });
  }, [isMapLoaded]);

  // Update driver markers
  useEffect(() => {
    if (!googleMapRef.current || !isMapLoaded) return;

    // Clear existing markers
    markersRef.current.forEach(marker => marker.setMap(null));
    markersRef.current.clear();

    // Create markers for each driver with location
    drivers.forEach((driver) => {
      if (!driver.current_lat || !driver.current_lng) return;

      const position = { lat: driver.current_lat, lng: driver.current_lng };
      const isOnTrip = !!driver.current_trip_id;
      const zIndex = isOnTrip ? 100 : 1;

      const marker = new window.google.maps.Marker({
        position,
        map: googleMapRef.current,
        icon: getEnhancedCarIcon(32, driver.heading || 0),
        title: `${driver.first_name} ${driver.last_name}`,
        optimized: false,
        zIndex,
      });

      markersRef.current.set(driver.id, marker);
    });

    // Fit bounds if drivers have locations
    const driversWithLocation = drivers.filter(d => d.current_lat && d.current_lng);
    if (driversWithLocation.length > 0 && googleMapRef.current) {
      const bounds = new window.google.maps.LatLngBounds();
      driversWithLocation.forEach(d => {
        bounds.extend({ lat: d.current_lat!, lng: d.current_lng! });
      });
      googleMapRef.current.fitBounds(bounds);
    }
  }, [drivers, isMapLoaded]);

  // Fetch service areas
  useEffect(() => {
    async function fetchServiceAreas() {
      const { data } = await supabase
        .from('service_areas')
        .select('id, name, region_id, region:regions(currency_code)')
        .eq('is_active', true)
        .order('name');
      
      setServiceAreas(data || []);
    }
    fetchServiceAreas();
  }, []);

  // Fetch stats based on period and service area
  const fetchStats = useCallback(async () => {
    setIsLoading(true);
    try {
      // Calculate date ranges based on period
      const now = new Date();
      let startDate: Date;
      let endDate: Date = endOfDay(now);
      let previousStartDate: Date;
      let previousEndDate: Date;
      
      if (period === 'custom' && customDateFrom) {
        startDate = startOfDay(customDateFrom);
        endDate = customDateTo ? endOfDay(customDateTo) : endOfDay(now);
        const durationMs = endDate.getTime() - startDate.getTime();
        previousEndDate = startDate;
        previousStartDate = new Date(startDate.getTime() - durationMs);
      } else if (period === 'daily') {
        startDate = startOfDay(now);
        previousStartDate = startOfDay(subDays(now, 1));
        previousEndDate = startDate;
      } else if (period === 'weekly') {
        startDate = startOfWeek(now);
        previousStartDate = startOfWeek(subWeeks(now, 1));
        previousEndDate = startDate;
      } else {
        startDate = startOfMonth(now);
        previousStartDate = startOfMonth(subMonths(now, 1));
        previousEndDate = startDate;
      }

      // Build queries
      let driversQuery = supabase.from('drivers').select('id, is_online, approval_status, current_lat, current_lng, heading, current_trip_id, first_name, last_name');
      let tripsQuery = supabase.from('trips').select('id, status, fare, created_at, commission_pence, service_area_id');
      let previousTripsQuery = supabase.from('trips').select('id, fare, created_at, commission_pence').eq('status', 'completed');

      // Apply date filter for trips
      tripsQuery = tripsQuery.gte('created_at', startDate.toISOString()).lte('created_at', endDate.toISOString());
      previousTripsQuery = previousTripsQuery
        .gte('created_at', previousStartDate.toISOString())
        .lt('created_at', previousEndDate.toISOString());

      // Apply service area filter
      if (selectedServiceArea !== 'all') {
        tripsQuery = tripsQuery.eq('service_area_id', selectedServiceArea);
        previousTripsQuery = previousTripsQuery.eq('service_area_id', selectedServiceArea);
      }

      const [
        driversResult,
        ridersResult,
        tripsResult,
        previousTripsResult,
        recentTripsResult,
      ] = await Promise.all([
        driversQuery,
        supabase.from('customers').select('id', { count: 'exact', head: true }),
        tripsQuery,
        previousTripsQuery,
        supabase.from('trips')
          .select('id, passenger_name, pickup_address, dropoff_address, driver:drivers!trips_driver_id_fkey(first_name, last_name)')
          .order('created_at', { ascending: false })
          .limit(5),
      ]);

      const allDrivers = driversResult.data || [];
      const trips = tripsResult.data || [];
      const previousTrips = previousTripsResult.data || [];

      // Calculate stats
      const totalDrivers = allDrivers.length;
      const onlineDrivers = allDrivers.filter(d => d.is_online).length;
      const pendingDrivers = allDrivers.filter(d => d.approval_status === 'pending').length;
      
      const completedTrips = trips.filter(t => t.status === 'completed').length;
      const cancelledTrips = trips.filter(t => t.status === 'cancelled').length;
      const activeTrips = trips.filter(t => ['pending', 'accepted', 'arriving', 'in_progress'].includes(t.status || '')).length;
      const inProgressTrips = trips.filter(t => t.status === 'in_progress').length;
      
      const totalRevenue = trips
        .filter(t => t.status === 'completed')
        .reduce((sum, t) => sum + (t.fare || 0), 0);
      // Commission from actual trip data only (set from tier config during settlement)
      const commissionRevenue = trips
        .filter(t => t.status === 'completed')
        .reduce((sum, t) => sum + ((t.commission_pence || 0) / 100), 0);

      const previousRevenue = previousTrips.reduce((sum, t) => sum + (t.fare || 0), 0);
      const previousCommission = previousTrips
        .reduce((sum, t) => sum + ((t.commission_pence || 0) / 100), 0);

      setStats({
        totalDrivers,
        onlineDrivers,
        offlineDrivers: totalDrivers - onlineDrivers,
        pendingDrivers,
        inactiveDrivers: allDrivers.filter(d => d.approval_status === 'rejected').length,
        totalRiders: ridersResult.count || 0,
        totalTrips: trips.length,
        activeTrips,
        inProgressTrips,
        completedTrips,
        cancelledTrips,
        totalRevenue,
        commissionRevenue,
        previousRevenue,
        previousCommission,
      });

      setDrivers(allDrivers as Driver[]);
      setRecentTrips(recentTripsResult.data || []);

      // Calculate revenue per service area
      if (selectedServiceArea === 'all' && serviceAreas.length > 0) {
        const completedTripsData = trips.filter(t => t.status === 'completed');
        const revenueByArea: ServiceAreaRevenue[] = serviceAreas.map(area => {
          const areaTrips = completedTripsData.filter(t => t.service_area_id === area.id);
          const revenue = areaTrips.reduce((sum, t) => sum + (t.fare || 0), 0);
          const commission = areaTrips.reduce((sum, t) => sum + ((t.commission_pence || 0) / 100), 0);
          return { name: area.name, revenue, trips: areaTrips.length, commission, currency_code: (area.region as any)?.currency_code || 'GBP' };
        }).filter(a => a.trips > 0).sort((a, b) => b.revenue - a.revenue);
        setServiceAreaRevenues(revenueByArea);
      } else {
        setServiceAreaRevenues([]);
      }

      // Fetch booking chart data
      await fetchBookingChartData();
    } catch (error) {
      console.error('Error fetching stats:', error);
    } finally {
      setIsLoading(false);
    }
  }, [period, selectedServiceArea, customDateFrom, customDateTo]);

  // Fetch booking chart data
  const fetchBookingChartData = async () => {
    const now = new Date();
    let dataPoints: BookingDataPoint[] = [];
    const timePeriod = period === 'custom' ? 'daily' : period;
    
    const applyServiceAreaFilter = (query: any) => {
      if (selectedServiceArea !== 'all') {
        return query.eq('service_area_id', selectedServiceArea);
      }
      return query;
    };
    
    if (timePeriod === 'daily') {
      // Last 24 hours by 2-hour intervals (or custom range)
      const intervals = period === 'custom' && customDateFrom ? 12 : 12;
      const rangeStart = period === 'custom' && customDateFrom ? startOfDay(customDateFrom) : subDays(now, 1);
      const rangeEnd = period === 'custom' && customDateTo ? endOfDay(customDateTo) : now;
      const totalMs = rangeEnd.getTime() - rangeStart.getTime();
      const intervalMs = totalMs / intervals;
      
      for (let i = 0; i < intervals; i++) {
        const startTime = new Date(rangeStart.getTime() + i * intervalMs);
        const endTime = new Date(rangeStart.getTime() + (i + 1) * intervalMs);
        
        let query = supabase
          .from('trips')
          .select('status')
          .gte('created_at', startTime.toISOString())
          .lt('created_at', endTime.toISOString());
        query = applyServiceAreaFilter(query);
        const { data: trips } = await query;
        
        dataPoints.push({
          label: format(startTime, 'HH:mm'),
          completed: trips?.filter(t => t.status === 'completed').length || 0,
          cancelled: trips?.filter(t => t.status === 'cancelled').length || 0,
        });
      }
    } else if (timePeriod === 'weekly') {
      for (let i = 6; i >= 0; i--) {
        const date = subDays(now, i);
        const dayStart = startOfDay(date);
        const dayEnd = new Date(dayStart);
        dayEnd.setDate(dayEnd.getDate() + 1);
        
        let query = supabase
          .from('trips')
          .select('status')
          .gte('created_at', dayStart.toISOString())
          .lt('created_at', dayEnd.toISOString());
        query = applyServiceAreaFilter(query);
        const { data: trips } = await query;
        
        dataPoints.push({
          label: format(date, 'EEE'),
          completed: trips?.filter(t => t.status === 'completed').length || 0,
          cancelled: trips?.filter(t => t.status === 'cancelled').length || 0,
        });
      }
    } else {
      for (let i = 3; i >= 0; i--) {
        const weekStart = startOfWeek(subWeeks(now, i));
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekEnd.getDate() + 7);
        
        let query = supabase
          .from('trips')
          .select('status')
          .gte('created_at', weekStart.toISOString())
          .lt('created_at', weekEnd.toISOString());
        query = applyServiceAreaFilter(query);
        const { data: trips } = await query;
        
        dataPoints.push({
          label: format(weekStart, 'MMM d'),
          completed: trips?.filter(t => t.status === 'completed').length || 0,
          cancelled: trips?.filter(t => t.status === 'cancelled').length || 0,
        });
      }
    }
    
    setBookingChartData(dataPoints);
  };

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  // Real-time driver location updates
  useEffect(() => {
    const channel = supabase
      .channel('dashboard-driver-updates')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'drivers' },
        (payload) => {
          const updated = payload.new as any;
          setDrivers(prev => prev.map(d => 
            d.id === updated.id 
              ? { ...d, ...updated }
              : d
          ));
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const driverChartData = [
    { name: 'Total Drivers', value: stats.totalDrivers, color: '#3B82F6' },
    { name: 'Active Drivers', value: stats.onlineDrivers, color: '#10B981' },
    { name: 'Pending Drivers', value: stats.pendingDrivers, color: '#8B5CF6' },
    { name: 'Inactive Drivers', value: stats.inactiveDrivers, color: '#EF4444' },
  ];

  const riderChartData = [
    { name: 'Total Riders', value: stats.totalRiders, color: '#3B82F6' },
    { name: 'Active Trips', value: stats.activeTrips, color: '#10B981' },
    { name: 'Completed', value: stats.completedTrips, color: '#8B5CF6' },
    { name: 'Cancelled', value: stats.cancelledTrips, color: '#EF4444' },
  ];

  const calculateChange = (current: number, previous: number) => {
    if (previous === 0) return current > 0 ? 100 : 0;
    return Math.round(((current - previous) / previous) * 100);
  };

  const revenueChange = calculateChange(stats.totalRevenue, stats.previousRevenue);
  const commissionChange = calculateChange(stats.commissionRevenue, stats.previousCommission);

  // Resolve currency symbol for the selected service area
  const selectedArea = serviceAreas.find(sa => sa.id === selectedServiceArea);
  const activeCurrencyCode = (selectedArea?.region as any)?.currency_code || 'GBP';
  const currencySymbol = getCurrencySymbol(activeCurrencyCode);

  const onlineDriversCount = drivers.filter(d => d.is_online).length;
  const onTripCount = drivers.filter(d => d.current_trip_id).length;
  const availableCount = drivers.filter(d => d.is_online && !d.current_trip_id).length;
  const offlineCount = drivers.filter(d => !d.is_online).length;

  return (
    <AdminLayout title="Dashboard" description="Dashboard › Main Dashboard">
      {/* Header with filters */}
      <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <div className="flex items-center gap-4">
          <h2 className="text-xl font-semibold">
            Dashboard Statistics - {format(new Date(), 'd MMMM yyyy')}
          </h2>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <Tabs value={period} onValueChange={(v) => {
            setPeriod(v as typeof period);
            if (v !== 'custom') {
              setCustomDateFrom(undefined);
              setCustomDateTo(undefined);
            }
          }}>
            <TabsList>
              <TabsTrigger value="daily">Daily</TabsTrigger>
              <TabsTrigger value="weekly">Weekly</TabsTrigger>
              <TabsTrigger value="monthly">Monthly</TabsTrigger>
              <TabsTrigger value="custom">Custom</TabsTrigger>
            </TabsList>
          </Tabs>

          {period === 'custom' && (
            <div className="flex items-center gap-2">
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className={cn("w-[130px] justify-start text-left font-normal", !customDateFrom && "text-muted-foreground")}>
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {customDateFrom ? format(customDateFrom, 'MMM d, yyyy') : 'From'}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0 z-[9999]" align="start">
                  <Calendar
                    mode="single"
                    selected={customDateFrom}
                    onSelect={setCustomDateFrom}
                    disabled={(date) => date > new Date()}
                    initialFocus
                    captionLayout="dropdown-buttons"
                    fromYear={2020}
                    toYear={new Date().getFullYear()}
                    className={cn("p-3 pointer-events-auto")}
                  />
                </PopoverContent>
              </Popover>
              <span className="text-muted-foreground text-sm">to</span>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className={cn("w-[130px] justify-start text-left font-normal", !customDateTo && "text-muted-foreground")}>
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {customDateTo ? format(customDateTo, 'MMM d, yyyy') : 'To'}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0 z-[9999]" align="start">
                  <Calendar
                    mode="single"
                    selected={customDateTo}
                    onSelect={setCustomDateTo}
                    disabled={(date) => date > new Date() || (customDateFrom ? date < customDateFrom : false)}
                    initialFocus
                    captionLayout="dropdown-buttons"
                    fromYear={2020}
                    toYear={new Date().getFullYear()}
                    className={cn("p-3 pointer-events-auto")}
                  />
                </PopoverContent>
              </Popover>
            </div>
          )}

          <Select value={selectedServiceArea} onValueChange={setSelectedServiceArea}>
            <SelectTrigger className="w-[180px]">
              <MapPin className="h-4 w-4 mr-2" />
              <SelectValue placeholder="Service Area" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Service Areas</SelectItem>
              {serviceAreas.map(area => (
                <SelectItem key={area.id} value={area.id}>{area.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="ghost" size="icon" onClick={fetchStats} disabled={isLoading}>
            <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4 mb-6">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Active Drivers
            </CardTitle>
            <Car className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {isLoading ? '...' : stats.onlineDrivers}
            </div>
            <p className="text-xs text-muted-foreground">
              <span className="text-red-500">{stats.offlineDrivers} offline</span>
              {' '}
              <span className="text-green-500">{stats.totalDrivers} total drivers</span>
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total Revenue
            </CardTitle>
            <CircleDollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              £{isLoading ? '...' : stats.totalRevenue.toFixed(2)}
            </div>
            <p className="text-xs">
              <span className={revenueChange >= 0 ? 'text-green-500' : 'text-red-500'}>
                {revenueChange >= 0 ? '+' : ''}{revenueChange}%
              </span>
              <span className="text-muted-foreground"> vs previous {period === 'daily' ? 'day' : period === 'weekly' ? 'week' : period === 'custom' ? 'period' : 'month'}</span>
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Active Trips
            </CardTitle>
            <MapPin className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {isLoading ? '...' : stats.activeTrips}
            </div>
            <p className="text-xs text-green-500">
              {stats.inProgressTrips} in progress
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Commission Revenue
            </CardTitle>
            <PoundSterling className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              £{isLoading ? '...' : stats.commissionRevenue.toFixed(2)}
            </div>
            <p className="text-xs">
              <span className={commissionChange >= 0 ? 'text-green-500' : 'text-red-500'}>
                {commissionChange >= 0 ? '+' : ''}{commissionChange}%
              </span>
              <span className="text-muted-foreground"> tier-based commission</span>
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Revenue by Service Area */}
      {serviceAreaRevenues.length > 0 && (
        <Card className="mb-6">
          <CardHeader className="flex flex-row items-center gap-2">
            <MapPin className="h-5 w-5 text-primary" />
            <CardTitle>Revenue by Service Area</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {serviceAreaRevenues.map((area) => {
                const maxRevenue = serviceAreaRevenues[0]?.revenue || 1;
                const percentage = Math.round((area.revenue / maxRevenue) * 100);
                return (
                  <div key={area.name} className="space-y-1">
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-medium">{area.name}</span>
                      <div className="flex items-center gap-4 text-muted-foreground">
                        <span>{area.trips} trips</span>
                        <span className="font-semibold text-foreground">£{area.revenue.toFixed(2)}</span>
                      </div>
                    </div>
                    <div className="h-2 rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full rounded-full bg-primary transition-all duration-500"
                        style={{ width: `${percentage}%` }}
                      />
                    </div>
                    <div className="flex justify-end">
                      <span className="text-xs text-muted-foreground">Commission: £{area.commission.toFixed(2)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2 mb-6">
        {/* User Statistics */}
        <Card>
          <CardHeader>
            <CardTitle>User Statistics</CardTitle>
            <Tabs defaultValue="drivers">
              <TabsList>
                <TabsTrigger value="drivers">Driver Statistics</TabsTrigger>
                <TabsTrigger value="riders">Rider Statistics</TabsTrigger>
              </TabsList>
            </Tabs>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2 mb-4">
              <Button 
                variant={userStatsPeriod === 'daily' ? 'default' : 'outline'} 
                size="sm"
                onClick={() => setUserStatsPeriod('daily')}
              >
                Days
              </Button>
              <Button 
                variant={userStatsPeriod === 'weekly' ? 'default' : 'outline'} 
                size="sm"
                onClick={() => setUserStatsPeriod('weekly')}
              >
                Weekly
              </Button>
              <Button 
                variant={userStatsPeriod === 'monthly' ? 'default' : 'outline'} 
                size="sm"
                onClick={() => setUserStatsPeriod('monthly')}
              >
                Monthly
              </Button>
            </div>
            <div className="h-[200px] flex items-center justify-center">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={driverChartData}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={80}
                    paddingAngle={5}
                    dataKey="value"
                  >
                    {driverChartData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="grid grid-cols-2 gap-4 mt-4">
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-blue-500" />
                <span className="text-sm">Total Drivers</span>
                <span className="font-semibold ml-auto">{stats.totalDrivers}</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-green-500" />
                <span className="text-sm">Active Drivers</span>
                <span className="font-semibold ml-auto">{stats.onlineDrivers}</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-purple-500" />
                <span className="text-sm">Pending Drivers</span>
                <span className="font-semibold ml-auto">{stats.pendingDrivers}</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-red-500" />
                <span className="text-sm">Inactive Drivers</span>
                <span className="font-semibold ml-auto">{stats.inactiveDrivers}</span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Booking Statistics */}
        <Card>
          <CardHeader>
            <CardTitle>Booking Statistics</CardTitle>
            <Tabs value={bookingStatType} onValueChange={(v) => setBookingStatType(v as typeof bookingStatType)}>
              <TabsList>
                <TabsTrigger value="completed">Completed Rides</TabsTrigger>
                <TabsTrigger value="cancelled">Cancelled Rides</TabsTrigger>
              </TabsList>
            </Tabs>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2 mb-4 text-sm text-muted-foreground">
              <span>Period: {period === 'daily' ? 'Last 24 hours' : period === 'weekly' ? 'Last 7 days' : 'Last 4 weeks'}</span>
            </div>
            <div className="h-[200px]">
              {bookingChartData.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={bookingChartData}>
                    <XAxis dataKey="label" axisLine={false} tickLine={false} fontSize={12} />
                    <YAxis axisLine={false} tickLine={false} fontSize={12} />
                    <Tooltip />
                    <Bar 
                      dataKey={bookingStatType === 'completed' ? 'completed' : 'cancelled'} 
                      fill={bookingStatType === 'completed' ? 'hsl(var(--primary))' : 'hsl(var(--destructive))'}
                      radius={[4, 4, 0, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-full flex items-center justify-center text-muted-foreground">
                  No booking data available
                </div>
              )}
            </div>
            <div className="grid grid-cols-2 gap-4 mt-4 text-sm">
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-primary" />
                <span>Completed</span>
                <span className="font-semibold ml-auto">{stats.completedTrips}</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-destructive" />
                <span>Cancelled</span>
                <span className="font-semibold ml-auto">{stats.cancelledTrips}</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Live Fleet Map & Recent Activity */}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center gap-2">
            <MapPin className="h-5 w-5 text-primary" />
            <CardTitle>Live Fleet Map</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="mb-4 flex items-center justify-between">
              <span className="text-sm text-muted-foreground">{onlineDriversCount} drivers online</span>
              <div className="flex items-center gap-4 text-xs">
                <span className="flex items-center gap-1">
                  <Navigation className="h-3 w-3 text-green-500" /> Available
                </span>
                <span className="flex items-center gap-1">
                  <Navigation className="h-3 w-3 text-amber-500" /> On Trip
                </span>
                <span className="flex items-center gap-1">
                  <Navigation className="h-3 w-3 text-gray-400" /> Offline
                </span>
              </div>
            </div>
            <div 
              ref={mapRef}
              className="h-[300px] bg-muted rounded-lg overflow-hidden"
            >
              {!isMapLoaded && (
                <div className="h-full flex items-center justify-center text-muted-foreground">
                  Loading map...
                </div>
              )}
            </div>
            <div className="grid grid-cols-2 gap-4 mt-4 text-sm">
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-green-500" />
                <span>Available ({availableCount})</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-yellow-500" />
                <span>On Trip ({onTripCount})</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-blue-500" />
                <span>Online ({onlineDriversCount})</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-gray-500" />
                <span>Offline ({offlineCount})</span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center gap-2">
            <Clock className="h-5 w-5 text-primary" />
            <CardTitle>Recent Activity</CardTitle>
          </CardHeader>
          <CardContent>
            {recentTrips.length === 0 ? (
              <p className="text-muted-foreground text-sm">No recent activity</p>
            ) : (
              <div className="space-y-4">
                {recentTrips.map((trip) => (
                  <div key={trip.id} className="flex items-start gap-3 pb-4 border-b last:border-0">
                    <div className="flex h-9 w-9 items-center justify-center rounded-full bg-muted">
                      <Car className="h-4 w-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{trip.driver?.first_name} {trip.driver?.last_name}</span>
                        <ArrowRight className="h-4 w-4 text-muted-foreground" />
                        <span>{trip.passenger_name || 'Unknown'}</span>
                      </div>
                      <div className="flex items-start gap-1 mt-1 text-xs text-muted-foreground">
                        <MapPin className="h-3 w-3 mt-0.5 shrink-0" />
                        <span className="truncate">{trip.pickup_address}</span>
                        <ArrowRight className="h-3 w-3 shrink-0" />
                        <span className="truncate text-primary">{trip.dropoff_address}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Quick Actions */}
      <div className="mt-6">
        <h3 className="text-lg font-semibold mb-4">Quick Actions</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3">
          {[
            { icon: Send, label: 'Dispatch', path: '/dispatch', color: 'text-blue-500', bg: 'bg-blue-500/10' },
            { icon: UserPlus, label: 'Add Driver', path: '/drivers', color: 'text-green-500', bg: 'bg-green-500/10' },
            { icon: Route, label: 'Active Trips', path: '/active-trips', color: 'text-amber-500', bg: 'bg-amber-500/10' },
            { icon: CreditCard, label: 'Payments', path: '/payments', color: 'text-purple-500', bg: 'bg-purple-500/10' },
            { icon: FileText, label: 'Documents', path: '/documents', color: 'text-cyan-500', bg: 'bg-cyan-500/10' },
            { icon: AlertTriangle, label: 'Disputes', path: '/disputes', color: 'text-red-500', bg: 'bg-red-500/10' },
            { icon: BarChart3, label: 'Trip History', path: '/trip-history', color: 'text-indigo-500', bg: 'bg-indigo-500/10' },
            { icon: Settings, label: 'Settings', path: '/settings', color: 'text-muted-foreground', bg: 'bg-muted' },
          ].map((action) => (
            <button
              key={action.path}
              onClick={() => navigate(action.path)}
              className="flex flex-col items-center gap-2 p-4 rounded-xl border bg-card hover:bg-accent/50 transition-all duration-200 hover:shadow-md hover:-translate-y-0.5 group"
            >
              <div className={cn("flex items-center justify-center w-10 h-10 rounded-lg transition-colors", action.bg)}>
                <action.icon className={cn("h-5 w-5", action.color)} />
              </div>
              <span className="text-xs font-medium text-muted-foreground group-hover:text-foreground transition-colors">
                {action.label}
              </span>
            </button>
          ))}
        </div>
      </div>
    </AdminLayout>
  );
}
