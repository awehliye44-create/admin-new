/** Admin presentation-only helpers; not part of Edge uploads. */
/**
 * Payment Sessions operational chips — actionable rows only (not historical queue noise).
 * Used for chip counts, chip filters, and backend summary KPIs.
 */
import type { AdminPaymentSessionsListRow } from '../../supabase/functions/_shared/adminPaymentSessionsSSOT.ts';

import {
  isProviderAuthorisedState,
  isProviderCapturedState,
  isProviderRefundedState,
  isProviderReleasedState,
} from '../../supabase/functions/_shared/paymentSessionsDisplaySSOT.ts';
import { isPaymentSessionsTestOrSandboxRow, isPaymentSessionsResolvedMoneyRow, nonZeroPence, isVerifiedCurrentActiveHoldRow, hasActiveProviderAuthorisationHold, upper } from "../../supabase/functions/_shared/paymentSessionsOperationalChipsSSOT.ts";


/** Stale/unverified authorisation — table/history only, never operational chip counts. */
export function isStaleUnverifiedAuthorisationRow(
  row: Pick<
    AdminPaymentSessionsListRow,
    | 'in_active_queue'
    | 'purpose'
    | 'authorised_amount_pence'
    | 'provider_state'
    | 'captured_at'
    | 'captured_amount_pence'
    | 'released_at'
    | 'released_amount_pence'
    | 'refunded_at'
    | 'refunded_amount_pence'
    | 'age_minutes'
    | 'provider_verification_status'
    | 'attention_class'
    | 'session_status_display'
    | 'trip_status'
    | 'hold_release_state'
  >,
): boolean {
  if (isPaymentSessionsTestOrSandboxRow(row)) return false;
  if (isPaymentSessionsResolvedMoneyRow(row)) return false;
  if (!nonZeroPence(row.authorised_amount_pence)) return false;
  if (isVerifiedCurrentActiveHoldRow(row)) return false;
  if (hasActiveProviderAuthorisationHold(row)) return true;
  if (isProviderAuthorisedState(row.provider_state)) return true;
  const display = upper(row.session_status_display);
  if (display === 'AUTHORISED' || display === 'CAPTURE_PENDING') return true;
  return false;
}

export * from "../../supabase/functions/_shared/paymentSessionsOperationalChipsSSOT.ts";
