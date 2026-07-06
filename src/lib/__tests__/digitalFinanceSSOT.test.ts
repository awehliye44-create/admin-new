import { describe, expect, it } from 'vitest';
import { isDigitalPaymentMethod } from '../../../shared/digitalFinanceSSOT';

describe('digitalFinanceSSOT', () => {
  it('treats card and wallet as digital payment methods', () => {
    expect(isDigitalPaymentMethod('card')).toBe(true);
    expect(isDigitalPaymentMethod('wallet')).toBe(true);
    expect(isDigitalPaymentMethod('apple_pay')).toBe(true);
  });
});

