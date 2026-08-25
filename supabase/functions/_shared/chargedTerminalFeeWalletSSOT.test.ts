/**
 * Lock: charged terminal fee wallet SSOT
 * (TEN = captured − known provider fee, commission 0; provider fee unknown → fail closed).
 * Run: deno test --allow-read supabase/functions/_shared/chargedTerminalFeeWalletSSOT.test.ts
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildChargedFeeTenLedgerInsert,
  buildFeeCapturePaymentSessionPatch,
  disposeOutcomeIndicatesFeeCapture,
  isChargedFeeOutcome,
  mapFeeTypeToChargedOutcome,
  readKnownProviderFeePence,
  resolveAirportProtectionCancelFee,
  resolveAssignedDriverId,
  resolveChargedTerminalFeeEntitlement,
  resolveUnambiguousEvidenceDriverId,
} from "./chargedTerminalFeeWalletSSOT.ts";
import { classifyMissingTen, MISSING_TEN_CLASS } from "./missingTripEarningNetDetectSSOT.ts";
import { resolveTerminalPaymentDecision } from "./terminalFeeDecisionSSOT.ts";

const rfoPath = new URL("../record-financial-outcome/index.ts", import.meta.url);
const cancelPath = new URL("../cancel-trip/index.ts", import.meta.url);
const disposePath = new URL("./terminalTripPaymentDisposition.ts", import.meta.url);
const feeDecisionPath = new URL("./terminalFeeDecisionSSOT.ts", import.meta.url);

Deno.test("no-show 400p − provider fee 20p → TEN 380p, commission 0", () => {
  const e = resolveChargedTerminalFeeEntitlement({
    outcome: "NO_SHOW",
    feePence: 400,
    providerFeePence: 20,
    feeStatus: "ACTUAL",
  });
  assertEquals(e.ok, true);
  if (!e.ok) return;
  assertEquals(e.captured_fee_pence, 400);
  assertEquals(e.provider_fee_pence, 20);
  assertEquals(e.driver_net_pence, 380);
  assertEquals(e.commission_pence, 0);
  assertEquals(e.commission_pct, 0);
  const row = buildChargedFeeTenLedgerInsert({
    driverId: "cd8bae4c-3827-4b90-98c6-10be70eb0e52",
    tripId: "648a1be3-59ea-46a1-94c4-6258c6c00dba",
    feePence: e.driver_net_pence,
    currency: "GBP",
    outcome: "NO_SHOW",
    capturedFeePence: e.captured_fee_pence,
    providerFeePence: e.provider_fee_pence,
  });
  assertEquals(row.type, "TRIP_EARNING_NET");
  assertEquals(row.amount_pence, 380);
  assertEquals(row.driver_id, "cd8bae4c-3827-4b90-98c6-10be70eb0e52");
  assertStringIncludes(String(row.description), "400p");
  assertStringIncludes(String(row.description), "20p");
});

Deno.test("no-show 400p − ACQUIRING 24p → TEN 376p, commission 0 (canary shape)", () => {
  const e = resolveChargedTerminalFeeEntitlement({
    outcome: "NO_SHOW",
    feePence: 400,
    providerFeePence: 24,
    feeStatus: "ACTUAL",
  });
  assertEquals(e.ok, true);
  if (!e.ok) return;
  assertEquals(e.driver_net_pence, 376);
  assertEquals(e.commission_pence, 0);
  assertEquals(e.provider_fee_pence, 24);
  const patch = buildFeeCapturePaymentSessionPatch({
    authPence: 480,
    capturedFeePence: 400,
    providerState: "COMPLETED",
    capturedAtIso: "2026-08-24T12:00:00.000Z",
  });
  assertEquals(patch.captured_amount_pence, 400);
  assertEquals(patch.released_amount_pence, 80);
  assertEquals(patch.status, "captured");
  assertEquals(patch.financial_operation_state, "CAPTURED");
});

Deno.test("late cancel 500p − provider fee 25p → TEN 475p, commission 0", () => {
  const e = resolveChargedTerminalFeeEntitlement({
    outcome: "LATE_PASSENGER_CANCELLATION",
    feePence: 500,
    providerFeePence: 25,
    feeStatus: "ACTUAL",
  });
  assertEquals(e.ok, true);
  if (!e.ok) return;
  assertEquals(e.driver_net_pence, 475);
  assertEquals(e.commission_pence, 0);
  assertEquals(e.revenue_type, "late_cancellation_revenue");
  const row = buildChargedFeeTenLedgerInsert({
    driverId: "d1",
    tripId: "t1",
    feePence: e.driver_net_pence,
    currency: "GBP",
    outcome: "LATE_PASSENGER_CANCELLATION",
    capturedFeePence: 500,
    providerFeePence: 25,
  });
  assertEquals(row.amount_pence, 475);
  assertStringIncludes(String(row.description), "late cancellation");
});

Deno.test("airport protection 2500p − provider fee 100p → TEN 2400p", () => {
  const e = resolveChargedTerminalFeeEntitlement({
    outcome: "AIRPORT_PROTECTION_CANCELLATION",
    feePence: 2500,
    providerFeePence: 100,
    feeStatus: "ACTUAL",
  });
  assertEquals(e.ok, true);
  if (!e.ok) return;
  assertEquals(e.driver_net_pence, 2400);
  assertEquals(e.commission_pence, 0);
  assertEquals(e.revenue_type, "airport_protection_revenue");
  assertEquals(mapFeeTypeToChargedOutcome("airport_protection"), "AIRPORT_PROTECTION_CANCELLATION");
  assertEquals(isChargedFeeOutcome("AIRPORT_PROTECTION_CANCELLATION"), true);
});

Deno.test("fee_status not ACTUAL with pence present → fail closed", () => {
  const pending = resolveChargedTerminalFeeEntitlement({
    outcome: "NO_SHOW",
    feePence: 400,
    providerFeePence: 20,
    feeStatus: "PENDING",
  });
  assertEquals(pending.ok, false);
  if (!pending.ok) assertEquals(pending.reason, "provider_fee_unknown");
  const nullStatus = resolveChargedTerminalFeeEntitlement({
    outcome: "NO_SHOW",
    feePence: 400,
    providerFeePence: 20,
    feeStatus: null,
  });
  assertEquals(nullStatus.ok, false);
});

Deno.test("provider fee missing → fail closed (never invent)", () => {
  const e = resolveChargedTerminalFeeEntitlement({
    outcome: "NO_SHOW",
    feePence: 400,
    providerFeePence: null,
    feeStatus: "ACTUAL",
  });
  assertEquals(e.ok, false);
  if (e.ok) return;
  assertEquals(e.reason, "provider_fee_unknown");
  assertEquals(readKnownProviderFeePence(null), null);
  assertEquals(readKnownProviderFeePence(undefined), null);
  assertEquals(readKnownProviderFeePence(""), null);
  assertEquals(readKnownProviderFeePence(0), 0);
});

Deno.test("provider fee ≥ captured → fail closed non-positive TEN", () => {
  const e = resolveChargedTerminalFeeEntitlement({
    outcome: "NO_SHOW",
    feePence: 400,
    providerFeePence: 400,
    feeStatus: "ACTUAL",
  });
  assertEquals(e.ok, false);
  if (e.ok) return;
  assertEquals(e.reason, "driver_ten_non_positive");
});

Deno.test("released zero capture / non-fee outcome → no entitlement", () => {
  assertEquals(
    resolveChargedTerminalFeeEntitlement({
      outcome: "CANCELLED_NO_FEE",
      feePence: 0,
      providerFeePence: 0,
      feeStatus: "ACTUAL",
    }).ok,
    false,
  );
  assertEquals(
    resolveChargedTerminalFeeEntitlement({
      outcome: "NO_SHOW",
      feePence: 0,
      providerFeePence: 0,
      feeStatus: "ACTUAL",
    }).ok,
    false,
  );
});

Deno.test("resolveAirportProtectionCancelFee: 50% of fare when journey started", () => {
  const r = resolveAirportProtectionCancelFee({
    config: {
      late_cancel_airport_protection_enabled: true,
      late_cancel_airport_fare_threshold_pence: 2000,
      late_cancel_airport_fee_type: "PERCENTAGE",
      late_cancel_airport_fee_percentage: 50,
      late_cancel_airport_protection_trigger: "AFTER_DRIVER_STARTED_JOURNEY",
    },
    driverStartedJourneyToPickupAt: "2026-08-24T10:00:00Z",
    estimatedFarePence: 4800,
    arrivedAt: null,
  });
  assertEquals(r.applies, true);
  assertEquals(r.feePence, 2400);
  assertEquals(r.percentage, 50);
  assertEquals(r.reason, "airport_protection");
});

Deno.test("resolveAirportProtectionCancelFee: rejects below threshold / arrived / disabled", () => {
  const base = {
    late_cancel_airport_protection_enabled: true,
    late_cancel_airport_fare_threshold_pence: 3000,
    late_cancel_airport_fee_type: "PERCENTAGE",
    late_cancel_airport_fee_percentage: 50,
    late_cancel_airport_protection_trigger: "AFTER_DRIVER_STARTED_JOURNEY",
  };
  assertEquals(
    resolveAirportProtectionCancelFee({
      config: base,
      driverStartedJourneyToPickupAt: "2026-08-24T10:00:00Z",
      estimatedFarePence: 2999,
      arrivedAt: null,
    }).applies,
    false,
  );
  assertEquals(
    resolveAirportProtectionCancelFee({
      config: base,
      driverStartedJourneyToPickupAt: "2026-08-24T10:00:00Z",
      estimatedFarePence: 4800,
      arrivedAt: "2026-08-24T10:05:00Z",
    }).reason,
    "already_arrived",
  );
  assertEquals(
    resolveAirportProtectionCancelFee({
      config: { ...base, late_cancel_airport_protection_enabled: false },
      driverStartedJourneyToPickupAt: "2026-08-24T10:00:00Z",
      estimatedFarePence: 4800,
    }).reason,
    "disabled",
  );
});

Deno.test('mapFeeTypeToChargedOutcome("none") returns null', () => {
  assertEquals(mapFeeTypeToChargedOutcome("none"), null);
  assertEquals(mapFeeTypeToChargedOutcome(""), null);
  assertEquals(mapFeeTypeToChargedOutcome(null), null);
});

Deno.test("terminal decision: airport protection beats late cancel when pre-arrival journey started", () => {
  const d = resolveTerminalPaymentDecision({
    evidence: {
      trip_id: "t1",
      trip_status: "cancelled",
      started_at: null,
      arrived_at: null,
      free_wait_expires_at: null,
      cancelled_at: "2026-08-24T10:30:00Z",
      cancelled_by: "customer",
      scheduled_at: "2026-08-24T11:00:00Z",
      cancellation_grace_expires_at: null,
      driver_id: "d1",
      confirmed_driver_id: "d1",
      driver_started_journey_to_pickup_at: "2026-08-24T10:00:00Z",
      estimated_fare_pence: 4800,
      no_show_recorded: false,
      authorised_amount_pence: 4800,
      previously_captured_amount_pence: 0,
      payment_session_id: "ps1",
      provider: "revolut",
      decision_at: "2026-08-24T10:30:00Z",
    },
    config: {
      cancellation_fee_pence: 200,
      cancellation_grace_period_minutes: 5,
      cancellation_apply_after_arrival_only: false,
      no_show_fee_pence: 400,
      no_show_wait_time_minutes: 5,
      no_show_apply_after_arrival_only: true,
      late_cancel_enabled: true,
      late_cancel_threshold_minutes: 60,
      late_cancel_fee_pence: 500,
      arrival_cancellation_enabled: false,
      arrival_cancellation_fee_pence: null,
      arrival_cancellation_apply_after_free_waiting_expired: null,
      arrival_cancellation_after_arrival_only: null,
      free_waiting_minutes: null,
      late_cancel_airport_protection_enabled: true,
      late_cancel_airport_fare_threshold_pence: 2000,
      late_cancel_airport_fee_type: "PERCENTAGE",
      late_cancel_airport_fee_percentage: 50,
      late_cancel_airport_protection_trigger: "AFTER_DRIVER_STARTED_JOURNEY",
    },
    feePolicyId: "fps1",
  });
  assertEquals(d.disposition_reason, "AIRPORT_PROTECTION_CANCELLATION");
  assertEquals(d.fee_type, "airport_protection");
  assertEquals(d.fee_amount_pence, 2400);
  assertEquals(d.provider_action, "partial_capture_fee");
});

Deno.test("generic CANCELLED_WITH_FEE is charged terminal (commission 0)", () => {
  const e = resolveChargedTerminalFeeEntitlement({
    outcome: "CANCELLED_WITH_FEE",
    feePence: 350,
    providerFeePence: 10,
    feeStatus: "ACTUAL",
  });
  assertEquals(e.ok, true);
  if (!e.ok) return;
  assertEquals(e.driver_net_pence, 340);
  assertEquals(e.commission_pence, 0);
  assertEquals(mapFeeTypeToChargedOutcome("cancellation"), "CANCELLED_WITH_FEE");
  assertEquals(mapFeeTypeToChargedOutcome("late_cancellation"), "LATE_PASSENGER_CANCELLATION");
  assertEquals(mapFeeTypeToChargedOutcome("late_cancel"), "LATE_PASSENGER_CANCELLATION");
  assertEquals(mapFeeTypeToChargedOutcome("no_show"), "NO_SHOW");
});

Deno.test("confirmed_driver_id fallback when driver_id is null", () => {
  assertEquals(
    resolveAssignedDriverId({
      driver_id: null,
      confirmed_driver_id: "cd8bae4c-3827-4b90-98c6-10be70eb0e52",
    }),
    "cd8bae4c-3827-4b90-98c6-10be70eb0e52",
  );
  assertEquals(
    resolveAssignedDriverId({
      driver_id: "a",
      confirmed_driver_id: "b",
    }),
    "b",
  );
  assertEquals(
    resolveAssignedDriverId({
      driver_id: null,
      confirmed_driver_id: null,
      accepted_offer_driver_id: "5ed232c3-8bb5-4085-95d6-73e48e6c5e28",
    }),
    "5ed232c3-8bb5-4085-95d6-73e48e6c5e28",
  );
  assertEquals(
    resolveUnambiguousEvidenceDriverId([
      "5ed232c3-8bb5-4085-95d6-73e48e6c5e28",
      "5ed232c3-8bb5-4085-95d6-73e48e6c5e28",
    ]),
    "5ed232c3-8bb5-4085-95d6-73e48e6c5e28",
  );
  assertEquals(
    resolveUnambiguousEvidenceDriverId(["a", "b"]),
    null,
  );
});

Deno.test("fee capture PS patch is captured not release-only cancel", () => {
  const p = buildFeeCapturePaymentSessionPatch({
    authPence: 480,
    capturedFeePence: 400,
    providerState: "COMPLETED",
    capturedAtIso: "2026-08-24T11:49:20.438Z",
  });
  assertEquals(p.status, "captured");
  assertEquals(p.financial_operation_state, "CAPTURED");
  assertEquals(p.captured_amount_pence, 400);
  assertEquals(p.released_amount_pence, 80);
  assertEquals(p.captured_at, "2026-08-24T11:49:20.438Z");
  assertEquals(p.hold_terminal_reason, "terminal_fee_partial_capture");
});

Deno.test("zero-fee void stays cancelled/released (no TEN path)", () => {
  const p = buildFeeCapturePaymentSessionPatch({
    authPence: 480,
    capturedFeePence: 0,
    providerState: "CANCELLED",
    capturedAtIso: "2026-08-24T11:49:20.438Z",
  });
  assertEquals(p.status, "cancelled");
  assertEquals(p.captured_amount_pence, 0);
  assertEquals(p.financial_operation_state, null);
});

Deno.test("FR detect: no-show captured + known provider fee → AUTHORITATIVE fee-net TEN", () => {
  const capturedPs = {
    id: "ff325bdd-82b6-4ee2-81e2-0dfc7cd6d42d",
    status: "captured",
    provider_state: "COMPLETED",
    provider_order_id: "6a8c2ddc-b477-a9fd-886e-33971e3067e2",
    provider_capture_id: null,
    captured_amount_pence: 400,
    captured_at: "2026-08-24T11:49:20.438Z",
    financial_operation_state: "CAPTURED",
    released_amount_pence: 80,
    refunded_amount_pence: null,
    provider_processing_fee_pence: 20,
    fee_status: "ACTUAL",
  };
  const c = classifyMissingTen({
    financialModel: "PLATFORM_COLLECTED",
    tripStatus: "no_show",
    driverId: "cd8bae4c-3827-4b90-98c6-10be70eb0e52",
    driverNetPence: 425,
    tenCount: 0,
    rideBookingSessions: [capturedPs],
    financialOutcome: "NO_SHOW",
    noShowChargePence: 400,
    cancellationFeePence: 400,
  });
  assertEquals(c?.classification, MISSING_TEN_CLASS.AUTHORITATIVE_MISSING_TERMINAL_FEE_TEN);
  assertEquals(c?.authoritative_amount_pence, 380);
});


Deno.test("FR detect: pence present but fee_status PENDING → PROVIDER_FEE_UNKNOWN", () => {
  const capturedPs = {
    id: "ff325bdd-82b6-4ee2-81e2-0dfc7cd6d42d",
    status: "captured",
    provider_state: "COMPLETED",
    provider_order_id: "6a8c2ddc-b477-a9fd-886e-33971e3067e2",
    provider_capture_id: null,
    captured_amount_pence: 400,
    captured_at: "2026-08-24T11:49:20.438Z",
    financial_operation_state: "CAPTURED",
    released_amount_pence: 80,
    refunded_amount_pence: null,
    provider_processing_fee_pence: 20,
    fee_status: "PENDING",
  };
  const c = classifyMissingTen({
    financialModel: "PLATFORM_COLLECTED",
    tripStatus: "no_show",
    driverId: "cd8bae4c-3827-4b90-98c6-10be70eb0e52",
    driverNetPence: 425,
    tenCount: 0,
    rideBookingSessions: [capturedPs],
    financialOutcome: "NO_SHOW",
    noShowChargePence: 400,
  });
  assertEquals(c?.classification, MISSING_TEN_CLASS.PROVIDER_FEE_UNKNOWN);
  assertEquals(c?.authoritative_amount_pence, null);
});

Deno.test("FR detect: no-show captured + missing provider fee → PROVIDER_FEE_UNKNOWN", () => {
  const capturedPs = {
    id: "ff325bdd-82b6-4ee2-81e2-0dfc7cd6d42d",
    status: "captured",
    provider_state: "COMPLETED",
    provider_order_id: "6a8c2ddc-b477-a9fd-886e-33971e3067e2",
    provider_capture_id: null,
    captured_amount_pence: 400,
    captured_at: "2026-08-24T11:49:20.438Z",
    financial_operation_state: "CAPTURED",
    released_amount_pence: 80,
    refunded_amount_pence: null,
    provider_processing_fee_pence: null,
  };
  const c = classifyMissingTen({
    financialModel: "PLATFORM_COLLECTED",
    tripStatus: "no_show",
    driverId: "cd8bae4c-3827-4b90-98c6-10be70eb0e52",
    driverNetPence: 425,
    tenCount: 0,
    rideBookingSessions: [capturedPs],
    financialOutcome: "NO_SHOW",
    noShowChargePence: 400,
  });
  assertEquals(c?.classification, MISSING_TEN_CLASS.PROVIDER_FEE_UNKNOWN);
  assertEquals(c?.authoritative_amount_pence, null);
});

Deno.test("FR detect catches late-cancel + airport protection missing TEN shapes", () => {
  const basePs = {
    id: "ps-fee",
    status: "captured",
    provider_state: "COMPLETED",
    provider_order_id: "ord",
    provider_capture_id: null,
    captured_amount_pence: 500,
    captured_at: "2026-08-24T12:00:00Z",
    financial_operation_state: "CAPTURED",
    released_amount_pence: 100,
    refunded_amount_pence: null,
    provider_processing_fee_pence: 25,
    fee_status: "ACTUAL",
  };
  const late = classifyMissingTen({
    financialModel: "PLATFORM_COLLECTED",
    tripStatus: "cancelled",
    driverId: "d1",
    driverNetPence: 425,
    tenCount: 0,
    rideBookingSessions: [basePs],
    financialOutcome: "LATE_PASSENGER_CANCELLATION",
    cancellationFeePence: 500,
  });
  assertEquals(late?.authoritative_amount_pence, 475);

  const airport = classifyMissingTen({
    financialModel: "PLATFORM_COLLECTED",
    tripStatus: "cancelled",
    driverId: "d1",
    driverNetPence: 425,
    tenCount: 0,
    rideBookingSessions: [{
      ...basePs,
      captured_amount_pence: 2500,
      provider_processing_fee_pence: 100,
      fee_status: "ACTUAL",
    }],
    financialOutcome: "AIRPORT_PROTECTION_CANCELLATION",
    cancellationFeePence: 2500,
  });
  assertEquals(airport?.authoritative_amount_pence, 2400);

  const generic = classifyMissingTen({
    financialModel: "PLATFORM_COLLECTED",
    tripStatus: "cancelled",
    driverId: "d1",
    driverNetPence: 425,
    tenCount: 0,
    rideBookingSessions: [{
      ...basePs,
      captured_amount_pence: 350,
      provider_processing_fee_pence: 10,
      fee_status: "ACTUAL",
    }],
    financialOutcome: "CANCELLED_WITH_FEE",
    cancellationFeePence: 350,
  });
  assertEquals(generic?.authoritative_amount_pence, 340);
});

Deno.test("normal released cancellation → no TEN candidate", () => {
  const released = {
    id: "ps-rel",
    status: "cancelled",
    provider_state: "CANCELLED",
    provider_order_id: "ord",
    provider_capture_id: null,
    captured_amount_pence: 0,
    captured_at: null,
    financial_operation_state: null,
    released_amount_pence: 480,
    refunded_amount_pence: null,
  };
  const c = classifyMissingTen({
    financialModel: "PLATFORM_COLLECTED",
    tripStatus: "cancelled",
    driverId: "d1",
    driverNetPence: 425,
    tenCount: 0,
    rideBookingSessions: [released],
    financialOutcome: "CANCELLED_NO_FEE",
    cancellationFeePence: 0,
  });
  assertEquals(c, null);
});

Deno.test("completed ride settlement classifier unchanged (uses driver_net stamp)", () => {
  const capturedPs = {
    id: "ps1",
    status: "captured",
    provider_state: "COMPLETED",
    provider_order_id: "ord",
    provider_capture_id: "cap",
    captured_amount_pence: 480,
    captured_at: "2026-08-24T11:40:07Z",
    financial_operation_state: "CAPTURED",
    released_amount_pence: null,
    refunded_amount_pence: null,
  };
  const c = classifyMissingTen({
    financialModel: "PLATFORM_COLLECTED",
    tripStatus: "completed",
    driverId: "d1",
    driverNetPence: 425,
    tenCount: 0,
    rideBookingSessions: [capturedPs],
  });
  assertEquals(c?.authoritative_amount_pence, 425);
});

Deno.test("disposeOutcomeIndicatesFeeCapture", () => {
  assertEquals(
    disposeOutcomeIndicatesFeeCapture({
      outcome: "FEE_CAPTURED_AND_REMAINDER_RELEASED",
      captured_fee_pence: 400,
      provider_state: "COMPLETED",
    }),
    true,
  );
  assertEquals(
    disposeOutcomeIndicatesFeeCapture({
      outcome: "ALREADY_RELEASED_RECONCILED",
      captured_fee_pence: 0,
      provider_state: "CANCELLED",
    }),
    false,
  );
  assertEquals(
    disposeOutcomeIndicatesFeeCapture({
      outcome: "HOLD_VOIDED",
      captured_fee_pence: 0,
      provider_state: "COMPLETED",
    }),
    false,
  );
  // Outcome string alone must never prove capture (would TEN without money).
  assertEquals(
    disposeOutcomeIndicatesFeeCapture({
      outcome: "FEE_CAPTURED_AND_REMAINDER_RELEASED",
      captured_fee_pence: 0,
      provider_state: "COMPLETED",
    }),
    false,
  );
});

Deno.test("idempotent retry does not duplicate TEN (early return + 23505 tolerate)", async () => {
  const src = await Deno.readTextFile(rfoPath);
  assertStringIncludes(src, "idempotent: true");
  assertStringIncludes(src, "existingTen.count === 1 && existingTen.totalPence === entitlement.driver_net_pence");
  assertStringIncludes(src, 'insertErr.code !== "23505"');
  assertStringIncludes(src, "DUPLICATE_TRIP_EARNING_NET");
});

Deno.test("RFO source boots: fee-net TEN, provider fee fail-closed, no commission calc", async () => {
  const src = await Deno.readTextFile(rfoPath);
  assertStringIncludes(src, "economic_earned_at from PS.captured_at");
  assertStringIncludes(src, "*/\nimport { serve }");
  assertStringIncludes(src, "resolveChargedTerminalFeeEntitlement");
  assertStringIncludes(src, "buildChargedFeeTenLedgerInsert");
  assertStringIncludes(src, "AIRPORT_PROTECTION_CANCELLATION");
  assertStringIncludes(src, "feeForEntitlement");
  assertStringIncludes(src, "psCaptured > 0 ? psCaptured : fee_pence");
  assertStringIncludes(src, "provider_processing_fee_pence");
  assertStringIncludes(src, "PROVIDER_FEE_UNKNOWN");
  assertStringIncludes(src, "readKnownProviderFeePence");
  assertStringIncludes(src, "feeStatus");
  assertStringIncludes(src, "fee_status");
  assertEquals(src.includes("calculateCommission"), false);
  assertStringIncludes(src, "commission_pence: 0");
  assertStringIncludes(src, "idempotent");
  const serveIdx = src.indexOf("\nserve(");
  const lastClose = src.lastIndexOf("*/", serveIdx);
  assertEquals(lastClose > 0 && lastClose < serveIdx, true);
});

