/**
 * Lock: Admin Driver Financial Review & Repair (P0).
 * Covers preview classification, safe gates, append-only correction,
 * freeze-by-recompute, separation from Adjustment / Resume, audit, no provider/payout.
 */
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { assertFalse } from "https://deno.land/std@0.224.0/assert/assert_false.ts";
import { fromFileUrl } from "https://deno.land/std@0.224.0/path/from_file_url.ts";
import { join } from "https://deno.land/std@0.224.0/path/join.ts";
import {
  ADMIN_REVIEW_REPAIR_ACTION_PRESENT,
  EXPECTED_STAMP_REPAIR_SEPARATE_FROM_ADJUSTMENT,
  REPAIR_VALUE_SERVER_CALCULATED,
  NO_ARBITRARY_STAMP_EDIT,
  EVIDENCE_ONLY_REPAIR_CHANGES_NO_MONEY,
  WALLET_CORRECTION_APPEND_ONLY,
  FALSE_FREEZE_CLEARS_BY_RECOMPUTE,
  NO_DIRECT_UNFREEZE,
  OPERATIONAL_PAUSE_SEPARATE,
  PROVIDER_UNKNOWN_BLOCKED,
  PAYOUT_IN_FLIGHT_BLOCKED,
  REPAIR_IDEMPOTENT,
  REPAIR_AUDIT_IMMUTABLE,
  NO_PROVIDER_CALL,
  NO_PAYOUT,
  DRAFT_PR_ONLY,
  STOPPED_FOR_REPAIR_CONTROL_APPROVAL,
  DRIVER_FINANCIAL_REPAIR_ACTION,
  DRIVER_FINANCIAL_REPAIR_AUDIT_EVENT,
  DRIVER_FINANCIAL_REPAIR_BLOCK,
  DRIVER_FINANCIAL_REPAIR_COPY,
  adjustmentClearsExpectedStampMissing,
  assertRepairPreviewStillFresh,
  buildDriverFinancialRepairPreview,
  computeExpectedStampForRepair,
  directUnfreezeAllowed,
  formatWalletCorrectionResultCopy,
  resumePayoutsMutatesEvidenceOrWallet,
  shouldDerivedFreezeClearAfterRecompute,
  shouldShowDriverFinancialReviewRepair,
  type DriverFinancialRepairEvidence,
} from "../../functions/_shared/driverFinancialReviewRepairSSOT.ts";

const REPO_ROOT = fromFileUrl(new URL("../../..", import.meta.url));

async function read(rel: string): Promise<string> {
  return await Deno.readTextFile(join(REPO_ROOT, rel));
}

function baseEvidence(
  overrides: Partial<DriverFinancialRepairEvidence> = {},
): DriverFinancialRepairEvidence {
  return {
    driver_id: "drv-1",
    driver_name: "Test Driver",
    driver_code: "MK-DRV-1",
    trip_id: "trip-1",
    trip_code: "MK-260924-001",
    trip_status: "completed",
    financial_model: "PLATFORM_COLLECTED",
    financial_outcome: "COMPLETED",
    payment_session_id: "ps-1",
    payment_session_lineage_ok: true,
    provider_order_id: "ord-1",
    provider_payment_id: "pay-1",
    provider_state: "CAPTURED",
    captured_amount_pence: 2000,
    final_fare_pence: 2000,
    commission_basis_pence: 2000,
    commission_rate_percent: 15,
    commission_pence: 300,
    provider_fee_pence: 0,
    tip_pence: 0,
    airport_charge_pence: 0,
    existing_driver_net_pence: null,
    existing_commission_pence: null,
    existing_tip_pence: null,
    actual_ten_credit_pence: 1700,
    actual_tip_credit_pence: 0,
    currency: "GBP",
    expected_currency: "GBP",
    has_contradictory_stamps: false,
    active_payout_reservation: false,
    payout_intent_status: null,
    already_applied_repair_token: null,
    admin_override_driver_net_pence: 999999,
    ...overrides,
  };
}

