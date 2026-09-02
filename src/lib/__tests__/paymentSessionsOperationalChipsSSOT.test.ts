/**
 * Payment Sessions operational chip predicates — actionable rows only.
 */
import { describe, expect, it } from 'vitest';
import type { AdminPaymentSessionsListRow } from '../../../shared/adminPaymentSessionsSSOT.ts';
import {
  PAYMENT_SESSIONS_STALE_HOLD_AGE_MINUTES,
  isStaleUnverifiedAuthorisationRow,
  isVerifiedCurrentActiveHoldRow,
  rowNeedsActiveReleaseNow,
  rowNeedsManualRecoveryNow,
} from '../../../shared/paymentSessionsOperationalChipsSSOT.ts';

function row(partial: Partial<AdminPaymentSessionsListRow>): AdminPaymentSessionsListRow {
  return {
    id: 'r1',
    source: 'payment_sessions',
    payment_session_id: 'ps-1',
    created_at: '2026-09-01T12:00:00Z',
    payment_provider: 'revolut',
    age_minutes: 60,
    in_active_queue: true,
    provider_verification_status: 'VERIFIED',
    classification: 'AMBER',
    ...partial,
  } as AdminPaymentSessionsListRow;
}

describe('paymentSessionsOperationalChipsSSOT', () => {
  it('excludes live OK_ACTIVE_TRIP from active release chip', () => {
    const live = row({
      attention_class: 'OK_ACTIVE_TRIP',
      trip_status: 'in_progress',
      provider_state: 'AUTHORISED',
      authorised_amount_pence: 500,
      session_status_display: 'AUTHORISED',
    });
    expect(rowNeedsActiveReleaseNow(live)).toBe(false);
  });

  it('includes terminal trip with active provider hold for active release', () => {
    const terminal = row({
      attention_class: 'ACTIVE_AUTHORISED_HOLD',
      trip_status: 'no_show',
      provider_state: 'AUTHORISED',
      authorised_amount_pence: 400,
      captured_amount_pence: null,
      released_amount_pence: null,
      refunded_amount_pence: null,
    });
    expect(rowNeedsActiveReleaseNow(terminal)).toBe(true);
  });

  it('excludes captured rows from active release', () => {
    const captured = row({
      attention_class: 'CAPTURED',
      trip_status: 'completed',
      captured_amount_pence: 500,
      captured_at: '2026-09-01T12:00:00Z',
      provider_state: 'CAPTURED',
    });
    expect(rowNeedsActiveReleaseNow(captured)).toBe(false);
  });

  it('excludes auto RECOVERY_PENDING from manual recovery chip', () => {
    const auto = row({
      attention_class: 'RECOVERY_PENDING',
      classification: 'AMBER',
      provider_state: 'AUTHORISED',
      trip_id: null,
      authorised_amount_pence: 500,
    });
    expect(rowNeedsManualRecoveryNow(auto)).toBe(false);
  });

  it('includes RELEASE_FAILED in manual recovery chip', () => {
    const failed = row({
      attention_class: 'RELEASE_FAILED',
      classification: 'RED',
      hold_release_state: 'release_failed',
      release_failure_reason: 'provider_timeout',
    });
    expect(rowNeedsManualRecoveryNow(failed)).toBe(true);
  });

  it('includes capture failed in manual recovery chip', () => {
    const captureFailed = row({
      session_status_display: 'CAPTURE_FAILED',
      attention_class: 'CAPTURED',
      classification: 'AMBER',
    });
    expect(rowNeedsManualRecoveryNow(captureFailed)).toBe(true);
  });

  it('counts verified current holds with positive authorised amount', () => {
    const liveHold = row({
      attention_class: 'OK_ACTIVE_TRIP',
      trip_status: 'in_progress',
      provider_state: 'AUTHORISED',
      authorised_amount_pence: 500,
      captured_amount_pence: null,
      released_amount_pence: null,
      refunded_amount_pence: null,
      session_status_display: 'AUTHORISED',
    });
    expect(isVerifiedCurrentActiveHoldRow(liveHold)).toBe(true);
    expect(rowNeedsActiveReleaseNow(liveHold)).toBe(false);
  });

  it('excludes historical inactive-queue rows from active release chip', () => {
    const historical = row({
      in_active_queue: false,
      attention_class: 'RELEASE_PENDING',
      trip_status: 'no_show',
      provider_state: 'AUTHORISED',
      authorised_amount_pence: 400,
      captured_amount_pence: null,
      released_amount_pence: null,
      refunded_amount_pence: null,
    });
    expect(rowNeedsActiveReleaseNow(historical)).toBe(false);
  });

  it('excludes resolved released rows from manual recovery chip', () => {
    const released = row({
      in_active_queue: false,
      attention_class: 'RELEASE_FAILED',
      hold_release_state: 'release_failed',
      release_failure_reason: 'provider_timeout',
      released_amount_pence: 400,
      released_at: '2026-09-01T12:00:00Z',
      provider_state: 'RELEASED',
    });
    expect(rowNeedsManualRecoveryNow(released)).toBe(false);
  });

  it('excludes stale unverified authorisations from verified hold chip', () => {
    const stale = row({
      attention_class: 'ACTIVE_AUTHORISED_HOLD',
      trip_status: 'no_show',
      provider_state: 'AUTHORISED',
      authorised_amount_pence: 400,
      captured_amount_pence: null,
      released_amount_pence: null,
      refunded_amount_pence: null,
      age_minutes: PAYMENT_SESSIONS_STALE_HOLD_AGE_MINUTES + 1,
      provider_verification_status: 'STALE',
    });
    expect(isVerifiedCurrentActiveHoldRow(stale)).toBe(false);
    expect(isStaleUnverifiedAuthorisationRow(stale)).toBe(true);
  });
});
