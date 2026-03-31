import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { ArrowLeft, CheckCircle, Eye, BellOff, Sparkles } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';

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

interface OpsAlertDetailProps {
  alert: OpsAlert;
  onBack: () => void;
  onRefresh: () => void;
}

const SEVERITY_COLORS: Record<string, string> = {
  fatal: 'bg-destructive text-destructive-foreground',
  critical: 'bg-destructive/80 text-destructive-foreground',
  warning: 'bg-amber-500/80 text-white',
  info: 'bg-muted text-muted-foreground',
};

export function OpsAlertDetail({ alert, onBack, onRefresh }: OpsAlertDetailProps) {
  const { user } = useAuth();

  // Fetch AI summary
  const { data: aiSummary } = useQuery({
    queryKey: ['ops-ai-summary', alert.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('ops_ai_summaries')
        .select('*')
        .eq('alert_id', alert.id)
        .order('created_at', { ascending: false })
        .limit(1);
      if (error) throw error;
      return data?.[0] || null;
    },
  });

  // Fetch related events
  const { data: relatedEvents } = useQuery({
    queryKey: ['ops-events', alert.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('ops_events')
        .select('*')
        .eq('alert_id', alert.id)
        .order('created_at', { ascending: false })
        .limit(20);
      if (error) throw error;
      return data || [];
    },
  });

  // Fetch related logs
  const { data: relatedLogs } = useQuery({
    queryKey: ['ops-logs-related', alert.related_trip_id],
    queryFn: async () => {
      if (!alert.related_trip_id) return [];
      const { data, error } = await supabase
        .from('ops_logs')
        .select('*')
        .eq('trip_id', alert.related_trip_id)
        .order('created_at', { ascending: false })
        .limit(10);
      if (error) throw error;
      return data || [];
    },
    enabled: !!alert.related_trip_id,
  });

  const handleAction = async (action: 'acknowledge' | 'resolve' | 'suppress') => {
    try {
      if (action === 'acknowledge') {
        await supabase.rpc('ops_acknowledge_alert', { p_alert_id: alert.id, p_user_id: user?.id });
      } else if (action === 'resolve') {
        await supabase.rpc('ops_resolve_alert', { p_alert_id: alert.id, p_user_id: user?.id });
      } else {
        const until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        await supabase.rpc('ops_suppress_alert', { p_alert_id: alert.id, p_until: until });
      }
      toast.success(`Alert ${action}d`);
      onRefresh();
    } catch (e: any) {
      toast.error('Action failed', { description: e.message });
    }
  };

  // Generate mock AI summary
  const handleGenerateAI = async () => {
    const mockSummaries: Record<string, { summary: string; root_cause: string; action: string }> = {
      payment: {
        summary: `Payment failure detected for ${alert.related_trip_id ? 'trip ' + alert.related_trip_id.slice(0, 8) : 'unknown trip'}. Stripe returned an error during capture.`,
        root_cause: 'Card declined or expired. The customer\'s payment method may have insufficient funds or may have been blocked by the issuing bank.',
        action: 'Contact the customer to update their payment method. If this is a recurring issue, consider enabling retry logic in the payment capture flow.',
      },
      commission: {
        summary: `Commission was not recorded for a completed trip. The trip_finance record is missing or incomplete.`,
        root_cause: 'The complete-trip edge function may have failed after updating the trip status but before inserting the trip_finance record.',
        action: 'Run the repair-commissions edge function to reconcile missing entries. Check edge function logs for errors around the trip completion time.',
      },
      dispatch: {
        summary: `Trip has been stuck in dispatch for an extended period with no driver accepting.`,
        root_cause: 'No eligible drivers online in the service area, or dispatch search radius too small. All available drivers may have declined.',
        action: 'Check driver availability in the service area. Consider expanding search radius or manually assigning a driver.',
      },
      duplication: {
        summary: `Duplicate entries detected that may indicate retry issues or double-click submissions.`,
        root_cause: 'Idempotency check may be missing in the relevant flow. Client-side retries or double-clicks can cause duplicate records.',
        action: 'Review the duplicate records and remove extras. Add idempotency keys to prevent recurrence.',
      },
    };

    const fallback = mockSummaries[alert.category] || {
      summary: `Alert: ${alert.title}. ${alert.description || ''}`,
      root_cause: 'Requires manual investigation to determine root cause.',
      action: 'Review the alert details and related logs. Investigate the affected system component.',
    };

    try {
      const { error } = await supabase.from('ops_ai_summaries').insert({
        alert_id: alert.id,
        summary: fallback.summary,
        root_cause: fallback.root_cause,
        recommended_action: fallback.action,
        confidence_score: 0.75,
        model_used: 'mock',
      });
      if (error) throw error;
      toast.success('AI summary generated');
    } catch (e: any) {
      toast.error('Failed to generate summary', { description: e.message });
    }
  };

  return (
    <div className="space-y-6">
      {/* Back + Actions */}
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="h-4 w-4 mr-2" /> Back to Alerts
        </Button>
        <div className="flex gap-2">
          {alert.status === 'open' && (
            <Button variant="outline" size="sm" onClick={() => handleAction('acknowledge')}>
              <Eye className="h-4 w-4 mr-1" /> Acknowledge
            </Button>
          )}
          {(alert.status === 'open' || alert.status === 'acknowledged') && (
            <Button variant="default" size="sm" onClick={() => handleAction('resolve')}>
              <CheckCircle className="h-4 w-4 mr-1" /> Resolve
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={() => handleAction('suppress')}>
            <BellOff className="h-4 w-4 mr-1" /> Suppress 24h
          </Button>
        </div>
      </div>

      {/* Alert Info */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <Badge className={cn(SEVERITY_COLORS[alert.severity])}>{alert.severity.toUpperCase()}</Badge>
            <Badge variant="outline">{alert.status}</Badge>
            <Badge variant="secondary">{alert.category.replace(/_/g, ' ')}</Badge>
          </div>
          <CardTitle className="mt-2">{alert.title}</CardTitle>
          {alert.description && <p className="text-sm text-muted-foreground">{alert.description}</p>}
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div><span className="text-muted-foreground">Occurrences:</span> <span className="font-medium">{alert.fingerprint_count}</span></div>
            <div><span className="text-muted-foreground">First seen:</span> <span className="font-medium">{format(new Date(alert.first_detected_at), 'PPp')}</span></div>
            <div><span className="text-muted-foreground">Last seen:</span> <span className="font-medium">{format(new Date(alert.last_detected_at), 'PPp')}</span></div>
            <div><span className="text-muted-foreground">Source:</span> <span className="font-medium">{alert.source}</span></div>
          </div>

          {/* Related IDs */}
          <Separator className="my-4" />
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            {alert.related_trip_id && <div><span className="text-muted-foreground">Trip:</span> <code className="text-xs bg-muted px-1 py-0.5 rounded">{alert.related_trip_id.slice(0, 8)}…</code></div>}
            {alert.related_driver_id && <div><span className="text-muted-foreground">Driver:</span> <code className="text-xs bg-muted px-1 py-0.5 rounded">{alert.related_driver_id.slice(0, 8)}…</code></div>}
            {alert.related_payment_id && <div><span className="text-muted-foreground">Payment:</span> <code className="text-xs bg-muted px-1 py-0.5 rounded">{alert.related_payment_id.slice(0, 8)}…</code></div>}
            {alert.related_payout_batch_id && <div><span className="text-muted-foreground">Payout Batch:</span> <code className="text-xs bg-muted px-1 py-0.5 rounded">{alert.related_payout_batch_id.slice(0, 8)}…</code></div>}
          </div>

          {/* Metadata */}
          {alert.metadata && Object.keys(alert.metadata).length > 0 && (
            <>
              <Separator className="my-4" />
              <p className="text-xs font-medium text-muted-foreground mb-2">Metadata</p>
              <pre className="text-xs bg-muted p-3 rounded-lg overflow-auto max-h-40">
                {JSON.stringify(alert.metadata, null, 2)}
              </pre>
            </>
          )}
        </CardContent>
      </Card>

      {/* AI Summary */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" /> AI Incident Summary
            </CardTitle>
            {!aiSummary && (
              <Button variant="outline" size="sm" onClick={handleGenerateAI}>
                Generate Summary
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {aiSummary ? (
            <div className="space-y-3">
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1">Summary</p>
                <p className="text-sm">{aiSummary.summary}</p>
              </div>
              {aiSummary.root_cause && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-1">Root Cause</p>
                  <p className="text-sm">{aiSummary.root_cause}</p>
                </div>
              )}
              {aiSummary.recommended_action && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-1">Recommended Action</p>
                  <p className="text-sm">{aiSummary.recommended_action}</p>
                </div>
              )}
              <div className="flex items-center gap-4 text-xs text-muted-foreground">
                <span>Model: {aiSummary.model_used}</span>
                {aiSummary.confidence_score && <span>Confidence: {Math.round(aiSummary.confidence_score * 100)}%</span>}
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No AI summary generated yet. Click "Generate Summary" to create one.</p>
          )}
        </CardContent>
      </Card>

      {/* Related Events */}
      {relatedEvents && relatedEvents.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">Related Events ({relatedEvents.length})</CardTitle></CardHeader>
          <CardContent className="p-0">
            <div className="max-h-60 overflow-auto">
              {relatedEvents.map((evt: any) => (
                <div key={evt.id} className="flex items-center gap-3 px-4 py-2 border-b last:border-0 text-sm">
                  <Badge variant="secondary" className="text-[10px]">{evt.event_type}</Badge>
                  <span className="text-muted-foreground flex-1 truncate">{evt.description || '—'}</span>
                  <span className="text-xs text-muted-foreground whitespace-nowrap">{format(new Date(evt.created_at), 'HH:mm:ss')}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Related Logs */}
      {relatedLogs && relatedLogs.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">Related Logs ({relatedLogs.length})</CardTitle></CardHeader>
          <CardContent className="p-0">
            <div className="max-h-60 overflow-auto">
              {relatedLogs.map((log: any) => (
                <div key={log.id} className="flex items-center gap-3 px-4 py-2 border-b last:border-0 text-sm">
                  <Badge variant={log.level === 'error' || log.level === 'fatal' ? 'destructive' : 'secondary'} className="text-[10px]">
                    {log.level}
                  </Badge>
                  <span className="text-muted-foreground truncate">[{log.source}]</span>
                  <span className="flex-1 truncate">{log.message}</span>
                  <span className="text-xs text-muted-foreground whitespace-nowrap">{format(new Date(log.created_at), 'HH:mm:ss')}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