Deno.test("cancel-trip uses mapFeeTypeToChargedOutcome + confirmed_driver_id + surfaces wallet failure", async () => {
  const src = await Deno.readTextFile(cancelPath);
  assertStringIncludes(src, "resolveAssignedDriverId");
  assertStringIncludes(src, "mapFeeTypeToChargedOutcome");
  assertStringIncludes(src, "confirmed_driver_id: trip.confirmed_driver_id");
  assertStringIncludes(src, "WALLET_SETTLEMENT_FAILED_AFTER_FEE_CAPTURE");
  assertStringIncludes(src, "provider_recapture: false");
  assertStringIncludes(src, 'financialOutcome = "LATE_PASSENGER_CANCELLATION"');
  assertEquals(src.includes("appliedFee > 0 && trip.driver_id"), false);
  assertStringIncludes(src, "postChargedFeeTenViaRfo");
});

Deno.test("cancel-trip posts RFO only after proven fee capture", async () => {
  const src = await Deno.readTextFile(cancelPath);
  assertStringIncludes(src, "const feeCaptured = appliedFee > 0 && disposeOutcomeIndicatesFeeCapture");
  assertStringIncludes(src, "if (feeCaptured) {");
  assertStringIncludes(src, "postChargedFeeTenViaRfo");
  assertStringIncludes(src, "disposition: holdDisposition");
  assertEquals(src.includes('if (appliedFee > 0 && feeType !== "none")'), false);
});

