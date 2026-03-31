import { supabase } from '@/integrations/supabase/client';

/**
 * AI Summary Service — abstraction layer for generating ops alert summaries.
 * Currently uses mock/template-based summaries.
 * Ready to swap to a real AI provider (OpenAI, Lovable AI) by replacing generateWithProvider().
 */

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

// ─── Mock / Template Provider ────────────────────────────────────────────────

const CATEGORY_TEMPLATES: Record<string, { summary: string; root_cause: string; action: string }> = {
  payment: {
    summary: 'Payment processing failure detected. A payment capture or charge was unsuccessful.',
    root_cause: 'Card declined, expired, or blocked by the issuing bank. Alternatively, a Stripe API timeout or network issue may have prevented the charge.',
    action: 'Check Stripe dashboard for the specific payment intent. Contact the customer to update their payment method if needed. Review retry logic in payment capture flow.',
  },
  commission: {
    summary: 'Commission was not recorded for a completed trip. The trip_finance record is missing or incomplete.',
    root_cause: 'The complete-trip edge function may have failed after updating trip status but before creating the commission record. Could also be a race condition.',
    action: 'Run the repair-commissions edge function to reconcile. Check edge function logs around the trip completion time for errors.',
  },
  earning: {
    summary: 'Driver earning was not recorded in the ledger after trip completion.',
    root_cause: 'The driver ledger entry was skipped during trip completion, likely due to an edge function timeout or partial failure.',
    action: 'Manually verify the trip_finance record exists. Insert the missing driver ledger entry or run reconciliation.',
  },
  payout: {
    summary: 'A payout batch failed during processing. Affected drivers have not been paid.',
    root_cause: 'Stripe Connect payout API error. May be insufficient platform balance, driver account suspension, or Stripe API downtime.',
    action: 'Check Stripe dashboard for the failed transfer. Verify platform balance. Retry the payout batch after resolving the underlying issue.',
  },
  dispatch: {
    summary: 'Trip stuck in dispatch — no driver has accepted within the expected time window.',
    root_cause: 'No eligible drivers online in the service area, search radius too small, or all available drivers declined the offer.',
    action: 'Check driver availability map. Consider expanding search radius or manually assigning a driver. Review dispatch settings.',
  },
  guest_booking: {
    summary: 'Guest booking flow on guest.onecab.net experienced a failure or abandonment.',
    root_cause: 'Payment processing failure, fare estimation timeout, or booking confirmation delay on the guest web platform.',
    action: 'Check guest booking logs for the specific error. Review Stripe payment intents for the session. Consider adding retry mechanisms.',
  },
  corporate_booking: {
    summary: 'Corporate booking request encountered an issue during processing.',
    root_cause: 'Policy validation failure, credit limit exceeded, or corporate account configuration issue.',
    action: 'Review corporate account settings and policies. Check if the booking violated any configured restrictions.',
  },
  duplication: {
    summary: 'Duplicate entries detected — may indicate retry issues or double-click submissions.',
    root_cause: 'Missing idempotency checks in the affected flow. Client-side retries or double-clicks can create duplicate records.',
    action: 'Review the duplicate records and remove extras. Add idempotency keys to the relevant API endpoints to prevent recurrence.',
  },
  backend: {
    summary: 'Backend/API error spike detected. Multiple server errors from the same edge function.',
    root_cause: 'Edge function experiencing failures — possibly database connection issues, Stripe API timeouts, or code bugs.',
    action: 'Check edge function logs for detailed error messages. Review recent deployments for regressions. Monitor dependent services.',
  },
  logs: {
    summary: 'Abnormal log patterns detected. Error or fatal log entries have spiked above normal levels.',
    root_cause: 'A system component is generating excessive errors. May indicate a cascading failure or external dependency issue.',
    action: 'Use the logs explorer to identify the specific source generating errors. Check dependent services (Stripe, Supabase, etc.).',
  },
  customer_app: {
    summary: 'Customer app reported an error or anomalous behavior.',
    root_cause: 'App crash, API call failure, or UI rendering error on the customer-facing application.',
    action: 'Review customer app error logs. Check API endpoints the app relies on. Verify recent app updates.',
  },
  driver_app: {
    summary: 'Driver app reported an error or anomalous behavior.',
    root_cause: 'App crash, location services failure, or API timeout on the driver-facing application.',
    action: 'Review driver app error logs. Check GPS/location service status. Verify recent app updates.',
  },
  system: {
    summary: 'System-level issue detected affecting platform operations.',
    root_cause: 'Infrastructure issue, service degradation, or configuration problem at the platform level.',
    action: 'Check Supabase dashboard for service status. Review infrastructure logs and database performance metrics.',
  },
};

function generateMockSummary(input: AISummaryInput): AISummaryResult {
  const template = CATEGORY_TEMPLATES[input.category] || CATEGORY_TEMPLATES.system;

  // Enrich summary with contextual details
  let summary = template.summary;
  if (input.relatedTripId) {
    summary += ` Affected trip: ${input.relatedTripId.slice(0, 8)}…`;
  }
  if (input.fingerprintCount > 1) {
    summary += ` This issue has occurred ${input.fingerprintCount} times.`;
  }

  let rootCause = template.root_cause;
  if (input.relatedLogs && input.relatedLogs.length > 0) {
    const errorLogs = input.relatedLogs.filter(l => l.level === 'error' || l.level === 'fatal');
    if (errorLogs.length > 0) {
      rootCause += ` Related log: "${errorLogs[0].message.slice(0, 100)}"`;
    }
  }

  return {
    summary,
    root_cause: rootCause,
    recommended_action: template.action,
    confidence_score: 0.72,
    model_used: 'mock-template-v1',
  };
}

// ─── Provider Abstraction ────────────────────────────────────────────────────

type SummaryProvider = 'mock' | 'lovable-ai';

async function generateWithProvider(
  input: AISummaryInput,
  _provider: SummaryProvider = 'mock'
): Promise<AISummaryResult> {
  // Future: add 'lovable-ai' case that calls the edge function
  // For now, always use mock
  return generateMockSummary(input);
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function generateAISummary(input: AISummaryInput): Promise<{ success: boolean; error?: string }> {
  try {
    const result = await generateWithProvider(input, 'mock');

    const { error } = await supabase.from('ops_ai_summaries').insert({
      alert_id: input.alertId,
      summary: result.summary,
      root_cause: result.root_cause,
      recommended_action: result.recommended_action,
      confidence_score: result.confidence_score,
      model_used: result.model_used,
    });

    if (error) throw error;
    return { success: true };
  } catch (e: any) {
    console.error('AI Summary generation failed:', e);
    return { success: false, error: e.message || 'Unknown error' };
  }
}

export async function regenerateAISummary(input: AISummaryInput): Promise<{ success: boolean; error?: string }> {
  try {
    // Delete existing summaries for this alert
    await supabase.from('ops_ai_summaries').delete().eq('alert_id', input.alertId);
    // Generate fresh
    return generateAISummary(input);
  } catch (e: any) {
    return { success: false, error: e.message || 'Unknown error' };
  }
}

export async function fetchAISummary(alertId: string) {
  const { data, error } = await supabase
    .from('ops_ai_summaries')
    .select('*')
    .eq('alert_id', alertId)
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) throw error;
  return data?.[0] || null;
}
