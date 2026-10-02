/**
 * Payment Sessions operational chips — actionable rows only (not historical queue noise).
 * Used for chip counts, chip filters, and backend summary KPIs.
 */
import type { AdminPaymentSessionsListRow } from './adminPaymentSessionsSSOT.ts';
import {
  isProviderAuthorisedState,
  isProviderCapturedState,
  isProviderRefundedState,
  isProviderReleasedState,
} from './paymentSessionsDisplaySSOT.ts';

/** Terminal trips where an authorised hold should be released (not live en-route). */
export const PAYMENT_SESSIONS_TERMINAL_TRIP_STATUSES = new Set([
  'cancelled',
  'customer_cancelled',
  'driver_cancelled',
  'expired',
  'expired_no_driver',
  'no_show',
  'failed',
  'declined',
  'abandoned',
  'rejected',
  'completed',
]);

/** Provider fee async window before terminal capture fee counts as manual recovery. */
export const PAYMENT_SESSIONS_FEE_ASYNC_WINDOW_MINUTES = 24 * 60;

/** Unverified holds older than this are historical — not active release work. */
export const PAYMENT_SESSIONS_STALE_HOLD_AGE_MINUTES = 14 * 24 * 60;

const RESOLVED_ATTENTION = new Set([
  'CAPTURED',
  'REFUNDED',
  'RESOLVED_PROVIDER_CANCELLED',
  'RESOLVED_PROVIDER_REVERTED',
  'RESOLVED_COMPANION_SESSION',
  'LEGACY_EVIDENCE',
]);

const AUTO_RECOVERY_ATTENTION = new Set([
  'RECOVERY_PENDING',
]);

function upper(v: unknown): string {
  return String(v ?? '').trim().toUpperCase();
}

function lower(v: unknown): string {
  return String(v ?? '').trim().toLowerCase();
}

function nonZeroPence(v: number | null | undefined): boolean {
  return v != null && Number.isFinite(Number(v)) && Number(v) > 0;
}

export function isPaymentSessionsActiveQueueRow(
  row: Pick<AdminPaymentSessionsListRow, 'in_active_queue'>,
): boolean {
  return row.in_active_queue === true;
}

export function isPaymentSessionsTestOrSandboxRow(
  row: Pick<AdminPaymentSessionsListRow, 'purpose'>,
): boolean {
  const purpose = lower(row.purpose);
  return purpose === 'legacy_evidence' || purpose === 'save_card';
}

export function isPaymentSessionsTerminalTripStatus(tripStatus: string | null | undefined): boolean {
  return PAYMENT_SESSIONS_TERMINAL_TRIP_STATUSES.has(lower(tripStatus));
}

export function hasActiveProviderAuthorisationHold(
  row: Pick<
    AdminPaymentSessionsListRow,
    | 'provider_state'
    | 'authorised_amount_pence'
    | 'captured_at'
    | 'captured_amount_pence'
    | 'released_at'
    | 'released_amount_pence'
    | 'refunded_at'
    | 'refunded_amount_pence'
  >,
): boolean {
  if (!nonZeroPence(row.authorised_amount_pence)) return false;
  if (row.captured_at || nonZeroPence(row.captured_amount_pence)) return false;
  if (row.released_at || nonZeroPence(row.released_amount_pence)) return false;
  if (row.refunded_at || nonZeroPence(row.refunded_amount_pence)) return false;

  const provider = upper(row.provider_state);
  if (isProviderCapturedState(provider) || isProviderReleasedState(provider) || isProviderRefundedState(provider)) {
    return false;
  }
  return isProviderAuthorisedState(provider) || provider === 'PROCESSING';
}

/** Verified current card hold — counts toward Active holds chip only (not revenue). */
export function isVerifiedCurrentActiveHoldRow(
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
  if (!isPaymentSessionsActiveQueueRow(row)) return false;
  if (isPaymentSessionsTestOrSandboxRow(row)) return false;
  if (isPaymentSessionsResolvedMoneyRow(row)) return false;
  if (!nonZeroPence(row.authorised_amount_pence)) return false;
  if (!hasActiveProviderAuthorisationHold(row)) return false;
  if (!isActionableHoldRow(row)) return false;
  return true;
}

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

