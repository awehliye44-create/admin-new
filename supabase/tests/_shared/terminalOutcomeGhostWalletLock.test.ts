/**
 * Terminal-outcome ghost wallet difference lock.
 *
 * ARRIVAL_CANCELLATION / NO_SHOW / LATE_PASSENGER_CANCELLATION:
 *   expected driver entitlement = captured − ACTUAL provider fee, commission 0.
 * The ordinary completed-fare formula (quote driver_net / fare − 15%) must never
 * win classification for these outcomes, even when an obsolete booking stamp
 * (500 / 75 / 425) is still on the trip row.
 *
 * MK-260927-009, MK-261002-014, MK-261002-015: ledger credit 426 (capture 450,
 * ACTUAL fee 24) was correct, but reconciliation trusted the stale 425 stamp and
 * froze the driver as DRIVER_OVER_CREDITED by 1p per trip.
 *
 * If these fail, fix the code — never delete or soften the lock.
 */
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import {
  buildFrDriverSettlementTripRow,
  CANONICAL_TERMINAL_FINANCIAL_OUTCOMES,
  classifyFrDriverFinancialOutcome,
  FR_EXPECTED_STAMP_STATUS,
  FR_FINANCIAL_OUTCOME_CLASS,
  resolveCanonicalTerminalEntitlement,
  resolveFrDriverExpectedEntitlement,
  resolveFrTerminalBeneficiaryDriverId,
} from "../../functions/_shared/frDriverExpectedEntitlementSSOT.ts";
import {
  computeFrDriverReconciliation,
  type FrDriverLedgerRow,
  type FrDriverSettlementTrip,
} from "../../functions/_shared/frDriverReconciliationSSOT.ts";
import {
  buildTerminalOutcomeTripPatch,
  computeTerminalOutcomeEntitlement,
  type TerminalOutcomeKind,
} from "../../functions/_shared/terminalOutcomeEntitlementSSOT.ts";
import {
  buildDriverFinancialRepairPreview,
  computeExpectedStampForRepair,
  DRIVER_FINANCIAL_REPAIR_ACTION,
  DRIVER_FINANCIAL_REPAIR_BLOCK,
  type DriverFinancialRepairEvidence,
} from "../../functions/_shared/driverFinancialReviewRepairSSOT.ts";

const DRIVER = "drv-terminal-beneficiary";
const OTHER_DRIVER = "drv-other";
const TRIP = "trip-terminal-1";
const OUTCOMES: TerminalOutcomeKind[] = [
  "ARRIVAL_CANCELLATION",
  "NO_SHOW",
  "LATE_PASSENGER_CANCELLATION",
];

const FN_ROOT = new URL("../../functions/", import.meta.url);
const readFn = (rel: string) => Deno.readTextFileSync(new URL(rel, FN_ROOT));

/** Obsolete booking quote stamp left on the row: 500 fare, 75 commission (15%), 425 net. */
function staleTerminalTrip(outcome: string, overrides: Record<string, unknown> = {}) {
  return {
    id: TRIP,
    trip_code: "MK-261002-014",
    status: outcome === "NO_SHOW" ? "no_show" : "cancelled",
    financial_outcome: outcome,
    financial_model: "PLATFORM_COLLECTED",
    driver_id: DRIVER,
    confirmed_driver_id: null,
    previous_driver_id: null,
    final_fare_pence: 500,
    gross_fare_pence: 500,
    commission_pence: 75,
    commission_pct: 15,
    driver_net_pence: 425,
    provider_fee_pence: null,
    capture_amount_pence: null,
    tip_pence: 0,
    tip_amount_pence: 0,
    airport_charge_pence: 0,
    customer_modification_charge_pence: 0,
    completed_at: null,
    ...overrides,
  };
}

function actualFeeSession(overrides: Record<string, unknown> = {}) {
  return {
    trip_id: TRIP,
    status: "captured",
    captured_amount_pence: 450,
    provider_processing_fee_pence: 24,
    fee_status: "ACTUAL",
    captured_at: "2026-10-02T12:00:00.000Z",
    ...overrides,
  };
}

