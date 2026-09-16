/**
 * Lock tests — monotonic Payment Session lifecycle from Revolut webhooks.
 *
 * Run:
 *   deno test --allow-read supabase/functions/_shared/paymentSessionWebhookLifecycleLock.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  PAYMENT_SESSION_WEBHOOK_TRANSITION_POLICY,
  paymentSessionStatusRank,
  resolvePaymentSessionStatusFromProviderWebhook,
} from "./paymentSessionWebhookLifecycleResolver.ts";
import { applyPaymentSessionWebhookLifecycleUpdate } from "./applyPaymentSessionWebhookLifecycleUpdate.ts";

const MK007_SESSION = {
  currentStatus: "captured",
  tripId: "trip-mk-007",
  storedCapturedAmountPence: 480,
  financialModel: "PLATFORM_COLLECTED",
  purpose: "RIDE_BOOKING",
};

const MK008_SESSION = {
  currentStatus: "trip_created",
  tripId: "trip-mk-008",
  storedCapturedAmountPence: 716,
  financialModel: "PLATFORM_COLLECTED",
  purpose: "RIDE_BOOKING",
  priorProviderState: "COMPLETED",
};

const MK009_SESSION = {
  currentStatus: "captured",
  tripId: "trip-mk-009",
  storedCapturedAmountPence: 798,
  financialModel: "PLATFORM_COLLECTED",
  purpose: "RIDE_BOOKING",
};

Deno.test("captured + later COMPLETED webhook remains captured", () => {
  const r = resolvePaymentSessionStatusFromProviderWebhook({
    ...MK007_SESSION,
    providerState: "COMPLETED",
    capturedAmountPence: 480,
  });
  assertEquals(r.decision, "KEEP_CURRENT");
  assertEquals(r.reason, "captured_idempotent");
});

Deno.test("captured + later AUTHORISED webhook remains captured", () => {
  const r = resolvePaymentSessionStatusFromProviderWebhook({
    ...MK009_SESSION,
    providerState: "AUTHORISED",
  });
  assertEquals(r.decision, "KEEP_CURRENT");
  assertEquals(r.reason, "authorised_webhook_after_capture_must_not_regress");
});

Deno.test("duplicate COMPLETED webhook is idempotent", () => {
  const r = resolvePaymentSessionStatusFromProviderWebhook({
    currentStatus: "captured",
    providerState: "COMPLETED",
    tripId: "trip-1",
    storedCapturedAmountPence: 699,
    purpose: "RIDE_BOOKING",
  });
  assertEquals(r.decision, "KEEP_CURRENT");
});

Deno.test("trip_created + verified COMPLETED + captured amount advances to captured", () => {
  const r = resolvePaymentSessionStatusFromProviderWebhook({
    currentStatus: "trip_created",
    providerState: "COMPLETED",
    tripId: "trip-1",
    storedCapturedAmountPence: 480,
    purpose: "RIDE_BOOKING",
  });
  assertEquals(r.decision, "ADVANCE");
  assertEquals(r.nextStatus, "captured");
});

Deno.test("COMPLETED without captured amount returns PENDING_EVIDENCE", () => {
  const r = resolvePaymentSessionStatusFromProviderWebhook({
    currentStatus: "trip_created",
    providerState: "COMPLETED",
    tripId: "trip-1",
    purpose: "RIDE_BOOKING",
  });
  assertEquals(r.decision, "PENDING_EVIDENCE");
  assertEquals(r.reason, "completed_without_authoritative_captured_amount");
});

Deno.test("refunded session cannot regress to captured or trip_created", () => {
  for (const providerState of ["COMPLETED", "AUTHORISED"]) {
    const r = resolvePaymentSessionStatusFromProviderWebhook({
      currentStatus: "captured",
      providerState,
      tripId: "trip-1",
      storedCapturedAmountPence: 500,
      refundedAmountPence: 100,
      purpose: "RIDE_BOOKING",
    });
    assertEquals(r.decision, "LIFECYCLE_CONFLICT");
  }
});

Deno.test("released session cannot regress to trip_created", () => {
  const r = resolvePaymentSessionStatusFromProviderWebhook({
    currentStatus: "cancelled",
    providerState: "AUTHORISED",
    tripId: "trip-1",
    holdReleaseState: "released",
    purpose: "RIDE_BOOKING",
  });
  assertEquals(r.decision, "LIFECYCLE_CONFLICT");
});

Deno.test("cancelled/failed session cannot regress to trip_created", () => {
  const cancelled = resolvePaymentSessionStatusFromProviderWebhook({
    currentStatus: "cancelled",
    providerState: "AUTHORISED",
    tripId: "trip-1",
    purpose: "RIDE_BOOKING",
  });
  assertEquals(cancelled.decision, "LIFECYCLE_CONFLICT");

  const failed = resolvePaymentSessionStatusFromProviderWebhook({
    currentStatus: "failed",
    providerState: "AUTHORISED",
    tripId: "trip-1",
    purpose: "RIDE_BOOKING",
  });
  assertEquals(failed.decision, "LIFECYCLE_CONFLICT");
});

Deno.test("conflicting provider capture identity fails closed", () => {
  const r = resolvePaymentSessionStatusFromProviderWebhook({
    currentStatus: "trip_created",
    providerState: "COMPLETED",
    tripId: "trip-1",
    storedCapturedAmountPence: 480,
    storedProviderCaptureId: "cap-a",
    incomingProviderCaptureId: "cap-b",
    purpose: "RIDE_BOOKING",
  });
  assertEquals(r.decision, "LIFECYCLE_CONFLICT");
  assertEquals(r.reason, "conflicting_provider_capture_identity");
});

Deno.test("DRIVER_COLLECTED session fails closed", () => {
  const r = resolvePaymentSessionStatusFromProviderWebhook({
    currentStatus: "trip_created",
    providerState: "COMPLETED",
    tripId: "trip-1",
    storedCapturedAmountPence: 500,
    financialModel: "DRIVER_COLLECTED_COMMISSION_WALLET",
    purpose: "RIDE_BOOKING",
  });
  assertEquals(r.decision, "LIFECYCLE_CONFLICT");
});

Deno.test("PAYMENT_RECOVERY purpose fails closed in booking resolver", () => {
  const r = resolvePaymentSessionStatusFromProviderWebhook({
    currentStatus: "trip_created",
    providerState: "COMPLETED",
    purpose: "PAYMENT_RECOVERY",
    storedCapturedAmountPence: 100,
  });
  assertEquals(r.decision, "LIFECYCLE_CONFLICT");
  assertEquals(r.reason, "payment_recovery_owned_by_recovery_path");
});

Deno.test("MK-007/008/009 pattern: captured must not become trip_created on AUTHORISED", () => {
  for (const session of [MK007_SESSION, MK009_SESSION]) {
    const r = resolvePaymentSessionStatusFromProviderWebhook({
      ...session,
      providerState: "AUTHORISED",
    });
    assertEquals(r.decision, "KEEP_CURRENT");
    assertEquals(r.nextStatus, undefined);
  }
});

Deno.test("MK-008 pattern: trip_created + COMPLETED with amount advances (not trip_created regression)", () => {
  const r = resolvePaymentSessionStatusFromProviderWebhook({
    ...MK008_SESSION,
    providerState: "COMPLETED",
    capturedAmountPence: 716,
  });
  assertEquals(r.decision, "ADVANCE");
  assertEquals(r.nextStatus, "captured");
});

Deno.test("old bug: trip_id must not unconditionally force trip_created on COMPLETED", () => {
  const r = resolvePaymentSessionStatusFromProviderWebhook({
    currentStatus: "captured",
    providerState: "COMPLETED",
    tripId: "trip-mk-007",
    storedCapturedAmountPence: 480,
    purpose: "RIDE_BOOKING",
  });
  assertEquals(r.decision, "KEEP_CURRENT");
  assertEquals(r.nextStatus, undefined);
});

Deno.test("monotonic transition policy forbids captured → trip_created", () => {
  const forbidden = PAYMENT_SESSION_WEBHOOK_TRANSITION_POLICY.filter(
    (t) => t.from === "captured" && t.to === "trip_created",
  );
  assertEquals(forbidden.length, 1);
  assertEquals(forbidden[0].allowed, false);
});

Deno.test("status rank: captured outranks trip_created", () => {
  assertEquals(
    paymentSessionStatusRank("captured") > paymentSessionStatusRank("trip_created"),
    true,
  );
});

Deno.test("compare-and-set race reload preserves newer captured state", async () => {
  let status = "trip_created";

  const supabase = {
    from(table: string) {
      if (table !== "payment_sessions") throw new Error("unexpected table");
      return {
        update(patch: Record<string, unknown>) {
          const casChain = {
            eq(_col: string, _val: unknown) {
              return casChain;
            },
            then(resolve: (v: { error: { message: string; code: string } | null }) => void) {
              if (typeof patch.status === "string") {
                resolve({ error: { message: "cas_miss", code: "PGRST116" } });
                return;
              }
              resolve({ error: null });
            },
          };
          return {
            eq(col: string, val: unknown) {
              if (col === "id") {
                if (val !== "ps-1") return casChain;
                return casChain;
              }
              return casChain;
            },
          };
        },
        select() {
          return {
            eq() {
              return {
                maybeSingle: () => Promise.resolve({
                  data: {
                    id: "ps-1",
                    trip_id: "trip-1",
                    status: "captured",
                    financial_operation_state: "CAPTURED",
                    captured_amount_pence: 480,
                    refunded_amount_pence: 0,
                    hold_release_state: null,
                    provider_capture_id: null,
                    provider_order_id: "ord-1",
                    provider_state: "COMPLETED",
                    financial_model: "PLATFORM_COLLECTED",
                    purpose: "RIDE_BOOKING",
                  },
                }),
              };
            },
          };
        },
      };
    },
  };

  const result = await applyPaymentSessionWebhookLifecycleUpdate({
    supabase: supabase as never,
    context: {
      sessionId: "ps-1",
      tripId: "trip-1",
      providerOrderId: "ord-1",
      currentStatus: "trip_created",
      financialOperationState: "CAPTURING",
      financialModel: "PLATFORM_COLLECTED",
      purpose: "RIDE_BOOKING",
      storedCapturedAmountPence: 480,
    },
    providerState: "COMPLETED",
    incomingCapturedAmountPence: 480,
    providerEvidencePatch: { provider_state: "COMPLETED" },
    statusAdvanceExtras: { captured_amount_pence: 480 },
  });

  assertEquals(result.reloaded, true);
  assertEquals(result.decision, "KEEP_CURRENT");
  assertEquals(result.applied, true);
});

Deno.test("webhook resolver module does not import wallet/settlement/provider-money", async () => {
  const resolverSrc = await Deno.readTextFile(
    new URL("./paymentSessionWebhookLifecycleResolver.ts", import.meta.url),
  );
  const applySrc = await Deno.readTextFile(
    new URL("./applyPaymentSessionWebhookLifecycleUpdate.ts", import.meta.url),
  );
  for (const src of [resolverSrc, applySrc]) {
    assertEquals(src.includes("TRIP_EARNING_NET"), false);
    assertEquals(src.includes("creditCapturedCardTripLedger"), false);
    assertEquals(src.includes("applyCanonicalSettlementAfterCapture"), false);
    assertEquals(src.includes("revolutMerchantRequest"), false);
    assertEquals(src.includes("cancelRevolutOrder"), false);
  }
});

Deno.test("revolut-webhook imports monotonic lifecycle apply helper", async () => {
  const webhookSrc = await Deno.readTextFile(
    new URL("../revolut-webhook/index.ts", import.meta.url),
  );
  assertEquals(
    webhookSrc.includes("applyPaymentSessionWebhookLifecycleUpdate"),
    true,
  );
  assertEquals(
    /sessionUpdate\.status\s*=\s*session\.trip_id\s*\?\s*"trip_created"/.test(webhookSrc),
    false,
  );
});

Deno.test("admin refresh imports monotonic lifecycle apply helper", async () => {
  const refreshSrc = await Deno.readTextFile(
    new URL("../admin-refresh-payment-sessions/index.ts", import.meta.url),
  );
  assertEquals(
    refreshSrc.includes("applyPaymentSessionWebhookLifecycleUpdate"),
    true,
  );
  assertEquals(
    /update\.status\s*=\s*s\.trip_id\s*\?\s*"trip_created"\s*:\s*"payment_authorised"/.test(
      refreshSrc,
    ),
    false,
  );
});

Deno.test("admin refresh cannot regress captured to trip_created or payment_authorised", () => {
  const completed = resolvePaymentSessionStatusFromProviderWebhook({
    currentStatus: "captured",
    providerState: "COMPLETED",
    tripId: "trip-1",
    storedCapturedAmountPence: 699,
    purpose: "RIDE_BOOKING",
  });
  assertEquals(completed.decision, "KEEP_CURRENT");

  const authorised = resolvePaymentSessionStatusFromProviderWebhook({
    currentStatus: "captured",
    providerState: "AUTHORISED",
    tripId: "trip-1",
    storedCapturedAmountPence: 699,
    purpose: "RIDE_BOOKING",
  });
  assertEquals(authorised.decision, "KEEP_CURRENT");
  assertEquals(authorised.nextStatus, undefined);
});

Deno.test("stale AUTHORISED refresh after COMPLETED keeps captured", () => {
  const r = resolvePaymentSessionStatusFromProviderWebhook({
    currentStatus: "captured",
    providerState: "AUTHORISED",
    priorProviderState: "COMPLETED",
    tripId: "trip-1",
    storedCapturedAmountPence: 480,
    purpose: "RIDE_BOOKING",
  });
  assertEquals(r.decision, "KEEP_CURRENT");
});

Deno.test("refund/release/cancel/fail statuses remain terminal under admin refresh resolver", () => {
  for (const currentStatus of ["cancelled", "failed"]) {
    const r = resolvePaymentSessionStatusFromProviderWebhook({
      currentStatus,
      providerState: "AUTHORISED",
      tripId: "trip-1",
      purpose: "RIDE_BOOKING",
    });
    assertEquals(r.decision, "LIFECYCLE_CONFLICT");
  }

  const refunded = resolvePaymentSessionStatusFromProviderWebhook({
    currentStatus: "captured",
    providerState: "AUTHORISED",
    tripId: "trip-1",
    purpose: "RIDE_BOOKING",
    refundedAmountPence: 100,
  });
  assertEquals(refunded.decision, "LIFECYCLE_CONFLICT");

  const released = resolvePaymentSessionStatusFromProviderWebhook({
    currentStatus: "cancelled",
    providerState: "AUTHORISED",
    tripId: "trip-1",
    purpose: "RIDE_BOOKING",
    holdReleaseState: "released",
  });
  assertEquals(released.decision, "LIFECYCLE_CONFLICT");
});

Deno.test("genuinely new pre-capture refresh may still set trip_created when trip exists", () => {
  const r = resolvePaymentSessionStatusFromProviderWebhook({
    currentStatus: "pending_payment",
    providerState: "AUTHORISED",
    tripId: "trip-1",
    purpose: "RIDE_BOOKING",
  });
  assertEquals(r.decision, "ADVANCE");
  assertEquals(r.nextStatus, "trip_created");
});
