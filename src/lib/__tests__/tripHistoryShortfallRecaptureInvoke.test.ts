import { describe, expect, it } from 'vitest';
import { FunctionsHttpError } from '@supabase/supabase-js';
import {
  parseShortfallRecaptureInvokeFailure,
  shortfallRecaptureUserMessage,
} from '../tripHistoryShortfallRecaptureInvoke';

describe('tripHistoryShortfallRecaptureInvoke', () => {
  it('parses structured recovery boot failure instead of opaque non-2xx', async () => {
    const body = {
      success: false,
      code: 'RECOVERY_FUNCTION_UNAVAILABLE',
      message: 'Payment recovery service failed to start. No provider charge was created.',
      retryable: true,
      attempt_id: null,
      provider_attempt_created: false,
    };
    const ctx = {
      json: async () => body,
      clone() { return this; },
    };
    const err = new FunctionsHttpError(ctx as never);
    const parsed = await parseShortfallRecaptureInvokeFailure(err, null);
    expect(parsed.code).toBe('RECOVERY_FUNCTION_UNAVAILABLE');
    expect(parsed.provider_attempt_created).toBe(false);
    expect(shortfallRecaptureUserMessage(parsed)).toMatch(/unavailable/i);
  });

  it('replaces opaque non-2xx when body cannot be parsed', async () => {
    const ctx = {
      json: async () => { throw new Error('no body'); },
    };
    const err = new FunctionsHttpError(ctx as never);
    Object.defineProperty(err, 'message', {
      value: 'Edge Function returned a non-2xx status code.',
    });
    const parsed = await parseShortfallRecaptureInvokeFailure(err, null);
    expect(parsed.code).toBe('EDGE_FUNCTION_NON_2XX');
    expect(parsed.message).not.toMatch(/non-2xx/i);
    expect(parsed.provider_attempt_created).toBe(false);
  });

  it('prefers data payload when present', async () => {
    const parsed = await parseShortfallRecaptureInvokeFailure(null, {
      code: 'SESSION_CUSTOMER_MISMATCH',
      message: 'No authoritative payment session is available for this trip and customer.',
      retryable: false,
      attempt_id: null,
      provider_attempt_created: false,
    });
    expect(parsed.code).toBe('SESSION_CUSTOMER_MISMATCH');
    expect(shortfallRecaptureUserMessage(parsed)).toMatch(/authoritative payment session/i);
  });
});
