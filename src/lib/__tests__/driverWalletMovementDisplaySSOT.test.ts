import { describe, expect, it } from 'vitest';
import {
  filterDriverWalletMovementRows,
  isDriverWalletMovementLedgerType,
} from '@/lib/driverWalletMovementDisplaySSOT';

describe('driverWalletMovementDisplaySSOT', () => {
  it('excludes PLATFORM_COMMISSION and provider fee rows', () => {
    expect(isDriverWalletMovementLedgerType('PLATFORM_COMMISSION')).toBe(false);
    expect(isDriverWalletMovementLedgerType('PLATFORM_COMMISSION_GROSS')).toBe(false);
    expect(isDriverWalletMovementLedgerType('COMPANY_COMMISSION')).toBe(false);
    expect(isDriverWalletMovementLedgerType('PAYMENT_PROVIDER_FEE')).toBe(false);
  });

  it('keeps driver wallet movements only', () => {
    const rows = [
      { type: 'TRIP_EARNING_NET', id: '1' },
      { type: 'PLATFORM_COMMISSION', id: '2' },
      { type: 'BONUS', id: '3' },
      { type: 'DEBT_RECOVERY', id: '4' },
      { type: 'WEEKLY_PAYOUT', id: '5' },
      { type: 'MANUAL_CREDIT', id: '6' },
      { type: 'MANUAL_DEBIT', id: '7' },
      { type: 'REFUND_DEBIT', id: '8' },
      { type: 'ADJUSTMENT', id: '9' },
      { type: 'CASH_COMMISSION_DEBT', id: '10' },
      { type: 'PAYMENT_PROVIDER_FEE', id: '11' },
    ];
    const kept = filterDriverWalletMovementRows(rows).map((r) => r.id);
    expect(kept).toEqual(['1', '3', '4', '5', '6', '7', '8', '9', '10']);
  });
});
