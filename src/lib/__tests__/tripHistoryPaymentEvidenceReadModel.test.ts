import { describe, expect, it } from 'vitest';
import { buildTripHistoryPaymentEvidenceReadModel } from '../../../shared/tripHistoryPaymentEvidenceReadModel';
import { TRIP_SHORTFALL_RECAPTURE_UI_STATE } from '../../../shared/tripHistoryShortfallRecaptureSSOT';

describe('tripHistoryPaymentEvidenceReadModel', () => {
  it('promoted trip: captured £5.95 vs gross £6.19 — no shortfall, no recapture', () => {
    const model = buildTripHistoryPaymentEvidenceReadModel({
      trip: {
        status: 'completed',
        financial_model: 'PLATFORM_COLLECTED',
        payment_method: 'card',
        final_fare_pence: 619,
        final_customer_fare_pence: 595,
        offer_discount_pence: 24,
        payment_status: 'captured',
      },
      sessions: [{
        status: 'completed',
        provider_state: 'COMPLETED',
        captured_amount_pence: 595,
        authorised_amount_pence: 595,
        refunded_amount_pence: 0,
      }],
      tripStatus: 'completed',
      adminPermitted: true,
    });

    expect(model.customer_discounted_payable_pence).toBe(595);
    expect(model.promotion_discount_pence).toBe(24);
    expect(model.verified_captured_pence).toBe(595);
    expect(model.net_verified_captured_pence).toBe(595);
    expect(model.outstanding_shortfall_pence).toBe(0);
    expect(model.recapture_eligible).toBe(false);
    expect(model.recapture_ui_state).toBe(TRIP_SHORTFALL_RECAPTURE_UI_STATE.FULLY_PAID);
    expect(model.coverage_tone).toBe('fully_paid');
  });

  it('uses disposition session when sessions array omitted', () => {
    const model = buildTripHistoryPaymentEvidenceReadModel({
      trip: {
        status: 'completed',
        financial_model: 'PLATFORM_COLLECTED',
        payment_method: 'card',
        final_fare_pence: 619,
        final_customer_fare_pence: 595,
        offer_discount_pence: 24,
        payment_disposition: {
          payment_session_id: 'ps-1',
          captured_amount_pence: 595,
          released_amount_pence: null,
          refunded_amount_pence: 0,
          provider_state: 'COMPLETED',
          payment_status: 'completed',
          payment_label: 'Captured',
          amount_label: null,
          amount_pence: 595,
          financial_model: 'PLATFORM_COLLECTED',
          terminal_disposition_reason: null,
          is_no_show_outcome: false,
        },
      },
      tripStatus: 'completed',
      adminPermitted: true,
    });

    expect(model.verified_captured_pence).toBe(595);
    expect(model.outstanding_shortfall_pence).toBe(0);
  });

  it('falls back to trip.capture_amount_pence when disposition capture is missing', () => {
    const model = buildTripHistoryPaymentEvidenceReadModel({
      trip: {
        status: 'completed',
        financial_model: 'PLATFORM_COLLECTED',
        payment_method: 'card',
        final_fare_pence: 619,
        final_customer_fare_pence: 595,
        capture_amount_pence: 595,
        offer_discount_pence: 24,
      },
      sessions: [],
      tripStatus: 'completed',
      adminPermitted: true,
    });

    expect(model.verified_captured_pence).toBe(595);
    expect(model.outstanding_shortfall_pence).toBe(0);
    expect(model.recapture_eligible).toBe(false);
  });

  it('real shortfall: payable exceeds verified capture — recapture eligible', () => {
    const model = buildTripHistoryPaymentEvidenceReadModel({
      trip: {
        status: 'completed',
        financial_model: 'PLATFORM_COLLECTED',
        payment_method: 'card',
        final_customer_fare_pence: 793,
        final_fare_pence: 793,
      },
      sessions: [],
      tripStatus: 'completed',
      adminPermitted: true,
    });

    expect(model.outstanding_shortfall_pence).toBe(793);
    expect(model.recapture_eligible).toBe(true);
  });
});
