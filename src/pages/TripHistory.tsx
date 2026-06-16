import React, { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import { usePageLoadTelemetry } from '@/hooks/useAdminTelemetry';
import { useQuery, useQueryClient } from '@tanstack/react-query';
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
  Eye, CheckCircle, Route, DollarSign,
  Navigation, User, Car, Globe, Settings2, AlertTriangle, Briefcase
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { format, subDays, startOfDay, endOfDay } from 'date-fns';
import { toast } from 'sonner';
import { getCurrencySymbol, formatDistance as formatDistanceUtil, getDistanceUnitShort } from '@/lib/regionSettings';
import { PaymentControlsCard } from '@/components/payment/PaymentControlsCard';
import { TripInvoiceCard, TripInvoiceStatusBadge } from '@/components/trips/TripInvoiceCard';
import { getTripDisplayId } from '@/lib/tripUtils';
import {
  captureStatusColorClass,
  getCapturedTotalPence,
  getTripCaptureStatus,
  getTripDriverNetPence,
  getTripSettlementBreakdown,
  getTripSettlementFarePence,
  getTripTipPence,
  isCardTrip,
  summarizeTripPayments,
} from '@/lib/tripCaptureStatus';
import { CurrencyGroupedStats, getSingleCurrency } from '@/components/finance/CurrencyGroupedStats';
import { useMapboxToken } from '@/hooks/useMapboxToken';
import { mapboxgl } from '@/lib/mapbox';
import { createMapboxMap } from '@/lib/mapboxMap';

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

/** Terminal trips shown in history — aligned with Financial Reconciliation SSOT trip filters. */
const HISTORY_FINANCIAL_OUTCOMES = ['COMPLETED', 'NO_SHOW'] as const;
const HISTORY_STATUSES = ['completed', 'no_show'] as const;

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
  payment_commission_pence?: number | null;
  payment_commission_pct?: number | null;
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

  const queryClient = useQueryClient();

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
  const { data: trips = [], isLoading } = useQuery({
    queryKey: ['trip-history', dateFilter, selectedRegionId, selectedServiceAreaId],
    queryFn: async () => {
      const { start, end } = getDateRange();
      
      const { data: tripsData, error: tripsError } = await supabase
        .from('trips')
        .select(`
          id, trip_code, trip_number, status, financial_outcome, passenger_name, passenger_phone,
          pickup_address, pickup_latitude, pickup_longitude, dropoff_address, dropoff_latitude, dropoff_longitude,
          estimated_fare, fare, gross_fare_pence, commission_pence, driver_net_pence, final_fare_pence,
          final_customer_fare_pence, capture_amount_pence,
          stripe_processing_fee_pence, onecab_net_pence,
          payment_status, payment_method, currency_code, estimated_distance_km, estimated_duration_minutes,
          total_stops, created_at, started_at, completed_at, surge_multiplier, driver_id,
          driver_location_lat, driver_location_lng, stripe_payment_intent_id, stacked_trip_id,
          pricing_mode, fare_locked, vehicle_type_id, vehicle_type, service_area_id, fare_engine_config_id,
          waiting_charge_pence, pickup_waiting_charge_pence, total_waiting_charge_pence, waiting_minutes, fare_breakdown,
          tip_pence, tip_amount_pence,
          arrival_cancellation_applied, arrival_cancellation_fee,
          invoice_no, invoice_pdf_url, invoice_generated_at, invoice_email_sent,
          invoice_email_sent_at, invoice_email_status, invoice_email_error,
          invoice_pdf_error, invoice_total_paid_pence, invoice_regenerated_at,
          driver:drivers!trips_driver_id_fkey(id, first_name, last_name, phone, driver_code, region_id),
          service_area_join:service_areas!trips_service_area_id_fkey(region_id, region:regions(currency_code, distance_unit))
        `)
        // Match useLedgerRevenue: financially terminal by outcome OR legacy status snapshot.
        .or(`financial_outcome.in.(${HISTORY_FINANCIAL_OUTCOMES.join(',')}),status.in.(${HISTORY_STATUSES.join(',')})`)
        .not('completed_at', 'is', null)
        .gte('completed_at', start.toISOString())
        .lte('completed_at', end.toISOString())
        .order('completed_at', { ascending: false });

      if (tripsError) throw tripsError;

      const tripIds = (tripsData || []).map(t => t.id);
      
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
        commission: number | null;
        commission_pct: number | null;
        tip: number | null;
        count: number;
        hasShortfallPi: boolean;
        lifecycleFees: number;
        metadataLifecycleFees: number;
      }> = {};
      if (tripIds.length > 0) {
        const { data: paymentsData } = await supabase
          .from('payments')
          .select('trip_id, amount_pence, captured_amount_pence, commission_amount_pence, commission_pct, status, fee_type, updated_at, metadata')
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
                commission: p.commission_amount_pence ?? null,
                commission_pct: p.commission_pct ?? null,
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

      let financeMap: Record<string, number> = {};
      let ledgerNetMap: Record<string, number> = {};
      if (tripIds.length > 0) {
        const [{ data: financeData }, { data: ledgerData }] = await Promise.all([
          supabase
            .from('trip_finance')
            .select('trip_id, final_trip_total_pence')
            .in('trip_id', tripIds),
          supabase
            .from('driver_wallet_ledger')
            .select('related_trip_id, amount_pence')
            .in('related_trip_id', tripIds)
            .eq('type', 'TRIP_EARNING_NET'),
        ]);
        if (financeData) {
          for (const row of financeData as { trip_id: string; final_trip_total_pence: number }[]) {
            if (row.final_trip_total_pence > 0) {
              financeMap[row.trip_id] = row.final_trip_total_pence;
            }
          }
        }
        if (ledgerData) {
          for (const row of ledgerData as { related_trip_id: string | null; amount_pence: number }[]) {
            if (row.related_trip_id && row.amount_pence >= 0) {
              ledgerNetMap[row.related_trip_id] = row.amount_pence;
            }
          }
        }
      }

      return (tripsData || []).map(trip => {
        const pay = paymentsMap[trip.id];
        return {
          ...trip,
          trip_stops: stopsMap[trip.id] || [],
          payment_captured_pence: pay && pay.captured > 0 ? pay.captured : null,
          payment_authorized_pence: pay?.authorized ?? null,
          payment_commission_pence: pay?.commission ?? null,
          payment_commission_pct: pay?.commission_pct ?? null,
          payment_tip_pence: pay?.tip ?? null,
          payment_count: pay?.count ?? 0,
          has_shortfall_payment_intent: pay?.hasShortfallPi ?? false,
          payment_lifecycle_fees_pence: pay?.lifecycleFees ?? 0,
          payment_metadata_lifecycle_fees_pence: pay?.metadataLifecycleFees ?? 0,
          settlement_total_pence: financeMap[trip.id] ?? null,
          ledger_trip_earning_net_pence: ledgerNetMap[trip.id] ?? null,
        };
      }) as CompletedTrip[];
    },
    staleTime: 30_000,
  });

  const fetchData = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['trip-history'] });
  }, [queryClient]);

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
    
    return matchesSearch;
  });

  // Settlement fare (customer paid) — SSOT via getTripSettlementFarePence
  const getTripFarePounds = (trip: CompletedTrip): number => getTripSettlementFarePence(trip) / 100;

  const getEffectiveCommissionPence = (trip: CompletedTrip): number | null => {
    if (trip.payment_commission_pence != null) return trip.payment_commission_pence;
    return trip.commission_pence ?? null;
  };

  const getEffectiveDriverNetPence = (trip: CompletedTrip): number | null => getTripDriverNetPence(trip);

  const getEffectiveTipPence = (trip: CompletedTrip): number => {
    const tip = getTripTipPence(trip);
    if (tip <= 0) return 0;
    if (isCardTrip(trip)) {
      const captured = getCapturedTotalPence(trip);
      const settlement = getTripSettlementFarePence(trip);
      if (captured != null && captured > 0 && settlement >= captured) return 0;
    }
    return tip;
  };

  // Customer total for revenue stat — same settlement fare as list row
  const getTripCustomerTotalPence = (trip: CompletedTrip): number => getTripSettlementFarePence(trip);

  // Stats based on filtered trips
  const totalRevenue = filteredTrips.reduce((sum, t) => sum + getTripSettlementFarePence(t) / 100, 0);
  const avgFare = filteredTrips.length > 0 ? totalRevenue / filteredTrips.length : 0;
  const multiStopTrips = filteredTrips.filter(t => isMultiStopTrip(t)).length;


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
                {isMixedCurrency ? (
                  <CurrencyGroupedStats
                    items={filteredTrips.map(t => ({ currency_code: resolveTripCurrency(t) || '???', amount: getTripCustomerTotalPence(t) }))}
                    className="text-lg font-bold text-green-600"
                  />
                ) : (
                  <p className="text-2xl font-bold text-green-600">
                    {statsSymbol}{totalRevenue.toFixed(2)}
                  </p>
                )}
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
                <p className="text-2xl font-bold">{statsSymbol}{avgFare.toFixed(2)}</p>
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
              Finished rides (completed / no-show) by completion date — commission &amp; Stripe fee are in trip details
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
            <Button variant="outline" onClick={() => fetchData()} disabled={isLoading}>
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
                  <TableHead>Customer Paid</TableHead>
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
                      <div className="font-medium text-green-600">
                        {getCurrencySymbol(resolveTripCurrency(trip))}
                        {getTripFarePounds(trip).toFixed(2)}
                      </div>
                      {getTripDriverNetPence(trip) != null && (
                        <div className="text-[10px] text-muted-foreground mt-0.5">
                          Net: {getCurrencySymbol(resolveTripCurrency(trip))}{((getTripDriverNetPence(trip) || 0) / 100).toFixed(2)}
                        </div>
                      )}
                      {getEffectiveTipPence(trip) > 0 && (
                        <div className="text-[10px] text-emerald-600 mt-0.5">
                          Tip: {getCurrencySymbol(resolveTripCurrency(trip))}{(getEffectiveTipPence(trip) / 100).toFixed(2)}
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
                <Badge variant="outline" className={
                  selectedTrip.status === 'no_show'
                    ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                    : 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                }>
                  <CheckCircle className="h-3 w-3 mr-1" />
                  {selectedTrip.status === 'no_show' ? 'No Show' : 'Completed'}
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

                  {/* Card capture confirmation — fare + tip vs sum of payment intents */}
                  {(() => {
                    const captureStatus = getTripCaptureStatus(selectedTrip);
                    if (!isCardTrip(selectedTrip)) return null;
                    const cs = getCurrencySymbol(resolveTripCurrency(selectedTrip));
                    const fmtP = (p: number) => `${cs}${(p / 100).toFixed(2)}`;
                    const isOk = captureStatus.kind === 'captured' || captureStatus.kind === 'captured_split';
                    const isMismatch = captureStatus.kind === 'capture_mismatch';
                    if (!isOk && !isMismatch) return null;
                    return (
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
                        <AlertDescription className="text-xs space-y-1 mt-1">
                          <div>Settlement total (fare + tip + fees): <span className="font-medium">{fmtP(captureStatus.expectedTotalPence ?? 0)}</span></div>
                          <div>Captured (Stripe{captureStatus.paymentCount > 1 ? `, ${captureStatus.paymentCount} PIs` : ''}): <span className="font-medium">{fmtP(captureStatus.capturedTotalPence ?? 0)}</span></div>
                          {isMismatch && captureStatus.diffPence != null && (
                            <div>Difference: <span className="font-medium">{captureStatus.diffPence > 0 ? '+' : ''}{fmtP(captureStatus.diffPence)}</span></div>
                          )}
                          {isMismatch && (
                            <div className="pt-1 text-amber-800 dark:text-amber-200">
                              Stripe captured less than the settlement total. Compare payments rows against final_fare_pence (includes waiting) plus tip and any lifecycle fees.
                            </div>
                          )}
                          {isOk && captureStatus.kind === 'captured_split' && (
                            <div className="pt-1 text-green-800 dark:text-green-200">
                              Split capture: primary PI plus a shortfall PI (auth cap) were charged separately; combined total matches settlement fare + tip.
                            </div>
                          )}
                          {isOk && captureStatus.tooltip && (
                            <div className="pt-1 text-green-800 dark:text-green-200">{captureStatus.tooltip}</div>
                          )}
                        </AlertDescription>
                      </Alert>
                    );
                  })()}

                  {/* Fare Breakdown */}
                  <div className="space-y-2">
                    <h4 className="text-sm font-semibold flex items-center gap-2">
                      <DollarSign className="h-4 w-4" />
                      Fare Breakdown
                    </h4>
                    {(() => {
                      const cs = getCurrencySymbol(resolveTripCurrency(selectedTrip));
                      const fmt = (pence: number) => `${cs}${(pence / 100).toFixed(2)}`;
                      const settlement = getTripSettlementBreakdown(selectedTrip);
                      const fb = selectedTrip.fare_breakdown as Record<string, number> | null;
                      const distanceCharge = fb?.distance_charge_pence ?? null;
                      const timeCharge = fb?.time_charge_pence ?? null;
                      const bookingFee = fb?.booking_fee_pence ?? null;

                      return (
                        <div className="bg-muted/50 rounded-lg p-4 space-y-2">
                          {settlement.baseFarePence > 0 && (
                            <div className="flex justify-between text-sm">
                              <span className="text-muted-foreground">Base Fare</span>
                              <span>{fmt(settlement.baseFarePence)}</span>
                            </div>
                          )}
                          {distanceCharge != null && distanceCharge > 0 && (
                            <div className="flex justify-between text-sm">
                              <span className="text-muted-foreground">Distance Charge</span>
                              <span>{fmt(distanceCharge)}</span>
                            </div>
                          )}
                          {timeCharge != null && timeCharge > 0 && (
                            <div className="flex justify-between text-sm">
                              <span className="text-muted-foreground">Time Charge</span>
                              <span>{fmt(timeCharge)}</span>
                            </div>
                          )}
                          {bookingFee != null && bookingFee > 0 && (
                            <div className="flex justify-between text-sm">
                              <span className="text-muted-foreground">Booking Fee</span>
                              <span>{fmt(bookingFee)}</span>
                            </div>
                          )}

                          {/* Waiting Charge — show when it contributed to settlement */}
                          {settlement.waitingPence > 0 && (
                            <div className="flex justify-between text-sm">
                              <span className="text-muted-foreground">
                                Waiting Time
                                {selectedTrip.waiting_minutes != null && selectedTrip.waiting_minutes > 0 && (
                                  <span className="text-xs ml-1">({Math.round(selectedTrip.waiting_minutes)} min)</span>
                                )}
                              </span>
                              <span className="text-amber-600">{fmt(settlement.waitingPence)}</span>
                            </div>
                          )}
                          {settlement.extrasPence > 0 && (
                            <div className="flex justify-between text-sm">
                              <span className="text-muted-foreground">Extras / Adjustments</span>
                              <span>{fmt(settlement.extrasPence)}</span>
                            </div>
                          )}
                          {settlement.tipPence > 0 && (
                            <div className="flex justify-between text-sm">
                              <span className="text-muted-foreground">Tips</span>
                              <span className="text-emerald-600">{fmt(settlement.tipPence)}</span>
                            </div>
                          )}

                          <Separator />

                          {(() => {
                            const isCard = isCardTrip(selectedTrip);
                            const captured = getCapturedTotalPence(selectedTrip);
                            const authorized = selectedTrip.payment_authorized_pence;
                            const useSettlement = isCard && captured != null && captured > 0;
                            const settlementFare = getTripSettlementFarePence(selectedTrip);
                            const grossDiffers = useSettlement && selectedTrip.gross_fare_pence != null && selectedTrip.gross_fare_pence !== settlementFare;
                            const effectiveCommission = getEffectiveCommissionPence(selectedTrip);
                            const effectiveDriverNet = getTripDriverNetPence(selectedTrip);
                            const releasedBuffer = useSettlement && authorized != null ? Math.max(0, authorized - (captured as number)) : null;
                            const pctLabel = (selectedTrip as any).commission_pct
                              ?? (selectedTrip.fare_breakdown as any)?.commission_pct
                              ?? selectedTrip.payment_commission_pct;
                            return (
                              <>
                                {/* Show fare engine estimate separately when it differs from settlement truth */}
                                {grossDiffers && (
                                  <div className="flex justify-between text-sm">
                                    <span className="text-muted-foreground">Fare engine estimate</span>
                                    <span className="line-through text-muted-foreground">{fmt(selectedTrip.gross_fare_pence!)}</span>
                                  </div>
                                )}
                                {useSettlement ? (
                                  <div className="flex justify-between text-sm">
                                    <span className="text-muted-foreground">Customer Paid (Stripe Captured)</span>
                                    <span className="font-medium">{fmt(settlementFare)}</span>
                                  </div>
                                ) : (
                                  selectedTrip.gross_fare_pence != null && (
                                    <div className="flex justify-between text-sm">
                                      <span className="text-muted-foreground">Gross Fare</span>
                                      <span>{fmt(selectedTrip.gross_fare_pence)}</span>
                                    </div>
                                  )
                                )}
                                {releasedBuffer != null && releasedBuffer > 0 && (
                                  <div className="flex justify-between text-xs text-muted-foreground">
                                    <span>Released buffer ({fmt(authorized!)} authorised − {fmt(captured as number)} captured)</span>
                                    <span>{fmt(releasedBuffer)}</span>
                                  </div>
                                )}
                                {effectiveCommission != null && (
                                  <div className="flex justify-between text-sm">
                                    <span className="text-muted-foreground">
                                      ONECAB Commission
                                      {pctLabel != null && (
                                        <span className="text-xs ml-1">({pctLabel}%)</span>
                                      )}
                                    </span>
                                    <span className="text-orange-600">-{fmt(effectiveCommission)}</span>
                                  </div>
                                )}
                                {effectiveDriverNet != null && (
                                  <div className="flex justify-between text-sm">
                                    <span className="text-muted-foreground">Driver Net</span>
                                    <span>{fmt(effectiveDriverNet)}</span>
                                  </div>
                                )}
                                {(() => {
                                  const tipPence = getEffectiveTipPence(selectedTrip);
                                  if (tipPence <= 0) return null;
                                  return (
                                    <div className="flex justify-between text-sm">
                                      <span className="text-muted-foreground">Driver Tip</span>
                                      <span className="text-emerald-600">{fmt(tipPence)}</span>
                                    </div>
                                  );
                                })()}
                              </>
                            );
                          })()}

                          {/* ONECAB net-after-Stripe — fields read from DB, never recomputed */}
                          {selectedTrip.commission_pence != null && (
                            <>
                              <Separator />
                              <div className="flex justify-between text-sm">
                                <span className="text-muted-foreground">Gross commission</span>
                                <span>{fmt(selectedTrip.commission_pence)}</span>
                              </div>
                              <div className="flex justify-between text-sm">
                                <span className="text-muted-foreground">Stripe Fee</span>
                                <span className="text-orange-600">
                                  {selectedTrip.stripe_processing_fee_pence && selectedTrip.stripe_processing_fee_pence > 0
                                    ? `−${fmt(selectedTrip.stripe_processing_fee_pence)}`
                                    : '—'}
                                </span>
                              </div>
                              <Separator />
                              <div className="flex justify-between text-sm font-medium">
                                <span>ONECAB net</span>
                                <span className="text-blue-600">
                                  {fmt(
                                    selectedTrip.onecab_net_pence != null
                                      ? selectedTrip.onecab_net_pence
                                      : selectedTrip.commission_pence
                                  )}
                                </span>
                              </div>
                            </>
                          )}
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
                            <span>Final Settlement Total</span>
                            <span className="text-green-600">
                              {fmt(getTripSettlementFarePence(selectedTrip))}
                            </span>
                          </div>
                        </div>
                      );
                    })()}
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

              {/* Admin Payment Controls — Capture, Cancel, Refund, Edit + full payment logs */}
              {selectedTrip.id && <PaymentControlsCard tripId={selectedTrip.id} />}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}
