import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyMissingTen,
  dryRunMatchesExpectedContract,
  MISSING_TEN_CLASS,
  MISSING_TEN_DETECT_LOOKBACK_DAYS,
  MISSING_TEN_FIELD,
  MISSING_TEN_STAGE,
  sessionIsTerminalNonCapture,
  sessionLooksCaptured,
  type MissingTenCandidate,
} from "./missingTripEarningNetDetectSSOT.ts";

const capturedPs = {
  id: "ps1",
  status: "captured",
  provider_state: "COMPLETED",
  provider_order_id: "ord",
  provider_capture_id: "cap",
  captured_amount_pence: 500,
  captured_at: "2026-08-06T00:00:00Z",
  financial_operation_state: "CAPTURED",
  released_amount_pence: null,
  refunded_amount_pence: null,
};

Deno.test("authoritative missing TEN when stamp + single captured PS + zero TEN", () => {
  const c = classifyMissingTen({
    financialModel: "PLATFORM_COLLECTED",
    tripStatus: "completed",
    driverId: "d1",
    driverNetPence: 425,
    tenCount: 0,
    rideBookingSessions: [capturedPs],
  });
  assertEquals(c?.classification, MISSING_TEN_CLASS.AUTHORITATIVE_ENTITLEMENT_MISSING_TEN);
  assertEquals(c?.authoritative_amount_pence, 425);
});

Deno.test("MK-260810-011 disposition: 744p AUTHORITATIVE with single verified capture", () => {
  const c = classifyMissingTen({
    financialModel: "PLATFORM_COLLECTED",
    tripStatus: "completed",
    driverId: "cd8bae4c-3827-4b90-98c6-10be70eb0e52",
    driverNetPence: 744,
    tenCount: 0,
    rideBookingSessions: [{
      ...capturedPs,
      id: "f4b48c64-shape",
      status: "trip_created",
      financial_operation_state: "IDLE",
      provider_state: "COMPLETED",
      captured_amount_pence: 788,
      captured_at: "2026-08-13T20:25:14.594Z",
    }],
  });
  assertEquals(c?.classification, MISSING_TEN_CLASS.AUTHORITATIVE_ENTITLEMENT_MISSING_TEN);
  assertEquals(c?.authoritative_amount_pence, 744);
});

Deno.test("authoritative amounts match Step 9.2B2 contract values", () => {
  for (const amt of [425, 382, 670, 408, 744]) {
    const c = classifyMissingTen({
      financialModel: "PLATFORM_COLLECTED",
      tripStatus: "completed",
      driverId: "d1",
      driverNetPence: amt,
      tenCount: 0,
      rideBookingSessions: [{ ...capturedPs, captured_amount_pence: amt }],
    });
    assertEquals(c?.authoritative_amount_pence, amt);
  }
});

Deno.test("MK-008 style null stamp → PENDING_EVIDENCE with null amount", () => {
  const c = classifyMissingTen({
    financialModel: "PLATFORM_COLLECTED",
    tripStatus: "completed",
    driverId: "d1",
    driverNetPence: null,
    tenCount: 0,
    rideBookingSessions: [{ ...capturedPs, status: "trip_created", captured_amount_pence: 716 }],
  });
  assertEquals(c?.classification, MISSING_TEN_CLASS.PENDING_EVIDENCE_MISSING_TEN);
  assertEquals(c?.authoritative_amount_pence, null);
});

Deno.test("existing TEN excluded", () => {
  const c = classifyMissingTen({
    financialModel: "PLATFORM_COLLECTED",
    tripStatus: "completed",
    driverId: "d1",
    driverNetPence: 425,
    tenCount: 1,
    rideBookingSessions: [capturedPs],
  });
  assertEquals(c, null);
});

Deno.test("DRIVER_COLLECTED excluded", () => {
  const c = classifyMissingTen({
    financialModel: "DRIVER_COLLECTED_COMMISSION_WALLET",
    tripStatus: "completed",
    driverId: "d1",
    driverNetPence: 425,
    tenCount: 0,
    rideBookingSessions: [capturedPs],
  });
  assertEquals(c, null);
});

