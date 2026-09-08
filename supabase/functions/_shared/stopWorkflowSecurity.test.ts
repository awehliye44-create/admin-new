/**
 * stop-workflow auth and operational-cash gates.
 * Run: deno test --allow-read supabase/functions/_shared/stopWorkflowSecurity.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  OPERATIONAL_CASH_VIOLATION,
  STOP_WORKFLOW_ACTIONS,
  completeTripCashDecision,
  decideStopWorkflowCaller,
  tripVisibleToDriver,
} from "./stopWorkflowSecurity.ts";

const DRIVER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";

Deno.test("every stop-workflow action shares one caller gate", () => {
  assertEquals(STOP_WORKFLOW_ACTIONS, [
    "start_journey_to_pickup",
    "arrive_pickup",
    "start_trip",
    "arrive_stop",
    "next_stop",
    "drive_to_next",
    "complete_trip",
    "driver_cancel",
    "cancel_queued_stacked",
  ]);
});

Deno.test("missing Authorization header is denied before body driver_id", () => {
  const decision = decideStopWorkflowCaller({
    hasAuthorizationHeader: false,
    userId: null,
    driverIdForUser: null,
    bodyDriverId: DRIVER,
  });
  assertEquals(decision, {
    ok: false,
    code: "UNAUTHORIZED",
    status: 401,
    message: "Authentication required",
  });
});

Deno.test("invalid or expired JWT is denied", () => {
  const decision = decideStopWorkflowCaller({
    hasAuthorizationHeader: true,
    userId: null,
    driverIdForUser: null,
    bodyDriverId: DRIVER,
  });
  assertEquals(decision.ok, false);
  if (!decision.ok) {
    assertEquals(decision.code, "UNAUTHORIZED");
    assertEquals(decision.status, 401);
  }
});

Deno.test("customer JWT with no driver row is forbidden", () => {
  const decision = decideStopWorkflowCaller({
    hasAuthorizationHeader: true,
    userId: USER,
    driverIdForUser: null,
    bodyDriverId: DRIVER,
  });
  assertEquals(decision, {
    ok: false,
    code: "FORBIDDEN",
    status: 403,
    message: "Driver account not found for authenticated user",
  });
});

Deno.test("assigned authenticated driver is allowed and body spoof is ignored", () => {
  const decision = decideStopWorkflowCaller({
    hasAuthorizationHeader: true,
    userId: USER,
    driverIdForUser: DRIVER,
    bodyDriverId: OTHER,
  });
  assertEquals(decision, {
    ok: true,
    driverId: DRIVER,
    ignoredBodyDriverId: true,
  });
});

Deno.test("unrelated driver cannot see the trip; offer claim remains allowed", () => {
  assertEquals(tripVisibleToDriver({
    tripExists: true,
    assignedDriverId: OTHER,
    callerDriverId: DRIVER,
    hasPendingOrAcceptedOffer: false,
  }), { visible: false });
  assertEquals(tripVisibleToDriver({
    tripExists: false,
    assignedDriverId: null,
    callerDriverId: DRIVER,
    hasPendingOrAcceptedOffer: false,
  }), { visible: false });
  assertEquals(tripVisibleToDriver({
    tripExists: true,
    assignedDriverId: DRIVER,
    callerDriverId: DRIVER,
    hasPendingOrAcceptedOffer: false,
  }), { visible: true, claimViaOffer: false });
  assertEquals(tripVisibleToDriver({
    tripExists: true,
    assignedDriverId: null,
    callerDriverId: DRIVER,
    hasPendingOrAcceptedOffer: true,
  }), { visible: true, claimViaOffer: true });
});

Deno.test("platform collected cash fails closed; driver-collected cash stays valid", () => {
  assertEquals(completeTripCashDecision({
    financial_model: "PLATFORM_COLLECTED",
    payment_method: "cash",
    cash_authorized_at: "2026-07-22T00:00:00Z",
  }), "fail_closed_operational_cash");
  assertEquals(completeTripCashDecision({
    financial_model: "PLATFORM_COLLECTED",
    payment_method: "card",
  }), "not_cash");
  assertEquals(completeTripCashDecision({
    financial_model: "DRIVER_COLLECTED_COMMISSION_WALLET",
    payment_method: "cash",
    payment_status: "driver_collects_upfront",
  }), "allow_driver_collected");
  assertEquals(OPERATIONAL_CASH_VIOLATION.includes("FINANCIAL_MODEL_VIOLATION"), true);
});

Deno.test("stop-workflow source requires JWT and does not write cash ledger types", async () => {
  const src = await Deno.readTextFile(
    new URL("../stop-workflow/index.ts", import.meta.url),
  );
  assertEquals(src.includes("decideStopWorkflowCaller"), true);
  assertEquals(src.includes("requireAuthenticatedUser"), true);
  assertEquals(src.includes("auth.getUser"), true);
  assertEquals(src.includes("Unauthenticated request using driver_id from body"), false);
  assertEquals(src.includes("driver_id = requestedDriverId"), false);
  assertEquals(src.includes("assigned_driver_id"), false);
  assertEquals(src.includes("type: 'CASH_TRIP_EARNING'"), false);
  assertEquals(src.includes("type: 'CASH_COMMISSION_DEBT'"), false);
  assertEquals(src.includes("collected_cash"), false);
  assertEquals(src.includes("FINANCIAL_MODEL_VIOLATION"), true);
  assertEquals(src.includes("mayPostDriverWalletLedger"), true);
  assertEquals(src.includes('tripFinancialModel === "PLATFORM_COLLECTED"'), true);
  assertEquals(src.includes("requiresProviderSettlement"), true);
  const edgeAuth = await Deno.readTextFile(new URL("./edgeAuth.ts", import.meta.url));
  assertEquals(edgeAuth.includes("auth.getUser"), true);
});