function reconcile(trips: FrDriverSettlementTrip[], ledger: FrDriverLedgerRow[]) {
  return computeFrDriverReconciliation({
    ledger,
    settledTrips: trips,
    completedPayoutItems: [],
    walletEvidenceAvailable: true,
    settlementEvidenceAvailable: true,
    identityMappingValid: true,
    accountVerified: true,
    finance_cleared_pence: 0,
    provider_account_balance_pence: null,
    provider_account_balance_status: "NOT_APPLICABLE",
    payout_provider: "revolut",
    query_scope_status: "LIFETIME",
  });
}

const ten = (amount: number, tripId = TRIP): FrDriverLedgerRow => ({
  type: "TRIP_EARNING_NET",
  amount_pence: amount,
  related_trip_id: tripId,
});

// ---------------------------------------------------------------------------
// Reconciliation: canonical terminal outcomes win over the obsolete stamp.
// ---------------------------------------------------------------------------

for (const outcome of OUTCOMES) {
  Deno.test(`${outcome}: capture 450, ACTUAL fee 24, ledger 426, stale stamp 425 → variance 0`, () => {
    const row = buildFrDriverSettlementTripRow({
      trip: staleTerminalTrip(outcome),
      session: actualFeeSession(),
      actual_wallet_trip_credit_pence: 426,
      evaluated_driver_id: DRIVER,
    });
    const fr = reconcile([row], [ten(426)]);
    assertEquals(fr.expected_payable_pence, 426);
    assertEquals(fr.actual_wallet_trip_credits_pence, 426);
    assertEquals(fr.wallet_variance_pence, 0);
    assertEquals(fr.driver_credit_status, "DRIVER_CREDIT_OK");
    assertNotEquals(fr.driver_credit_status, "DRIVER_OVER_CREDITED");
  });

  Deno.test(`${outcome}: expected entitlement ignores driver_net / commission / final fare stamps`, () => {
    const r = resolveFrDriverExpectedEntitlement({
      financial_outcome: outcome,
      trip_status: outcome === "NO_SHOW" ? "no_show" : "cancelled",
      driver_net_pence: 425,
      commission_pence: 75,
      final_fare_pence: 500,
      provider_fee_pence: null,
      captured_amount_pence: 450,
      provider_processing_fee_pence: 24,
      provider_fee_status: "ACTUAL",
      tip_pence: 0,
    });
    assertEquals(r.expected_stamp_status, FR_EXPECTED_STAMP_STATUS.OK);
    assertEquals(r.expected_entitlement_pence, 426);
    assertEquals(r.entitlement_source, "terminal_fee_capture_minus_provider_fee");
    assertEquals(r.is_terminal_fee_outcome, true);
    assertNotEquals(r.expected_entitlement_pence, 425);
  });

  Deno.test(`${outcome}: classified TERMINAL_FEE before fare-settlement evidence`, () => {
    const c = classifyFrDriverFinancialOutcome({
      financial_outcome: outcome,
      trip_status: "completed",
      driver_net_pence: 425,
      commission_pence: 75,
      final_fare_pence: 500,
      fare_trip_earning_net_count: 1,
      fare_trip_earning_net_pence: 425,
    });
    assertEquals(c.class, FR_FINANCIAL_OUTCOME_CLASS.TERMINAL_FEE);
  });

  Deno.test(`${outcome}: missing capture fails closed (EXPECTED_STAMP_MISSING, never 0)`, () => {
    const r = resolveFrDriverExpectedEntitlement({
      financial_outcome: outcome,
      driver_net_pence: 425,
      captured_amount_pence: null,
      provider_processing_fee_pence: 24,
      provider_fee_status: "ACTUAL",
    });
    assertEquals(r.expected_stamp_status, FR_EXPECTED_STAMP_STATUS.EXPECTED_STAMP_MISSING);
    assertEquals(r.expected_entitlement_pence, null);
  });

  for (const feeStatus of [null, "ESTIMATED", "PENDING", "UNKNOWN"]) {
    Deno.test(`${outcome}: provider fee status ${feeStatus} is not authoritative → EXPECTED_STAMP_MISSING`, () => {
      const r = resolveFrDriverExpectedEntitlement({
        financial_outcome: outcome,
        driver_net_pence: 425,
        captured_amount_pence: 450,
        provider_processing_fee_pence: 24,
        provider_fee_status: feeStatus,
      });
      assertEquals(r.expected_stamp_status, FR_EXPECTED_STAMP_STATUS.EXPECTED_STAMP_MISSING);
      assertEquals(r.expected_entitlement_pence, null);
    });
  }

  Deno.test(`${outcome}: ACTUAL status with null fee amount → EXPECTED_STAMP_MISSING`, () => {
    const r = resolveFrDriverExpectedEntitlement({
      financial_outcome: outcome,
      captured_amount_pence: 450,
      provider_processing_fee_pence: null,
      provider_fee_status: "ACTUAL",
    });
    assertEquals(r.expected_stamp_status, FR_EXPECTED_STAMP_STATUS.EXPECTED_STAMP_MISSING);
  });

  Deno.test(`${outcome}: reconciliation SSOT equals terminal settlement SSOT`, () => {
    for (const [captured, fee] of [[450, 24], [400, 24], [500, 0], [1, 0], [300, 299]]) {
      const settle = computeTerminalOutcomeEntitlement({
        payment_session_id: "ps",
        captured_pence: captured,
        provider_fee_pence: fee,
        provider_fee_confirmed: true,
      });
      const fr = resolveCanonicalTerminalEntitlement({
        captured_pence: captured,
        provider_fee_pence: fee,
        provider_fee_status: "ACTUAL",
      });
      assertEquals(fr.entitlement_pence, settle.expected_driver_entitlement_pence, `${captured}/${fee}`);
      assertEquals(fr.commission_pence, 0);
      assertEquals(settle.commission_pence, 0);
    }
  });
}

