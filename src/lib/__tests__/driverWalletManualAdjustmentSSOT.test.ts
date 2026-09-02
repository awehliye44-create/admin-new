import { describe, expect, it } from 'vitest';
import { computeLedgerWalletBalancePence } from '../../../supabase/functions/_shared/onecabFinanceLedger.ts';
import {
  buildDriverWalletManualAdjustmentIdempotencyKey,
  canAuthenticatedClientInsertDriverWalletLedger,
  canDriverSelectOwnAdminAdjustmentLedgerRow,
  DRIVER_WALLET_ADJUSTMENT_STATUS,
  DRIVER_WALLET_ADMIN_CREDIT_TYPE,
  DRIVER_WALLET_ADMIN_DEBIT_TYPE,
  DRIVER_WALLET_ADMIN_ADJUSTMENTS_DEPLOYED,
  FINANCE_WALLET_ADJUSTMENT_ROLES,
  driverWalletAdjustmentAdminDirectionLabel,
  driverWalletAdjustmentDriverTitle,
  evaluateDriverWalletAdjustmentCallerAccess,
  ledgerTypeForDriverWalletAdjustmentDirection,
  parseDriverWalletAdminAdjustmentMetadata,
  planDriverWalletManualAdjustment,
  signedAmountPenceForDriverWalletAdjustment,
  simulateConcurrentManualAdjustmentLedgerPosts,
  validateDriverWalletManualAdjustmentInput,
} from '../../../shared/driverWalletManualAdjustmentSSOT.ts';
import { walletTransactionDisplayTitle } from '../../../shared/walletTransactionTitles.ts';

describe('driverWalletManualAdjustmentSSOT', () => {
  it('keeps feature parked', () => {
    expect(DRIVER_WALLET_ADMIN_ADJUSTMENTS_DEPLOYED).toBe(false);
  });

  it('admin credit +500p increases wallet live balance', () => {
    const before = computeLedgerWalletBalancePence([{ type: 'TRIP_EARNING_NET', amount_pence: 1_000 }]);
    const signed = signedAmountPenceForDriverWalletAdjustment('CREDIT', 500);
    expect(signed).toBe(500);
    expect(ledgerTypeForDriverWalletAdjustmentDirection('CREDIT')).toBe(DRIVER_WALLET_ADMIN_CREDIT_TYPE);
    const after = computeLedgerWalletBalancePence([
      { type: 'TRIP_EARNING_NET', amount_pence: 1_000 },
      { type: DRIVER_WALLET_ADMIN_CREDIT_TYPE, amount_pence: signed },
    ]);
    expect(after - before).toBe(500);
  });

  it('admin debit -500p reduces wallet live balance', () => {
    const signed = signedAmountPenceForDriverWalletAdjustment('DEBIT', 500);
    expect(signed).toBe(-500);
    expect(ledgerTypeForDriverWalletAdjustmentDirection('DEBIT')).toBe(DRIVER_WALLET_ADMIN_DEBIT_TYPE);
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

  it('HTTP auth matrix: unauth / support / operator / legacy admin / finance roles', () => {
    expect(evaluateDriverWalletAdjustmentCallerAccess({
      authenticated: false,
      hasStaffFinanceProfile: false,
      staffRole: null,
    }).ok).toBe(false);

    expect(evaluateDriverWalletAdjustmentCallerAccess({
      authenticated: true,
      hasStaffFinanceProfile: true,
      staffRole: 'customer_support',
    })).toEqual({ ok: false, code: 'FINANCE_EXECUTION_FORBIDDEN' });

    expect(evaluateDriverWalletAdjustmentCallerAccess({
      authenticated: true,
      hasStaffFinanceProfile: true,
      staffRole: 'operator',
    })).toEqual({ ok: false, code: 'FINANCE_EXECUTION_FORBIDDEN' });

    expect(evaluateDriverWalletAdjustmentCallerAccess({
      authenticated: true,
      hasStaffFinanceProfile: false,
      staffRole: 'admin',
    })).toEqual({ ok: false, code: 'FINANCE_STAFF_PROFILE_REQUIRED' });

    expect(evaluateDriverWalletAdjustmentCallerAccess({
      authenticated: true,
      hasStaffFinanceProfile: true,
      staffRole: 'finance_manager',
    })).toEqual({ ok: true, role: 'finance_manager' });
  });

  it('RLS matrix: driver own applied rows only; client cannot insert', () => {
    expect(canDriverSelectOwnAdminAdjustmentLedgerRow({
      viewerDriverId: 'd1',
      rowDriverId: 'd1',
      ledgerType: DRIVER_WALLET_ADMIN_DEBIT_TYPE,
    })).toBe(true);
    expect(canDriverSelectOwnAdminAdjustmentLedgerRow({
      viewerDriverId: 'd1',
      rowDriverId: 'd2',
      ledgerType: DRIVER_WALLET_ADMIN_DEBIT_TYPE,
    })).toBe(false);
    expect(canAuthenticatedClientInsertDriverWalletLedger()).toBe(false);
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

  it('driver-visible title is ONECAB adjustment; admin keeps credit/debit label', () => {
    const parsed = parseDriverWalletAdminAdjustmentMetadata({
      source: 'admin_manual_adjustment',
      reason_category: 'goodwill_credit',
      reason_note: 'Make-good for delayed payout',
      created_by_admin_id: '11111111-1111-1111-1111-111111111111',
    });
    expect(parsed.reasonCategoryLabel).toBe('Goodwill credit');
    expect(driverWalletAdjustmentDriverTitle('CREDIT')).toBe('ONECAB adjustment');
    expect(driverWalletAdjustmentDriverTitle('DEBIT')).toBe('ONECAB adjustment');
    expect(driverWalletAdjustmentAdminDirectionLabel('CREDIT')).toBe('Credit');
    expect(walletTransactionDisplayTitle('ADMIN_WALLET_CREDIT')).toBe('ONECAB adjustment');
    expect(walletTransactionDisplayTitle('ADMIN_WALLET_DEBIT')).toBe('ONECAB adjustment');
  });

  it('duplicate idempotency key does not double-prefix or double-post', () => {
    const once = buildDriverWalletManualAdjustmentIdempotencyKey('abc-123');
    const twice = buildDriverWalletManualAdjustmentIdempotencyKey(once);
    expect(once).toBe('dw_manual_adj:abc-123');
    expect(twice).toBe(once);

    const concurrent = simulateConcurrentManualAdjustmentLedgerPosts({
      idempotencyKey: 'abc-123',
      ledgerType: DRIVER_WALLET_ADMIN_CREDIT_TYPE,
      attempts: 8,
    });
    expect(concurrent.posted).toBe(1);
    expect(concurrent.rejectedDuplicates).toBe(7);
    expect(concurrent.ledgerTypes).toEqual([DRIVER_WALLET_ADMIN_CREDIT_TYPE]);
  });

  it('never allows TRIP_EARNING_NET for manual adjustment posts', () => {
    expect(() => simulateConcurrentManualAdjustmentLedgerPosts({
      idempotencyKey: 'ten-forbidden',
      ledgerType: 'TRIP_EARNING_NET',
      attempts: 1,
    })).toThrow(/TRIP_EARNING_NET/);
  });
});
