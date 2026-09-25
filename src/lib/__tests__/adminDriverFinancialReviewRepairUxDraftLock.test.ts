import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DRIVER_FINANCIAL_REPAIR_ACTION,
  DRIVER_FINANCIAL_REPAIR_BLOCK,
  DRIVER_FINANCIAL_REPAIR_COPY,
  DRIVER_FINANCIAL_REPAIR_UI_STATUS,
  WALLET_CORRECTION_APPEND_CERTIFIED,
  assertWalletCorrectionApplyCertified,
  buildDriverFinancialRepairPreview,
  directUnfreezeAllowed,
  isFrIssueEligibleForReviewRepair,
  resolveDriverFinancialRepairUiStatus,
  shouldShowDriverFinancialReviewRepair,
  type DriverFinancialRepairEvidence,
} from '../../../shared/driverFinancialReviewRepairSSOT';
import {
  driverFinancialRepairHistoryIsReadOnly,
  mapDriverFinancialRepairHistoryRows,
} from '@/lib/driverFinancialRepairHistory';
import {
  frIssueReviewRepairButtonLabel,
  frReviewRepairDeepLinkAutoPreview,
  resolveFrIssueReviewRepairDeepLink,
} from '@/lib/frIssuesReviewRepairDeepLink';
import {
  resolveDriverWalletLedgerRowMenu,
} from '@/lib/driverWalletReviewRepairMenu';
import { reviewRepairPanelAutoPreviewOnOpen } from '@/components/finance/DriverWalletReviewRepairPanel';

const ROOT = resolve(__dirname, '../../..');

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf8');
}

