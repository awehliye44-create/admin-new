/**
 * Step 8.2A — Admin capture / refund ownership lock + production-shaped scenarios.
 *
 * Run:
 *   deno test --allow-read --no-check supabase/functions/_shared/adminCaptureTripPaymentOwnershipLock.test.ts
 */
import {
  assert,
  assertEquals,
  assertStrictEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyRideBookingPaymentSessions,
  PAYMENT_SESSION_GATE_STATUS,
  PAYMENT_SESSION_PURPOSE_RIDE_BOOKING,
} from "./paymentSessionCaptureGateSSOT.ts";
import { executeAdminCaptureTripPayment } from "./adminCaptureTripPaymentSSOT.ts";
import { FINANCIAL_MODEL_VIOLATION, SERVICE_AREA_FINANCIAL_MODEL } from "./commissionWalletSSOT.ts";

const ROOT = new URL(".", import.meta.url).pathname.replace(/_shared\/$/, "");

function bookingSession(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    purpose: PAYMENT_SESSION_PURPOSE_RIDE_BOOKING,
    provider_order_id: "order-1",
    status: "trip_created",
    provider_state: "AUTHORISED",
    metadata: {},
    ...extra,
  };
}

const BASE_TRIP = {
  id: "trip-1",
  status: "completed",
  financial_model: "PLATFORM_COLLECTED",
  driver_id: "driver-1",
  provider_order_id: "order-1",
  authorised_amount_pence: 500,
  driver_net_pence: 425,
  trip_code: "MK-TEST-001",
};

Deno.test("A: Admin capture AUTHORIZED path — persist after provider capture, then settlement", async () => {
  const src = await Deno.readTextFile(new URL("./adminCaptureTripPaymentSSOT.ts", import.meta.url));
  const captureIdx = src.indexOf('decision.action === "retry_capture"');
  const persistIdx = src.indexOf("await persistConfirmedCapture");
  const settlementIdx = src.indexOf("await applySettlement");
  assertEquals(captureIdx >= 0 && persistIdx > captureIdx && settlementIdx > persistIdx, true);
  assertEquals(/import\s*\{[^}]*markPaymentSessionCaptured/.test(src), false);
});

Deno.test("B: Admin capture COMPLETED path — reconcile via persistConfirmedProviderCapture, no captureOrder", async () => {
  const src = await Deno.readTextFile(new URL("./adminCaptureTripPaymentSSOT.ts", import.meta.url));
  const reconcileBlock = src.slice(
    src.indexOf('decision.action === "reconcile_already_captured"'),
    src.indexOf('decision.action === "retry_capture"'),
  );
  assertStrictEquals(reconcileBlock.includes("captureOrder("), false);
  assertStrictEquals(reconcileBlock.includes("await captureOrder"), false);
  const sharedPersist = src.slice(src.indexOf('decision.action === "retry_capture"'));
  assertStrictEquals(sharedPersist.includes("await persistConfirmedCapture("), true);
});

Deno.test("C: Post-capture wallet failure — retry_provider_capture always false", async () => {
  const src = await Deno.readTextFile(new URL("./adminCaptureTripPaymentSSOT.ts", import.meta.url));
  assertStringIncludes(src, "attachCapturedPostCaptureFields");
  assertStringIncludes(src, "postingWalletMismatch");
  assertEquals(src.includes("retry_provider_capture: true"), false);
  const resultSrc = await Deno.readTextFile(new URL("./postCaptureSettlementResult.ts", import.meta.url));
  assertStringIncludes(resultSrc, "retry_provider_capture: false");
});

Deno.test("D: Missing Payment Session — fail closed before provider", async () => {
  const classified = classifyRideBookingPaymentSessions([]);
  assertEquals(classified.gate_status, PAYMENT_SESSION_GATE_STATUS.PAYMENT_SESSION_MISSING);

  const src = await Deno.readTextFile(new URL("./adminCaptureTripPaymentSSOT.ts", import.meta.url));
  const beforeRetrieve = src.slice(0, src.indexOf("retrieveOrder("));
  assertStringIncludes(beforeRetrieve, PAYMENT_SESSION_GATE_STATUS.PAYMENT_SESSION_MISSING);
});

