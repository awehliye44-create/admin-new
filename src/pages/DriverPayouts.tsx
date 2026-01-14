import { useState, useMemo } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { supabase } from '@/integrations/supabase/client';
import { useQuery } from '@tanstack/react-query';
import { 
  Search, 
  Download, 
  DollarSign,
  TrendingUp,
  Eye,
  RefreshCw,
  Clock,
  CheckCircle2,
  User,
  Car,
  Banknote
} from 'lucide-react';

interface DriverEarnings {
  driver_id: string;
  driver_name: string;
  driver_email: string;
  total_trips: number;
  total_earnings: number;
  commission: number;
  net_payout: number;
  is_online: boolean;
  rating: number | null;
}

export default function DriverPayouts() {
  const [activeTab, setActiveTab] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [viewingDriver, setViewingDriver] = useState<DriverEarnings | null>(null);

  // Fetch drivers with their completed trip earnings
  const { data: driverEarnings = [], isLoading, refetch } = useQuery({
    queryKey: ['driver-payouts-real'],
    queryFn: async () => {
      // Get all drivers
      const { data: drivers, error: driversError } = await supabase
        .from('drivers')
        .select('id, first_name, last_name, email, is_online, rating, total_trips')
        .eq('approval_status', 'approved');
      
      if (driversError) throw driversError;

      // Get completed trips with fares for each driver
      const { data: trips, error: tripsError } = await supabase
        .from('trips')
        .select('driver_id, fare, service_area_id')
        .eq('status', 'completed')
        .not('fare', 'is', null)
        .not('driver_id', 'is', null);
      
      if (tripsError) throw tripsError;

      // Get commission rates from service area pricing
      const { data: pricingData } = await supabase
        .from('service_area_vehicle_pricing')
        .select('service_area_id, commission_percentage');
      
      const commissionMap = (pricingData || []).reduce((acc, p) => {
        acc[p.service_area_id] = p.commission_percentage;
        return acc;
      }, {} as Record<string, number>);

      // Calculate earnings per driver
      const earningsMap: Record<string, { earnings: number; trips: number; commission: number }> = {};
      
      (trips || []).forEach(trip => {
        if (!trip.driver_id || !trip.fare) return;
        
        if (!earningsMap[trip.driver_id]) {
          earningsMap[trip.driver_id] = { earnings: 0, trips: 0, commission: 0 };
        }
        
        const commissionRate = trip.service_area_id ? (commissionMap[trip.service_area_id] || 20) : 20;
        const commission = (trip.fare * commissionRate) / 100;
        
        earningsMap[trip.driver_id].earnings += trip.fare;
        earningsMap[trip.driver_id].trips += 1;
        earningsMap[trip.driver_id].commission += commission;
      });

      return (drivers || []).map(driver => {
        const driverData = earningsMap[driver.id] || { earnings: 0, trips: 0, commission: 0 };
        return {
          driver_id: driver.id,
          driver_name: `${driver.first_name} ${driver.last_name}`,
          driver_email: driver.email,
          total_trips: driverData.trips || driver.total_trips || 0,
          total_earnings: driverData.earnings,
          commission: driverData.commission,
          net_payout: driverData.earnings - driverData.commission,
          is_online: driver.is_online,
          rating: driver.rating,
        };
      }).sort((a, b) => b.net_payout - a.net_payout);
    },
  });

  const filteredEarnings = useMemo(() => {
    return driverEarnings.filter(driver => {
      const matchesSearch = 
        driver.driver_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        driver.driver_email.toLowerCase().includes(searchTerm.toLowerCase());
      
      if (activeTab === 'with_earnings') {
        return matchesSearch && driver.net_payout > 0;
      }
      if (activeTab === 'online') {
        return matchesSearch && driver.is_online;
      }
      return matchesSearch;
    });
  }, [driverEarnings, searchTerm, activeTab]);

  // Stats from real data
  const totalPayout = driverEarnings.reduce((sum, d) => sum + d.net_payout, 0);
  const totalCommission = driverEarnings.reduce((sum, d) => sum + d.commission, 0);
  const driversWithEarnings = driverEarnings.filter(d => d.net_payout > 0).length;
  const onlineDrivers = driverEarnings.filter(d => d.is_online).length;

  if (isLoading) {
    return (
      <AdminLayout title="Driver Payouts" description="Manage driver payouts">
        <div className="flex items-center justify-center h-64">
          <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout 
      title="Driver Payouts & Settlements" 
      description="View driver earnings from completed trips"
    >
      <div className="space-y-6">
        {/* Stats */}
        <div className="grid gap-4 md:grid-cols-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Driver Earnings</CardTitle>
              <DollarSign className="h-4 w-4 text-green-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-500">£{totalPayout.toFixed(2)}</div>
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <TrendingUp className="h-3 w-3 text-green-500" />
                Net after commission
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Platform Commission</CardTitle>
              <Banknote className="h-4 w-4 text-blue-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-blue-500">£{totalCommission.toFixed(2)}</div>
              <p className="text-xs text-muted-foreground">Total collected</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Drivers with Earnings</CardTitle>
              <User className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{driversWithEarnings}</div>
              <p className="text-xs text-muted-foreground">Of {driverEarnings.length} total</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Online Now</CardTitle>
              <Car className="h-4 w-4 text-green-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{onlineDrivers}</div>
              <p className="text-xs text-muted-foreground">Active drivers</p>
            </CardContent>
          </Card>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
          <div className="flex flex-col sm:flex-row justify-between gap-4">
            <TabsList>
              <TabsTrigger value="all">All Drivers ({driverEarnings.length})</TabsTrigger>
              <TabsTrigger value="with_earnings">
                With Earnings
                {driversWithEarnings > 0 && (
                  <Badge variant="secondary" className="ml-1 h-5 min-w-5 rounded-full p-0 flex items-center justify-center text-xs">
                    {driversWithEarnings}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="online">Online ({onlineDrivers})</TabsTrigger>
            </TabsList>

            <div className="flex gap-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input 
                  placeholder="Search drivers..." 
                  className="pl-9 w-[200px]"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
              </div>
              <Button variant="outline" size="icon" onClick={() => refetch()}>
                <RefreshCw className="h-4 w-4" />
              </Button>
              <Button variant="outline">
                <Download className="h-4 w-4 mr-2" />
                Export
              </Button>
            </div>
          </div>

          <TabsContent value={activeTab} className="m-0">
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Driver</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Trips</TableHead>
                      <TableHead className="text-right">Total Earnings</TableHead>
                      <TableHead className="text-right">Commission</TableHead>
                      <TableHead className="text-right">Net Payout</TableHead>
                      <TableHead>Rating</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredEarnings.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                          No drivers found
                        </TableCell>
                      </TableRow>
                    ) : (
                      filteredEarnings.map((driver) => (
                        <TableRow key={driver.driver_id}>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center">
                                <User className="h-4 w-4" />
                              </div>
                              <div>
                                <p className="font-medium">{driver.driver_name}</p>
                                <p className="text-xs text-muted-foreground">{driver.driver_email}</p>
                              </div>
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge variant={driver.is_online ? 'default' : 'secondary'} className={driver.is_online ? 'bg-green-500' : ''}>
                              {driver.is_online ? 'Online' : 'Offline'}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right">{driver.total_trips}</TableCell>
                          <TableCell className="text-right">£{driver.total_earnings.toFixed(2)}</TableCell>
                          <TableCell className="text-right text-muted-foreground">-£{driver.commission.toFixed(2)}</TableCell>
                          <TableCell className="text-right font-medium text-green-600">£{driver.net_payout.toFixed(2)}</TableCell>
                          <TableCell>
                            {driver.rating ? (
                              <span className="flex items-center gap-1">
                                ⭐ {driver.rating.toFixed(1)}
                              </span>
                            ) : '-'}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button 
                              variant="ghost" 
                              size="sm"
                              onClick={() => setViewingDriver(driver)}
                            >
                              <Eye className="h-4 w-4" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        {/* Driver Detail Dialog */}
        <Dialog open={!!viewingDriver} onOpenChange={() => setViewingDriver(null)}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Driver Earnings Details</DialogTitle>
              <DialogDescription>{viewingDriver?.driver_name}</DialogDescription>
            </DialogHeader>
            {viewingDriver && (
              <div className="space-y-4 py-4">
                <div className="flex items-center gap-4">
                  <div className="h-16 w-16 rounded-full bg-muted flex items-center justify-center">
                    <User className="h-8 w-8" />
                  </div>
                  <div>
                    <p className="text-lg font-medium">{viewingDriver.driver_name}</p>
                    <p className="text-sm text-muted-foreground">{viewingDriver.driver_email}</p>
                    <Badge variant={viewingDriver.is_online ? 'default' : 'secondary'} className={viewingDriver.is_online ? 'bg-green-500 mt-1' : 'mt-1'}>
                      {viewingDriver.is_online ? 'Online' : 'Offline'}
                    </Badge>
                  </div>
                </div>

                <div className="grid gap-4 grid-cols-2">
                  <Card>
                    <CardContent className="pt-4">
                      <p className="text-sm text-muted-foreground">Total Trips</p>
                      <p className="text-2xl font-bold">{viewingDriver.total_trips}</p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="pt-4">
                      <p className="text-sm text-muted-foreground">Rating</p>
                      <p className="text-2xl font-bold">{viewingDriver.rating?.toFixed(1) || 'N/A'} ⭐</p>
                    </CardContent>
                  </Card>
                </div>

                <Card>
                  <CardContent className="pt-4 space-y-2">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Total Earnings</span>
                      <span className="font-medium">£{viewingDriver.total_earnings.toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Commission</span>
                      <span className="font-medium text-red-500">-£{viewingDriver.commission.toFixed(2)}</span>
                    </div>
                    <div className="border-t pt-2 flex justify-between">
                      <span className="font-medium">Net Payout</span>
                      <span className="font-bold text-green-600">£{viewingDriver.net_payout.toFixed(2)}</span>
                    </div>
                  </CardContent>
                </Card>
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => setViewingDriver(null)}>
                Close
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </AdminLayout>
  );
}
