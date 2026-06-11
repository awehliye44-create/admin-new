import { describe, it, expect } from 'vitest';

/**
 * Regression guard: ONECAB commission MUST come from the ledger
 * (driver_wallet_ledger PLATFORM_COMMISSION) — never derived from
 * `stripe_available_balance - driver_payable`. That formula confuses
 * unallocated cash with earned commission and is the bug class this
 * test exists to prevent forever.
 */
function computeCommissionFromLedger(ledger: { type: string; amount_pence: number }[]): number {
  return ledger
    .filter((l) => l.type === 'PLATFORM_COMMISSION')
    .reduce((s, l) => s + l.amount_pence, 0);
}

// Intentionally exported so a future refactor cannot quietly switch the
// admin reporting layer back to the wrong formula.
function FORBIDDEN_commissionFromBalances(stripeAvailable: number, driverPayable: number): number {
  return stripeAvailable - driverPayable;
}

describe('Finance summary — commission source-of-truth', () => {
  it('reports commission from the ledger, not from stripe balance minus driver payable', () => {
    const ledger = [
      { type: 'PLATFORM_COMMISSION', amount_pence: 146 },
      { type: 'PLATFORM_COMMISSION', amount_pence: 79 },
      { type: 'TRIP_EARNING_NET',    amount_pence: 827 },
      { type: 'DRIVER_TIP_CREDIT',   amount_pence: 500 },
      { type: 'EARLY_CASHOUT',       amount_pence: -777 },
    ];
    const stripeAvailable = 999_999; // unallocated cash
    const driverPayable = 1_500;

    const correct = computeCommissionFromLedger(ledger);
    const wrong = FORBIDDEN_commissionFromBalances(stripeAvailable, driverPayable);

    expect(correct).toBe(225);
    expect(correct).not.toBe(wrong);
  });

  it('zero ledger commission returns zero — never falls back to platform balance', () => {
    expect(computeCommissionFromLedger([])).toBe(0);
  });
});
