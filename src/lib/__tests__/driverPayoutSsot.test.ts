import { describe, expect, it } from 'vitest';
import {
  computeConnectAwaitingSettlementPence,
  computeDriverCashoutExecutablePence,
  formatAdminDriverPayoutSsotSummary,
} from '../driverPayoutSsot';

describe('driverPayoutSsot', () => {
  it('MK0001: wallet £9.73, Connect £21.30 → cash out £9.73, awaiting £0', () => {
    const ledger = 973;
    const finance = 973;
    const connect = 2130;

    expect(computeDriverCashoutExecutablePence(ledger, finance, connect)).toBe(973);
    expect(computeConnectAwaitingSettlementPence(ledger, connect)).toBe(0);
  });

  it('awaiting settlement when ledger exceeds Connect', () => {
    expect(computeConnectAwaitingSettlementPence(1000, 350)).toBe(650);
    expect(computeDriverCashoutExecutablePence(1000, 1000, 350)).toBe(350);
  });

  it('formats admin summary copy', () => {
    expect(
      formatAdminDriverPayoutSsotSummary({
        walletOwedPence: 973,
        connectAvailablePence: 2130,
        cashoutNowPence: 973,
        currencyCode: 'gbp',
      }),
    ).toBe(
      'Driver is owed £9.73. Provider has £21.30 instantly available. Cash-out available now: £9.73.',
    );
  });
});
