import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildTripHistoryPaymentEvidenceReadModel } from '../../../shared/tripHistoryPaymentEvidenceReadModel';
import {
  ADMIN_FARE_COMPONENT_UNAVAILABLE,
  formatStoredPenceOrUnavailable,
} from '../adminFareComponentDisplay';

describe('Trip History shortfall tip double-count lock', () => {
  const mkTrip = {
    final_customer_fare_pence: 500,
    final_fare_pence: 500,
    locked_base_fare_pence: 500,
    tip_pence: 100,
    tip_amount_pence: 100,
    financial_model: 'PLATFORM_COLLECTED',
    payment_method: 'card',
    status: 'completed',
    payment_status: 'captured',
  };

  it('MK-260912-005: Edge tip-inclusive payable used authoritatively → shortfall 0', () => {
    const model = buildTripHistoryPaymentEvidenceReadModel({
      trip: mkTrip,
      sessions: [{
        status: 'completed',
        provider_state: 'COMPLETED',
        captured_amount_pence: 600,
        refunded_amount_pence: 0,
      }],
      authoritativeCustomerPayablePence: 600,
      providerSettlementVerified: true,
      adminPermitted: true,
      tripStatus: 'completed',
    });
    expect(model.customer_discounted_payable_pence).toBe(600);
    expect(model.verified_captured_pence).toBe(600);
    expect(model.outstanding_shortfall_pence).toBe(0);
    expect(model.recapture_eligible).toBe(false);
  });

  it('stuffed tip-inclusive final_customer does not become 700', () => {
    const model = buildTripHistoryPaymentEvidenceReadModel({
      trip: {
        ...mkTrip,
        final_customer_fare_pence: 600,
        final_fare_pence: 500,
      },
      sessions: [{
        status: 'completed',
        provider_state: 'COMPLETED',
        captured_amount_pence: 600,
      }],
      providerSettlementVerified: true,
      adminPermitted: true,
    });
    expect(model.customer_discounted_payable_pence).toBe(600);
    expect(model.outstanding_shortfall_pence).toBe(0);
  });

  it('ShortfallAction must not overwrite final_customer_fare with Edge payable', () => {
    const src = readFileSync(
      resolve(__dirname, '../../components/trips/TripHistoryShortfallRecaptureAction.tsx'),
      'utf8',
    );
    expect(src).toContain('authoritativeCustomerPayablePence');
    expect(src).not.toMatch(/final_customer_fare_pence:\s*payable\s*>\s*0\s*\?\s*payable/);
  });

  it('Unavailable for missing refund / wallet — never invent £0', () => {
    expect(formatStoredPenceOrUnavailable(null, 'GBP', 'not loaded')).toContain(
      ADMIN_FARE_COMPONENT_UNAVAILABLE,
    );
    expect(formatStoredPenceOrUnavailable(0, 'GBP')).toMatch(/£0\.00|0\.00/);
  });
});
