import { supabase } from '@/integrations/supabase/client';

export interface AISummaryInput {
  alertId: string;
  category: string;
  severity: string;
  title: string;
  description: string | null;
  fingerprint: string;
  fingerprintCount: number;
  source: string;
  app: string | null;
  metadata: Record<string, unknown>;
  relatedTripId: string | null;
  relatedDriverId: string | null;
  relatedPaymentId: string | null;
  relatedPayoutBatchId: string | null;
  relatedLogs?: Array<{ level: string; source: string; message: string }>;
}

export interface AISummaryResult {
  summary: string;
  root_cause: string;
  recommended_action: string;
  confidence_score: number;
  model_used: string;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function generateAISummary(input: AISummaryInput): Promise<{ success: boolean; error?: string }> {
  try {
    const { data, error } = await supabase.functions.invoke('ops-ai-summary', {
      body: { alert_id: input.alertId },
    });

    if (error) throw error;
    if (data?.error) throw new Error(data.error);

    return { success: true };
  } catch (e: any) {
    console.error('AI Summary generation failed:', e);
    return { success: false, error: e.message || 'Unknown error' };
  }
}

export async function regenerateAISummary(input: AISummaryInput): Promise<{ success: boolean; error?: string }> {
  // The edge function already deletes existing summaries before inserting
  return generateAISummary(input);
}

export async function fetchAISummary(alertId: string) {
  const { data, error } = await supabase
    .from('ops_alert_summaries')
    .select('*')
    .eq('alert_id', alertId)
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) throw error;
  return data?.[0] || null;
}
