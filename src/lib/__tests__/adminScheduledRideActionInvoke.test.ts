import { describe, it, expect } from 'vitest';
import { FunctionsHttpError } from '@supabase/supabase-js';
import { toAdminScheduledRideActionResult } from '../adminScheduledRideActionInvoke';

const httpError = (status: number, body: unknown) =>
  new FunctionsHttpError(
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  );

describe('admin scheduled ride action result', () => {
  it('reads the payment gate block from a 409 body', async () => {
    const r = await toAdminScheduledRideActionResult(
      null,
      httpError(409, { success: false, error: 'PAYMENT_GATE_NOT_SATISFIED', message: 'Hold too small' }),
    );
    expect(r).toEqual({ success: false, error: 'PAYMENT_GATE_NOT_SATISFIED', message: 'Hold too small' });
  });

  it('uses the permission code from a 403 body, not its human text', async () => {
    const r = await toAdminScheduledRideActionResult(
      null,
      httpError(403, { error: 'Forbidden — scheduled_rides.assign required', code: 'ACTION_PERMISSION_DENIED' }),
    );
    expect(r.error).toBe('ACTION_PERMISSION_DENIED');
  });

  it('reads airport pricing and wallet blocks', async () => {
    expect((await toAdminScheduledRideActionResult(null, httpError(409, { error: 'AIRPORT_PRICING_UNRESOLVED' }))).error)
      .toBe('AIRPORT_PRICING_UNRESOLVED');
    expect((await toAdminScheduledRideActionResult(null, httpError(409, { error: 'INSUFFICIENT_COMMISSION_WALLET_BALANCE', message: 'Driver has insufficient commission wallet balance for this trip' }))).message)
      .toBe('Driver has insufficient commission wallet balance for this trip');
  });

  it('never returns the generic non-2xx text when the body is unreadable', async () => {
    const err = new FunctionsHttpError(new Response('not json', { status: 500 }));
    const r = await toAdminScheduledRideActionResult(null, err);
    expect(r.error).toBe('Request rejected (HTTP 500)');
  });

  it('reports success only when the body says success', async () => {
    expect(await toAdminScheduledRideActionResult({ success: true }, null)).toEqual({ success: true });
    expect((await toAdminScheduledRideActionResult({}, null)).success).toBe(false);
  });
});