Deno.test("MK-260716-016 shape: cancelled single RIDE_BOOKING excluded (not CAPTURE_AMBIGUOUS)", () => {
  const cancelled = {
    ...capturedPs,
    status: "cancelled",
    provider_state: "CANCELLED",
    financial_operation_state: null,
    captured_amount_pence: null,
    captured_at: null,
    authorised_amount_pence: 1089,
  };
  assertEquals(sessionIsTerminalNonCapture(cancelled), true);
  const c = classifyMissingTen({
    financialModel: "PLATFORM_COLLECTED",
    tripStatus: "completed",
    driverId: "d1",
    driverNetPence: 841,
    tenCount: 0,
    rideBookingSessions: [cancelled],
  });
  assertEquals(c, null);
});

Deno.test("MK-260719-009 / MK-260805-003 shape: cancelled auth excluded", () => {
  for (const net of [714, 671]) {
    const c = classifyMissingTen({
      financialModel: "PLATFORM_COLLECTED",
      tripStatus: "completed",
      driverId: "d1",
      driverNetPence: net,
      tenCount: 0,
      rideBookingSessions: [{
        ...capturedPs,
        status: "cancelled",
        provider_state: "CANCELLED",
        financial_operation_state: null,
        captured_amount_pence: null,
        captured_at: null,
      }],
    });
    assertEquals(c, null);
  }
});

Deno.test("MK-260807-008 shape: released/CANCELLED single RIDE_BOOKING excluded", () => {
  const released = {
    ...capturedPs,
    status: "released",
    provider_state: "CANCELLED",
    financial_operation_state: null,
    captured_amount_pence: null,
    captured_at: null,
    authorised_amount_pence: 350,
  };
  assertEquals(sessionIsTerminalNonCapture(released), true);
  const c = classifyMissingTen({
    financialModel: "PLATFORM_COLLECTED",
    tripStatus: "completed",
    driverId: "d1",
    driverNetPence: 350,
    tenCount: 0,
    rideBookingSessions: [released],
  });
  assertEquals(c, null);
});

Deno.test("released amount > 0 is terminal non-capture (excluded)", () => {
  const released = classifyMissingTen({
    financialModel: "PLATFORM_COLLECTED",
    tripStatus: "completed",
    driverId: "d1",
    driverNetPence: 425,
    tenCount: 0,
    rideBookingSessions: [{ ...capturedPs, released_amount_pence: 500, status: "released" }],
  });
  assertEquals(released, null);
});

Deno.test("MK-260824-002 shape: captured 400p + unknown provider fee → PROVIDER_FEE_UNKNOWN (not 400/340/425)", () => {
  const c = classifyMissingTen({
    financialModel: "PLATFORM_COLLECTED",
    tripStatus: "no_show",
    driverId: "cd8bae4c-3827-4b90-98c6-10be70eb0e52",
    driverNetPence: 425,
    tenCount: 0,
    rideBookingSessions: [{
      ...capturedPs,
      status: "dispatching",
      financial_operation_state: null,
      captured_amount_pence: 400,
      released_amount_pence: 0,
      provider_processing_fee_pence: null,
    }],
    financialOutcome: "NO_SHOW",
    noShowChargePence: 400,
    cancellationFeePence: 400,
  });
  assertEquals(c?.classification, MISSING_TEN_CLASS.PROVIDER_FEE_UNKNOWN);
  assertEquals(c?.authoritative_amount_pence, null);
});

Deno.test("MK-260824-005 shape: driver null + captured 400p + provider fee null → PROVIDER_FEE_UNKNOWN", () => {
  const c = classifyMissingTen({
    financialModel: "PLATFORM_COLLECTED",
    tripStatus: "cancelled",
    driverId: null,
    driverNetPence: 400,
    tenCount: 0,
    rideBookingSessions: [{
      ...capturedPs,
      status: "captured",
      financial_operation_state: "CAPTURED",
      captured_amount_pence: 400,
      released_amount_pence: 80,
      provider_processing_fee_pence: null,
      fee_status: null,
    }],
    financialOutcome: "CANCELLED_WITH_FEE",
    cancellationFeePence: 400,
  });
  assertEquals(c?.classification, MISSING_TEN_CLASS.PROVIDER_FEE_UNKNOWN);
  assertEquals(c?.authoritative_amount_pence, null);
});

Deno.test("MK-260824-002 shape with cancel-cleared driver → still PROVIDER_FEE_UNKNOWN", () => {
  const c = classifyMissingTen({
    financialModel: "PLATFORM_COLLECTED",
    tripStatus: "no_show",
    driverId: null,
    driverNetPence: null,
    tenCount: 0,
    rideBookingSessions: [{
      ...capturedPs,
      status: "dispatching",
      financial_operation_state: null,
      captured_amount_pence: 400,
      released_amount_pence: 0,
      provider_processing_fee_pence: null,
      fee_status: null,
    }],
    financialOutcome: "NO_SHOW",
    noShowChargePence: 400,
    cancellationFeePence: 400,
  });
  assertEquals(c?.classification, MISSING_TEN_CLASS.PROVIDER_FEE_UNKNOWN);
  assertEquals(c?.authoritative_amount_pence, null);
});