Deno.test("canonical terminal set is exactly the three chargeable outcomes", () => {
  assertEquals(
    [...CANONICAL_TERMINAL_FINANCIAL_OUTCOMES].sort(),
    ["ARRIVAL_CANCELLATION", "LATE_PASSENGER_CANCELLATION", "NO_SHOW"],
  );
});

Deno.test("terminal outcome is NOT inferred from status alone", () => {
  for (const status of ["no_show", "cancelled"]) {
    const c = classifyFrDriverFinancialOutcome({
      financial_outcome: null,
      trip_status: status,
      driver_net_pence: 425,
      commission_pence: 75,
      final_fare_pence: 500,
    });
    assertNotEquals(c.reason, "canonical_terminal_financial_outcome", status);
    const r = resolveFrDriverExpectedEntitlement({
      financial_outcome: null,
      trip_status: status,
      driver_net_pence: 425,
      captured_amount_pence: 450,
      provider_processing_fee_pence: 24,
      provider_fee_status: "ACTUAL",
    });
    assertNotEquals(r.entitlement_source, "terminal_fee_capture_minus_provider_fee", status);
  }
});

Deno.test("completed normal trip keeps the ordinary fare formula", () => {
  const r = resolveFrDriverExpectedEntitlement({
    financial_outcome: "COMPLETED",
    trip_status: "completed",
    driver_net_pence: 1700,
    commission_pence: 300,
    final_fare_pence: 2000,
    captured_amount_pence: 2000,
    provider_processing_fee_pence: 24,
    provider_fee_status: "ACTUAL",
    fare_trip_earning_net_count: 1,
    fare_trip_earning_net_pence: 1700,
    tip_pence: 0,
  });
  assertEquals(r.expected_stamp_status, FR_EXPECTED_STAMP_STATUS.OK);
  assertEquals(r.expected_entitlement_pence, 1700);
  assertEquals(r.is_terminal_fee_outcome, false);
  assertNotEquals(r.entitlement_source, "terminal_fee_capture_minus_provider_fee");
});

