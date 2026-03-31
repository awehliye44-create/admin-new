import { useState, useEffect, useCallback, useMemo } from 'react';
import { usePageLoadTelemetry } from '@/hooks/useAdminTelemetry';
import { useSearchParams } from 'react-router-dom';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { OpsHealthCards } from '@/components/ops/OpsHealthCards';
import { OpsAlertsTable } from '@/components/ops/OpsAlertsTable';
import { OpsLogsExplorer } from '@/components/ops/OpsLogsExplorer';
import { OpsAlertDetail } from '@/components/ops/OpsAlertDetail';
import { OpsRealtimeIndicator } from '@/components/ops/OpsRealtimeIndicator';
import { QueryErrorState } from '@/components/QueryErrorState';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { RefreshCw, Activity, AlertTriangle, ScrollText, Shield, CreditCard, Truck, Copy, Globe, Gauge, Smartphone } from 'lucide-react';
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
  const [searchParams] = useSearchParams();
  const defaultTab = searchParams.get('tab') || 'alerts';
  const [selectedAlert, setSelectedAlert] = useState<OpsAlert | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const queryClient = useQueryClient();

  // Admin panel telemetry
  usePageLoadTelemetry('OpsIntelligence');

  // Realtime hook — handles subscriptions, query invalidation, and critical toasts
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

  // Fetch health summary
  const { data: healthData, isLoading: healthLoading, error: healthError, refetch: refetchHealth } = useQuery({
    queryKey: ['ops-health-summary'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('ops_alerts')
        .select('category, severity, status, last_detected_at')
        .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
      if (error) throw error;
      
      const summary: Record<string, { open: number; critical: number; latest: string | null }> = {};
      const categories = ['payment', 'commission', 'earning', 'payout', 'dispatch', 'guest_booking', 'corporate_booking', 'customer_app', 'driver_app', 'backend', 'logs', 'duplication', 'system', 'admin_panel'];
      categories.forEach(c => { summary[c] = { open: 0, critical: 0, latest: null }; });
      
      (data || []).forEach((a: any) => {
        // Merge corporate_web into corporate_booking
        const cat = a.category === 'corporate_web' ? 'corporate_booking' : a.category;
        if (!summary[cat]) summary[cat] = { open: 0, critical: 0, latest: null };
        if (a.status === 'open' || a.status === 'acknowledged') {
          summary[cat].open++;
          if (a.severity === 'critical' || a.severity === 'fatal') summary[cat].critical++;
        }
        if (!summary[cat].latest || a.last_detected_at > summary[cat].latest!) {
          summary[cat].latest = a.last_detected_at;
        }
      });
      return summary;
    },
    staleTime: 10000,
  });

  // Fetch alerts
  const { data: alerts, isLoading: alertsLoading, error: alertsError, refetch: refetchAlerts } = useQuery({
    queryKey: ['ops-alerts', categoryFilter],
    queryFn: async () => {
      let query = supabase
        .from('ops_alerts')
        .select('id, fingerprint, category, severity, status, source, app, title, description, fingerprint_count, first_detected_at, last_detected_at, acknowledged_at, resolved_at, related_trip_id, related_driver_id, related_payment_id, related_payout_batch_id, metadata, created_at')
        .order('last_detected_at', { ascending: false })
        .limit(200);
      
      if (categoryFilter !== 'all') {
        query = query.eq('category', categoryFilter);
      }
      
      const { data, error } = await query;
      if (error) throw error;
      return (data || []) as OpsAlert[];
    },
    staleTime: 5000,
  });

  // Top-level stats
  const totalOpen = alerts?.filter(a => a.status === 'open').length || 0;
  const totalCritical = alerts?.filter(a => (a.severity === 'critical' || a.severity === 'fatal') && a.status === 'open').length || 0;
  const totalAcknowledged = alerts?.filter(a => a.status === 'acknowledged').length || 0;

  // Seed/clear demo data helper
  const callOpsSeed = async (seedAction: 'seed' | 'clear') => {
    try {
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ops-seed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY },
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

  // Run all detections
  const handleRunDetections = async () => {
    try {
      const { data, error } = await supabase.rpc('ops_run_all_detections');
      if (error) throw error;
      toast.success('Detection scan complete', { description: JSON.stringify(data) });
    } catch (e: any) {
      toast.error('Scan failed', { description: e.message });
    }
  };

  // Manual refresh all
  const handleRefreshAll = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['ops-alerts'] });
    queryClient.invalidateQueries({ queryKey: ['ops-health-summary'] });
    queryClient.invalidateQueries({ queryKey: ['ops-logs'] });
    toast.success('Refreshed');
  }, [queryClient]);

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

  // Filter helpers for tabs
  const allAlerts = alerts || [];
  const moneyAlerts = allAlerts.filter(a => ['payment', 'commission', 'earning', 'payout'].includes(a.category));
  const dispatchAlerts = allAlerts.filter(a => a.category === 'dispatch');
  const guestAlerts = allAlerts.filter(a => a.category === 'guest_booking' || a.app === 'guest');
  const perfAlerts = allAlerts.filter(a =>
    a.category === 'backend' || a.category === 'logs' ||
    a.fingerprint.includes('latency') || a.fingerprint.includes('5xx') ||
    a.fingerprint.includes('error_spike') || a.fingerprint.includes('edge_fn') ||
    a.fingerprint.includes('fatal_log')
  );
  const dupAlerts = allAlerts.filter(a => a.category === 'duplication');

  return (
    <AdminLayout title="Ops Intelligence" description="Platform-wide operations monitoring, alerts & health">
      {/* Top action bar */}
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div className="flex items-center gap-3 flex-wrap">
          <OpsRealtimeIndicator status={realtimeStatus} lastEvent={lastEvent} />
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-muted">
            <Activity className="h-4 w-4 text-primary" />
            <span className="text-sm font-medium">{totalOpen} open</span>
          </div>
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-destructive/10">
            <AlertTriangle className="h-4 w-4 text-destructive" />
            <span className="text-sm font-medium text-destructive">{totalCritical} critical</span>
          </div>
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-muted">
            <Shield className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">{totalAcknowledged} ack'd</span>
          </div>
        </div>
        <div className="flex gap-2 flex-wrap">
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

      {/* Health Cards — with error state */}
      {healthError ? (
        <QueryErrorState error={healthError} onRetry={() => refetchHealth()} title="Failed to load health summary" compact />
      ) : (
        <OpsHealthCards data={healthData} loading={healthLoading} onCategoryClick={setCategoryFilter} />
      )}

      {/* Main Tabs */}
      <Tabs defaultValue={defaultTab} className="mt-8">
        <TabsList className="flex-wrap h-auto gap-1">
          <TabsTrigger value="alerts" className="gap-2">
            <AlertTriangle className="h-4 w-4" /> Alerts
            {totalOpen > 0 && <span className="text-[10px] bg-destructive/20 text-destructive px-1.5 py-0.5 rounded-full">{totalOpen}</span>}
          </TabsTrigger>
          <TabsTrigger value="money" className="gap-2">
            <CreditCard className="h-4 w-4" /> Money Integrity
            {moneyAlerts.filter(a => a.status === 'open').length > 0 && (
              <span className="text-[10px] bg-destructive/20 text-destructive px-1.5 py-0.5 rounded-full">{moneyAlerts.filter(a => a.status === 'open').length}</span>
            )}
          </TabsTrigger>
          <TabsTrigger value="dispatch" className="gap-2">
            <Truck className="h-4 w-4" /> Dispatch Issues
          </TabsTrigger>
          <TabsTrigger value="guest" className="gap-2">
            <Globe className="h-4 w-4" /> Guest Booking
            {guestAlerts.filter(a => a.status === 'open').length > 0 && (
              <span className="text-[10px] bg-destructive/20 text-destructive px-1.5 py-0.5 rounded-full">{guestAlerts.filter(a => a.status === 'open').length}</span>
            )}
          </TabsTrigger>
          <TabsTrigger value="performance" className="gap-2">
            <Gauge className="h-4 w-4" /> Performance
            {perfAlerts.filter(a => a.status === 'open').length > 0 && (
              <span className="text-[10px] bg-amber-500/20 text-amber-600 px-1.5 py-0.5 rounded-full">{perfAlerts.filter(a => a.status === 'open').length}</span>
            )}
          </TabsTrigger>
          <TabsTrigger value="duplications" className="gap-2">
            <Copy className="h-4 w-4" /> Duplications
            {dupAlerts.filter(a => a.status === 'open').length > 0 && (
              <span className="text-[10px] bg-destructive/20 text-destructive px-1.5 py-0.5 rounded-full">{dupAlerts.filter(a => a.status === 'open').length}</span>
            )}
          </TabsTrigger>
          <TabsTrigger value="app-performance" className="gap-2">
            <Smartphone className="h-4 w-4" /> App Performance
          </TabsTrigger>
          <TabsTrigger value="logs" className="gap-2">
            <ScrollText className="h-4 w-4" /> Logs Explorer
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
            title="Money Integrity Issues — Payments, Commissions, Earnings & Payouts"
          />
        </TabsContent>

        <TabsContent value="dispatch">
          <OpsAlertsTable
            alerts={dispatchAlerts}
            loading={alertsLoading}
            categoryFilter="dispatch"
            onCategoryChange={() => {}}
            onSelectAlert={setSelectedAlert}
            title="Dispatch Issues — Stuck Trips, Driver Availability & Offer Failures"
          />
        </TabsContent>

        <TabsContent value="guest">
          <OpsAlertsTable
            alerts={guestAlerts}
            loading={alertsLoading}
            categoryFilter="guest"
            onCategoryChange={() => {}}
            onSelectAlert={setSelectedAlert}
            title="Guest Booking (guest.onecab.net) — Quotes, Checkout, Confirmation & Drop-offs"
          />
        </TabsContent>

        <TabsContent value="performance">
          <OpsAlertsTable
            alerts={perfAlerts}
            loading={alertsLoading}
            categoryFilter="performance"
            onCategoryChange={() => {}}
            onSelectAlert={setSelectedAlert}
            title="Performance & Backend — 5xx Spikes, Latency, Edge Functions, Error Rates"
          />
        </TabsContent>

        <TabsContent value="duplications">
          <OpsAlertsTable
            alerts={dupAlerts}
            loading={alertsLoading}
            categoryFilter="duplication"
            onCategoryChange={() => {}}
            onSelectAlert={setSelectedAlert}
            title="Duplication Issues — Payments, Bookings, Payouts, Earnings & Dispatch"
          />
        </TabsContent>

        <TabsContent value="app-performance">
          <AppPerformanceDashboard />
        </TabsContent>

        <TabsContent value="logs">
          <OpsLogsExplorer />
        </TabsContent>
      </Tabs>
    </AdminLayout>
  );
}