Deno.test("flags: required P0 control flags locked true", () => {
  assert(ADMIN_REVIEW_REPAIR_ACTION_PRESENT);
  assert(EXPECTED_STAMP_REPAIR_SEPARATE_FROM_ADJUSTMENT);
  assert(REPAIR_VALUE_SERVER_CALCULATED);
  assert(NO_ARBITRARY_STAMP_EDIT);
  assert(EVIDENCE_ONLY_REPAIR_CHANGES_NO_MONEY);
  assert(WALLET_CORRECTION_APPEND_ONLY);
  assert(FALSE_FREEZE_CLEARS_BY_RECOMPUTE);
  assert(NO_DIRECT_UNFREEZE);
  assert(OPERATIONAL_PAUSE_SEPARATE);
  assert(PROVIDER_UNKNOWN_BLOCKED);
  assert(PAYOUT_IN_FLIGHT_BLOCKED);
  assert(REPAIR_IDEMPOTENT);
  assert(REPAIR_AUDIT_IMMUTABLE);
  assert(NO_PROVIDER_CALL);
  assert(NO_PAYOUT);
  assert(DRAFT_PR_ONLY);
  assert(STOPPED_FOR_REPAIR_CONTROL_APPROVAL);
});

Deno.test("1. EXPECTED_STAMP_MISSING + complete evidence → exact stamp preview", () => {
  const preview = buildDriverFinancialRepairPreview({
    evidence: baseEvidence({ actual_ten_credit_pence: 1700 }),
    repair_token: "11111111-1111-1111-1111-111111111111",
    derived_frozen: true,
  });
  assertEquals(preview.classification, DRIVER_FINANCIAL_REPAIR_ACTION.RESTORE_EXPECTED_STAMP);
  assert(preview.apply_allowed);
  assert(preview.proposed_repair.restore_expected_stamp);
  assert(preview.proposed_repair.proposed_stamp != null);
  assertEquals(preview.proposed_repair.proposed_stamp!.driver_net_pence, 1700);
  assertEquals(preview.proposed_repair.append_wallet_correction_pence, 0);
  assertFalse(preview.proposed_repair.wallet_money_changes);
  assert(preview.proposed_repair.freeze_should_clear_after_recompute);
});

Deno.test("2. Admin cannot type a custom stamp", () => {
  const withOverride = baseEvidence({ admin_override_driver_net_pence: 1 });
  const computed = computeExpectedStampForRepair(withOverride);
  assert(computed.ok);
  if (computed.ok) {
    assertEquals(computed.stamp.driver_net_pence, 1700);
    assert(computed.stamp.driver_net_pence !== 1);
  }
  const preview = buildDriverFinancialRepairPreview({
    evidence: withOverride,
    repair_token: "22222222-2222-2222-2222-222222222222",
  });
  assertEquals(preview.proposed_repair.proposed_stamp?.driver_net_pence, 1700);
});

Deno.test("3. Correct wallet amount → no wallet adjustment", () => {
  const preview = buildDriverFinancialRepairPreview({
    evidence: baseEvidence({
      existing_driver_net_pence: 1700,
      existing_commission_pence: 300,
      actual_ten_credit_pence: 1700,
    }),
    repair_token: "33333333-3333-3333-3333-333333333333",
  });
  assertEquals(preview.classification, DRIVER_FINANCIAL_REPAIR_ACTION.RECOMPUTE_RECONCILIATION);
  assertEquals(preview.proposed_repair.append_wallet_correction_pence, 0);
  assertFalse(preview.proposed_repair.wallet_money_changes);
});

Deno.test("4. Genuine missing credit → exact append-only correction", () => {
  const preview = buildDriverFinancialRepairPreview({
    evidence: baseEvidence({
      existing_driver_net_pence: 1700,
      existing_commission_pence: 300,
      actual_ten_credit_pence: 0,
    }),
    repair_token: "44444444-4444-4444-4444-444444444444",
  });
  assertEquals(preview.classification, DRIVER_FINANCIAL_REPAIR_ACTION.APPEND_WALLET_CORRECTION);
  assertEquals(preview.proposed_repair.append_wallet_correction_pence, 1700);
  assert(preview.proposed_repair.wallet_money_changes);
});

Deno.test("5. Provider UNKNOWN blocks repair", () => {
  const preview = buildDriverFinancialRepairPreview({
    evidence: baseEvidence({ provider_state: "UNKNOWN" }),
    repair_token: "55555555-5555-5555-5555-555555555555",
  });
  assertEquals(preview.classification, DRIVER_FINANCIAL_REPAIR_ACTION.NO_REPAIR_PROVIDER_UNKNOWN);
  assertEquals(preview.block_code, DRIVER_FINANCIAL_REPAIR_BLOCK.PROVIDER_UNKNOWN);
  assertFalse(preview.apply_allowed);
});

Deno.test("6. Active reservation blocks repair", () => {
  const preview = buildDriverFinancialRepairPreview({
    evidence: baseEvidence({ active_payout_reservation: true }),
    repair_token: "66666666-6666-6666-6666-666666666666",
  });
  assertEquals(preview.block_code, DRIVER_FINANCIAL_REPAIR_BLOCK.ACTIVE_RESERVATION);
  assertFalse(preview.apply_allowed);
});