Deno.test("dispose reconcile uses fee-capture PS patch helper", async () => {
  const src = await Deno.readTextFile(disposePath);
  assertStringIncludes(src, "buildFeeCapturePaymentSessionPatch");
  assertStringIncludes(src, 'status: patch.status');
});

Deno.test("dispose stamps ACQUIRING fee via extract+markPaymentSessionProviderFee before RFO", async () => {
  const src = await Deno.readTextFile(disposePath);
  assertStringIncludes(src, "extractProviderFeePence");
  assertStringIncludes(src, "markPaymentSessionProviderFee");
  assertStringIncludes(src, "providerOrderPayload");
  assertStringIncludes(src, "Never invent provider fee from settled_amount");
  // Fee persist must run inside reconcile (before cancel-trip posts RFO).
  const reconcileIdx = src.indexOf("async function reconcileSessionCancelled");
  const feeIdx = src.indexOf("markPaymentSessionProviderFee", reconcileIdx);
  const returnTrueIdx = src.indexOf("return true;", feeIdx);
  assertEquals(reconcileIdx > 0 && feeIdx > reconcileIdx && returnTrueIdx > feeIdx, true);
  // Fee persist failure fail-closes local reconciliation (provider_recapture stays false at cancel).
  assertStringIncludes(src, "provider fee persist failed");
  // Must not compute fee from settled_amount (ban comments may mention the token).
  const codeSansBan = src
    .replace(/Never invent(?:s)? provider fee from settled_amount\.?/g, "")
    .replace(/Never invents from settled_amount\.?/g, "")
    .replace(/\(never settled_amount invent\)\.?/g, "");
  assertEquals(/\bsettled_amount\b/.test(codeSansBan), false);
  assertStringIncludes(src, "retrieveRevolutOrderWithAcquiringFee");
});

