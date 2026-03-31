import { useState, useEffect } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { OpsHealthCards } from '@/components/ops/OpsHealthCards';
import { OpsAlertsTable } from '@/components/ops/OpsAlertsTable';
import { OpsLogsExplorer } from '@/components/ops/OpsLogsExplorer';
import { OpsAlertDetail } from '@/components/ops/OpsAlertDetail';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { RefreshCw, Activity, AlertTriangle, ScrollText, Shield, CreditCard, Truck, Copy } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

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
  const [selectedAlert, setSelectedAlert] = useState<OpsAlert | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const queryClient = useQueryClient();

  // Fetch health summary
  const { data: healthData, isLoading: healthLoading } = useQuery({
    queryKey: ['ops-health-summary'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('ops_alerts')
        .select('category, severity, status, last_detected_at')
        .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
      if (error) throw error;
      
      // Group by category
      const summary: Record<string, { open: number; critical: number; latest: string | null }> = {};
      const categories = ['payment', 'commission', 'earning', 'payout', 'dispatch', 'guest_booking', 'corporate_booking', 'customer_app', 'driver_app', 'backend', 'logs', 'duplication', 'system'];
      categories.forEach(c => { summary[c] = { open: 0, critical: 0, latest: null }; });
      
      (data || []).forEach((a: any) => {
        if (!summary[a.category]) summary[a.category] = { open: 0, critical: 0, latest: null };
        if (a.status === 'open' || a.status === 'acknowledged') {
          summary[a.category].open++;
          if (a.severity === 'critical' || a.severity === 'fatal') summary[a.category].critical++;
        }
        if (!summary[a.category].latest || a.last_detected_at > summary[a.category].latest!) {
          summary[a.category].latest = a.last_detected_at;
        }
      });
      return summary;
    },
    refetchInterval: 30000,
  });

  // Fetch alerts
  const { data: alerts, isLoading: alertsLoading } = useQuery({
    queryKey: ['ops-alerts', categoryFilter],
    queryFn: async () => {
      let query = supabase
        .from('ops_alerts')
        .select('*')
        .order('last_detected_at', { ascending: false })
        .limit(200);
      
      if (categoryFilter !== 'all') {
        query = query.eq('category', categoryFilter);
      }
      
      const { data, error } = await query;
      if (error) throw error;
      return (data || []) as OpsAlert[];
    },
    refetchInterval: 15000,
  });

  // Top-level stats
  const totalOpen = alerts?.filter(a => a.status === 'open').length || 0;
  const totalCritical = alerts?.filter(a => a.severity === 'critical' && a.status === 'open').length || 0;
  const totalAcknowledged = alerts?.filter(a => a.status === 'acknowledged').length || 0;

  // Run all detections
  const handleRunDetections = async () => {
    try {
      const { data, error } = await supabase.rpc('ops_run_all_detections');
      if (error) throw error;
      toast.success('Detection scan complete', { description: JSON.stringify(data) });
      queryClient.invalidateQueries({ queryKey: ['ops-alerts'] });
      queryClient.invalidateQueries({ queryKey: ['ops-health-summary'] });
    } catch (e: any) {
      toast.error('Scan failed', { description: e.message });
    }
  };

  // Realtime subscription for alerts
  useEffect(() => {
    const channel = supabase
      .channel('ops-alerts-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'ops_alerts' }, () => {
        queryClient.invalidateQueries({ queryKey: ['ops-alerts'] });
        queryClient.invalidateQueries({ queryKey: ['ops-health-summary'] });
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
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

  return (
    <AdminLayout title="Ops Intelligence" description="Platform-wide operations monitoring, alerts & health">
      {/* Top action bar */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
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
        <Button onClick={handleRunDetections} variant="outline" size="sm">
          <RefreshCw className="h-4 w-4 mr-2" />
          Run Detection Scan
        </Button>
      </div>

      {/* Health Cards */}
      <OpsHealthCards data={healthData} loading={healthLoading} onCategoryClick={setCategoryFilter} />

      {/* Main Tabs */}
      <Tabs defaultValue="alerts" className="mt-8">
        <TabsList>
          <TabsTrigger value="alerts" className="gap-2">
            <AlertTriangle className="h-4 w-4" /> Alerts
          </TabsTrigger>
          <TabsTrigger value="logs" className="gap-2">
            <ScrollText className="h-4 w-4" /> Logs Explorer
          </TabsTrigger>
          <TabsTrigger value="money" className="gap-2">
            <CreditCard className="h-4 w-4" /> Money Integrity
          </TabsTrigger>
          <TabsTrigger value="dispatch" className="gap-2">
            <Truck className="h-4 w-4" /> Dispatch Issues
          </TabsTrigger>
          <TabsTrigger value="duplications" className="gap-2">
            <Copy className="h-4 w-4" /> Duplications
          </TabsTrigger>
        </TabsList>

        <TabsContent value="alerts">
          <OpsAlertsTable
            alerts={alerts || []}
            loading={alertsLoading}
            categoryFilter={categoryFilter}
            onCategoryChange={setCategoryFilter}
            onSelectAlert={setSelectedAlert}
          />
        </TabsContent>

        <TabsContent value="logs">
          <OpsLogsExplorer />
        </TabsContent>

        <TabsContent value="money">
          <OpsAlertsTable
            alerts={(alerts || []).filter(a => ['payment', 'commission', 'earning', 'payout'].includes(a.category))}
            loading={alertsLoading}
            categoryFilter="money"
            onCategoryChange={() => {}}
            onSelectAlert={setSelectedAlert}
            title="Money Integrity Issues"
          />
        </TabsContent>

        <TabsContent value="dispatch">
          <OpsAlertsTable
            alerts={(alerts || []).filter(a => a.category === 'dispatch')}
            loading={alertsLoading}
            categoryFilter="dispatch"
            onCategoryChange={() => {}}
            onSelectAlert={setSelectedAlert}
            title="Dispatch Issues"
          />
        </TabsContent>

        <TabsContent value="duplications">
          <OpsAlertsTable
            alerts={(alerts || []).filter(a => a.category === 'duplication')}
            loading={alertsLoading}
            categoryFilter="duplication"
            onCategoryChange={() => {}}
            onSelectAlert={setSelectedAlert}
            title="Duplication Issues"
          />
        </TabsContent>
      </Tabs>
    </AdminLayout>
  );
}
