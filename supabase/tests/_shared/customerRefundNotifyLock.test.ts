/**
 * LOCK — customer refund confirmation (push + email + SMS).
 *
 * Confirmed refunds only. Pending/failed/hold-release must not notify.
 * Per provider_refund_id + channel idempotency. MK-261104-003 apology line.
 *
 * Run:
 *   deno test -A --config supabase/functions/deno.json \
 *     supabase/tests/_shared/customerRefundNotifyLock.test.ts \
 *     supabase/tests/_shared/scheduledLateCancelActiveAssignmentLock.test.ts
 */
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildCustomerRefundNotifyCopy,
  MK_261104_003_REFUND_APOLOGY,
  shouldNotifyCustomerRefund,
} from "../../functions/_shared/customerRefundNotifySSOT.ts";
import { resolveTerminalPaymentDecision } from "../../functions/_shared/terminalFeeDecisionSSOT.ts";

Deno.test("copy: general refund wording with amount + booking reference", () => {
  const copy = buildCustomerRefundNotifyCopy({
    amountPence: 500,
    bookingReference: "MK-261104-099",
  });
  assertEquals(copy.title, "Your ONECAB refund: £5.00");
  assertEquals(copy.subject, copy.title);
  assertStringIncludes(copy.body, "We’ve refunded £5.00 for booking MK-261104-099");
  assertStringIncludes(copy.body, "original payment method");
  assertEquals(copy.body.includes(MK_261104_003_REFUND_APOLOGY), false);
});

Deno.test("copy: MK-261104-003 includes the late-cancel apology", () => {
  const copy = buildCustomerRefundNotifyCopy({
    amountPence: 500,
    bookingReference: "MK-261104-003",
    tripCode: "MK-261104-003",
  });
  assertStringIncludes(copy.body, MK_261104_003_REFUND_APOLOGY);
});

Deno.test("eligibility: confirmed refund only; pending/failed/hold-release excluded", () => {
  assertEquals(
    shouldNotifyCustomerRefund({
      providerRefundId: "ref_1",
      amountPence: 500,
      refundStatus: "confirmed",
    }),
    true,
  );
  assertEquals(
    shouldNotifyCustomerRefund({
      providerRefundId: "ref_1",
      amountPence: 500,
      refundStatus: "pending",
    }),
    false,
  );
  assertEquals(
    shouldNotifyCustomerRefund({
      providerRefundId: "ref_1",
      amountPence: 500,
      refundStatus: "failed",
    }),
    false,
  );
  assertEquals(
    shouldNotifyCustomerRefund({
      providerRefundId: "ref_1",
      amountPence: 500,
      isHoldRelease: true,
    }),
    false,
  );
  assertEquals(
    shouldNotifyCustomerRefund({
      providerRefundId: "",
      amountPence: 500,
    }),
    false,
  );
  assertEquals(
    shouldNotifyCustomerRefund({
      providerRefundId: "ref_1",
      amountPence: 0,
    }),
    false,
  );
});

Deno.test("partial refund amount formats correctly", () => {
  const copy = buildCustomerRefundNotifyCopy({
    amountPence: 266,
    bookingReference: "MK-TEST-001",
  });
  assertEquals(copy.title, "Your ONECAB refund: £2.66");
  assertStringIncludes(copy.body, "£2.66");
});

Deno.test("source: applyProviderRefund + session upsert call shared notify; hold release does not", async () => {
  const applySrc = await Deno.readTextFile(
    new URL("../../functions/_shared/applyProviderRefund.ts", import.meta.url),
  );
  const sessionSrc = await Deno.readTextFile(
    new URL("../../functions/_shared/paymentSessionSSOT.ts", import.meta.url),
  );
  const disposeSrc = await Deno.readTextFile(
    new URL("../../functions/_shared/terminalTripPaymentDisposition.ts", import.meta.url),
  );
  const migration = await Deno.readTextFile(
    new URL(
      "../../migrations/20261229140000_customer_refund_notification_deliveries.sql",
      import.meta.url,
    ),
  );

  assertStringIncludes(applySrc, "notifyCustomerConfirmedRefund");
  assertStringIncludes(sessionSrc, "notifyCustomerConfirmedRefund");
  assertEquals(disposeSrc.includes("notifyCustomerConfirmedRefund"), false);
  assertStringIncludes(migration, "customer_refund_notification_deliveries");
  assertStringIncludes(migration, "UNIQUE (provider_refund_id, channel)");
});

Deno.test("late-cancel rematch still NO_FEE / full release after this change", () => {
  const d = resolveTerminalPaymentDecision({
    evidence: {
      trip_id: "07d3d9cf-1e50-4935-aaab-35aea4b5422c",
      trip_status: "cancelled",
      started_at: null,
      arrived_at: null,
      free_wait_expires_at: null,
      cancelled_at: "2026-11-04T22:17:50.241Z",
      cancelled_by: "rider",
      scheduled_at: "2026-11-04T22:25:00.000Z",
      cancellation_grace_expires_at: null,
      driver_id: null,
      confirmed_driver_id: null,
      no_show_recorded: false,
      authorised_amount_pence: 500,
      previously_captured_amount_pence: 0,
      payment_session_id: "9d1c74ca-6ce4-4435-91d6-b47ecf0fd0e7",
      provider: "revolut",
      decision_at: "2026-11-04T22:17:50.241Z",
    },
    config: {
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
    },
  });
  assertEquals(d.disposition_reason, "NO_FEE_FULL_RELEASE");
  assertEquals(d.capture_required_pence, 0);
  assertEquals(d.release_required_pence, 500);
  assert(d.provider_action === "void_full");
});
