import { useState, useEffect } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useQuery } from '@tanstack/react-query';
import { 
  BarChart3, 
  Download, 
  Calendar,
  FileText,
  RefreshCw,
  TrendingUp,
  TrendingDown,
  Users,
  Car,
  DollarSign,
  Clock,
  MapPin,
  Building2,
  PieChart,
  LineChart,
  Globe
} from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LineChart as RechartsLineChart, Line, PieChart as RechartsPieChart, Pie, Cell } from 'recharts';

interface Region {
  id: string;
  name: string;
}

interface ServiceArea {
  id: string;
  name: string;
  region_id: string;
}

const COLORS = ['hsl(var(--primary))', 'hsl(var(--chart-2))', 'hsl(var(--chart-3))', 'hsl(var(--chart-4))'];

export default function CorporateReports() {
  const [activeTab, setActiveTab] = useState('overview');
  const [dateRange, setDateRange] = useState('last30');
  const [regionFilter, setRegionFilter] = useState<string>('all');
  const [serviceAreaFilter, setServiceAreaFilter] = useState<string>('all');
  const [selectedAccount, setSelectedAccount] = useState<string>('all');

  // Fetch regions
  const { data: regions = [] } = useQuery({
    queryKey: ['regions'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('regions')
        .select('id, name')
        .order('name');
      if (error) throw error;
      return data as Region[];
    },
  });

  // Fetch service areas based on region filter
  const { data: serviceAreas = [] } = useQuery({
    queryKey: ['service-areas', regionFilter],
    queryFn: async () => {
      let query = supabase.from('service_areas').select('id, name, region_id').order('name');
      if (regionFilter !== 'all') {
        query = query.eq('region_id', regionFilter);
      }
      const { data, error } = await query;
      if (error) throw error;
      return data as ServiceArea[];
    },
  });

  // Reset service area filter when region changes
  useEffect(() => {
    setServiceAreaFilter('all');
  }, [regionFilter]);

  // Fetch corporate accounts
  const { data: accounts = [] } = useQuery({
    queryKey: ['corporate-accounts-for-reports', regionFilter, serviceAreaFilter],
    queryFn: async () => {
      let query = supabase
        .from('corporate_accounts')
        .select('*')
        .order('company_name');
      
      if (regionFilter !== 'all') {
        query = query.eq('region_id', regionFilter);
      }
      if (serviceAreaFilter !== 'all') {
        query = query.eq('service_area_id', serviceAreaFilter);
      }
      
      const { data, error } = await query;
      if (error) throw error;
      return data || [];
    },
  });

  // Fetch invoices for revenue data
  const { data: invoices = [] } = useQuery({
    queryKey: ['corporate-invoices-for-reports', regionFilter, serviceAreaFilter, dateRange],
    queryFn: async () => {
      const now = new Date();
      let startDate = new Date();
      
      switch (dateRange) {
        case 'last7': startDate.setDate(now.getDate() - 7); break;
        case 'last30': startDate.setDate(now.getDate() - 30); break;
        case 'last90': startDate.setDate(now.getDate() - 90); break;
        case 'thisYear': startDate = new Date(now.getFullYear(), 0, 1); break;
        case 'lastYear': startDate = new Date(now.getFullYear() - 1, 0, 1); break;
        default: startDate.setDate(now.getDate() - 30);
      }

      let query = supabase
        .from('corporate_invoices')
        .select('*')
        .gte('created_at', startDate.toISOString());
      
      if (regionFilter !== 'all') {
        query = query.eq('region_id', regionFilter);
      }
      if (serviceAreaFilter !== 'all') {
        query = query.eq('service_area_id', serviceAreaFilter);
      }
      
      const { data, error } = await query;
      if (error) throw error;
      return data || [];
    },
  });

  // Fetch trip data for reports
  const { data: tripData = [], isLoading } = useQuery({
    queryKey: ['corporate-trip-reports', dateRange, regionFilter, serviceAreaFilter],
    queryFn: async () => {
      const now = new Date();
      let startDate = new Date();
      
      switch (dateRange) {
        case 'last7': startDate.setDate(now.getDate() - 7); break;
        case 'last30': startDate.setDate(now.getDate() - 30); break;
        case 'last90': startDate.setDate(now.getDate() - 90); break;
        case 'thisYear': startDate = new Date(now.getFullYear(), 0, 1); break;
        case 'lastYear': startDate = new Date(now.getFullYear() - 1, 0, 1); break;
        default: startDate.setDate(now.getDate() - 30);
      }

      let query = supabase
        .from('trips')
        .select('id, fare, created_at, trip_type, service_area_id')
        .eq('status', 'completed')
        .gte('created_at', startDate.toISOString());
      
      if (serviceAreaFilter !== 'all') {
        query = query.eq('service_area_id', serviceAreaFilter);
      }
      
      const { data: trips, error } = await query;
      if (error) throw error;
      return trips || [];
    },
  });

  // Calculate report data from real data
  const calculateMonthlyTrends = (trips: any[]) => {
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const monthData: Record<string, { trips: number; revenue: number }> = {};
    
    trips.forEach(trip => {
      const date = new Date(trip.created_at);
      const key = `${date.getFullYear()}-${String(date.getMonth()).padStart(2, '0')}`;
      if (!monthData[key]) monthData[key] = { trips: 0, revenue: 0 };
      monthData[key].trips++;
      monthData[key].revenue += trip.fare || 0;
    });

    return Object.entries(monthData)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-6)
      .map(([key, data]) => ({
        month: monthNames[parseInt(key.split('-')[1])],
        trips: data.trips,
        revenue: Math.round(data.revenue),
      }));
  };

  const calculateTripDistribution = (trips: any[]) => {
    if (!trips.length) return [];
    const distribution: Record<string, number> = { 'Standard': 0, 'Premium': 0 };
    trips.forEach(trip => {
      const type = trip.trip_type === 'executive' ? 'Premium' : 'Standard';
      distribution[type]++;
    });
    
    const total = trips.length;
    return Object.entries(distribution)
      .filter(([_, count]) => count > 0)
      .map(([category, count]) => ({
        category,
        value: Math.round((count / total) * 100),
      }));
  };

  const calculateUsageByTime = (trips: any[]) => {
    const hourData: Record<number, number> = {};
    trips.forEach(trip => {
      const hour = new Date(trip.created_at).getHours();
      const roundedHour = Math.floor(hour / 2) * 2;
      hourData[roundedHour] = (hourData[roundedHour] || 0) + 1;
    });

    return [6, 8, 10, 12, 14, 16, 18, 20].map(h => ({
      hour: `${h > 12 ? h - 12 : h}${h >= 12 ? 'PM' : 'AM'}`,
      trips: hourData[h] || 0,
    }));
  };

  const totalRevenue = invoices.filter(i => i.status === 'paid').reduce((sum, i) => sum + (i.total_amount || 0), 0);
  const totalTrips = tripData.length;
  const avgTripCost = totalTrips > 0 ? totalRevenue / totalTrips : 0;
  const activeAccounts = accounts.filter((a: any) => a.status === 'active').length;
  const monthlyTrends = calculateMonthlyTrends(tripData);
  const tripDistribution = calculateTripDistribution(tripData);
  const usageByTime = calculateUsageByTime(tripData);

  const handleExportReport = (reportType: string) => {
    toast.success(`${reportType} report exported successfully`);
  };

  const handleGenerateReport = () => {
    toast.success('Report generation started. You will be notified when ready.');
  };

  if (isLoading) {
    return (
      <AdminLayout title="Corporate Reports" description="Generate corporate reports">
        <div className="flex items-center justify-center h-64">
          <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout 
      title="Corporate Reports" 
      description="Analytics and reports for corporate accounts"
    >
      <div className="space-y-6">
        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-4 justify-between">
          <div className="flex flex-wrap gap-2">
            <Select value={dateRange} onValueChange={setDateRange}>
              <SelectTrigger className="w-[180px]">
                <Calendar className="h-4 w-4 mr-2" />
                <SelectValue placeholder="Date Range" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="last7">Last 7 Days</SelectItem>
                <SelectItem value="last30">Last 30 Days</SelectItem>
                <SelectItem value="last90">Last 90 Days</SelectItem>
                <SelectItem value="thisYear">This Year</SelectItem>
                <SelectItem value="lastYear">Last Year</SelectItem>
              </SelectContent>
            </Select>
            <Select value={regionFilter} onValueChange={setRegionFilter}>
              <SelectTrigger className="w-[160px]">
                <Globe className="h-4 w-4 mr-2" />
                <SelectValue placeholder="Region" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Regions</SelectItem>
                {regions.map((region) => (
                  <SelectItem key={region.id} value={region.id}>{region.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={serviceAreaFilter} onValueChange={setServiceAreaFilter}>
              <SelectTrigger className="w-[170px]">
                <MapPin className="h-4 w-4 mr-2" />
                <SelectValue placeholder="Service Area" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Areas</SelectItem>
                {serviceAreas.map((area) => (
                  <SelectItem key={area.id} value={area.id}>{area.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={selectedAccount} onValueChange={setSelectedAccount}>
              <SelectTrigger className="w-[200px]">
                <Building2 className="h-4 w-4 mr-2" />
                <SelectValue placeholder="All Accounts" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Accounts</SelectItem>
                {accounts.map((acc: any) => (
                  <SelectItem key={acc.id} value={acc.id}>{acc.company_name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => handleExportReport('Summary')}>
              <Download className="h-4 w-4 mr-2" />
              Export
            </Button>
            <Button onClick={handleGenerateReport}>
              <FileText className="h-4 w-4 mr-2" />
              Generate Report
            </Button>
          </div>
        </div>

        {/* Summary Stats */}
        <div className="grid gap-4 md:grid-cols-5">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Accounts</CardTitle>
              <Building2 className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{accounts.length}</div>
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <TrendingUp className="h-3 w-3 text-green-500" />
                {activeAccounts} active
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Trips</CardTitle>
              <Car className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{totalTrips.toLocaleString()}</div>
              <p className="text-xs text-muted-foreground">In selected period</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Revenue</CardTitle>
              <DollarSign className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">${totalRevenue.toLocaleString()}</div>
              <p className="text-xs text-muted-foreground">From paid invoices</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Avg Trip Cost</CardTitle>
              <BarChart3 className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">${avgTripCost.toFixed(2)}</div>
              <p className="text-xs text-muted-foreground">Per trip</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Trips/Account</CardTitle>
              <Users className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {activeAccounts > 0 ? Math.round(totalTrips / activeAccounts) : 0}
              </div>
              <p className="text-xs text-muted-foreground">Average per active account</p>
            </CardContent>
          </Card>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
          <TabsList>
            <TabsTrigger value="overview" className="flex items-center gap-2">
              <BarChart3 className="h-4 w-4" />
              Overview
            </TabsTrigger>
            <TabsTrigger value="trends" className="flex items-center gap-2">
              <LineChart className="h-4 w-4" />
              Trends
            </TabsTrigger>
            <TabsTrigger value="accounts" className="flex items-center gap-2">
              <Building2 className="h-4 w-4" />
              By Account
            </TabsTrigger>
            <TabsTrigger value="usage" className="flex items-center gap-2">
              <Clock className="h-4 w-4" />
              Usage Patterns
            </TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="space-y-6">
            <div className="grid gap-6 lg:grid-cols-2">
              {/* Monthly Revenue Chart */}
              <Card>
                <CardHeader>
                  <CardTitle>Monthly Revenue</CardTitle>
                  <CardDescription>Revenue trend over the past months</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="h-[300px]">
                    {monthlyTrends.length > 0 ? (
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={monthlyTrends}>
                          <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                          <XAxis dataKey="month" className="text-xs" />
                          <YAxis className="text-xs" />
                          <Tooltip 
                            formatter={(value: number) => [`$${value.toLocaleString()}`, 'Revenue']}
                            contentStyle={{ 
                              backgroundColor: 'hsl(var(--background))', 
                              border: '1px solid hsl(var(--border))' 
                            }}
                          />
                          <Bar dataKey="revenue" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    ) : (
                      <div className="flex items-center justify-center h-full text-muted-foreground">
                        No data available for the selected period
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>

              {/* Trip Distribution */}
              <Card>
                <CardHeader>
                  <CardTitle>Trip Distribution</CardTitle>
                  <CardDescription>Breakdown by service type</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="h-[300px]">
                    {tripDistribution.length > 0 ? (
                      <ResponsiveContainer width="100%" height="100%">
                        <RechartsPieChart>
                          <Pie
                            data={tripDistribution}
                            cx="50%"
                            cy="50%"
                            outerRadius={100}
                            fill="hsl(var(--primary))"
                            dataKey="value"
                            label={({ category, value }) => `${category}: ${value}%`}
                          >
                            {tripDistribution.map((_, index) => (
                              <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                            ))}
                          </Pie>
                          <Tooltip />
                        </RechartsPieChart>
                      </ResponsiveContainer>
                    ) : (
                      <div className="flex items-center justify-center h-full text-muted-foreground">
                        No data available for the selected period
                      </div>
                    )}
                  </div>
                  {tripDistribution.length > 0 && (
                    <div className="flex flex-wrap justify-center gap-4 mt-4">
                      {tripDistribution.map((item, index) => (
                        <div key={item.category} className="flex items-center gap-2">
                          <div 
                            className="w-3 h-3 rounded-full" 
                            style={{ backgroundColor: COLORS[index % COLORS.length] }} 
                          />
                          <span className="text-sm">{item.category}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="trends" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Trip & Revenue Trends</CardTitle>
                <CardDescription>Monthly comparison of trips and revenue</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-[400px]">
                  {monthlyTrends.length > 0 ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <RechartsLineChart data={monthlyTrends}>
                        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                        <XAxis dataKey="month" className="text-xs" />
                        <YAxis yAxisId="left" className="text-xs" />
                        <YAxis yAxisId="right" orientation="right" className="text-xs" />
                        <Tooltip 
                          contentStyle={{ 
                            backgroundColor: 'hsl(var(--background))', 
                            border: '1px solid hsl(var(--border))' 
                          }}
                        />
                        <Line 
                          yAxisId="left" 
                          type="monotone" 
                          dataKey="trips" 
                          stroke="hsl(var(--primary))" 
                          strokeWidth={2}
                          name="Trips"
                        />
                        <Line 
                          yAxisId="right" 
                          type="monotone" 
                          dataKey="revenue" 
                          stroke="hsl(var(--chart-2))" 
                          strokeWidth={2}
                          name="Revenue ($)"
                        />
                      </RechartsLineChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="flex items-center justify-center h-full text-muted-foreground">
                      No data available for the selected period
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="accounts" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Corporate Accounts</CardTitle>
                <CardDescription>Account overview and balances</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Company</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Credit Limit</TableHead>
                      <TableHead>Current Balance</TableHead>
                      <TableHead>Discount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {accounts.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">
                          No corporate accounts found
                        </TableCell>
                      </TableRow>
                    ) : (
                      accounts.map((account: any) => (
                        <TableRow key={account.id}>
                          <TableCell className="font-medium">{account.company_name}</TableCell>
                          <TableCell>
                            <Badge variant={account.status === 'active' ? 'default' : 'secondary'}>
                              {account.status}
                            </Badge>
                          </TableCell>
                          <TableCell>${(account.credit_limit || 0).toLocaleString()}</TableCell>
                          <TableCell>${(account.current_balance || 0).toLocaleString()}</TableCell>
                          <TableCell>{account.discount_percentage || 0}%</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="usage" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Usage by Time of Day</CardTitle>
                <CardDescription>When corporate trips are most common</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-[300px]">
                  {usageByTime.some(u => u.trips > 0) ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={usageByTime}>
                        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                        <XAxis dataKey="hour" className="text-xs" />
                        <YAxis className="text-xs" />
                        <Tooltip 
                          contentStyle={{ 
                            backgroundColor: 'hsl(var(--background))', 
                            border: '1px solid hsl(var(--border))' 
                          }}
                        />
                        <Bar dataKey="trips" fill="hsl(var(--chart-2))" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="flex items-center justify-center h-full text-muted-foreground">
                      No data available for the selected period
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </AdminLayout>
  );
}
