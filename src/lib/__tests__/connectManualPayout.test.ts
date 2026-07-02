import { describe, expect, it } from 'vitest';
import {
  computeMaxManualConnectPayoutPence,
  evaluateConnectManualPayoutGate,
} from '../../../supabase/functions/_shared/connectManualPayout.ts';

const baseInput = {
  wallet_balance_pence: 973,
  driver_available_now_pence: 45,
  connect_available_pence: 1449,
  connect_instant_available_pence: 45,
  payouts_enabled: true,
  charges_enabled: true,
  stripe_account_id: 'acct_test',
  account_restricted: false,
  payout_blocked: false,
  reconciliation_status: 'BALANCED',
  outstanding_debt_pence: 0,
};

describe('connectManualPayout', () => {
  it('max manual payout is min of finance-cleared available now and instant available (not wallet)', () => {
    expect(computeMaxManualConnectPayoutPence(baseInput)).toBe(45);
    expect(computeMaxManualConnectPayoutPence({
      ...baseInput,
      wallet_balance_pence: 50_000,
      driver_available_now_pence: 500,
      connect_instant_available_pence: 300,
    })).toBe(300);
  });

  it('blocks when wallet <= 0', () => {
    const gate = evaluateConnectManualPayoutGate({
      ...baseInput,
      wallet_balance_pence: 0,
    });
    expect(gate.allowed).toBe(false);
    expect(gate.block_reasons.some((r) => r.includes('wallet'))).toBe(true);
  });

  it('blocks when instant available <= 0', () => {
    const gate = evaluateConnectManualPayoutGate({
      ...baseInput,
      connect_instant_available_pence: 0,
    });
    expect(gate.allowed).toBe(false);
  });

  it('blocks when payouts disabled', () => {
    const gate = evaluateConnectManualPayoutGate({
      ...baseInput,
      payouts_enabled: false,
    });
    expect(gate.allowed).toBe(false);
  });

  it('blocks when reconciliation mismatch', () => {
    const gate = evaluateConnectManualPayoutGate({
      ...baseInput,
      reconciliation_status: 'RECONCILIATION_MISMATCH',
    });
    expect(gate.allowed).toBe(false);
  });

  it('allows when all gates pass', () => {
    const gate = evaluateConnectManualPayoutGate(baseInput);
    expect(gate.allowed).toBe(true);
    expect(gate.max_manual_payout_pence).toBe(45);
  });
});
