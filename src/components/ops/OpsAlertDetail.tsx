import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { ArrowLeft, CheckCircle, Eye, BellOff, Sparkles, ExternalLink, RefreshCw, Loader2, AlertTriangle } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { format, formatDistanceToNow } from 'date-fns';
import { cn } from '@/lib/utils';
import { generateAISummary, regenerateAISummary, fetchAISummary } from '@/lib/opsAiSummaryService';
import type { AISummaryInput } from '@/lib/opsAiSummaryService';

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
  const [aiGenerating, setAiGenerating] = useState(false);

  // Fetch AI summary
  const { data: aiSummary, isLoading: aiLoading, error: aiError, refetch: refetchAI } = useQuery({
    queryKey: ['ops-ai-summary', alert.id],
    queryFn: () => fetchAISummary(alert.id),
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
    queryKey: ['ops-logs-related', alert.id, alert.related_trip_id],
    queryFn: async () => {
      const results: any[] = [];
      if (alert.related_trip_id) {
        const { data } = await supabase
          .from('ops_logs')
          .select('*')
          .eq('trip_id', alert.related_trip_id)
          .order('created_at', { ascending: false })
          .limit(10);
        if (data) results.push(...data);
      }
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

  // Build AI input from alert context
  const buildAIInput = (): AISummaryInput => ({
    alertId: alert.id,
    category: alert.category,
    severity: alert.severity,
    title: alert.title,
    description: alert.description,
    fingerprint: alert.fingerprint,
    fingerprintCount: alert.fingerprint_count,
    source: alert.source,
    app: alert.app,
    metadata: alert.metadata,
    relatedTripId: alert.related_trip_id,
    relatedDriverId: alert.related_driver_id,
    relatedPaymentId: alert.related_payment_id,
    relatedPayoutBatchId: alert.related_payout_batch_id,
    relatedLogs: relatedLogs?.map((l: any) => ({ level: l.level, source: l.source, message: l.message })),
  });

  const handleGenerateAI = async () => {
    setAiGenerating(true);
    const result = await generateAISummary(buildAIInput());
    setAiGenerating(false);
    if (result.success) {
      toast.success('AI summary generated');
      refetchAI();
    } else {
      toast.error('Failed to generate summary', { description: result.error });
    }
  };

  const handleRegenerateAI = async () => {
    setAiGenerating(true);
    const result = await regenerateAISummary(buildAIInput());
    setAiGenerating(false);
    if (result.success) {
      toast.success('AI summary regenerated');
      refetchAI();
    } else {
      toast.error('Failed to regenerate summary', { description: result.error });
    }
  };

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

          <div>
            <span className="text-muted-foreground text-xs">Fingerprint</span>
            <code className="block text-xs bg-muted px-2 py-1 rounded mt-0.5 break-all">{alert.fingerprint}</code>
          </div>

          {(alert.acknowledged_at || alert.resolved_at || alert.suppressed_until) && (
            <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
              {alert.acknowledged_at && <span>Acknowledged: {format(new Date(alert.acknowledged_at), 'PPp')}</span>}
              {alert.resolved_at && <span>Resolved: {format(new Date(alert.resolved_at), 'PPp')}</span>}
              {alert.suppressed_until && <span>Suppressed until: {format(new Date(alert.suppressed_until), 'PPp')}</span>}
            </div>
          )}

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

      {/* AI Incident Summary */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" /> AI Incident Summary
            </CardTitle>
            <div className="flex items-center gap-2">
              {aiSummary ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleRegenerateAI}
                  disabled={aiGenerating}
                >
                  {aiGenerating ? (
                    <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4 mr-1" />
                  )}
                  Regenerate
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleGenerateAI}
                  disabled={aiGenerating || aiLoading}
                >
                  {aiGenerating ? (
                    <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  ) : (
                    <Sparkles className="h-4 w-4 mr-1" />
                  )}
                  {aiGenerating ? 'Generating…' : 'Generate Summary'}
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {aiLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-5/6" />
            </div>
          ) : aiError ? (
            <div className="flex items-center gap-2 text-sm text-destructive">
              <AlertTriangle className="h-4 w-4" />
              <span>Failed to load summary. <button onClick={() => refetchAI()} className="underline">Retry</button></span>
            </div>
          ) : aiSummary ? (
            <div className="space-y-4">
              {/* Summary */}
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1">Summary</p>
                <p className="text-sm leading-relaxed">{aiSummary.summary}</p>
              </div>

              {/* Root Cause */}
              {aiSummary.root_cause && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-1">Likely Root Cause</p>
                  <p className="text-sm leading-relaxed">{aiSummary.root_cause}</p>
                </div>
              )}

              {/* Recommended Action */}
              {aiSummary.recommended_action && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-1">Recommended Next Action</p>
                  <p className="text-sm leading-relaxed">{aiSummary.recommended_action}</p>
                </div>
              )}

              {/* Status bar */}
              <Separator />
              <div className="flex items-center gap-4 flex-wrap text-xs text-muted-foreground">
                <div className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-emerald-500" />
                  <span>Generated</span>
                </div>
                <span>Model: {aiSummary.model_used}</span>
                {aiSummary.confidence_score != null && (
                  <span>Confidence: {Math.round(aiSummary.confidence_score * 100)}%</span>
                )}
                {aiSummary.created_at && (
                  <span>Created: {formatDistanceToNow(new Date(aiSummary.created_at), { addSuffix: true })}</span>
                )}
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-6 text-center">
              <Sparkles className="h-8 w-8 text-muted-foreground/40 mb-2" />
              <p className="text-sm text-muted-foreground">No AI summary yet</p>
              <p className="text-xs text-muted-foreground mt-1">
                Click "Generate Summary" to create an AI-powered incident analysis
              </p>
            </div>
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
