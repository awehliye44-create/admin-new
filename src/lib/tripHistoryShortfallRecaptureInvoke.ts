/**
 * Structured Edge invoke error parsing for Trip History shortfall recapture.
 * Never surface only the opaque "Edge Function returned a non-2xx status code."
 */
import { FunctionsHttpError } from '@supabase/supabase-js';

export type ShortfallRecaptureInvokeError = {
  code: string;
  message: string;
  retryable: boolean;
  attempt_id: string | null;
  provider_attempt_created: boolean;
  outstanding_shortfall_pence?: number | null;
};

function fromPayload(payload: Record<string, unknown> | null | undefined): ShortfallRecaptureInvokeError | null {
  if (!payload || typeof payload !== 'object') return null;
  const code = String(payload.code ?? payload.error_code ?? '').trim();
  const message = String(payload.message ?? payload.error ?? '').trim();
  if (!code && !message) return null;
  return {
    code: code || 'RECAPTURE_FAILED',
    message: message || 'Recapture request failed',
    retryable: payload.retryable === true || payload.retry_allowed === true
      || (typeof payload.retryable !== 'boolean'
        && !code.includes('NOT_ALLOWED')
        && !code.includes('FORBIDDEN')
        && !code.includes('MISMATCH')),
    attempt_id: typeof payload.attempt_id === 'string'
      ? payload.attempt_id
      : (typeof payload.payment_session_id === 'string' ? payload.payment_session_id : null),
    provider_attempt_created: payload.provider_attempt_created === true,
    outstanding_shortfall_pence: typeof payload.outstanding_shortfall_pence === 'number'
      ? payload.outstanding_shortfall_pence
      : null,
  };
}

export async function parseShortfallRecaptureInvokeFailure(
  error: unknown,
  data: Record<string, unknown> | null | undefined,
): Promise<ShortfallRecaptureInvokeError> {
  const fromData = fromPayload(data);
  if (fromData) return fromData;

  if (error instanceof FunctionsHttpError) {
    try {
      const ctx = error.context as Response & { json?: () => Promise<unknown>; clone?: () => Response };
      let payload: Record<string, unknown> | null = null;
      if (typeof ctx?.json === 'function') {
        try {
          payload = await (ctx.clone?.() ?? ctx).json() as Record<string, unknown>;
        } catch {
          payload = await ctx.json() as Record<string, unknown>;
        }
      }
      const fromErr = fromPayload(payload);
      if (fromErr) return fromErr;
    } catch {
      /* fall through */
    }
    if (/non-2xx|edge function/i.test(error.message)) {
      return {
        code: 'EDGE_FUNCTION_NON_2XX',
        message: 'Recapture request failed before a provider charge was confirmed. No duplicate charge should be created until this attempt is reconciled.',
        retryable: true,
        attempt_id: null,
        provider_attempt_created: false,
      };
    }
    return {
      code: 'EDGE_FUNCTION_ERROR',
      message: error.message,
      retryable: true,
      attempt_id: null,
      provider_attempt_created: false,
    };
  }

  if (error instanceof Error && error.message) {
    return {
      code: 'RECAPTURE_FAILED',
      message: error.message,
      retryable: true,
      attempt_id: null,
      provider_attempt_created: false,
    };
  }

  return {
    code: 'RECAPTURE_FAILED',
    message: 'Recapture request failed',
    retryable: true,
    attempt_id: null,
    provider_attempt_created: false,
  };
}

export function shortfallRecaptureUserMessage(err: ShortfallRecaptureInvokeError): string {
  switch (err.code) {
    case 'ORIGINAL_AUTHORISED_HOLD_USABLE':
    case 'original_authorised_hold_usable':
      return 'Original authorised hold is still active. Retrieve and capture the original order before starting recovery.';
    case 'ORIGINAL_PROCESSING':
    case 'original_processing':
      return 'Original payment is still processing. Wait and reconcile before starting recovery.';
    case 'ORIGINAL_UNKNOWN_RECONCILE':
    case 'original_unknown_reconcile':
      return 'Original payment state could not be confirmed. Retrieve and reconcile before starting recovery.';
    case 'OPERATION_PENDING':
    case 'operation_pending':
      return 'A payment operation is already in progress. Wait for it to finish before recovery.';
    case 'REMAINING_SHORTFALL_ZERO':
    case 'remaining_shortfall_zero':
      return 'There is no remaining shortfall to recover.';
    case 'RECOVERY_FUNCTION_UNAVAILABLE':
      return 'Payment recovery service is temporarily unavailable. No provider charge was created.';
    case 'PAYMENT_METHOD_UNAVAILABLE':
    case 'payment_method_unavailable':
      return 'The customer’s payment method is unavailable for recapture.';
    case 'CUSTOMER_ACTION_REQUIRED':
    case 'customer_action_required':
      return 'Customer authentication is required to collect this outstanding payment.';
    case 'DRIVER_COLLECTED_NOT_ALLOWED':
      return 'Driver-collected trips cannot use platform shortfall recapture.';
    case 'PAGE_FORBIDDEN':
    case 'admin_not_permitted':
      return 'You do not have permission to recapture shortfall payments.';
    case 'AMOUNT_NOT_ALLOWED':
      return 'Arbitrary charge amounts are not accepted. The server calculates the outstanding shortfall.';
    case 'SESSION_CUSTOMER_MISMATCH':
      return 'No authoritative payment session is available for this trip and customer.';
    case 'TRIP_NOT_FOUND':
      return 'Trip not found.';
    case 'EDGE_FUNCTION_NON_2XX':
      return err.message;
    default:
      return err.message || 'Recapture request failed';
  }
}