export function isPaymentSessionsResolvedMoneyRow(
  row: Pick<
    AdminPaymentSessionsListRow,
    | 'session_status_display'
    | 'captured_at'
    | 'captured_amount_pence'
    | 'released_at'
    | 'released_amount_pence'
    | 'refunded_at'
    | 'refunded_amount_pence'
    | 'provider_state'
    | 'attention_class'
  >,
): boolean {
  const display = upper(row.session_status_display);
  if (
    display === 'CAPTURED'
    || display === 'RELEASED'
    || display === 'CANCELLED'
    || display === 'REFUNDED'
    || display === 'PARTIALLY_REFUNDED'
  ) {
    return true;
  }
  if (row.captured_at || nonZeroPence(row.captured_amount_pence)) return true;
  if (row.released_at || nonZeroPence(row.released_amount_pence)) return true;
  if (row.refunded_at || nonZeroPence(row.refunded_amount_pence)) return true;
  if (isProviderCapturedState(row.provider_state) || isProviderReleasedState(row.provider_state)) return true;
  if (isProviderRefundedState(row.provider_state)) return true;
  if (RESOLVED_ATTENTION.has(upper(row.attention_class))) return true;
  return false;
}

function isWithinActionableWindow(ageMinutes: number): boolean {
  return ageMinutes <= PAYMENT_SESSIONS_STALE_HOLD_AGE_MINUTES;
}

function isActionableHoldRow(
  row: Pick<
    AdminPaymentSessionsListRow,
    | 'age_minutes'
    | 'provider_verification_status'
    | 'attention_class'
    | 'in_active_queue'
    | 'trip_status'
    | 'hold_release_state'
    | 'provider_state'
    | 'authorised_amount_pence'
    | 'captured_at'
    | 'captured_amount_pence'
    | 'released_at'
    | 'released_amount_pence'
    | 'refunded_at'
    | 'refunded_amount_pence'
  >,
): boolean {
  if (!isPaymentSessionsActiveQueueRow(row)) return false;
  const age = Number(row.age_minutes ?? 0);
  if (row.provider_verification_status === 'STALE') return false;
  if (row.provider_verification_status === 'UNAVAILABLE') return false;
  if (!isWithinActionableWindow(age)) return false;
  if (row.provider_verification_status === 'VERIFIED') {
    return hasActiveProviderAuthorisationHold(row);
  }
  if (upper(row.attention_class) === 'RELEASE_PENDING' || lower(row.hold_release_state) === 'release_pending') {
    return true;
  }
  if (isPaymentSessionsTerminalTripStatus(row.trip_status)) {
    return true;
  }
  return hasActiveProviderAuthorisationHold(row);
}

function isActionableRecoveryRow(
  row: Pick<
    AdminPaymentSessionsListRow,
    | 'age_minutes'
    | 'provider_verification_status'
    | 'in_active_queue'
  >,
): boolean {
  if (!isPaymentSessionsActiveQueueRow(row)) return false;
  if (row.provider_verification_status === 'STALE') return false;
  return isWithinActionableWindow(Number(row.age_minutes ?? 0));
}

function isReleaseExplicitlyDue(
  row: Pick<
    AdminPaymentSessionsListRow,
    | 'attention_class'
    | 'hold_release_state'
    | 'trip_status'
    | 'provider_state'
    | 'authorised_amount_pence'
    | 'captured_at'
    | 'captured_amount_pence'
    | 'released_at'
    | 'released_amount_pence'
    | 'refunded_at'
    | 'refunded_amount_pence'
  >,
): boolean {
  if (upper(row.attention_class) === 'RELEASE_PENDING') return true;
  if (lower(row.hold_release_state) === 'release_pending') return true;
  if (upper(row.attention_class) === 'ACTIVE_AUTHORISED_HOLD' && isPaymentSessionsTerminalTripStatus(row.trip_status)) {
    return hasActiveProviderAuthorisationHold(row);
  }
  if (isPaymentSessionsTerminalTripStatus(row.trip_status) && hasActiveProviderAuthorisationHold(row)) {
    return true;
  }
  return false;
}