Deno.test("disposer loads airport FPS config + journey/fare evidence", async () => {
  const src = await Deno.readTextFile(disposePath);
  assertStringIncludes(src, "late_cancel_airport_protection_enabled");
  assertStringIncludes(src, "late_cancel_airport_fare_threshold_pence");
  assertStringIncludes(src, "late_cancel_airport_fee_percentage");
  assertStringIncludes(src, "driver_started_journey_to_pickup_at");
  assertStringIncludes(src, "estimated_total_pence");
  assertStringIncludes(src, "estimated_fare_pence:");
  assertStringIncludes(src, "financial_outcome");
  assertStringIncludes(src, 'disposition_reason === "AIRPORT_PROTECTION_CANCELLATION"');
  assertStringIncludes(src, "Any provider-captured terminal fee is non-commissionable");
  assertStringIncludes(src, "mapFeeTypeToChargedOutcome");
  assertStringIncludes(src, "stamped_financial_outcome");
});

Deno.test("release-terminal-trip-hold force-overrides when fee_pence provided", async () => {
  const src = await Deno.readTextFile(
    new URL("../release-terminal-trip-hold/index.ts", import.meta.url),
  );
  assertStringIncludes(src, "forceFeePenceOverride: typeof feePence === \"number\"");
});

Deno.test("revolutPreauthRelease stamps fee capture PS + does not refund intentional fee COMPLETED", async () => {
  const src = await Deno.readTextFile(
    new URL("./revolutPreauthReleaseSSOT.ts", import.meta.url),
  );
  assertStringIncludes(src, "buildFeeCapturePaymentSessionPatch");
  assertStringIncludes(src, "revolut_preauth_fee_capture");
  assertStringIncludes(src, "isIntentionalTerminalFeeCapture");
  assertStringIncludes(src, "revolut_fee_capture_already_completed");
  assertStringIncludes(src, "captured_terminal_fee");
  assertEquals(src.includes("Fee capture must stamp Payment Session as captured"), true);
  assertStringIncludes(src, "extractProviderFeePence");
  assertStringIncludes(src, "markPaymentSessionProviderFee");
  assertEquals(src.includes("Never invent provider fee from settled_amount") ||
    src.includes("never settled_amount invent"), true);
});

