import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { supabase } from '@/integrations/supabase/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, ShieldCheck, AlertTriangle, Activity, FileText, Bug } from 'lucide-react';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';

type ReconciliationData = {
  generated_at: string;
  time_window: string;
  synthetic_excluded: boolean;
  total_open_alerts: number;
  total_acknowledged: number;
  total_resolved_24h: number;
  total_active: number;
  demo_alerts_open: number;
  real_alerts_open: number;
  categories: Record<string, {
    open_alerts: number;
    critical_alerts: number;
    acknowledged: number;
    demo_alerts: number;
    real_alerts: number;
    latest_detection: string | null;
  }>;
  recent_logs: {
    total_6h: number;
    errors_6h: number;
    warnings_6h: number;
    info_6h: number;
  };
};

const CATEGORY_LABELS: Record<string, string> = {
  payment: 'Payments',
  commission: 'Commissions',
  earning: 'Driver Earnings',
  payout: 'Payouts',
  dispatch: 'Dispatch',
  guest_booking: 'Guest Booking',
  corporate_booking: 'Corporate',
  customer_app: 'Customer App',
  driver_app: 'Driver App',
  backend: 'Backend/API',
  logs: 'Logs & Errors',
  duplication: 'Duplications',
  system: 'System',
  admin_panel: 'Admin Panel',
};

function StatusDot({ count, critical }: { count: number; critical: number }) {
  if (critical > 0) return <span className="h-2.5 w-2.5 rounded-full bg-destructive inline-block" />;
  if (count > 0) return <span className="h-2.5 w-2.5 rounded-full bg-amber-500 inline-block" />;
  return <span className="h-2.5 w-2.5 rounded-full bg-emerald-500 inline-block" />;
}