Deno.test("provider fee ACTUAL + driver null → PENDING_EVIDENCE_MISSING_DRIVER", () => {
  const c = classifyMissingTen({
    financialModel: "PLATFORM_COLLECTED",
    tripStatus: "cancelled",
    driverId: null,
    driverNetPence: 400,
    tenCount: 0,
    rideBookingSessions: [{
      ...capturedPs,
      status: "captured",
      financial_operation_state: "CAPTURED",
      captured_amount_pence: 400,
      released_amount_pence: 80,
      provider_processing_fee_pence: 20,
      fee_status: "ACTUAL",
    }],
    financialOutcome: "CANCELLED_WITH_FEE",
    cancellationFeePence: 400,
  });
  assertEquals(c?.classification, MISSING_TEN_CLASS.PENDING_EVIDENCE_MISSING_DRIVER);
  assertEquals(c?.authoritative_amount_pence, null);
});

Deno.test("provider fee ACTUAL + driver known + no TEN → AUTHORITATIVE_MISSING_TERMINAL_FEE_TEN", () => {
  const c = classifyMissingTen({
    financialModel: "PLATFORM_COLLECTED",
    tripStatus: "cancelled",
    driverId: "5ed232c3-8bb5-4085-95d6-73e48e6c5e28",
    driverNetPence: 400,
    tenCount: 0,
    rideBookingSessions: [{
      ...capturedPs,
      status: "captured",
      financial_operation_state: "CAPTURED",
      captured_amount_pence: 400,
      released_amount_pence: 80,
      provider_processing_fee_pence: 20,
      fee_status: "ACTUAL",
    }],
    financialOutcome: "CANCELLED_WITH_FEE",
    cancellationFeePence: 400,
  });
  assertEquals(c?.classification, MISSING_TEN_CLASS.AUTHORITATIVE_MISSING_TERMINAL_FEE_TEN);
  assertEquals(c?.authoritative_amount_pence, 380);
});

Deno.test("partial fee capture with known provider fee → AUTHORITATIVE terminal-fee TEN", () => {
  const feeCapturePs = {
    ...capturedPs,
    status: "captured",
    financial_operation_state: "CAPTURED",
    captured_amount_pence: 400,
    released_amount_pence: 80,
    provider_processing_fee_pence: 20,
    fee_status: "ACTUAL",
  };
  assertEquals(sessionLooksCaptured(feeCapturePs), true);
  const c = classifyMissingTen({
    financialModel: "PLATFORM_COLLECTED",
    tripStatus: "no_show",
    driverId: "cd8bae4c-3827-4b90-98c6-10be70eb0e52",
    driverNetPence: 425,
    tenCount: 0,
    rideBookingSessions: [feeCapturePs],
    financialOutcome: "NO_SHOW",
    noShowChargePence: 400,
  });
  assertEquals(c?.classification, MISSING_TEN_CLASS.AUTHORITATIVE_MISSING_TERMINAL_FEE_TEN);
  assertEquals(c?.authoritative_amount_pence, 380);
});

Deno.test("fee-terminal FR scan uses updated_at + confirmed_driver_id + all charged outcomes", async () => {
  const src = await Deno.readTextFile(
    new URL("./missingTripEarningNetDetectSSOT.ts", import.meta.url),
  );
  assertStringIncludes(src, "confirmed_driver_id");
  assertStringIncludes(src, "accepted_ride_offer_id");
  assertStringIncludes(src, "resolveAssignedDriverId");
  assertStringIncludes(src, "resolveUnambiguousEvidenceDriverId");
  assertStringIncludes(src, "loadFrDetectAssignmentEvidenceIds");
  assertStringIncludes(src, "isChargedFeeOutcome");
  assertStringIncludes(src, "AIRPORT_PROTECTION_CANCELLATION");
  assertStringIncludes(src, "CANCELLED_WITH_FEE");
  assertStringIncludes(src, "late_cancel_fee_pence");
  assertStringIncludes(src, "lateCancelFeePence");
  assertStringIncludes(src, "provider_processing_fee_pence");
  assertStringIncludes(src, "PROVIDER_FEE_UNKNOWN");
  assertStringIncludes(src, "PENDING_EVIDENCE_MISSING_DRIVER");
  assertStringIncludes(src, "AUTHORITATIVE_MISSING_TERMINAL_FEE_TEN");
  assertStringIncludes(src, "FEE_NET_NON_POSITIVE");
  assertStringIncludes(src, "fee_status");
  assertStringIncludes(src, "feeStatus");
  assertStringIncludes(src, '.gte("updated_at", since)');
  assertEquals(src.includes('.gte("cancelled_at", since)'), false);
  // Monitor must remain detect-only (no wallet money writes).
  assertStringIncludes(src, "never_credit");
  assertStringIncludes(src, "detect_only");
  assertEquals(src.includes("creditCapturedCardTripLedger"), false);
  assertEquals(src.includes('from("driver_wallet_ledger").insert'), false);
});

