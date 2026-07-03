import { describe, expect, it } from 'vitest';
import { formatMoneyMinor, getCurrencyMinorUnit } from '@/lib/formatMoneyMinor';

describe('formatMoneyMinor', () => {
  it('formats GBP with 2 minor units', () => {
    expect(formatMoneyMinor(2130, 'GBP')).toBe('£21.30');
  });

  it('formats GHS with GH₵ symbol', () => {
    expect(formatMoneyMinor(2130, 'GHS')).toBe('GH₵21.30');
  });

  it('formats KES', () => {
    expect(formatMoneyMinor(2130, 'KES')).toBe('KSh21.30');
  });

  it('formats UGX with zero minor units', () => {
    expect(getCurrencyMinorUnit('UGX')).toBe(0);
    expect(formatMoneyMinor(2130, 'UGX')).toBe('USh2,130');
  });

  it('formats ETB', () => {
    expect(formatMoneyMinor(2130, 'ETB')).toBe('Br21.30');
  });

  it('returns em dash without currency code', () => {
    expect(formatMoneyMinor(100, '')).toBe('—');
  });
});