Deno.test("E: Duplicate RIDE_BOOKING — CAPTURE_AMBIGUOUS", async () => {
  const classified = classifyRideBookingPaymentSessions([
    bookingSession("ps-1"),
    bookingSession("ps-2"),
  ]);
  assertEquals(classified.gate_status, PAYMENT_SESSION_GATE_STATUS.CAPTURE_AMBIGUOUS);
  assertEquals(classified.session, null);
});

Deno.test("F: One RIDE_BOOKING plus PAYMENT_RECOVERY — booking session selected", async () => {
  const gate = classifyRideBookingPaymentSessions([bookingSession("ps-book")]);
  assertEquals(gate.gate_status, PAYMENT_SESSION_GATE_STATUS.OK);
  assertEquals(gate.session?.id, "ps-book");

  const gateSrc = await Deno.readTextFile(new URL("./paymentSessionCaptureGateSSOT.ts", import.meta.url));
  const rideBookingFn = gateSrc.slice(
    gateSrc.indexOf("export async function loadRideBookingPaymentSessions"),
    gateSrc.indexOf("export async function loadPaymentSessionCaptureGate"),
  );
  assertEquals(rideBookingFn.includes('.eq("purpose", PAYMENT_SESSION_PURPOSE_RIDE_BOOKING)'), true);
  assertEquals(rideBookingFn.includes(".neq("), false);
});

Deno.test("G: revolut-capture-order returns 410 LEGACY_CAPTURE_ENDPOINT_DISABLED", async () => {
  const src = await Deno.readTextFile(`${ROOT}revolut-capture-order/index.ts`);
  assertStringIncludes(src, "410");
  assertStringIncludes(src, "LEGACY_CAPTURE_ENDPOINT_DISABLED");
  assertEquals(src.includes("captureRevolutOrder"), false);
  assertEquals(src.includes('from("trips").update'), false);
  assertEquals(src.includes('from("payment_sessions")'), false);
});

Deno.test("I: DRIVER_COLLECTED cannot use Admin provider capture", async () => {
  const result = await executeAdminCaptureTripPayment({
    supabase: { from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }) }) } as never,
    trip: {
      ...BASE_TRIP,
      financial_model: SERVICE_AREA_FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET,
    },
  });
  assertEquals(result.success, false);
  assertEquals(result.error_code, FINANCIAL_MODEL_VIOLATION);
});

Deno.test("J: ownership locks — admin capture uses canonical modules, no direct wallet insert", async () => {
  const adminSrc = await Deno.readTextFile(`${ROOT}admin-capture-trip-payment/index.ts`);
  const ssotSrc = await Deno.readTextFile(`${ROOT}_shared/adminCaptureTripPaymentSSOT.ts`);

  assertStringIncludes(adminSrc, "executeAdminCaptureTripPayment");
  assertEquals(adminSrc.includes("captureRevolutOrder"), false);
  assertEquals(adminSrc.includes('from("driver_wallet_ledger").insert'), false);

  assertStringIncludes(ssotSrc, "applyCanonicalSettlementAfterCapture");
  assertStringIncludes(ssotSrc, "persistConfirmedProviderCapture");
  assertStringIncludes(ssotSrc, "validateAdminCaptureTripPreconditions");
  assertEquals(ssotSrc.includes('from("driver_wallet_ledger").insert'), false);

  const frSrc = await Deno.readTextFile(`${ROOT}financial-ssot-monitor/index.ts`);
  assertEquals(frSrc.includes("creditCapturedCardTripLedger"), false);

  const legacySrc = await Deno.readTextFile(`${ROOT}revolut-capture-order/index.ts`);
  assertEquals(legacySrc.includes("captureRevolutOrder"), false);
});

Deno.test("J: revolut-capture-order boot lock — no second capture implementation", async () => {
  const src = await Deno.readTextFile(`${ROOT}revolut-capture-order/index.ts`);
  assertEquals(src.includes("retrieveRevolutOrder"), false);
  assertEquals(src.includes("persistConfirmedProviderCapture"), false);
  assertEquals(src.includes("admin_payment_audit"), false);
});
