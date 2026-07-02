import { useState, useEffect, useMemo } from 'react';
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
import { useRegions } from '@/hooks/useRegions';
import { getCurrencySymbol } from '@/lib/regionSettings';
import {
  calculateMonthlyTripTrends,
  isCountableCorporateFinancialTrip,
  type CorporateReportTripRow,
} from '@/lib/corporateReportFinance';
import { 
  BarChart3, 
  Download, 
  Calendar,
  FileText,
  RefreshCw,
  TrendingUp,
  Users,
  Car,
  Clock,
  MapPin,
  Building2,
  Globe,
  Calculator,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LineChart as RechartsLineChart, Line, PieChart as RechartsPieChart, Pie, Cell } from 'recharts';

const COLORS = ['hsl(var(--primary))', 'hsl(var(--chart-2))', 'hsl(var(--chart-3))', 'hsl(var(--chart-4))'];

export default function CorporateReports() {
  const [activeTab, setActiveTab] = useState('overview');
  const [dateRange, setDateRange] = useState('last30');
  const [regionFilter, setRegionFilter] = useState<string>('all');
  const [serviceAreaFilter, setServiceAreaFilter] = useState<string>('all');
  const [selectedAccount, setSelectedAccount] = useState<string>('all');

  // Fetch regions (shared hook, cached)
  const { data: regions = [] } = useRegions();

  // Resolve currency from selected region
  const selectedRegion = useMemo(() => {
    if (regionFilter === 'all') return null;
    return regions.find(r => r.id === regionFilter) || null;
  }, [regionFilter, regions]);

  const currencyCode = selectedRegion?.currency_code || '';

  // Fetch service areas based on region filter
  const { data: serviceAreas = [] } = useQuery({
    queryKey: ['service-areas-corp-reports', regionFilter],
    queryFn: async () => {
      let query = supabase.from('service_areas').select('id, name, region_id').order('name');
      if (regionFilter !== 'all') {
        query = query.eq('region_id', regionFilter);
      }
      const { data, error } = await query;
      if (error) throw error;
      return data || [];
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

  // Build date range
  const dateRangeDates = useMemo(() => {
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
    return { start: startDate.toISOString(), end: now.toISOString() };
  }, [dateRange]);

  // Fetch corporate trip data — operational counts only (finance in FR → Trips)
  const { data: tripData = [], isLoading } = useQuery<CorporateReportTripRow[]>({
    queryKey: ['corporate-trip-reports', dateRange, regionFilter, serviceAreaFilter, selectedAccount],
    queryFn: async () => {
      let query = supabase
        .from('trips')
        .select(`
          id, created_at, status, financial_outcome, service_area_id, corporate_account_id,
          corporate_account:corporate_accounts!trips_corporate_account_id_fkey(id, company_name)
        `)
        .not('corporate_account_id', 'is', null)
        .gte('created_at', dateRangeDates.start);
      
      if (serviceAreaFilter !== 'all') {
        query = query.eq('service_area_id', serviceAreaFilter);
      }
      
      if (selectedAccount !== 'all') {
        query = query.eq('corporate_account_id', selectedAccount);
      }
      
      const { data: trips, error } = await query;
      if (error) throw error;
      return trips ?? [];
    },
  });

  const calculateTripDistribution = (trips: CorporateReportTripRow[]) => {
    if (!trips.length) return [];
    const distribution: Record<string, number> = {};
    
    trips.forEach(trip => {
      const companyName = (trip.corporate_account as any)?.company_name || 'Unknown';
      distribution[companyName] = (distribution[companyName] || 0) + 1;
    });
    
    const total = trips.length;
    return Object.entries(distribution)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([category, count]) => ({
        category,
        value: Math.round((count / total) * 100),
        count,
      }));
  };

  const calculateUsageByTime = (trips: CorporateReportTripRow[]) => {
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

  const financialTrips = tripData.filter(isCountableCorporateFinancialTrip);
  const totalTrips = tripData.length;
  const activeAccounts = accounts.filter((a: { status?: string }) => a.status === 'active').length;
  const monthlyTrends = calculateMonthlyTripTrends(financialTrips);
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
                  <SelectItem key={region.id} value={region.id}>
                    {region.name} ({getCurrencySymbol(region.currency_code)})
                  </SelectItem>
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
                {serviceAreas.map((area: any) => (
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

        {/* Mixed currency warning */}
        {!currencyCode && regions.length > 1 && (
          <div className="rounded-md border border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-800 p-3 text-sm text-amber-800 dark:text-amber-200">
            Select a Region to see settlement revenue in the correct currency. Showing raw totals without currency conversion.
          </div>
        )}

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
              <p className="text-xs text-muted-foreground">{financialTrips.length} with financial outcome</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Financial Trips</CardTitle>
              <Car className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{financialTrips.length.toLocaleString()}</div>
              <p className="text-xs text-muted-foreground">Countable corporate trips in period</p>
            </CardContent>
          </Card>
          <Card className="border-primary/30 bg-primary/5">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Settlement &amp; Commission (SSOT)</CardTitle>
              <Calculator className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                Customer paid, commission, and driver settlement per trip are on Trip History (Trip Settlement SSOT) only.
              </p>
              <Button asChild variant="outline" size="sm" className="mt-3">
                <Link to="/trip-history">Trip History (Settlement SSOT)</Link>
              </Button>
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
              <Clock className="h-4 w-4" />
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
                  <CardTitle>Monthly Corporate Trip Volume</CardTitle>
                  <CardDescription>Trip count trend — fare/settlement values on Trip History</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="h-[300px]">
                    {monthlyTrends.length > 0 ? (
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={monthlyTrends}>
                          <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                          <XAxis dataKey="month" className="text-xs" />
                          <YAxis className="text-xs" allowDecimals={false} />
                          <Tooltip
                            formatter={(value: number) => [value, 'Trips']}
                            contentStyle={{
                              backgroundColor: 'hsl(var(--background))',
                              border: '1px solid hsl(var(--border))',
                            }}
                          />
                          <Bar dataKey="trips" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
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
                  <CardDescription>Breakdown by corporate account</CardDescription>
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
                            label={(props: any) => `${props.category}: ${props.value}%`}
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
                <CardTitle>Monthly trip volume</CardTitle>
                <CardDescription>Corporate trip counts by month — settlement values on Trip History</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-[400px]">
                  {monthlyTrends.length > 0 ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <RechartsLineChart data={monthlyTrends}>
                        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                        <XAxis dataKey="month" className="text-xs" />
                        <YAxis className="text-xs" />
                        <Tooltip
                          formatter={(value: number) => [value, 'Trips']}
                          contentStyle={{
                            backgroundColor: 'hsl(var(--background))',
                            border: '1px solid hsl(var(--border))',
                          }}
                        />
                        <Line
                          type="monotone"
                          dataKey="trips"
                          stroke="hsl(var(--primary))"
                          strokeWidth={2}
                          name="Trips"
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
                <CardTitle>Corporate Account Performance</CardTitle>
                <CardDescription>Trip volume by account — settlement on Trip History</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Company</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Trips</TableHead>
                      <TableHead>Trip settlement</TableHead>
                      <TableHead className="text-right">Discount</TableHead>
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
                      accounts.map((account: any) => {
                        const accountTrips = financialTrips.filter((trip) => trip.corporate_account_id === account.id);
                        
                        return (
                          <TableRow key={account.id}>
                            <TableCell className="font-medium">{account.company_name}</TableCell>
                            <TableCell>
                              <Badge variant={account.status === 'active' ? 'default' : 'secondary'}>
                                {account.status}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-right font-medium">{accountTrips.length}</TableCell>
                            <TableCell>
                              <Button asChild variant="link" size="sm" className="h-auto p-0 text-xs">
                                <Link to="/trip-history">Trip History</Link>
                              </Button>
                            </TableCell>
                            <TableCell className="text-right">{account.discount_percentage || 0}%</TableCell>
                          </TableRow>
                        );
                      })
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
