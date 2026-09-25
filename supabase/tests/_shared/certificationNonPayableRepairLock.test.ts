/**
 * Lock: CERTIFICATION_NON_PAYABLE Review & repair (draft).
 * No production Apply / merge / migrate / deploy from this suite.
 */
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { assertFalse } from "https://deno.land/std@0.224.0/assert/assert_false.ts";
import { fromFileUrl } from "https://deno.land/std@0.224.0/path/from_file_url.ts";
import { join } from "https://deno.land/std@0.224.0/path/join.ts";
import {
  buildCertificationNonPayableProposedColumns,
  CERTIFICATION_NON_PAYABLE_ACTION_LABEL,
  CERTIFICATION_NON_PAYABLE_AUDIT_EVENT,
  CERTIFICATION_NON_PAYABLE_OUTCOME,
  evaluateCertificationNonPayableGuards,
  mk011CertificationFixture,
} from "../../functions/_shared/certificationNonPayableRepairSSOT.ts";
import {
  buildDriverFinancialRepairPreview,
  DRIVER_FINANCIAL_REPAIR_ACTION,
  DRIVER_FINANCIAL_REPAIR_AUDIT_EVENT,
  DRIVER_FINANCIAL_REPAIR_BLOCK,
  DRIVER_FINANCIAL_REPAIR_COPY,
  DRIVER_FINANCIAL_REPAIR_UI_STATUS,
  resolveDriverFinancialRepairUiStatus,
  type DriverFinancialRepairEvidence,
} from "../../functions/_shared/driverFinancialReviewRepairSSOT.ts";
import { resolveFrDriverExpectedEntitlement } from "../../functions/_shared/frDriverExpectedEntitlementSSOT.ts";

const REPO_ROOT = fromFileUrl(new URL("../../..", import.meta.url));

async function read(rel: string): Promise<string> {
  return await Deno.readTextFile(join(REPO_ROOT, rel));
}

function baseEvidence(
  overrides: Partial<DriverFinancialRepairEvidence> = {},
): DriverFinancialRepairEvidence {
  return {
    driver_id: "56136f5f-1a3a-4a14-bb23-439b3951415a",
    driver_name: "Cert Driver",
    driver_code: "MK-DRV-CERT",
    trip_id: "a4305381-2e45-4a44-b64e-8fb5cbe4805d",
    trip_code: "MK-260923-011",
    trip_status: "completed",
    financial_model: "PLATFORM_COLLECTED",
    financial_outcome: null,
    // Owned session absent — repair evidence uses payment_sessions.trip_id
    payment_session_id: null,
    payment_session_lineage_ok: true,
    provider_order_id: null,
    provider_payment_id: null,
    provider_state: null, // UNKNOWN — cert path must bypass only when guards pass
    captured_amount_pence: null,
    final_fare_pence: null,
    commission_basis_pence: null,
    commission_rate_percent: null,
    commission_pence: null,
    tip_pence: 0,
    airport_charge_pence: 0,
    existing_driver_net_pence: null,
    existing_commission_pence: null,
    existing_tip_pence: 0,
    actual_ten_credit_pence: 0,
    actual_tip_credit_pence: 0,
    currency: "GBP",
    expected_currency: null,
    has_contradictory_stamps: false,
    active_payout_reservation: false,
    payout_intent_status: null,
    already_applied_repair_token: null,
    admin_override_driver_net_pence: null,
    certification: mk011CertificationFixture(),
    ...overrides,
  };
}

Deno.test("MK-011 fixture → SAFE_TO_APPLY CERTIFICATION_NON_PAYABLE Preview", () => {
  const guards = evaluateCertificationNonPayableGuards(mk011CertificationFixture());
  assertEquals(guards.ok, true);

  const preview = buildDriverFinancialRepairPreview({
    evidence: baseEvidence(),
    repair_token: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  });
  assertEquals(preview.classification, DRIVER_FINANCIAL_REPAIR_ACTION.CERTIFICATION_NON_PAYABLE);
  assert(preview.apply_allowed);
  assertEquals(preview.expected_driver_entitlement_pence, 0);
  assertEquals(preview.proposed_repair.proven_wallet_delta_pence, 0);
  assertFalse(preview.proposed_repair.wallet_money_changes);
  assertEquals(preview.proposed_repair.canonical_ten_restoration_pence, 0);
  assertEquals(preview.proposed_repair.append_wallet_correction_pence, 0);
  assertEquals(preview.proposed_repair.proposed_stamp?.commission_pct, null);
  assertEquals(
    preview.clear_stale_payment_session_id,
    "bfab32d2-a52d-4f4f-b1a6-596a32b61a95",
  );
  assertEquals(
    preview.clear_stale_payment_session_owner_trip_code,
    "MK-260923-010",
  );
  assertEquals(
    resolveDriverFinancialRepairUiStatus({ preview }),
    DRIVER_FINANCIAL_REPAIR_UI_STATUS.SAFE_TO_APPLY,
  );
});

