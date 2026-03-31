import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { ArrowLeft, CheckCircle, Eye, BellOff, Sparkles, ExternalLink } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { format, formatDistanceToNow } from 'date-fns';
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
  related_entity_type?: string | null;
  related_entity_id?: string | null;
  suppressed_until?: string | null;
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

const LEVEL_COLORS: Record<string, string> = {
  debug: 'bg-muted text-muted-foreground',
  info: 'bg-blue-500/10 text-blue-600 border-blue-500/30',
  warn: 'bg-amber-500/10 text-amber-600 border-amber-500/30',
  error: 'bg-destructive/10 text-destructive border-destructive/30',
  fatal: 'bg-destructive text-destructive-foreground',
};

export function OpsAlertDetail({ alert, onBack, onRefresh }: OpsAlertDetailProps) {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  // Fetch AI summary
  const { data: aiSummary, refetch: refetchAI } = useQuery({
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

  // Fetch related logs — by trip_id OR by time window around alert
  const { data: relatedLogs } = useQuery({
    queryKey: ['ops-logs-related', alert.id, alert.related_trip_id],
    queryFn: async () => {
      const results: any[] = [];

      // By trip_id
      if (alert.related_trip_id) {
        const { data } = await supabase
          .from('ops_logs')
          .select('*')
          .eq('trip_id', alert.related_trip_id)
          .order('created_at', { ascending: false })
          .limit(10);
        if (data) results.push(...data);
      }

      // By related_entity_id if it's an ops_log
      if (alert.related_entity_type === 'ops_log' && alert.related_entity_id) {
        const { data } = await supabase
          .from('ops_logs')
          .select('*')
          .eq('id', alert.related_entity_id)
          .limit(1);
        if (data) {
          data.forEach(d => {
            if (!results.find(r => r.id === d.id)) results.push(d);
          });
        }
      }

      // By time window around alert detection (±5 min) if no trip-based logs found
      if (results.length === 0) {
        const alertTime = new Date(alert.last_detected_at);
        const from = new Date(alertTime.getTime() - 5 * 60 * 1000).toISOString();
        const to = new Date(alertTime.getTime() + 5 * 60 * 1000).toISOString();
        const { data } = await supabase
          .from('ops_logs')
          .select('*')
          .gte('created_at', from)
          .lte('created_at', to)
          .in('level', ['error', 'fatal', 'warn'])
          .order('created_at', { ascending: false })
          .limit(10);
        if (data) results.push(...data);
      }

      return results;
    },
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
        summary: 'Commission was not recorded for a completed trip. The trip_finance record is missing or incomplete.',
        root_cause: 'The complete-trip edge function may have failed after updating the trip status but before inserting the trip_finance record.',
        action: 'Run the repair-commissions edge function to reconcile missing entries. Check edge function logs for errors around the trip completion time.',
      },
      earning: {
        summary: 'Driver earning was not recorded in the ledger for a completed trip.',
        root_cause: 'The driver ledger entry was not created during trip completion, possibly due to a race condition or edge function timeout.',
        action: 'Manually insert the missing driver ledger entry or run the reconciliation process.',
      },
      payout: {
        summary: 'A payout batch failed during processing. Drivers have not been paid.',
        root_cause: 'Stripe Connect payout API returned an error. May be due to insufficient platform balance or driver account issues.',
        action: 'Check Stripe dashboard for the failed transfer details. Retry the payout batch after resolving the underlying issue.',
      },
      dispatch: {
        summary: 'Trip has been stuck in dispatch for an extended period with no driver accepting.',
        root_cause: 'No eligible drivers online in the service area, or dispatch search radius too small. All available drivers may have declined.',
        action: 'Check driver availability in the service area. Consider expanding search radius or manually assigning a driver.',
      },
      guest_booking: {
        summary: 'Guest booking flow on guest.onecab.net experienced a failure. Customer may have abandoned the booking.',
        root_cause: 'Could be a payment processing failure, fare estimation timeout, or booking confirmation delay on the guest web platform.',
        action: 'Check the guest booking logs for the specific error. Review Stripe payment intents for the session. Consider adding retry mechanisms.',
      },
      duplication: {
        summary: 'Duplicate entries detected that may indicate retry issues or double-click submissions.',
        root_cause: 'Idempotency check may be missing in the relevant flow. Client-side retries or double-clicks can cause duplicate records.',
        action: 'Review the duplicate records and remove extras. Add idempotency keys to prevent recurrence.',
      },
      backend: {
        summary: 'Backend/API error spike detected. Multiple server errors from the same edge function.',
        root_cause: 'The edge function is experiencing failures. Could be due to database connection issues, Stripe API timeouts, or code bugs.',
        action: 'Check edge function logs for detailed error messages. Review recent deployments for regressions.',
      },
      logs: {
        summary: 'Abnormal log patterns detected. Error or fatal entries have spiked above normal levels.',
        root_cause: 'A system component is generating excessive errors. This may indicate a cascading failure or external dependency issue.',
        action: 'Investigate the logs explorer for the specific source generating errors. Check dependent services (Stripe, Supabase, etc.).',
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
      refetchAI();
    } catch (e: any) {
      toast.error('Failed to generate summary', { description: e.message });
    }
  };

  // Helper to build related reference items
  const relatedRefs = [
    { label: 'Trip', value: alert.related_trip_id },
    { label: 'Driver', value: alert.related_driver_id },
    { label: 'Payment', value: alert.related_payment_id },
    { label: 'Payout Batch', value: alert.related_payout_batch_id },
    ...(alert.related_entity_type && alert.related_entity_id
      ? [{ label: alert.related_entity_type.replace(/_/g, ' '), value: alert.related_entity_id }]
      : []),
  ].filter(r => r.value);

  return (
    <div className="space-y-6">
      {/* Back + Actions */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="h-4 w-4 mr-2" /> Back to Alerts
        </Button>
        <div className="flex gap-2 flex-wrap">
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
          <div className="flex items-center gap-3 flex-wrap">
            <Badge className={cn(SEVERITY_COLORS[alert.severity])}>{alert.severity.toUpperCase()}</Badge>
            <Badge variant="outline">{alert.status}</Badge>
            <Badge variant="secondary">{alert.category.replace(/_/g, ' ')}</Badge>
            {alert.app && <Badge variant="outline" className="text-[10px]">App: {alert.app}</Badge>}
          </div>
          <CardTitle className="mt-2">{alert.title}</CardTitle>
          {alert.description && <p className="text-sm text-muted-foreground">{alert.description}</p>}
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Key Stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <span className="text-muted-foreground block text-xs">Occurrences</span>
              <span className="font-semibold text-lg">{alert.fingerprint_count}</span>
            </div>
            <div>
              <span className="text-muted-foreground block text-xs">First Seen</span>
              <span className="font-medium">{format(new Date(alert.first_detected_at), 'PPp')}</span>
            </div>
            <div>
              <span className="text-muted-foreground block text-xs">Last Seen</span>
              <span className="font-medium">{format(new Date(alert.last_detected_at), 'PPp')}</span>
              <span className="text-xs text-muted-foreground ml-1">
                ({formatDistanceToNow(new Date(alert.last_detected_at), { addSuffix: true })})
              </span>
            </div>
            <div>
              <span className="text-muted-foreground block text-xs">Source</span>
              <span className="font-medium">{alert.source}</span>
            </div>
          </div>

          {/* Fingerprint */}
          <div>
            <span className="text-muted-foreground text-xs">Fingerprint</span>
            <code className="block text-xs bg-muted px-2 py-1 rounded mt-0.5 break-all">{alert.fingerprint}</code>
          </div>

          {/* Status timestamps */}
          {(alert.acknowledged_at || alert.resolved_at || alert.suppressed_until) && (
            <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
              {alert.acknowledged_at && <span>Acknowledged: {format(new Date(alert.acknowledged_at), 'PPp')}</span>}
              {alert.resolved_at && <span>Resolved: {format(new Date(alert.resolved_at), 'PPp')}</span>}
              {alert.suppressed_until && <span>Suppressed until: {format(new Date(alert.suppressed_until), 'PPp')}</span>}
            </div>
          )}

          {/* Related References */}
          {relatedRefs.length > 0 && (
            <>
              <Separator />
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2">Related References</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                  {relatedRefs.map((ref, i) => (
                    <div key={i} className="flex items-center gap-2 bg-muted/50 rounded-lg px-3 py-2">
                      <span className="text-xs text-muted-foreground capitalize">{ref.label}:</span>
                      <code className="text-xs font-mono truncate flex-1">{ref.value}</code>
                      <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0" />
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          {/* Metadata */}
          {alert.metadata && Object.keys(alert.metadata).length > 0 && (
            <>
              <Separator />
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2">Metadata</p>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                  {Object.entries(alert.metadata).map(([key, value]) => (
                    <div key={key} className="bg-muted/50 rounded px-2 py-1.5">
                      <span className="text-[10px] text-muted-foreground block">{key}</span>
                      <span className="text-xs font-medium">{typeof value === 'object' ? JSON.stringify(value) : String(value)}</span>
                    </div>
                  ))}
                </div>
              </div>
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
                  <Badge variant="secondary" className="text-[10px] shrink-0">{evt.event_type}</Badge>
                  <span className="text-muted-foreground flex-1 truncate">{evt.description || '—'}</span>
                  {evt.amount_pence != null && (
                    <span className="text-xs text-muted-foreground shrink-0">£{(evt.amount_pence / 100).toFixed(2)}</span>
                  )}
                  <span className="text-xs text-muted-foreground whitespace-nowrap shrink-0">{format(new Date(evt.created_at), 'HH:mm:ss')}</span>
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
            <div className="max-h-80 overflow-auto">
              {relatedLogs.map((log: any) => (
                <div key={log.id} className="flex items-start gap-3 px-4 py-2.5 border-b last:border-0 text-sm font-mono">
                  <span className="text-xs text-muted-foreground whitespace-nowrap pt-0.5 shrink-0">
                    {format(new Date(log.created_at), 'HH:mm:ss.SSS')}
                  </span>
                  <Badge variant="outline" className={cn('text-[10px] shrink-0', LEVEL_COLORS[log.level])}>
                    {log.level?.toUpperCase()}
                  </Badge>
                  <span className="text-xs text-primary/80 shrink-0">[{log.source}]</span>
                  <span className="flex-1 text-foreground break-all text-xs">{log.message}</span>
                  {log.http_status && (
                    <Badge variant="secondary" className="text-[10px] shrink-0">{log.http_status}</Badge>
                  )}
                  {log.duration_ms != null && (
                    <span className="text-xs text-muted-foreground shrink-0">{log.duration_ms}ms</span>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