Deno.test("CANCELLED_NO_FEE has no entitlement even with a stale quote stamp", () => {
  const r = resolveFrDriverExpectedEntitlement({
    financial_outcome: "CANCELLED_NO_FEE",
    trip_status: "cancelled",
    driver_net_pence: 425,
    commission_pence: 75,
    final_fare_pence: 500,
    captured_amount_pence: 450,
    provider_processing_fee_pence: 24,
    provider_fee_status: "ACTUAL",
  });
  assertEquals(r.expected_stamp_status, FR_EXPECTED_STAMP_STATUS.OK);
  assertEquals(r.expected_entitlement_pence, 0);
  assertEquals(r.entitlement_source, "cancelled_no_fee_no_entitlement");
});

Deno.test("legacy CANCELLED_WITH_FEE formula is unchanged (capture − commission)", () => {
  const r = resolveFrDriverExpectedEntitlement({
    financial_outcome: "CANCELLED_WITH_FEE",
    trip_status: "cancelled",
    captured_amount_pence: 500,
    commission_pence: 75,
    driver_net_pence: 425,
  });
  assertEquals(r.entitlement_source, "terminal_fee_capture_minus_commission");
  assertEquals(r.expected_entitlement_pence, 425);
});

// ---------------------------------------------------------------------------
// Freeze: obsolete stamps never freeze; real variance still does.
// ---------------------------------------------------------------------------

Deno.test("freeze: 1p REAL over-credit on a terminal trip stays DRIVER_OVER_CREDITED", () => {
  const row = buildFrDriverSettlementTripRow({
    trip: staleTerminalTrip("NO_SHOW"),
    session: actualFeeSession(),
    actual_wallet_trip_credit_pence: 427,
    evaluated_driver_id: DRIVER,
  });
  const fr = reconcile([row], [ten(427)]);
  assertEquals(fr.expected_payable_pence, 426);
  assertEquals(fr.wallet_variance_pence, 1);
  assertEquals(fr.driver_credit_status, "DRIVER_OVER_CREDITED");
});

Deno.test("freeze: 1p REAL under-credit on a terminal trip stays DRIVER_UNDER_CREDITED", () => {
  const row = buildFrDriverSettlementTripRow({
    trip: staleTerminalTrip("ARRIVAL_CANCELLATION"),
    session: actualFeeSession(),
    actual_wallet_trip_credit_pence: 425,
    evaluated_driver_id: DRIVER,
  });
  const fr = reconcile([row], [ten(425)]);
  assertEquals(fr.wallet_variance_pence, -1);
  assertEquals(fr.driver_credit_status, "DRIVER_UNDER_CREDITED");
});

Deno.test("freeze: three correct terminal credits with stale stamps never accumulate a ghost", () => {
  const trips = ["t9", "t14", "t15"].map((id, i) =>
    buildFrDriverSettlementTripRow({
      trip: staleTerminalTrip(OUTCOMES[i]!, {
        id,
        driver_net_pence: i === 0 ? 340 : 425,
        commission_pence: i === 0 ? 60 : 75,
        final_fare_pence: i === 0 ? 400 : 500,
      }),
      session: actualFeeSession({ trip_id: id, captured_amount_pence: i === 0 ? 400 : 450 }),
      actual_wallet_trip_credit_pence: i === 0 ? 376 : 426,
      evaluated_driver_id: DRIVER,
    })
  );
  const fr = reconcile(trips, [ten(376, "t9"), ten(426, "t14"), ten(426, "t15")]);
  assertEquals(fr.expected_payable_pence, 1228);
  assertEquals(fr.wallet_variance_pence, 0);
  assertEquals(fr.driver_credit_status, "DRIVER_CREDIT_OK");
});

