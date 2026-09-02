import { describe, expect, it } from 'vitest';
import { computeLedgerWalletBalancePence } from '../../../supabase/functions/_shared/onecabFinanceLedger.ts';
import {
  buildDriverWalletManualAdjustmentIdempotencyKey,
  DRIVER_WALLET_ADJUSTMENT_STATUS,
  DRIVER_WALLET_ADMIN_CREDIT_TYPE,
  DRIVER_WALLET_ADMIN_DEBIT_TYPE,
  FINANCE_WALLET_ADJUSTMENT_ROLES,
  driverWalletAdjustmentDriverTitle,
  parseDriverWalletAdminAdjustmentMetadata,
  planDriverWalletManualAdjustment,
  signedAmountPenceForDriverWalletAdjustment,
  validateDriverWalletManualAdjustmentInput,
} from '../../../shared/driverWalletManualAdjustmentSSOT.ts';

describe('driverWalletManualAdjustmentSSOT', () => {
  it('admin credit +500p increases wallet live balance', () => {
    const before = computeLedgerWalletBalancePence([{ type: 'TRIP_EARNING_NET', amount_pence: 1_000 }]);
    const signed = signedAmountPenceForDriverWalletAdjustment('CREDIT', 500);
    expect(signed).toBe(500);
    const after = computeLedgerWalletBalancePence([
      { type: 'TRIP_EARNING_NET', amount_pence: 1_000 },
      { type: DRIVER_WALLET_ADMIN_CREDIT_TYPE, amount_pence: signed },
    ]);
    expect(after - before).toBe(500);
  });

  it('admin debit -500p reduces wallet live balance', () => {
    const signed = signedAmountPenceForDriverWalletAdjustment('DEBIT', 500);
    expect(signed).toBe(-500);
    const after = computeLedgerWalletBalancePence([
      { type: 'TRIP_EARNING_NET', amount_pence: 1_000 },
      { type: DRIVER_WALLET_ADMIN_DEBIT_TYPE, amount_pence: signed },
    ]);
    expect(after).toBe(500);
  });

  it('debit beyond available creates debt position with owner approval', () => {
    const plan = planDriverWalletManualAdjustment({
      direction: 'DEBIT',
      amountPence: 800,
      reasonCategory: 'overpayment_recovery',
      liveBalancePence: 500,
      availableBalancePence: 300,
      actorIsOwner: false,
    });
    expect(plan.requiresOwnerApproval).toBe(true);
    expect(plan.approvalReasonCodes).toContain('DEBIT_EXCEEDS_AVAILABLE');
    expect(plan.createsDebtPosition).toBe(true);
    expect(plan.status).toBe(DRIVER_WALLET_ADJUSTMENT_STATUS.PENDING_APPROVAL);
  });

  it('owner can apply large credit immediately', () => {
    const plan = planDriverWalletManualAdjustment({
      direction: 'CREDIT',
      amountPence: 10_000,
      reasonCategory: 'goodwill_credit',
      liveBalancePence: 0,
      availableBalancePence: 0,
      actorIsOwner: true,
    });
    expect(plan.status).toBe(DRIVER_WALLET_ADJUSTMENT_STATUS.APPLIED);
    expect(plan.requiresOwnerApproval).toBe(true);
  });

  it('rejects support-like roles outside finance set', () => {
    expect(FINANCE_WALLET_ADJUSTMENT_ROLES.has('support')).toBe(false);
    expect(FINANCE_WALLET_ADJUSTMENT_ROLES.has('operator')).toBe(false);
    expect(FINANCE_WALLET_ADJUSTMENT_ROLES.has('finance_manager')).toBe(true);
  });

  it('validates minimum note length and amount', () => {
    const bad = validateDriverWalletManualAdjustmentInput({
      direction: 'credit',
      amount_pence: 0,
      reason_category: 'goodwill_credit',
      reason_note: 'too short',
    });
    expect(bad.ok).toBe(false);
    if (bad.ok === false) expect(bad.code).toBe('INVALID_AMOUNT');

    const badNote = validateDriverWalletManualAdjustmentInput({
      direction: 'credit',
      amount_pence: 100,
      reason_category: 'goodwill_credit',
      reason_note: 'short',
    });
    expect(badNote.ok).toBe(false);
    if (badNote.ok === false) expect(badNote.code).toBe('REASON_TOO_SHORT');
  });

  it('owner approval required above threshold for finance staff', () => {
    const plan = planDriverWalletManualAdjustment({
      direction: 'CREDIT',
      amountPence: 10_000,
      reasonCategory: 'goodwill_credit',
      liveBalancePence: 1_000,
      availableBalancePence: 800,
      actorIsOwner: false,
    });
    expect(plan.status).toBe(DRIVER_WALLET_ADJUSTMENT_STATUS.PENDING_APPROVAL);
    expect(plan.approvalReasonCodes).toContain('AMOUNT_ABOVE_THRESHOLD');
  });

  it('parses admin adjustment metadata for driver-visible fields', () => {
    const parsed = parseDriverWalletAdminAdjustmentMetadata({
      source: 'admin_manual_adjustment',
      reason_category: 'goodwill_credit',
      reason_note: 'Make-good for delayed payout',
      created_by_admin_id: '11111111-1111-1111-1111-111111111111',
    });
    expect(parsed.reasonCategoryLabel).toBe('Goodwill credit');
    expect(driverWalletAdjustmentDriverTitle('CREDIT')).toBe('Admin credit');
  });

  it('duplicate idempotency key does not double-prefix', () => {
    const once = buildDriverWalletManualAdjustmentIdempotencyKey('abc-123');
    const twice = buildDriverWalletManualAdjustmentIdempotencyKey(once);
    expect(once).toBe('dw_manual_adj:abc-123');
    expect(twice).toBe(once);
  });
});
