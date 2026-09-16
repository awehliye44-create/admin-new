import { describe, expect, it } from 'vitest';
import {
  canonicalDriverWalletTxType,
  driverWalletTxTypeLabel,
} from '@/lib/driverWalletTransactionTypes';

describe('canonicalDriverWalletTxType', () => {
  it('maps ledger types to wallet SSOT enums (no PLATFORM_COMMISSION display type)', () => {
    expect(canonicalDriverWalletTxType('TRIP_EARNING_NET')).toBe('TRIP_EARNING');
    expect(canonicalDriverWalletTxType('CASH_COMMISSION_DEBT')).toBe('DEBT_RECOVERY');
    expect(canonicalDriverWalletTxType('BONUS')).toBe('BONUS');
    expect(canonicalDriverWalletTxType('MANUAL_CREDIT')).toBe('MANUAL_CREDIT');
    expect(canonicalDriverWalletTxType('MANUAL_DEBIT')).toBe('MANUAL_DEBIT');
    expect(canonicalDriverWalletTxType('WEEKLY_PAYOUT')).toBe('PAYOUT');
    expect(canonicalDriverWalletTxType('DEBT_RECOVERY')).toBe('DEBT_RECOVERY');
    expect(canonicalDriverWalletTxType('PAYOUT_REVERSAL')).toBe('REVERSAL');
    expect(canonicalDriverWalletTxType('REFUND_DEBIT')).toBe('REFUND');
  });

  it('keeps DRIVER_TIP_CREDIT as its own type (never folds into TRIP_EARNING)', () => {
    expect(canonicalDriverWalletTxType('DRIVER_TIP_CREDIT')).toBe('DRIVER_TIP_CREDIT');
    expect(canonicalDriverWalletTxType('TIP_CREDIT')).toBe('DRIVER_TIP_CREDIT');
    expect(driverWalletTxTypeLabel('DRIVER_TIP_CREDIT')).toBe('Tip');
    expect(driverWalletTxTypeLabel('TRIP_EARNING_NET')).toBe('Trip earning');
  });
});
