import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { usePageLoadTelemetry } from '@/hooks/useAdminTelemetry';
import { useQuery } from '@tanstack/react-query';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { supabase } from '@/integrations/supabase/client';
import { isAdminPageLiveActive } from '@/lib/adminPageVisibility';
import { useServiceAreas } from '@/hooks/useServiceAreas';
import { 
  Car, 
  MapPin, 
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
  BarChart3,
  MessageSquare,
  Shield,
  Calculator,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { useSidebarCounts } from '@/hooks/useSidebarCounts';
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
import { preloadMarkerImage } from '@/lib/mapMarkers';
import { mapboxgl } from '@/lib/mapbox';
import { createMapboxMap } from '@/lib/mapboxMap';
import { useMapboxToken } from '@/hooks/useMapboxToken';
import { getCurrencySymbol } from '@/lib/regionSettings';
import { isActiveTripDbStatus } from '@/lib/activeTripStatuses';
import { filterAdminActiveTrips } from '@/lib/adminActiveTripFilter';


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

interface DashboardServiceArea {
  id: string;
  name: string;
  region_id: string;
  region?: { currency_code: string; distance_unit: string } | null;
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


// Quick Actions panel with live badge counts
function QuickActionsPanel({ navigate }: { navigate: (path: string) => void }) {
  const { counts } = useSidebarCounts();

  const actions = [
    {
      icon: UserPlus,
      label: 'Approve Drivers',
      description: counts.pendingDrivers > 0
        ? `${counts.pendingDrivers} pending application${counts.pendingDrivers !== 1 ? 's' : ''}`
        : 'No pending applications',
      path: '/drivers',
      badge: counts.pendingDrivers,
    },
    {
      icon: MessageSquare,
      label: 'Send Notifications',
      description: 'Broadcast messages to drivers',
      path: '/notifications',
      badge: 0,
    },
    {
      icon: BarChart3,
      label: 'Analytics',
      description: 'View detailed performance reports',
      path: '/trip-history',
      badge: 0,
      highlight: true,
    },
    {
      icon: CreditCard,
      label: 'Finance & Payouts',
      description: counts.pendingDocuments > 0
        ? `${counts.pendingDocuments} driver document${counts.pendingDocuments !== 1 ? 's' : ''} pending review`
        : 'Platform reconciliation, trips, and Provider health',
      path: '/financial-reconciliation',
      badge: counts.pendingDocuments,
    },
    {
      icon: Shield,
      label: 'Safety Center',
      description: counts.pendingFeedback > 0
        ? `${counts.pendingFeedback} active alert${counts.pendingFeedback !== 1 ? 's' : ''}`
        : 'No active alerts',
      path: '/disputes',
      badge: counts.pendingFeedback,
    },
  ];

  return (
    <div className="mt-6">
      <h3 className="text-lg font-semibold mb-4">Quick Actions</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        {actions.map((action) => (
          <Card
            key={action.path}
            className="relative flex flex-col justify-between hover:shadow-md transition-shadow"
          >
            {action.badge > 0 && (
              <span className="absolute -top-2 -right-2 flex items-center justify-center min-w-[22px] h-[22px] px-1.5 rounded-full bg-destructive text-destructive-foreground text-xs font-bold">
                {action.badge}
              </span>
            )}
            <CardContent className="pt-5 pb-3 flex flex-col gap-3">
              <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-muted">
                <action.icon className="h-5 w-5 text-muted-foreground" />
              </div>
              <div>
                <p className="font-semibold text-sm">{action.label}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{action.description}</p>
              </div>
            </CardContent>
            <div className="px-5 pb-4">
              <Button
                onClick={() => navigate(action.path)}
                className={cn(
                  "w-full",
                  action.highlight
                    ? "bg-amber-400 hover:bg-amber-500 text-foreground"
                    : ""
                )}
                variant={action.highlight ? "default" : "default"}
              >
                Open
              </Button>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

export default function Dashboard() {
  // Screen load tracked by AdminTelemetryProvider's useRouteChangeTracker
  const navigate = useNavigate();
  const [period, setPeriod] = useState<'daily' | 'weekly' | 'monthly' | 'custom'>('daily');
  const [selectedServiceArea, setSelectedServiceArea] = useState<string>('all');
  const [userStatsPeriod, setUserStatsPeriod] = useState<'daily' | 'weekly' | 'monthly'>('weekly');
  const [bookingStatType, setBookingStatType] = useState<'completed' | 'ongoing' | 'cancelled'>('completed');
  const [customDateFrom, setCustomDateFrom] = useState<Date | undefined>(undefined);
  const [customDateTo, setCustomDateTo] = useState<Date | undefined>(undefined);
  // Map state
  const { isReady: mapboxReady, error: mapboxError } = useMapboxToken();
  const [isMapLoaded, setIsMapLoaded] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const mapInitError = mapboxError ?? mapError;
  const mapRef = useRef<HTMLDivElement>(null);
  const mapboxMapRef = useRef<mapboxgl.Map | null>(null);

  // Preload marker image
  useEffect(() => {
    preloadMarkerImage();
  }, []);

  // Initialize Mapbox after web token resolves (env or get-mapbox-token)
  useEffect(() => {
    if (!mapboxReady || !mapRef.current || mapboxMapRef.current) return;

    let cancelled = false;
    let detachResize: (() => void) | undefined;

    void (async () => {
      try {
        const { map, detachResize: detach } = await createMapboxMap({
          container: mapRef.current!,
          center: [-0.7594, 52.0406],
          zoom: 12,
          onLoad: () => {
            if (!cancelled) setIsMapLoaded(true);
          },
          onTileError: (msg) => {
            if (!cancelled) {
              setMapError(msg);
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
        mapboxMapRef.current = map;
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : 'Failed to initialize map';
        console.error('[Dashboard] map init', msg);
        setMapError(msg);
        setIsMapLoaded(true);
      }
    })();

    return () => {
      cancelled = true;
      detachResize?.();
      mapboxMapRef.current?.remove();
      mapboxMapRef.current = null;
      setIsMapLoaded(false);
    };
  }, [mapboxReady]);

  // Fetch service areas — use shared cached hook
  const { data: sharedServiceAreas } = useServiceAreas({ activeOnly: true });
  const serviceAreas = useMemo(() => (sharedServiceAreas || []) as DashboardServiceArea[], [sharedServiceAreas]);

  // Calculate date ranges (memoized)
  const dateRange = useMemo(() => {
    const now = new Date();
    let startDate: Date, endDate: Date = endOfDay(now), previousStartDate: Date, previousEndDate: Date;
    if (period === 'custom' && customDateFrom) {
      startDate = startOfDay(customDateFrom);
      endDate = customDateTo ? endOfDay(customDateTo) : endOfDay(now);
      const durationMs = endDate.getTime() - startDate.getTime();
      previousEndDate = startDate;
      previousStartDate = new Date(startDate.getTime() - durationMs);
    } else if (period === 'daily') {
      startDate = startOfDay(now); previousStartDate = startOfDay(subDays(now, 1)); previousEndDate = startDate;
    } else if (period === 'weekly') {
      startDate = startOfWeek(now, { weekStartsOn: 1 }); previousStartDate = startOfWeek(subWeeks(now, 1), { weekStartsOn: 1 }); previousEndDate = startDate;
    } else {
      startDate = startOfMonth(now); previousStartDate = startOfMonth(subMonths(now, 1)); previousEndDate = startDate;
    }
    return { startDate, endDate, previousStartDate, previousEndDate };
  }, [period, customDateFrom, customDateTo]);

  // Platform financial KPIs — Financial Reconciliation → Overview only (no duplicate widgets here).

  // ─── MAIN DASHBOARD QUERY — operational stats only (no revenue) ───
  const { data: dashData, isLoading, refetch: fetchStats } = useQuery({
    queryKey: ['dashboard-stats', period, selectedServiceArea, customDateFrom?.toISOString(), customDateTo?.toISOString()],
    queryFn: async () => {
      const { startDate, endDate } = dateRange;

      let tripsQ = supabase.from('trips')
        .select('id, status, financial_outcome, service_area_id, searching_expires_at, driver_id, created_at, trip_code')
        .gte('created_at', startDate.toISOString()).lte('created_at', endDate.toISOString()).limit(10000);

      // Chart query range
      const timePeriod = period === 'custom' ? 'daily' : period;
      const now = new Date();
      let chartStart: Date;
      if (timePeriod === 'daily') chartStart = period === 'custom' && customDateFrom ? startOfDay(customDateFrom) : subDays(now, 1);
      else if (timePeriod === 'weekly') chartStart = startOfDay(subDays(now, 6));
      else chartStart = startOfWeek(subWeeks(now, 3));
      const chartEnd = period === 'custom' && customDateTo ? endOfDay(customDateTo) : now;

      let chartQ = supabase.from('trips').select('status, created_at')
        .gte('created_at', chartStart.toISOString()).lte('created_at', chartEnd.toISOString())
        .in('status', ['completed', 'cancelled']);

      if (selectedServiceArea !== 'all') {
        tripsQ = tripsQ.eq('service_area_id', selectedServiceArea);
        chartQ = chartQ.eq('service_area_id', selectedServiceArea);
      }

      const [driversR, ridersR, tripsR, recentR, chartR] = await Promise.all([
        supabase.from('drivers').select('id, is_online, approval_status, current_lat, current_lng, heading, current_trip_id, first_name, last_name'),
        supabase.from('customers').select('id', { count: 'exact', head: true }),
        tripsQ,
        supabase.from('trips')
          .select('id, passenger_name, pickup_address, dropoff_address, driver:drivers!trips_driver_id_fkey(first_name, last_name)')
          .order('created_at', { ascending: false }).limit(5),
        chartQ,
      ]);

      const allDrivers = driversR.data || [];
      const trips = tripsR.data || [];

      const s: Stats = {
        totalDrivers: allDrivers.length,
        onlineDrivers: allDrivers.filter(d => d.is_online).length,
        offlineDrivers: allDrivers.filter(d => !d.is_online).length,
        pendingDrivers: allDrivers.filter(d => d.approval_status === 'pending').length,
        inactiveDrivers: allDrivers.filter(d => d.approval_status === 'rejected').length,
        totalRiders: ridersR.count || 0,
        totalTrips: trips.length,
        activeTrips: filterAdminActiveTrips(
          trips.filter(t => isActiveTripDbStatus(t.status)),
        ).length,
        inProgressTrips: trips.filter(t =>
          ['in_progress', 'started', 'on_trip', 'ongoing', 'trip_started'].includes(t.status || ''),
        ).length,
        completedTrips: trips.filter(t => t.status === 'completed').length,
        cancelledTrips: trips.filter(t => t.status === 'cancelled').length,
      };

      // Chart bucketing
      const cTrips = chartR.data || [];
      let chartData: BookingDataPoint[] = [];
      if (timePeriod === 'daily') {
        const totalMs = chartEnd.getTime() - chartStart.getTime();
        const intMs = totalMs / 12;
        for (let i = 0; i < 12; i++) {
          const bS = chartStart.getTime() + i * intMs;
          const bucket = cTrips.filter(t => { const ts = new Date(t.created_at).getTime(); return ts >= bS && ts < bS + intMs; });
          chartData.push({ label: format(new Date(bS), 'HH:mm'), completed: bucket.filter(t => t.status === 'completed').length, cancelled: bucket.filter(t => t.status === 'cancelled').length });
        }
      } else if (timePeriod === 'weekly') {
        for (let i = 6; i >= 0; i--) {
          const date = subDays(now, i);
          const dS = startOfDay(date).getTime();
          const bucket = cTrips.filter(t => { const ts = new Date(t.created_at).getTime(); return ts >= dS && ts < dS + 86400000; });
          chartData.push({ label: format(date, 'EEE'), completed: bucket.filter(t => t.status === 'completed').length, cancelled: bucket.filter(t => t.status === 'cancelled').length });
        }
      } else {
        for (let i = 3; i >= 0; i--) {
          const ws = startOfWeek(subWeeks(now, i));
          const we = new Date(ws); we.setDate(we.getDate() + 7);
          const bucket = cTrips.filter(t => { const ts = new Date(t.created_at).getTime(); return ts >= ws.getTime() && ts < we.getTime(); });
          chartData.push({ label: format(ws, 'MMM d'), completed: bucket.filter(t => t.status === 'completed').length, cancelled: bucket.filter(t => t.status === 'cancelled').length });
        }
      }

      return { stats: s, drivers: allDrivers as Driver[], recentTrips: (recentR.data || []) as RecentTrip[], bookingChartData: chartData };
    },
    staleTime: 60_000,
    refetchInterval: () => (isAdminPageLiveActive() ? 120_000 : false),
    refetchIntervalInBackground: false,
  });


  const stats = dashData?.stats || { totalDrivers: 0, onlineDrivers: 0, offlineDrivers: 0, pendingDrivers: 0, inactiveDrivers: 0, totalRiders: 0, totalTrips: 0, activeTrips: 0, inProgressTrips: 0, completedTrips: 0, cancelledTrips: 0 };
  const drivers = dashData?.drivers || [];
  const recentTrips = dashData?.recentTrips || [];
  const bookingChartData = dashData?.bookingChartData || [];

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

  // Resolve currency symbol — Region is the single source of truth for currency
  const selectedArea = serviceAreas.find(sa => sa.id === selectedServiceArea);
  const activeCurrencyCode = selectedArea?.region?.currency_code || (serviceAreas[0]?.region?.currency_code) || '';
  const currencySymbol = getCurrencySymbol(activeCurrencyCode);

  const onlineDriversCount = drivers.filter(d => d.is_online).length;
  const onTripCount = drivers.filter(d => d.current_trip_id).length;
  const availableCount = drivers.filter(d => d.is_online && !d.current_trip_id).length;
  const offlineCount = drivers.filter(d => !d.is_online).length;

  return (
    <AdminLayout title="Dashboard" description="Dashboard › Main Dashboard">
      <PaymentHoldsDashboardAlert />
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
          <Button variant="ghost" size="icon" onClick={() => fetchStats()} disabled={isLoading}>
            <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      {/* Stats Grid — Operational */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4 mb-6">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Active Drivers</CardTitle>
            <Car className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{isLoading ? '...' : stats.onlineDrivers}</div>
            <p className="text-xs text-muted-foreground">
              <span className="text-destructive">{stats.offlineDrivers} offline</span>{' '}
              <span className="text-primary">{stats.totalDrivers} total</span>
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Active Trips</CardTitle>
            <MapPin className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{isLoading ? '...' : stats.activeTrips}</div>
            <p className="text-xs text-primary">{stats.inProgressTrips} in progress</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Riders</CardTitle>
            <UserPlus className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{isLoading ? '...' : stats.totalRiders}</div>
            <p className="text-xs text-muted-foreground">Registered customers</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Completed Trips</CardTitle>
            <Route className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{isLoading ? '...' : stats.completedTrips}</div>
            <p className="text-xs text-destructive">{stats.cancelledTrips} cancelled</p>
          </CardContent>
        </Card>
      </div>

      <Card className="mb-6 border-primary/30 bg-primary/5">
        <CardHeader className="flex flex-row items-center gap-2 pb-2">
          <Calculator className="h-5 w-5 text-primary" />
          <CardTitle className="text-base">Platform Financial KPIs (SSOT)</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-4">
            ONECAB commission, platform liability, captures, and reconciliation status live exclusively in
            Financial Reconciliation → Overview. This dashboard shows operational stats only.
          </p>
          <Button asChild variant="default" size="sm">
            <Link to="/financial-reconciliation?tab=overview">Open Financial Reconciliation → Overview</Link>
          </Button>
        </CardContent>
      </Card>

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
              className="h-[300px] bg-muted rounded-lg overflow-hidden relative"
            >
              {mapInitError && (
                <div className="absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-muted-foreground">
                  Map unavailable: {mapInitError}. Set VITE_MAPBOX_WEB_TOKEN in Lovable or MAPBOX_WEB_TOKEN on Supabase.
                </div>
              )}
              {!mapInitError && !isMapLoaded && (
                <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
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
      <QuickActionsPanel navigate={navigate} />
    </AdminLayout>
  );
}

