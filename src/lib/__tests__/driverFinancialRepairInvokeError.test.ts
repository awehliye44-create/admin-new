import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FunctionsFetchError, FunctionsHttpError } from '@supabase/supabase-js';
import { toDriverFinancialRepairInvokeError } from '../driverFinancialRepairInvokeError';

function httpError(status: number, body: unknown | (() => never)) {
  const ctx = {
    status,
    json: async () => (typeof body === 'function' ? (body as () => never)() : body),
    clone() { return this; },
  };
  const err = new FunctionsHttpError(ctx as never);
  Object.defineProperty(err, 'message', { value: 'Edge Function returned a non-2xx status code' });
  return err;
}

describe('driverFinancialRepairInvokeError', () => {
  it('409 TRIP_DRIVER_MISMATCH shows safe copy, not the opaque non-2xx message', async () => {
    const err = await toDriverFinancialRepairInvokeError(
      httpError(409, { error: 'Trip driver mismatch', error_code: 'TRIP_DRIVER_MISMATCH' }),
      null,
      'preview',
    );
    expect(err?.code).toBe('TRIP_DRIVER_MISMATCH');
    expect(err?.http_status).toBe(409);
    expect(err?.message).toMatch(/not attributed to this driver/i);
    expect(err?.message).not.toMatch(/non-2xx|edge function/i);
  });

  it('never renders raw backend error text or details for internal failures', async () => {
    const err = await toDriverFinancialRepairInvokeError(
      httpError(500, {
        error: 'duplicate key value violates unique constraint "driver_wallet_ledger_pkey"',
        error_code: 'STAMP_RESTORE_FAILED',
        details: { hint: 'relation public.trips', sql: 'UPDATE trips SET ...' },
      }),
      null,
      'apply',
    );
    expect(err?.code).toBe('STAMP_RESTORE_FAILED');
    expect(err?.message).toMatch(/could not be restored/i);
    expect(err?.message).toMatch(/history/i);
    expect(err?.message).not.toMatch(/duplicate key|constraint|relation|UPDATE|pkey/i);
  });

  it('unknown code is shown as a code only, never with its message', async () => {
    const err = await toDriverFinancialRepairInvokeError(
      httpError(400, { error: 'internal: column x of relation y', error_code: 'SOMETHING_NEW' }),
      null,
      'preview',
    );
    expect(err?.message).toBe('Repair preview failed (SOMETHING_NEW).');
  });

  it('rejects non-identifier codes instead of echoing them', async () => {
    const err = await toDriverFinancialRepairInvokeError(
      httpError(400, { error: 'x', error_code: 'select * from trips; --' }),
      null,
      'preview',
    );
    expect(err?.code).toBe('HTTP_400');
    expect(err?.message).toBe('Repair preview request was rejected (HTTP 400).');
  });

  it('unparseable 5xx body (boot failure) gives a safe availability message', async () => {
    const err = await toDriverFinancialRepairInvokeError(
      httpError(503, () => { throw new Error('no body'); }),
      null,
      'apply',
    );
    expect(err?.code).toBe('HTTP_503');
    expect(err?.message).toMatch(/unavailable \(HTTP 503\)/);
    expect(err?.message).not.toMatch(/non-2xx/i);
  });

  it('200 with error payload maps by code', async () => {
    const err = await toDriverFinancialRepairInvokeError(
      null,
      { error: 'Preview stale', error_code: 'REPAIR_PREVIEW_STALE' },
      'apply',
    );
    expect(err?.message).toMatch(/Load a new preview/);
  });

  it('network failure never shows transport internals', async () => {
    const err = await toDriverFinancialRepairInvokeError(
      new FunctionsFetchError({ message: 'getaddrinfo ENOTFOUND internal-host' }),
      null,
      'preview',
    );
    expect(err?.message).toBe('Repair preview failed. Please try again.');
  });

  it('success returns null', async () => {
    expect(await toDriverFinancialRepairInvokeError(null, { preview: {} }, 'preview')).toBeNull();
  });

  it('panel routes both preview and apply failures through the safe mapper', () => {
    const src = readFileSync(
      resolve(__dirname, '../../components/finance/DriverWalletReviewRepairPanel.tsx'),
      'utf8',
    );
    expect(src).toContain("toDriverFinancialRepairInvokeError(error, data, 'preview')");
    expect(src).toContain("toDriverFinancialRepairInvokeError(error, data, 'apply')");
    expect(src).not.toMatch(/if \(error\) throw error;/);
    expect(src).not.toMatch(/new Error\(String\(data\.error\)\)/);
  });
});
