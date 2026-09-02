import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type {
  AdminPayoutLedgerListRequest,
  AdminPayoutLedgerListResponse,
} from '../../shared/adminPayoutLedgerSSOT';
import { ADMIN_PAYOUT_LEDGER_FN } from '../../shared/adminPayoutLedgerSSOT';
import { isAdminPageLiveActive } from '@/lib/adminPageVisibility';
import {
  ADMIN_FINANCE_QUERY_DEFAULTS,
  withAdminFinanceQueryTiming,
} from '@/lib/adminFinanceLoadPerf';

const PAYOUT_LEDGER_INVOKE_TIMEOUT_MS = 28_000;

async function invokePayoutLedger(
  request: AdminPayoutLedgerListRequest,
): Promise<{ data: AdminPayoutLedgerListResponse | null; error: Error | null }> {
  try {
    const result = await Promise.race([
      supabase.functions.invoke<AdminPayoutLedgerListResponse>(
        ADMIN_PAYOUT_LEDGER_FN,
        { body: request },
      ),
      new Promise<never>((_, reject) => {
        window.setTimeout(
          () => reject(new Error('Payout ledger request timed out — try narrowing the service area filter.')),
          PAYOUT_LEDGER_INVOKE_TIMEOUT_MS,
        );
      }),
    ]);
    return { data: result.data, error: result.error };
  } catch (err) {
    return {
      data: null,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}

function emptyDegradedLedger(
  request: AdminPayoutLedgerListRequest,
  errorCode: string,
  errorMessage: string,
): AdminPayoutLedgerListResponse {
  return {
    success: true,
    ok: false,
    error: errorMessage,
    error_code: errorCode,
    page_status: 'DEGRADED',
    tab: request.tab ?? 'overview',
    items: [],
    batches: [],
    accounts: [],
    company_transfers: [],
    company_batches: [],
    company_audit_rows: [],
    company_transfers_read_only: true,
    summary: {
      total_items: 0,
      scheduled_count: 0,
      processing_count: 0,
      completed_count: 0,
      failed_count: 0,
      returned_cancelled_count: 0,
      pending_count: 0,
      scheduled_today_count: 0,
      paid_today_count: 0,
      paid_today_pence: null,
      total_paid_pence: null,
      total_failed_pence: null,
      total_paid_week_pence: null,
      total_paid_month_pence: null,
      total_paid_year_pence: null,
    },
  } as AdminPayoutLedgerListResponse;
}

/**
 * Payout Ledger fetch — never throws.
 * Edge/network failures return DEGRADED empty payload so the page stays mounted
 * (avoids blank-screen attribution when admin-payout-ledger is unreachable).
 */
export function useAdminPayoutLedger(
  request: AdminPayoutLedgerListRequest,
  enabled = true,
) {
  const tab = request.tab ?? 'overview';
  return useQuery({
    queryKey: ['admin-payout-ledger', request],
    queryFn: () =>
      withAdminFinanceQueryTiming(
        {
          page: 'payout_ledger',
          tab,
          query_name: request.mode ?? 'list',
          rowCount: (r) =>
            r.items?.length
            ?? r.accounts?.length
            ?? r.batches?.length
            ?? r.audit_rows?.length
            ?? 0,
        },
        async () => {
          try {
            const { data, error } = await invokePayoutLedger(request);
            // Prefer structured body even when FunctionsHttpError wraps a DEGRADED/PARTIAL payload.
            if (data?.success) return data;
            if (data?.overview_summary || data?.company_balance || data?.page_status) {
              return { ...data, success: true } as AdminPayoutLedgerListResponse;
            }
            const msg = error?.message
              || data?.error
              || 'Payout ledger list failed';
            const code = data?.error_code ?? 'PAYOUT_LEDGER_API_UNAVAILABLE';
            return emptyDegradedLedger(request, code, msg);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return emptyDegradedLedger(request, 'PAYOUT_LEDGER_API_UNAVAILABLE', msg);
          }
        },
      ),
    enabled,
    ...ADMIN_FINANCE_QUERY_DEFAULTS,
    placeholderData: keepPreviousData,
    refetchInterval: (query) => {
      if (!isAdminPageLiveActive()) return false;
      if (tab !== 'processing') return false;
      const processing = query.state.data?.summary?.processing_count ?? 0;
      return processing > 0 ? 90_000 : false;
    },
  });
}
