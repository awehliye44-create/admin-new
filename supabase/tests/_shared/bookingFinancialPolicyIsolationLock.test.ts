/**
 * #89 — Booking financial policy isolation lock.
 * Admin buffer changes apply to NEW bookings only; existing bookings keep frozen contract.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildBookingFinancialPolicy,
  reconstructLegacyBookingFinancialPolicy,
  resolveFrozenPreauthBufferPence,
  BOOKING_FINANCIAL_POLICY_VERSION,
} from "../../functions/_shared/bookingFinancialPolicySSOT.ts";
import { computeServiceAreaPreauthBuffer } from "../../functions/_shared/preauthBufferResolverSSOT.ts";
import { planRevolutCompletionCapture } from "../../functions/_shared/revolutPaymentHoldSSOT.ts";

const MK = "cb58f1bd-8b6f-45b9-ad31-b3140309892c";

Deno.test("#89 scheduled £2 buffer then Admin disables — capture uses frozen fare only", () => {
  const atBook = computeServiceAreaPreauthBuffer(
    { enable_preauth_buffer: true, buffer_type: "fixed", buffer_value: 2 },
    3194,
    MK,
  );
  assertEquals(atBook.bufferPence, 200);
  const policy = buildBookingFinancialPolicy({
    serviceAreaId: MK,
    buffer: atBook,
    source: "booking_create",
  });
  assertEquals(policy.version, BOOKING_FINANCIAL_POLICY_VERSION);
  assertEquals(policy.preauth_buffer.buffer_pence, 200);

  // Admin later disables buffer (live settings).
  const liveNow = computeServiceAreaPreauthBuffer(
    { enable_preauth_buffer: false, buffer_type: "fixed", buffer_value: 2 },
    3194,
    MK,
  );
  assertEquals(liveNow.bufferPence, 0);

  // Existing booking must keep frozen 200 — never live 0.
  const frozen = resolveFrozenPreauthBufferPence({ policy });
  assertEquals(frozen.bufferPence, 200);
  assertEquals(frozen.source, "policy");

  // Capture plans against authorised hold (fare+buffer) but captures fare only.
  const plan = planRevolutCompletionCapture({
    finalFarePence: 3194,
    authorisedHoldPence: 3194 + frozen.bufferPence,
    bufferPence: frozen.bufferPence,
    preferSameOrderIncrement: true,
  });
  assertEquals(plan.kind, "capture_within_hold");
  if (plan.kind === "capture_within_hold") {
    assertEquals(plan.capture_amount_pence, 3194);
  }
});

Deno.test("#89 scheduled £0 buffer then Admin enables £2 — existing booking stays 0", () => {
  const atBook = computeServiceAreaPreauthBuffer(
    { enable_preauth_buffer: false, buffer_type: "fixed", buffer_value: 2 },
    2000,
    MK,
  );
  assertEquals(atBook.bufferPence, 0);
  const policy = buildBookingFinancialPolicy({
    serviceAreaId: MK,
    buffer: atBook,
  });
  const liveNow = computeServiceAreaPreauthBuffer(
    { enable_preauth_buffer: true, buffer_type: "fixed", buffer_value: 2 },
    2000,
    MK,
  );
  assertEquals(liveNow.bufferPence, 200);
  assertEquals(resolveFrozenPreauthBufferPence({ policy }).bufferPence, 0);
});

Deno.test("#89 Admin changes buffer mid-trip — frozen session/trip columns win", () => {
  // No policy JSON yet (legacy) — session buffer still authoritative.
  const frozen = resolveFrozenPreauthBufferPence({
    sessionBufferPence: 200,
    tripPreauthBufferPence: 200,
  });
  assertEquals(frozen.bufferPence, 200);
  assertEquals(frozen.insufficient_historical_evidence, false);

  const missing = resolveFrozenPreauthBufferPence({});
  assertEquals(missing.insufficient_historical_evidence, true);
  assertEquals(missing.bufferPence, 0);
});

Deno.test("#89 legacy reconstruct never invents today's Admin buffer", () => {
  const reconstructed = reconstructLegacyBookingFinancialPolicy({
    serviceAreaId: MK,
    bufferPence: 200,
    frozenAt: "2026-11-24T13:39:10.422Z",
  });
  assertEquals(reconstructed.source, "legacy_reconstruct");
  assertEquals(reconstructed.preauth_buffer.buffer_pence, 200);
  // Live Admin may be disabled — reconstruct still reports booking-time 200.
  assertEquals(
    resolveFrozenPreauthBufferPence({ policy: reconstructed }).bufferPence,
    200,
  );
});

Deno.test("#89 create-preauth freezes booking financial policy", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/create-preauth-payment-intent/index.ts", import.meta.url),
  );
  assertEquals(src.includes("buildBookingFinancialPolicy"), true);
  assertEquals(src.includes("bookingFinancialPolicyJson: bookingFinancialPolicy"), true);
  const buildCall = src.indexOf("const bookingFinancialPolicy = buildBookingFinancialPolicy({");
  const preauthCall = src.indexOf("await createRevolutPreauthResponse({");
  assertEquals(buildCall > 0 && preauthCall > buildCall, true);
});

Deno.test("#89 completion capture must not call resolvePreauthBuffer live", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/_shared/revolutCompletionCapture.ts", import.meta.url),
  );
  assertEquals(src.includes("resolvePreauthBuffer"), false);
  assertEquals(src.includes('from("service_area_preauth_settings")'), false);
  assertEquals(src.includes("resolveFrozenPreauthBufferPence"), true);
  assertEquals(src.includes("parseBookingFinancialPolicy"), true);
});

Deno.test("#89D frozen policy consumption map — buffer/model/provider via trip+session stamps", async () => {
  // Buffer: completion uses resolveFrozenPreauthBufferPence (policy/session/trip).
  // Commission / airport / discounts / financial_model: stamped on trips at accept/fold;
  // settlement reads trip.driver_net_pence / accepted_commission_percent / airport_charge.
  // Waiting: live accrual clocks; buffer headroom remains frozen.
  // Collection model: trips.financial_model immutable after insert.
  const capture = await Deno.readTextFile(
    new URL("../../functions/_shared/revolutCompletionCapture.ts", import.meta.url),
  );
  const settlement = await Deno.readTextFile(
    new URL("../../functions/_shared/missingTripEarningNetRecoverySSOT.ts", import.meta.url),
  );
  assertEquals(capture.includes("resolveFrozenPreauthBufferPence"), true);
  assertEquals(settlement.includes("driver_net_pence"), true);
  assertEquals(settlement.includes("PLATFORM_COLLECTED"), true);
});
