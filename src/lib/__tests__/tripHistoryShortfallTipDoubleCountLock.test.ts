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
      customer_payable_pence: 600,
      providerSettlementVerified: true,
      adminPermitted: true,
      tripStatus: 'completed',
    });
    expect(model.customer_discounted_payable_pence).toBe(600);
    expect(model.verified_captured_pence).toBe(600);
    expect(model.outstanding_shortfall_pence).toBe(0);
    expect(model.recapture_eligible).toBe(false);
  });

  it('authoritative aggregate path never adds tip again', () => {
    const model = buildTripHistoryPaymentEvidenceReadModel({
      trip: {
        ...mkTrip,
        final_customer_fare_pence: 500,
        tip_pence: 100,
      },
      sessions: [{
        status: 'completed',
        provider_state: 'COMPLETED',
        captured_amount_pence: 600,
      }],
      customer_payable_pence: 600,
      providerSettlementVerified: true,
      adminPermitted: true,
    });
    expect(model.customer_discounted_payable_pence).toBe(600);
    expect(model.outstanding_shortfall_pence).toBe(0);
    expect(model.payable_source).toContain('authoritative_customer_payable');
  });

  it('unknown fold semantics fail closed — no false shortfall button', () => {
    const model = buildTripHistoryPaymentEvidenceReadModel({
      trip: {
        ...mkTrip,
        final_customer_fare_pence: 600,
      },
      sessions: [{
        status: 'completed',
        provider_state: 'COMPLETED',
        captured_amount_pence: 600,
      }],
      fare_field_contract: 'unknown',
      providerSettlementVerified: true,
      adminPermitted: true,
    });
    expect(model.customer_discounted_payable_pence).toBe(0);
    expect(model.outstanding_shortfall_pence).toBe(0);
    expect(model.recapture_eligible).toBe(false);
    expect(model.evidence_complete).toBe(false);
  });

  it('ShortfallAction must not overwrite final_customer_fare with Edge payable', () => {
    const src = readFileSync(
      resolve(__dirname, '../../components/trips/TripHistoryShortfallRecaptureAction.tsx'),
      'utf8',
    );
    expect(src).toContain('customer_payable_pence');
    expect(src).not.toMatch(/final_customer_fare_pence:\s*payable\s*>\s*0\s*\?\s*payable/);
  });

  it('Unavailable for missing refund / wallet — never invent £0', () => {
    expect(formatStoredPenceOrUnavailable(null, 'GBP', 'not loaded')).toContain(
      ADMIN_FARE_COMPONENT_UNAVAILABLE,
    );
    expect(formatStoredPenceOrUnavailable(0, 'GBP')).toMatch(/£0\.00|0\.00/);
  });
});