Deno.test("7. Payout intent in flight blocks repair", () => {
  const preview = buildDriverFinancialRepairPreview({
    evidence: baseEvidence({ payout_intent_status: "SUBMITTED" }),
    repair_token: "77777777-7777-7777-7777-777777777777",
  });
  assertEquals(preview.block_code, DRIVER_FINANCIAL_REPAIR_BLOCK.PAYOUT_IN_FLIGHT);
  assertFalse(preview.apply_allowed);

  const unknown = buildDriverFinancialRepairPreview({
    evidence: baseEvidence({ payout_intent_status: "UNKNOWN" }),
    repair_token: "77777777-7777-7777-7777-777777777778",
  });
  assertEquals(unknown.block_code, DRIVER_FINANCIAL_REPAIR_BLOCK.PAYOUT_IN_FLIGHT);
});

Deno.test("8. Duplicate apply is idempotent (already-applied token)", () => {
  const preview = buildDriverFinancialRepairPreview({
    evidence: baseEvidence({
      already_applied_repair_token: "88888888-8888-8888-8888-888888888888",
    }),
    repair_token: "88888888-8888-8888-8888-888888888888",
  });
  assertEquals(preview.block_code, DRIVER_FINANCIAL_REPAIR_BLOCK.ALREADY_APPLIED);
  assertFalse(preview.apply_allowed);
});

Deno.test("9. Stale preview fails", () => {
  const fresh = assertRepairPreviewStillFresh({
    stored_preview_hash: "abc",
    live_preview_hash: "abc",
  });
  assertEquals(fresh.ok, true);
  const stale = assertRepairPreviewStillFresh({
    stored_preview_hash: "abc",
    live_preview_hash: "xyz",
  });
  assertEquals(stale.ok, false);
  if (!stale.ok) assertEquals(stale.error_code, "REPAIR_PREVIEW_STALE");
});

Deno.test("10. Original ledger row remains unchanged (append-only contract)", () => {
  assert(WALLET_CORRECTION_APPEND_ONLY);
  const preview = buildDriverFinancialRepairPreview({
    evidence: baseEvidence({
      existing_driver_net_pence: 1700,
      actual_ten_credit_pence: 1500,
    }),
    repair_token: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  });
  assertEquals(preview.proposed_repair.append_wallet_correction_pence, 200);
  // Correction is a delta append — never an edit of the 1500 TEN row.
  assert(preview.proposed_repair.append_wallet_correction_pence !== 1500);
});

Deno.test("11. Successful evidence repair reruns reconciliation", () => {
  const preview = buildDriverFinancialRepairPreview({
    evidence: baseEvidence(),
    repair_token: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  });
  assert(preview.proposed_repair.recompute_reconciliation);
});

Deno.test("12. Freeze clears only when reconciliation returns zero/complete", () => {
  assert(
    shouldDerivedFreezeClearAfterRecompute({
      variance_pence: 0,
      evidence_complete: true,
      driver_credit_status: "DRIVER_CREDIT_OK",
    }),
  );
});

Deno.test("13. Remaining mismatch keeps freeze", () => {
  assertFalse(
    shouldDerivedFreezeClearAfterRecompute({
      variance_pence: 100,
      evidence_complete: true,
      driver_credit_status: "DRIVER_UNDER_CREDITED",
    }),
  );
  assertFalse(
    shouldDerivedFreezeClearAfterRecompute({
      variance_pence: 0,
      evidence_complete: false,
      driver_credit_status: "DRIVER_CREDIT_OK",
    }),
  );
});

Deno.test("14. Operational pause remains unchanged (separate)", () => {
  assert(OPERATIONAL_PAUSE_SEPARATE);
  assertFalse(resumePayoutsMutatesEvidenceOrWallet());
});

Deno.test("15. Resume payouts does not modify evidence or wallet", () => {
  assertFalse(resumePayoutsMutatesEvidenceOrWallet());
});

Deno.test("16. Adjustment does not falsely clear EXPECTED_STAMP_MISSING", () => {
  assertFalse(adjustmentClearsExpectedStampMissing());
  assert(EXPECTED_STAMP_REPAIR_SEPARATE_FROM_ADJUSTMENT);
});

