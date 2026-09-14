/**
 * Tip channel + window locks (no provider I/O).
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";
import { dirname, fromFileUrl, join } from "https://deno.land/std@0.224.0/path/mod.ts";
import {
  isCustomerAppTipBookingSource,
  isCustomerAppTipChannelEligible,
} from "./tipChannelEligibilitySSOT.ts";
import { TIP_WINDOW_MS, TIP_WINDOW_STATUS } from "../../../shared/tipWindowConstants.ts";
import { isTipWindowOpen, tipCollectedFromConfirmedCapture, invoiceTipPenceFromConfirmedCapture, recordedTipPenceAfterCapture, storedCaptureAllowsTipWindowClose, tipWindowCloseAllowedAfterFinalize, expiryFareOnlyTipPence, expiredUnclosedTipWindowForbidsTipCapture, visibleTipAfterExpiredWindowClose } from "../../../shared/tripPaymentFinalised.ts";
import { capturedTipReversalPence } from "./providerRefundSSOT.ts";
import { resolveTripInvoicePaymentState } from "./tripInvoicePaymentStateSSOT.ts";
import { receiptTipPence } from "./receiptTipSSOT.ts";

const SHARED = dirname(fromFileUrl(import.meta.url));

Deno.test("captured tip is invoiceable; unexplained excess over fare+tip is not", () => {
  const covered = resolveTripInvoicePaymentState({
    trip: {
      id: "trip-tip",
      payment_method: "card",
      final_fare_pence: 716,
      tip_pence: 200,
    },
    paymentSessions: [
      { trip_id: "trip-tip", status: "captured", captured_amount_pence: 916, provider_order_id: "ord-tip" },
    ],
  });
  assertEquals(covered.paymentClassification, "FULLY_PAID");
  assertEquals(covered.authoritativePaidPence, 916);
  assertEquals(covered.invoiceEligible, true);

  const over = resolveTripInvoicePaymentState({
    trip: {
      id: "trip-over",
      payment_method: "card",
      final_fare_pence: 716,
      tip_pence: 200,
    },
    paymentSessions: [
      { trip_id: "trip-over", status: "captured", captured_amount_pence: 982, provider_order_id: "ord-over" },
    ],
  });
  assertEquals(over.paymentClassification, "RECONCILIATION_REQUIRED");
  assertEquals(over.invoiceEligible, false);

  const fareRefundKeepsTip = resolveTripInvoicePaymentState({
    trip: {
      id: "trip-fare-refund",
      payment_method: "card",
      final_fare_pence: 716,
      tip_pence: 200,
    },
    paymentSessions: [
      {
        trip_id: "trip-fare-refund",
        status: "captured",
        captured_amount_pence: 916,
        refunded_amount_pence: 100,
        provider_order_id: "ord-fare-refund",
      },
    ],
  });
  assertEquals(fareRefundKeepsTip.paymentClassification, "FULLY_PAID");
  assertEquals(fareRefundKeepsTip.authoritativePaidPence, 816);
  assertEquals(fareRefundKeepsTip.invoiceEligible, true);
});

Deno.test("receipt tip line follows confirmed payment capture, not a trip hold stamp", () => {
  const trip = {
    payment_method: "card",
    final_fare_pence: 716,
    tip_pence: 200,
    tip_amount_pence: 200,
    capture_amount_pence: 916,
  };
  const fareOnlyPayments = [{ status: "captured", captured_amount_pence: 716, amount_pence: 916 }];
  assertEquals(receiptTipPence(trip, fareOnlyPayments), 0);

  const coveredPayments = [{ status: "captured", captured_amount_pence: 916 }];
  assertEquals(receiptTipPence({ ...trip, capture_amount_pence: 716 }, coveredPayments), 200);
});

Deno.test("tip window is 20 minutes", () => {
  assertEquals(TIP_WINDOW_MS, 20 * 60 * 1000);
  assertEquals(TIP_WINDOW_STATUS.OPEN, "open");
  assertEquals(TIP_WINDOW_STATUS.CLOSED, "closed");
});

Deno.test("Customer App sources eligible; WhatsApp/guest/corporate excluded", () => {
  assertEquals(isCustomerAppTipBookingSource("customer"), true);
  assertEquals(isCustomerAppTipBookingSource("customer_app"), true);
  assertEquals(isCustomerAppTipBookingSource("choose_ride"), true);
  assertEquals(isCustomerAppTipChannelEligible({ booking_source: "customer" }), true);
  assertEquals(isCustomerAppTipChannelEligible({ booking_source: "whatsapp_booking" }), false);
  assertEquals(isCustomerAppTipChannelEligible({ booking_source: "guest" }), false);
  assertEquals(isCustomerAppTipChannelEligible({ booking_source: "guest_web" }), false);
  assertEquals(isCustomerAppTipChannelEligible({ booking_source: "corporate" }), false);
  assertEquals(
    isCustomerAppTipChannelEligible({ booking_source: "customer", corporate_account_id: "acct" }),
    false,
  );
});

Deno.test("tip window open requires stamped expires_at (no completed_at invent)", () => {
  const now = Date.now();
  assertEquals(
    isTipWindowOpen({
      tip_window_expires_at: new Date(now + 60_000).toISOString(),
      tip_window_closed_at: null,
      completed_at: new Date(now - TIP_WINDOW_MS - 1).toISOString(),
    }, now),
    true,
  );
  assertEquals(
    isTipWindowOpen({
      tip_window_expires_at: new Date(now - 1).toISOString(),
      tip_window_closed_at: null,
      completed_at: new Date(now).toISOString(),
    }, now),
    false,
  );
  assertEquals(
    isTipWindowOpen({
      tip_window_expires_at: null,
      tip_window_closed_at: null,
      completed_at: new Date(now - 60_000).toISOString(),
    }, now),
    false,
  );
});

Deno.test("stop-workflow defers capture for tip window; TEN posted; no FR mutation", async () => {
  const stop = await Deno.readTextFile(join(SHARED, "../stop-workflow/index.ts"));
  assert(stop.includes("deferCaptureForTipWindow"));
  assert(stop.includes("tip_window_capture_deferred"));
  assert(stop.includes("postTripEarningNetCanonical"));
  assert(stop.includes("TIP_WINDOW_STATUS.OPEN"));
  assert(stop.includes("isCustomerAppTipChannelEligible"));
  // Fallback trip row (if post-complete select fails) must still see channel + provider.
  assert(stop.includes("booking_source, corporate_account_id"));
  assert(stop.includes("tipWindowStampErr") || stop.includes("tip window stamp failed"));
  assert(stop.includes("tipWindowDeferred"));
  assert(!/from\(["']financial_reconciliation/.test(stop));
});

Deno.test("already-captured fare does not invent an unpaid tip credit", () => {
  assertEquals(
    tipCollectedFromConfirmedCapture({
      captureAmountPence: 1000,
      farePlusTipPence: 1500,
      requestedTipPence: 500,
    }),
    { tipCollectedPence: 0, tipShortfallPence: 500 },
  );
  assertEquals(
    tipCollectedFromConfirmedCapture({
      captureAmountPence: 1500,
      farePlusTipPence: 1500,
      requestedTipPence: 500,
    }),
    { tipCollectedPence: 500, tipShortfallPence: 0 },
  );
  assertEquals(
    tipCollectedFromConfirmedCapture({
      captureAmountPence: 1000,
      farePlusTipPence: 1000,
      requestedTipPence: 0,
    }),
    { tipCollectedPence: 0, tipShortfallPence: 0 },
  );
  assertEquals(
    invoiceTipPenceFromConfirmedCapture({
      paymentMethod: "card",
      captureAmountPence: 1000,
      finalFarePence: 1000,
      requestedTipPence: 500,
    }),
    0,
  );
  assertEquals(
    invoiceTipPenceFromConfirmedCapture({
      paymentMethod: "cash",
      captureAmountPence: 0,
      finalFarePence: 1000,
      requestedTipPence: 500,
    }),
    500,
  );
  assertEquals(recordedTipPenceAfterCapture(undefined), null);
  assertEquals(recordedTipPenceAfterCapture(null), null);
  assertEquals(recordedTipPenceAfterCapture(200), 200);
  assertEquals(recordedTipPenceAfterCapture(0), 0);
  assertEquals(tipWindowCloseAllowedAfterFinalize({ capture_amount_pence: 1000 }), true);
  assertEquals(tipWindowCloseAllowedAfterFinalize({ status: "payment_shortfall", capture_amount_pence: 0 }), false);
  assertEquals(tipWindowCloseAllowedAfterFinalize({ status: "processing" }), false);
  assertEquals(tipWindowCloseAllowedAfterFinalize(null), false);
  assertEquals(storedCaptureAllowsTipWindowClose({
    paymentStatus: "captured",
    captureAmountPence: 0,
  }), false);
  assertEquals(storedCaptureAllowsTipWindowClose({
    paymentStatus: "captured",
    captureAmountPence: 1000,
  }), true);
  assertEquals(storedCaptureAllowsTipWindowClose({
    paymentMethod: "cash",
    paymentStatus: "collected_cash",
    captureAmountPence: 0,
  }), true);
});

Deno.test("submit-customer-trip-tip gates channel + closes window status", async () => {
  const tip = await Deno.readTextFile(join(SHARED, "../submit-customer-trip-tip/index.ts"));
  assert(tip.includes("TIPS_NOT_ALLOWED_FOR_CHANNEL"));
  assert(tip.includes("isCustomerAppTipChannelEligible"));
  assert(!tip.includes("tipAmountPence > 0 &&\n      !isCustomerAppTipChannelEligible"));
  assert(tip.includes("including tip=0 and Skip"));
  assert(tip.includes("TIP_WINDOW_STATUS.CLOSED"));
  assert(tip.includes("recordedTipPenceAfterCapture"));
  assert(!tip.includes("tip_collected_pence ?? tipPence"));
  assert(tip.includes("FINANCIAL_MODEL_VIOLATION"));
  // Capture while window open, then close — crash-safe (no stuck closed+uncaptured).
  assert(tip.includes('source: "submit_customer_trip_tip"'));
  assert(tip.includes("await closeWindow()"));
  assert(tip.includes("revertTipClaim"));
  // Skip must not wipe a concurrent positive tip claim — finish claimed tip instead.
  assert(tip.includes("tipAmountPence === 0"));
  assert(tip.includes("tipAmountPence = existingTip") || tip.includes("tipAmountPence = racedTip"));
  assert(tip.includes("requires Revolut provider"));
  assert(tip.includes("tip_collected_pence"));
  // Failed tips_enabled read is not TIPS_DISABLED (client would drop the tip).
  assert(tip.includes("TIP_STATUS_UNAVAILABLE"));
  assert(tip.includes("areaErr"));
  // Tips off while the window is still open must not return before fare capture.
  assert(tip.includes("Do not capture that tip"));
});

Deno.test("stale-holds sweep and finalize refuse open tip window", async () => {
  const sweep = await Deno.readTextFile(join(SHARED, "../sweep-revolut-stale-holds/index.ts"));
  assert(sweep.includes("isTipWindowOpen"));
  assert(sweep.includes("tip_window_open"));
  assert(sweep.includes("expiredUnclosedTipWindowForbidsTipCapture"));
  assert(sweep.includes("expiryFareOnlyTipPence"));
  assert(sweep.includes("would_retry_completed_authorised_capture_fare_only"));
  assert(sweep.includes("heal_completed") || sweep.includes("would_heal_completed_capture"));
  const heal = sweep.indexOf("would_heal_completed_capture");
  assert(heal > 0);
  assert(sweep.slice(heal - 400, heal).includes("tip_window_open"));
  assert(sweep.includes("TIP_WINDOW_STATUS.CLOSED"));
  const finalize = await Deno.readTextFile(join(SHARED, "../finalize-trip-and-capture/index.ts"));
  assert(finalize.includes("TIP_WINDOW_OPEN"));
  assert(finalize.includes("isTipWindowOpen"));
  assert(finalize.includes("submit_customer_trip_tip"));
  assert(finalize.includes("allowOpenTipWindow"));
  assert(finalize.includes("allowOpenTipWindowCapture"));
  assert(finalize.includes("extractBearerToken"));
  const adminPre = await Deno.readTextFile(join(SHARED, "adminCaptureTripPaymentPreconditions.ts"));
  assert(adminPre.includes("TIP_WINDOW_OPEN"));
  assert(adminPre.includes("tip_window_expires_at"));
  assert(adminPre.includes("tip_window_closed_at"));
  assert(adminPre.includes("unresolved") || adminPre.includes("unclosed") || adminPre.includes("Tip window still unresolved"));
  const adminCap = await Deno.readTextFile(join(SHARED, "adminCaptureTripPaymentSSOT.ts"));
  assert(adminCap.includes("tripHasConflictingFinalCapture"));
  assert(adminCap.includes("FINAL_CAPTURE_AMOUNT_CONFLICT"));
  const core = await Deno.readTextFile(join(SHARED, "finalizeRevolutTripCapture.ts"));
  assert(core.includes("isTipWindowOpen"));
  assert(core.includes("allowOpenTipWindow"));
  const capture = await Deno.readTextFile(join(SHARED, "revolutCompletionCapture.ts"));
  assert(capture.includes("tipCollectedFromConfirmedCapture"));
  assert(!capture.includes("?? finalFarePence"));
  assert(capture.includes("tipCoverage.tipCollectedPence"));
  assert(capture.includes("tripHasConflictingFinalCapture"));
  assert(capture.includes("different amount refused"));
  assert(capture.includes("refuseDifferentFinalCapture"));
  assert(capture.includes("freshSessionCapture"));
  assert(capture.includes("freshPaymentCapture"));
  assert(capture.includes("captureSessionByTrip"));
  const idem = await Deno.readTextFile(join(SHARED, "revolutCaptureIdempotencySSOT.ts"));
  assert(idem.includes("extractConfirmedCaptureAmountPence"));
  assert(!idem.includes("authorised > 0 ? authorised"));
  const stop = await Deno.readTextFile(join(SHARED, "../stop-workflow/index.ts"));
  assert(stop.includes("tipWindowOnComplete"));
  assert(stop.includes("tip window skipped; no provider order"));
  assert(stop.includes("Boolean(providerOrderId)"));
  assert(stop.includes("same write as status=completed"));
  assert(stop.includes("TIP_WINDOW_STAMP_UNAVAILABLE"));
  const remediate = await Deno.readTextFile(join(SHARED, "../admin-remediate-trip-payment/index.ts"));
  assert(remediate.includes("tip_amount_pence"));
  assert(remediate.includes("expiredUnclosedTipWindowForbidsTipCapture"));
  assert(remediate.includes("expiryFareOnlyTipPence"));
  assert(!remediate.includes("tipPence: 0"));
  assert(remediate.includes("TIP_WINDOW_STATUS.CLOSED"));
  assert(remediate.includes("invoiceTipPenceFromConfirmedCapture"));
  assert(remediate.includes("recordedTipPenceAfterCapture"));
  assert(!remediate.includes("tip_collected_pence ?? tipPence"));
});

Deno.test("invoice tip window matches TIP_WINDOW_MS (20m)", async () => {
  const inv = await Deno.readTextFile(join(SHARED, "tripInvoiceEligibility.ts"));
  assert(inv.includes("TIP_WINDOW_MS"));
  assert(!inv.includes("2 * 60 * 1000"));
  assert(inv.includes("tip_window_expires_at) return false"));
  assert(inv.includes('=== "open") return false'));
  const invoice = await Deno.readTextFile(join(SHARED, "tripInvoice.ts"));
  assert(invoice.includes("isTipWindowClosedForInvoice"));
  assert(invoice.includes("invoiceTipPenceFromConfirmedCapture"));
  assert(invoice.includes("tipPenceRemainingAfterRefund"));
  assert(invoice.includes("invoiceTotalPence"));
  assert(invoice.includes("buildLines(trip, total, coveredTip, paymentState.refundedPence)"));
  assert(invoice.includes("invoicePdfStaleAfterRefund"));
  assert(invoice.includes('label: "Refund"'));
  assert(!invoice.includes("captureAmountPence: trip.capture_amount_pence"));
  const retire = await Deno.readTextFile(
    join(SHARED, "../../migrations/20261109590000_phase_tip_retire_legacy_completion_triggers.sql"),
  );
  assert(retire.includes("Tip wallet credit is posted only after a confirmed capture"));
  assert(!retire.includes("INSERT INTO public.driver_wallet_ledger"));
  assert(!retire.includes("interval '2 minutes'"));
  const payState = await Deno.readTextFile(join(SHARED, "tripInvoicePaymentStateSSOT.ts"));
  assert(payState.includes("invoiceTipPenceFromConfirmedCapture"));
  assert(payState.includes("explainedPaidPence"));
  const invoiceService = await Deno.readTextFile(join(SHARED, "tripInvoiceService.ts"));
  assert(invoiceService.includes("isTipWindowClosedForInvoice"));
  assert(invoiceService.includes("invoiceStoredBeforeRefund"));
  const invoiceData = await Deno.readTextFile(join(SHARED, "tripInvoiceData.ts"));
  assert(invoiceData.includes("receiptTipPence"));
  assert(invoiceData.includes("settlement + tip"));
  const receiptTip = await Deno.readTextFile(join(SHARED, "receiptTipSSOT.ts"));
  assert(receiptTip.includes("invoiceTipPenceFromConfirmedCapture"));
  assert(receiptTip.includes("sumPaymentsCapturedPence"));
  const paymentsList = await Deno.readTextFile(join(SHARED, "../admin-payments-list/index.ts"));
  assert(paymentsList.includes("tipPenceRemainingAfterRefund"));
  assert(!paymentsList.includes("tip: t.tip_pence || 0"));
  const paymentDetail = await Deno.readTextFile(join(SHARED, "../admin-payment-detail/index.ts"));
  assert(paymentDetail.includes("tipPenceRemainingAfterRefund"));
  assert(!paymentDetail.includes("const tip = trip.tip_pence || 0"));
  const extra = await Deno.readTextFile(join(SHARED, "extraPaymentRecoverySSOT.ts"));
  assert(extra.includes("invoiceTipPenceFromConfirmedCapture"));
  const extraPay = await Deno.readTextFile(join(SHARED, "../admin-request-extra-payment/index.ts"));
  assert(extraPay.includes("TIP_WINDOW_OPEN"));
  const recovery = await Deno.readTextFile(join(SHARED, "../create-payment-recovery/index.ts"));
  assert(recovery.includes("TIP_WINDOW_OPEN"));
});

Deno.test("expired window with a stale claimed tip captures fare only", () => {
  const staleClaimPence = 500;
  const farePence = 1000;
  const tipPence = expiryFareOnlyTipPence(staleClaimPence);
  assertEquals(tipPence, 0);
  assertEquals(
    invoiceTipPenceFromConfirmedCapture({
      paymentMethod: "card",
      captureAmountPence: farePence,
      finalFarePence: farePence,
      requestedTipPence: tipPence,
    }),
    0,
  );
  assertEquals(
    tipCollectedFromConfirmedCapture({
      captureAmountPence: farePence + staleClaimPence,
      farePlusTipPence: farePence + tipPence,
      requestedTipPence: tipPence,
    }).tipCollectedPence,
    0,
  );
  const expired = {
    tip_window_expires_at: new Date(Date.now() - 1).toISOString(),
    tip_window_closed_at: null,
  };
  assertEquals(expiredUnclosedTipWindowForbidsTipCapture(expired), true);
  assertEquals(expiryFareOnlyTipPence(staleClaimPence), 0);
  // Covered stored capture is not enough. No prior submit settlement → clear the claim.
  assertEquals(visibleTipAfterExpiredWindowClose({
    requestedTipPence: 200,
    priorSettledTipPence: 0,
    captureAmountPence: 1200,
    farePence: 1000,
  }), 0);
  // Before-expiry submit already captured and settled the tip → keep it, do not recapture.
  assertEquals(visibleTipAfterExpiredWindowClose({
    requestedTipPence: 200,
    priorSettledTipPence: 200,
    captureAmountPence: 1200,
    farePence: 1000,
  }), 200);
  // Settled tip the stored capture does not cover is still a stale claim.
  assertEquals(visibleTipAfterExpiredWindowClose({
    requestedTipPence: 200,
    priorSettledTipPence: 200,
    captureAmountPence: 1000,
    farePence: 1000,
  }), 0);
  assertEquals(expiredUnclosedTipWindowForbidsTipCapture({
    tip_window_expires_at: new Date(Date.now() + 60_000).toISOString(),
    tip_window_closed_at: null,
  }), false);
});

Deno.test("tip expiry job accepts authorised + authorized spellings", async () => {
  const exp = await Deno.readTextFile(join(SHARED, "../capture-expired-tip-windows/index.ts"));
  assert(exp.includes('"authorised"'));
  assert(exp.includes('"authorized"'));
  assert(exp.includes('"preauth_authorised"'));
  assert(exp.includes("tip_window_closed_at"));
  assert(exp.includes("expiryFareOnlyTipPence"));
  assert(exp.includes("payment_session_id.not.is.null"));
  assert(exp.includes('"pending"'));
  assert(exp.includes("would_close_nothing_to_capture"));
  assert(exp.includes("Session order copy failed") || exp.includes("row.provider_order_id = sessionOrderId"));
  assert(exp.includes("would_capture_fare_only"));
  assert(exp.includes("tipPence,"));
  assert(!exp.includes("recordedTipPenceAfterCapture"));
  assert(!exp.includes("Math.max(\n          0,\n          Math.round(Number(trip.tip_amount_pence ?? trip.tip_pence ?? 0) || 0),\n        );\n        const rec = await invokeFinalizeTripCapture"));
  const sweep = await Deno.readTextFile(join(SHARED, "../sweep-revolut-stale-holds/index.ts"));
  assert(sweep.includes("tipCollectedFromConfirmedCapture"));
  assert(sweep.includes("recordedTipPenceAfterCapture"));
  assert(sweep.includes("extractConfirmedCaptureAmountPence"));
  assert(!sweep.includes("?? row.authorised_amount_pence"));
  assert(!sweep.includes("tip_collected_pence ?? tipPence"));
  const settlement = await Deno.readTextFile(join(SHARED, "applyCanonicalSettlementAfterCapture.ts"));
  assert(settlement.includes("Caller amount wins when present"));
  assert(!settlement.includes("Math.max(\n    Math.round(Number(captureAmountPence)"));
  const refresh = await Deno.readTextFile(join(SHARED, "../admin-refresh-payment-sessions/index.ts"));
  assert(!refresh.includes("s.captured_amount_pence ?? s.authorised_amount_pence"));
  assert(refresh.includes("extractConfirmedCaptureAmountPence"));
  assert(!refresh.includes("Math.round(order.amount)"));
  const recoveryCreate = await Deno.readTextFile(join(SHARED, "../create-payment-recovery/index.ts"));
  assert(recoveryCreate.includes("extractConfirmedCaptureAmountPence"));
  assert(!recoveryCreate.includes("parentPatch.captured_amount_pence = orderAmt"));
  const webhook = await Deno.readTextFile(join(SHARED, "../revolut-webhook/index.ts"));
  assert(webhook.includes("extractConfirmedCaptureAmountPence"));
  assert(webhook.includes("resolveConfirmedCaptureMinor"));
  assert(!webhook.includes("capturedAmt?.amount"));
  assert(!webhook.includes("captured_amount,\n          (event.data as { captured_amount?: unknown; amount?: unknown } | undefined)?.amount"));
  assert(exp.includes("clear_claim_failed"));
  assert(exp.includes("tip_window_status: TIP_WINDOW_STATUS.CLOSED"));
  assert(!exp.includes("recordedTipPenceAfterCapture"));
  assert(exp.includes("tipWindowCloseAllowedAfterFinalize"));
  assert(exp.includes("payment_shortfall"));
  assert(!exp.includes("tip_collected_pence ?? tipPence"));
  const tip = await Deno.readTextFile(join(SHARED, "../submit-customer-trip-tip/index.ts"));
  assert(tip.includes("tipWindowCloseAllowedAfterFinalize"));
  assert(exp.includes("assertCronOrServiceRoleAuth"));
  assert(exp.includes("closed_already_finalised") || exp.includes("would_close_already_finalised"));
  assert(exp.includes("visibleTipAfterExpiredWindowClose"));
  assert(exp.includes("would_clear_stale_tip"));
  assert(exp.includes("cleared_stale_tip"));
  assert(exp.includes('.eq("type", "DRIVER_TIP_CREDIT")'));
  assert(!exp.includes('from("driver_wallet_ledger").insert'));
  assert(!exp.includes("financial_reconciliation"));
  assert(exp.includes("Never POST a second capture"));
});

Deno.test("refund of a captured tip claws DRIVER_TIP_CREDIT; fare-only refund does not", () => {
  assertEquals(capturedTipReversalPence({
    cumulativeRefundedPence: 500,
    farePence: 1000,
    capturedPence: 1200,
    tipCreditPence: 200,
  }), 0);
  assertEquals(capturedTipReversalPence({
    cumulativeRefundedPence: 1200,
    farePence: 1000,
    capturedPence: 1500,
    tipCreditPence: 200,
  }), 200);
  assertEquals(capturedTipReversalPence({
    cumulativeRefundedPence: 1100,
    farePence: 1000,
    capturedPence: 1200,
    tipCreditPence: 200,
  }), 100);
  assertEquals(capturedTipReversalPence({
    cumulativeRefundedPence: 1200,
    farePence: 0,
    capturedPence: 1200,
    tipCreditPence: 0,
  }), 0);
});

Deno.test("unpaid claimed tip is not booked, and refund uses confirmed capture", async () => {
  const repair = await Deno.readTextFile(join(SHARED, "../repair-commissions/index.ts"));
  assert(repair.includes("invoiceTipPenceFromConfirmedCapture"));
  assert(!repair.includes(": requestedTip;"));
  const refundAdmin = await Deno.readTextFile(join(SHARED, "../admin-refund-trip-payment/index.ts"));
  assert(refundAdmin.includes("extractConfirmedCaptureAmountPence"));
  assert(!refundAdmin.includes("?? Number(orderBefore.amount"));
  const legacyRefund = await Deno.readTextFile(join(SHARED, "../revolut-refund-order/index.ts"));
  assert(legacyRefund.includes("applyProviderRefundToOnecab"));
  assert(legacyRefund.includes("extractConfirmedCaptureAmountPence"));
  assert(!legacyRefund.includes('payment_status: refundAmount === captured'));
  const stop = await Deno.readTextFile(join(SHARED, "../stop-workflow/index.ts"));
  assert(stop.includes("ledgerTipPence"));
  assert(stop.includes("invoiceTipPenceFromConfirmedCapture"));
  assert(stop.includes("TEN already posted"));
  const payState = await Deno.readTextFile(join(SHARED, "../admin-get-trip-payment-state/index.ts"));
  assert(payState.includes("extractConfirmedCaptureAmountPence"));
  assert(!payState.includes("trip.capture_amount_pence ?? order.amount"));
  const refundSql = await Deno.readTextFile(join(
    SHARED,
    "../../migrations/20261109580000_phase_tip_refund_reverses_captured_tip.sql",
  ));
  assert(refundSql.includes("v_target_tip_reversal"));
  assert(refundSql.includes("DRIVER_TIP_CREDIT"));
  assert(refundSql.includes("p_cumulative_refunded_pence - v_fare_basis_pence"));
});

Deno.test("ledger allows DRIVER_TIP_CREDIT when TEN already exists", async () => {
  const ledger = await Deno.readTextFile(join(SHARED, "onecabFinanceLedger.ts"));
  assert(ledger.includes("Do NOT return early"));
  assert(ledger.includes("DRIVER_TIP_CREDIT"));
  const settlement = await Deno.readTextFile(join(SHARED, "applyCanonicalSettlementAfterCapture.ts"));
  assert(settlement.includes("coveredTipPenceAfterCapture"));
  assert(settlement.includes("invoiceTipPenceFromConfirmedCapture"));
  // Early return that skipped tip must be gone.
  assert(!/readbackBefore\.count === 1\) \{[\s\S]{0,400}return \{ credited: true/.test(ledger));
});
