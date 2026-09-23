/**
 * Canonical Admin client for driver operational payout pause / resume.
 * Calls public.admin_set_driver_payout_operational_pause — never writes
 * drivers.payouts_enabled / payout_operational_paused from the client.
 */
import { supabase } from '@/integrations/supabase/client';

export type OperationalPauseAction = 'pause' | 'resume';

export type AdminSetDriverPayoutOperationalPauseResult =
  | {
    ok: true;
    payout_operational_paused: boolean;
    payouts_enabled: boolean;
    unchanged: boolean;
  }
  | {
    ok: false;
    error_code: string;
    message: string;
  };

function normalizeReason(reason: string): string {
  return String(reason ?? '').trim();
}

export function validateOperationalPauseReason(reason: string): string | null {
  const trimmed = normalizeReason(reason);
  if (trimmed.length < 3 || trimmed.length > 500) {
    return 'Reason must be 3–500 characters.';
  }
  return null;
}

/**
 * Pause or resume operational payouts for one driver.
 * Resume never sends money — it only restores eligibility for the next evaluation.
 */
export async function adminSetDriverPayoutOperationalPause(args: {
  driverId: string;
  paused: boolean;
  reason: string;
}): Promise<AdminSetDriverPayoutOperationalPauseResult> {
  const driverId = String(args.driverId ?? '').trim();
  if (!driverId) {
    return { ok: false, error_code: 'driver_id_required', message: 'Driver id is required.' };
  }
  const reasonError = validateOperationalPauseReason(args.reason);
  if (reasonError) {
    return { ok: false, error_code: 'reason_required_3_to_500_chars', message: reasonError };
  }

  const { data, error } = await supabase.rpc('admin_set_driver_payout_operational_pause', {
    p_driver_id: driverId,
    p_paused: args.paused === true,
    p_reason: normalizeReason(args.reason),
  });

  if (error) {
    const message = error.message || 'Operational pause update failed.';
    const code =
      (typeof error.code === 'string' && error.code.trim()) ||
      (message.includes('FINANCIAL_READINESS_UNKNOWN')
        ? 'FINANCIAL_READINESS_UNKNOWN'
        : message.includes('DESTINATION_NOT_PROVIDER_VERIFIED')
        ? 'DESTINATION_NOT_PROVIDER_VERIFIED'
        : message.includes('ACTIVE_RESERVATION')
        ? 'ACTIVE_RESERVATION'
        : message.includes('PAYOUT_IN_FLIGHT')
        ? 'PAYOUT_IN_FLIGHT'
        : message.includes('CREDIT_MISMATCH')
        ? 'CREDIT_MISMATCH'
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
      message: String(row.message ?? 'Operational pause update rejected.'),
    };
  }

  return {
    ok: true,
    payout_operational_paused: row.payout_operational_paused === true,
    payouts_enabled: row.payouts_enabled === true,
    unchanged: row.unchanged === true,
  };
}

export function operationalPauseConfirmCopy(args: {
  action: OperationalPauseAction;
  driverName?: string | null;
  driverCode?: string | null;
}): { title: string; body: string } {
  const who = [args.driverName?.trim(), args.driverCode?.trim()].filter(Boolean).join(' · ')
    || 'this driver';
  if (args.action === 'resume') {
    return {
      title: `Resume payouts for ${who}?`,
      body:
        'This allows the driver to be considered for future payouts. It does not send money immediately.',
    };
  }
  return {
    title: `Pause payouts for ${who}?`,
    body:
      'This places an Admin operational hold. Existing in-flight payouts are not cancelled; reconciliation may still be required.',
  };
}
