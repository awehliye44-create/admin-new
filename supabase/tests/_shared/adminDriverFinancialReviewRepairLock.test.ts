/**
 * Lock: Admin Driver Financial Review & Repair (P0) — post-blocker fixes.
 */
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { assertFalse } from "https://deno.land/std@0.224.0/assert/assert_false.ts";
import { fromFileUrl } from "https://deno.land/std@0.224.0/path/from_file_url.ts";
import { join } from "https://deno.land/std@0.224.0/path/join.ts";
import {
  ADMIN_REVIEW_REPAIR_ACTION_PRESENT,
  assertRepairMoneyConservation,
  assertRepairPreviewStillFresh,
  buildDriverFinancialRepairPreview,
  DRIVER_FINANCIAL_REPAIR_ACTION,
  DRIVER_FINANCIAL_REPAIR_AUDIT_EVENT,
  DRIVER_FINANCIAL_REPAIR_BLOCK,
  DRIVER_FINANCIAL_REPAIR_COPY,
  evaluateFalseFreezeClearedFromRecompute,
  planDriverFinancialRepairMoney,
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

Deno.test("P0 money: stamp missing + TEN missing → TEN 1700, ADMIN 0, total 1700", () => {
  const preview = buildDriverFinancialRepairPreview({
    evidence: baseEvidence({ actual_ten_credit_pence: 0 }),
    repair_token: "11111111-1111-1111-1111-111111111111",
  });
  assertEquals(preview.classification, DRIVER_FINANCIAL_REPAIR_ACTION.RESTORE_EXPECTED_STAMP);
  assert(preview.proposed_repair.restore_expected_stamp);
  assertEquals(preview.proposed_repair.canonical_ten_restoration_pence, 1700);
  assertEquals(preview.proposed_repair.append_wallet_correction_pence, 0);
  assertEquals(preview.proposed_repair.proven_wallet_delta_pence, 1700);
  const cons = assertRepairMoneyConservation({
    canonical_ten_restoration_pence: 1700,
    residual_correction_pence: 0,
    proven_missing_pence: 1700,
  });
  assertEquals(cons.ok, true);
});

Deno.test("P0 money: stamp missing + TEN correct → £0 money", () => {
  const preview = buildDriverFinancialRepairPreview({
    evidence: baseEvidence({ actual_ten_credit_pence: 1700 }),
    repair_token: "22222222-2222-2222-2222-222222222222",
  });
  assertEquals(preview.proposed_repair.canonical_ten_restoration_pence, 0);
  assertEquals(preview.proposed_repair.append_wallet_correction_pence, 0);
  assertEquals(preview.proposed_repair.proven_wallet_delta_pence, 0);
  assertFalse(preview.proposed_repair.wallet_money_changes);
});

Deno.test("P0 money: stamp present + ledger shortage → correction only", () => {
  const preview = buildDriverFinancialRepairPreview({
    evidence: baseEvidence({
      existing_driver_net_pence: 1700,
      existing_commission_pence: 300,
      actual_ten_credit_pence: 1500,
    }),
    repair_token: "33333333-3333-3333-3333-333333333333",
  });
  assertEquals(preview.classification, DRIVER_FINANCIAL_REPAIR_ACTION.APPEND_WALLET_CORRECTION);
  assertFalse(preview.proposed_repair.restore_expected_stamp);
  assertEquals(preview.proposed_repair.canonical_ten_restoration_pence, 0);
  assertEquals(preview.proposed_repair.append_wallet_correction_pence, 200);
  assertEquals(preview.proposed_repair.proven_wallet_delta_pence, 200);
});

Deno.test("P0 money: conservation invariant blocks double-count plan", () => {
  const bad = assertRepairMoneyConservation({
    canonical_ten_restoration_pence: 1700,
    residual_correction_pence: 1700,
    proven_missing_pence: 1700,
  });
  assertEquals(bad.ok, false);
});

Deno.test("P0 money: planDriverFinancialRepairMoney never double-counts", () => {
  const plan = planDriverFinancialRepairMoney({
    expected_ten_credit_pence: 1700,
    expected_tip_pence: 0,
    actual_ten_credit_pence: 0,
    actual_tip_credit_pence: 0,
  });
  assert(!("ok" in plan && plan.ok === false));
  if (!("ok" in plan)) {
    assertEquals(plan.canonical_ten_restoration_pence, 1700);
    assertEquals(plan.residual_correction_pence, 0);
    assertEquals(plan.proven_wallet_delta_pence, 1700);
  }
});

Deno.test("P0 freeze: second independent discrepancy prevents FALSE_FREEZE_CLEARED", () => {
  const secondMismatch = evaluateFalseFreezeClearedFromRecompute({
    wallet_status: "FROZEN",
    driver_credit_status: "DRIVER_UNDER_CREDITED",
    wallet_variance_pence: -500,
    missing_stamp_trip_count: 0,
    provider_state_ok: true,
    active_payout_reservation: false,
    payout_intent_in_flight: false,
  });
  assertFalse(secondMismatch.clear);
  assert(secondMismatch.remaining_blockers.length > 0);

  const clean = evaluateFalseFreezeClearedFromRecompute({
    wallet_status: "ACTIVE",
    driver_credit_status: "DRIVER_CREDIT_OK",
    wallet_variance_pence: 0,
    missing_stamp_trip_count: 0,
    provider_state_ok: true,
    active_payout_reservation: false,
    payout_intent_in_flight: false,
  });
  assert(clean.clear);
});

Deno.test("P0 freeze: synthetic OK alone is not enough without live snapshot fields", () => {
  // Missing stamp count remaining after a single-trip repair on a multi-issue driver.
  const stillMissing = evaluateFalseFreezeClearedFromRecompute({
    wallet_status: "FROZEN",
    driver_credit_status: "EXPECTED_STAMP_MISSING",
    wallet_variance_pence: 0,
    missing_stamp_trip_count: 2,
    provider_state_ok: true,
  });
  assertFalse(stillMissing.clear);
});

Deno.test("fail-closed gates still block", () => {
  assertEquals(
    buildDriverFinancialRepairPreview({
      evidence: baseEvidence({ provider_state: "UNKNOWN" }),
      repair_token: "55555555-5555-5555-5555-555555555555",
    }).block_code,
    DRIVER_FINANCIAL_REPAIR_BLOCK.PROVIDER_UNKNOWN,
  );
  assertEquals(
    buildDriverFinancialRepairPreview({
      evidence: baseEvidence({ active_payout_reservation: true }),
      repair_token: "66666666-6666-6666-6666-666666666666",
    }).block_code,
    DRIVER_FINANCIAL_REPAIR_BLOCK.ACTIVE_RESERVATION,
  );
  assertEquals(
    buildDriverFinancialRepairPreview({
      evidence: baseEvidence({ payout_intent_status: "SUBMITTED" }),
      repair_token: "77777777-7777-7777-7777-777777777777",
    }).block_code,
    DRIVER_FINANCIAL_REPAIR_BLOCK.PAYOUT_IN_FLIGHT,
  );
});

Deno.test("stale preview fails", () => {
  const stale = assertRepairPreviewStillFresh({
    stored_preview_hash: "abc",
    live_preview_hash: "xyz",
  });
  assertEquals(stale.ok, false);
});

Deno.test("1–10 source certification locks (preview zero writes, real recompute, lock fail-closed)", async () => {
  const edge = await read("supabase/functions/admin-driver-financial-repair/index.ts");
  const ssot = await read("supabase/functions/_shared/driverFinancialReviewRepairSSOT.ts");
  const migration = await read(
    "supabase/migrations/20261129120000_driver_financial_review_repair.sql",
  );
  const panel = await read("src/components/finance/DriverWalletReviewRepairPanel.tsx");
  const adjustmentEdge = await read("supabase/functions/admin-driver-adjustment/index.ts");

  // 1. Preview = zero writes
  const previewFn = edge.slice(
    edge.indexOf("async function handlePreview"),
    edge.indexOf("async function handleApply"),
  );
  assert(!previewFn.includes(".insert("));
  assert(!previewFn.includes("insertRepairAudit"));
  assert(!previewFn.includes("logFinanceAuditEvent"));
  assert(previewFn.includes("preview_persisted: false") || previewFn.includes("preview_persisted:false"));
  assert(previewFn.includes("Intentionally no persistent writes"));

  // 2. Client cannot control money/stamp
  assert(edge.includes("ARBITRARY_STAMP_EDIT"));
  assert(ssot.includes("admin_override_driver_net_pence"));
  assert(panel.includes("preview_hash"));
  assert(!panel.includes("amount_pence:"));

  // 3. Adjustment separate
  assert(!adjustmentEdge.includes("EXPECTED_STAMP_RESTORED"));
  assert(ADMIN_REVIEW_REPAIR_ACTION_PRESENT);

  // 4–5. Residual-only correction + conservation
  assert(ssot.includes("planDriverFinancialRepairMoney"));
  assert(ssot.includes("canonical_ten_restoration_pence"));
  assert(ssot.includes("proven_wallet_delta_pence"));
  assert(ssot.includes("MONETARY_CONSERVATION_VIOLATION"));
  assert(edge.includes("canonical_ten_restoration_pence"));
  assert(edge.includes("assertRepairMoneyConservation"));
  assert(edge.includes("actual_wallet_delta_pence"));

  // 6. Real recompute
  assert(edge.includes("fetchDriverWalletPayoutSnapshot"));
  assert(edge.includes("evaluateFalseFreezeClearedFromRecompute"));
  assert(!/driver_credit_status:\s*postVariance[\s\S]{0,40}DRIVER_CREDIT_OK/.test(edge));
  assert(!edge.includes('driver_credit_status: postVariance === 0 || appendPence !== 0'));
  assert(edge.includes('source: "fetchDriverWalletPayoutSnapshot"'));

  // 7. Lock fail-closed
  assert(edge.includes("admin_driver_financial_repair_lock"));
  assert(edge.includes("LOCK_UNAVAILABLE"));
  assert(!edge.includes(".catch(() => undefined)") || edge.includes("releaseDriverFinancialRepairLock"));
  // Acquire must not swallow:
  const acquireFn = edge.slice(
    edge.indexOf("async function acquireDriverFinancialRepairLock"),
    edge.indexOf("async function releaseDriverFinancialRepairLock"),
  );
  assert(!acquireFn.includes(".catch("));
  assert(migration.includes("admin_driver_financial_repair_lock"));
  assert(migration.includes("pg_advisory_lock"));

  // 8. No Revolut/payout/scheduler
  assert(!/revolut\.com|createOrder|captureOrder/i.test(edge));
  assert(!edge.includes("admin-execute-weekly-payout"));
  assert(!edge.includes("release_driver_payout_reservation"));

  // 9. Idempotency
  assert(edge.includes("idempotent: true"));
  assert(migration.includes("dw_fin_repair:%"));
  assert(migration.includes("driver_financial_repair_requests_idempotency_uidx"));

  // 10. Migration append-only / safe
  assert(migration.includes("append-only"));
  assert(!/UPDATE\s+public\.driver_wallet_ledger/i.test(migration));
  assert(!/DELETE\s+FROM\s+public\.driver_wallet_ledger/i.test(migration));
  for (const ev of Object.values(DRIVER_FINANCIAL_REPAIR_AUDIT_EVENT)) {
    assert(migration.includes(ev));
  }

  assertEquals(DRIVER_FINANCIAL_REPAIR_COPY.BUTTON, "Review & repair");
  assert(
    shouldShowDriverFinancialReviewRepair({ driver_credit_status: "EXPECTED_STAMP_MISSING" }),
  );
});
