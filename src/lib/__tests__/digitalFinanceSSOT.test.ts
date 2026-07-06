import { describe, expect, it } from 'vitest';
import {
  HISTORICAL_LEGACY_TRIP_LABEL,
  historicalLegacyTripPaymentLabel,
  isDigitalPaymentMethod,
  isHistoricalLegacyCashTrip,
  shouldShowDigitalCaptureShortfall,
} from '../../../shared/digitalFinanceSSOT';

describe('digitalFinanceSSOT', () => {
  it('flags historical legacy cash trips', () => {
    expect(isHistoricalLegacyCashTrip('cash')).toBe(true);
    expect(isHistoricalLegacyCashTrip('CASH')).toBe(true);
    expect(historicalLegacyTripPaymentLabel('cash')).toBe(HISTORICAL_LEGACY_TRIP_LABEL);
  });

  it('treats card and wallet as digital payment methods', () => {
    expect(isDigitalPaymentMethod('card')).toBe(true);
    expect(isDigitalPaymentMethod('wallet')).toBe(true);
    expect(isDigitalPaymentMethod('cash')).toBe(false);
  });

  it('never shows capture shortfall on legacy cash trips', () => {
    expect(shouldShowDigitalCaptureShortfall('cash', 850, 0)).toBe(false);
    expect(shouldShowDigitalCaptureShortfall('card', 850, 500)).toBe(true);
    expect(shouldShowDigitalCaptureShortfall('card', 850, 850)).toBe(false);
  });
});
