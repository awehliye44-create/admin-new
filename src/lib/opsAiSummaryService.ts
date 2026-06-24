import { FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';
import { parseApiError } from '@/lib/errorCodes';

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

async function readFunctionError(error: unknown): Promise<string> {
  if (error instanceof FunctionsHttpError) {
    try {
      const payload = await error.context.json();
      if (payload?.error && typeof payload.error === 'string') return payload.error;
      if (payload?.warning && typeof payload.warning === 'string') return payload.warning;
      return parseApiError(payload);
    } catch {
      return error.message;
    }
  }
  return parseApiError(error);
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function generateAISummary(
  input: AISummaryInput,
): Promise<{ success: boolean; degraded?: boolean; warning?: string; error?: string }> {
  try {
    const { data, error } = await supabase.functions.invoke('ops-ai-summary', {
      body: { alert_id: input.alertId },
    });

    if (error) {
      throw Object.assign(error, { parsedMessage: await readFunctionError(error) });
    }
    if (data?.error) throw new Error(String(data.error));

    return {
      success: true,
      degraded: Boolean(data?.degraded),
      warning: typeof data?.warning === 'string' ? data.warning : undefined,
    };
  } catch (e: unknown) {
    const message =
      (e as { parsedMessage?: string }).parsedMessage
      || await readFunctionError(e);
    console.error('AI Summary generation failed:', e);
    return { success: false, error: message || 'Unknown error' };
  }
}

export async function regenerateAISummary(
  input: AISummaryInput,
): Promise<{ success: boolean; degraded?: boolean; warning?: string; error?: string }> {
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