Deno.test("Wrong session belongs to MK-010 → clear target FK only (proposed columns)", () => {
  const cols = buildCertificationNonPayableProposedColumns({
    clear_payment_session_id: true,
  });
  assertEquals(cols.payment_session_id, null);
  assertEquals(cols.financial_outcome, CERTIFICATION_NON_PAYABLE_OUTCOME);
  assertEquals(cols.driver_net_pence, 0);
  assertEquals(cols.commission_pence, 0);
  // Must NOT invent 0% commission rate
  assertFalse("commission_pct" in cols);
  assertFalse("accepted_commission_percent" in cols);
  assertFalse("driver_tier_commission_percent" in cols);
});

Deno.test("Real £0 promotion trip must not qualify automatically", () => {
  const promo = mk011CertificationFixture({
    booking_source: "customer",
    client_action_id: null,
    passenger_name: "Real Customer",
    pickup_address: "1 High Street",
    dropoff_address: "2 Station Rd",
    estimated_fare: 0,
    fare: 0,
    platform_promotion_subsidy_pence: 500,
    trips_payment_session_id: null,
  });
  const guards = evaluateCertificationNonPayableGuards(promo);
  assertFalse(guards.ok);

  const preview = buildDriverFinancialRepairPreview({
    evidence: baseEvidence({
      certification: promo,
      trip_id: promo.trip_id,
    }),
    repair_token: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  });
  assert(
    preview.classification !== DRIVER_FINANCIAL_REPAIR_ACTION.CERTIFICATION_NON_PAYABLE
      || preview.apply_allowed === false,
  );
});

Deno.test("Real unpaid trip must not qualify", () => {
  const unpaid = mk011CertificationFixture({
    booking_source: "admin",
    client_action_id: null,
    passenger_name: "Unpaid Rider",
    pickup_address: "A",
    dropoff_address: "B",
    estimated_fare: 12.5,
    fare: 12.5,
    final_fare_pence: 1250,
    trips_payment_session_id: null,
  });
  assertFalse(evaluateCertificationNonPayableGuards(unpaid).ok);
});

Deno.test("Missing cert marker blocks", () => {
  const missing = mk011CertificationFixture({
    passenger_name: "Normal Name",
    pickup_address: "Normal Pickup",
    dropoff_address: "Normal Dropoff",
  });
  const g = evaluateCertificationNonPayableGuards(missing);
  assertFalse(g.ok);
  if (!g.ok) assertEquals(g.block_code, "CERT_MARKERS_MISSING");
});

Deno.test("Any non-zero fare/fee/tip blocks", () => {
  assertFalse(evaluateCertificationNonPayableGuards(
    mk011CertificationFixture({ tip_pence: 100 }),
  ).ok);
  assertFalse(evaluateCertificationNonPayableGuards(
    mk011CertificationFixture({ airport_charge_pence: 50 }),
  ).ok);
  assertFalse(evaluateCertificationNonPayableGuards(
    mk011CertificationFixture({ fare: 1 }),
  ).ok);
});

Deno.test("Owned payment session blocks", () => {
  const g = evaluateCertificationNonPayableGuards(
    mk011CertificationFixture({ owned_payment_session_count: 1 }),
  );
  assertFalse(g.ok);
  if (!g.ok) assertEquals(g.block_code, "CERT_OWNED_PAYMENT_SESSION");
});

Deno.test("Wallet/TEN/payout evidence blocks", () => {
  assertFalse(evaluateCertificationNonPayableGuards(
    mk011CertificationFixture({ wallet_or_admin_correction_count: 1 }),
  ).ok);
  assertFalse(evaluateCertificationNonPayableGuards(
    mk011CertificationFixture({ payout_allocation_count: 1 }),
  ).ok);
  assertFalse(evaluateCertificationNonPayableGuards(
    mk011CertificationFixture({ accepted_ride_offer_count: 1 }),
  ).ok);
});

Deno.test("Stale link must prove other-trip ownership", () => {
  const g = evaluateCertificationNonPayableGuards(
    mk011CertificationFixture({
      linked_session_owner_trip_id: "a4305381-2e45-4a44-b64e-8fb5cbe4805d", // same as trip
    }),
  );
  assertFalse(g.ok);
  if (!g.ok) assertEquals(g.block_code, "CERT_STALE_SESSION_OWNER_UNPROVEN");
});

Deno.test("Duplicate Apply → ALREADY_APPLIED (idempotent reject of second mutate)", () => {
  const preview = buildDriverFinancialRepairPreview({
    evidence: baseEvidence({
      financial_outcome: CERTIFICATION_NON_PAYABLE_OUTCOME,
      existing_driver_net_pence: 0,
      certification: mk011CertificationFixture({
        trips_payment_session_id: null,
        financial_outcome: CERTIFICATION_NON_PAYABLE_OUTCOME,
        existing_driver_net_pence: 0,
      }),
    }),
    repair_token: "cccccccc-cccc-cccc-cccc-cccccccccccc",
  });
  assertEquals(preview.classification, DRIVER_FINANCIAL_REPAIR_ACTION.CERTIFICATION_NON_PAYABLE);
  assertFalse(preview.apply_allowed);
  assertEquals(preview.block_code, DRIVER_FINANCIAL_REPAIR_BLOCK.ALREADY_APPLIED);
});

