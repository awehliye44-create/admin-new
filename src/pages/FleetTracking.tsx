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
import { ACTIVE_TRIP_DB_STATUSES } from '@/lib/activeTripStatuses';
import { 
  MapPin, Loader2, Search, RefreshCw, Car, Users, Circle, 
  Navigation, Phone, Star, Clock, Wifi, WifiOff
} from 'lucide-react';
import { toast } from 'sonner';
import { createCarMarkerElement, preloadMarkerImage } from '@/lib/mapMarkers';
import { useMapboxToken } from '@/hooks/useMapboxToken';
import { mapboxgl } from '@/lib/mapbox';
import { createMapboxMap } from '@/lib/mapboxMap';

interface Driver {
  id: string;
  first_name: string;
  last_name: string;
  phone: string;
  email: string;
  is_online: boolean;
  driver_online_intent?: boolean;
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
  /** SSOT from admin_driver_online_snapshot */
  fleet_state?: string | null;
  available_for_customer_request?: boolean;
  available_for_dispatch?: boolean;
  availability_exclusion_reason?: string | null;
  heartbeat_age_seconds?: number | null;
  location_age_seconds?: number | null;
  dispatchable_reason?: string | null;
  effective_online_reason?: string | null;
  platform?: string | null;
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

function fleetStatusLabel(driver: Driver): string {
  if (driver.current_trip) return 'On Trip';
  if (driver.available_for_dispatch) return 'Available';
  if (driver.fleet_state === 'ONLINE_DEGRADED' || driver.driver_online_intent) {
    return 'Online, not available';
  }
  if (driver.is_online) return 'Stale / not dispatchable';
  return 'Offline';
}

function fleetStatusBadgeClass(driver: Driver): string {
  if (driver.current_trip) return 'bg-amber-100 text-amber-700 border-amber-200';
  if (driver.available_for_dispatch) return 'bg-green-100 text-green-700 border-green-200';
  if (driver.driver_online_intent || driver.is_online) {
    return 'bg-orange-100 text-orange-700 border-orange-200';
  }
  return 'bg-gray-100 text-gray-600 border-gray-200';
}

function isDispatchableOnline(driver: Driver): boolean {
  return driver.available_for_dispatch === true && !driver.current_trip;
}

function isStaleOrUnavailable(driver: Driver): boolean {
  return !driver.current_trip
    && (driver.driver_online_intent === true || driver.is_online === true)
    && driver.available_for_dispatch !== true;
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
  const [mapTileError, setMapTileError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState(new Date());

  const { isReady: mapboxReady, error: mapboxError } = useMapboxToken();
  const mapInitError = mapboxError ?? mapTileError;
  const mapRef = useRef<HTMLDivElement>(null);
  const mapboxMapRef = useRef<mapboxgl.Map | null>(null);
  const markersRef = useRef<Map<string, mapboxgl.Marker>>(new Map());
  const regionLayerIdsRef = useRef<string[]>([]);

  // Preload marker image
  useEffect(() => {
    preloadMarkerImage();
  }, []);

  // Initialize Mapbox — always resolve web token before constructing Map
  useEffect(() => {
    if (!mapRef.current || mapboxMapRef.current) return;

    let cancelled = false;
    let detachResize: (() => void) | undefined;

    void (async () => {
      try {
        const { map, detachResize: detach } = await createMapboxMap({
          container: mapRef.current!,
          center: [-0.7594, 52.0406],
          zoom: 13,
          onLoad: () => {
            if (!cancelled) setIsMapLoaded(true);
          },
          onTileError: (msg) => {
            if (!cancelled) setMapTileError(msg);
          },
        });
        if (cancelled) {
          map.remove();
          detach();
          return;
        }
        detachResize = detach;
        map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right');
        mapboxMapRef.current = map;
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : 'Failed to initialize map';
        console.error('[FleetTracking]', msg);
        setMapTileError(msg);
      }
    })();

    return () => {
      cancelled = true;
      detachResize?.();
      mapboxMapRef.current?.remove();
      mapboxMapRef.current = null;
      setIsMapLoaded(false);
    };
  }, []);

  // Fetch data
  const fetchData = useCallback(async (isBackground = false) => {
    try {
      if (!isBackground) setIsLoading(true);
      
      // Fetch all data in parallel instead of sequentially
      const [driversRes, snapshotRes, regionsRes, serviceAreasRes, tripsRes] = await Promise.all([
        supabase
          .from('drivers')
          .select('*, region:regions(name)')
          .eq('approval_status', 'approved')
          .eq('documents_approved', true)
          .order('is_online', { ascending: false }),
        supabase
          .from('admin_driver_online_snapshot')
          .select(
            'id, fleet_state, available_for_customer_request, available_for_dispatch, availability_exclusion_reason, heartbeat_age_seconds, location_age_seconds, dispatchable_reason, effective_online_reason, platform, driver_online_intent, is_online, last_heartbeat_at, last_location_at',
          ),
        supabase
          .from('regions')
          .select('id, name, geo_boundary')
          .eq('status', 'active'),
        
        supabase
          .from('service_areas')
          .select('id, name, region_id')
          .eq('is_active', true),
        supabase
          .from('trips')
          .select('id, driver_id, status, pickup_address, dropoff_address')
          .in('status', [...ACTIVE_TRIP_DB_STATUSES]),
      ]);

      if (driversRes.error) throw driversRes.error;
      if (regionsRes.error) throw regionsRes.error;

      const snapshotById = new Map(
        (snapshotRes.data ?? []).map((row: Record<string, unknown>) => [String(row.id), row]),
      );

      const serviceAreasData: ServiceArea[] = (serviceAreasRes.data || []).map((sa: any) => ({
        id: sa.id as string,
        name: sa.name as string,
        region_id: sa.region_id as string
      }));

      // Map active trips to drivers
      const activeTrips = tripsRes.data || [];
      const driversWithTrips = (driversRes.data || []).map(driver => {
        const currentTrip = activeTrips.find(t => t.driver_id === driver.id);
        const snap = snapshotById.get(driver.id) as Record<string, unknown> | undefined;
        return {
          ...driver,
          current_trip: currentTrip || null,
          fleet_state: typeof snap?.fleet_state === 'string' ? snap.fleet_state : null,
          available_for_customer_request: snap?.available_for_customer_request === true,
          available_for_dispatch: snap?.available_for_dispatch === true,
          availability_exclusion_reason:
            typeof snap?.availability_exclusion_reason === 'string'
              ? snap.availability_exclusion_reason
              : null,
          heartbeat_age_seconds:
            typeof snap?.heartbeat_age_seconds === 'number' ? snap.heartbeat_age_seconds : null,
          location_age_seconds:
            typeof snap?.location_age_seconds === 'number' ? snap.location_age_seconds : null,
          dispatchable_reason:
            typeof snap?.dispatchable_reason === 'string' ? snap.dispatchable_reason : null,
          effective_online_reason:
            typeof snap?.effective_online_reason === 'string' ? snap.effective_online_reason : null,
          platform: typeof snap?.platform === 'string' ? snap.platform : null,
          driver_online_intent: snap?.driver_online_intent === true || driver.driver_online_intent === true,
        };
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
      if (!isBackground) toast.error('Failed to load fleet data');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    
    // Background refresh every 30s (no spinner)
    const interval = setInterval(() => fetchData(true), 30000);
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
    const map = mapboxMapRef.current;
    if (!map || !isMapLoaded) return;

    const apply = () => {
      // Clear existing region layers/sources
      for (const id of regionLayerIdsRef.current) {
        if (map.getLayer(`${id}-fill`)) map.removeLayer(`${id}-fill`);
        if (map.getLayer(`${id}-line`)) map.removeLayer(`${id}-line`);
        if (map.getSource(id)) map.removeSource(id);
      }
      regionLayerIdsRef.current = [];

      regions.forEach((region) => {
        const coords = region.geo_boundary;
        if (!Array.isArray(coords) || coords.length < 3) return;
        const ring: [number, number][] = coords.map((p: any) => [p.lng, p.lat]);
        // Close ring
        if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) {
          ring.push(ring[0]);
        }
        const sourceId = `region-${region.id}`;
        map.addSource(sourceId, {
          type: 'geojson',
          data: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } },
        });
        map.addLayer({
          id: `${sourceId}-fill`,
          type: 'fill',
          source: sourceId,
          paint: { 'fill-color': '#3b82f6', 'fill-opacity': 0.1 },
        });
        map.addLayer({
          id: `${sourceId}-line`,
          type: 'line',
          source: sourceId,
          paint: { 'line-color': '#3b82f6', 'line-width': 2, 'line-opacity': 0.5 },
        });
        regionLayerIdsRef.current.push(sourceId);
      });
    };

    if (map.isStyleLoaded()) apply();
    else map.once('load', apply);
  }, [regions, isMapLoaded]);

  // Update driver markers with real GPS coordinates
  useEffect(() => {
    const map = mapboxMapRef.current;
    if (!map || !isMapLoaded) return;

    // Clear existing markers
    markersRef.current.forEach((m) => m.remove());
    markersRef.current.clear();

    // Filter drivers
    const filtered = drivers.filter((driver) => {
      const matchesSearch =
        `${driver.first_name} ${driver.last_name}`.toLowerCase().includes(searchQuery.toLowerCase()) ||
        driver.phone.includes(searchQuery);
      const matchesRegion = regionFilter === 'all' || driver.region_id === regionFilter;
      const matchesServiceArea =
        serviceAreaFilter === 'all' ||
        driverServiceAreasMap[driver.id]?.includes(serviceAreaFilter);
      const matchesStatus =
        statusFilter === 'all' ||
        (statusFilter === 'online' && isDispatchableOnline(driver)) ||
        (statusFilter === 'offline' && !driver.is_online && !driver.driver_online_intent) ||
        (statusFilter === 'on_trip' && driver.current_trip) ||
        (statusFilter === 'stale' && isStaleOrUnavailable(driver));
      return matchesSearch && matchesRegion && matchesServiceArea && matchesStatus;
    });

    // Create markers for each driver
    filtered.forEach((driver) => {
      let position: { lat: number; lng: number } | null = null;

      if (driver.current_lat && driver.current_lng) {
        position = { lat: driver.current_lat, lng: driver.current_lng };
      } else {
        const region = regions.find((r) => r.id === driver.region_id);
        if (region?.geo_boundary?.[0]) {
          position = {
            lat: region.geo_boundary[0].lat,
            lng: region.geo_boundary[0].lng,
          };
        }
      }
      if (!position) return;

      const isSelected = selectedDriver?.id === driver.id;
      const markerSize = isSelected ? 64 : 32;
      const isOnTrip = !!driver.current_trip;

      const el = createCarMarkerElement(markerSize as 32 | 64, isOnTrip);
      el.title = `${driver.first_name} ${driver.last_name}${driver.speed ? ` (${Math.round(driver.speed * 3.6)} km/h)` : ''}`;
      el.style.zIndex = String(isSelected ? 1000 : isOnTrip ? 100 : 1);

      const marker = new mapboxgl.Marker({
        element: el,
        rotation: driver.heading || 0,
        rotationAlignment: 'map',
      })
        .setLngLat([position.lng, position.lat])
        .addTo(map);

      el.addEventListener('click', () => {
        setSelectedDriver(driver);
        if (mapboxMapRef.current && position) {
          mapboxMapRef.current.flyTo({ center: [position.lng, position.lat], zoom: 15 });
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
      (statusFilter === 'online' && isDispatchableOnline(driver)) ||
      (statusFilter === 'offline' && !driver.is_online && !driver.driver_online_intent) ||
      (statusFilter === 'on_trip' && driver.current_trip) ||
      (statusFilter === 'stale' && isStaleOrUnavailable(driver));
    return matchesSearch && matchesRegion && matchesServiceArea && matchesStatus;
  });

  const onlineCount = drivers.filter(isDispatchableOnline).length;
  const staleCount = drivers.filter(isStaleOrUnavailable).length;
  const offlineCount = drivers.filter(d => !d.is_online && !d.driver_online_intent && !d.current_trip).length;
  const onTripCount = drivers.filter(d => d.current_trip).length;

  return (
    <AdminLayout 
      title="Live Fleet Tracking" 
      description="Monitor your fleet in real-time"
    >
      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
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
                <p className="text-sm text-muted-foreground">Dispatchable</p>
                <p className="text-2xl font-bold text-green-600">{onlineCount}</p>
              </div>
              <Wifi className="h-8 w-8 text-green-500" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-orange-500/30 bg-orange-500/5">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Stale / N/A</p>
                <p className="text-2xl font-bold text-orange-600">{staleCount}</p>
              </div>
              <Clock className="h-8 w-8 text-orange-500" />
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
                  <Button variant="outline" size="sm" onClick={() => fetchData()} disabled={isLoading}>
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
              {mapInitError && (
                <div
                  role="alert"
                  className="mb-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                >
                  Map unavailable: {mapInitError}. Set VITE_MAPBOX_WEB_TOKEN in .env.local (restart dev server) or
                  MAPBOX_WEB_TOKEN on Supabase for Lovable/production.
                </div>
              )}
              <div className="relative w-full min-h-[500px] h-[calc(100vh-200px)] max-h-[720px] rounded-lg border border-border overflow-hidden">
                <div ref={mapRef} className="absolute inset-0" />
                {!mapboxReady && !mapInitError && (
                  <div className="absolute inset-0 z-10 flex items-center justify-center bg-muted/80 text-muted-foreground">
                    <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                    Loading map token…
                  </div>
                )}
                {mapboxReady && !isMapLoaded && !mapInitError && (
                  <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-muted/50 text-muted-foreground">
                    <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                    Loading map tiles…
                  </div>
                )}
              </div>
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
                    <SelectItem value="online">Dispatchable</SelectItem>
                    <SelectItem value="stale">Stale / Not available</SelectItem>
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
                              className={fleetStatusBadgeClass(driver)}
                            >
                              {fleetStatusLabel(driver)}
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
                            {driver.heartbeat_age_seconds != null && (
                              <span className="flex items-center gap-1">
                                <Clock className="h-3 w-3" />
                                HB {driver.heartbeat_age_seconds}s
                              </span>
                            )}
                          </div>
                          {driver.availability_exclusion_reason && !driver.available_for_dispatch && (
                            <div className="mt-1 text-[10px] text-orange-700">
                              {driver.availability_exclusion_reason}
                            </div>
                          )}
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
