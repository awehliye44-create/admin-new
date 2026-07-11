import { describe, expect, it } from 'vitest';
import { canonicalDriverWalletTxType } from '@/lib/driverWalletTransactionTypes';

describe('canonicalDriverWalletTxType', () => {
  it('maps ledger types to wallet SSOT enums', () => {
    expect(canonicalDriverWalletTxType('TRIP_EARNING_NET')).toBe('TRIP_EARNING');
    expect(canonicalDriverWalletTxType('PLATFORM_COMMISSION')).toBe('PLATFORM_COMMISSION');
    expect(canonicalDriverWalletTxType('CASH_COMMISSION_DEBT')).toBe('PLATFORM_COMMISSION');
    expect(canonicalDriverWalletTxType('BONUS')).toBe('BONUS');
    expect(canonicalDriverWalletTxType('MANUAL_CREDIT')).toBe('MANUAL_CREDIT');
    expect(canonicalDriverWalletTxType('MANUAL_DEBIT')).toBe('MANUAL_DEBIT');
    expect(canonicalDriverWalletTxType('WEEKLY_PAYOUT')).toBe('PAYOUT');
    expect(canonicalDriverWalletTxType('DEBT_RECOVERY')).toBe('DEBT_RECOVERY');
    expect(canonicalDriverWalletTxType('PAYOUT_REVERSAL')).toBe('REVERSAL');
    expect(canonicalDriverWalletTxType('REFUND_DEBIT')).toBe('REFUND');
  });
});