Deno.test("No provider call / no wallet write in proposed repair", () => {
  const preview = buildDriverFinancialRepairPreview({
    evidence: baseEvidence(),
    repair_token: "dddddddd-dddd-dddd-dddd-dddddddddddd",
  });
  assertEquals(preview.proposed_repair.proven_wallet_delta_pence, 0);
  assertFalse(preview.proposed_repair.wallet_money_changes);
  assertEquals(preview.certification_evidence?.provider_action, "none");
  assertEquals(preview.certification_evidence?.payout_action, "none");
  assertEquals(preview.certification_evidence?.no_provider_payment_will_be_changed, true);
});

Deno.test("FR: CERTIFICATION_NON_PAYABLE clears EXPECTED_STAMP_MISSING with entitlement 0", () => {
  const before = resolveFrDriverExpectedEntitlement({
    financial_model: "PLATFORM_COLLECTED",
    financial_outcome: null,
    driver_net_pence: null,
    tip_pence: 0,
    completed_at: "2026-09-23T13:32:02.876Z",
  });
  assertEquals(before.expected_stamp_status, "EXPECTED_STAMP_MISSING");

  const after = resolveFrDriverExpectedEntitlement({
    financial_model: "PLATFORM_COLLECTED",
    financial_outcome: CERTIFICATION_NON_PAYABLE_OUTCOME,
    driver_net_pence: 0,
    tip_pence: 0,
    completed_at: "2026-09-23T13:32:02.876Z",
  });
  assertEquals(after.expected_stamp_status, "OK");
  assertEquals(after.expected_entitlement_pence, 0);
  assertEquals(after.entitlement_source, "certification_non_payable");
});

Deno.test("Copy + audit event names locked", () => {
  assertEquals(
    DRIVER_FINANCIAL_REPAIR_COPY.CERTIFICATION_NON_PAYABLE_ACTION,
    CERTIFICATION_NON_PAYABLE_ACTION_LABEL,
  );
  assertEquals(
    DRIVER_FINANCIAL_REPAIR_COPY.CERTIFICATION_NO_PROVIDER_CHANGE,
    "No provider payment will be changed",
  );
  assertEquals(
    DRIVER_FINANCIAL_REPAIR_AUDIT_EVENT.CERTIFICATION_NON_PAYABLE_MARKED,
    CERTIFICATION_NON_PAYABLE_AUDIT_EVENT.MARKED,
  );
  assertEquals(
    DRIVER_FINANCIAL_REPAIR_AUDIT_EVENT.STALE_PAYMENT_SESSION_LINK_CLEARED,
    CERTIFICATION_NON_PAYABLE_AUDIT_EVENT.STALE_PAYMENT_SESSION_LINK_CLEARED,
  );
});

Deno.test("Edge Apply path: clear FK only; never mutate payment_sessions / MK-010", async () => {
  const edge = await read("supabase/functions/admin-driver-financial-repair/index.ts");
  assert(edge.includes("CERTIFICATION_NON_PAYABLE"));
  assert(edge.includes("STALE_PAYMENT_SESSION_LINK_CLEARED"));
  assert(edge.includes("payment_sessions_row_unchanged"));
  assert(edge.includes("owner_trip_unchanged"));
  // Must not update payment_sessions in cert apply
  const certBlockStart = edge.indexOf("CERTIFICATION_NON_PAYABLE Apply");
  assert(certBlockStart > 0);
  const certBlock = edge.slice(certBlockStart, certBlockStart + 6000);
  assertFalse(certBlock.includes('.from("payment_sessions").update'));
  assertFalse(certBlock.includes("creditCapturedCardTripLedger"));
});

Deno.test("UI shows certification evidence + mandatory reason + SAFE_TO_APPLY gate", async () => {
  const panel = await read("src/components/finance/DriverWalletReviewRepairPanel.tsx");
  assert(panel.includes("review-repair-certification-evidence"));
  assert(panel.includes("CERTIFICATION_NON_PAYABLE_ACTION"));
  assert(panel.includes("CERTIFICATION_NO_PROVIDER_CHANGE"));
  assert(panel.includes("Admin reason (3–500 characters)"));
});

Deno.test("Without certification evidence, PROVIDER_UNKNOWN still blocks", () => {
  const preview = buildDriverFinancialRepairPreview({
    evidence: baseEvidence({ certification: null, provider_state: null }),
    repair_token: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
  });
  assertEquals(
    preview.classification,
    DRIVER_FINANCIAL_REPAIR_ACTION.NO_REPAIR_PROVIDER_UNKNOWN,
  );
  assertFalse(preview.apply_allowed);
});
