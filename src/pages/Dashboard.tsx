import { useEffect, useState } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { supabase } from '@/integrations/supabase/client';
import { 
  Car, 
  Users, 
  Navigation, 
  MapPin, 
  TrendingUp, 
  PoundSterling,
  RefreshCw,
  Clock,
  ArrowRight
} from 'lucide-react';
import { format } from 'date-fns';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PieChart, Pie, Cell, ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip } from 'recharts';

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
  activeRegions: number;
  activeServiceAreas: number;
  totalRevenue: number;
  commissionRevenue: number;
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

export default function Dashboard() {
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
    activeRegions: 0,
    activeServiceAreas: 0,
    totalRevenue: 0,
    commissionRevenue: 0,
  });
  const [recentTrips, setRecentTrips] = useState<RecentTrip[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [period, setPeriod] = useState<'daily' | 'weekly' | 'monthly'>('daily');

  useEffect(() => {
    async function fetchStats() {
      try {
        const [
          driversResult,
          onlineDriversResult,
          pendingDriversResult,
          ridersResult,
          tripsResult,
          activeTripsResult,
          inProgressTripsResult,
          completedTripsResult,
          regionsResult,
          serviceAreasResult,
          recentTripsResult,
          revenueResult,
        ] = await Promise.all([
          supabase.from('drivers').select('id', { count: 'exact', head: true }),
          supabase.from('drivers').select('id', { count: 'exact', head: true }).eq('is_online', true),
          supabase.from('drivers').select('id', { count: 'exact', head: true }).eq('approval_status', 'pending'),
          supabase.from('customers').select('id', { count: 'exact', head: true }),
          supabase.from('trips').select('id', { count: 'exact', head: true }),
          supabase.from('trips').select('id', { count: 'exact', head: true }).in('status', ['pending', 'accepted', 'arriving', 'in_progress']),
          supabase.from('trips').select('id', { count: 'exact', head: true }).eq('status', 'in_progress'),
          supabase.from('trips').select('id', { count: 'exact', head: true }).eq('status', 'completed'),
          supabase.from('regions').select('id', { count: 'exact', head: true }).eq('status', 'active'),
          supabase.from('service_areas').select('id', { count: 'exact', head: true }).eq('is_active', true),
          supabase.from('trips').select('id, passenger_name, pickup_address, dropoff_address, driver:drivers(first_name, last_name)').order('created_at', { ascending: false }).limit(5),
          supabase.from('trips').select('fare').eq('status', 'completed'),
        ]);

        const totalRevenue = revenueResult.data?.reduce((sum, trip) => sum + (trip.fare || 0), 0) || 0;
        const commissionRevenue = totalRevenue * 0.15; // 15% commission

        setStats({
          totalDrivers: driversResult.count || 0,
          onlineDrivers: onlineDriversResult.count || 0,
          offlineDrivers: (driversResult.count || 0) - (onlineDriversResult.count || 0),
          pendingDrivers: pendingDriversResult.count || 0,
          inactiveDrivers: 0,
          totalRiders: ridersResult.count || 0,
          totalTrips: tripsResult.count || 0,
          activeTrips: activeTripsResult.count || 0,
          inProgressTrips: inProgressTripsResult.count || 0,
          completedTrips: completedTripsResult.count || 0,
          activeRegions: regionsResult.count || 0,
          activeServiceAreas: serviceAreasResult.count || 0,
          totalRevenue,
          commissionRevenue,
        });

        setRecentTrips(recentTripsResult.data || []);
      } catch (error) {
        console.error('Error fetching stats:', error);
      } finally {
        setIsLoading(false);
      }
    }

    fetchStats();
  }, []);

  const driverChartData = [
    { name: 'Total Drivers', value: stats.totalDrivers, color: '#3B82F6' },
    { name: 'Active Drivers', value: stats.onlineDrivers, color: '#10B981' },
    { name: 'Pending Drivers', value: stats.pendingDrivers, color: '#8B5CF6' },
    { name: 'Inactive Drivers', value: stats.inactiveDrivers, color: '#EF4444' },
  ];

  const bookingChartData = [
    { time: '00:00', rides: 2 },
    { time: '02:00', rides: 5 },
    { time: '04:00', rides: 8 },
    { time: '06:00', rides: 12 },
    { time: '08:00', rides: 18 },
    { time: '10:00', rides: 6 },
    { time: '12:00', rides: 5 },
    { time: '14:00', rides: 7 },
    { time: '16:00', rides: 9 },
    { time: '18:00', rides: 15 },
    { time: '20:00', rides: 8 },
  ];

  return (
    <AdminLayout title="Dashboard" description="Dashboard › Main Dashboard">
      {/* Header with filters */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <h2 className="text-xl font-semibold">
            Dashboard Statistics - {format(new Date(), 'd MMMM yyyy')}
          </h2>
        </div>
        <div className="flex items-center gap-4">
          <Tabs value={period} onValueChange={(v) => setPeriod(v as typeof period)}>
            <TabsList>
              <TabsTrigger value="daily">Daily</TabsTrigger>
              <TabsTrigger value="weekly">Weekly</TabsTrigger>
              <TabsTrigger value="monthly">Monthly</TabsTrigger>
            </TabsList>
          </Tabs>
          <Select defaultValue="all">
            <SelectTrigger className="w-[180px]">
              <MapPin className="h-4 w-4 mr-2" />
              <SelectValue placeholder="Service Area" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Service Areas</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="ghost" size="icon">
            <RefreshCw className="h-4 w-4" />
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
            <PoundSterling className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              £{isLoading ? '...' : stats.totalRevenue.toFixed(2)}
            </div>
            <p className="text-xs">
              <span className="text-green-500">+12%</span>
              <span className="text-muted-foreground"> vs previous day</span>
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
              <span className="text-green-500">+8%</span>
              <span className="text-muted-foreground"> 15% commission</span>
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Charts Section */}
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
            <div className="flex items-center gap-4 mb-4">
              <Button variant="outline" size="sm">Days</Button>
              <Button size="sm">Weekly</Button>
              <Button variant="outline" size="sm">Monthly</Button>
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

        {/* Downloads Statistics */}
        <Card>
          <CardHeader>
            <CardTitle>Downloads Statistics</CardTitle>
            <Tabs defaultValue="driver">
              <TabsList>
                <TabsTrigger value="driver">Driver App</TabsTrigger>
                <TabsTrigger value="rider">Rider App</TabsTrigger>
              </TabsList>
            </Tabs>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-4 mb-4">
              <Button variant="outline" size="sm">Days</Button>
              <Button size="sm">Weekly</Button>
              <Button variant="outline" size="sm">Monthly</Button>
            </div>
            <div className="h-[200px] flex items-center justify-center text-muted-foreground">
              No platform data available
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Booking Statistics */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Booking Statistics</CardTitle>
          <Tabs defaultValue="completed">
            <TabsList>
              <TabsTrigger value="completed">Completed Rides</TabsTrigger>
              <TabsTrigger value="ongoing">Ongoing Rides</TabsTrigger>
              <TabsTrigger value="cancelled">Cancelled Rides</TabsTrigger>
            </TabsList>
          </Tabs>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-4 mb-4 text-sm text-muted-foreground">
            <span>31 Dec 2025</span>
            <span>7 Jan 2026</span>
          </div>
          <div className="h-[200px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={bookingChartData}>
                <XAxis dataKey="time" axisLine={false} tickLine={false} />
                <YAxis axisLine={false} tickLine={false} />
                <Tooltip />
                <Line 
                  type="monotone" 
                  dataKey="rides" 
                  stroke="hsl(var(--primary))" 
                  strokeWidth={2}
                  dot={{ fill: 'hsl(var(--primary))' }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      {/* Live Fleet Map & Recent Activity */}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center gap-2">
            <MapPin className="h-5 w-5 text-primary" />
            <CardTitle>Live Fleet Map</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="mb-4">
              <span className="text-sm text-muted-foreground">{stats.onlineDrivers} drivers online</span>
            </div>
            <div className="h-[300px] bg-muted rounded-lg flex items-center justify-center">
              <div className="text-center text-muted-foreground">
                <p>Map integration coming soon</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4 mt-4 text-sm">
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-green-500" />
                <span>Available ({stats.onlineDrivers})</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-yellow-500" />
                <span>On Trip ({stats.inProgressTrips})</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-blue-500" />
                <span>Online ({stats.onlineDrivers})</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-gray-500" />
                <span>Offline ({stats.offlineDrivers})</span>
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
    </AdminLayout>
  );
}