/** Live authorised holds that need release now — active queue only, never history. */
export function rowNeedsActiveReleaseNow(row: AdminPaymentSessionsListRow): boolean {
  if (!isPaymentSessionsActiveQueueRow(row)) return false;
  if (isPaymentSessionsTestOrSandboxRow(row)) return false;
  if (isPaymentSessionsResolvedMoneyRow(row)) return false;
  if (!hasActiveProviderAuthorisationHold(row)) return false;
  if (upper(row.attention_class) === 'OK_ACTIVE_TRIP') return false;
  if (AUTO_RECOVERY_ATTENTION.has(upper(row.attention_class))) return false;
  if (RESOLVED_ATTENTION.has(upper(row.attention_class))) return false;
  if (!isReleaseExplicitlyDue(row)) return false;
  if (!isActionableHoldRow(row)) return false;
  return true;
}

function isTerminalCapturedFeePendingManual(row: AdminPaymentSessionsListRow): boolean {
  if (!nonZeroPence(row.captured_amount_pence)) return false;
  if (!isPaymentSessionsTerminalTripStatus(row.trip_status)) return false;
  const feePending = upper(row.fee_status) === 'PENDING'
    || row.fee_display_badge === 'PENDING'
    || row.evidence_status === 'PENDING_PROVIDER_FEE';
  if (!feePending) return false;
  return Number(row.age_minutes ?? 0) > PAYMENT_SESSIONS_FEE_ASYNC_WINDOW_MINUTES;
}

function isCaptureFailedOperationalRow(row: AdminPaymentSessionsListRow): boolean {
  if (isPaymentSessionsResolvedMoneyRow(row) && nonZeroPence(row.captured_amount_pence)) return false;
  const display = upper(row.session_status_display);
  return display === 'CAPTURE_FAILED'
    || display === 'FAILED'
    || String(row.session_status_label ?? '').includes('CAPTURE FAILED')
    || String(row.attention_class ?? '').includes('CAPTURE_FAILED')
    || row.evidence_status === 'CAPTURE_AMOUNT_MISSING';
}

function isReleaseFailedOperationalRow(row: AdminPaymentSessionsListRow): boolean {
  if (!isPaymentSessionsActiveQueueRow(row)) return false;
  if (isPaymentSessionsResolvedMoneyRow(row)) return false;
  if (upper(row.attention_class) === 'RELEASE_FAILED') return true;
  if (lower(row.hold_release_state) === 'release_failed') return true;
  return false;
}

export function rowNeedsReleaseFailedNow(row: AdminPaymentSessionsListRow): boolean {
  return isReleaseFailedOperationalRow(row) && isActionableRecoveryRow(row);
}

function isRefundFailedOperationalRow(row: AdminPaymentSessionsListRow): boolean {
  if (isPaymentSessionsResolvedMoneyRow(row)) return false;
  const display = upper(row.session_status_display);
  return display.includes('REFUND') && display.includes('FAIL');
}

function isManualRecoveryResolutionStatus(row: AdminPaymentSessionsListRow): boolean {
  const status = upper(row.payment_resolution_status);
  return status === 'MANUAL_REQUIRED'
    || status === 'ERROR'
    || status === 'ACTIVE'
    || status === 'MANUAL_RECOVERY';
}

export function rowNeedsManualRecoveryNow(row: AdminPaymentSessionsListRow): boolean {
  if (!isPaymentSessionsActiveQueueRow(row)) return false;
  if (isPaymentSessionsTestOrSandboxRow(row)) return false;
  if (AUTO_RECOVERY_ATTENTION.has(upper(row.attention_class))) return false;
  if (upper(row.attention_class) === 'RELEASE_PENDING') return false;
  if (RESOLVED_ATTENTION.has(upper(row.attention_class)) && !isCaptureFailedOperationalRow(row)) return false;

  if (isReleaseFailedOperationalRow(row)) return isActionableRecoveryRow(row);
  if (isCaptureFailedOperationalRow(row)) return isActionableRecoveryRow(row);
  if (isRefundFailedOperationalRow(row)) return isActionableRecoveryRow(row);

  if (isPaymentSessionsResolvedMoneyRow(row)) {
    if (isTerminalCapturedFeePendingManual(row)) return isActionableRecoveryRow(row);
    return false;
  }

  if (upper(row.attention_class) === 'UNKNOWN_PROVIDER_STATE' && row.classification === 'RED') {
    return hasActiveProviderAuthorisationHold(row) && isActionableHoldRow(row);
  }

  if (
    upper(row.attention_class) === 'ACTIVE_AUTHORISED_HOLD'
    && row.classification === 'RED'
    && Number(row.recovery_attempt_count ?? 0) >= 1
    && hasActiveProviderAuthorisationHold(row)
  ) {
    return isActionableHoldRow(row);
  }

  if (isTerminalCapturedFeePendingManual(row)) return isActionableRecoveryRow(row);

  if (row.recovery_required === true && isManualRecoveryResolutionStatus(row)) {
    return isActionableRecoveryRow(row);
  }

  return false;
}