// ---------------------------------------------------------------------------
// Beneficiary: driver_id legitimately cleared, previous_driver_id qualifies.
// ---------------------------------------------------------------------------

Deno.test("beneficiary: driver_id NULL + previous_driver_id → reconciliation credits that driver", () => {
  const trip = staleTerminalTrip("NO_SHOW", { driver_id: null, previous_driver_id: DRIVER });
  assertEquals(resolveFrTerminalBeneficiaryDriverId(trip), DRIVER);
  const row = buildFrDriverSettlementTripRow({
    trip,
    session: actualFeeSession(),
    actual_wallet_trip_credit_pence: 426,
    evaluated_driver_id: DRIVER,
  });
  const fr = reconcile([row], [ten(426)]);
  assertEquals(fr.expected_payable_pence, 426);
  assertEquals(fr.wallet_variance_pence, 0);
});

Deno.test("beneficiary: another driver's wallet never inherits the terminal entitlement", () => {
  const trip = staleTerminalTrip("NO_SHOW", { driver_id: null, previous_driver_id: DRIVER });
  const row = buildFrDriverSettlementTripRow({
    trip,
    session: actualFeeSession(),
    actual_wallet_trip_credit_pence: 0,
    evaluated_driver_id: OTHER_DRIVER,
  });
  assertEquals(row.expected_entitlement_pence, 0);
  // A credit wrongly posted to the other driver stays a REAL over-credit.
  const wrongRow = buildFrDriverSettlementTripRow({
    trip,
    session: actualFeeSession(),
    actual_wallet_trip_credit_pence: 426,
    evaluated_driver_id: OTHER_DRIVER,
  });
  const fr = reconcile([wrongRow], [ten(426)]);
  assertEquals(fr.wallet_variance_pence, 426);
  assertEquals(fr.driver_credit_status, "DRIVER_OVER_CREDITED");
});

Deno.test("beneficiary: confirmed_driver_id outranks driver_id and previous_driver_id", () => {
  assertEquals(
    resolveFrTerminalBeneficiaryDriverId({
      confirmed_driver_id: DRIVER,
      driver_id: OTHER_DRIVER,
      previous_driver_id: "drv-prev",
    }),
    DRIVER,
  );
});

// ---------------------------------------------------------------------------
// Repair tool: same terminal SSOT, never fare − 15%.
// ---------------------------------------------------------------------------

function terminalRepairEvidence(
  outcome: string,
  overrides: Partial<DriverFinancialRepairEvidence> = {},
): DriverFinancialRepairEvidence {
  return {
    driver_id: DRIVER,
    driver_name: "Terminal Driver",
    driver_code: "MK0007",
    trip_id: TRIP,
    trip_code: "MK-261002-014",
    trip_status: outcome === "NO_SHOW" ? "no_show" : "cancelled",
    financial_model: "PLATFORM_COLLECTED",
    financial_outcome: outcome,
    payment_session_id: "ps-1",
    payment_session_lineage_ok: true,
    provider_order_id: "ord-1",
    provider_payment_id: "pay-1",
    provider_state: "CAPTURED",
    captured_amount_pence: 450,
    final_fare_pence: 450,
    commission_basis_pence: 450,
    commission_rate_percent: 0,
    commission_rule_source: "terminal_outcome_commission_zero",
    commission_pence: 0,
    provider_fee_pence: 24,
    provider_processing_fee_pence: 24,
    provider_fee_status: "ACTUAL",
    tip_pence: 0,
    airport_charge_pence: 0,
    existing_driver_net_pence: 425,
    existing_commission_pence: 75,
    existing_tip_pence: 0,
    actual_ten_credit_pence: 426,
    actual_tip_credit_pence: 0,
    currency: "GBP",
    expected_currency: "GBP",
    has_contradictory_stamps: false,
    active_payout_reservation: false,
    payout_intent_status: null,
    ...overrides,
  };
}

