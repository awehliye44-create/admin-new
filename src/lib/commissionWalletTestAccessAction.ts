import { FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';

export type CommissionWalletTestAccessResult =
  | {
    ok: true;
    driver_id: string;
    commission_wallet_test_access: boolean;
    op?: string;
  }
  | {
    ok: false;
    message: string;
    code?: string;
  };

async function parseInvokeFailure(
  error: unknown,
  data: Record<string, unknown> | null | undefined,
): Promise<{ message: string; code?: string }> {
  if (data && data.success === false) {
    return {
      message: typeof data.error === 'string' ? data.error : 'Request failed',
      code: typeof data.code === 'string' ? data.code : undefined,
    };
  }
  if (error instanceof FunctionsHttpError) {
    try {
      const payload = await error.context.json() as Record<string, unknown>;
      return {
        message: typeof payload?.error === 'string' ? payload.error : error.message,
        code: typeof payload?.code === 'string' ? payload.code : undefined,
      };
    } catch {
      return { message: error.message };
    }
  }
  if (error instanceof Error) return { message: error.message };
  return { message: 'Request failed' };
}

/** Get or set Phase 3 test access via page-gated admin edge. */
export async function invokeCommissionWalletTestAccess(input: {
  driverId: string;
  enabled?: boolean;
}): Promise<CommissionWalletTestAccessResult> {
  const body: { driver_id: string; enabled?: boolean } = {
    driver_id: input.driverId,
  };
  if (typeof input.enabled === 'boolean') {
    body.enabled = input.enabled;
  }

  const { data, error } = await supabase.functions.invoke(
    'admin-set-commission-wallet-test-access',
    { body },
  );

  const payload = (data ?? null) as Record<string, unknown> | null;
  if (error || !payload?.success) {
    const parsed = await parseInvokeFailure(error, payload);
    return {
      ok: false,
      message: parsed.code === 'DRIVER_NOT_FOUND' ? 'Driver not found' : parsed.message,
      code: parsed.code,
    };
  }

  return {
    ok: true,
    driver_id: String(payload.driver_id),
    commission_wallet_test_access: Boolean(payload.commission_wallet_test_access),
    op: typeof payload.op === 'string' ? payload.op : undefined,
  };
}
