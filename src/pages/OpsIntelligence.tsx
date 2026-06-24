import { useState, useEffect, useCallback, useMemo, lazy, Suspense } from 'react';
import { usePageLoadTelemetry } from '@/hooks/useAdminTelemetry';
import { useSearchParams } from 'react-router-dom';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { OpsHealthCards } from '@/components/ops/OpsHealthCards';
import { OpsAlertsTable } from '@/components/ops/OpsAlertsTable';
import { OpsLogsExplorer } from '@/components/ops/OpsLogsExplorer';
import { OpsReconciliationPanel } from '@/components/ops/OpsReconciliationPanel';
import { OpsAlertDetail } from '@/components/ops/OpsAlertDetail';
import { OpsRealtimeIndicator } from '@/components/ops/OpsRealtimeIndicator';
import { QueryErrorState } from '@/components/QueryErrorState';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { RefreshCw, Activity, AlertTriangle, ScrollText, Shield, CreditCard, Truck, Copy, Globe, Gauge, Smartphone, CheckCircle, Car, Building2 } from 'lucide-react';
import { AppPerformanceDashboard } from '@/components/ops/AppPerformanceDashboard';
import { supabase } from '@/integrations/supabase/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useOpsRealtime } from '@/hooks/useOpsRealtime';

