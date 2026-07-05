import React, { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { usePageLoadTelemetry } from '@/hooks/useAdminTelemetry';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';
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
import { useRegions } from '@/hooks/useRegions';
import { useServiceAreas as useSharedServiceAreas } from '@/hooks/useServiceAreas';
import { 
  History, Loader2, Search, RefreshCw, MapPin, Phone,
  CheckCircle, Route, DollarSign, Clock,
  Navigation, User, Car, Globe, Settings2, AlertTriangle, Briefcase
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { getSingleCurrency } from '@/components/finance/CurrencyGroupedStats';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { format, subDays, startOfDay, endOfDay } from 'date-fns';
import { toast } from 'sonner';
import { getCurrencySymbol, formatDistance as formatDistanceUtil, getDistanceUnitShort } from '@/lib/regionSettings';
import { TripInvoiceCard, TripInvoiceStatusBadge } from '@/components/trips/TripInvoiceCard';
import { TripHistoryRowActions } from '@/components/trips/TripHistoryRowActions';
import { getTripDisplayId } from '@/lib/tripUtils';
import { resolveTripDisplayFare } from '@/lib/fareDisplaySSOT';
import {
  captureStatusColorClass,
  getTripCaptureStatus,
  isCardTrip,
  summarizeTripPayments,
} from '@/lib/tripCaptureStatus';
import { FinancialReconciliationTripLink } from '@/components/finance/FinancialReconciliationTripLink';
import { FinanceRecoveryPanel } from '@/components/payment/FinanceRecoveryPanel';
import { SyncStripeRefundButton } from '@/components/payment/SyncStripeRefundButton';
import { getTripRefundDisplay } from '@/lib/tripRefundDisplay';
import { useMapboxToken } from '@/hooks/useMapboxToken';
import { mapboxgl } from '@/lib/mapbox';
import { createMapboxMap } from '@/lib/mapboxMap';
import { fetchTripHistoryRows } from '@/lib/tripHistoryQuery';
import { fetchTripsCaptureSsot } from '@/hooks/financeReconciliationApi';

function getTripMapCenter(trip: CompletedTrip): [number, number] {
  const lng = trip.pickup_longitude ?? trip.dropoff_longitude ?? -0.7594;
  const lat = trip.pickup_latitude ?? trip.dropoff_latitude ?? 52.0406;
  return [lng, lat];
}

function scheduleDialogMapResize(map: mapboxgl.Map): void {
  const doResize = () => {
    try {
      map.resize();
    } catch {
      /* map may be removed */
    }
  };
  requestAnimationFrame(() => {
    doResize();
    window.setTimeout(doResize, 100);
    window.setTimeout(doResize, 350);
  });
}

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
  financial_outcome: string | null;
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
  final_customer_fare_pence: number | null;
  capture_amount_pence: number | null;
  stripe_processing_fee_pence: number | null;
  onecab_net_pence: number | null;
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
  stacked_trip_id: string | null;
  corporate_account_id: string | null;
  corporate_account?: { id: string; company_name: string } | null;
  // Fare Engine source-of-truth fields
  pricing_mode: string | null;
  fare_locked: boolean | null;
  vehicle_type_id: string | null;
  vehicle_type: string | null;
  service_area_id: string | null;
  fare_engine_config_id: string | null;
  // Waiting & fare breakdown fields
  waiting_charge_pence: number | null;
  pickup_waiting_charge_pence: number | null;
  total_waiting_charge_pence: number | null;
  waiting_minutes: number | null;
  fare_breakdown: Record<string, unknown> | null;
  tip_pence: number | null;
  tip_amount_pence: number | null;
  driver?: {
    id: string;
    first_name: string;
    last_name: string;
    phone: string;
    driver_code: string | null;
    region_id: string | null;
  } | null;
  /** Joined from service_areas → regions for currency resolution */
  service_area_join?: {
    region_id?: string | null;
    region?: {
      currency_code: string;
      distance_unit: string;
    } | null;
  } | null;
  // Joined trip_stops for display
  trip_stops?: TripStop[];
  // Joined from payments table — settlement source of truth
  payment_captured_pence?: number | null;
  payment_authorized_pence?: number | null;
  payment_tip_pence?: number | null;
  payment_count?: number;
  has_shortfall_payment_intent?: boolean;
  payment_lifecycle_fees_pence?: number | null;
  payment_metadata_lifecycle_fees_pence?: number | null;
  arrival_cancellation_applied?: boolean | null;
  arrival_cancellation_fee?: number | null;
  settlement_total_pence?: number | null;
  ledger_trip_earning_net_pence?: number | null;
  invoice_no: string | null;
  invoice_pdf_url: string | null;
  invoice_generated_at: string | null;
  invoice_email_sent: boolean | null;
  invoice_email_sent_at: string | null;
  invoice_email_status: string | null;
  invoice_email_error: string | null;
  invoice_pdf_error: string | null;
  invoice_total_paid_pence: number | null;
  invoice_regenerated_at: string | null;
}

export default function TripHistory() {
  usePageLoadTelemetry('TripHistory');
  const { session, isAuthReady } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  
  const [searchQuery, setSearchQuery] = useState('');
  const [dateFilter, setDateFilter] = useState('7days');

  // Region and Service Area filters
  const [selectedRegionId, setSelectedRegionId] = useState<string>('all');
  const [selectedServiceAreaId, setSelectedServiceAreaId] = useState<string>('all');
  const [corporateFilter, setCorporateFilter] = useState<string>('all');

  // Dialog states
  const [isViewOpen, setIsViewOpen] = useState(false);
  const [selectedTrip, setSelectedTrip] = useState<CompletedTrip | null>(null);
  const [tripStops, setTripStops] = useState<TripStop[]>([]);
  const [isLoadingStops, setIsLoadingStops] = useState(false);
  const [selectedServiceArea, setSelectedServiceArea] = useState<ServiceArea | null>(null);

  // Map state
  const [isMapLoaded, setIsMapLoaded] = useState(false);
  const [mapTileError, setMapTileError] = useState<string | null>(null);
  const { isReady: mapboxReady, error: mapboxError } = useMapboxToken();
  const mapInitError = mapboxError ?? mapTileError;
  const [mapContainerEl, setMapContainerEl] = useState<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const markersRef = useRef<mapboxgl.Marker[]>([]);
  const routeSourceIdRef = useRef<string>('trip-history-route');
  const tripStopsRef = useRef(tripStops);
  const selectedTripRef = useRef(selectedTrip);

  useEffect(() => {
    tripStopsRef.current = tripStops;
  }, [tripStops]);

  useEffect(() => {
    selectedTripRef.current = selectedTrip;
  }, [selectedTrip]);

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

  // Use shared cached hooks for regions/service areas
  const { data: sharedRegions = [] } = useRegions();
  const { data: sharedServiceAreas = [] } = useSharedServiceAreas({ activeOnly: true });

  const regions = sharedRegions as any[];
  const serviceAreas = sharedServiceAreas as any[];

  const activeRegion = useMemo(() => {
    if (selectedRegionId === 'all') return null;
    return regions.find(r => r.id === selectedRegionId) || null;
  }, [selectedRegionId, regions]);

  // Reset service area when region changes
  useEffect(() => {
    setSelectedServiceAreaId('all');
  }, [selectedRegionId]);

  // React Query for trip data
  const { data: trips = [], isLoading, isError, error, refetch } = useQuery({
    queryKey: ['trip-history', dateFilter, selectedRegionId, selectedServiceAreaId, corporateFilter, session?.access_token],
    enabled: isAuthReady && Boolean(session?.access_token),
    queryFn: async () => {
      const { start, end } = getDateRange();

      const tripsData = await fetchTripHistoryRows({
        start,
        end,
        regionId: selectedRegionId !== 'all' ? selectedRegionId : undefined,
        serviceAreaId: selectedServiceAreaId !== 'all' ? selectedServiceAreaId : undefined,
      });

      const tripIds = tripsData.map((t) => t.id);
      
      let stopsMap: Record<string, TripStop[]> = {};
      if (tripIds.length > 0) {
        const { data: stopsData, error: stopsError } = await supabase
          .from('trip_stops')
          .select('id, trip_id, stop_index, address, lat, lng, type, status, arrived_at, completed_at')
          .in('trip_id', tripIds)
          .order('stop_index', { ascending: true });

        if (!stopsError && stopsData) {
          stopsMap = stopsData.reduce((acc, stop) => {
            if (!acc[stop.trip_id]) acc[stop.trip_id] = [];
            acc[stop.trip_id].push(stop);
            return acc;
          }, {} as Record<string, TripStop[]>);
        }
      }

      // Fetch payments — captured_amount_pence is the settlement source of truth for card trips
      let paymentsMap: Record<string, {
        captured: number;
        authorized: number | null;
        tip: number | null;
        count: number;
        hasShortfallPi: boolean;
        lifecycleFees: number;
        metadataLifecycleFees: number;
      }> = {};
      if (tripIds.length > 0) {
        const { data: paymentsData } = await supabase
          .from('payments')
          .select('trip_id, amount_pence, captured_amount_pence, status, fee_type, updated_at, metadata')
          .in('trip_id', tripIds)
          .order('updated_at', { ascending: false });
        if (paymentsData) {
          for (const p of paymentsData as any[]) {
            const summary = summarizeTripPayments([p]);
            const rowCaptured = summary.capturedTotalPence ?? 0;
            const existing = paymentsMap[p.trip_id];
            if (!existing) {
              paymentsMap[p.trip_id] = {
                captured: rowCaptured,
                authorized: p.amount_pence ?? null,
                tip: summary.tipFromMeta,
                count: 1,
                hasShortfallPi: summary.hasShortfallPaymentIntent,
                lifecycleFees: summary.lifecycleFeesPence,
                metadataLifecycleFees: summary.metadataLifecycleFeesPence,
              };
            } else {
              existing.captured += rowCaptured;
              existing.count += 1;
              existing.hasShortfallPi = existing.hasShortfallPi || summary.hasShortfallPaymentIntent;
              existing.lifecycleFees += summary.lifecycleFeesPence;
              existing.metadataLifecycleFees += summary.metadataLifecycleFeesPence;
              if (existing.tip == null && summary.tipFromMeta != null) {
                existing.tip = summary.tipFromMeta;
              }
            }
          }
        }
      }

      const captureSsotRows = tripIds.length > 0
        ? await fetchTripsCaptureSsot(tripIds).catch((captureErr) => {
            console.warn('[TripHistory] Capture SSOT optional fetch failed:', captureErr);
            return [];
          })
        : [];
      const captureByTrip = new Map(captureSsotRows.map((r) => [r.trip_id, r]));

      return tripsData.map((trip) => {
        const pay = paymentsMap[trip.id];
        const capture = captureByTrip.get(trip.id);
        return {
          ...trip,
          trip_stops: stopsMap[trip.id] || [],
          payment_captured_pence: pay && pay.captured > 0 ? pay.captured : null,
          payment_authorized_pence: pay?.authorized ?? null,
          payment_tip_pence: pay?.tip ?? null,
          payment_count: pay?.count ?? 0,
          has_shortfall_payment_intent: pay?.hasShortfallPi ?? false,
          payment_lifecycle_fees_pence: pay?.lifecycleFees ?? 0,
          payment_metadata_lifecycle_fees_pence: pay?.metadataLifecycleFees ?? 0,
          settlement_total_pence: capture?.settlement_total_pence ?? null,
          ledger_trip_earning_net_pence: capture?.ledger_trip_earning_net_pence ?? null,
          invoice_no: (trip.invoice_no as string | null | undefined) ?? null,
          invoice_pdf_url: (trip.invoice_pdf_url as string | null | undefined) ?? null,
          invoice_generated_at: (trip.invoice_generated_at as string | null | undefined) ?? null,
          invoice_email_sent: (trip.invoice_email_sent as boolean | null | undefined) ?? null,
          invoice_email_sent_at: (trip.invoice_email_sent_at as string | null | undefined) ?? null,
          invoice_email_status: (trip.invoice_email_status as string | null | undefined) ?? null,
          invoice_email_error: (trip.invoice_email_error as string | null | undefined) ?? null,
          invoice_pdf_error: (trip.invoice_pdf_error as string | null | undefined) ?? null,
          invoice_total_paid_pence: (trip.invoice_total_paid_pence as number | null | undefined) ?? null,
          invoice_regenerated_at: (trip.invoice_regenerated_at as string | null | undefined) ?? null,
        };
      }) as CompletedTrip[];
    },
    staleTime: 30_000,
  });

  const fetchData = useCallback(() => {
    void refetch();
  }, [refetch]);

  const fetchTripStops = async (tripId: string) => {
    try {
      setIsLoadingStops(true);
      const { data, error } = await supabase
        .from('trip_stops')
        .select('id, trip_id, stop_index, address, lat, lng, type, status, arrived_at, completed_at')
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

  // Deep-link: /trip-history?trip=CODE or ?tripId=uuid (&recover=1 opens finance recovery)
  useEffect(() => {
    if (isLoading || trips.length === 0) return;
    const tripCode = searchParams.get('trip');
    const tripId = searchParams.get('tripId');
    if (!tripCode && !tripId) return;

    const match = trips.find((t) => {
      if (tripId && t.id === tripId) return true;
      if (tripCode) {
        const code = tripCode.trim().toLowerCase();
        return (
          t.trip_code?.toLowerCase() === code
          || t.trip_number?.toLowerCase() === code
          || getTripDisplayId(t).toLowerCase() === code
        );
      }
      return false;
    });
    if (!match || (selectedTrip?.id === match.id && isViewOpen)) return;

    void (async () => {
      await handleViewTrip(match);
      const next = new URLSearchParams(searchParams);
      next.delete('trip');
      next.delete('tripId');
      if (next.toString() !== searchParams.toString()) {
        setSearchParams(next, { replace: true });
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deep-link once when trips load
  }, [isLoading, trips, searchParams]);

  const drawTripRouteOnMap = useCallback((map: mapboxgl.Map) => {
    const trip = selectedTripRef.current;
    const stops = tripStopsRef.current;
    if (!trip) return;

    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];

    const bounds = new mapboxgl.LngLatBounds();
    const path: [number, number][] = [];

    const addCircleMarker = (lng: number, lat: number, color: string, title: string, label?: string) => {
      const el = document.createElement('div');
      el.style.width = '20px'; el.style.height = '20px'; el.style.borderRadius = '50%';
      el.style.background = color; el.style.border = '2px solid #ffffff';
      el.style.boxShadow = '0 1px 4px rgba(0,0,0,0.4)';
      el.style.display = 'flex'; el.style.alignItems = 'center'; el.style.justifyContent = 'center';
      el.style.color = '#fff'; el.style.fontSize = '11px'; el.style.fontWeight = 'bold';
      if (label) el.textContent = label;
      el.title = title;
      const marker = new mapboxgl.Marker({ element: el }).setLngLat([lng, lat]).addTo(map);
      markersRef.current.push(marker);
    };

    if (trip.pickup_latitude && trip.pickup_longitude) {
      addCircleMarker(trip.pickup_longitude, trip.pickup_latitude, '#22c55e', 'Pickup');
      path.push([trip.pickup_longitude, trip.pickup_latitude]);
      bounds.extend([trip.pickup_longitude, trip.pickup_latitude]);
    }

    stops
      .filter((s) => s.type !== 'pickup' && s.type !== 'dropoff' && s.lat && s.lng)
      .forEach((stop, idx) => {
        addCircleMarker(stop.lng!, stop.lat!, '#3b82f6', `Stop ${idx + 1}`, String(idx + 1));
        path.push([stop.lng!, stop.lat!]);
        bounds.extend([stop.lng!, stop.lat!]);
      });

    if (trip.dropoff_latitude && trip.dropoff_longitude) {
      addCircleMarker(trip.dropoff_longitude, trip.dropoff_latitude, '#ef4444', 'Dropoff');
      path.push([trip.dropoff_longitude, trip.dropoff_latitude]);
      bounds.extend([trip.dropoff_longitude, trip.dropoff_latitude]);
    }

    if (trip.driver_location_lat && trip.driver_location_lng) {
      const dLat = trip.driver_location_lat;
      const dLng = trip.driver_location_lng;
      const dropL = trip.dropoff_latitude;
      const dropG = trip.dropoff_longitude;
      let show = true;
      if (dropL && dropG) {
        const dist = haversineDistance(dLat, dLng, dropL, dropG);
        if (dist < 0.1) show = false;
      }
      if (show) {
        addCircleMarker(dLng, dLat, '#f59e0b', 'Driver Completion Location');
        bounds.extend([dLng, dLat]);
      }
    }

    const srcId = routeSourceIdRef.current;
    const layerId = `${srcId}-layer`;
    const lineData: GeoJSON.Feature<GeoJSON.LineString> = {
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: path },
    };
    const existing = map.getSource(srcId) as mapboxgl.GeoJSONSource | undefined;
    if (existing) {
      existing.setData(
        path.length >= 2
          ? lineData
          : ({ type: 'FeatureCollection', features: [] } as unknown as GeoJSON.Feature<GeoJSON.LineString>),
      );
    } else if (path.length >= 2) {
      map.addSource(srcId, { type: 'geojson', data: lineData });
      map.addLayer({
        id: layerId,
        type: 'line',
        source: srcId,
        paint: { 'line-color': '#6366f1', 'line-width': 4, 'line-opacity': 0.8 },
      });
    }

    if (path.length > 0 && !bounds.isEmpty()) {
      map.fitBounds(bounds, { padding: 50, animate: false });
    }
  }, []);

  // Initialize route map when dialog container mounts (Radix Dialog mounts after isViewOpen)
  useEffect(() => {
    if (!mapboxReady || !isViewOpen || !selectedTrip || !mapContainerEl) return;

    let cancelled = false;
    let detachResize: (() => void) | undefined;

    setMapTileError(null);
    setIsMapLoaded(false);

    const initTimer = window.setTimeout(() => {
      if (cancelled || !mapContainerEl) return;

      void (async () => {
        try {
          const center = getTripMapCenter(selectedTrip);
          const { map, detachResize: detach } = await createMapboxMap({
            container: mapContainerEl,
            center,
            zoom: 13,
            onLoad: (m) => {
              if (!cancelled) {
                setIsMapLoaded(true);
                scheduleDialogMapResize(m);
              }
            },
            onIdle: (m) => {
              if (!cancelled) drawTripRouteOnMap(m);
            },
            onTileError: (msg) => {
              if (!cancelled) {
                setMapTileError(msg);
                setIsMapLoaded(true);
              }
            },
            onLoadTimeout: () => {
              if (!cancelled) {
                setMapTileError(
                  'Map tiles did not load in time. Confirm VITE_MAPBOX_WEB_TOKEN in Lovable and allow adminonecab.net on the Mapbox token.',
                );
                setIsMapLoaded(true);
              }
            },
          });
          if (cancelled) {
            map.remove();
            detach();
            return;
          }
          detachResize = detach;
          map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right');
          mapRef.current = map;
          scheduleDialogMapResize(map);
        } catch (err) {
          if (cancelled) return;
          const msg = err instanceof Error ? err.message : 'Failed to initialize map';
          console.error('[TripHistory] route map', msg);
          setMapTileError(msg);
          setIsMapLoaded(true);
        }
      })();
    }, 150);

    return () => {
      cancelled = true;
      window.clearTimeout(initTimer);
      detachResize?.();
      markersRef.current.forEach((m) => m.remove());
      markersRef.current = [];
      mapRef.current?.remove();
      mapRef.current = null;
      setIsMapLoaded(false);
    };
  }, [mapboxReady, isViewOpen, selectedTrip?.id, mapContainerEl, drawTripRouteOnMap]);

  // Redraw markers/route when trip stops arrive after map is ready
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapLoaded || !selectedTrip) return;
    if (map.isStyleLoaded()) drawTripRouteOnMap(map);
    else map.once('load', () => drawTripRouteOnMap(map));
  }, [selectedTrip, tripStops, isMapLoaded, drawTripRouteOnMap]);

  const formatDuration = (minutes: number | null) => {
    if (!minutes) return 'N/A';
    const hrs = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
  };

  const getTripDurationMinutes = (trip: CompletedTrip): number | null => {
    if (trip.estimated_duration_minutes != null && trip.estimated_duration_minutes > 0) {
      return trip.estimated_duration_minutes;
    }
    if (trip.started_at && trip.completed_at) {
      const mins = Math.round(
        (new Date(trip.completed_at).getTime() - new Date(trip.started_at).getTime()) / 60000,
      );
      return mins > 0 ? mins : null;
    }
    return null;
  };

  /** Expected customer payable (not Stripe captured). */
  const getTripCustomerPayablePence = (trip: CompletedTrip): number => {
    const finalCustomer = trip.final_customer_fare_pence ?? 0;
    const waiting =
      trip.total_waiting_charge_pence
      ?? trip.waiting_charge_pence
      ?? trip.pickup_waiting_charge_pence
      ?? 0;
    if (finalCustomer > 0) return finalCustomer + Math.max(0, waiting);
    return resolveTripDisplayFare(trip).payable_pence;
  };

  /** Stripe actual captured amount only. */
  const getTripStripeCapturedPence = (trip: CompletedTrip): number => {
    if (trip.payment_captured_pence != null && trip.payment_captured_pence > 0) {
      return trip.payment_captured_pence;
    }
    if (trip.capture_amount_pence != null && trip.capture_amount_pence > 0) {
      return trip.capture_amount_pence;
    }
    return 0;
  };

  /** @deprecated label — use payable vs captured explicitly */
  const getTripCustomerPaidPence = (trip: CompletedTrip): number =>
    getTripStripeCapturedPence(trip) > 0
      ? getTripStripeCapturedPence(trip)
      : getTripCustomerPayablePence(trip);

  const getTripCustomerPaidPounds = (trip: CompletedTrip): number =>
    getTripCustomerPaidPence(trip) / 100;

  const getTripStatusLabel = (trip: CompletedTrip): string => {
    if (trip.status === 'no_show') return 'No Show';
    if (trip.status === 'cancelled') return 'Cancelled';
    if (trip.financial_outcome === 'LATE_PASSENGER_CANCELLATION') return 'Late cancellation';
    return 'Completed';
  };

  /**
   * Resolve currency for a specific trip.
   * Priority: service_area → region (single source of truth), then trip snapshot, then active region filter.
   */
  const resolveTripCurrency = (trip: CompletedTrip): string => {
    return trip.service_area_join?.region?.currency_code
      || trip.currency_code
      || activeRegion?.currency_code
      || '';
  };

  // Get the active currency symbol — Region is the single source of truth for currency
  const getActiveCurrencySymbol = () => {
    if (activeRegion) {
      return getCurrencySymbol(activeRegion.currency_code);
    }
    return getCurrencySymbol('');
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
    let unit = activeRegion?.distance_unit || 'km'; // Default to km, resolved from Region
    
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
    
    // Region filter — trip service area (SSOT) with driver region fallback
    if (selectedRegionId !== 'all') {
      const tripRegionId =
        trip.service_area_join?.region_id
        ?? serviceAreas.find(sa => sa.id === trip.service_area_id)?.region_id
        ?? trip.driver?.region_id
        ?? null;
      if (tripRegionId !== selectedRegionId) {
        return false;
      }
    }

    if (selectedServiceAreaId !== 'all' && trip.service_area_id !== selectedServiceAreaId) {
      return false;
    }

    if (corporateFilter === 'corporate' && !trip.corporate_account_id) return false;
    if (corporateFilter === 'personal' && trip.corporate_account_id) return false;
    if (corporateFilter !== 'all' && corporateFilter !== 'corporate' && corporateFilter !== 'personal' && trip.corporate_account_id !== corporateFilter) return false;

    return matchesSearch;
  });

  // Unique corporate accounts present in current trip set (for filter dropdown)
  const corporateAccountsInTrips = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of trips) {
      if (t.corporate_account_id && t.corporate_account?.company_name) {
        map.set(t.corporate_account_id, t.corporate_account.company_name);
      }
    }
    return Array.from(map.entries()).map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [trips]);

  const multiStopTrips = filteredTrips.filter(t => isMultiStopTrip(t)).length;

  const totalCustomerPaid = filteredTrips.reduce(
    (sum, t) => sum + getTripCustomerPaidPence(t) / 100,
    0,
  );
  const avgCustomerPaid = filteredTrips.length > 0 ? totalCustomerPaid / filteredTrips.length : 0;

  // Resolve a single currency across all filtered trips for the stats widgets
  const statsCurrencyItems = filteredTrips.map(t => ({ currency_code: resolveTripCurrency(t) || '???' }));
  const singleStatsCurrency = getSingleCurrency(statsCurrencyItems);
  const isMixedCurrency = !singleStatsCurrency && filteredTrips.length > 0;
  const statsSymbol = getCurrencySymbol(singleStatsCurrency || activeRegion?.currency_code || '');

  return (
    <AdminLayout 
      title="Trip History" 
      description="View completed and no-show trips with route and fare details"
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
                  {isMixedCurrency ? 'Mixed currencies' : `${statsSymbol}${totalCustomerPaid.toFixed(2)}`}
                </p>
              </div>
              <DollarSign className="h-8 w-8 text-green-500 opacity-80" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Average Fare</p>
                <p className="text-2xl font-bold">
                  {isMixedCurrency ? '—' : `${statsSymbol}${avgCustomerPaid.toFixed(2)}`}
                </p>
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
              Finished rides (completed / no-show) by completion date — customer fare from backend SSOT; commission &amp; Stripe fees in Financial Reconciliation
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
            <Select value={corporateFilter} onValueChange={setCorporateFilter}>
              <SelectTrigger className="w-full md:w-[170px]">
                <Briefcase className="h-4 w-4 mr-2 text-muted-foreground" />
                <SelectValue placeholder="Account Type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Trips</SelectItem>
                <SelectItem value="corporate">Corporate Only</SelectItem>
                <SelectItem value="personal">Personal Only</SelectItem>
                {corporateAccountsInTrips.length > 0 && (
                  <>
                    <div className="px-2 py-1 text-xs text-muted-foreground">Companies</div>
                    {corporateAccountsInTrips.map(c => (
                      <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                    ))}
                  </>
                )}
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
            <Button variant="outline" onClick={() => fetchData()} disabled={isLoading}>
              <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {isError ? (
            <Alert variant="destructive" className="mb-4">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Trip history failed to load</AlertTitle>
              <AlertDescription className="space-y-2">
                <p>{(error as Error).message}</p>
                <Button variant="outline" size="sm" onClick={() => fetchData()}>
                  Retry
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}
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
                  : trips.length > 0
                    ? 'Trips loaded but hidden by filters — try All Areas / All Regions / Last 90 Days'
                    : 'No trips completed in the selected time period'}
              </p>
              {!searchQuery && trips.length === 0 && selectedServiceAreaId !== 'all' ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-4"
                  onClick={() => {
                    setSelectedServiceAreaId('all');
                    setSelectedRegionId('all');
                    setDateFilter('90days');
                  }}
                >
                  Clear location filters
                </Button>
              ) : null}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Trip</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead>Passenger</TableHead>
                  <TableHead>Route</TableHead>
                  <TableHead>Driver</TableHead>
                  <TableHead>Stops</TableHead>
                  <TableHead>Distance</TableHead>
                  <TableHead>Payable / Captured</TableHead>
                  <TableHead>Payment</TableHead>
                  <TableHead>Invoice</TableHead>
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
                      {trip.corporate_account_id ? (
                        <div className="flex flex-col gap-1">
                          <Badge variant="default" className="gap-1 w-fit bg-amber-500/15 text-amber-700 dark:text-amber-400 border border-amber-500/30 hover:bg-amber-500/20">
                            <Briefcase className="h-3 w-3" />
                            Corporate
                          </Badge>
                          <span className="text-xs font-medium truncate max-w-[160px]" title={trip.corporate_account?.company_name || ''}>
                            {trip.corporate_account?.company_name || '—'}
                          </span>
                        </div>
                      ) : (
                        <Badge variant="outline" className="gap-1 w-fit text-muted-foreground">
                          <User className="h-3 w-3" />
                          Personal
                        </Badge>
                      )}
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
                      <div className="flex flex-wrap items-center gap-1">
                        <Badge variant="outline" className="bg-blue-500/10 text-blue-600">
                          {getIntermediateStopsCount(trip)}
                        </Badge>
                        {getIntermediateStopsCount(trip) > 0 && (
                          <span className="text-xs text-muted-foreground">
                            via {getIntermediateStopsCount(trip)} stop{getIntermediateStopsCount(trip) > 1 ? 's' : ''}
                          </span>
                        )}
                        {trip.stacked_trip_id && (
                          <Badge variant="outline" className="bg-orange-500/10 text-orange-600 border-orange-300 text-[10px]">
                            ⚡ Stacked
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatTripDistance(getTripDistance(trip), trip)}
                    </TableCell>
                     <TableCell>
                      <div className="font-medium flex flex-col gap-0.5">
                        {(() => {
                          const sym = getCurrencySymbol(resolveTripCurrency(trip));
                          const payable = getTripCustomerPayablePence(trip);
                          const captured = getTripStripeCapturedPence(trip);
                          const shortfall = Math.max(0, payable - captured);
                          if (payable <= 0 && captured <= 0) {
                            return <span className="text-muted-foreground">—</span>;
                          }
                          return (
                            <>
                              <span className="text-muted-foreground text-xs font-normal">
                                Payable {sym}{(payable / 100).toFixed(2)}
                              </span>
                              <span className="text-green-600">
                                Captured {sym}{(captured / 100).toFixed(2)}
                              </span>
                              {shortfall > 0 && (
                                <span className="text-[10px] text-amber-600 font-normal">
                                  Shortfall {sym}{(shortfall / 100).toFixed(2)}
                                </span>
                              )}
                            </>
                          );
                        })()}
                        {(() => {
                          const refund = getTripRefundDisplay(trip);
                          if (!refund.showRefundBreakdown) return null;
                          const sym = getCurrencySymbol(resolveTripCurrency(trip));
                          return (
                            <>
                              <span className="text-[10px] text-red-600 font-normal">
                                Ref {sym}{(refund.refundPence / 100).toFixed(2)}
                              </span>
                              <span className="text-[10px] text-muted-foreground font-normal">
                                Net {sym}{(refund.netPaidPence / 100).toFixed(2)}
                              </span>
                            </>
                          );
                        })()}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-0.5">
                        <Badge variant="outline" className="text-[10px] w-fit">
                          {trip.payment_method === 'cash' ? 'Historical Legacy Trip'
                            : trip.payment_method === 'apple_pay' ? '📱 Apple Pay'
                            : trip.payment_method === 'card' ? '💳 Card'
                            : trip.payment_method || 'Unknown'}
                        </Badge>
                        {(() => {
                          const captureStatus = getTripCaptureStatus(trip);
                          if (!captureStatus.shortLabel || captureStatus.shortLabel === '—') return null;
                          const content = (
                            <span className={`text-[10px] ${captureStatusColorClass(captureStatus.kind)}`}>
                              {captureStatus.shortLabel}
                            </span>
                          );
                          if (!captureStatus.tooltip) return content;
                          return (
                            <TooltipProvider delayDuration={150}>
                              <Tooltip>
                                <TooltipTrigger asChild>{content}</TooltipTrigger>
                                <TooltipContent side="top" className="text-xs max-w-xs">
                                  {captureStatus.tooltip}
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          );
                        })()}
                      </div>
                    </TableCell>
                    <TableCell>
                      <TripInvoiceStatusBadge trip={trip} />
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {trip.completed_at 
                        ? format(new Date(trip.completed_at), 'MMM d, HH:mm')
                        : 'N/A'}
                    </TableCell>
                    <TableCell className="text-right">
                      <TripHistoryRowActions
                        trip={trip}
                        onView={() => handleViewTrip(trip)}
                        onInvoiceUpdated={fetchData}
                      />
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
                <Badge variant="outline" className={
                  selectedTrip.status === 'no_show'
                    ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                    : selectedTrip.status === 'cancelled'
                      ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                      : 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                }>
                  <CheckCircle className="h-3 w-3 mr-1" />
                  {getTripStatusLabel(selectedTrip)}
                </Badge>
                {/* Pricing Mode Badge */}
                {selectedTrip.pricing_mode && (
                  <Badge 
                    variant="outline" 
                    className={selectedTrip.pricing_mode === 'fixed' 
                      ? 'bg-blue-100 text-blue-700 border-blue-300 dark:bg-blue-900/30 dark:text-blue-400' 
                      : 'bg-amber-100 text-amber-700 border-amber-300 dark:bg-amber-900/30 dark:text-amber-400'}
                  >
                    {selectedTrip.pricing_mode === 'fixed' ? '🔒 Fixed Fare' : '⚡ Dynamic Fare'}
                  </Badge>
                )}
                {selectedTrip.fare_locked && (
                  <Badge variant="outline" className="bg-indigo-100 text-indigo-700 border-indigo-300 dark:bg-indigo-900/30 dark:text-indigo-400">
                    Fare Locked at Booking
                  </Badge>
                )}
                {selectedTrip.stacked_trip_id && (
                  <Badge variant="outline" className="bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400">
                    ⚡ Stacked Ride
                  </Badge>
                )}
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
                {selectedTrip.vehicle_type && (
                  <Badge variant="outline">
                    <Car className="h-3 w-3 mr-1" />
                    {selectedTrip.vehicle_type}
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
                  {/* Trip summary */}
                  <div className="space-y-2">
                    <h4 className="text-sm font-semibold flex items-center gap-2">
                      <Route className="h-4 w-4" />
                      Trip Summary
                    </h4>
                    <div className="bg-muted/50 rounded-lg p-3 grid grid-cols-2 gap-3 text-sm">
                      <div>
                        <Label className="text-xs text-muted-foreground">Distance</Label>
                        <p className="font-medium">{formatTripDistance(getTripDistance(selectedTrip), selectedTrip)}</p>
                      </div>
                      <div>
                        <Label className="text-xs text-muted-foreground">Duration</Label>
                        <p className="font-medium flex items-center gap-1">
                          <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                          {formatDuration(getTripDurationMinutes(selectedTrip))}
                        </p>
                      </div>
                      <div>
                        <Label className="text-xs text-muted-foreground">Payment</Label>
                        <p className="font-medium capitalize">{selectedTrip.payment_method || '—'}</p>
                      </div>
                      <div>
                        <Label className="text-xs text-muted-foreground">Customer payable</Label>
                        <p className="font-medium">
                          {getTripCustomerPayablePence(selectedTrip) > 0
                            ? `${getCurrencySymbol(resolveTripCurrency(selectedTrip))}${(getTripCustomerPayablePence(selectedTrip) / 100).toFixed(2)}`
                            : '—'}
                        </p>
                      </div>
                      <div>
                        <Label className="text-xs text-muted-foreground">Stripe captured</Label>
                        <p className="font-medium text-green-600">
                          {getTripStripeCapturedPence(selectedTrip) > 0
                            ? `${getCurrencySymbol(resolveTripCurrency(selectedTrip))}${(getTripStripeCapturedPence(selectedTrip) / 100).toFixed(2)}`
                            : '—'}
                        </p>
                      </div>
                      {getTripCustomerPayablePence(selectedTrip) > getTripStripeCapturedPence(selectedTrip) && (
                        <div>
                          <Label className="text-xs text-muted-foreground">Outstanding shortfall</Label>
                          <p className="font-medium text-amber-600">
                            {`${getCurrencySymbol(resolveTripCurrency(selectedTrip))}${((getTripCustomerPayablePence(selectedTrip) - getTripStripeCapturedPence(selectedTrip)) / 100).toFixed(2)}`}
                          </p>
                        </div>
                      )}
                      {(() => {
                        const refund = getTripRefundDisplay(selectedTrip);
                        if (!refund.showRefundBreakdown) return null;
                        const sym = getCurrencySymbol(resolveTripCurrency(selectedTrip));
                        return (
                          <>
                            <div>
                              <Label className="text-xs text-muted-foreground">Refunded</Label>
                              <p className="font-medium text-red-600">
                                {sym}{(refund.refundPence / 100).toFixed(2)}
                              </p>
                            </div>
                            <div>
                              <Label className="text-xs text-muted-foreground">Net Paid</Label>
                              <p className="font-medium">
                                {sym}{(refund.netPaidPence / 100).toFixed(2)}
                              </p>
                            </div>
                            <div>
                              <Label className="text-xs text-muted-foreground">Payment Status</Label>
                              <Badge variant="outline" className="text-xs bg-red-500/10 text-red-700 border-red-500/30">
                                {refund.paymentStatusLabel}
                              </Badge>
                            </div>
                            {selectedTrip.refunded_at && (
                              <div className="col-span-2">
                                <Label className="text-xs text-muted-foreground">Refunded At</Label>
                                <p className="text-sm">{format(new Date(String(selectedTrip.refunded_at)), 'MMM d, yyyy HH:mm')}</p>
                              </div>
                            )}
                          </>
                        );
                      })()}
                      <div className="col-span-2">
                        <Label className="text-xs text-muted-foreground">Invoice</Label>
                        <div className="mt-0.5">
                          <TripInvoiceStatusBadge trip={selectedTrip} />
                        </div>
                      </div>
                    </div>
                  </div>

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

                  {/* Fare Source & Pricing Mode */}
                  <div className="space-y-2">
                    <h4 className="text-sm font-semibold flex items-center gap-2">
                      <Settings2 className="h-4 w-4" />
                      Fare Source
                    </h4>
                    <div className="bg-muted/50 rounded-lg p-4 space-y-2">
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Pricing Mode</span>
                        <Badge variant="outline" className={selectedTrip.pricing_mode === 'fixed' 
                          ? 'bg-blue-100 text-blue-700 border-blue-300' 
                          : selectedTrip.pricing_mode === 'dynamic'
                            ? 'bg-amber-100 text-amber-700 border-amber-300'
                            : ''}>
                          {selectedTrip.pricing_mode === 'fixed' ? '🔒 Fixed Fare' 
                            : selectedTrip.pricing_mode === 'dynamic' ? '⚡ Dynamic Fare' 
                            : 'Not set'}
                        </Badge>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Fare Locked at Booking</span>
                        <span>{selectedTrip.fare_locked ? 'Yes' : 'No'}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Fare Source</span>
                        <span className="text-xs font-mono">Fare Engine</span>
                      </div>
                      {selectedTrip.vehicle_type && (
                        <div className="flex justify-between text-sm">
                          <span className="text-muted-foreground">Vehicle Type</span>
                          <span>{selectedTrip.vehicle_type}</span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Card capture status — amounts in Financial Reconciliation → Trips only */}
                  {(() => {
                    const captureStatus = getTripCaptureStatus(selectedTrip);
                    if (!isCardTrip(selectedTrip)) return null;
                    const isOk = captureStatus.kind === 'captured' || captureStatus.kind === 'captured_split';
                    const isMismatch = captureStatus.kind === 'capture_mismatch';
                    if (!isOk && !isMismatch) return null;
                    return (
                      <>
                        <Alert
                        variant={isMismatch ? 'destructive' : 'default'}
                        className={
                          isMismatch
                            ? 'border-amber-400 bg-amber-500/10 text-amber-900 dark:text-amber-100 [&>svg]:text-amber-600'
                            : 'border-green-400 bg-green-500/10 text-green-900 dark:text-green-100 [&>svg]:text-green-600'
                        }
                      >
                        {isMismatch ? <AlertTriangle className="h-4 w-4" /> : <CheckCircle className="h-4 w-4" />}
                        <AlertTitle>{captureStatus.label}</AlertTitle>
                        <AlertDescription className="text-xs space-y-2 mt-1">
                          <p>
                            {isMismatch
                              ? 'Capture mismatch detected. Use Trip Settlement tools below or Financial Reconciliation for platform audit.'
                              : (captureStatus.tooltip ?? captureStatus.shortLabel)}
                          </p>
                          <FinancialReconciliationTripLink
                            tripId={selectedTrip.id}
                            tripCode={selectedTrip.trip_code}
                            tripNumber={selectedTrip.trip_number}
                            variant="button"
                          />
                        </AlertDescription>
                      </Alert>
                    </>
                    );
                  })()}

                  {isCardTrip(selectedTrip) && (
                    <FinanceRecoveryPanel
                      tripId={selectedTrip.id}
                      tripCode={selectedTrip.trip_code}
                      source="trip-history"
                      variant="summary"
                    />
                  )}

                  {/* Advanced finance — Financial Reconciliation audit only */}
                  <div className="space-y-2">
                    <h4 className="text-sm font-semibold flex items-center gap-2">
                      <DollarSign className="h-4 w-4" />
                      Finance (audit)
                    </h4>
                    <div className="rounded-md border p-4 space-y-3">
                      <p className="text-sm text-muted-foreground">
                        Commission, driver net, settlement totals, and Stripe fees are audited in Financial Reconciliation only — not calculated on this page.
                      </p>
                      <FinancialReconciliationTripLink
                        tripId={selectedTrip.id}
                        tripCode={selectedTrip.trip_code}
                        tripNumber={selectedTrip.trip_number}
                        variant="button"
                      />
                      {isCardTrip(selectedTrip) && selectedTrip.stripe_payment_intent_id && (
                        <SyncStripeRefundButton
                          tripId={selectedTrip.id}
                          tripCode={selectedTrip.trip_code}
                          onSynced={fetchData}
                        />
                      )}
                      <Separator />
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Capture Status</span>
                        <Badge
                          variant="outline"
                          className={`text-xs ${
                            (() => {
                              const k = getTripCaptureStatus(selectedTrip).kind;
                              if (k === 'captured' || k === 'captured_split' || k === 'cash_collected') {
                                return 'bg-green-500/10 text-green-700 border-green-500/30';
                              }
                              if (k === 'capture_mismatch' || k === 'pending_capture') {
                                return 'bg-amber-500/10 text-amber-700 border-amber-500/30';
                              }
                              return '';
                            })()
                          }`}
                        >
                          {getTripCaptureStatus(selectedTrip).shortLabel}
                        </Badge>
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
                  {mapInitError && (
                    <div
                      role="alert"
                      className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                    >
                      Map unavailable: {mapInitError}. Set VITE_MAPBOX_WEB_TOKEN in .env.local (restart dev server) or
                      MAPBOX_WEB_TOKEN on Supabase for Lovable/production.
                    </div>
                  )}
                  <div
                    className="relative w-full min-h-[300px] h-[400px] rounded-lg border border-border overflow-hidden bg-muted"
                    data-testid="trip-history-route-map"
                  >
                    <div ref={setMapContainerEl} className="absolute inset-0" />
                    {isViewOpen && !mapboxReady && !mapInitError && (
                      <div className="absolute inset-0 z-10 flex items-center justify-center bg-muted/80 text-muted-foreground">
                        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                        Loading map token…
                      </div>
                    )}
                    {isViewOpen && mapboxReady && !isMapLoaded && !mapInitError && (
                      <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-muted/50 text-muted-foreground">
                        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                        Loading map tiles…
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {selectedTrip.id && (
                <TripInvoiceCard
                  trip={selectedTrip}
                  onUpdated={async () => {
                    fetchData();
                    const { data } = await supabase
                      .from('trips')
                      .select(`
                        invoice_no, invoice_pdf_url, invoice_generated_at, invoice_email_sent,
                        invoice_email_sent_at, invoice_email_status, invoice_email_error,
                        invoice_pdf_error, invoice_total_paid_pence, invoice_regenerated_at
                      `)
                      .eq('id', selectedTrip.id)
                      .single();
                    if (data) {
                      setSelectedTrip((prev) => (prev ? { ...prev, ...data } : prev));
                    }
                  }}
                />
              )}

            </div>
          )}
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}
