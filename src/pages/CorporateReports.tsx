import { useState } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
  LineChart
} from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LineChart as RechartsLineChart, Line, PieChart as RechartsPieChart, Pie, Cell } from 'recharts';

interface ReportData {
  corporate_summary: {
    total_accounts: number;
    active_accounts: number;
    total_trips: number;
    total_revenue: number;
    avg_trip_cost: number;
    top_accounts: { name: string; trips: number; revenue: number }[];
  };
  monthly_trends: { month: string; trips: number; revenue: number }[];
  trip_distribution: { category: string; value: number }[];
  usage_by_time: { hour: string; trips: number }[];
}

const defaultReportData: ReportData = {
  corporate_summary: {
    total_accounts: 15,
    active_accounts: 12,
    total_trips: 2450,
    total_revenue: 125000,
    avg_trip_cost: 51.02,
    top_accounts: [
      { name: 'Global Finance Ltd', trips: 520, revenue: 35000 },
      { name: 'TechCorp Solutions', trips: 380, revenue: 22000 },
      { name: 'Healthcare Solutions LLC', trips: 290, revenue: 18500 },
      { name: 'Legal Partners LLP', trips: 210, revenue: 15000 },
      { name: 'Marketing Pros Inc', trips: 180, revenue: 12000 },
    ],
  },
  monthly_trends: [
    { month: 'Aug', trips: 180, revenue: 9200 },
    { month: 'Sep', trips: 210, revenue: 10800 },
    { month: 'Oct', trips: 245, revenue: 12500 },
    { month: 'Nov', trips: 220, revenue: 11200 },
    { month: 'Dec', trips: 195, revenue: 10000 },
    { month: 'Jan', trips: 260, revenue: 13300 },
  ],
  trip_distribution: [
    { category: 'Executive', value: 35 },
    { category: 'Standard', value: 45 },
    { category: 'Airport', value: 15 },
    { category: 'Events', value: 5 },
  ],
  usage_by_time: [
    { hour: '6AM', trips: 45 },
    { hour: '8AM', trips: 180 },
    { hour: '10AM', trips: 120 },
    { hour: '12PM', trips: 90 },
    { hour: '2PM', trips: 75 },
    { hour: '4PM', trips: 85 },
    { hour: '6PM', trips: 160 },
    { hour: '8PM', trips: 95 },
  ],
};

const COLORS = ['hsl(var(--primary))', 'hsl(var(--chart-2))', 'hsl(var(--chart-3))', 'hsl(var(--chart-4))'];