for (const outcome of OUTCOMES) {
  Deno.test(`repair preview ${outcome}: 426 expected, variance 0, no money movement`, () => {
    const p = buildDriverFinancialRepairPreview({
      evidence: terminalRepairEvidence(outcome),
      repair_token: "tok-1",
      derived_frozen: true,
    });
    assertEquals(p.classification, DRIVER_FINANCIAL_REPAIR_ACTION.RECOMPUTE_RECONCILIATION);
    assertEquals(p.expected_driver_entitlement_pence, 426);
    assertEquals(p.variance_pence, 0);
    assertEquals(p.proposed_repair.canonical_ten_restoration_pence, 0);
    assertEquals(p.proposed_repair.append_wallet_correction_pence, 0);
    assertEquals(p.proposed_repair.proven_wallet_delta_pence, 0);
    assertEquals(p.proposed_repair.wallet_money_changes, false);
    assertNotEquals(p.expected_driver_entitlement_pence, 425);
  });

  Deno.test(`repair preview ${outcome}: never proposes fare − 15% even when commission evidence says 15%`, () => {
    const p = buildDriverFinancialRepairPreview({
      evidence: terminalRepairEvidence(outcome, {
        existing_driver_net_pence: null,
        existing_commission_pence: null,
        final_fare_pence: 500,
        commission_basis_pence: 500,
        commission_rate_percent: 15,
        commission_pence: 75,
        commission_rule_source: "ride_offers.effective_commission_percent",
      }),
      repair_token: "tok-2",
    });
    assertEquals(p.expected_driver_entitlement_pence, 426);
    const stamp = p.proposed_repair.proposed_stamp!;
    assertEquals(stamp.driver_net_pence, 426);
    assertEquals(stamp.commission_pence, 0);
    assertEquals(stamp.commission_pct, 0);
    assertEquals(stamp.provider_fee_pence, 24);
    assertEquals(stamp.final_fare_pence, 450);
  });

  Deno.test(`repair stamp ${outcome}: columns equal the certified terminal trip patch`, () => {
    const r = computeExpectedStampForRepair(terminalRepairEvidence(outcome, { existing_driver_net_pence: null }));
    assert(r.ok);
    const patch = buildTerminalOutcomeTripPatch({
      outcome,
      entitlement: computeTerminalOutcomeEntitlement({
        payment_session_id: "ps-1",
        captured_pence: 450,
        provider_fee_pence: 24,
        provider_fee_confirmed: true,
      }),
      nowIso: "1970-01-01T00:00:00.000Z",
    })!;
    for (const key of ["status", "financial_outcome", "payment_method", "updated_at"]) delete patch[key];
    assertEquals(r.stamp.columns, patch);
    assertEquals(r.expected_credit_pence, 426);
  });

  Deno.test(`repair ${outcome}: non-ACTUAL fee blocks as insufficient evidence (no invented zero)`, () => {
    const p = buildDriverFinancialRepairPreview({
      evidence: terminalRepairEvidence(outcome, { provider_fee_status: "ESTIMATED" }),
      repair_token: "tok-3",
    });
    assertEquals(p.classification, DRIVER_FINANCIAL_REPAIR_ACTION.NO_REPAIR_INSUFFICIENT_EVIDENCE);
    assertEquals(p.block_code, DRIVER_FINANCIAL_REPAIR_BLOCK.INSUFFICIENT_EVIDENCE);
    assertEquals(p.expected_driver_entitlement_pence, null);
    assertEquals(p.apply_allowed, false);
  });

  Deno.test(`repair ${outcome}: real 1p over-credit stays visible as residual correction`, () => {
    const p = buildDriverFinancialRepairPreview({
      evidence: terminalRepairEvidence(outcome, { actual_ten_credit_pence: 427 }),
      repair_token: "tok-4",
    });
    assertEquals(p.variance_pence, -1);
    assertNotEquals(p.classification, DRIVER_FINANCIAL_REPAIR_ACTION.RECOMPUTE_RECONCILIATION);
  });
}

