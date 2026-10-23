/**
 * Canonical Admin client for driver enable / disable.
 * Calls public.admin_set_driver_operational_status — never direct drivers.driver_status writes.
 */
import { supabase } from '@/integrations/supabase/client';

export type DriverOperationalStatus = 'active' | 'disabled';

export type AdminSetDriverOperationalStatusResult =
  | {
      ok: true;
      driver_status: DriverOperationalStatus;
      is_online: boolean;
      driver_online_intent: boolean;
      unchanged: boolean;
    }
  | {
      ok: false;
      error_code: string;
      message: string;
    };

export async function adminSetDriverOperationalStatus(args: {
  driverId: string;
  status: DriverOperationalStatus;
}): Promise<AdminSetDriverOperationalStatusResult> {
  const driverId = String(args.driverId ?? '').trim();
  if (!driverId) {
    return { ok: false, error_code: 'driver_id_required', message: 'Driver id is required.' };
  }
  if (args.status !== 'active' && args.status !== 'disabled') {
    return {
      ok: false,
      error_code: 'invalid_status',
      message: 'Status must be active or disabled.',
    };
  }

  const { data, error } = await supabase.rpc('admin_set_driver_operational_status', {
    p_driver_id: driverId,
    p_status: args.status,
  });

  if (error) {
    const message = error.message || 'Failed to update driver status.';
    const code =
      (typeof error.code === 'string' && error.code.trim()) ||
      (message.includes('active trip')
        ? 'active_trip'
        : message.includes('not authorized')
          ? 'not_authorized'
          : 'rpc_error');
    return { ok: false, error_code: code, message };
  }

  const row = (data ?? {}) as Record<string, unknown>;
  if (row.ok === false) {
    return {
      ok: false,
      error_code: String(row.error_code ?? 'rpc_rejected'),
      message: String(row.message ?? 'Failed to update driver status.'),
    };
  }

  const status = String(row.driver_status ?? args.status);
  return {
    ok: true,
    driver_status: status === 'disabled' ? 'disabled' : 'active',
    is_online: row.is_online === true,
    driver_online_intent: row.driver_online_intent === true,
    unchanged: row.unchanged === true,
  };
}
