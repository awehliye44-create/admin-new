import { describe, expect, it } from 'vitest';
import {
  isDigitalPaymentMethod,
  shouldShowDigitalCaptureShortfall,
} from '../../../shared/digitalFinanceSSOT';

describe('digitalFinanceSSOT', () => {
  it('treats card and wallet as digital payment methods', () => {
    expect(isDigitalPaymentMethod('card')).toBe(true);
    expect(isDigitalPaymentMethod('wallet')).toBe(true);
    expect(isDigitalPaymentMethod('apple_pay')).toBe(true);
  });

  it('shows capture shortfall when payable exceeds captured', () => {
    expect(shouldShowDigitalCaptureShortfall('card', 850, 500)).toBe(true);
    expect(shouldShowDigitalCaptureShortfall('card', 850, 850)).toBe(false);
    expect(shouldShowDigitalCaptureShortfall('card', 0, 0)).toBe(false);
  });
});