export function OpsReconciliationPanel() {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['ops-reconciliation'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('ops_reconciliation_diagnostics');
      if (error) throw error;
      return data as unknown as ReconciliationData;
    },
    staleTime: 30000,
  });

  if (!expanded) {
    return (
      <Card className="mt-4">
        <CardContent className="py-3 px-4">
          <Button variant="ghost" size="sm" onClick={() => setExpanded(true)} className="gap-2 w-full justify-start text-muted-foreground">
            <Bug className="h-4 w-4" />
            <span className="text-xs">Show Reconciliation Diagnostics</span>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="mt-4 border-dashed">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Bug className="h-4 w-4 text-muted-foreground" />
            Reconciliation Diagnostics
          </CardTitle>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => refetch()}>
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setExpanded(false)} className="text-xs text-muted-foreground">
              Hide
            </Button>
          </div>
        </div>
        {data && (
          <p className="text-xs text-muted-foreground">
            {data.generated_at && !isNaN(new Date(data.generated_at).getTime())
              ? <>Generated {format(new Date(data.generated_at), 'HH:mm:ss')} · </>
              : null}
            {data.time_window ? <>Window: {data.time_window} · </> : null}
            Synthetic excluded: {data.synthetic_excluded ? 'Yes' : 'No'}
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-6 w-full" />)}
          </div>
        ) : error ? (
          <p className="text-sm text-destructive">Failed to load diagnostics: {(error as Error).message}</p>
        ) : data ? (
          <>
            {/* Global summary */}
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3">
              <div className="rounded-lg border bg-muted/30 p-3 text-center">
                <p className="text-lg font-bold text-foreground">{data.real_alerts_open}</p>
                <p className="text-[10px] text-muted-foreground">Real Open</p>
              </div>
              <div className="rounded-lg border bg-muted/30 p-3 text-center">
                <p className="text-lg font-bold text-foreground">{data.total_acknowledged}</p>
                <p className="text-[10px] text-muted-foreground">Acknowledged</p>
              </div>
              <div className="rounded-lg border bg-muted/30 p-3 text-center">
                <p className="text-lg font-bold text-foreground">{data.total_resolved_24h}</p>
                <p className="text-[10px] text-muted-foreground">Resolved (24h)</p>
              </div>
              <div className="rounded-lg border bg-muted/30 p-3 text-center">
                <p className="text-lg font-bold text-foreground">{data.demo_alerts_open}</p>
                <p className="text-[10px] text-muted-foreground">
                  {data.demo_alerts_open > 0 ? '⚠️ Demo Open' : 'Demo Open'}
                </p>
              </div>
              <div className="rounded-lg border bg-muted/30 p-3 text-center">
                <p className="text-lg font-bold text-foreground">{data.recent_logs?.errors_6h || 0}</p>
                <p className="text-[10px] text-muted-foreground">Error Logs (6h)</p>
              </div>
              <div className="rounded-lg border bg-muted/30 p-3 text-center">
                <p className="text-lg font-bold text-foreground">{data.recent_logs?.total_6h || 0}</p>
                <p className="text-[10px] text-muted-foreground">Total Logs (6h)</p>
              </div>
            </div>

            {/* Per-category breakdown */}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Category</TableHead>
                  <TableHead className="text-center">Health</TableHead>
                  <TableHead className="text-center">Real Open</TableHead>
                  <TableHead className="text-center">Critical</TableHead>
                  <TableHead className="text-center">Ack'd</TableHead>
                  <TableHead className="text-center">Demo</TableHead>
                  <TableHead>Latest Detection</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {Object.entries(CATEGORY_LABELS).map(([key, label]) => {
                  const cat = data.categories?.[key] || { open_alerts: 0, critical_alerts: 0, acknowledged: 0, demo_alerts: 0, real_alerts: 0, latest_detection: null };
                  return (
                    <TableRow key={key}>
                      <TableCell className="text-sm font-medium">{label}</TableCell>
                      <TableCell className="text-center">
                        <StatusDot count={cat.real_alerts} critical={cat.critical_alerts} />
                      </TableCell>
                      <TableCell className="text-center">
                        <span className={cn('text-sm font-mono', cat.real_alerts > 0 ? 'text-amber-600 font-bold' : 'text-muted-foreground')}>{cat.real_alerts}</span>
                      </TableCell>
                      <TableCell className="text-center">
                        <span className={cn('text-sm font-mono', cat.critical_alerts > 0 ? 'text-destructive font-bold' : 'text-muted-foreground')}>{cat.critical_alerts}</span>
                      </TableCell>
                      <TableCell className="text-center">
                        <span className="text-sm font-mono text-muted-foreground">{cat.acknowledged}</span>
                      </TableCell>
                      <TableCell className="text-center">
                        {cat.demo_alerts > 0 ? (
                          <Badge variant="outline" className="text-[10px] border-amber-500/30 bg-amber-500/10 text-amber-600">{cat.demo_alerts}</Badge>
                        ) : (
                          <span className="text-sm font-mono text-muted-foreground">0</span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {cat.latest_detection && !isNaN(new Date(cat.latest_detection).getTime()) ? format(new Date(cat.latest_detection), 'HH:mm:ss') : '—'}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>

            {/* Architecture explanation */}
            <div className="rounded-lg border bg-muted/20 p-4 space-y-2">
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">How Data Flows</h4>
              <ul className="text-xs text-muted-foreground space-y-1 list-disc list-inside">
                <li><strong>Logs Explorer</strong> → queries <code className="bg-muted px-1 rounded">ops_logs</code> table directly (raw system logs)</li>
                <li><strong>Health Cards</strong> → queries <code className="bg-muted px-1 rounded">ops_alerts</code> (open/acknowledged, last 6h, grouped by category)</li>
                <li><strong>Alerts Table</strong> → queries <code className="bg-muted px-1 rounded">ops_alerts</code> (deduplicated by fingerprint, limit 200)</li>
                <li><strong>Detection Engine</strong> → 40+ SQL functions analyze <code className="bg-muted px-1 rounded">ops_logs</code>, <code className="bg-muted px-1 rounded">app_performance_events</code>, and <code className="bg-muted px-1 rounded">trips</code> → upserts into <code className="bg-muted px-1 rounded">ops_alerts</code></li>
                <li><strong>Grouping</strong>: Many raw log entries map to one alert via fingerprint deduplication (e.g., 50 error logs → 1 "Error spike" alert with fingerprint_count tracking occurrences)</li>
                <li><strong>Auto-resolve</strong>: Alerts resolve when not re-detected for 6h, or when P95 metrics return below thresholds</li>
              </ul>
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
