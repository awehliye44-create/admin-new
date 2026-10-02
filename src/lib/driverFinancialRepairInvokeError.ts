/**
 * Safe Admin copy for admin-driver-financial-repair failures.
 * Never surface the opaque "Edge Function returned a non-2xx status code", and never
 * render the backend `error` text or `details` verbatim: internal failures carry raw
 * database messages. Copy is chosen by `error_code` only.
 */
import { FunctionsHttpError } from '@supabase/supabase-js';
import {
  DRIVER_FINANCIAL_REPAIR_BLOCK,
  DRIVER_FINANCIAL_REPAIR_COPY,
} from '../../shared/driverFinancialReviewRepairSSOT';

export type DriverFinancialRepairInvokeError = Error & {
  code: string;
  http_status: number | null;
};

const CHECK_HISTORY = 'Check Review & repair history before retrying.';

const SAFE_COPY: Record<string, string> = {
  TRIP_DRIVER_MISMATCH:
    'This trip is not attributed to this driver’s wallet. No change was made.',
  TRIP_NOT_FOUND: 'Trip not found. No change was made.',
  DRIVER_NOT_FOUND: 'Driver not found. No change was made.',
  ADMIN_USER_REQUIRED: 'You do not have permission to review and repair this driver’s wallet.',
  [DRIVER_FINANCIAL_REPAIR_BLOCK.PERMISSION_DENIED]:
    'You do not have permission to review and repair this driver’s wallet.',
  FINANCIAL_MODEL_VIOLATION:
    'Review & repair is only available for platform-collected trips. No change was made.',
  INVALID_INPUT: 'The repair request was invalid. Reload the panel and try again.',
  INVALID_ACTION: 'The repair request was invalid. Reload the panel and try again.',
  FORBIDDEN_FIELD: 'Repair values are calculated by the server and cannot be supplied.',
  [DRIVER_FINANCIAL_REPAIR_BLOCK.ARBITRARY_STAMP_EDIT]:
    'Repair values are calculated by the server and cannot be supplied.',
  [DRIVER_FINANCIAL_REPAIR_BLOCK.REASON_INVALID]: 'Enter a reason between 3 and 500 characters.',
  [DRIVER_FINANCIAL_REPAIR_BLOCK.LOCK_UNAVAILABLE]:
    'Another repair is in progress for this driver. Try again shortly.',
  [DRIVER_FINANCIAL_REPAIR_BLOCK.REPAIR_PREVIEW_STALE]:
    'The trip or wallet changed since this preview. Load a new preview.',
  [DRIVER_FINANCIAL_REPAIR_BLOCK.ALREADY_APPLIED]: 'This repair has already been applied.',
  [DRIVER_FINANCIAL_REPAIR_BLOCK.MONETARY_CONSERVATION_VIOLATION]:
    'Repair blocked: the proposed amounts do not reconcile. No change was made.',
  [DRIVER_FINANCIAL_REPAIR_BLOCK.WALLET_CORRECTION_NOT_CERTIFIED]:
    DRIVER_FINANCIAL_REPAIR_COPY.WALLET_CORRECTION_NOT_CERTIFIED,
  APPLY_PERSIST_FAILED: `The repair could not be recorded. ${CHECK_HISTORY}`,
  STAMP_RESTORE_FAILED: `The trip stamp could not be restored. ${CHECK_HISTORY}`,
  WALLET_CREDIT_FAILED: `The wallet credit could not be posted. ${CHECK_HISTORY}`,
  WALLET_CORRECTION_FAILED: `The wallet correction could not be posted. ${CHECK_HISTORY}`,
  CERT_APPLY_RPC_FAILED: `The certification repair could not be completed. ${CHECK_HISTORY}`,
};

const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

function readCode(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const raw = (payload as Record<string, unknown>).error_code
    ?? (payload as Record<string, unknown>).code;
  const code = typeof raw === 'string' ? raw.trim() : '';
  return SAFE_CODE.test(code) ? code : null;
}

function hasError(payload: unknown): boolean {
  return Boolean(payload && typeof payload === 'object' && (payload as Record<string, unknown>).error);
}

export function driverFinancialRepairErrorMessage(
  code: string | null,
  httpStatus: number | null,
  action: 'preview' | 'apply',
): string {
  if (code && SAFE_COPY[code]) return SAFE_COPY[code];
  const verb = action === 'apply' ? 'Repair' : 'Repair preview';
  if (code) return `${verb} failed (${code}).${action === 'apply' ? ` ${CHECK_HISTORY}` : ''}`;
  if (httpStatus != null && httpStatus >= 500) {
    return `${verb} service is unavailable (HTTP ${httpStatus}).${action === 'apply' ? ` ${CHECK_HISTORY}` : ' Please try again.'}`;
  }
  if (httpStatus != null) return `${verb} request was rejected (HTTP ${httpStatus}).`;
  return `${verb} failed. Please try again.`;
}

async function readHttpPayload(error: FunctionsHttpError): Promise<{ payload: unknown; status: number | null }> {
  const ctx = error.context as (Response & { clone?: () => Response }) | undefined;
  const status = typeof ctx?.status === 'number' ? ctx.status : null;
  if (!ctx || typeof ctx.json !== 'function') return { payload: null, status };
  try {
    return { payload: await (ctx.clone?.() ?? ctx).json(), status };
  } catch {
    return { payload: null, status };
  }
}

/** Returns a safe error when the invoke failed, otherwise null. */
export async function toDriverFinancialRepairInvokeError(
  error: unknown,
  data: unknown,
  action: 'preview' | 'apply',
): Promise<DriverFinancialRepairInvokeError | null> {
  let code: string | null = null;
  let status: number | null = null;

  if (error instanceof FunctionsHttpError) {
    const http = await readHttpPayload(error);
    code = readCode(http.payload);
    status = http.status;
  } else if (error) {
    code = readCode(error);
  } else if (hasError(data)) {
    code = readCode(data);
  } else {
    return null;
  }

  const err = new Error(driverFinancialRepairErrorMessage(code, status, action)) as DriverFinancialRepairInvokeError;
  err.code = code ?? (status != null ? `HTTP_${status}` : 'REPAIR_REQUEST_FAILED');
  err.http_status = status;
  return err;
}
