/**
 * Reads the real result of admin-scheduled-ride-action. The function answers blocked
 * actions with a non-2xx status and a JSON body ({ error, code?, message? }); the
 * Supabase client hides that body behind a generic "non-2xx status code" error, so it
 * is read back from the HTTP response here.
 */
import { FunctionsHttpError } from '@supabase/supabase-js';

export type AdminScheduledRideActionResult = {
  success: boolean;
  /** Machine code (e.g. PAYMENT_GATE_NOT_SATISFIED, ACTION_PERMISSION_DENIED) or backend error text. */
  error?: string;
  message?: string;
};

type Body = { success?: unknown; error?: unknown; code?: unknown; message?: unknown };

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;

function fromBody(body: Body | null | undefined, fallback: string): AdminScheduledRideActionResult {
  if (body && body.success === true) return { success: true };
  return {
    success: false,
    // `code` carries the machine code when `error` is human text (permission/auth gates).
    error: str(body?.code) ?? str(body?.error) ?? fallback,
    message: str(body?.message),
  };
}

async function readHttpBody(error: FunctionsHttpError): Promise<{ body: Body | null; status: number | null }> {
  const ctx = error.context as (Response & { clone?: () => Response }) | undefined;
  const status = typeof ctx?.status === 'number' ? ctx.status : null;
  if (!ctx || typeof ctx.json !== 'function') return { body: null, status };
  try {
    return { body: (await (ctx.clone?.() ?? ctx).json()) as Body, status };
  } catch {
    return { body: null, status };
  }
}

export async function toAdminScheduledRideActionResult(
  data: unknown,
  error: unknown,
): Promise<AdminScheduledRideActionResult> {
  if (error instanceof FunctionsHttpError) {
    const { body, status } = await readHttpBody(error);
    return fromBody(body, status != null ? `Request rejected (HTTP ${status})` : 'action_failed');
  }
  if (error) {
    return { success: false, error: (error as Error).message || 'Could not reach the scheduled rides service' };
  }
  return fromBody((data ?? null) as Body | null, 'action_failed');
}
