import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildFrAuditOverviewKpis,
  buildFrCustomerMoneyKpisFromPaymentSessions,
  captureVariancePence,
  classifyCaptureReconciliation,
  classifyRefundReconciliation,
  classifyReleaseReconciliation,
  classifyWalletReconciliation,
  onecabNetFromSessionFee,
} from "./frTripAuditComparisonSSOT.ts";

Deno.test("capture variance: actual − expected fare", () => {
  assertEquals(captureVariancePence({ captured_pence: 480, final_customer_fare_pence: 480 }), 0);
  assertEquals(captureVariancePence({ captured_pence: 400, final_customer_fare_pence: 480 }), -80);
  assertEquals(captureVariancePence({ captured_pence: null, final_customer_fare_pence: 480 }), null);
});

Deno.test("capture status: zero/null PS capture is mismatch not green", () => {
  assertEquals(
    classifyCaptureReconciliation({
      isCash: false,
      paymentEvidenceStatus: "PAYMENT_SESSIONS",
      captured_pence: null,
      final_customer_fare_pence: 480,
      authorised_pence: 780,
    }),
    "PAYMENT_SESSION_CAPTURE_MISMATCH",
  );
  assertEquals(
    classifyCaptureReconciliation({
      isCash: false,
      paymentEvidenceStatus: "PAYMENT_SESSIONS",
      captured_pence: null,
      final_customer_fare_pence: 480,
      authorised_pence: 780,
      tripCompleted: false,
    }),
    "CAPTURE_PENDING",
  );
  assertEquals(
    classifyCaptureReconciliation({
      isCash: false,
      paymentEvidenceStatus: "PAYMENT_SESSIONS",
      captured_pence: 0,
      final_customer_fare_pence: 480,
    }),
    "PAYMENT_SESSION_CAPTURE_MISMATCH",
  );
  assertEquals(
    classifyCaptureReconciliation({
      isCash: false,
      paymentEvidenceStatus: "PAYMENT_SESSIONS",
      captured_pence: 480,
      final_customer_fare_pence: 480,
    }),
    // Amount MATCHED/OVERCAPTURE is Payment Sessions classification only.
    "CAPTURE_AMOUNT_UNKNOWN",
  );
  assertEquals(
    classifyCaptureReconciliation({
      isCash: false,
      paymentEvidenceStatus: "PAYMENT_SESSIONS",
      captured_pence: 480,
      final_customer_fare_pence: 480,
      provider_verification_status: "STALE",
    }),
    "PROVIDER_VERIFICATION_PENDING",
  );
});

Deno.test("release/refund classifiers preserve unknown amounts", () => {
  assertEquals(
    classifyReleaseReconciliation({
      authorised_pence: 780,
      captured_pence: 480,
      released_pence: null,
    }),
    "RELEASE_PENDING",
  );
  assertEquals(
    classifyReleaseReconciliation({
      authorised_pence: null,
      captured_pence: 480,
      released_pence: 300,
    }),
    "RELEASE_AMOUNT_UNKNOWN",
  );
  assertEquals(
    classifyRefundReconciliation({ refunded_pence: 0 }),
    "REFUND_MATCHED",
  );
  assertEquals(
    classifyRefundReconciliation({ refunded_pence: 100 }),
    "REFUND_PENDING",
  );
});

Deno.test("wallet status: missing credit when expected net present", () => {
  assertEquals(
    classifyWalletReconciliation({
      walletEvidenceAvailable: true,
      expected_driver_net_pence: 408,
      actual_wallet_credit_pence: null,
    }),
    "WALLET_CREDIT_MISSING",
  );
});

Deno.test("onecab net uses PS fee only — pending fee stays null", () => {
  assertEquals(
    onecabNetFromSessionFee({
      gross_commission_pence: 72,
      provider_processing_fee_pence: 25,
      sessionsMapPresent: true,
    }),
    47,
  );
  assertEquals(
    onecabNetFromSessionFee({
      gross_commission_pence: 72,
      provider_processing_fee_pence: null,
      sessionsMapPresent: true,
    }),
    null,
  );
});

Deno.test("overview KPIs are backend aggregates from audit rows", () => {
  const k = buildFrAuditOverviewKpis([
    {
      final_fare_pence: 480,
      captured_pence: 480,
      refunded_pence: 0,
      processing_fee_pence: 25,
      onecab_gross_commission_pence: 72,
      onecab_net_pence: 47,
      driver_net_pence: 408,
      wallet_credit_pence: 408,
      capture_variance_pence: 0,
      capture_reconciliation_status: "MATCHED",
      wallet_reconciliation_status: "WALLET_MATCHED",
      payout_reconciliation_status: "PAYOUT_NOT_DUE",
      capture_mismatch: false,
      reconciliation_status: { label: "Balanced", tone: "green" },
    },
    {
      final_fare_pence: 480,
      captured_pence: null,
      capture_variance_pence: null,
      capture_reconciliation_status: "CAPTURE_AMOUNT_UNKNOWN",
      wallet_reconciliation_status: "WALLET_CREDIT_MISSING",
      capture_mismatch: true,
      reconciliation_status: { label: "Mismatch", tone: "red" },
      driver_net_pence: 408,
      wallet_credit_pence: null,
    },
  ]);
  assertEquals(k.confirmed_provider_captured_total_pence, 480);
  assertEquals(k.missing_wallet_credits_count, 1);
  assertEquals(k.unresolved_mismatches_count, 1);
  assertEquals(k.balanced_trips_count, 1);
});