Deno.test("no_show with TEN present excluded", () => {
  const c = classifyMissingTen({
    financialModel: "PLATFORM_COLLECTED",
    tripStatus: "no_show",
    driverId: "d1",
    driverNetPence: 400,
    tenCount: 1,
    rideBookingSessions: [{ ...capturedPs, captured_amount_pence: 400 }],
    financialOutcome: "NO_SHOW",
    noShowChargePence: 400,
  });
  assertEquals(c, null);
});

Deno.test("non-terminal unclear capture remains CAPTURE_AMBIGUOUS fail-closed", () => {
  const thin = classifyMissingTen({
    financialModel: "PLATFORM_COLLECTED",
    tripStatus: "completed",
    driverId: "d1",
    driverNetPence: 425,
    tenCount: 0,
    rideBookingSessions: [{
      ...capturedPs,
      captured_amount_pence: null,
      provider_state: null,
      financial_operation_state: null,
      status: "dispatching",
    }],
  });
  assertEquals(thin?.classification, MISSING_TEN_CLASS.CAPTURE_AMBIGUOUS);
  assertEquals(sessionLooksCaptured({
    ...capturedPs,
    refunded_amount_pence: 100,
  }), false);
});

Deno.test("zero RIDE_BOOKING → PAYMENT_SESSION_MISSING", () => {
  const c = classifyMissingTen({
    financialModel: "PLATFORM_COLLECTED",
    tripStatus: "completed",
    driverId: "d1",
    driverNetPence: 425,
    tenCount: 0,
    rideBookingSessions: [],
  });
  assertEquals(c?.classification, MISSING_TEN_CLASS.PAYMENT_SESSION_MISSING);
});

Deno.test("multiple genuine RIDE_BOOKING → CAPTURE_AMBIGUOUS", () => {
  const c = classifyMissingTen({
    financialModel: "PLATFORM_COLLECTED",
    tripStatus: "completed",
    driverId: "d1",
    driverNetPence: 425,
    tenCount: 0,
    rideBookingSessions: [capturedPs, { ...capturedPs, id: "ps2" }],
  });
  assertEquals(c?.classification, MISSING_TEN_CLASS.CAPTURE_AMBIGUOUS);
});

Deno.test("unrelated-purpose siblings are out of scope (classifier only sees RIDE_BOOKING list)", () => {
  // Caller filters purpose=RIDE_BOOKING; SAVE_CARD/PAYMENT_RECOVERY must not be passed in.
  const c = classifyMissingTen({
    financialModel: "PLATFORM_COLLECTED",
    tripStatus: "completed",
    driverId: "d1",
    driverNetPence: 425,
    tenCount: 0,
    rideBookingSessions: [capturedPs], // one RIDE_BOOKING only
  });
  assertEquals(c?.classification, MISSING_TEN_CLASS.AUTHORITATIVE_ENTITLEMENT_MISSING_TEN);
});

Deno.test("joined child rows cannot multiply a single Payment Session (one result per trip)", () => {
  // classifyMissingTen is pure over the RIDE_BOOKING array — no joins; length===1 stays authoritative.
  const c = classifyMissingTen({
    financialModel: "PLATFORM_COLLECTED",
    tripStatus: "completed",
    driverId: "d1",
    driverNetPence: 425,
    tenCount: 0,
    rideBookingSessions: [capturedPs],
  });
  assertEquals(c?.classification, MISSING_TEN_CLASS.AUTHORITATIVE_ENTITLEMENT_MISSING_TEN);
  assertEquals(c?.authoritative_amount_pence, 425);
});

