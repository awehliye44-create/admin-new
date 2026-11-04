/**
 * LOCK — scheduled late-cancellation requires an active driver assignment.
 *
 * MK-261104-003: Driver A accepted → cancelled before Start Trip → rematch →
 * customer cancelled with no replacement acceptance. Within the 30-minute
 * scheduled window the platform wrongly charged LATE_PASSENGER_CANCELLATION.
 *
 * Required rule: searching / rematching with no live driver_id /
 * confirmed_driver_id → NO_FEE_FULL_RELEASE (void full hold). Revoked offers,
 * historical assigned_at, and outstanding offers do not count.
 *
 * Separate ops note (not fixed here): rematch waves logged DB_ERROR_CREATE_OFFERS.
 *
 * Run:
 *   deno test -A supabase/tests/_shared/scheduledLateCancelActiveAssignmentLock.test.ts
 */
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  hasActiveDriverAssignment,
  resolveTerminalPaymentDecision,
  type FarePricingFeeConfig,
  type TerminalTripEvidence,
} from "../../functions/_shared/terminalFeeDecisionSSOT.ts";

const TRIP = "07d3d9cf-1e50-4935-aaab-35aea4b5422c";
const SESSION = "9d1c74ca-6ce4-4435-91d6-b47ecf0fd0e7";
const DRIVER_A = "c40dd8a6-f422-40bc-9534-bae7be88b93e";
const DRIVER_B = "56136f5f-1a3a-4a14-bb23-439b3951415a";
const SCHEDULED_AT = "2026-11-04T22:25:00.000Z";
const CUSTOMER_CANCEL_AT = "2026-11-04T22:17:50.241Z";
const AUTH_PENCE = 500;

/** MK fare_pricing_settings row used on the incident trip. */
const MK_POLICY: FarePricingFeeConfig = {
  cancellation_fee_pence: 0,
  cancellation_grace_period_minutes: 3,
  cancellation_apply_after_arrival_only: true,
  no_show_fee_pence: 450,
  no_show_wait_time_minutes: 5,
  no_show_apply_after_arrival_only: true,
  late_cancel_enabled: true,
  late_cancel_threshold_minutes: 30,
  late_cancel_fee_pence: 500,
  arrival_cancellation_enabled: true,
  arrival_cancellation_fee_pence: 450,
  arrival_cancellation_apply_after_free_waiting_expired: true,
  arrival_cancellation_after_arrival_only: true,
  free_waiting_minutes: 3,
};

function evidence(over: Partial<TerminalTripEvidence> = {}): TerminalTripEvidence {
  return {
    trip_id: TRIP,
    trip_status: "cancelled",
    started_at: null,
    arrived_at: null,
    free_wait_expires_at: null,
    cancelled_at: CUSTOMER_CANCEL_AT,
    cancelled_by: "rider",
    scheduled_at: SCHEDULED_AT,
    cancellation_grace_expires_at: null,
    driver_id: null,
    confirmed_driver_id: null,
    no_show_recorded: false,
    authorised_amount_pence: AUTH_PENCE,
    previously_captured_amount_pence: 0,
    payment_session_id: SESSION,
    provider: "revolut",
    decision_at: CUSTOMER_CANCEL_AT,
    ...over,
  };
}

function decide(over: Partial<TerminalTripEvidence> = {}) {
  return resolveTerminalPaymentDecision({
    evidence: evidence(over),
    config: MK_POLICY,
    feePolicyId: "9ab39ea8-536c-4e4a-864e-218db52b7263",
  });
}

Deno.test("MK-261104-003: rematch / searching with no active driver → no late fee, void full hold", () => {
  // Customer cancel while rematching: driver_id cleared, outstanding rematch
  // offer to Driver B is not an acceptance, arrived_at/started_at null.
  assertEquals(hasActiveDriverAssignment({ driver_id: null, confirmed_driver_id: null }), false);

  const d = decide({
    driver_id: null,
    confirmed_driver_id: null,
    trip_status: "cancelled",
  });

  assertEquals(d.disposition_reason, "NO_FEE_FULL_RELEASE");
  assertEquals(d.fee_type, "none");
  assertEquals(d.fee_amount_pence, 0);
  assertEquals(d.capture_required_pence, 0);
  assertEquals(d.release_required_pence, AUTH_PENCE);
  assertEquals(d.provider_action, "void_full");
});