Deno.test("isIntentionalTerminalFeeCapture: partial + full-auth fee stamp + charged outcome", async () => {
  const { isIntentionalTerminalFeeCapture, classifyRevolutHoldReconciliation } = await import(
    "./revolutPreauthReleaseSSOT.ts"
  );
  assertEquals(
    isIntentionalTerminalFeeCapture({
      capturedAmountPence: 400,
      authorisedAmountPence: 480,
    }),
    true,
  );
  // Full-auth fee (= auth) on no_show with stamp — must not look like wrong capture.
  assertEquals(
    isIntentionalTerminalFeeCapture({
      tripStatus: "no_show",
      feeStampPence: 400,
      capturedAmountPence: 400,
      authorisedAmountPence: 400,
      feePenceRequested: 0,
    }),
    true,
  );
  assertEquals(
    isIntentionalTerminalFeeCapture({
      financialOutcome: "AIRPORT_PROTECTION_CANCELLATION",
      capturedAmountPence: 2400,
      authorisedAmountPence: 4800,
    }),
    true,
  );
  // Accidental full capture on live trip — not intentional fee.
  assertEquals(
    isIntentionalTerminalFeeCapture({
      tripStatus: "in_progress",
      capturedAmountPence: 480,
      authorisedAmountPence: 480,
      feePenceRequested: 0,
      feeStampPence: 0,
    }),
    false,
  );
  assertEquals(
    classifyRevolutHoldReconciliation({
      providerOrderState: "COMPLETED",
      tripStatus: "no_show",
      capturedAmountPence: 400,
      authorisedAmountPence: 400,
      feeStampPence: 400,
      financialOutcome: "NO_SHOW",
    }),
    "captured_terminal_fee",
  );
  assertEquals(
    classifyRevolutHoldReconciliation({
      providerOrderState: "COMPLETED",
      tripStatus: "assigned",
      capturedAmountPence: 480,
      authorisedAmountPence: 480,
    }),
    "refunded_wrong_capture",
  );
});