Deno.test("no created_at fallback or approximate entitlement", async () => {
  const src = await Deno.readTextFile(new URL("./missingTripEarningNetDetectSSOT.ts", import.meta.url));
  assertEquals(src.includes("limit(1)"), false);
  assertEquals(/0\.85|85\s*%|Math\.round\([^)]*\*\s*0\./.test(src), false);
  assertStringIncludes(src, "driverNetPence");
  assertStringIncludes(src, "sessionIsTerminalNonCapture");
});

Deno.test("stable mismatch identity keys", () => {
  assertEquals(MISSING_TEN_STAGE, "missing_trip_earning_net");
  assertEquals(MISSING_TEN_FIELD, "TRIP_EARNING_NET");
});

Deno.test("lookback retains historical window (>=45d)", () => {
  assertEquals(MISSING_TEN_DETECT_LOOKBACK_DAYS >= 45, true);
});

Deno.test("dry-run contract matcher accepts exact six-trip Step 9.2B2 set", () => {
  const mk = (code: string, cls: string, amt: number | null): MissingTenCandidate => ({
    trip_id: code,
    trip_code: code,
    driver_id: "d",
    financial_model: "PLATFORM_COLLECTED",
    trip_status: "completed",
    classification: cls as MissingTenCandidate["classification"],
    authoritative_amount_pence: amt,
    ten_count: 0,
    ride_booking_count: 1,
    payment_session_id: "ps",
    provider_state: "COMPLETED",
    provider_order_id: null,
    provider_capture_id: null,
    captured_amount_pence: null,
    captured_at: null,
    reason: "t",
    proposed_mismatch_key: { trip_id: code, stage: MISSING_TEN_STAGE, field_name: MISSING_TEN_FIELD },
  });
  const candidates = [
    mk("MK-260805-016", MISSING_TEN_CLASS.AUTHORITATIVE_ENTITLEMENT_MISSING_TEN, 425),
    mk("MK-260808-053", MISSING_TEN_CLASS.AUTHORITATIVE_ENTITLEMENT_MISSING_TEN, 382),
    mk("MK-260808-054", MISSING_TEN_CLASS.AUTHORITATIVE_ENTITLEMENT_MISSING_TEN, 670),
    mk("MK-260810-011", MISSING_TEN_CLASS.AUTHORITATIVE_ENTITLEMENT_MISSING_TEN, 744),
    mk("MK-260817-008", MISSING_TEN_CLASS.PENDING_EVIDENCE_MISSING_TEN, null),
    mk("MK-260818-001", MISSING_TEN_CLASS.AUTHORITATIVE_ENTITLEMENT_MISSING_TEN, 408),
  ];
  assertEquals(dryRunMatchesExpectedContract(candidates).ok, true);
  assertEquals(dryRunMatchesExpectedContract(candidates.slice(0, 5)).ok, false);
});

Deno.test("monitor source: no money writers / repair; has auth + dry_run", async () => {
  const src = await Deno.readTextFile(new URL("../financial-ssot-monitor/index.ts", import.meta.url));
  assertEquals(src.includes('from("driver_wallet_ledger").insert'), false);
  assertEquals(src.includes("creditCapturedCardTripLedger"), false);
  assertEquals(src.includes("applyCanonicalSettlementAfterCapture"), false);
  assertEquals(src.includes("relayApprovedDriverPayoutPayment("), false);
  assertStringIncludes(src, "requireAdminOrStaff");
  assertStringIncludes(src, "dry_run");
  assertStringIncludes(src, "DETECT_MISSING_TEN_ONLY");
  assertStringIncludes(src, "REPAIR_FORBIDDEN");
  assertStringIncludes(src, "detectMissingTripEarningNet");
  assertStringIncludes(src, 'serveWithEdgeTiming("financial-ssot-monitor", corsHeaders,');
});

Deno.test("detector source: no provider/wallet/payout DML; dryRun zero-write path", async () => {
  const src = await Deno.readTextFile(new URL("./missingTripEarningNetDetectSSOT.ts", import.meta.url));
  assertEquals(src.includes(".insert(") && src.includes("driver_wallet_ledger"), false);
  assertEquals(src.includes('from("driver_wallet_ledger").insert'), false);
  assertEquals(src.includes('from("payment_sessions").update'), false);
  assertEquals(src.includes("fetch("), false);
  assertStringIncludes(src, 'from("financial_ssot_mismatches")');
  assertStringIncludes(src, "dryRun");
  assertStringIncludes(src, "if (dryRun)");
});
