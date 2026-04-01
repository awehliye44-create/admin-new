import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { Smartphone, Car, Globe, Activity, Clock, AlertTriangle, TrendingUp, Zap, RefreshCw, Building2 } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

type HealthSummaryRow = {
  app_name: string;
  screen_name: string;
  metric_name: string;
  event_count: number;
  avg_ms: number;
  median_ms: number;
  p95_ms: number;
  p99_ms: number;
  min_ms: number;
  max_ms: number;
  last_event_at: string;
};

type Threshold = {
  id: string;
  app_name: string;
  screen_name: string | null;
  metric_name: string;
  warning_threshold: number;
  critical_threshold: number;
  is_active: boolean;
};

const APP_CONFIG = [
  { key: 'customer_app', label: 'Customer App', icon: Smartphone, color: 'text-blue-500' },
  { key: 'driver_app', label: 'Driver App', icon: Car, color: 'text-emerald-500' },
  { key: 'guest_web', label: 'Guest Web', icon: Globe, color: 'text-purple-500' },
  { key: 'corporate_web', label: 'Corporate Web', icon: Building2, color: 'text-orange-500' },
  { key: 'admin_panel', label: 'Admin Panel', icon: Activity, color: 'text-amber-500' },
] as const;

function getHealthStatus(avgMs: number, thresholds: Threshold[], appName: string, screenName: string, metricName: string) {
  const t = thresholds.find(
    th => th.app_name === appName && th.metric_name === metricName &&
      (th.screen_name === null || th.screen_name === screenName)
  );
  if (!t) return { status: 'unknown', label: 'No threshold' };
  if (avgMs >= t.critical_threshold) return { status: 'critical', label: 'Critical' };
  if (avgMs >= t.warning_threshold) return { status: 'warning', label: 'Warning' };
  return { status: 'healthy', label: 'Healthy' };
}

function StatusBadge({ status, label }: { status: string; label: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        'text-xs font-semibold',
        status === 'critical' && 'border-destructive/50 bg-destructive/10 text-destructive',
        status === 'warning' && 'border-amber-500/50 bg-amber-500/10 text-amber-600',
        status === 'healthy' && 'border-emerald-500/50 bg-emerald-500/10 text-emerald-600',
        status === 'unknown' && 'border-muted-foreground/30 bg-muted text-muted-foreground',
      )}
    >
      {label}
    </Badge>
  );
}