Deno.test("fee decision SSOT imports resolveAirportProtectionCancelFee", async () => {
  const src = await Deno.readTextFile(feeDecisionPath);
  assertStringIncludes(
    src,
    'import { resolveAirportProtectionCancelFee } from "./chargedTerminalFeeWalletSSOT.ts"',
  );
  assertStringIncludes(src, "resolveAirportProtectionCancelFee({");
});

Deno.test("pickup-no-show settle posts TEN not DRIVER_COMPENSATION on card capture", async () => {
  const src = await Deno.readTextFile(
    new URL("./noShowSettlement.ts", import.meta.url),
  );
  assertStringIncludes(src, "buildChargedFeeTenLedgerInsert");
  assertStringIncludes(src, "recordCapturedNoShowTen");
  assertStringIncludes(src, "resolveAuthoritativeCapturedFeeSession");
  assertStringIncludes(src, "readKnownProviderFeePence");
  assertStringIncludes(src, "providerFeePence");
  assertStringIncludes(src, 'const LEDGER_TEN = "TRIP_EARNING_NET"');
  assertEquals(src.includes("LEDGER_NO_SHOW_FEE"), false);

  const pickup = await Deno.readTextFile(
    new URL("../pickup-no-show/index.ts", import.meta.url),
  );
  assertStringIncludes(pickup, "WALLET_SETTLEMENT_FAILED_AFTER_FEE_CAPTURE");
  assertStringIncludes(pickup, "provider_recapture: false");
  assertStringIncludes(pickup, "capturedFeePence");
  assertStringIncludes(pickup, "settleFeePence");
  assertStringIncludes(pickup, "chargeResult?.charged === true");
});

