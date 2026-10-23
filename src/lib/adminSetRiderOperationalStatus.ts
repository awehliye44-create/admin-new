/**
 * Canonical Admin client for rider enable / disable / suspend.
 * Calls public.admin_set_rider_operational_status — never bare customers.rider_status writes.
 */
import { supabase } from '@/integrations/supabase/client';

export type RiderOperationalStatus = 'active' | 'disabled' | 'suspended';

export type AdminSetRiderOperationalStatusResult =
  | {
      ok: true;
      rider_status: RiderOperationalStatus;
      unchanged: boolean;
      sessions_revoked: boolean;
    }
  | {
      ok: false;
      error_code: string;
      message: string;
    };

export async function adminSetRiderOperationalStatus(args: {
  customerId: string;
  status: RiderOperationalStatus;
  reason?: string | null;
}): Promise<AdminSetRiderOperationalStatusResult> {
  const customerId = String(args.customerId ?? '').trim();
  if (!customerId) {
    return { ok: false, error_code: 'customer_id_required', message: 'Customer id is required.' };
  }
  if (args.status !== 'active' && args.status !== 'disabled' && args.status !== 'suspended') {
    return {
      ok: false,
      error_code: 'invalid_status',
      message: 'Status must be active, disabled, or suspended.',
    };
  }

  const { data, error } = await supabase.rpc('admin_set_rider_operational_status', {
    p_customer_id: customerId,
    p_status: args.status,
    p_reason: args.reason?.trim() || null,
  });

  if (error) {
    return {
      ok: false,
      error_code: (typeof error.code === 'string' && error.code) || 'rpc_error',
      message: error.message || 'Failed to update rider status.',
    };
  }

  const row = (data ?? {}) as Record<string, unknown>;
  if (row.ok === false) {
    return {
      ok: false,
      error_code: String(row.error_code ?? 'rpc_rejected'),
      message: String(row.message ?? 'Failed to update rider status.'),
    };
  }

  const status = String(row.rider_status ?? args.status) as RiderOperationalStatus;
  return {
    ok: true,
    rider_status:
      status === 'disabled' || status === 'suspended' || status === 'active'
        ? status
        : args.status,
    unchanged: row.unchanged === true,
    sessions_revoked: row.sessions_revoked === true,
  };
}