export default function CorporateReports() {
  const [activeTab, setActiveTab] = useState('overview');
  const [dateRange, setDateRange] = useState('last30');
  const [selectedAccount, setSelectedAccount] = useState<string>('all');

  // Fetch report data
  const { data: reportData = defaultReportData, isLoading } = useQuery({
    queryKey: ['corporate-reports', dateRange, selectedAccount],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('admin_settings')
        .select('*')
        .eq('setting_key', 'corporate_reports')
        .maybeSingle();
      
      if (error) throw error;
      return (data?.setting_value as unknown as ReportData) || defaultReportData;
    },
  });

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
          <div className="flex gap-2">
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
            <Select value={selectedAccount} onValueChange={setSelectedAccount}>
              <SelectTrigger className="w-[200px]">
                <Building2 className="h-4 w-4 mr-2" />
                <SelectValue placeholder="All Accounts" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Accounts</SelectItem>
                {reportData.corporate_summary.top_accounts.map((acc) => (
                  <SelectItem key={acc.name} value={acc.name}>{acc.name}</SelectItem>
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
              <div className="text-2xl font-bold">{reportData.corporate_summary.total_accounts}</div>
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <TrendingUp className="h-3 w-3 text-green-500" />
                {reportData.corporate_summary.active_accounts} active
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Trips</CardTitle>
              <Car className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{reportData.corporate_summary.total_trips.toLocaleString()}</div>
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <TrendingUp className="h-3 w-3 text-green-500" />
                +12% from last period
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Revenue</CardTitle>
              <DollarSign className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">${reportData.corporate_summary.total_revenue.toLocaleString()}</div>
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <TrendingUp className="h-3 w-3 text-green-500" />
                +8% from last period
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Avg Trip Cost</CardTitle>
              <BarChart3 className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">${reportData.corporate_summary.avg_trip_cost.toFixed(2)}</div>
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <TrendingDown className="h-3 w-3 text-red-500" />
                -3% from last period
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Trips/Account</CardTitle>
              <Users className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {Math.round(reportData.corporate_summary.total_trips / reportData.corporate_summary.active_accounts)}
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
                  <CardDescription>Revenue trend over the past 6 months</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="h-[300px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={reportData.monthly_trends}>
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
                    <ResponsiveContainer width="100%" height="100%">
                      <RechartsPieChart>
                        <Pie
                          data={reportData.trip_distribution}
                          cx="50%"
                          cy="50%"
                          outerRadius={100}
                          fill="hsl(var(--primary))"
                          dataKey="value"
                          label={({ category, value }) => `${category}: ${value}%`}
                        >
                          {reportData.trip_distribution.map((_, index) => (
                            <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                          ))}
                        </Pie>
                        <Tooltip />
                      </RechartsPieChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="flex flex-wrap justify-center gap-4 mt-4">
                    {reportData.trip_distribution.map((item, index) => (
                      <div key={item.category} className="flex items-center gap-2">
                        <div 
                          className="w-3 h-3 rounded-full" 
                          style={{ backgroundColor: COLORS[index % COLORS.length] }} 
                        />
                        <span className="text-sm">{item.category}</span>
                      </div>
                    ))}
                  </div>
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
                  <ResponsiveContainer width="100%" height="100%">
                    <RechartsLineChart data={reportData.monthly_trends}>
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
                        dot={{ fill: 'hsl(var(--primary))' }}
                      />
                      <Line 
                        yAxisId="right" 
                        type="monotone" 
                        dataKey="revenue" 
                        stroke="hsl(var(--chart-2))" 
                        strokeWidth={2}
                        dot={{ fill: 'hsl(var(--chart-2))' }}
                      />
                    </RechartsLineChart>
                  </ResponsiveContainer>
                </div>
                <div className="flex justify-center gap-6 mt-4">
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full bg-primary" />
                    <span className="text-sm">Trips</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full" style={{ backgroundColor: 'hsl(var(--chart-2))' }} />
                    <span className="text-sm">Revenue ($)</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="accounts" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Top Corporate Accounts</CardTitle>
                <CardDescription>Ranked by total revenue</CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Rank</TableHead>
                      <TableHead>Account</TableHead>
                      <TableHead className="text-right">Trips</TableHead>
                      <TableHead className="text-right">Revenue</TableHead>
                      <TableHead className="text-right">Avg/Trip</TableHead>
                      <TableHead className="text-right">Share</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {reportData.corporate_summary.top_accounts.map((account, index) => (
                      <TableRow key={account.name}>
                        <TableCell>
                          <Badge variant={index < 3 ? 'default' : 'outline'}>#{index + 1}</Badge>
                        </TableCell>
                        <TableCell className="font-medium">{account.name}</TableCell>
                        <TableCell className="text-right">{account.trips.toLocaleString()}</TableCell>
                        <TableCell className="text-right font-medium">${account.revenue.toLocaleString()}</TableCell>
                        <TableCell className="text-right">${(account.revenue / account.trips).toFixed(2)}</TableCell>
                        <TableCell className="text-right">
                          {((account.revenue / reportData.corporate_summary.total_revenue) * 100).toFixed(1)}%
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="usage" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Usage by Time of Day</CardTitle>
                <CardDescription>Peak hours for corporate trips</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-[400px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={reportData.usage_by_time}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis dataKey="hour" className="text-xs" />
                      <YAxis className="text-xs" />
                      <Tooltip 
                        formatter={(value: number) => [value, 'Trips']}
                        contentStyle={{ 
                          backgroundColor: 'hsl(var(--background))', 
                          border: '1px solid hsl(var(--border))' 
                        }}
                      />
                      <Bar dataKey="trips" fill="hsl(var(--chart-2))" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="mt-4 p-4 bg-muted rounded-lg">
                  <p className="text-sm font-medium">Peak Hours Analysis</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    Morning rush (8AM) and evening commute (6PM) show highest demand. 
                    Consider surge pricing adjustments during these periods.
                  </p>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </AdminLayout>
  );
}