Deno.test("late-cancellation-check stamps charged outcome + dispose + RFO after capture", async () => {
  const src = await Deno.readTextFile(
    new URL("../late-cancellation-check/index.ts", import.meta.url),
  );
  assertStringIncludes(src, "disposeTerminalTripPayment");
  assertStringIncludes(src, "forceFeePenceOverride: true");
  assertStringIncludes(src, "disposeOutcomeIndicatesFeeCapture");
  assertStringIncludes(src, "postChargedFeeTenViaRfo");
  assertStringIncludes(src, 'financialOutcome: "LATE_PASSENGER_CANCELLATION"');
  assertStringIncludes(src, "WALLET_SETTLEMENT_FAILED_AFTER_FEE_CAPTURE");
  assertStringIncludes(src, "commission_pence = 0");
});

Deno.test("cancel-trip posts TEN via shared postChargedFeeTenViaRfo", async () => {
  const src = await Deno.readTextFile(cancelPath);
  assertStringIncludes(src, "postChargedFeeTenViaRfo");
  assertStringIncludes(src, "disposeOutcomeIndicatesFeeCapture");
  assertStringIncludes(src, "WALLET_SETTLEMENT_FAILED_AFTER_FEE_CAPTURE");
});

Deno.test("charge-lifecycle-fee stamps commission 0 + charged financial_outcome", async () => {
  const src = await Deno.readTextFile(
    new URL("../charge-lifecycle-fee/index.ts", import.meta.url),
  );
  assertStringIncludes(src, "mapFeeTypeToChargedOutcome");
  assertStringIncludes(src, "tripPatch.commission_pence = 0");
  assertStringIncludes(src, "financial_outcome");
  assertStringIncludes(src, 'fee_type !== "waiting_surcharge"');
  assertStringIncludes(src, "postChargedFeeTenViaRfo");
  assertStringIncludes(src, "late_cancel_fee_pence");
  assertStringIncludes(src, "WALLET_SETTLEMENT_FAILED_AFTER_FEE_CAPTURE");
});

