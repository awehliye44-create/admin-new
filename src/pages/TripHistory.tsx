import React, { useEffect, useState, useCallback, useRef } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { 
  History, Loader2, Search, RefreshCw, MapPin, Phone,
  Eye, CheckCircle, Route, DollarSign,
  Navigation, User, Car, Globe
} from 'lucide-react';
import { format, subDays, startOfDay, endOfDay } from 'date-fns';
import { toast } from 'sonner';
import { getCurrencySymbol, formatDistance as formatDistanceUtil, getDistanceUnitShort } from '@/lib/regionSettings';
import { getTripDisplayId } from '@/lib/tripUtils';

/* global google */

interface TripStop {
  id: string;
  trip_id: string;
  stop_index: number;
  address: string;
  lat: number | null;
  lng: number | null;
  type: string;
  status: string;
  arrived_at: string | null;
  completed_at: string | null;
}

interface ServiceArea {
  id: string;
  name: string;
  region_id: string;
  region?: {
    name: string;
    currency_code: string;
    distance_unit: string;
  } | null;
}

interface Region {
  id: string;
  name: string;
  currency_code: string;
  distance_unit: string;
}

interface CompletedTrip {
  id: string;
  trip_code: string | null;
  trip_number: string | null;
  status: string | null;
  passenger_name: string | null;
  passenger_phone: string | null;
  pickup_address: string;
  pickup_latitude: number | null;
  pickup_longitude: number | null;
  dropoff_address: string;
  dropoff_latitude: number | null;
  dropoff_longitude: number | null;
  estimated_fare: number | null;
  fare: number | null;
  gross_fare_pence: number | null;
  commission_pence: number | null;
  driver_net_pence: number | null;
  final_fare_pence: number | null;
  payment_status: string | null;
  payment_method: string | null;
  currency_code: string | null;
  estimated_distance_km: number | null;
  estimated_duration_minutes: number | null;
  total_stops: number | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  surge_multiplier: number | null;
  driver_id: string | null;
  driver_location_lat: number | null;
  driver_location_lng: number | null;
  stripe_payment_intent_id: string | null;
  driver?: {
    id: string;
    first_name: string;
    last_name: string;
    phone: string;
    driver_code: string | null;
    region_id: string | null;
  } | null;
  // Joined trip_stops for display
  trip_stops?: TripStop[];
}

