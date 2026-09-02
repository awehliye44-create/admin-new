import { describe, expect, it } from 'vitest';
import { resolveTripHistoryTerminalOutcomeDisplay } from '../../../shared/tripHistoryTerminalOutcomeDisplaySSOT';

/** MK-260808-046 shape — stale ride commission must not surface in terminal panel. */
const MK_260808_046 = {
  trip_code: 'MK-260808-046',
  status: 'no_show',
  financial_outcome: 'NO_SHOW',
  no_show_charge_pence: 400,
  capture_amount_pence: 400,
  provider_fee_pence: 24,
  commission_pence: 75,
  driver_net_pence: 425,
  commissionable_fare_pence: 500,
  accepted_preset_offer_fare_pence: 500,
  payment_disposition: {
    payment_session_id: 'ps-1',
    captured_amount_pence: 400,
    released_amount_pence: null,
    refunded_amount_pence: 0,
    provider_processing_fee_pence: 24,
    fee_status: 'ACTUAL',
    provider_state: 'COMPLETED',
    payment_status: 'completed',
    payment_label: 'Captured',
    amount_label: null,
    amount_pence: 400,
    financial_model: 'PLATFORM_COLLECTED',
    terminal_disposition_reason: 'CUSTOMER_NO_SHOW',
    is_no_show_outcome: true,
  },
};

describe('tripHistoryTerminalOutcomeDisplaySSOT', () => {
  it('MK-260808-046: fee-based terminal settlement only — commission £0, entitlement £3.76', () => {
    const display = resolveTripHistoryTerminalOutcomeDisplay(MK_260808_046);
    expect(display).not.toBeNull();
    expect(display?.customer_charge_pence).toBe(400);
    expect(display?.provider_fee_pence).toBe(24);
    expect(display?.driver_entitlement_pence).toBe(376);
    expect(display?.onecab_commission_pence).toBe(0);
    expect(display?.hide_normal_settlement).toBe(true);
    expect(display?.customer_charge_label).toBe('No-show fee captured');
    expect(display?.original_quote_pence).toBe(500);
    expect(display?.entitlement_pending).toBe(false);
  });

  it('hides normal settlement — stale commission/driver net ignored by display SSOT', () => {
    const display = resolveTripHistoryTerminalOutcomeDisplay(MK_260808_046);
    expect(display?.onecab_commission_pence).not.toBe(75);
    expect(display?.driver_entitlement_pence).not.toBe(425);
  });

  it('pending provider fee → entitlement pending message', () => {
    const display = resolveTripHistoryTerminalOutcomeDisplay({
      ...MK_260808_046,
      provider_fee_pence: null,
      payment_disposition: {
        ...MK_260808_046.payment_disposition,
        provider_processing_fee_pence: null,
        fee_status: 'PENDING',
      },
    });
    expect(display?.entitlement_pending).toBe(true);
    expect(display?.driver_entitlement_pence).toBeNull();
    expect(display?.entitlement_pending_message).toMatch(/provider fee/i);
  });

  it('charged cancellation uses cancellation fee label', () => {
    const display = resolveTripHistoryTerminalOutcomeDisplay({
      status: 'cancelled',
      financial_outcome: 'LATE_PASSENGER_CANCELLATION',
      cancellation_fee_pence: 350,
      capture_amount_pence: 350,
      provider_fee_pence: 21,
      payment_disposition: {
        payment_session_id: 'ps-2',
        captured_amount_pence: 350,
        released_amount_pence: null,
        refunded_amount_pence: 0,
        provider_processing_fee_pence: 21,
        fee_status: 'ACTUAL',
        provider_state: 'COMPLETED',
        payment_status: 'completed',
        payment_label: 'Captured',
        amount_label: null,
        amount_pence: 350,
        financial_model: 'PLATFORM_COLLECTED',
        terminal_disposition_reason: 'LATE_PASSENGER_CANCELLATION',
        is_no_show_outcome: false,
      },
    });
    expect(display?.outcome_kind).toBe('LATE_PASSENGER_CANCELLATION');
    expect(display?.customer_charge_label).toBe('Cancellation fee charged');
    expect(display?.onecab_commission_pence).toBe(0);
    expect(display?.driver_entitlement_pence).toBe(329);
  });

  it('returns null for normal completed ride', () => {
    expect(resolveTripHistoryTerminalOutcomeDisplay({
      status: 'completed',
      financial_outcome: 'COMPLETED',
      final_customer_fare_pence: 595,
      capture_amount_pence: 595,
      commission_pence: 89,
      driver_net_pence: 506,
    })).toBeNull();
  });
});
