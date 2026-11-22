/**
 * #75A — Payment Sessions residual release SSOT locks.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  classifyPostCaptureResidualReleaseEvidence,
  expectedReleasePence,
  RELEASE_EVIDENCE_STATUS,
} from '../../../shared/paymentSessionReleaseEvidenceSSOT';
import {
  expectedResidualReleasePenceForRow,
  formatReleasedAmountDisplay,
  sumExpectedResidualReleasePence,
  sumReleasedBufferTotalPence,
} from '../../../shared/paymentSessionsDisplaySSOT';
import { classifyReleaseReconciliation } from '../../../shared/frTripAuditComparisonSSOT';
import {
  isEligibleHistoricalReleaseEvidenceSession,
  wouldDowngradeReleaseEvidence,
} from '../../../shared/historicalReleaseEvidenceBackfillSSOT';
import { moneyAggregateUnsupportedReason } from '../../../supabase/functions/admin-payment-sessions/lib/adminPaymentSessionsMoneyAggregatesSSOT';

const fmt = (p: number | null) => (p == null ? '—' : `£${(p / 100).toFixed(2)}`);

describe('#75A residual release SSOT', () => {
  it('MK-261121-004: £32.67 auth / £30.67 capture → expected 200p, unconfirmed display', () => {
    const expected = expectedReleasePence({
      totalAuthorisedPence: 3267,
      capturedPence: 3067,
    });
    expect(expected).toBe(200);

    const classified = classifyPostCaptureResidualReleaseEvidence({
      authorisedHoldPence: 3267,
      capturedAmountPence: 3067,
      providerPayload: { state: 'COMPLETED', outstanding_amount: 0 },
      retrieveSucceeded: true,
    });
    expect(classified.release_evidence_status).toBe(RELEASE_EVIDENCE_STATUS.AMOUNT_UNCONFIRMED);
    expect(classified.released_amount_pence).toBeNull();
    expect(classified.expected_release_pence).toBe(200);
    expect(classified.set_released_at).toBe(true);

    const display = formatReleasedAmountDisplay({
      released_amount_pence: null,
      released_at: null,
      release_evidence_status: null,
      currencyFormatter: fmt,
      captureConfirmed: true,
      providerState: 'COMPLETED',
      capturedAmountPence: 3067,
      expectedReleasePence: 200,
    });
    expect(display.primary).toBe('£2.00');
    expect(display.secondary).toMatch(/Expected residual|not confirmed/i);
  });

  it('full capture without residual → NOT_REQUIRED / dash', () => {
    const classified = classifyPostCaptureResidualReleaseEvidence({
      authorisedHoldPence: 3067,
      capturedAmountPence: 3067,
      providerPayload: { state: 'COMPLETED' },
      retrieveSucceeded: true,
    });
    expect(classified.release_evidence_status).toBe(RELEASE_EVIDENCE_STATUS.NOT_REQUIRED);
    expect(classified.expected_release_pence).toBe(0);

    const display = formatReleasedAmountDisplay({
      released_amount_pence: null,
      release_evidence_status: 'NOT_REQUIRED',
      currencyFormatter: fmt,
      captureConfirmed: true,
      providerState: 'COMPLETED',
      capturedAmountPence: 3067,
      expectedReleasePence: 0,
    });
    expect(display.primary).toBe('—');
  });

  it('confirmed release amount displays as confirmed money', () => {
    const display = formatReleasedAmountDisplay({
      released_amount_pence: 200,
      release_evidence_status: 'CONFIRMED',
      currencyFormatter: fmt,
      captureConfirmed: true,
      providerState: 'COMPLETED',
      capturedAmountPence: 3067,
      expectedReleasePence: 200,
    });
    expect(display.primary).toBe('£2.00');
    expect(display.secondary).toBeNull();
  });

  it('FR: terminal COMPLETED residual without evidence → RELEASE_AMOUNT_UNCONFIRMED not MISSING_RELEASE', () => {
    expect(
      classifyReleaseReconciliation({
        authorised_pence: 3267,
        captured_pence: 3067,
        released_pence: null,
        release_evidence_status: null,
        provider_state: 'COMPLETED',
      }),
    ).toBe('RELEASE_AMOUNT_UNCONFIRMED');

    expect(
      classifyReleaseReconciliation({
        authorised_pence: 3267,
        captured_pence: 3067,
        released_pence: null,
        release_evidence_status: null,
        provider_state: 'AUTHORISED',
      }),
    ).toBe('RELEASE_PENDING');
  });

  it('expected residual sum is distinct from confirmed released buffer', () => {
    const rows = [
      {
        authorised_amount_pence: 3267,
        captured_amount_pence: 3067,
        released_amount_pence: null,
        provider_state: 'COMPLETED',
      },
      {
        authorised_amount_pence: 800,
        captured_amount_pence: 500,
        released_amount_pence: 300,
        provider_state: 'COMPLETED',
      },
    ];
    expect(sumExpectedResidualReleasePence(rows)).toBe(200 + 300);
    expect(sumReleasedBufferTotalPence(rows)).toBe(300);
    expect(
      expectedResidualReleasePenceForRow({
        authorised_amount_pence: 3267,
        captured_amount_pence: 3067,
      }),
    ).toBe(200);
  });

  it('historical eligibility + never downgrade CONFIRMED', () => {
    expect(
      isEligibleHistoricalReleaseEvidenceSession({
        id: 'd93a5d2d-2dba-4641-bd1d-1088d25888e4',
        trip_id: 't',
        provider_order_id: 'ord',
        payment_provider: 'revolut',
        authorised_amount_pence: 3267,
        captured_amount_pence: 3067,
        released_amount_pence: null,
        release_evidence_status: null,
      }).eligible,
    ).toBe(true);

    expect(
      wouldDowngradeReleaseEvidence({
        existingStatus: 'CONFIRMED',
        existingReleasedAmountPence: 200,
        nextStatus: 'AMOUNT_UNCONFIRMED',
        nextReleasedAmountPence: null,
      }),
    ).toBe(true);
  });

  it('money aggregates: payment_method/purpose supported; active_hold unsupported', () => {
    expect(moneyAggregateUnsupportedReason({ payment_method: 'apple_pay' })).toBeNull();
    expect(moneyAggregateUnsupportedReason({ purpose: 'RIDE_BOOKING' })).toBeNull();
    expect(moneyAggregateUnsupportedReason({ active_hold: true })).toMatch(/Active-hold/);
  });

  it('capture paths call residual evidence; resolutionFields strip released invent', () => {
    const capture = readFileSync(
      resolve(__dirname, '../../../supabase/functions/_shared/revolutCompletionCapture.ts'),
      'utf8',
    );
    expect(capture).toContain('persistPostCaptureResidualReleaseEvidence');
    const residualCalls = capture.split('persistPostCaptureResidualReleaseEvidence({').length - 1;
    expect(residualCalls).toBeGreaterThanOrEqual(4);

    const ssot = readFileSync(
      resolve(__dirname, '../../../supabase/functions/_shared/paymentSessionSSOT.ts'),
      'utf8',
    );
    expect(ssot).toContain('persistCaptureResidualReleaseEvidence');
    expect(ssot).toContain('safePersistCaptureResidualReleaseEvidence');
    expect(ssot).toContain('released_amount_pence: _omitReleased');

    const webhook = readFileSync(
      resolve(__dirname, '../../../supabase/functions/revolut-webhook/index.ts'),
      'utf8',
    );
    expect(webhook).toContain('safePersistCaptureResidualReleaseEvidence');
    expect(webhook).toContain('REVOLUT_WEBHOOK');
  });

  it('Admin UI uses formatReleasedAmountDisplay + Expected residual card', () => {
    const list = readFileSync(
      resolve(__dirname, '../../../src/components/finance/PaymentSessionsListPanel.tsx'),
      'utf8',
    );
    expect(list).toContain('formatReleasedAmountDisplay');
    expect(list).toContain('expectedResidualReleasePenceForRow');

    const cards = readFileSync(
      resolve(__dirname, '../../../src/components/finance/PaymentSessionsSummaryCards.tsx'),
      'utf8',
    );
    expect(cards).toContain('Expected residual');
    expect(cards).toContain('expected_residual_release_total_pence');
    expect(cards).toContain('Released buffer total');
    expect(cards).toContain('money_totals_unavailable_reason');
  });
});
