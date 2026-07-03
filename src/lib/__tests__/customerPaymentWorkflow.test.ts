import { describe, expect, it } from 'vitest';
import {
  catalogMethodsForProvider,
  isCustomerBookingAdapterLive,
  isMobileWalletCollectProvider,
  isStripePreauthProvider,
  normalizeMobileWalletMethods,
  resolveProviderBookingAdapterStatus,
} from '@/lib/customerPaymentWorkflow';

describe('admin customerPaymentWorkflow', () => {
  it('identifies Stripe vs mobile wallet gateways', () => {
    expect(isStripePreauthProvider('stripe')).toBe(true);
    expect(isMobileWalletCollectProvider('sifalo_pay')).toBe(true);
    expect(isMobileWalletCollectProvider('intasend')).toBe(true);
  });

  it('exposes Mogadishu Sifalo catalog', () => {
    expect(catalogMethodsForProvider('sifalo_pay')).toContain('evc_plus');
    expect(catalogMethodsForProvider('sifalo_pay')).toContain('zaad');
    expect(catalogMethodsForProvider('sifalo_pay')).toContain('premier_bank');
  });

  it('exposes Nairobi IntaSend M-Pesa catalog', () => {
    expect(catalogMethodsForProvider('intasend')).toEqual(['mpesa']);
  });

  it('flags non-Stripe ready providers as not_implemented', () => {
    expect(isCustomerBookingAdapterLive('sifalo_pay')).toBe(false);
    expect(resolveProviderBookingAdapterStatus('sifalo_pay', true)).toBe('not_implemented');
    expect(resolveProviderBookingAdapterStatus('stripe', true)).toBe('live');
  });

  it('respects mobile wallet allowlist', () => {
    expect(normalizeMobileWalletMethods('sifalo_pay', ['evc_plus', 'zaad'])).toEqual([
      'evc_plus',
      'zaad',
    ]);
  });
});
