import { describe, expect, it, vi, beforeEach } from 'vitest';
import { FunctionsHttpError } from '@supabase/supabase-js';

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    functions: {
      invoke: vi.fn(),
    },
  },
}));

import { supabase } from '@/integrations/supabase/client';
import { invokeCommissionWalletTestAccess } from '@/lib/commissionWalletTestAccessAction';

describe('invokeCommissionWalletTestAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns access on success', async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: {
        success: true,
        driver_id: 'd1',
        commission_wallet_test_access: true,
        op: 'get',
      },
      error: null,
    } as never);

    const result = await invokeCommissionWalletTestAccess({ driverId: 'd1' });
    expect(result).toEqual({
      ok: true,
      driver_id: 'd1',
      commission_wallet_test_access: true,
      op: 'get',
    });
  });

  it('parses DRIVER_NOT_FOUND from FunctionsHttpError body', async () => {
    const context = {
      json: async () => ({
        success: false,
        error: 'Driver not found',
        code: 'DRIVER_NOT_FOUND',
      }),
    };
    const err = new FunctionsHttpError(context as never);
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: null,
      error: err,
    } as never);

    const result = await invokeCommissionWalletTestAccess({ driverId: 'missing' });
    expect(result).toEqual({
      ok: false,
      message: 'Driver not found',
      code: 'DRIVER_NOT_FOUND',
    });
  });
});