function AppHealthCard({
  appKey,
  label,
  Icon,
  iconColor,
  data,
  thresholds,
}: {
  appKey: string;
  label: string;
  Icon: React.ElementType;
  iconColor: string;
  data: HealthSummaryRow[];
  thresholds: Threshold[];
}) {
  const appData = data.filter(d => d.app_name === appKey);
  const totalEvents = appData.reduce((s, d) => s + d.event_count, 0);
  const avgOverall = appData.length > 0
    ? Math.round(appData.reduce((s, d) => s + d.avg_ms * d.event_count, 0) / Math.max(totalEvents, 1))
    : 0;
  const worstScreen = appData.length > 0
    ? appData.reduce((w, d) => d.p95_ms > (w?.p95_ms || 0) ? d : w, appData[0])
    : null;

  const criticalCount = appData.filter(d => {
    const h = getHealthStatus(d.avg_ms, thresholds, d.app_name, d.screen_name, d.metric_name);
    return h.status === 'critical';
  }).length;
  const warningCount = appData.filter(d => {
    const h = getHealthStatus(d.avg_ms, thresholds, d.app_name, d.screen_name, d.metric_name);
    return h.status === 'warning';
  }).length;

  const overallStatus = criticalCount > 0 ? 'critical' : warningCount > 0 ? 'warning' : totalEvents > 0 ? 'healthy' : 'unknown';

  return (
    <Card className={cn(
      'border transition-all',
      overallStatus === 'critical' && 'border-destructive/40 bg-destructive/5',
      overallStatus === 'warning' && 'border-amber-500/40 bg-amber-500/5',
      overallStatus === 'healthy' && 'border-emerald-500/30 bg-emerald-500/5',
    )}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Icon className={cn('h-5 w-5', iconColor)} />
            <CardTitle className="text-sm font-semibold">{label}</CardTitle>
          </div>
          <StatusBadge status={overallStatus} label={overallStatus === 'unknown' ? 'No Data' : overallStatus.charAt(0).toUpperCase() + overallStatus.slice(1)} />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-3 gap-2 text-center">
          <div>
            <p className="text-[10px] text-muted-foreground uppercase">Events</p>
            <p className="text-lg font-bold">{totalEvents}</p>
          </div>
          <div>
            <p className="text-[10px] text-muted-foreground uppercase">Avg</p>
            <p className="text-lg font-bold">{avgOverall}<span className="text-xs text-muted-foreground">ms</span></p>
          </div>
          <div>
            <p className="text-[10px] text-muted-foreground uppercase">Issues</p>
            <p className="text-lg font-bold">
              {criticalCount > 0 && <span className="text-destructive">{criticalCount}C</span>}
              {criticalCount > 0 && warningCount > 0 && ' '}
              {warningCount > 0 && <span className="text-amber-600">{warningCount}W</span>}
              {criticalCount === 0 && warningCount === 0 && <span className="text-emerald-600">0</span>}
            </p>
          </div>
        </div>
        {worstScreen && totalEvents > 0 && (
          <div className="text-xs text-muted-foreground border-t pt-2">
            <span className="font-medium">Slowest:</span> {worstScreen.screen_name} — P95 {worstScreen.p95_ms}ms
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ScreenMetricsTable({ data, thresholds }: { data: HealthSummaryRow[]; thresholds: Threshold[] }) {
  if (data.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <Activity className="h-8 w-8 mx-auto mb-3 opacity-40" />
        <p className="text-sm font-medium">No telemetry data yet</p>
        <p className="text-xs mt-1">Integrate the SDK in your mobile apps to start collecting performance data.</p>
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>App</TableHead>
          <TableHead>Screen</TableHead>
          <TableHead>Metric</TableHead>
          <TableHead className="text-right">Events</TableHead>
          <TableHead className="text-right">Avg</TableHead>
          <TableHead className="text-right">Median</TableHead>
          <TableHead className="text-right">P95</TableHead>
          <TableHead className="text-right">P99</TableHead>
          <TableHead className="text-right">Max</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Last Event</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.map((row, i) => {
          const health = getHealthStatus(row.avg_ms, thresholds, row.app_name, row.screen_name, row.metric_name);
          return (
            <TableRow key={i} className={cn(
              health.status === 'critical' && 'bg-destructive/5',
              health.status === 'warning' && 'bg-amber-500/5',
            )}>
              <TableCell className="text-xs font-medium">{row.app_name.replace('_', ' ')}</TableCell>
              <TableCell className="text-xs font-medium">{row.screen_name}</TableCell>
              <TableCell className="text-xs">{row.metric_name}</TableCell>
              <TableCell className="text-right text-xs tabular-nums">{row.event_count}</TableCell>
              <TableCell className="text-right text-xs tabular-nums font-medium">{row.avg_ms}ms</TableCell>
              <TableCell className="text-right text-xs tabular-nums">{row.median_ms}ms</TableCell>
              <TableCell className="text-right text-xs tabular-nums font-medium">{row.p95_ms}ms</TableCell>
              <TableCell className="text-right text-xs tabular-nums">{row.p99_ms}ms</TableCell>
              <TableCell className="text-right text-xs tabular-nums">{row.max_ms}ms</TableCell>
              <TableCell><StatusBadge status={health.status} label={health.label} /></TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {row.last_event_at ? formatDistanceToNow(new Date(row.last_event_at), { addSuffix: true }) : '—'}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function MoneyScreensPanel({ data, thresholds }: { data: HealthSummaryRow[]; thresholds: Threshold[] }) {
  const moneyScreens = [
    'PaymentScreen', 'PayoutScreen', 'EarningsScreen', 'CommissionScreen',
    'WalletScreen', 'CheckoutPage', 'BookingPayment', 'DriverSettlement',
    'InvoiceScreen', 'BookingConfirmation', 'PaymentFlow', 'PaymentPage', 'InvoicePage',
  ];
  const moneyData = data.filter(d => moneyScreens.includes(d.screen_name));

  if (moneyData.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <Clock className="h-8 w-8 mx-auto mb-3 opacity-40" />
        <p className="text-sm font-medium">No money screen telemetry yet</p>
        <p className="text-xs mt-1">Payment, payout, and earnings screens will appear here once instrumented.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {moneyData.filter(d => d.metric_name === 'screen_load_time').map((d, i) => {
          const health = getHealthStatus(d.avg_ms, thresholds, d.app_name, d.screen_name, d.metric_name);
          return (
            <Card key={i} className={cn(
              'border',
              health.status === 'critical' && 'border-destructive/40 bg-destructive/5',
              health.status === 'warning' && 'border-amber-500/40 bg-amber-500/5',
            )}>
              <CardContent className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-medium">{d.screen_name}</span>
                  <StatusBadge status={health.status} label={health.label} />
                </div>
                <p className="text-xs text-muted-foreground mb-1">{d.app_name.replace('_', ' ')}</p>
                <div className="flex items-baseline gap-2">
                  <span className="text-2xl font-bold">{d.avg_ms}</span>
                  <span className="text-xs text-muted-foreground">ms avg</span>
                </div>
                <div className="flex gap-3 mt-2 text-[10px] text-muted-foreground">
                  <span>P95: {d.p95_ms}ms</span>
                  <span>Max: {d.max_ms}ms</span>
                  <span>{d.event_count} events</span>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
      <ScreenMetricsTable data={moneyData} thresholds={thresholds} />
    </div>
  );
}

export function AppPerformanceDashboard() {
  const [activeApp, setActiveApp] = useState<string>('all');
  const [includeSeed, setIncludeSeed] = useState(false);

  const { data: healthData, isLoading: healthLoading, refetch } = useQuery({
    queryKey: ['app-health-summary', includeSeed],
    queryFn: async () => {
      if (!includeSeed) {
        const { data, error } = await supabase
          .from('app_health_summary')
          .select('*');
        if (error) throw error;
        return (data || []) as HealthSummaryRow[];
      }
      // Include synthetic data — query raw events and aggregate client-side
      const { data, error } = await supabase
        .from('app_performance_events')
        .select('app_name, screen_name, metric_name, metric_value, created_at')
        .gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
        .limit(5000);
      if (error) throw error;
      if (!data || data.length === 0) return [];
      // Group and aggregate
      const groups: Record<string, { values: number[]; lastAt: string }> = {};
      for (const e of data) {
        const key = `${e.app_name}|${e.screen_name}|${e.metric_name}`;
        if (!groups[key]) groups[key] = { values: [], lastAt: e.created_at };
        groups[key].values.push(e.metric_value);
        if (e.created_at > groups[key].lastAt) groups[key].lastAt = e.created_at;
      }
      return Object.entries(groups).map(([key, g]) => {
        const [app_name, screen_name, metric_name] = key.split('|');
        const sorted = g.values.sort((a, b) => a - b);
        const len = sorted.length;
        const p = (pct: number) => sorted[Math.min(Math.floor(pct * len), len - 1)];
        return {
          app_name, screen_name, metric_name,
          event_count: len,
          avg_ms: Math.round(sorted.reduce((s, v) => s + v, 0) / len),
          median_ms: Math.round(p(0.5)),
          p95_ms: Math.round(p(0.95)),
          p99_ms: Math.round(p(0.99)),
          min_ms: Math.round(sorted[0]),
          max_ms: Math.round(sorted[len - 1]),
          last_event_at: g.lastAt,
        } as HealthSummaryRow;
      });
    },
    staleTime: 15000,
  });

  const { data: thresholds } = useQuery({
    queryKey: ['app-perf-thresholds'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('app_performance_thresholds')
        .select('*')
        .eq('is_active', true);
      if (error) throw error;
      return (data || []) as Threshold[];
    },
    staleTime: 60000,
  });

  const allThresholds = thresholds || [];
  const allData = healthData || [];
  const filteredData = activeApp === 'all' ? allData : allData.filter(d => d.app_name === activeApp);

  if (healthLoading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[1, 2, 3].map(i => <Skeleton key={i} className="h-40" />)}
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* App health overview cards */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
          <Zap className="h-4 w-4" /> App Health Overview {includeSeed ? '(All Data — 7 Days)' : '(Last 24 Hours)'}
        </h3>
        <div className="flex items-center gap-2">
          <Button
            variant={includeSeed ? 'default' : 'outline'}
            size="sm"
            onClick={() => setIncludeSeed(!includeSeed)}
            className="text-xs"
          >
            {includeSeed ? 'Showing All Data' : 'Include Seed Data'}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => refetch()}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
        {APP_CONFIG.map(({ key, label, icon: Icon, color }) => (
          <AppHealthCard
            key={key}
            appKey={key}
            label={label}
            Icon={Icon}
            iconColor={color}
            data={allData}
            thresholds={allThresholds}
          />
        ))}
      </div>

      {/* Detail tabs */}
      <Tabs defaultValue="all-screens">
        <TabsList className="flex-wrap h-auto gap-1">
          <TabsTrigger value="all-screens" className="gap-1.5 text-xs">
            <Activity className="h-3.5 w-3.5" /> All Screens
          </TabsTrigger>
          <TabsTrigger value="money-screens" className="gap-1.5 text-xs">
            <AlertTriangle className="h-3.5 w-3.5" /> Money Screens
          </TabsTrigger>
          <TabsTrigger value="version-breakdown" className="gap-1.5 text-xs">
            <TrendingUp className="h-3.5 w-3.5" /> By Version
          </TabsTrigger>
        </TabsList>

        <div className="mt-4 flex items-center gap-2">
          <Button
            variant={activeApp === 'all' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setActiveApp('all')}
            className="text-xs"
          >
            All Apps
          </Button>
          {APP_CONFIG.map(({ key, label }) => (
            <Button
              key={key}
              variant={activeApp === key ? 'default' : 'outline'}
              size="sm"
              onClick={() => setActiveApp(key)}
              className="text-xs"
            >
              {label}
            </Button>
          ))}
        </div>

        <TabsContent value="all-screens" className="mt-4">
          <Card>
            <CardContent className="p-0">
              <ScreenMetricsTable data={filteredData} thresholds={allThresholds} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="money-screens" className="mt-4">
          <MoneyScreensPanel data={filteredData} thresholds={allThresholds} />
        </TabsContent>

        <TabsContent value="version-breakdown" className="mt-4">
          <VersionBreakdownPanel activeApp={activeApp} />
        </TabsContent>
      </Tabs>

      {/* Integration guide */}
      <Card className="border-dashed">
        <CardContent className="p-4">
          <h4 className="text-sm font-semibold mb-2">📱 Integration Guide</h4>
          <p className="text-xs text-muted-foreground mb-2">
            Send telemetry from your mobile apps by POSTing to the <code className="bg-muted px-1 py-0.5 rounded text-[11px]">ingest-telemetry</code> edge function:
          </p>
          <pre className="bg-muted/50 p-3 rounded text-[11px] overflow-x-auto">{`POST /functions/v1/ingest-telemetry
Content-Type: application/json

{
  "app_name": "customer_app",
  "screen_name": "PaymentScreen",
  "metric_name": "screen_load_time",
  "metric_value": 4500,
  "app_version": "2.3.1",
  "platform": "ios"
}`}</pre>
        </CardContent>
      </Card>
    </div>
  );
}

/** Version breakdown sub-panel */
function VersionBreakdownPanel({ activeApp }: { activeApp: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['app-version-breakdown', activeApp],
    queryFn: async () => {
      let query = supabase
        .from('app_performance_events')
        .select('app_name, app_version, platform, metric_name, metric_value')
        .gte('created_at', new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString())
        .not('app_version', 'is', null)
        .eq('is_synthetic', false)
        .limit(1000);

      if (activeApp !== 'all') {
        query = query.eq('app_name', activeApp);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data || [];
    },
    staleTime: 30000,
  });

  if (isLoading) return <Skeleton className="h-40" />;

  if (!data || data.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <TrendingUp className="h-8 w-8 mx-auto mb-3 opacity-40" />
        <p className="text-sm font-medium">No version-specific data yet</p>
        <p className="text-xs mt-1">Include <code className="bg-muted px-1 rounded">app_version</code> in telemetry events.</p>
      </div>
    );
  }

  // Aggregate by app + version
  const grouped: Record<string, { app: string; version: string; platform: string | null; count: number; totalMs: number }> = {};
  data.forEach((e: any) => {
    const k = `${e.app_name}|${e.app_version}|${e.platform || 'unknown'}`;
    if (!grouped[k]) grouped[k] = { app: e.app_name, version: e.app_version, platform: e.platform, count: 0, totalMs: 0 };
    grouped[k].count++;
    grouped[k].totalMs += Number(e.metric_value);
  });

  const rows = Object.values(grouped).sort((a, b) => (b.totalMs / b.count) - (a.totalMs / a.count));

  return (
    <Card>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>App</TableHead>
              <TableHead>Version</TableHead>
              <TableHead>Platform</TableHead>
              <TableHead className="text-right">Events</TableHead>
              <TableHead className="text-right">Avg (ms)</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, i) => (
              <TableRow key={i}>
                <TableCell className="text-xs">{r.app.replace('_', ' ')}</TableCell>
                <TableCell className="text-xs font-mono">{r.version}</TableCell>
                <TableCell className="text-xs">{r.platform}</TableCell>
                <TableCell className="text-right text-xs tabular-nums">{r.count}</TableCell>
                <TableCell className="text-right text-xs tabular-nums font-medium">{Math.round(r.totalMs / r.count)}ms</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