Deno.test("ordinary scheduled late cancel with active driver still charges", () => {
  const d = decide({
    driver_id: DRIVER_A,
    confirmed_driver_id: DRIVER_A,
  });
  assertEquals(d.disposition_reason, "LATE_PASSENGER_CANCELLATION");
  assertEquals(d.fee_type, "late_passenger_cancellation");
  assertEquals(d.fee_amount_pence, 500);
  assertEquals(d.capture_required_pence, 500);
  assertEquals(d.release_required_pence, 0);
  assertEquals(d.provider_action, "partial_capture_fee");
  assertEquals(d.decision_evidence.active_assignment, true);
});

Deno.test("race: replacement accept before cancel → late fee on that assignment", () => {
  // Ordering A: Driver B accepts rematch, then customer cancel commits.
  const d = decide({
    driver_id: DRIVER_B,
    confirmed_driver_id: DRIVER_B,
  });
  assertEquals(d.disposition_reason, "LATE_PASSENGER_CANCELLATION");
  assertEquals(d.fee_amount_pence, 500);
  assertEquals(d.capture_required_pence, 500);
  assertEquals(d.decision_evidence.active_assignment_driver_id, DRIVER_B);
});

Deno.test("race: cancel before replacement accept → no fee, full release", () => {
  // Ordering B: customer cancel commits while only an outstanding offer exists.
  const d = decide({
    driver_id: null,
    confirmed_driver_id: null,
  });
  assertEquals(d.disposition_reason, "NO_FEE_FULL_RELEASE");
  assertEquals(d.fee_amount_pence, 0);
  assertEquals(d.capture_required_pence, 0);
  assertEquals(d.release_required_pence, AUTH_PENCE);
  assertEquals(d.provider_action, "void_full");
});

Deno.test("revoked prior acceptance / confirmed_driver_id-only still counts as live assignment", () => {
  // confirmed_driver_id alone is live assignment (scheduled confirm path).
  const d = decide({
    driver_id: null,
    confirmed_driver_id: DRIVER_A,
  });
  assertEquals(d.disposition_reason, "LATE_PASSENGER_CANCELLATION");
  assertEquals(hasActiveDriverAssignment({ driver_id: null, confirmed_driver_id: DRIVER_A }), true);
});

Deno.test("outside scheduled threshold stays free even with active driver", () => {
  const d = decide({
    driver_id: DRIVER_A,
    confirmed_driver_id: DRIVER_A,
    cancelled_at: "2026-11-04T21:00:00.000Z",
    decision_at: "2026-11-04T21:00:00.000Z",
  });
  assertEquals(d.disposition_reason, "NO_FEE_FULL_RELEASE");
  assertEquals(d.fee_amount_pence, 0);
});

Deno.test("cancel-trip uses SSOT + assignment CAS; dispose freezes previous_driver_id", async () => {
  const cancelSrc = await Deno.readTextFile(
    new URL("../../functions/cancel-trip/index.ts", import.meta.url),
  );
  assertStringIncludes(cancelSrc, "resolveTerminalPaymentDecision");
  assertStringIncludes(cancelSrc, "hasActiveDriverAssignment");
  assertStringIncludes(cancelSrc, "CANCEL_ASSIGNMENT_CAS_ATTEMPTS");
  assertStringIncludes(cancelSrc, 'tripUpdate.late_cancel_fee_pence = 0');
  assert(
    cancelSrc.includes('.is("driver_id", null)') &&
      cancelSrc.includes('.is("confirmed_driver_id", null)'),
    "cancel commit must CAS on null assignment for rematch cancels",
  );
  // Must not reintroduce standalone late-cancel apply without assignment gate.
  assertEquals(
    /timeToPickupMinutes <= lateCancelThresholdMinutes[\s\S]{0,120}appliedFee = lateCancelFeePence/.test(
      cancelSrc,
    ),
    false,
  );

  const feeSrc = await Deno.readTextFile(
    new URL("../../functions/_shared/terminalFeeDecisionSSOT.ts", import.meta.url),
  );
  assertStringIncludes(feeSrc, "MK-261104-003");
  assertStringIncludes(feeSrc, "hasActiveDriverAssignment");
  assert(
    feeSrc.includes("if (!driverWasAssigned)") &&
      feeSrc.includes("LATE_PASSENGER_CANCELLATION"),
    "late cancel must gate on active assignment",
  );

  const disposeSrc = await Deno.readTextFile(
    new URL("../../functions/_shared/terminalTripPaymentDisposition.ts", import.meta.url),
  );
  assertStringIncludes(disposeSrc, "previous_driver_id");
  assertStringIncludes(disposeSrc, "assignmentDriverId");
});