function evidence(partial: Partial<DriverFinancialRepairEvidence> = {}): DriverFinancialRepairEvidence {
  return {
    driver_id: 'd1',
    trip_id: 't1',
    trip_code: 'MK-TEST-001',
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

describe('Review & repair UX draft — history, FR deep-link, wallet correction lock', () => {
  it('FR deep-link resolves eligible driver_credit issue to existing panel target', () => {
    const target = resolveFrIssueReviewRepairDeepLink({
      issue_type: 'driver_credit',
      driver_id: 'drv-1',
      trip_id: 'trip-1',
      trip_code: 'MK-1',
      driver_name: 'Ada',
      driver_credit_health: 'EXPECTED_STAMP_MISSING',
    });
    expect(target).toEqual({
      driverId: 'drv-1',
      tripId: 'trip-1',
      tripCode: 'MK-1',
      driverName: 'Ada',
    });
    expect(frIssueReviewRepairButtonLabel()).toBe('Review & repair');
    expect(isFrIssueEligibleForReviewRepair({
      issue_type: 'payout',
      driver_id: 'drv-1',
      trip_id: 'trip-1',
    })).toBe(false);
  });

  it('opening panel / FR deep-link never auto-previews or mutates', () => {
    expect(reviewRepairPanelAutoPreviewOnOpen()).toBe(false);
    expect(frReviewRepairDeepLinkAutoPreview()).toBe(false);
    const panel = read('src/components/finance/DriverWalletReviewRepairPanel.tsx');
    expect(panel).toContain('never Preview or mutate');
    expect(panel).not.toMatch(/useEffect\([\s\S]{0,200}previewMutation\.mutate/);
    expect(panel).toContain("action: 'preview'");
    expect(panel).toContain('onClick={() => previewMutation.mutate()}');
  });

  it('repair history is read-only Finance SELECT mapping', () => {
    expect(driverFinancialRepairHistoryIsReadOnly()).toBe(true);
    const rows = mapDriverFinancialRepairHistoryRows({
      requests: [{
        id: 'r1',
        repair_token: 'tok-1',
        driver_id: 'd1',
        trip_id: 't1',
        preview_hash: 'rfh_abc',
        classification: 'RESTORE_EXPECTED_STAMP',
        status: 'APPLIED',
        apply_reason: 'ok',
        apply_result: { actual_wallet_delta_pence: 0 },
        created_by_admin_id: 'admin-1',
        applied_by_admin_id: 'admin-1',
        created_at: '2026-09-25T07:43:29Z',
        applied_at: '2026-09-25T07:43:31Z',
        trips: { trip_code: 'MK-260817-008' },
      }],
      audits: [{
        id: 'a1',
        event_type: 'DRIVER_FINANCIAL_REPAIR_PREVIEWED',
        repair_token: 'tok-1',
        preview_hash: 'rfh_abc',
        driver_id: 'd1',
        trip_id: 't1',
        admin_user_id: 'admin-1',
        reason: null,
        details: null,
        created_at: '2026-09-25T07:43:29Z',
      }, {
        id: 'a2',
        event_type: 'EXPECTED_STAMP_RESTORED',
        repair_token: 'tok-1',
        preview_hash: 'rfh_abc',
        driver_id: 'd1',
        trip_id: 't1',
        admin_user_id: 'admin-1',
        reason: 'ok',
        details: null,
        created_at: '2026-09-25T07:43:30Z',
      }, {
        id: 'a3',
        event_type: 'RECONCILIATION_RECOMPUTED',
        repair_token: 'tok-1',
        preview_hash: 'rfh_abc',
        driver_id: 'd1',
        trip_id: 't1',
        admin_user_id: 'admin-1',
        reason: null,
        details: null,
        created_at: '2026-09-25T07:43:31Z',
      }],
      staffByUserId: { 'admin-1': 'ONECAB Administrator' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].trip_code).toBe('MK-260817-008');
    expect(rows[0].admin_actor).toBe('ONECAB Administrator');
    expect(rows[0].wallet_delta_pence).toBe(0);
    expect(rows[0].audit_sequence).toEqual([
      'DRIVER_FINANCIAL_REPAIR_PREVIEWED',
      'EXPECTED_STAMP_RESTORED',
      'RECONCILIATION_RECOMPUTED',
    ]);
    const hook = read('src/hooks/useDriverFinancialRepairHistory.ts');
    expect(hook).toContain('driver_financial_repair_requests');
    expect(hook).toContain('driver_financial_repair_audit');
    expect(hook).not.toContain('.insert(');
    expect(hook).not.toContain('.update(');
    expect(hook).not.toContain('functions.invoke');
  });

  it('RESTORE_EXPECTED_STAMP remains applyable when safe', () => {
    const preview = buildDriverFinancialRepairPreview({
      evidence: evidence(),
      repair_token: '00000000-0000-0000-0000-000000000001',
    });
    expect(preview.classification).toBe(DRIVER_FINANCIAL_REPAIR_ACTION.RESTORE_EXPECTED_STAMP);
    expect(preview.apply_allowed).toBe(true);
    expect(resolveDriverFinancialRepairUiStatus({ preview })).toBe(
      DRIVER_FINANCIAL_REPAIR_UI_STATUS.SAFE_TO_APPLY,
    );
  });

  it('RECOMPUTE_RECONCILIATION remains applyable when safe', () => {
    const preview = buildDriverFinancialRepairPreview({
      evidence: evidence({
        existing_driver_net_pence: 900,
        existing_commission_pence: 100,
        actual_ten_credit_pence: 900,
      }),
      repair_token: '00000000-0000-0000-0000-000000000002',
    });
    expect(preview.classification).toBe(DRIVER_FINANCIAL_REPAIR_ACTION.RECOMPUTE_RECONCILIATION);
    expect(preview.apply_allowed).toBe(true);
    expect(resolveDriverFinancialRepairUiStatus({ preview })).toBe(
      DRIVER_FINANCIAL_REPAIR_UI_STATUS.SAFE_TO_APPLY,
    );
  });

  it('APPEND_WALLET_CORRECTION Preview works but Apply is rejected server-side', () => {
    expect(WALLET_CORRECTION_APPEND_CERTIFIED).toBe(false);
    const preview = buildDriverFinancialRepairPreview({
      evidence: evidence({
        existing_driver_net_pence: 900,
        existing_commission_pence: 100,
        actual_ten_credit_pence: 700,
      }),
      repair_token: '00000000-0000-0000-0000-000000000003',
    });
    expect(preview.classification).toBe(DRIVER_FINANCIAL_REPAIR_ACTION.APPEND_WALLET_CORRECTION);
    expect(preview.proposed_repair.append_wallet_correction_pence).toBe(200);
    expect(preview.apply_allowed).toBe(false);
    expect(preview.block_code).toBe(DRIVER_FINANCIAL_REPAIR_BLOCK.WALLET_CORRECTION_NOT_CERTIFIED);
    expect(preview.block_reason).toBe(DRIVER_FINANCIAL_REPAIR_COPY.WALLET_CORRECTION_NOT_CERTIFIED);
    expect(resolveDriverFinancialRepairUiStatus({ preview })).toBe(
      DRIVER_FINANCIAL_REPAIR_UI_STATUS.WALLET_CORRECTION_NOT_CERTIFIED,
    );
    const gate = assertWalletCorrectionApplyCertified({
      classification: DRIVER_FINANCIAL_REPAIR_ACTION.APPEND_WALLET_CORRECTION,
    });
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.error_code).toBe(DRIVER_FINANCIAL_REPAIR_BLOCK.WALLET_CORRECTION_NOT_CERTIFIED);
    }
  });

  it('UI cannot bypass the wallet-correction block', () => {
    const panel = read('src/components/finance/DriverWalletReviewRepairPanel.tsx');
    expect(panel).toContain('WALLET_CORRECTION_APPEND_CERTIFIED');
    expect(panel).toContain('WALLET_CORRECTION_NOT_CERTIFIED');
    expect(panel).toContain('DRIVER_FINANCIAL_REPAIR_COPY.WALLET_CORRECTION_NOT_CERTIFIED');
    expect(panel).toContain('walletCorrectionBlocked');
    expect(panel).toContain('!walletCorrectionBlocked');
    const edge = read('supabase/functions/admin-driver-financial-repair/index.ts');
    expect(edge).toContain('assertWalletCorrectionApplyCertified');
    expect(edge).toContain('wallet_correction_not_certified');
  });

  it('keeps Adjustment and Resume payouts as separate controls', () => {
    const menu = resolveDriverWalletLedgerRowMenu({
      visibility: { driver_credit_status: 'EXPECTED_STAMP_MISSING' },
      adjustmentsDeployed: true,
      payout_operational_paused: true,
    });
    expect(menu).toContain('review_and_repair');
    expect(menu).toContain('adjustment');
    expect(menu).not.toContain('resume_payouts');
    const ledger = read('src/pages/DriverWalletLedger.tsx');
    expect(ledger).toContain('DriverWalletAdjustmentDialog');
    expect(ledger).toContain('DriverWalletReviewRepairPanel');
    expect(ledger).not.toMatch(/Adjustment[\s\S]{0,40}Review & repair/);
    const pauseMenu = read('src/lib/driverOperationalPauseMenu.ts');
    expect(pauseMenu).toContain('Resume payouts');
    expect(pauseMenu).not.toContain('Review & repair');
  });

  it('forbids direct freeze/unfreeze and preserves drift/idempotency/provider/payout gates', () => {
    expect(directUnfreezeAllowed()).toBe(false);
    const edge = read('supabase/functions/admin-driver-financial-repair/index.ts');
    expect(edge).not.toMatch(/payout_operational_paused:\s*false/);
    expect(edge).toContain('REPAIR_PREVIEW_STALE');
    expect(edge).toContain('idempotent: true');
    const ssot = read('supabase/functions/_shared/driverFinancialReviewRepairSSOT.ts');
    expect(ssot).toContain('PROVIDER_UNKNOWN');
    expect(ssot).toContain('PAYOUT_IN_FLIGHT');
    expect(ssot).toContain('assertRepairPreviewStillFresh');
    expect(shouldShowDriverFinancialReviewRepair({
      driver_credit_status: 'EXPECTED_STAMP_MISSING',
    })).toBe(true);
  });

  it('exposes exact UI status labels including SAFE_TO_PREVIEW', () => {
    expect(resolveDriverFinancialRepairUiStatus({ preview: null })).toBe(
      DRIVER_FINANCIAL_REPAIR_UI_STATUS.SAFE_TO_PREVIEW,
    );
    expect(Object.values(DRIVER_FINANCIAL_REPAIR_UI_STATUS)).toEqual([
      'SAFE_TO_PREVIEW',
      'SAFE_TO_APPLY',
      'BLOCKED_WITH_EXACT_REASON',
      'ALREADY_REPAIRED',
      'PREVIEW_STALE',
      'PROVIDER_UNKNOWN',
      'PAYOUT_IN_FLIGHT',
      'WALLET_CORRECTION_NOT_CERTIFIED',
    ]);
  });

  it('FR Issues tab wires Review & repair to existing panel with trip prefill', () => {
    const issues = read('src/components/finance/FinancialReconciliationIssuesTab.tsx');
    expect(issues).toContain('DriverWalletReviewRepairPanel');
    expect(issues).toContain('resolveFrIssueReviewRepairDeepLink');
    expect(issues).toContain('initialTripId={reviewRepairTarget.tripId}');
    expect(issues).toContain('frIssueReviewRepairButtonLabel');
    expect(issues).not.toContain("action: 'apply'");
    expect(issues).not.toContain('admin-driver-financial-repair');
  });
});