Deno.test("repair: completed trip keeps the ordinary commission formula", () => {
  const p = buildDriverFinancialRepairPreview({
    evidence: terminalRepairEvidence("COMPLETED", {
      trip_status: "completed",
      captured_amount_pence: 2000,
      final_fare_pence: 2000,
      commission_basis_pence: 2000,
      commission_rate_percent: 15,
      commission_pence: 300,
      commission_rule_source: "ride_offers.effective_commission_percent",
      provider_fee_pence: 0,
      existing_driver_net_pence: null,
      existing_commission_pence: null,
      actual_ten_credit_pence: 1700,
    }),
    repair_token: "tok-5",
  });
  assertEquals(p.expected_driver_entitlement_pence, 1700);
  assertEquals(p.proposed_repair.proposed_stamp?.commission_pence, 300);
});

Deno.test("repair endpoint: terminal beneficiary uses previous_driver_id only for canonical terminal outcomes", () => {
  const src = readFn("admin-driver-financial-repair/index.ts");
  assert(src.includes("confirmed_driver_id"), "trip select must load confirmed_driver_id");
  assert(src.includes("previous_driver_id"), "trip select must load previous_driver_id");
  assert(
    /isCanonicalTerminalFinancialOutcome\([\s\S]{0,200}\)[\s\S]{0,120}\?\s*resolveTerminalEntitledDriverId\(/.test(src),
    "beneficiary must come from resolveTerminalEntitledDriverId only when the outcome is a canonical terminal",
  );
  assert(
    /:\s*\(String\(trip\.driver_id \?\? ""\) \|\| null\)/.test(src),
    "non-terminal trips must keep the strict driver_id match",
  );
  assert(src.includes("TRIP_DRIVER_MISMATCH"));
});

Deno.test("reconciliation snapshot: previous_driver_id rows are scoped to canonical terminal outcomes", () => {
  const src = readFn("_shared/fetchDriverWalletPayoutSnapshot.ts");
  assert(
    /\.eq\("previous_driver_id", [\s\S]{0,40}\)[\s\S]{0,80}\.is\("driver_id", null\)[\s\S]{0,80}\.in\("financial_outcome", \[\.\.\.CANONICAL_TERMINAL_FINANCIAL_OUTCOMES\]\)/
      .test(src),
    "previous_driver_id is only honoured for canonical terminal outcomes with driver_id cleared",
  );
  assert(src.includes("resolveFrTerminalBeneficiaryDriverId"));
});

// ---------------------------------------------------------------------------
// Restamp stays the first safety layer.
// ---------------------------------------------------------------------------

Deno.test("restamp: every terminal posting path stamps the trip before posting the credit", () => {
  for (const rel of [
    "_shared/terminalFeeSettlementResumptionSSOT.ts",
    "_shared/noShowSettlement.ts",
    "_shared/canonicalTypedWalletPostingSSOT.ts",
  ]) {
    const src = readFn(rel);
    const stampAt = src.indexOf("stampTerminalOutcomeTripRow({");
    const postAt = src.indexOf("postTerminalEntitlementFromSettlement({");
    assert(stampAt > 0, `${rel}: stampTerminalOutcomeTripRow must remain`);
    assert(postAt > stampAt, `${rel}: stamp must precede the wallet posting`);
  }
});

Deno.test("restamp: failures emit TERMINAL_TRIP_STAMP_FAILED operational evidence", () => {
  const src = readFn("_shared/terminalOutcomeEntitlementSSOT.ts");
  assert(src.includes('TERMINAL_TRIP_STAMP_FAILED_EVENT = "TERMINAL_TRIP_STAMP_FAILED"'));
  assert(/from\("ops_events"\)\.insert\(\{\s*event_type: TERMINAL_TRIP_STAMP_FAILED_EVENT/.test(src));
});