export type PaymentSessionsOperationalChipAudit = {
  row_id: string;
  payment_session_id: string | null;
  provider_state: string | null;
  authorised_amount_pence: number | null;
  captured_amount_pence: number | null;
  released_amount_pence: number | null;
  refunded_amount_pence: number | null;
  trip_status: string | null;
  age_minutes: number;
  attention_class: string | null;
  in_active_queue: boolean;
  provider_hold_active: boolean;
  actionable_reason: string;
};

export function explainPaymentSessionsOperationalChipRow(
  row: AdminPaymentSessionsListRow,
  chip: 'release_pending' | 'recovery_required',
): PaymentSessionsOperationalChipAudit | null {
  const matches = chip === 'release_pending'
    ? rowNeedsActiveReleaseNow(row)
    : rowNeedsManualRecoveryNow(row);
  if (!matches) return null;

  let actionable_reason: string = chip;
  if (chip === 'release_pending') {
    if (upper(row.attention_class) === 'RELEASE_PENDING') actionable_reason = 'release_pending_attention';
    else if (isPaymentSessionsTerminalTripStatus(row.trip_status)) actionable_reason = 'terminal_trip_active_hold';
    else actionable_reason = 'active_hold_release_due';
  } else {
    if (isReleaseFailedOperationalRow(row)) actionable_reason = 'release_failed';
    else if (isCaptureFailedOperationalRow(row)) actionable_reason = 'capture_failed';
    else if (isRefundFailedOperationalRow(row)) actionable_reason = 'refund_failed';
    else if (upper(row.attention_class) === 'UNKNOWN_PROVIDER_STATE') actionable_reason = 'provider_state_conflict';
    else if (isTerminalCapturedFeePendingManual(row)) actionable_reason = 'terminal_fee_pending_manual';
    else if (row.recovery_required === true) actionable_reason = 'manual_recovery_required';
    else actionable_reason = 'recovery_exhausted_manual';
  }

  return {
    row_id: row.id,
    payment_session_id: row.payment_session_id,
    provider_state: row.provider_state,
    authorised_amount_pence: row.authorised_amount_pence,
    captured_amount_pence: row.captured_amount_pence,
    released_amount_pence: row.released_amount_pence,
    refunded_amount_pence: row.refunded_amount_pence,
    trip_status: row.trip_status,
    age_minutes: row.age_minutes,
    attention_class: row.attention_class,
    in_active_queue: row.in_active_queue === true,
    provider_hold_active: hasActiveProviderAuthorisationHold(row),
    actionable_reason,
  };
}

export function buildPaymentSessionsOperationalChipAudits(
  rows: readonly AdminPaymentSessionsListRow[],
): {
  release_pending: PaymentSessionsOperationalChipAudit[];
  recovery_required: PaymentSessionsOperationalChipAudit[];
} {
  const release_pending: PaymentSessionsOperationalChipAudit[] = [];
  const recovery_required: PaymentSessionsOperationalChipAudit[] = [];
  for (const row of rows) {
    const releaseAudit = explainPaymentSessionsOperationalChipRow(row, 'release_pending');
    if (releaseAudit) release_pending.push(releaseAudit);
    const recoveryAudit = explainPaymentSessionsOperationalChipRow(row, 'recovery_required');
    if (recoveryAudit) recovery_required.push(recoveryAudit);
  }
  return { release_pending, recovery_required };
}