Deno.test("overview KPIs: MK-260708-008 waiting is not OVERCAPTURE; fare = PS expected", () => {
  const k = buildFrAuditOverviewKpis([
    {
      // Ride fare alone would wrongly be 680 — PS expected includes waiting.
      final_customer_fare_pence: 680,
      final_fare_pence: 680,
      ps_expected_capture_pence: 698,
      captured_pence: 698,
      released_pence: 82,
      refunded_pence: 0,
      processing_fee_pence: 27,
      capture_variance_pence: 0,
      capture_classification: "CAPTURED_WITH_WAITING_TIME",
      capture_reconciliation_status: "MATCHED",
      release_reconciliation_status: "RELEASE_MATCHED",
      wallet_reconciliation_status: "WALLET_MATCHED",
      payout_reconciliation_status: "PAYOUT_NOT_DUE",
      capture_mismatch: false,
      onecab_gross_commission_pence: 102,
      onecab_net_pence: 75,
      driver_net_pence: 578,
      wallet_credit_pence: 578,
      reconciliation_status: { label: "Balanced", tone: "green" },
    },
  ]);
  assertEquals(k.completed_trip_fare_total_pence, 698);
  assertEquals(k.confirmed_provider_captured_total_pence, 698);
  assertEquals(k.released_total_pence, 82);
  assertEquals(k.provider_fee_total_pence, 27);
  assertEquals(k.overcapture_pence, 0);
  assertEquals(k.capture_shortfall_pence, 0);
  assertEquals(k.missing_captures_count, 0);
  assertEquals(k.balanced_trips_count, 1);
});

Deno.test("overview KPIs: only unexplained overcapture status contributes to overcapture total", () => {
  const k = buildFrAuditOverviewKpis([
    {
      ps_expected_capture_pence: 680,
      captured_pence: 698,
      capture_variance_pence: 18,
      capture_classification: "UNEXPLAINED_OVERCAPTURE",
      capture_reconciliation_status: "OVERCAPTURE",
      capture_mismatch: true,
      wallet_reconciliation_status: "WALLET_MATCHED",
      payout_reconciliation_status: "PAYOUT_NOT_DUE",
    },
  ]);
  assertEquals(k.overcapture_pence, 18);
  assertEquals(k.completed_trip_fare_total_pence, 680);
});

Deno.test("PS customer money KPIs: waiting trip is not OVERCAPTURE", () => {
  const k = buildFrCustomerMoneyKpisFromPaymentSessions([
    {
      captured_amount_pence: 698,
      authorised_amount_pence: 780,
      released_amount_pence: 82,
      refunded_amount_pence: 0,
      provider_processing_fee_pence: 27,
      fee_status: "ACTUAL",
      provider_state: "CAPTURED",
      metadata: {
        capture_breakdown: {
          ride_fare_pence: 680,
          pickup_waiting_charge_pence: 18,
          expected_capture_pence: 698,
          provider_captured_pence: 698,
          variance_pence: 0,
          variance_reason: "Pickup waiting time",
          capture_classification: "CAPTURED_WITH_WAITING_TIME",
        },
      },
    },
  ]);
  assertEquals(k.completed_trip_fare_total_pence, 698);
  assertEquals(k.confirmed_provider_captured_total_pence, 698);
  assertEquals(k.released_total_pence, 82);
  assertEquals(k.provider_fee_total_pence, 27);
  assertEquals(k.overcapture_pence, 0);
  assertEquals(k.capture_shortfall_pence, 0);
  assertEquals(k.missing_captures_count, 0);
  assertEquals(k.missing_releases_count, 0);
});

Deno.test("PS customer money KPIs: missing capture and release from session fields", () => {
  const k = buildFrCustomerMoneyKpisFromPaymentSessions([
    {
      captured_amount_pence: null,
      authorised_amount_pence: 780,
      released_amount_pence: null,
      provider_state: "AUTHORISED",
    },
    {
      captured_amount_pence: 480,
      authorised_amount_pence: 780,
      released_amount_pence: null,
      provider_state: "CAPTURED",
      metadata: {
        capture_breakdown: {
          expected_capture_pence: 480,
          provider_captured_pence: 480,
          variance_pence: 0,
          capture_classification: "CAPTURED_MATCHED",
        },
      },
    },
  ]);
  assertEquals(k.missing_captures_count, 1);
  assertEquals(k.missing_releases_count, 1);
  assertEquals(k.confirmed_provider_captured_total_pence, 480);
  assertEquals(k.completed_trip_fare_total_pence, 480);
});