export default function TripHistory() {
  const [trips, setTrips] = useState<CompletedTrip[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [dateFilter, setDateFilter] = useState('7days');

  // Region and Service Area filters
  const [regions, setRegions] = useState<Region[]>([]);
  const [serviceAreas, setServiceAreas] = useState<ServiceArea[]>([]);
  const [selectedRegionId, setSelectedRegionId] = useState<string>('all');
  const [selectedServiceAreaId, setSelectedServiceAreaId] = useState<string>('all');
  const [activeRegion, setActiveRegion] = useState<Region | null>(null);

  // Dialog states
  const [isViewOpen, setIsViewOpen] = useState(false);
  const [selectedTrip, setSelectedTrip] = useState<CompletedTrip | null>(null);
  const [tripStops, setTripStops] = useState<TripStop[]>([]);
  const [isLoadingStops, setIsLoadingStops] = useState(false);
  const [selectedServiceArea, setSelectedServiceArea] = useState<ServiceArea | null>(null);

  // Map state
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const markersRef = useRef<any[]>([]);
  const polylineRef = useRef<google.maps.Polyline | null>(null);

  const getDateRange = useCallback(() => {
    const now = new Date();
    switch (dateFilter) {
      case 'today':
        return { start: startOfDay(now), end: endOfDay(now) };
      case '7days':
        return { start: startOfDay(subDays(now, 7)), end: endOfDay(now) };
      case '30days':
        return { start: startOfDay(subDays(now, 30)), end: endOfDay(now) };
      case '90days':
        return { start: startOfDay(subDays(now, 90)), end: endOfDay(now) };
      default:
        return { start: startOfDay(subDays(now, 7)), end: endOfDay(now) };
    }
  }, [dateFilter]);

  // Fetch regions and service areas on mount
  const fetchRegionsAndServiceAreas = useCallback(async () => {
    try {
      const [regionsRes, serviceAreasRes] = await Promise.all([
        supabase
          .from('regions')
          .select('id, name, currency_code, distance_unit')
          .eq('status', 'active')
          .order('name'),
        supabase
          .from('service_areas')
          .select('id, name, region_id, region:regions(name, currency_code, distance_unit)')
          .eq('is_active', true)
          .order('name'),
      ]);

      if (regionsRes.error) throw regionsRes.error;
      if (serviceAreasRes.error) throw serviceAreasRes.error;

      setRegions(regionsRes.data || []);
      setServiceAreas((serviceAreasRes.data || []) as ServiceArea[]);
    } catch (err) {
      console.error('Error fetching regions/service areas:', err);
    }
  }, []);

  useEffect(() => {
    fetchRegionsAndServiceAreas();
  }, [fetchRegionsAndServiceAreas]);

  // Update active region when filter changes
  useEffect(() => {
    if (selectedRegionId === 'all') {
      setActiveRegion(null);
    } else {
      const region = regions.find(r => r.id === selectedRegionId);
      setActiveRegion(region || null);
    }
    // Reset service area when region changes
    setSelectedServiceAreaId('all');
  }, [selectedRegionId, regions]);

  const fetchData = useCallback(async () => {
    try {
      setIsLoading(true);
      const { start, end } = getDateRange();
      
      // Fetch trips with driver info
      const { data: tripsData, error: tripsError } = await supabase
        .from('trips')
        .select(`
          *,
          driver:drivers!trips_driver_id_fkey(id, first_name, last_name, phone, driver_code, region_id)
        `)
        .eq('status', 'completed')
        .gte('created_at', start.toISOString())
        .lte('created_at', end.toISOString())
        .order('completed_at', { ascending: false });

      if (tripsError) throw tripsError;

      const tripIds = (tripsData || []).map(t => t.id);
      
      // Fetch all trip stops for these trips in one query
      let stopsMap: Record<string, TripStop[]> = {};
      if (tripIds.length > 0) {
        const { data: stopsData, error: stopsError } = await supabase
          .from('trip_stops')
          .select('*')
          .in('trip_id', tripIds)
          .order('stop_index', { ascending: true });

        if (!stopsError && stopsData) {
          // Group stops by trip_id
          stopsMap = stopsData.reduce((acc, stop) => {
            if (!acc[stop.trip_id]) {
              acc[stop.trip_id] = [];
            }
            acc[stop.trip_id].push(stop);
            return acc;
          }, {} as Record<string, TripStop[]>);
        }
      }

      // Combine trips with their stops
      const tripsWithStops = (tripsData || []).map(trip => ({
        ...trip,
        trip_stops: stopsMap[trip.id] || [],
      }));

      setTrips(tripsWithStops as CompletedTrip[]);
    } catch (err) {
      console.error('Error fetching completed trips:', err);
      toast.error('Failed to load trip history');
    } finally {
      setIsLoading(false);
    }
  }, [getDateRange]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const fetchTripStops = async (tripId: string) => {
    try {
      setIsLoadingStops(true);
      const { data, error } = await supabase
        .from('trip_stops')
        .select('*')
        .eq('trip_id', tripId)
        .order('stop_index', { ascending: true });

      if (error) throw error;
      setTripStops(data || []);
    } catch (err) {
      console.error('Error fetching trip stops:', err);
      setTripStops([]);
    } finally {
      setIsLoadingStops(false);
    }
  };

  const fetchServiceAreaForTrip = async (regionId: string) => {
    try {
      const { data, error } = await supabase
        .from('service_areas')
        .select(`
          id,
          name,
          region_id,
          region:regions(name, currency_code, distance_unit)
        `)
        .eq('region_id', regionId)
        .limit(1)
        .maybeSingle();

      if (error || !data) {
        // Fallback: try to get region directly
        const { data: regionData } = await supabase
          .from('regions')
          .select('id, name, currency_code, distance_unit')
          .eq('id', regionId)
          .single();
        
        if (regionData) {
          setSelectedServiceArea({
            id: regionData.id,
            name: regionData.name,
            region_id: regionData.id,
            region: {
              name: regionData.name,
              currency_code: regionData.currency_code,
              distance_unit: regionData.distance_unit,
            }
          });
        }
        return;
      }
      
      setSelectedServiceArea(data as ServiceArea);
    } catch (err) {
      console.error('Error fetching service area:', err);
      setSelectedServiceArea(null);
    }
  };

  const handleViewTrip = async (trip: CompletedTrip) => {
    setSelectedTrip(trip);
    setSelectedServiceArea(null);
    setIsViewOpen(true);
    await fetchTripStops(trip.id);
    
    // Fetch service area if driver has region
    if (trip.driver?.region_id) {
      await fetchServiceAreaForTrip(trip.driver.region_id);
    }
  };

  // Initialize map when dialog opens with a trip
  useEffect(() => {
    if (!isViewOpen || !selectedTrip || !mapContainerRef.current) return;

    // Wait for dialog to be fully rendered
    const initTimer = setTimeout(() => {
      if (!mapContainerRef.current || !window.google) return;

      const center = {
        lat: selectedTrip.pickup_latitude || 51.5074,
        lng: selectedTrip.pickup_longitude || -0.1278,
      };

      mapRef.current = new window.google.maps.Map(mapContainerRef.current, {
        center,
        zoom: 13,
        styles: [
          { featureType: 'poi', stylers: [{ visibility: 'off' }] },
          { featureType: 'transit', stylers: [{ visibility: 'off' }] },
        ],
      });
    }, 100);

    return () => {
      clearTimeout(initTimer);
      // Cleanup markers and polyline
      markersRef.current.forEach(m => m.setMap(null));
      markersRef.current = [];
      polylineRef.current?.setMap(null);
      polylineRef.current = null;
    };
  }, [isViewOpen, selectedTrip]);

  // Update markers when trip or stops change
  useEffect(() => {
    if (!mapRef.current || !selectedTrip) return;

    // Clear existing markers
    markersRef.current.forEach(m => m.setMap(null));
    markersRef.current = [];
    polylineRef.current?.setMap(null);

    const bounds = new window.google.maps.LatLngBounds();
    const path: google.maps.LatLngLiteral[] = [];

    // Add pickup marker
    if (selectedTrip.pickup_latitude && selectedTrip.pickup_longitude) {
      const pickupPos = { lat: selectedTrip.pickup_latitude, lng: selectedTrip.pickup_longitude };
      path.push(pickupPos);
      bounds.extend(pickupPos);

      const pickupMarker = new window.google.maps.Marker({
        position: pickupPos,
        map: mapRef.current,
        icon: {
          path: window.google.maps.SymbolPath.CIRCLE,
          scale: 10,
          fillColor: '#22c55e',
          fillOpacity: 1,
          strokeColor: '#ffffff',
          strokeWeight: 2,
        },
        title: 'Pickup',
      });
      markersRef.current.push(pickupMarker);
    }

    // Add intermediate stops
    tripStops
      .filter(s => s.type !== 'pickup' && s.type !== 'dropoff' && s.lat && s.lng)
      .forEach((stop, idx) => {
        const pos = { lat: stop.lat!, lng: stop.lng! };
        path.push(pos);
        bounds.extend(pos);

        const marker = new window.google.maps.Marker({
          position: pos,
          map: mapRef.current!,
          label: {
            text: String(idx + 1),
            color: '#ffffff',
            fontSize: '12px',
            fontWeight: 'bold',
          },
          icon: {
            path: window.google.maps.SymbolPath.CIRCLE,
            scale: 10,
            fillColor: '#3b82f6',
            fillOpacity: 1,
            strokeColor: '#ffffff',
            strokeWeight: 2,
          },
          title: `Stop ${idx + 1}`,
        });
        markersRef.current.push(marker);
      });

    // Add dropoff marker
    if (selectedTrip.dropoff_latitude && selectedTrip.dropoff_longitude) {
      const dropoffPos = { lat: selectedTrip.dropoff_latitude, lng: selectedTrip.dropoff_longitude };
      path.push(dropoffPos);
      bounds.extend(dropoffPos);

      const dropoffMarker = new window.google.maps.Marker({
        position: dropoffPos,
        map: mapRef.current,
        icon: {
          path: window.google.maps.SymbolPath.CIRCLE,
          scale: 10,
          fillColor: '#ef4444',
          fillOpacity: 1,
          strokeColor: '#ffffff',
          strokeWeight: 2,
        },
        title: 'Dropoff (Destination)',
      });
      markersRef.current.push(dropoffMarker);
    }

    // Add driver completion location marker (where driver actually was when trip completed)
    if (selectedTrip.driver_location_lat && selectedTrip.driver_location_lng) {
      const driverEndPos = { lat: selectedTrip.driver_location_lat, lng: selectedTrip.driver_location_lng };
      
      // Only show if it's meaningfully different from the dropoff (>100m away)
      const dropoffLat = selectedTrip.dropoff_latitude;
      const dropoffLng = selectedTrip.dropoff_longitude;
      let showDriverEnd = true;
      if (dropoffLat && dropoffLng) {
        const dist = haversineDistance(driverEndPos.lat, driverEndPos.lng, dropoffLat, dropoffLng);
        if (dist < 0.1) showDriverEnd = false; // less than 100m
      }

      if (showDriverEnd) {
        bounds.extend(driverEndPos);

        const driverEndMarker = new window.google.maps.Marker({
          position: driverEndPos,
          map: mapRef.current,
          icon: {
            path: window.google.maps.SymbolPath.CIRCLE,
            scale: 10,
            fillColor: '#f59e0b',
            fillOpacity: 1,
            strokeColor: '#ffffff',
            strokeWeight: 2,
          },
          title: 'Driver Completion Location',
        });
        markersRef.current.push(driverEndMarker);
      }
    }

    // Draw route polyline
    if (path.length >= 2) {
      polylineRef.current = new window.google.maps.Polyline({
        path,
        geodesic: true,
        strokeColor: '#6366f1',
        strokeOpacity: 0.8,
        strokeWeight: 4,
      });
      polylineRef.current.setMap(mapRef.current);
    }

    // Fit bounds
    if (path.length > 0) {
      mapRef.current.fitBounds(bounds, 50);
    }
  }, [selectedTrip, tripStops]);

  const formatDuration = (minutes: number | null) => {
    if (!minutes) return 'N/A';
    const hrs = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
  };

  // Get the active currency symbol (from filter or default)
  const getActiveCurrencySymbol = () => {
    if (activeRegion) {
      return getCurrencySymbol(activeRegion.currency_code);
    }
    return getCurrencySymbol('GBP');
  };

  // Get the active distance unit (from filter or default)
  const getActiveDistanceUnit = () => {
    if (activeRegion) {
      return activeRegion.distance_unit || 'mile';
    }
    return 'mile';
  };

  // Convert km to the correct distance unit
  const formatTripDistance = (distanceKm: number | null, trip?: CompletedTrip) => {
    if (!distanceKm) return 'N/A';
    // Use trip's driver region unit if available, otherwise use active filter unit, default to 'mile'
    let unit = 'mile'; // Default to miles
    
    if (trip?.driver?.region_id) {
      const driverRegion = regions.find(r => r.id === trip.driver?.region_id);
      if (driverRegion) {
        unit = driverRegion.distance_unit || 'mile';
      }
    } else if (activeRegion) {
      unit = activeRegion.distance_unit || 'mile';
    }
    
    return formatDistanceUtil(distanceKm, unit);
  };

  // Calculate total route distance from trip stops (using Haversine formula)
  const calculateRouteDistance = (stops: TripStop[]): number => {
    if (stops.length < 2) return 0;
    
    let totalDistance = 0;
    for (let i = 0; i < stops.length - 1; i++) {
      const from = stops[i];
      const to = stops[i + 1];
      if (from.lat && from.lng && to.lat && to.lng) {
        totalDistance += haversineDistance(from.lat, from.lng, to.lat, to.lng);
      }
    }
    return totalDistance;
  };

  // Haversine formula to calculate distance between two points in km
  const haversineDistance = (lat1: number, lng1: number, lat2: number, lng2: number): number => {
    const R = 6371; // Earth's radius in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = 
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  };

  // Get total waypoints count for a trip (pickup + intermediate stops + dropoff)
  const getTripStopsCount = (trip: CompletedTrip): number => {
    if (trip.trip_stops && trip.trip_stops.length > 0) {
      return trip.trip_stops.length;
    }
    // Simple A to B trip has 2 points (pickup and dropoff)
    return 2;
  };

  // Get intermediate stops count (excluding pickup and dropoff)
  // A regular A→B trip has 0 intermediate stops
  const getIntermediateStopsCount = (trip: CompletedTrip): number => {
    if (trip.trip_stops && trip.trip_stops.length > 0) {
      // Only count stops with type='stop' (not pickup or dropoff)
      return trip.trip_stops.filter(s => s.type === 'stop').length;
    }
    // If no trip_stops data, assume it's a simple A to B trip
    return 0;
  };

  // Check if a trip is a multi-stop trip (has intermediate stops)
  const isMultiStopTrip = (trip: CompletedTrip): boolean => {
    return getIntermediateStopsCount(trip) > 0;
  };

  // Get best distance for trip (calculated from stops or estimated)
  const getTripDistance = (trip: CompletedTrip): number | null => {
    if (trip.trip_stops && trip.trip_stops.length >= 2) {
      const calculatedDistance = calculateRouteDistance(trip.trip_stops);
      if (calculatedDistance > 0) return calculatedDistance;
    }
    return trip.estimated_distance_km;
  };

  // Format distance for dialog (uses selectedServiceArea or defaults to mile)
  const formatDialogDistance = (distanceKm: number | null) => {
    if (!distanceKm) return 'N/A';
    const unit = selectedServiceArea?.region?.distance_unit || activeRegion?.distance_unit || 'mile';
    return formatDistanceUtil(distanceKm, unit);
  };

  // Get available service areas for selected region
  const filteredServiceAreas = selectedRegionId === 'all'
    ? serviceAreas
    : serviceAreas.filter(sa => sa.region_id === selectedRegionId);

  const filteredTrips = trips.filter(trip => {
    const matchesSearch = 
      getTripDisplayId(trip).toLowerCase().includes(searchQuery.toLowerCase()) ||
      trip.trip_code?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      trip.passenger_name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      trip.passenger_phone?.includes(searchQuery) ||
      trip.pickup_address?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      trip.driver?.first_name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      trip.driver?.last_name?.toLowerCase().includes(searchQuery.toLowerCase());
    
    // Region filter
    if (selectedRegionId !== 'all') {
      if (!trip.driver?.region_id || trip.driver.region_id !== selectedRegionId) {
        return false;
      }
    }

    // Service area filter (check driver's service area assignments if needed)
    // For now, we filter by region only since trips don't store service_area_id directly
    
    return matchesSearch;
  });

  // Helper to get fare in pounds from pence-based fields (source of truth) or legacy fare field
  const getTripFarePounds = (trip: CompletedTrip): number => {
    if (trip.gross_fare_pence != null && trip.gross_fare_pence > 0) return trip.gross_fare_pence / 100;
    if (trip.fare != null && trip.fare > 0) return trip.fare;
    return 0;
  };

  // Stats based on filtered trips
  const totalRevenue = filteredTrips.reduce((sum, t) => sum + getTripFarePounds(t), 0);
  const avgFare = filteredTrips.length > 0 ? totalRevenue / filteredTrips.length : 0;
  const multiStopTrips = filteredTrips.filter(t => isMultiStopTrip(t)).length;

  return (
    <AdminLayout 
      title="Trip History" 
      description="View all completed trips with route and fare details"
    >
      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Total Trips</p>
                <p className="text-2xl font-bold">{filteredTrips.length}</p>
              </div>
              <CheckCircle className="h-8 w-8 text-green-500 opacity-80" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-green-500/30 bg-green-500/5">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Total Revenue</p>
                <p className="text-2xl font-bold text-green-600">
                  {getActiveCurrencySymbol()}{totalRevenue.toFixed(2)}
                </p>
              </div>
              <DollarSign className="h-8 w-8 text-green-500" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Average Fare</p>
                <p className="text-2xl font-bold">{getActiveCurrencySymbol()}{avgFare.toFixed(2)}</p>
              </div>
              <Route className="h-8 w-8 text-muted-foreground opacity-80" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-blue-500/30 bg-blue-500/5">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Multi-Stop Trips</p>
                <p className="text-2xl font-bold text-blue-600">{multiStopTrips}</p>
              </div>
              <Navigation className="h-8 w-8 text-blue-500" />
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <History className="h-5 w-5 text-primary" />
              Completed Trips
            </CardTitle>
            <CardDescription className="flex items-center gap-2 flex-wrap">
              All completed rides with route and payment details
              {activeRegion && (
                <Badge variant="outline" className="ml-2 text-xs">
                  {activeRegion.name} • {getActiveCurrencySymbol()} • {getActiveDistanceUnit()}
                </Badge>
              )}
            </CardDescription>
          </div>
          <div className="flex flex-col gap-2 md:flex-row md:items-center flex-wrap">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search trips..."
                className="pl-9 w-full md:w-[180px]"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
            <Select value={selectedRegionId} onValueChange={setSelectedRegionId}>
              <SelectTrigger className="w-full md:w-[140px]">
                <Globe className="h-4 w-4 mr-2 text-muted-foreground" />
                <SelectValue placeholder="Region" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Regions</SelectItem>
                {regions.map((region) => (
                  <SelectItem key={region.id} value={region.id}>
                    {region.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select 
              value={selectedServiceAreaId} 
              onValueChange={setSelectedServiceAreaId}
              disabled={filteredServiceAreas.length === 0}
            >
              <SelectTrigger className="w-full md:w-[150px]">
                <SelectValue placeholder="Service Area" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Areas</SelectItem>
                {filteredServiceAreas.map((area) => (
                  <SelectItem key={area.id} value={area.id}>
                    {area.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={dateFilter} onValueChange={setDateFilter}>
              <SelectTrigger className="w-full md:w-[130px]">
                <SelectValue placeholder="Date Range" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="today">Today</SelectItem>
                <SelectItem value="7days">Last 7 Days</SelectItem>
                <SelectItem value="30days">Last 30 Days</SelectItem>
                <SelectItem value="90days">Last 90 Days</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" onClick={fetchData} disabled={isLoading}>
              <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          ) : filteredTrips.length === 0 ? (
            <div className="py-12 text-center">
              <History className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-medium mb-2">No completed trips</h3>
              <p className="text-muted-foreground">
                {searchQuery 
                  ? 'Try adjusting your search' 
                  : 'No trips completed in the selected time period'}
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Trip</TableHead>
                  <TableHead>Passenger</TableHead>
                  <TableHead>Route</TableHead>
                  <TableHead>Driver</TableHead>
                  <TableHead>Stops</TableHead>
                  <TableHead>Distance</TableHead>
                  <TableHead>Fare</TableHead>
                  <TableHead>Payment</TableHead>
                  <TableHead>Completed</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredTrips.map((trip) => (
                  <TableRow key={trip.id}>
                    <TableCell>
                      <div className="font-mono text-sm font-medium text-primary">
                        {getTripDisplayId(trip)}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div>
                        <div className="font-medium">{trip.passenger_name || 'Unknown'}</div>
                        <div className="text-xs text-muted-foreground flex items-center gap-1">
                          <Phone className="h-3 w-3" />
                          {trip.passenger_phone || 'N/A'}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="max-w-[180px]">
                        <div className="flex items-start gap-1 text-xs">
                          <MapPin className="h-3 w-3 text-green-500 mt-0.5 shrink-0" />
                          <span className="truncate">{trip.pickup_address?.slice(0, 25)}...</span>
                        </div>
                        <div className="flex items-start gap-1 text-xs mt-1">
                          <MapPin className="h-3 w-3 text-red-500 mt-0.5 shrink-0" />
                          <span className="truncate">{trip.dropoff_address?.slice(0, 25)}...</span>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      {trip.driver ? (
                        <div className="text-sm">
                          <div className="font-medium">{trip.driver.first_name} {trip.driver.last_name}</div>
                          <div className="text-xs text-muted-foreground font-mono">
                            {trip.driver.driver_code || 'N/A'}
                          </div>
                        </div>
                      ) : (
                        <span className="text-muted-foreground text-sm">N/A</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Badge variant="outline" className="bg-blue-500/10 text-blue-600">
                          {getIntermediateStopsCount(trip)}
                        </Badge>
                        {getIntermediateStopsCount(trip) > 0 && (
                          <span className="text-xs text-muted-foreground">
                            via {getIntermediateStopsCount(trip)} stop{getIntermediateStopsCount(trip) > 1 ? 's' : ''}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatTripDistance(getTripDistance(trip), trip)}
                    </TableCell>
                    <TableCell>
                      <div className="font-medium text-green-600">
                        {trip.currency_code 
                          ? getCurrencySymbol(trip.currency_code)
                          : getActiveCurrencySymbol()}
                        {getTripFarePounds(trip).toFixed(2)}
                      </div>
                      {trip.commission_pence != null && (
                        <div className="text-[10px] text-muted-foreground mt-0.5">
                          Net: {((trip.driver_net_pence || 0) / 100).toFixed(2)}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-0.5">
                        <Badge variant="outline" className="text-[10px] w-fit">
                          {trip.payment_method === 'cash' ? '💵 Cash' 
                            : trip.payment_method === 'apple_pay' ? '📱 Apple Pay'
                            : trip.payment_method === 'card' ? '💳 Card'
                            : trip.payment_method || 'Unknown'}
                        </Badge>
                        {trip.payment_status && (
                          <span className={`text-[10px] ${
                            trip.payment_status === 'captured' || trip.payment_status === 'collected_cash' 
                              ? 'text-green-600' 
                              : trip.payment_status === 'pending' 
                                ? 'text-amber-600' 
                                : 'text-muted-foreground'
                          }`}>
                            {trip.payment_status === 'captured' ? '✓ Paid' 
                              : trip.payment_status === 'collected_cash' ? '✓ Cash collected'
                              : trip.payment_status}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {trip.completed_at 
                        ? format(new Date(trip.completed_at), 'MMM d, HH:mm')
                        : 'N/A'}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button 
                        variant="ghost" 
                        size="sm"
                        onClick={() => handleViewTrip(trip)}
                      >
                        <Eye className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Trip Details Dialog */}
      <Dialog open={isViewOpen} onOpenChange={setIsViewOpen}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-xl font-bold">
              Trip #{selectedTrip ? getTripDisplayId(selectedTrip) : ''}
            </DialogTitle>
            <DialogDescription className="sr-only">
              Trip details and route information
            </DialogDescription>
          </DialogHeader>
          {selectedTrip && (
            <div className="space-y-4">
              {/* Status Badges Row */}
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                  <CheckCircle className="h-3 w-3 mr-1" />
                  Completed
                </Badge>
                {selectedTrip.payment_method && (
                  <Badge variant="secondary">
                    {selectedTrip.payment_method}
                  </Badge>
                )}
                {selectedServiceArea && (
                  <Badge variant="outline" className="bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
                    <Globe className="h-3 w-3 mr-1" />
                    {selectedServiceArea.name}
                    {selectedServiceArea.region && ` (${selectedServiceArea.region.name})`}
                  </Badge>
                )}
                {selectedTrip.surge_multiplier && selectedTrip.surge_multiplier > 1 && (
                  <Badge variant="destructive">
                    {selectedTrip.surge_multiplier}x Surge
                  </Badge>
                )}
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Left Column - Details */}
                <div className="space-y-5">
                  {/* Passenger Info */}
                  <div className="space-y-2">
                    <h4 className="text-sm font-semibold flex items-center gap-2">
                      <User className="h-4 w-4" />
                      Passenger
                    </h4>
                    <div className="bg-muted/50 rounded-lg p-3">
                      <p className="font-medium">{selectedTrip.passenger_name || 'Unknown'}</p>
                      <p className="text-sm text-muted-foreground">{selectedTrip.passenger_phone || 'No phone'}</p>
                    </div>
                  </div>

                  {/* Driver Info */}
                  {selectedTrip.driver && (
                    <div className="space-y-2">
                      <h4 className="text-sm font-semibold flex items-center gap-2">
                        <Car className="h-4 w-4" />
                        Driver
                      </h4>
                      <div className="bg-muted/50 rounded-lg p-3">
                        <p className="font-medium">
                          {selectedTrip.driver.first_name} {selectedTrip.driver.last_name}
                        </p>
                        <p className="text-sm text-muted-foreground font-mono">
                          {selectedTrip.driver.driver_code || 'N/A'}
                        </p>
                      </div>
                    </div>
                  )}

                  {/* Route Stops */}
                  <div className="space-y-2">
                    <h4 className="text-sm font-semibold flex items-center gap-2">
                      <Route className="h-4 w-4" />
                      Route ({tripStops.filter(s => s.type === 'stop').length} stop{tripStops.filter(s => s.type === 'stop').length !== 1 ? 's' : ''})
                      <Badge variant="secondary" className="text-xs">
                        {tripStops.length >= 2 && calculateRouteDistance(tripStops) > 0 
                          ? formatDialogDistance(calculateRouteDistance(tripStops))
                          : formatDialogDistance(selectedTrip.estimated_distance_km)}
                      </Badge>
                    </h4>
                    <div className="space-y-2">
                      {isLoadingStops ? (
                        <div className="flex items-center justify-center py-4">
                          <Loader2 className="h-4 w-4 animate-spin" />
                        </div>
                      ) : tripStops.length > 0 ? (
                        /* Render from trip_stops table */
                        tripStops.map((stop, idx) => {
                          const isPickup = stop.type === 'pickup';
                          const isDropoff = stop.type === 'dropoff';
                          const isIntermediateStop = stop.type === 'stop';
                          
                          let bgColor = 'bg-blue-500/10 dark:bg-blue-900/20';
                          let dotColor = 'bg-blue-500';
                          let labelColor = 'text-blue-700 dark:text-blue-400';
                          let label = `Stop ${idx + 1}`;
                          let dotLabel = String(idx + 1);
                          
                          if (isPickup) {
                            bgColor = 'bg-green-500/10 dark:bg-green-900/20';
                            dotColor = 'bg-green-500';
                            labelColor = 'text-green-700 dark:text-green-400';
                            label = 'Pickup';
                            dotLabel = 'A';
                          } else if (isDropoff) {
                            bgColor = 'bg-red-500/10 dark:bg-red-900/20';
                            dotColor = 'bg-red-500';
                            labelColor = 'text-red-700 dark:text-red-400';
                            label = 'Dropoff';
                            dotLabel = 'B';
                          } else {
                            // Intermediate stop - get correct numbering
                            const intermediateIndex = tripStops
                              .slice(0, idx)
                              .filter(s => s.type === 'stop').length + 1;
                            label = `Stop ${intermediateIndex}`;
                            dotLabel = String(intermediateIndex);
                          }

                          return (
                            <div key={stop.id} className={`flex items-start gap-3 ${bgColor} rounded-lg p-3`}>
                              <div className={`w-6 h-6 rounded-full ${dotColor} flex items-center justify-center shrink-0`}>
                                <span className="text-xs font-bold text-white">{dotLabel}</span>
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center justify-between gap-2">
                                  <div className="flex items-center gap-2">
                                    <p className={`text-xs font-medium ${labelColor}`}>{label}</p>
                                    <Badge 
                                      variant={stop.status === 'completed' ? 'default' : 'secondary'}
                                      className="text-[10px] px-1 py-0"
                                    >
                                      {stop.status}
                                    </Badge>
                                  </div>
                                  {stop.arrived_at && (
                                    <p className="text-xs text-muted-foreground shrink-0">
                                      {format(new Date(stop.arrived_at), 'h:mm a')}
                                    </p>
                                  )}
                                </div>
                                <p className="text-sm mt-0.5">{stop.address}</p>
                                {stop.lat && stop.lng && (
                                  <p className="text-[10px] text-muted-foreground mt-0.5 font-mono">
                                    {stop.lat.toFixed(6)}, {stop.lng.toFixed(6)}
                                  </p>
                                )}
                                {stop.completed_at && !isDropoff && (
                                  <p className="text-xs text-muted-foreground mt-1">
                                    Left: {format(new Date(stop.completed_at), 'h:mm a')}
                                  </p>
                                )}
                              </div>
                            </div>
                          );
                        })
                      ) : (
                        /* Fallback to trip's pickup/dropoff addresses */
                        <>
                          {/* Pickup */}
                          <div className="flex items-start gap-3 bg-green-500/10 dark:bg-green-900/20 rounded-lg p-3">
                            <div className="w-6 h-6 rounded-full bg-green-500 flex items-center justify-center shrink-0">
                              <span className="text-xs font-bold text-white">A</span>
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between">
                                <p className="text-xs font-medium text-green-700 dark:text-green-400">Pickup</p>
                                {selectedTrip.started_at && (
                                  <p className="text-xs text-muted-foreground">
                                    {format(new Date(selectedTrip.started_at), 'h:mm a')}
                                  </p>
                                )}
                              </div>
                              <p className="text-sm">{selectedTrip.pickup_address}</p>
                              {selectedTrip.pickup_latitude && selectedTrip.pickup_longitude && (
                                <p className="text-[10px] text-muted-foreground mt-0.5 font-mono">
                                  {selectedTrip.pickup_latitude.toFixed(6)}, {selectedTrip.pickup_longitude.toFixed(6)}
                                </p>
                              )}
                            </div>
                          </div>

                          {/* Dropoff */}
                          <div className="flex items-start gap-3 bg-red-500/10 dark:bg-red-900/20 rounded-lg p-3">
                            <div className="w-6 h-6 rounded-full bg-red-500 flex items-center justify-center shrink-0">
                              <span className="text-xs font-bold text-white">B</span>
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between">
                                <p className="text-xs font-medium text-red-700 dark:text-red-400">Dropoff</p>
                                {selectedTrip.completed_at && (
                                  <p className="text-xs text-muted-foreground">
                                    {format(new Date(selectedTrip.completed_at), 'h:mm a')}
                                  </p>
                                )}
                              </div>
                              <p className="text-sm">{selectedTrip.dropoff_address}</p>
                              {selectedTrip.dropoff_latitude && selectedTrip.dropoff_longitude && (
                                <p className="text-[10px] text-muted-foreground mt-0.5 font-mono">
                                  {selectedTrip.dropoff_latitude.toFixed(6)}, {selectedTrip.dropoff_longitude.toFixed(6)}
                                </p>
                              )}
                            </div>
                          </div>
                        </>
                      )}
                    </div>

                    {/* Driver Completion Location Warning */}
                    {selectedTrip.driver_location_lat && selectedTrip.driver_location_lng && (() => {
                      const dropoffLat = selectedTrip.dropoff_latitude;
                      const dropoffLng = selectedTrip.dropoff_longitude;
                      if (!dropoffLat || !dropoffLng) return null;
                      const dist = haversineDistance(selectedTrip.driver_location_lat!, selectedTrip.driver_location_lng!, dropoffLat, dropoffLng);
                      if (dist < 0.1) return null; // within 100m, no issue
                      return (
                        <div className="flex items-start gap-3 bg-amber-500/10 dark:bg-amber-900/20 rounded-lg p-3 border border-amber-500/30">
                          <div className="w-6 h-6 rounded-full bg-amber-500 flex items-center justify-center shrink-0">
                            <Navigation className="h-3 w-3 text-white" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
                              Driver Completion Location ({(dist).toFixed(2)} km from dropoff)
                            </p>
                            <p className="text-sm mt-0.5 text-muted-foreground">
                              Driver completed the trip {(dist).toFixed(2)} km away from the intended destination
                            </p>
                            <p className="text-[10px] text-muted-foreground mt-0.5 font-mono">
                              {selectedTrip.driver_location_lat!.toFixed(6)}, {selectedTrip.driver_location_lng!.toFixed(6)}
                            </p>
                          </div>
                        </div>
                      );
                    })()}
                  </div>

                  {/* Fare Breakdown */}
                  <div className="space-y-2">
                    <h4 className="text-sm font-semibold flex items-center gap-2">
                      <DollarSign className="h-4 w-4" />
                      Fare Breakdown
                    </h4>
                    <div className="bg-muted/50 rounded-lg p-4 space-y-2">
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Estimated Fare</span>
                        <span>{getCurrencySymbol(selectedTrip.currency_code)}{(selectedTrip.estimated_fare || 0).toFixed(2)}</span>
                      </div>
                      {selectedTrip.gross_fare_pence != null && (
                        <div className="flex justify-between text-sm">
                          <span className="text-muted-foreground">Gross Fare</span>
                          <span>{getCurrencySymbol(selectedTrip.currency_code)}{(selectedTrip.gross_fare_pence / 100).toFixed(2)}</span>
                        </div>
                      )}
                      {selectedTrip.commission_pence != null && (
                        <div className="flex justify-between text-sm">
                          <span className="text-muted-foreground">Commission</span>
                          <span className="text-orange-600">-{getCurrencySymbol(selectedTrip.currency_code)}{(selectedTrip.commission_pence / 100).toFixed(2)}</span>
                        </div>
                      )}
                      {selectedTrip.driver_net_pence != null && (
                        <div className="flex justify-between text-sm">
                          <span className="text-muted-foreground">Driver Net</span>
                          <span>{getCurrencySymbol(selectedTrip.currency_code)}{(selectedTrip.driver_net_pence / 100).toFixed(2)}</span>
                        </div>
                      )}
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Payment Status</span>
                        <Badge variant="outline" className="text-xs">
                          {selectedTrip.payment_status || 'unknown'}
                        </Badge>
                      </div>
                      <Separator />
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Estimated Distance</span>
                        <span>{formatDialogDistance(selectedTrip.estimated_distance_km)}</span>
                      </div>
                      {tripStops.length >= 2 && calculateRouteDistance(tripStops) > 0 && (
                        <div className="flex justify-between text-sm">
                          <span className="text-muted-foreground">Actual Distance</span>
                          <span className="font-medium text-primary">
                            {formatDialogDistance(calculateRouteDistance(tripStops))}
                          </span>
                        </div>
                      )}
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Duration</span>
                        <span>{formatDuration(selectedTrip.estimated_duration_minutes)}</span>
                      </div>
                      {selectedTrip.surge_multiplier && selectedTrip.surge_multiplier > 1 && (
                        <div className="flex justify-between text-sm">
                          <span className="text-muted-foreground">Surge Multiplier</span>
                          <span className="text-orange-600">{selectedTrip.surge_multiplier}x</span>
                        </div>
                      )}
                      <Separator />
                      <div className="flex justify-between font-semibold">
                        <span>Final Fare</span>
                        <span className="text-green-600">
                          {getCurrencySymbol(selectedTrip.currency_code)}{((selectedTrip.final_fare_pence ?? (selectedTrip.fare ? selectedTrip.fare * 100 : 0)) / 100).toFixed(2)}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Timestamps */}
                  <div className="grid grid-cols-2 gap-4 pt-2 border-t">
                    <div>
                      <Label className="text-muted-foreground text-xs">Started</Label>
                      <p className="text-sm font-medium">
                        {selectedTrip.started_at 
                          ? format(new Date(selectedTrip.started_at), 'MMMM do, yyyy h:mm a')
                          : 'N/A'}
                      </p>
                    </div>
                    <div>
                      <Label className="text-muted-foreground text-xs">Completed</Label>
                      <p className="text-sm font-medium">
                        {selectedTrip.completed_at 
                          ? format(new Date(selectedTrip.completed_at), 'MMMM do, yyyy h:mm a')
                          : 'N/A'}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Right Column - Map */}
                <div className="space-y-2">
                  <h4 className="text-sm font-semibold flex items-center gap-2">
                    <MapPin className="h-4 w-4" />
                    Route Map
                  </h4>
                  <div 
                    ref={mapContainerRef} 
                    className="h-[400px] lg:h-full min-h-[400px] rounded-lg border bg-muted"
                  >
                    {typeof window !== 'undefined' && !(window as any).google && (
                      <div className="flex items-center justify-center h-full text-muted-foreground">
                        <p className="text-sm">Map loading...</p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}