Deno.test("17–20. Edge + migration + UI + audit source locks", async () => {
  const ssot = await read("supabase/functions/_shared/driverFinancialReviewRepairSSOT.ts");
  const edge = await read("supabase/functions/admin-driver-financial-repair/index.ts");
  const migration = await read(
    "supabase/migrations/20261129120000_driver_financial_review_repair.sql",
  );
  const list = await read("src/components/finance/DriverWalletDriverList.tsx");
  const page = await read("src/pages/DriverWalletLedger.tsx");
  const panel = await read("src/components/finance/DriverWalletReviewRepairPanel.tsx");
  const config = await read("supabase/config.toml");
  const adjustmentEdge = await read("supabase/functions/admin-driver-adjustment/index.ts");

  // 17. Service-area / Finance permissions
  assert(edge.includes("requireFinanceExecutionAuth"));
  assert(edge.includes("requireStaffFinanceProfile: true"));
  assert(edge.includes("DRIVER_WALLET_LEDGER"));
  assert(edge.includes("staff_service_areas"));
  assert(edge.includes("PERMISSION_DENIED"));

  // 18. No Revolut / provider mutation
  assert(!/revolut\.com|createOrder|captureOrder|revolutFetch/i.test(edge));
  assert(edge.includes("Forbidden field") || edge.includes("FORBIDDEN_FIELD"));
  assert(NO_PROVIDER_CALL);

  // 19. No payout or scheduler invocation (forbid-list mention of execute_payout is OK)
  assert(!edge.includes("admin-execute-weekly-payout"));
  assert(!edge.includes("admin-weekly-payout-scheduler"));
  assert(edge.includes('"execute_payout"') || edge.includes("'execute_payout'"));
  assert(!/functions\.invoke\(\s*['"]admin-execute/.test(edge));
  assert(!/rpc\(\s*['"]execute_.*payout/.test(edge));
  assert(NO_PAYOUT);

  // 20. Immutable audit trail events
  for (const ev of Object.values(DRIVER_FINANCIAL_REPAIR_AUDIT_EVENT)) {
    assert(ssot.includes(ev));
    assert(migration.includes(ev));
  }
  assert(edge.includes("driver_financial_repair_audit"));
  assert(migration.includes("append-only"));
  assert(REPAIR_AUDIT_IMMUTABLE);

  // UI present; opens panel; separate from Adjustment
  assert(list.includes("Review & repair") || list.includes("driverFinancialReviewRepairButtonLabel"));
  assert(list.includes("driver-wallet-review-repair"));
  assert(page.includes("DriverWalletReviewRepairPanel"));
  assert(page.includes("Review & repair") || page.includes("driverFinancialReviewRepairButtonLabel"));
  assert(panel.includes("DRIVER_FINANCIAL_REPAIR_COPY.CONFIRMATION") || panel.includes("Before you apply"));
  assert(panel.includes("Approve repair"));
  assertEquals(DRIVER_FINANCIAL_REPAIR_COPY.CONFIRMATION.includes("does not send money"), true);
  assert(ADMIN_REVIEW_REPAIR_ACTION_PRESENT);

  // Adjustment edge must not restore stamps / clear EXPECTED_STAMP_MISSING
  assert(!adjustmentEdge.includes("EXPECTED_STAMP_RESTORED"));
  assert(!adjustmentEdge.includes("EXPECTED_STAMP_MISSING"));
  assertFalse(directUnfreezeAllowed());
  assert(!edge.includes("wallet_status=ACTIVE") && !edge.includes('wallet_status: "ACTIVE"'));
  assert(!edge.includes("frozen=false") && !edge.includes("frozen: false"));

  // Config + migration parked for draft PR only
  assert(config.includes("[functions.admin-driver-financial-repair]"));
  assert(migration.includes("driver_financial_repair_requests"));
  assert(DRAFT_PR_ONLY);
  assert(STOPPED_FOR_REPAIR_CONTROL_APPROVAL);

  // Copy contracts
  assertEquals(DRIVER_FINANCIAL_REPAIR_COPY.BUTTON, "Review & repair");
  assert(formatWalletCorrectionResultCopy(250).includes("£2.50"));
  assert(panel.includes("Financial evidence restored") || ssot.includes(DRIVER_FINANCIAL_REPAIR_COPY.EVIDENCE_ONLY_RESULT));

  // Visibility helper
  assert(
    shouldShowDriverFinancialReviewRepair({
      driver_credit_status: "EXPECTED_STAMP_MISSING",
    }),
  );
  assert(
    shouldShowDriverFinancialReviewRepair({ wallet_status: "FROZEN" }),
  );
  assertFalse(
    shouldShowDriverFinancialReviewRepair({
      wallet_status: "ACTIVE",
      driver_credit_status: "DRIVER_CREDIT_OK",
    }),
  );
});
