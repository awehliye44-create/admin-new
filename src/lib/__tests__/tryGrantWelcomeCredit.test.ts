import { describe, expect, it } from 'vitest';
import { isWelcomeGrantSoftSkipCode } from '@/lib/tryGrantWelcomeCredit';

describe('isWelcomeGrantSoftSkipCode', () => {
  it('treats expected welcome/wallet gates as soft skips', () => {
    expect(isWelcomeGrantSoftSkipCode('WALLET_DISABLED')).toBe(true);
    expect(isWelcomeGrantSoftSkipCode('WELCOME_CREDIT_DISABLED')).toBe(true);
    expect(isWelcomeGrantSoftSkipCode('WELCOME_CREDIT_ALREADY_RECEIVED')).toBe(true);
    expect(isWelcomeGrantSoftSkipCode('WELCOME_CREDIT_MAX_DRIVERS_REACHED')).toBe(true);
    expect(isWelcomeGrantSoftSkipCode('WELCOME_CREDIT_AMOUNT_MISMATCH')).toBe(true);
    expect(isWelcomeGrantSoftSkipCode('DRIVER_NOT_IN_SERVICE_AREA')).toBe(true);
  });

  it('does not soft-skip unexpected failures', () => {
    expect(isWelcomeGrantSoftSkipCode('CLAIM_WRITE_FAILED')).toBe(false);
    expect(isWelcomeGrantSoftSkipCode('AUDIT_WRITE_FAILED')).toBe(false);
    expect(isWelcomeGrantSoftSkipCode(undefined)).toBe(false);
  });
});
