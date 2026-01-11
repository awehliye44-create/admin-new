import { useEffect, useState } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { supabase } from '@/integrations/supabase/client';
import { Users, Car, MapPin, Navigation, TrendingUp, DollarSign } from 'lucide-react';

interface Stats {
  totalDrivers: number;
  onlineDrivers: number;
  totalRiders: number;
  totalTrips: number;
  activeRegions: number;
  activeServiceAreas: number;
}

export default function Dashboard() {
  const [stats, setStats] = useState<Stats>({
    totalDrivers: 0,
    onlineDrivers: 0,
    totalRiders: 0,
    totalTrips: 0,
    activeRegions: 0,
    activeServiceAreas: 0,
  });
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function fetchStats() {
      try {
        const [
          driversResult,
          onlineDriversResult,
          ridersResult,
          tripsResult,
          regionsResult,
          serviceAreasResult,
        ] = await Promise.all([
          supabase.from('drivers').select('id', { count: 'exact', head: true }),
          supabase.from('drivers').select('id', { count: 'exact', head: true }).eq('is_online', true),
          supabase.from('customers').select('id', { count: 'exact', head: true }),
          supabase.from('trips').select('id', { count: 'exact', head: true }),
          supabase.from('regions').select('id', { count: 'exact', head: true }).eq('status', 'active'),
          supabase.from('service_areas').select('id', { count: 'exact', head: true }).eq('is_active', true),
        ]);

        setStats({
          totalDrivers: driversResult.count || 0,
          onlineDrivers: onlineDriversResult.count || 0,
          totalRiders: ridersResult.count || 0,
          totalTrips: tripsResult.count || 0,
          activeRegions: regionsResult.count || 0,
          activeServiceAreas: serviceAreasResult.count || 0,
        });
      } catch (error) {
        console.error('Error fetching stats:', error);
      } finally {
        setIsLoading(false);
      }
    }

    fetchStats();
  }, []);

  const statCards = [
    {
      title: 'Total Drivers',
      value: stats.totalDrivers,
      subtitle: `${stats.onlineDrivers} online`,
      icon: Car,
      color: 'text-blue-500',
      bgColor: 'bg-blue-500/10',
    },
    {
      title: 'Total Riders',
      value: stats.totalRiders,
      subtitle: 'Registered customers',
      icon: Users,
      color: 'text-green-500',
      bgColor: 'bg-green-500/10',
    },
    {
      title: 'Total Trips',
      value: stats.totalTrips,
      subtitle: 'All time',
      icon: Navigation,
      color: 'text-purple-500',
      bgColor: 'bg-purple-500/10',
    },
    {
      title: 'Active Regions',
      value: stats.activeRegions,
      subtitle: 'Operating regions',
      icon: MapPin,
      color: 'text-primary',
      bgColor: 'bg-primary/10',
    },
    {
      title: 'Service Areas',
      value: stats.activeServiceAreas,
      subtitle: 'Active service zones',
      icon: TrendingUp,
      color: 'text-cyan-500',
      bgColor: 'bg-cyan-500/10',
    },
  ];

  return (
    <AdminLayout title="Dashboard" description="Welcome to ONECAB Admin Panel">
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {statCards.map((card) => (
          <Card key={card.title}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {card.title}
              </CardTitle>
              <div className={`rounded-lg p-2 ${card.bgColor}`}>
                <card.icon className={`h-4 w-4 ${card.color}`} />
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {isLoading ? '...' : card.value.toLocaleString()}
              </div>
              <p className="text-xs text-muted-foreground">{card.subtitle}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Recent Activity Section */}
      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Recent Trips</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground text-sm">
              Trip history and analytics coming soon...
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Driver Activity</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground text-sm">
              Real-time driver status and activity coming soon...
            </p>
          </CardContent>
        </Card>
      </div>
    </AdminLayout>
  );
}
