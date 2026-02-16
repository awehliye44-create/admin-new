import { useEffect, useState, useRef, useCallback } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { 
  MapPin, Loader2, Search, RefreshCw, Car, Users, Circle, 
  Navigation, Phone, Star, Clock, Wifi, WifiOff
} from 'lucide-react';
import { toast } from 'sonner';
import { getOneCabCarIcon, getEnhancedCarIcon, preloadMarkerImage } from '@/lib/mapMarkers';

interface Driver {
  id: string;
  first_name: string;
  last_name: string;
  phone: string;
  email: string;
  is_online: boolean;
  rating: number;
  total_trips: number;
  approval_status: string;
  region_id: string;
  current_lat: number | null;
  current_lng: number | null;
  heading: number | null;
  speed: number | null;
  last_location_updated_at: string | null;
  region?: { name: string };
  current_trip?: {
    id: string;
    status: string;
    pickup_address: string;
    dropoff_address: string;
  } | null;
}

interface Region {
  id: string;
  name: string;
  geo_boundary: any;
}

interface ServiceArea {
  id: string;
  name: string;
  region_id: string;
}

declare global {
  interface Window {
    google: any;
  }
}

export default function FleetTracking() {
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [regions, setRegions] = useState<Region[]>([]);
  const [serviceAreas, setServiceAreas] = useState<ServiceArea[]>([]);
  const [driverServiceAreasMap, setDriverServiceAreasMap] = useState<Record<string, string[]>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [regionFilter, setRegionFilter] = useState('all');
  const [serviceAreaFilter, setServiceAreaFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [selectedDriver, setSelectedDriver] = useState<Driver | null>(null);
  const [isMapLoaded, setIsMapLoaded] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(new Date());
  
  const mapRef = useRef<HTMLDivElement>(null);
  const googleMapRef = useRef<any>(null);
  const markersRef = useRef<Map<string, any>>(new Map());
  const polygonsRef = useRef<Map<string, any>>(new Map());

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

  // Fetch data
  const fetchData = useCallback(async () => {
    try {
      setIsLoading(true);
      
      const driversRes = await supabase
        .from('drivers')
        .select('*, region:regions(name)')
        .eq('approval_status', 'approved')
        .order('is_online', { ascending: false });
      
      const regionsRes = await supabase
        .from('regions')
        .select('id, name, geo_boundary')
        .eq('status', 'active');
      
      // Fetch service areas
      // @ts-expect-error - Type instantiation too deep in generated Supabase types
      const { data: rawServiceAreas } = await supabase
        .from('service_areas')
        .select('id, name, region_id')
        .eq('status', 'active');
      
      const serviceAreasData: ServiceArea[] = (rawServiceAreas || []).map((sa: any) => ({
        id: sa.id as string,
        name: sa.name as string,
        region_id: sa.region_id as string
      }));
      
      const tripsRes = await supabase
        .from('trips')
        .select('id, driver_id, status, pickup_address, dropoff_address')
        .in('status', ['accepted', 'arrived', 'in_progress']);

      if (driversRes.error) throw driversRes.error;
      if (regionsRes.error) throw regionsRes.error;

      // Map active trips to drivers
      const activeTrips = tripsRes.data || [];
      const driversWithTrips = (driversRes.data || []).map(driver => {
        const currentTrip = activeTrips.find(t => t.driver_id === driver.id);
        return { ...driver, current_trip: currentTrip || null };
      });

      // Fetch driver service area assignments
      const driverIds = driversWithTrips.map(d => d.id);
      if (driverIds.length > 0) {
        const { data: dsaData } = await supabase
          .from('driver_service_areas')
          .select('driver_id, service_area_id')
          .in('driver_id', driverIds);
        
        if (dsaData) {
          const mapping: Record<string, string[]> = {};
          dsaData.forEach(item => {
            if (!mapping[item.driver_id]) {
              mapping[item.driver_id] = [];
            }
            mapping[item.driver_id].push(item.service_area_id);
          });
          setDriverServiceAreasMap(mapping);
        }
      }

      setDrivers(driversWithTrips);
      setRegions(regionsRes.data || []);
      setServiceAreas(serviceAreasData || []);
      setLastRefresh(new Date());
    } catch (err) {
      console.error('Error fetching fleet data:', err);
      toast.error('Failed to load fleet data');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    
    // Auto-refresh every 30 seconds
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  // Real-time driver location updates
  useEffect(() => {
    const channel = supabase
      .channel('driver-location-updates')
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'drivers',
        },
        (payload) => {
          const updatedDriver = payload.new as any;
          console.log('Driver location update received:', updatedDriver.id, updatedDriver.current_lat, updatedDriver.current_lng);
          
          setDrivers(prev => prev.map(driver => {
            if (driver.id === updatedDriver.id) {
              return {
                ...driver,
                current_lat: updatedDriver.current_lat,
                current_lng: updatedDriver.current_lng,
                heading: updatedDriver.heading,
                speed: updatedDriver.speed,
                is_online: updatedDriver.is_online,
                last_location_updated_at: updatedDriver.last_location_updated_at,
              };
            }
            return driver;
          }));
          
          setLastRefresh(new Date());
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  // Draw region boundaries on map
  useEffect(() => {
    if (!googleMapRef.current || !isMapLoaded) return;

    // Clear existing polygons
    polygonsRef.current.forEach(polygon => polygon.setMap(null));
    polygonsRef.current.clear();

    regions.forEach(region => {
      if (region.geo_boundary && Array.isArray(region.geo_boundary) && region.geo_boundary.length >= 3) {
        const polygon = new window.google.maps.Polygon({
          paths: region.geo_boundary,
          strokeColor: '#3b82f6',
          strokeOpacity: 0.5,
          strokeWeight: 2,
          fillColor: '#3b82f6',
          fillOpacity: 0.1,
          map: googleMapRef.current,
        });
        polygonsRef.current.set(region.id, polygon);
      }
    });
  }, [regions, isMapLoaded]);

  // Update driver markers with real GPS coordinates
  useEffect(() => {
    if (!googleMapRef.current || !isMapLoaded) return;

    // Clear existing markers
    markersRef.current.forEach(marker => marker.setMap(null));
    markersRef.current.clear();

    // Filter drivers
    const filtered = drivers.filter(driver => {
      const matchesSearch = 
        `${driver.first_name} ${driver.last_name}`.toLowerCase().includes(searchQuery.toLowerCase()) ||
        driver.phone.includes(searchQuery);
      const matchesRegion = regionFilter === 'all' || driver.region_id === regionFilter;
      const matchesServiceArea = serviceAreaFilter === 'all' || 
        (driverServiceAreasMap[driver.id]?.includes(serviceAreaFilter));
      const matchesStatus = statusFilter === 'all' || 
        (statusFilter === 'online' && driver.is_online) ||
        (statusFilter === 'offline' && !driver.is_online) ||
        (statusFilter === 'on_trip' && driver.current_trip);
      return matchesSearch && matchesRegion && matchesServiceArea && matchesStatus;
    });

    // Create markers for each driver
    filtered.forEach((driver) => {
      // Use real GPS coordinates if available, otherwise fallback to region center
      let position: { lat: number; lng: number } | null = null;
      
      if (driver.current_lat && driver.current_lng) {
        // Real GPS coordinates
        position = { lat: driver.current_lat, lng: driver.current_lng };
      } else {
        // Fallback: use region center if no GPS data
        const region = regions.find(r => r.id === driver.region_id);
        if (region?.geo_boundary?.[0]) {
          position = {
            lat: region.geo_boundary[0].lat,
            lng: region.geo_boundary[0].lng,
          };
        }
      }

      // Skip if no position available
      if (!position) return;

      // Determine if this driver is selected
      const isSelected = selectedDriver?.id === driver.id;
      const markerSize = isSelected ? 64 : 32;
      const zIndex = isSelected ? 1000 : driver.current_trip ? 100 : 1;

      const isOnTrip = !!driver.current_trip;
      const marker = new window.google.maps.Marker({
        position,
        map: googleMapRef.current,
        icon: getEnhancedCarIcon(markerSize as 32 | 64, driver.heading || 0, isOnTrip),
        title: `${driver.first_name} ${driver.last_name}${driver.speed ? ` (${Math.round(driver.speed * 3.6)} km/h)` : ''}`,
        optimized: false,
        zIndex,
      });

      marker.addListener('click', () => {
        setSelectedDriver(driver);
        
        // Pan to driver location
        if (googleMapRef.current && position) {
          googleMapRef.current.panTo(position);
          googleMapRef.current.setZoom(15);
        }
      });

      markersRef.current.set(driver.id, marker);
    });
  }, [drivers, regions, searchQuery, regionFilter, serviceAreaFilter, statusFilter, isMapLoaded, driverServiceAreasMap, selectedDriver]);

  // Filter service areas by selected region
  const filteredServiceAreas = regionFilter === 'all' 
    ? serviceAreas 
    : serviceAreas.filter(sa => sa.region_id === regionFilter);

  // Reset service area filter when region changes
  useEffect(() => {
    if (regionFilter !== 'all' && serviceAreaFilter !== 'all') {
      const isValidServiceArea = filteredServiceAreas.some(sa => sa.id === serviceAreaFilter);
      if (!isValidServiceArea) {
        setServiceAreaFilter('all');
      }
    }
  }, [regionFilter, filteredServiceAreas, serviceAreaFilter]);

  const filteredDrivers = drivers.filter(driver => {
    const matchesSearch = 
      `${driver.first_name} ${driver.last_name}`.toLowerCase().includes(searchQuery.toLowerCase()) ||
      driver.phone.includes(searchQuery);
    const matchesRegion = regionFilter === 'all' || driver.region_id === regionFilter;
    const matchesServiceArea = serviceAreaFilter === 'all' || 
      (driverServiceAreasMap[driver.id]?.includes(serviceAreaFilter));
    const matchesStatus = statusFilter === 'all' || 
      (statusFilter === 'online' && driver.is_online) ||
      (statusFilter === 'offline' && !driver.is_online) ||
      (statusFilter === 'on_trip' && driver.current_trip);
    return matchesSearch && matchesRegion && matchesServiceArea && matchesStatus;
  });

  const onlineCount = drivers.filter(d => d.is_online).length;
  const offlineCount = drivers.filter(d => !d.is_online).length;
  const onTripCount = drivers.filter(d => d.current_trip).length;

  return (
    <AdminLayout 
      title="Live Fleet Tracking" 
      description="Monitor your fleet in real-time"
    >
      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Total Drivers</p>
                <p className="text-2xl font-bold">{drivers.length}</p>
              </div>
              <Users className="h-8 w-8 text-primary opacity-80" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-green-500/30 bg-green-500/5">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Online</p>
                <p className="text-2xl font-bold text-green-600">{onlineCount}</p>
              </div>
              <Wifi className="h-8 w-8 text-green-500" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-amber-500/30 bg-amber-500/5">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">On Trip</p>
                <p className="text-2xl font-bold text-amber-600">{onTripCount}</p>
              </div>
              <Car className="h-8 w-8 text-amber-500" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-gray-500/30 bg-gray-500/5">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Offline</p>
                <p className="text-2xl font-bold text-gray-600">{offlineCount}</p>
              </div>
              <WifiOff className="h-8 w-8 text-gray-400" />
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Map Section */}
        <div className="lg:col-span-2">
          <Card className="h-full">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2">
                  <MapPin className="h-5 w-5 text-primary" />
                  Live Map
                </CardTitle>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    Last updated: {lastRefresh.toLocaleTimeString()}
                  </span>
                  <Button variant="outline" size="sm" onClick={fetchData} disabled={isLoading}>
                    <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
                  </Button>
                </div>
              </div>
              {/* Legend */}
              <div className="flex flex-wrap gap-4 text-xs mt-2">
                <span className="flex items-center gap-1">
                  <Navigation className="h-3 w-3 text-green-500" /> Live Tracking
                </span>
                <span className="flex items-center gap-1">
                  <Navigation className="h-3 w-3 text-amber-500" /> On Trip
                </span>
                <span className="flex items-center gap-1">
                  <Navigation className="h-3 w-3 text-gray-500" /> Stale Location
                </span>
                <span className="flex items-center gap-1">
                  <Circle className="h-3 w-3 fill-gray-400 text-gray-400" /> Offline
                </span>
              </div>
            </CardHeader>
            <CardContent>
              <div
                ref={mapRef}
                className="w-full h-[500px] rounded-lg border border-border overflow-hidden"
              />
            </CardContent>
          </Card>
        </div>

        {/* Driver List */}
        <div className="lg:col-span-1">
          <Card className="h-full">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2">
                <Users className="h-5 w-5 text-primary" />
                Drivers
              </CardTitle>
              <CardDescription>{filteredDrivers.length} drivers</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Filters */}
              <div className="space-y-2">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search drivers..."
                    className="pl-9"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Select value={regionFilter} onValueChange={setRegionFilter}>
                    <SelectTrigger>
                      <SelectValue placeholder="Region" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Regions</SelectItem>
                      {regions.map(region => (
                        <SelectItem key={region.id} value={region.id}>{region.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select 
                    value={serviceAreaFilter} 
                    onValueChange={setServiceAreaFilter}
                    disabled={filteredServiceAreas.length === 0}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Service Area" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Service Areas</SelectItem>
                      {filteredServiceAreas.map(area => (
                        <SelectItem key={area.id} value={area.id}>{area.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger>
                    <SelectValue placeholder="Status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Status</SelectItem>
                    <SelectItem value="online">Online</SelectItem>
                    <SelectItem value="on_trip">On Trip</SelectItem>
                    <SelectItem value="offline">Offline</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Driver List */}
              <div className="space-y-2 max-h-[400px] overflow-y-auto">
                {isLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="h-6 w-6 animate-spin text-primary" />
                  </div>
                ) : filteredDrivers.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    No drivers found
                  </div>
                ) : (
                  filteredDrivers.map(driver => (
                    <div
                      key={driver.id}
                      className={`p-3 rounded-lg border cursor-pointer transition-colors ${
                        selectedDriver?.id === driver.id 
                          ? 'border-primary bg-primary/5' 
                          : 'hover:bg-muted/50'
                      }`}
                      onClick={() => setSelectedDriver(driver)}
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium truncate">
                              {driver.first_name} {driver.last_name}
                            </span>
                            <Badge 
                              variant="outline" 
                              className={
                                !driver.is_online 
                                  ? 'bg-gray-100 text-gray-600 border-gray-200'
                                  : driver.current_trip 
                                    ? 'bg-amber-100 text-amber-700 border-amber-200'
                                    : 'bg-green-100 text-green-700 border-green-200'
                              }
                            >
                              {!driver.is_online ? 'Offline' : driver.current_trip ? 'On Trip' : 'Available'}
                            </Badge>
                          </div>
                          <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                            <span className="flex items-center gap-1">
                              <Phone className="h-3 w-3" />
                              {driver.phone}
                            </span>
                            <span className="flex items-center gap-1">
                              <Star className="h-3 w-3 text-yellow-500" />
                              {driver.rating?.toFixed(1) || '5.0'}
                            </span>
                          </div>
                          {driver.current_trip && (
                            <div className="mt-2 text-xs p-2 bg-amber-50 rounded border border-amber-100">
                              <div className="flex items-center gap-1 text-amber-700">
                                <Navigation className="h-3 w-3" />
                                {driver.current_trip.pickup_address?.slice(0, 30)}...
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Selected Driver Details */}
      {selectedDriver && (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Car className="h-5 w-5" />
              {selectedDriver.first_name} {selectedDriver.last_name}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
              <div className="p-3 bg-muted/50 rounded-lg">
                <p className="text-xs text-muted-foreground">Phone</p>
                <p className="font-medium">{selectedDriver.phone}</p>
              </div>
              <div className="p-3 bg-muted/50 rounded-lg">
                <p className="text-xs text-muted-foreground">Rating</p>
                <p className="font-medium flex items-center gap-1">
                  <Star className="h-4 w-4 text-yellow-500" />
                  {selectedDriver.rating?.toFixed(1) || '5.0'}
                </p>
              </div>
              <div className="p-3 bg-muted/50 rounded-lg">
                <p className="text-xs text-muted-foreground">Total Trips</p>
                <p className="font-medium">{selectedDriver.total_trips || 0}</p>
              </div>
              <div className="p-3 bg-muted/50 rounded-lg">
                <p className="text-xs text-muted-foreground">Region</p>
                <p className="font-medium">{selectedDriver.region?.name || 'Unknown'}</p>
              </div>
              <div className="p-3 bg-muted/50 rounded-lg">
                <p className="text-xs text-muted-foreground">GPS Location</p>
                {selectedDriver.current_lat && selectedDriver.current_lng ? (
                  <div>
                    <p className="font-medium text-xs">
                      {selectedDriver.current_lat.toFixed(5)}, {selectedDriver.current_lng.toFixed(5)}
                    </p>
                    {selectedDriver.last_location_updated_at && (
                      <p className="text-[10px] text-muted-foreground">
                        Updated: {new Date(selectedDriver.last_location_updated_at).toLocaleTimeString()}
                      </p>
                    )}
                    {selectedDriver.speed !== null && selectedDriver.speed !== undefined && (
                      <p className="text-[10px] text-muted-foreground">
                        Speed: {Math.round(selectedDriver.speed * 3.6)} km/h
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="font-medium text-muted-foreground">No GPS data</p>
                )}
              </div>
            </div>
            {selectedDriver.current_trip && (
              <div className="mt-4 p-4 border rounded-lg bg-amber-50 border-amber-200">
                <p className="font-medium text-amber-800 mb-2">Current Trip</p>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <p className="text-muted-foreground">Pickup</p>
                    <p>{selectedDriver.current_trip.pickup_address}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Dropoff</p>
                    <p>{selectedDriver.current_trip.dropoff_address}</p>
                  </div>
                </div>
                <Button 
                  variant="outline" 
                  size="sm" 
                  className="mt-3"
                  onClick={() => window.location.href = '/active-trips'}
                >
                  View Trip Details
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </AdminLayout>
  );
}
