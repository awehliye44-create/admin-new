import { describe, expect, it } from 'vitest';
import {
  DRIVER_FINANCIAL_REPAIR_ACTION,
  DRIVER_FINANCIAL_REPAIR_COPY,
  buildDriverFinancialRepairPreview,
  shouldShowDriverFinancialReviewRepair,
  type DriverFinancialRepairEvidence,
} from '../../../shared/driverFinancialReviewRepairSSOT';
import {
  driverFinancialReviewRepairButtonLabel,
  resolveDriverWalletLedgerRowMenu,
} from '@/lib/driverWalletReviewRepairMenu';

function evidence(partial: Partial<DriverFinancialRepairEvidence> = {}): DriverFinancialRepairEvidence {
  return {
    driver_id: 'd1',
    trip_id: 't1',
    trip_status: 'completed',
    financial_model: 'PLATFORM_COLLECTED',
    payment_session_id: 'ps1',
    payment_session_lineage_ok: true,
    provider_state: 'CAPTURED',
    captured_amount_pence: 1000,
    final_fare_pence: 1000,
    commission_rate_percent: 10,
    tip_pence: 0,
    airport_charge_pence: 0,
    existing_driver_net_pence: null,
    actual_ten_credit_pence: 900,
    actual_tip_credit_pence: 0,
    currency: 'GBP',
    expected_currency: 'GBP',
    ...partial,
  };
}

describe('driver financial review repair UI locks', () => {
  it('shows Review & repair label and menu ordering', () => {
    expect(driverFinancialReviewRepairButtonLabel()).toBe('Review & repair');
    expect(DRIVER_FINANCIAL_REPAIR_COPY.BUTTON).toBe('Review & repair');
    const menu = resolveDriverWalletLedgerRowMenu({
      visibility: { driver_credit_status: 'EXPECTED_STAMP_MISSING' },
      adjustmentsDeployed: true,
    });
    expect(menu).toEqual(['open_wallet_account', 'review_and_repair', 'adjustment']);
  });

  it('hides Review & repair when wallet healthy', () => {
    expect(
      shouldShowDriverFinancialReviewRepair({
        wallet_status: 'ACTIVE',
        driver_credit_status: 'DRIVER_CREDIT_OK',
      }),
    ).toBe(false);
    const menu = resolveDriverWalletLedgerRowMenu({
      visibility: { wallet_status: 'ACTIVE', driver_credit_status: 'DRIVER_CREDIT_OK' },
      adjustmentsDeployed: true,
    });
    expect(menu).toEqual(['open_wallet_account', 'adjustment']);
  });

  it('server-calculated stamp preview for missing stamp', () => {
    const preview = buildDriverFinancialRepairPreview({
      evidence: evidence(),
      repair_token: '00000000-0000-0000-0000-000000000001',
    });
    expect(preview.classification).toBe(DRIVER_FINANCIAL_REPAIR_ACTION.RESTORE_EXPECTED_STAMP);
    expect(preview.proposed_repair.proposed_stamp?.driver_net_pence).toBe(900);
    expect(preview.proposed_repair.wallet_money_changes).toBe(false);
  });
});
