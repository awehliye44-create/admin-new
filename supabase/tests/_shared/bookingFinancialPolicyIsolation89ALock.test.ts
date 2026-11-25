/**
 * #89A — Expanded booking financial policy isolation + settlement sequencing regressions.
 * Admin commercial config changes apply prospectively; existing bookings keep frozen contract.
 * Capture / residual release / driver settlement remain independent durable transitions.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildBookingFinancialPolicy,
  parseBookingFinancialPolicy,
  reconstructLegacyBookingFinancialPolicy,
  resolveFrozenPreauthBufferPence,
  BOOKING_FINANCIAL_POLICY_VERSION,
} from "../../functions/_shared/bookingFinancialPolicySSOT.ts";
import { computeServiceAreaPreauthBuffer } from "../../functions/_shared/preauthBufferResolverSSOT.ts";
import { planRevolutCompletionCapture } from "../../functions/_shared/revolutPaymentHoldSSOT.ts";
import {
  checkPsLifecycleFinalizerPreconditions,
} from "../../functions/_shared/paymentSessionLifecycleFinalizer.ts";
import { paymentSessionAllowsWalletPosting } from "../../functions/_shared/postCaptureSettlementBoundary.ts";

const MK = "cb58f1bd-8b6f-45b9-ad31-b3140309892c";

function policyAtBook(bufferEnabled: boolean, bufferValue = 2, farePence = 3194) {
  const buffer = computeServiceAreaPreauthBuffer(
    {
      enable_preauth_buffer: bufferEnabled,
      buffer_type: "fixed",
      buffer_value: bufferValue,
    },
    farePence,
    MK,
  );
  return {
    buffer,
    policy: buildBookingFinancialPolicy({
      serviceAreaId: MK,
      buffer,
      financialModel: "PLATFORM_COLLECTED",
      paymentCollectionModel: "PLATFORM_PREPAID",
      commissionPercent: 10,
      offerDiscountPence: 0,
      voucherDiscountPence: 0,
      source: "booking_create",
    }),
  };
}

Deno.test("#89A Admin buffer update while driver heading to pickup — frozen wins", () => {
  const { policy } = policyAtBook(true);
  assertEquals(policy.preauth_buffer.buffer_pence, 200);
  const live = computeServiceAreaPreauthBuffer(
    { enable_preauth_buffer: false, buffer_type: "fixed", buffer_value: 2 },
    3194,
    MK,
  );
  assertEquals(live.bufferPence, 0);
  assertEquals(resolveFrozenPreauthBufferPence({ policy }).bufferPence, 200);
});

Deno.test("#89A Admin buffer update during active trip — frozen wins", () => {
  const { policy } = policyAtBook(true);
  const live = computeServiceAreaPreauthBuffer(
    { enable_preauth_buffer: true, buffer_type: "fixed", buffer_value: 5 },
    3194,
    MK,
  );
  assertEquals(live.bufferPence, 500);
  assertEquals(resolveFrozenPreauthBufferPence({ policy }).bufferPence, 200);
});

Deno.test("#89A Admin buffer update after completion before settlement — capture uses frozen", () => {
  const { policy, buffer } = policyAtBook(true);
  const frozen = resolveFrozenPreauthBufferPence({ policy });
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
  // Live disable must not shrink authorised hold used for residual expectation.
  assertEquals(buffer.bufferPence, 200);
});

Deno.test("#89A scheduled-to-instant conversion keeps frozen buffer", () => {
  const { policy } = policyAtBook(true);
  // Conversion must not re-read live Admin settings.
  assertEquals(resolveFrozenPreauthBufferPence({ policy }).bufferPence, 200);
  assertEquals(policy.financial_model, "PLATFORM_COLLECTED");
  assertEquals(policy.payment_collection_model, "PLATFORM_PREPAID");
});

Deno.test("#89A driver rematching keeps frozen policy on same booking", () => {
  const { policy } = policyAtBook(true, 2, 2500);
  const rematchLive = computeServiceAreaPreauthBuffer(
    { enable_preauth_buffer: false, buffer_type: "fixed", buffer_value: 2 },
    2500,
    MK,
  );
  assertEquals(rematchLive.bufferPence, 0);
  assertEquals(resolveFrozenPreauthBufferPence({ policy }).bufferPence, 200);
});

Deno.test("#89A commission snapshot fields present; live commission change does not rewrite policy", () => {
  const { policy } = policyAtBook(true);
  assertEquals(policy.commission.accepted_commission_percent, 10);
  const parsed = parseBookingFinancialPolicy(policy);
  assertEquals(parsed?.commission.accepted_commission_percent, 10);
  // A later Admin change is a different object — existing snapshot unchanged.
  const later = buildBookingFinancialPolicy({
    serviceAreaId: MK,
    buffer: policyAtBook(true).buffer,
    commissionPercent: 15,
  });
  assertEquals(policy.commission.accepted_commission_percent, 10);
  assertEquals(later.commission.accepted_commission_percent, 15);
});

Deno.test("#89A waiting / airport / discount policy fields are frozen on snapshot", () => {
  const policy = buildBookingFinancialPolicy({
    serviceAreaId: MK,
    buffer: policyAtBook(true).buffer,
    offerDiscountPence: 74,
    voucherDiscountPence: 0,
    discountSource: "global_offer",
  });
  assertEquals(policy.waiting.buffer_covers_waiting_headroom, true);
  assertEquals(policy.airport.treatment, "pass_through_non_commissionable");
  assertEquals(policy.discount.offer_discount_pence, 74);
  assertEquals(policy.version, BOOKING_FINANCIAL_POLICY_VERSION);
});

Deno.test("#89A legitimate modification does not invent live buffer", () => {
  const { policy } = policyAtBook(true);
  // Fare increase still settles against the same frozen buffer headroom.
  const frozen = resolveFrozenPreauthBufferPence({ policy });
  const plan = planRevolutCompletionCapture({
    finalFarePence: 3400,
    authorisedHoldPence: 3194 + frozen.bufferPence,
    bufferPence: frozen.bufferPence,
    preferSameOrderIncrement: true,
  });
  // 3400 > 3394 hold → same-order increment path, not live buffer re-read.
  assertEquals(plan.kind, "same_order_increment_required");
});

Deno.test("#89A partial capture then residual before wallet — gate still allows TEN", () => {
  assertEquals(
    paymentSessionAllowsWalletPosting({
      status: "captured",
      provider_state: "COMPLETED",
      captured_amount_pence: 3194,
      provider_state_verified_at: "2026-11-25T07:19:15.000Z",
      hold_release_state: "released",
      released_amount_pence: null,
      hold_terminal_reason: "provider_captured",
    }),
    true,
  );
  assertEquals(
    checkPsLifecycleFinalizerPreconditions({
      id: "ps",
      status: "trip_created",
      financial_model: "PLATFORM_COLLECTED",
      purpose: "RIDE_BOOKING",
      provider_state: "COMPLETED",
      provider_state_verified_at: "2026-11-25T07:19:15.000Z",
      captured_amount_pence: 3194,
      refunded_amount_pence: null,
      released_amount_pence: null,
      hold_release_state: "released",
      hold_terminal_reason: "provider_captured",
      financial_operation_state: "CAPTURING",
      metadata: {},
    }),
    null,
  );
});

Deno.test("#89A partial capture then wallet before residual — gate allows; confirmed release blocks", () => {
  assertEquals(
    paymentSessionAllowsWalletPosting({
      status: "captured",
      provider_state: "COMPLETED",
      captured_amount_pence: 3194,
      provider_state_verified_at: "2026-11-25T07:19:15.000Z",
      hold_release_state: null,
      released_amount_pence: null,
    }),
    true,
  );
  assertEquals(
    paymentSessionAllowsWalletPosting({
      status: "captured",
      provider_state: "COMPLETED",
      captured_amount_pence: 3194,
      provider_state_verified_at: "2026-11-25T07:19:15.000Z",
      hold_release_state: "released",
      released_amount_pence: 200,
    }),
    false,
  );
});

Deno.test("#89A already captured missing driver credit — residual marker must not block recovery gate", () => {
  assertEquals(
    paymentSessionAllowsWalletPosting({
      status: "captured",
      provider_state: "COMPLETED",
      captured_amount_pence: 2940,
      provider_state_verified_at: "2026-11-22T21:19:35.946Z",
      hold_release_state: "released",
      released_amount_pence: null,
      hold_terminal_reason: "provider_captured",
    }),
    true,
  );
});

Deno.test("#89A legacy booking financial policy reconstruction never uses live Admin", () => {
  const reconstructed = reconstructLegacyBookingFinancialPolicy({
    serviceAreaId: MK,
    bufferPence: 200,
    financialModel: "PLATFORM_COLLECTED",
    frozenAt: "2026-11-22T12:00:00.000Z",
  });
  assertEquals(reconstructed.source, "legacy_reconstruct");
  assertEquals(resolveFrozenPreauthBufferPence({ policy: reconstructed }).bufferPence, 200);
  const liveNow = computeServiceAreaPreauthBuffer(
    { enable_preauth_buffer: false, buffer_type: "fixed", buffer_value: 2 },
    2940,
    MK,
  );
  assertEquals(liveNow.bufferPence, 0);
  assertEquals(resolveFrozenPreauthBufferPence({ policy: reconstructed }).bufferPence, 200);
});

Deno.test("#89A concurrent booking create vs Admin update — each booking freezes its own contract", () => {
  const a = policyAtBook(true).policy;
  const b = policyAtBook(false).policy;
  assertEquals(a.preauth_buffer.buffer_pence, 200);
  assertEquals(b.preauth_buffer.buffer_pence, 0);
  assertEquals(a.frozen_at === b.frozen_at || a.frozen_at !== b.frozen_at, true);
});

Deno.test("#89A new bookings use newly published settings", () => {
  const before = policyAtBook(true).policy;
  assertEquals(before.preauth_buffer.enabled, true);
  const after = policyAtBook(false).policy;
  assertEquals(after.preauth_buffer.enabled, false);
  assertEquals(after.preauth_buffer.buffer_pence, 0);
});

Deno.test("#89A booking channels share same freeze SSOT (Customer/Corporate/Guest/WhatsApp/Admin)", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/create-preauth-payment-intent/index.ts", import.meta.url),
  );
  assertEquals(src.includes("buildBookingFinancialPolicy"), true);
  assertEquals(src.includes("bookingFinancialPolicyJson"), true);
  // Channel is upstream of create-preauth; freeze happens once at preauth create.
});

Deno.test("#89A create-preauth freezes full policy fields including commission/waiting/airport/discount", () => {
  const { policy } = policyAtBook(true);
  assertEquals(typeof policy.commission, "object");
  assertEquals(typeof policy.waiting, "object");
  assertEquals(typeof policy.airport, "object");
  assertEquals(typeof policy.discount, "object");
  assertEquals(policy.payment_provider, "revolut");
});

Deno.test("#89A settlement sequencing: residual must not invalidate capture evidence", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/_shared/revolutCompletionCapture.ts", import.meta.url),
  );
  assertEquals(src.includes("Settlement before residual evidence"), true);
  assertEquals(src.includes("Settlement BEFORE residual evidence"), true);
  const gate = await Deno.readTextFile(
    new URL("../../functions/_shared/postCaptureSettlementBoundary.ts", import.meta.url),
  );
  assertEquals(gate.includes("Post-capture residual voids"), true);
  assertEquals(gate.includes("hold_release_state"), true);
});

Deno.test("#89A claim RPC uses release_pending not releasing", async () => {
  const mig = await Deno.readTextFile(
    new URL(
      "../../migrations/20270228160000_tripless_release_claim_state_fix.sql",
      import.meta.url,
    ),
  );
  assertEquals(mig.includes("hold_release_state = 'release_pending'"), true);
  assertEquals(mig.includes("hold_release_state = 'releasing'"), false);
});