Deno.test("cancel-corporate-trip stamps charged fee + dispose + RFO after capture", async () => {
  const src = await Deno.readTextFile(
    new URL("../cancel-corporate-trip/index.ts", import.meta.url),
  );
  assertStringIncludes(src, "disposeTerminalTripPayment");
  assertStringIncludes(src, "postChargedFeeTenViaRfo");
  assertStringIncludes(src, "forceFeePenceOverride: true");
  assertStringIncludes(src, "commission_pence = 0");
  assertStringIncludes(src, "WALLET_SETTLEMENT_FAILED_AFTER_FEE_CAPTURE");
});

Deno.test("dispose idempotent replay prefers PS captured_amount_pence + captured_at", async () => {
  const src = await Deno.readTextFile(disposePath);
  assertStringIncludes(src, "captured_at, metadata");
  assertStringIncludes(src, "psCaptured > 0");
  assertStringIncludes(src, "psCapturedAt");
  assertEquals(src.includes("captured_at: decision.capture_required_pence > 0 ? new Date().toISOString()"), false);
});

Deno.test("release-terminal-trip-hold + sweep post TEN after proven fee capture", async () => {
  const release = await Deno.readTextFile(
    new URL("../release-terminal-trip-hold/index.ts", import.meta.url),
  );
  assertStringIncludes(release, "postChargedFeeTenViaRfo");
  assertStringIncludes(release, "disposeOutcomeIndicatesFeeCapture");
  assertStringIncludes(release, "WALLET_SETTLEMENT_FAILED_AFTER_FEE_CAPTURE");
  assertStringIncludes(release, "forceFeePenceOverride: typeof feePence === \"number\"");

  const sweep = await Deno.readTextFile(
    new URL("../sweep-revolut-stale-holds/index.ts", import.meta.url),
  );
  assertStringIncludes(sweep, "postChargedFeeTenViaRfo");
  assertStringIncludes(sweep, "WALLET_SETTLEMENT_FAILED_AFTER_FEE_CAPTURE");
});

Deno.test("postChargedFeeTenViaRfo gates on capture proof and driver", async () => {
  const { postChargedFeeTenViaRfo } = await import("./chargedTerminalFeeWalletSSOT.ts");
  const none = await postChargedFeeTenViaRfo({
    supabaseUrl: "http://localhost",
    serviceRoleKey: "k",
    tripId: "t1",
    driverId: "d1",
    outcome: "NO_SHOW",
    feePence: 400,
    disposition: { captured_fee_pence: 0 },
  });
  assertEquals(none.status, "NOT_REQUIRED");

  const noDriver = await postChargedFeeTenViaRfo({
    supabaseUrl: "http://localhost",
    serviceRoleKey: "k",
    tripId: "t1",
    driverId: null,
    outcome: "NO_SHOW",
    feePence: 400,
    disposition: { captured_fee_pence: 400 },
  });
  assertEquals(noDriver.status, "SKIPPED_NO_DRIVER");
});

Deno.test("extractProviderFeePence: ACQUIRING from fees[] only — never settled_amount", async () => {
  const { extractProviderFeePence } = await import("./paymentCaptureEvidenceSSOT.ts");
  assertEquals(
    extractProviderFeePence({
      amount: 400,
      settled_amount: 376,
      payments: [{ fees: [{ type: "ACQUIRING", amount: 24 }] }],
    }),
    24,
  );
  // settled_amount alone is not a canonical fee source
  assertEquals(
    extractProviderFeePence({
      amount: 400,
      settled_amount: 376,
      payments: [{ fees: [] }],
    }),
    null,
  );
  assertEquals(
    extractProviderFeePence({
      amount: 400,
      settled_amount: 376,
    }),
    null,
  );
  assertEquals(extractProviderFeePence(null), null);
  assertEquals(
    extractProviderFeePence({
      payments: [{ fees: [{ type: "SCHEME", amount: 10 }] }],
    }),
    null,
  );
});

Deno.test("markPaymentSessionProviderFee is idempotent for ACTUAL (no duplicate fee stamp)", async () => {
  const src = await Deno.readTextFile(new URL("./paymentSessionSSOT.ts", import.meta.url));
  assertStringIncludes(src, "Do not overwrite confirmed ACTUAL with PENDING/UNAVAILABLE");
  assertStringIncludes(src, "existingStatus === FEE_STATUS.ACTUAL");
});

Deno.test("cancel-trip: capture ok + wallet fail → provider_recapture false", async () => {
  const src = await Deno.readTextFile(cancelPath);
  assertStringIncludes(src, "WALLET_SETTLEMENT_FAILED_AFTER_FEE_CAPTURE");
  assertStringIncludes(src, "provider_recapture: false");
  assertStringIncludes(src, "feeCaptured && walletSettlementStatus !== \"SUCCEEDED\"");
});