type OpsAlert = {
  id: string;
  fingerprint: string;
  category: string;
  severity: string;
  status: string;
  source: string;
  app: string | null;
  title: string;
  description: string | null;
  fingerprint_count: number;
  first_detected_at: string;
  last_detected_at: string;
  acknowledged_at: string | null;
  resolved_at: string | null;
  related_trip_id: string | null;
  related_driver_id: string | null;
  related_payment_id: string | null;
  related_payout_batch_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

export default function OpsIntelligence() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = searchParams.get('tab') || 'alerts';
  const [selectedAlert, setSelectedAlert] = useState<OpsAlert | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [showResolved, setShowResolved] = useState(false);
  const queryClient = useQueryClient();

  // Screen load tracked by AdminTelemetryProvider's useRouteChangeTracker

  const { status: realtimeStatus, lastEvent } = useOpsRealtime();

  // Listen for focus-alert events from toast clicks
  useEffect(() => {
    const handler = (e: Event) => {
      const alertId = (e as CustomEvent).detail;
      if (alertId && alerts) {
        const found = alerts.find(a => a.id === alertId);
        if (found) setSelectedAlert(found);
      }
    };
    window.addEventListener('ops-focus-alert', handler);
    return () => window.removeEventListener('ops-focus-alert', handler);
  }, []);

  // Fetch health summary — ONLY active (open/acknowledged) alerts from last 24h
  const { data: healthData, isLoading: healthLoading, error: healthError, refetch: refetchHealth } = useQuery({
    queryKey: ['ops-health-summary'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('ops_alerts')
        .select('category, severity, status, last_detected_at, fingerprint')
        .in('status', ['open', 'acknowledged'])
        .not('fingerprint', 'like', 'demo:%')
        .gte('last_detected_at', new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString());
      if (error) throw error;

      const summary: Record<string, { open: number; critical: number; latest: string | null }> = {};
      const categories = ['payment', 'commission', 'earning', 'payout', 'dispatch', 'guest_booking', 'corporate_booking', 'customer_app', 'driver_app', 'backend', 'logs', 'duplication', 'system', 'admin_panel'];
      categories.forEach(c => { summary[c] = { open: 0, critical: 0, latest: null }; });

      (data || []).forEach((a: any) => {
        const cat = a.category === 'corporate_web' ? 'corporate_booking' : a.category;
        if (!summary[cat]) summary[cat] = { open: 0, critical: 0, latest: null };
        summary[cat].open++;
        if (a.severity === 'critical' || a.severity === 'fatal') summary[cat].critical++;
        if (!summary[cat].latest || a.last_detected_at > summary[cat].latest!) {
          summary[cat].latest = a.last_detected_at;
        }
      });
      return summary;
    },
    staleTime: 30000,
  });

  // Fetch alerts — separate active vs resolved
  const { data: alerts, isLoading: alertsLoading, error: alertsError, refetch: refetchAlerts } = useQuery({
    queryKey: ['ops-alerts', categoryFilter, showResolved],
    queryFn: async () => {
      let query = supabase
        .from('ops_alerts')
        .select('id, fingerprint, category, severity, status, source, app, title, description, fingerprint_count, first_detected_at, last_detected_at, acknowledged_at, resolved_at, related_trip_id, related_driver_id, related_payment_id, related_payout_batch_id, metadata, created_at')
        .not('fingerprint', 'like', 'demo:%')
        .order('last_detected_at', { ascending: false })
        .limit(200);

      if (showResolved) {
        query = query.eq('status', 'resolved');
      } else {
        query = query.in('status', ['open', 'acknowledged']);
      }

      if (categoryFilter !== 'all') {
        query = query.eq('category', categoryFilter);
      }

      const { data, error } = await query;
      if (error) throw error;
      return (data || []) as OpsAlert[];
    },
    staleTime: 15000,
  });

  // Top-level stats — only from active alerts
  const activeAlerts = alerts?.filter(a => a.status === 'open') || [];
  const totalOpen = activeAlerts.length;
  const totalCritical = activeAlerts.filter(a => a.severity === 'critical' || a.severity === 'fatal').length;
  const totalAcknowledged = alerts?.filter(a => a.status === 'acknowledged').length || 0;

  const callOpsSeed = async (seedAction: 'seed' | 'clear') => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ops-seed`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
          'Authorization': `Bearer ${session?.access_token ?? ''}`,
        },
        body: JSON.stringify({ action: seedAction }),
      });
      const data = await res.json();
      if (data.success) {
        toast.success(seedAction === 'seed' ? 'Demo data seeded' : 'Demo data cleared', {
          description: seedAction === 'seed' ? `${data.alerts_seeded} alerts, ${data.logs_seeded} logs` : 'All demo alerts and logs removed',
        });
      } else toast.error('Operation failed', { description: JSON.stringify(data) });
    } catch (e: any) { toast.error('Operation failed', { description: e.message }); }
  };


  const handleRunDetections = async () => {
    try {
      const { data, error } = await supabase.rpc('ops_run_all_detections');
      if (error) throw error;
      toast.success('Detection scan complete', { description: JSON.stringify(data) });
    } catch (e: any) {
      toast.error('Scan failed', { description: e.message });
    }
  };

  const handleRefreshAll = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['ops-alerts'] });
    queryClient.invalidateQueries({ queryKey: ['ops-health-summary'] });
    queryClient.invalidateQueries({ queryKey: ['ops-logs'] });
    toast.success('Refreshed');
  }, [queryClient]);

  const allAlerts = alerts || [];

  const { moneyAlerts, dispatchAlerts, guestAlerts, perfAlerts, dupAlerts, driverAppAlerts, customerAppAlerts, corporateAlerts } = useMemo(() => {
    const money: OpsAlert[] = [];
    const dispatch: OpsAlert[] = [];
    const guest: OpsAlert[] = [];
    const perf: OpsAlert[] = [];
    const dup: OpsAlert[] = [];
    const driverApp: OpsAlert[] = [];
    const customerApp: OpsAlert[] = [];
    const corporate: OpsAlert[] = [];

    for (const a of allAlerts) {
      if (['payment', 'commission', 'earning', 'payout'].includes(a.category)) money.push(a);
      if (a.category === 'dispatch') dispatch.push(a);
      if (a.category === 'guest_booking' || a.app === 'guest') guest.push(a);
      if (a.category === 'backend' || a.category === 'logs' ||
          a.fingerprint.includes('latency') || a.fingerprint.includes('5xx') ||
          a.fingerprint.includes('error_spike') || a.fingerprint.includes('edge_fn') ||
          a.fingerprint.includes('fatal_log')) perf.push(a);
      if (a.category === 'duplication') dup.push(a);
      const eventType = typeof a.metadata?.event_type === 'string' ? a.metadata.event_type : '';
      if (
        a.category === 'driver_app' || a.app === 'driver' || a.app === 'driver_app'
        || a.fingerprint.startsWith('driver_') || eventType.startsWith('driver_')
        || a.source === 'workflow' && eventType.startsWith('driver_')
      ) driverApp.push(a);
      if (
        a.category === 'customer_app' || a.app === 'customer' || a.app === 'customer_app'
        || a.fingerprint.startsWith('customer_') || eventType.startsWith('customer_')
        || a.source === 'workflow' && eventType.startsWith('customer_')
      ) customerApp.push(a);
      if (
        a.source === 'workflow' && (
          eventType.startsWith('contradictory_') || eventType.startsWith('rematch_')
          || eventType.startsWith('call_masking_') || eventType.startsWith('offer_presets_')
          || eventType.startsWith('dispatch_timeout_')
        )
      ) perf.push(a);
      if (a.category === 'corporate_booking' || a.category === 'corporate_web' || a.app === 'corporate_web') corporate.push(a);
    }

    return {
      moneyAlerts: money, dispatchAlerts: dispatch, guestAlerts: guest,
      perfAlerts: perf, dupAlerts: dup, driverAppAlerts: driverApp,
      customerAppAlerts: customerApp, corporateAlerts: corporate,
    };
  }, [allAlerts]);

  if (selectedAlert) {
    return (
      <AdminLayout title="Ops Intelligence" description="Alert Detail">
        <OpsAlertDetail
          alert={selectedAlert}
          onBack={() => setSelectedAlert(null)}
          onRefresh={() => {
            queryClient.invalidateQueries({ queryKey: ['ops-alerts'] });
            setSelectedAlert(null);
          }}
        />
      </AdminLayout>
    );
  }

  return (
    <AdminLayout title="Ops Intelligence" description="Platform-wide operations monitoring, alerts & health">
      {/* Top action bar */}
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div className="flex items-center gap-3 flex-wrap">
          <OpsRealtimeIndicator status={realtimeStatus} lastEvent={lastEvent} />
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-muted">
            <Activity className="h-4 w-4 text-primary" />
            <span className="text-sm font-medium">{totalOpen} active</span>
          </div>
          {totalCritical > 0 && (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-destructive/10">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              <span className="text-sm font-medium text-destructive">{totalCritical} critical</span>
            </div>
          )}
          {totalAcknowledged > 0 && (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-muted">
              <Shield className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">{totalAcknowledged} ack'd</span>
            </div>
          )}
          {totalOpen === 0 && totalCritical === 0 && (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-emerald-500/10">
              <CheckCircle className="h-4 w-4 text-emerald-600" />
              <span className="text-sm font-medium text-emerald-600">All clear</span>
            </div>
          )}
        </div>
        <div className="flex gap-2 flex-wrap">
          {/* Active / Resolved toggle */}
          <Button
            onClick={() => setShowResolved(!showResolved)}
            variant={showResolved ? 'default' : 'outline'}
            size="sm"
          >
            {showResolved ? 'Showing Resolved' : 'Show Resolved'}
          </Button>
          <Button onClick={handleRefreshAll} variant="ghost" size="sm" title="Manual refresh">
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button onClick={() => callOpsSeed('seed')} variant="secondary" size="sm">
            Seed Demo
          </Button>
          <Button onClick={() => callOpsSeed('clear')} variant="ghost" size="sm" className="text-muted-foreground">
            Clear Demo
          </Button>
          <Button onClick={handleRunDetections} variant="outline" size="sm">
            <RefreshCw className="h-4 w-4 mr-2" />
            Run Detection Scan
          </Button>
        </div>
      </div>

      {/* Health Cards — only active alerts */}
      {healthError ? (
        <QueryErrorState error={healthError} onRetry={() => refetchHealth()} title="Failed to load health summary" compact />
      ) : (
        <OpsHealthCards data={healthData} loading={healthLoading} onCategoryClick={setCategoryFilter} />
      )}

      {/* Resolved banner */}
      {showResolved && (
        <div className="mt-4 p-3 rounded-lg border border-muted bg-muted/50 flex items-center gap-2">
          <CheckCircle className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">Showing resolved/historical alerts. These no longer affect system health status.</span>
        </div>
      )}

      {/* Main Tabs */}
      <Tabs value={activeTab} onValueChange={(val) => setSearchParams({ tab: val })} className="mt-8">
        <TabsList className="flex-wrap h-auto gap-1">
          <TabsTrigger value="alerts" className="gap-2">
            <AlertTriangle className="h-4 w-4" /> {showResolved ? 'Resolved' : 'Active'} Alerts
            {!showResolved && totalOpen > 0 && <span className="text-[10px] bg-destructive/20 text-destructive px-1.5 py-0.5 rounded-full">{totalOpen}</span>}
          </TabsTrigger>
          <TabsTrigger value="money" className="gap-2">
            <CreditCard className="h-4 w-4" /> Money Integrity
            {!showResolved && moneyAlerts.filter(a => a.status === 'open').length > 0 && (
              <span className="text-[10px] bg-destructive/20 text-destructive px-1.5 py-0.5 rounded-full">{moneyAlerts.filter(a => a.status === 'open').length}</span>
            )}
          </TabsTrigger>
          <TabsTrigger value="dispatch" className="gap-2">
            <Truck className="h-4 w-4" /> Dispatch Issues
          </TabsTrigger>
          <TabsTrigger value="guest" className="gap-2">
            <Globe className="h-4 w-4" /> Guest Booking
            {!showResolved && guestAlerts.filter(a => a.status === 'open').length > 0 && (
              <span className="text-[10px] bg-destructive/20 text-destructive px-1.5 py-0.5 rounded-full">{guestAlerts.filter(a => a.status === 'open').length}</span>
            )}
          </TabsTrigger>
          <TabsTrigger value="performance" className="gap-2">
            <Gauge className="h-4 w-4" /> Performance
            {!showResolved && perfAlerts.filter(a => a.status === 'open').length > 0 && (
              <span className="text-[10px] bg-amber-500/20 text-amber-600 px-1.5 py-0.5 rounded-full">{perfAlerts.filter(a => a.status === 'open').length}</span>
            )}
          </TabsTrigger>
          <TabsTrigger value="duplications" className="gap-2">
            <Copy className="h-4 w-4" /> Duplications
            {!showResolved && dupAlerts.filter(a => a.status === 'open').length > 0 && (
              <span className="text-[10px] bg-destructive/20 text-destructive px-1.5 py-0.5 rounded-full">{dupAlerts.filter(a => a.status === 'open').length}</span>
            )}
          </TabsTrigger>
          <TabsTrigger value="driver-app" className="gap-2">
            <Car className="h-4 w-4" /> Driver App
            {!showResolved && driverAppAlerts.filter(a => a.status === 'open').length > 0 && (
              <span className="text-[10px] bg-destructive/20 text-destructive px-1.5 py-0.5 rounded-full">{driverAppAlerts.filter(a => a.status === 'open').length}</span>
            )}
          </TabsTrigger>
          <TabsTrigger value="customer-app" className="gap-2">
            <Smartphone className="h-4 w-4" /> Customer App
            {!showResolved && customerAppAlerts.filter(a => a.status === 'open').length > 0 && (
              <span className="text-[10px] bg-destructive/20 text-destructive px-1.5 py-0.5 rounded-full">{customerAppAlerts.filter(a => a.status === 'open').length}</span>
            )}
          </TabsTrigger>
          <TabsTrigger value="corporate" className="gap-2">
            <Building2 className="h-4 w-4" /> Corporate
            {!showResolved && corporateAlerts.filter(a => a.status === 'open').length > 0 && (
              <span className="text-[10px] bg-destructive/20 text-destructive px-1.5 py-0.5 rounded-full">{corporateAlerts.filter(a => a.status === 'open').length}</span>
            )}
          </TabsTrigger>
          <TabsTrigger value="app-performance" className="gap-2">
            <Gauge className="h-4 w-4" /> App Performance
          </TabsTrigger>
          <TabsTrigger value="logs" className="gap-2">
            <ScrollText className="h-4 w-4" /> Logs Explorer
          </TabsTrigger>
          <TabsTrigger value="integration" className="gap-2">
            <Smartphone className="h-4 w-4" /> Integration Guide
          </TabsTrigger>
        </TabsList>

        <TabsContent value="alerts">
          {alertsError ? (
            <QueryErrorState error={alertsError} onRetry={() => refetchAlerts()} title="Failed to load alerts" />
          ) : (
            <OpsAlertsTable
              alerts={allAlerts}
              loading={alertsLoading}
              categoryFilter={categoryFilter}
              onCategoryChange={setCategoryFilter}
              onSelectAlert={setSelectedAlert}
              title={showResolved ? 'Resolved Alerts — Historical' : undefined}
            />
          )}
        </TabsContent>

        <TabsContent value="money">
          <OpsAlertsTable
            alerts={moneyAlerts}
            loading={alertsLoading}
            categoryFilter="money"
            onCategoryChange={() => {}}
            onSelectAlert={setSelectedAlert}
            title={showResolved ? 'Resolved Money Alerts' : 'Money Integrity Issues — Payments, Commissions, Earnings & Payouts'}
          />
        </TabsContent>

        <TabsContent value="dispatch">
          <OpsAlertsTable
            alerts={dispatchAlerts}
            loading={alertsLoading}
            categoryFilter="dispatch"
            onCategoryChange={() => {}}
            onSelectAlert={setSelectedAlert}
            title={showResolved ? 'Resolved Dispatch Alerts' : 'Dispatch Issues — Stuck Trips, Driver Availability & Offer Failures'}
          />
        </TabsContent>

        <TabsContent value="guest">
          <OpsAlertsTable
            alerts={guestAlerts}
            loading={alertsLoading}
            categoryFilter="guest"
            onCategoryChange={() => {}}
            onSelectAlert={setSelectedAlert}
            title={showResolved ? 'Resolved Guest Booking Alerts' : 'Guest Booking (guest.onecab.net) — Quotes, Checkout, Confirmation & Drop-offs'}
          />
        </TabsContent>

        <TabsContent value="performance">
          <OpsAlertsTable
            alerts={perfAlerts}
            loading={alertsLoading}
            categoryFilter="performance"
            onCategoryChange={() => {}}
            onSelectAlert={setSelectedAlert}
            title={showResolved ? 'Resolved Performance Alerts' : 'Performance & Backend — 5xx Spikes, Latency, Edge Functions, Error Rates'}
          />
        </TabsContent>

        <TabsContent value="duplications">
          <OpsAlertsTable
            alerts={dupAlerts}
            loading={alertsLoading}
            categoryFilter="duplication"
            onCategoryChange={() => {}}
            onSelectAlert={setSelectedAlert}
            title={showResolved ? 'Resolved Duplication Alerts' : 'Duplication Issues — Payments, Bookings, Payouts, Earnings & Dispatch'}
          />
        </TabsContent>

        <TabsContent value="driver-app">
          <OpsAlertsTable
            alerts={driverAppAlerts}
            loading={alertsLoading}
            categoryFilter="driver_app"
            onCategoryChange={() => {}}
            onSelectAlert={setSelectedAlert}
            title={showResolved ? 'Resolved Driver App Alerts' : 'Driver App — Screen Performance, Crashes, Slow Loads & Version Issues'}
          />
        </TabsContent>

        <TabsContent value="customer-app">
          <OpsAlertsTable
            alerts={customerAppAlerts}
            loading={alertsLoading}
            categoryFilter="customer_app"
            onCategoryChange={() => {}}
            onSelectAlert={setSelectedAlert}
            title={showResolved ? 'Resolved Customer App Alerts' : 'Customer App — Screen Performance, Crashes, Slow Loads & Version Issues'}
          />
        </TabsContent>

        <TabsContent value="corporate">
          <OpsAlertsTable
            alerts={corporateAlerts}
            loading={alertsLoading}
            categoryFilter="corporate_booking"
            onCategoryChange={() => {}}
            onSelectAlert={setSelectedAlert}
            title={showResolved ? 'Resolved Corporate Alerts' : 'Corporate — Booking Issues, Web App Performance & Account Problems'}
          />
        </TabsContent>

        <TabsContent value="app-performance">
          <AppPerformanceDashboard />
        </TabsContent>

        <TabsContent value="logs">
          <OpsLogsExplorer />
          <OpsReconciliationPanel />
        </TabsContent>
        <TabsContent value="integration">
          <MobileIntegrationGuide />
        </TabsContent>
      </Tabs>
    </AdminLayout>
  );
}

function MobileIntegrationGuide() {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;

  const curlExample = `curl -X POST "${supabaseUrl}/functions/v1/ingest-telemetry" \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_ANON_KEY" \\
  -d '{
    "app_name": "customer_app",
    "screen_name": "PaymentScreen",
    "metric_name": "screen_load_time",
    "metric_value": 4500,
    "app_version": "2.3.1",
    "platform": "ios"
  }'`;

  const swiftExample = `func sendTelemetry(screen: String, metric: String, value: Double) {
    let url = URL(string: "\\(supabaseURL)/functions/v1/ingest-telemetry")!
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("Bearer \\(anonKey)", forHTTPHeaderField: "Authorization")

    let body: [String: Any] = [
        "app_name": "customer_app",
        "screen_name": screen,
        "metric_name": metric,
        "metric_value": value,
        "app_version": Bundle.main.appVersion,
        "platform": "ios"
    ]
    request.httpBody = try? JSONSerialization.data(withJSONObject: body)
    URLSession.shared.dataTask(with: request).resume()
}`;

  const kotlinExample = `fun sendTelemetry(screen: String, metric: String, value: Double) {
    val client = OkHttpClient()
    val json = JSONObject().apply {
        put("app_name", "driver_app")
        put("screen_name", screen)
        put("metric_name", metric)
        put("metric_value", value)
        put("app_version", BuildConfig.VERSION_NAME)
        put("platform", "android")
    }
    val body = json.toString()
        .toRequestBody("application/json".toMediaType())
    val request = Request.Builder()
        .url("\${supabaseUrl}/functions/v1/ingest-telemetry")
        .post(body)
        .addHeader("Authorization", "Bearer \$anonKey")
        .build()
    client.newCall(request).enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) {}
        override fun onResponse(call: Call, response: Response) {}
    })
}`;

  const reactNativeExample = `const sendTelemetry = async (screen, metric, value) => {
  await fetch(\`\${SUPABASE_URL}/functions/v1/ingest-telemetry\`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': \`Bearer \${ANON_KEY}\`,
    },
    body: JSON.stringify({
      app_name: 'customer_app',
      screen_name: screen,
      metric_name: metric,
      metric_value: value,
      app_version: DeviceInfo.getVersion(),
      platform: Platform.OS,
    }),
  });
};`;

  const metrics = [
    { name: 'screen_load_time', unit: 'ms', desc: 'Time for a screen to become interactive' },
    { name: 'api_response_time', unit: 'ms', desc: 'Round-trip time for an API call' },
    { name: 'app_crash', unit: 'count', desc: 'Crash event (value = 1)' },
    { name: 'memory_usage', unit: 'MB', desc: 'App memory consumption' },
    { name: 'battery_drain', unit: '%/hr', desc: 'Battery consumption rate' },
    { name: 'frame_drop', unit: 'count', desc: 'Dropped frames during animation' },
  ];

  const [copiedBlock, setCopiedBlock] = useState<string | null>(null);

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopiedBlock(label);
    setTimeout(() => setCopiedBlock(null), 2000);
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Smartphone className="h-5 w-5 text-primary" />
            📱 Mobile Integration Guide
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Send telemetry from your Driver and Customer mobile apps to power the Ops Intelligence dashboards.
          </p>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Endpoint */}
          <div>
            <h3 className="text-sm font-semibold mb-2">Endpoint</h3>
            <div className="bg-muted rounded-lg px-4 py-3 font-mono text-sm flex items-center justify-between">
              <span>POST {supabaseUrl}/functions/v1/ingest-telemetry</span>
              <Button variant="ghost" size="sm" onClick={() => copyToClipboard(`${supabaseUrl}/functions/v1/ingest-telemetry`, 'endpoint')}>
                {copiedBlock === 'endpoint' ? <CheckCircle className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
          </div>

          {/* Payload Schema */}
          <div>
            <h3 className="text-sm font-semibold mb-2">Request Payload</h3>
            <div className="bg-muted rounded-lg p-4 overflow-auto">
              <pre className="text-xs font-mono">{JSON.stringify({
                app_name: "customer_app | driver_app",
                screen_name: "PaymentScreen",
                metric_name: "screen_load_time",
                metric_value: 4500,
                unit: "ms (optional, default: ms)",
                app_version: "2.3.1 (optional)",
                platform: "ios | android (optional)",
                device_model: "iPhone 15 Pro (optional)",
                os_version: "17.4 (optional)",
                session_id: "uuid (optional)",
                user_id: "uuid (optional)",
                metadata: "{ any extra data } (optional)"
              }, null, 2)}</pre>
            </div>
          </div>

          {/* Supported Metrics */}
          <div>
            <h3 className="text-sm font-semibold mb-2">Supported Metrics</h3>
            <div className="rounded-lg border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="text-left px-4 py-2 font-medium">Metric Name</th>
                    <th className="text-left px-4 py-2 font-medium">Unit</th>
                    <th className="text-left px-4 py-2 font-medium">Description</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.map((m) => (
                    <tr key={m.name} className="border-t">
                      <td className="px-4 py-2 font-mono text-xs">{m.name}</td>
                      <td className="px-4 py-2 text-muted-foreground">{m.unit}</td>
                      <td className="px-4 py-2 text-muted-foreground">{m.desc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Code Examples */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Code Examples</CardTitle>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="curl" className="w-full">
            <TabsList>
              <TabsTrigger value="curl">cURL</TabsTrigger>
              <TabsTrigger value="swift">Swift (iOS)</TabsTrigger>
              <TabsTrigger value="kotlin">Kotlin (Android)</TabsTrigger>
              <TabsTrigger value="rn">React Native</TabsTrigger>
            </TabsList>
            {[
              { key: 'curl', code: curlExample },
              { key: 'swift', code: swiftExample },
              { key: 'kotlin', code: kotlinExample },
              { key: 'rn', code: reactNativeExample },
            ].map(({ key, code }) => (
              <TabsContent key={key} value={key}>
                <div className="relative">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="absolute top-2 right-2 z-10"
                    onClick={() => copyToClipboard(code, key)}
                  >
                    {copiedBlock === key ? <CheckCircle className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
                  </Button>
                  <pre className="bg-muted rounded-lg p-4 overflow-auto text-xs font-mono max-h-80">{code}</pre>
                </div>
              </TabsContent>
            ))}
          </Tabs>
        </CardContent>
      </Card>

      {/* Best Practices */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Best Practices</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2 text-sm text-muted-foreground list-disc list-inside">
            <li>Send <code className="text-xs bg-muted px-1 py-0.5 rounded">screen_load_time</code> after each screen becomes interactive</li>
            <li>Use consistent <code className="text-xs bg-muted px-1 py-0.5 rounded">screen_name</code> values across platforms (e.g., <code className="text-xs bg-muted px-1 py-0.5 rounded">PaymentScreen</code> not <code className="text-xs bg-muted px-1 py-0.5 rounded">payment_screen</code>)</li>
            <li>Set <code className="text-xs bg-muted px-1 py-0.5 rounded">app_name</code> to <code className="text-xs bg-muted px-1 py-0.5 rounded">customer_app</code> or <code className="text-xs bg-muted px-1 py-0.5 rounded">driver_app</code> — these map to dashboard filters</li>
            <li>Include <code className="text-xs bg-muted px-1 py-0.5 rounded">app_version</code> to track regressions across releases</li>
            <li>Batch telemetry calls or use a queue to avoid blocking the UI thread</li>
            <li>Do NOT set <code className="text-xs bg-muted px-1 py-0.5 rounded">is_synthetic: true</code> — that flag is for test data only and is filtered from dashboards</li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
