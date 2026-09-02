import { describe, expect, it } from 'vitest';
import {
  MISSED_CANCELLED_PAYMENT_LABELS,
  buildAdminTripPaymentDispositionRead,
  isNoShowFromPaymentDisposition,
  pickPrimaryPaymentSession,
} from '../../../shared/adminTripPaymentDispositionSSOT';
import {
  belongsInMissedCancelled,
  isAdminNoShowTrip,
} from '../adminTripNoShowClassification';

const MK_260824_002_SESSION = {
  id: 'ps-mk-260824-002',
  status: 'captured',
  captured_amount_pence: 400,
  released_amount_pence: 0,
  refunded_amount_pence: 0,
  provider_state: 'completed',
  metadata: { terminal_disposition_reason: 'CUSTOMER_NO_SHOW' },
};

describe('adminTripPaymentDispositionSSOT', () => {
  it('MK-260824-002 trip history disposition: no-show fee captured', () => {
    const trip = {
      trip_code: 'MK-260824-002',
      status: 'no_show',
      financial_outcome: 'NO_SHOW',
      no_show_charge_pence: 400,
    };
    const disposition = buildAdminTripPaymentDispositionRead({
      trip,
      sessions: [MK_260824_002_SESSION],
      surface: 'trip_history',
    });
    expect(disposition.payment_label).toBe('No-show fee captured');
    expect(disposition.amount_pence).toBe(400);
    expect(disposition.is_no_show_outcome).toBe(true);
    expect(isAdminNoShowTrip({ ...trip, payment_disposition: disposition })).toBe(true);
    expect(belongsInMissedCancelled({ ...trip, payment_disposition: disposition })).toBe(false);
  });

  it('excludes cancelled + CUSTOMER_NO_SHOW disposition from Missed & Cancelled', () => {
    const trip = {
      status: 'cancelled',
      financial_outcome: null,
      no_show_charge_pence: 0,
    };
    const disposition = buildAdminTripPaymentDispositionRead({
      trip,
      sessions: [{
        id: 'ps-1',
        status: 'captured',
        captured_amount_pence: 400,
        metadata: { terminal_disposition_reason: 'CUSTOMER_NO_SHOW' },
      }],
      surface: 'missed_cancelled',
    });
    expect(isNoShowFromPaymentDisposition(disposition)).toBe(true);
    expect(belongsInMissedCancelled({ ...trip, payment_disposition: disposition })).toBe(false);
  });

  it('missed cancelled released hold shows Released label', () => {
    const disposition = buildAdminTripPaymentDispositionRead({
      trip: { status: 'customer_cancelled', financial_outcome: null },
      sessions: [{
        id: 'ps-rel',
        status: 'cancelled',
        captured_amount_pence: 0,
        released_amount_pence: 480,
        provider_state: 'released',
      }],
      surface: 'missed_cancelled',
    });
    expect(disposition.payment_label).toBe(MISSED_CANCELLED_PAYMENT_LABELS.RELEASED);
    expect(disposition.amount_pence).toBe(480);
  });

  it('missed cancelled fee capture shows Cancellation fee charged', () => {
    const disposition = buildAdminTripPaymentDispositionRead({
      trip: { status: 'cancelled', financial_outcome: 'LATE_PASSENGER_CANCELLATION' },
      sessions: [{
        id: 'ps-fee',
        status: 'captured',
        captured_amount_pence: 500,
        provider_state: 'completed',
      }],
      surface: 'missed_cancelled',
    });
    expect(disposition.payment_label).toBe(MISSED_CANCELLED_PAYMENT_LABELS.CANCELLATION_FEE_CHARGED);
    expect(disposition.amount_pence).toBe(500);
  });

  it('pickPrimaryPaymentSession prefers captured session', () => {
    const picked = pickPrimaryPaymentSession([
      { id: 'a', captured_amount_pence: 0, released_amount_pence: 100 },
      { id: 'b', captured_amount_pence: 400, released_amount_pence: 0 },
    ]);
    expect(picked?.id).toBe('b');
  });
});
