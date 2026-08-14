import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  resolveDriverFromRows,
  type DriverResolveResult,
  type DriverRowForResolve,
  type ProfileRowForResolve,
} from "../../../shared/resolveAuthenticatedDriver.ts";

export {
  payoutSetupMessageForReason,
  type DriverResolveErrorCode,
  type DriverResolveResult,
  type ResolvedAuthenticatedDriver,
} from "../../../shared/resolveAuthenticatedDriver.ts";

const DRIVER_SELECT =
  'id, user_id, email, phone, first_name, last_name, deleted_at, created_at';

function isRlsOrPermissionError(message: string, code?: string): boolean {
  const m = message.toLowerCase();
  return (
    code === '42501' ||
    m.includes('permission denied') ||
    m.includes('row-level security') ||
    m.includes('rls')
  );
}

/**
 * Resolve auth.users id → drivers row (service-role client).
 * Lookup: drivers.user_id = authUserId (never drivers.id = auth uid unless equal by data).
 */
export async function resolveAuthenticatedDriver(
  supabase: SupabaseClient,
  authUserId: string | null | undefined,
  logPrefix = 'PAYOUT_SETUP',
): Promise<DriverResolveResult> {
  console.log(`${logPrefix}_DRIVER_RESOLVE_STARTED`);

  if (!authUserId || authUserId.trim().length === 0) {
    console.error(`${logPrefix}_DRIVER_RESOLVE_FAILED`, JSON.stringify({ reason: 'auth_user_missing' }));
    return {
      ok: false,
      reason: 'auth_user_missing',
      message: 'Authentication required.',
    };
  }

  const userId = authUserId.trim();
  console.log(`${logPrefix}_AUTH_USER_ID`, JSON.stringify({ auth_user_id: userId }));

  const { data: driverRows, error: driverError } = await supabase
    .from('drivers')
    .select(DRIVER_SELECT)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(5);

  if (driverError) {
    const reason = isRlsOrPermissionError(driverError.message, driverError.code)
      ? 'rls_denied'
      : 'driver_row_missing';
    console.error(`${logPrefix}_DRIVER_RESOLVE_FAILED`, JSON.stringify({
      reason,
      code: driverError.code ?? null,
      message: driverError.message,
    }));
    return {
      ok: false,
      reason,
      message: reason === 'rls_denied'
        ? 'Unable to load driver profile due to permissions.'
        : 'Driver profile not found. Please contact support.',
      detail: driverError.message,
    };
  }

  let profile: ProfileRowForResolve | null = null;
  const rows = (driverRows ?? []) as DriverRowForResolve[];

  if (rows.length === 0) {
    const { data: profileRow, error: profileError } = await supabase
      .from('profiles')
      .select('user_id, role, full_name')
      .eq('user_id', userId)
      .maybeSingle();

    if (profileError && isRlsOrPermissionError(profileError.message, profileError.code)) {
      console.error(`${logPrefix}_DRIVER_RESOLVE_FAILED`, JSON.stringify({
        reason: 'rls_denied',
        scope: 'profiles',
      }));
      return {
        ok: false,
        reason: 'rls_denied',
        message: 'Unable to load account profile due to permissions.',
        detail: profileError.message,
      };
    }

    profile = profileRow as ProfileRowForResolve | null;
  }

  const result = resolveDriverFromRows(userId, rows, profile);

  if (result.ok) {
    console.log(`${logPrefix}_DRIVER_RESOLVE_SUCCESS`, JSON.stringify({
      driver_id: result.driver.driver_id,
      source: result.source,
      multiple_driver_rows: result.multiple_driver_rows ?? false,
    }));
    return result;
  }

  console.error(`${logPrefix}_DRIVER_RESOLVE_FAILED`, JSON.stringify({
    reason: result.reason,
    detail: result.detail ?? null,
  }));

  if (result.reason === 'driver_row_missing') {
    console.error(`${logPrefix}_BLOCKED_DRIVER_NOT_FOUND`, JSON.stringify({
      auth_user_id: userId,
      detail: result.detail ?? null,
    }));
  }

  return result;
}

/** Convenience for edges that only have env vars. */
export function createServiceRoleClient(): SupabaseClient {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  return createClient(supabaseUrl, supabaseServiceKey);
}
