/**
 * Lifecycle matrix lock — customer receivable SSOT (pure planners).
 * Covers decline, UNKNOWN, idempotency, partial capture, ordering,
 * cancel rules, auth-not-settle, capture-POST-alone, COMPLETED settles,
 * no duplicate TEN, FR classification, backfill 30+6=36.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ALLOCATION_STATUS,
  CUSTOMER_RECEIVABLE_STATUS,
  PREAUTH_RECEIVABLE_ORDERING,
  RECEIVABLE_PERSISTENCE_UNAVAILABLE,
  TEN_REPAIR_FORBIDDEN,
  buildDeclinedWaitingReceivableIdempotencyKey,
  computeDeclinedIncrementReceivablePence,
  makeReceivablePersistenceUnavailable,
  planCreateReceivableFromDeclinedIncrement,
  planFoldReceivablesIntoPreauth,
  planPartialCaptureAllocation,
  planReleaseOnCancel,
  planReserveBeforeProviderCall,
  planSettleFromProviderEvidence,
  sumFixtureOutstandingPence,
} from "../supabase/functions/_shared/customerReceivableSSOT.ts";
import {
  buildFrCustomerOutstandingOverview,
  FR_CUSTOMER_OUTSTANDING_CLASS,
  mk012Mk017BackfillPreviewPence,
} from "../supabase/functions/_shared/frCustomerOutstandingSSOT.ts";

const MK012 = {
  trip_id: "2799bb97-cabf-47e1-a570-fe225e6b06b1",
  trip_code: "MK-260923-012",
  customer_id: "6818f4c3-2645-4bef-897a-30d0abe199bd",
  final_fare_pence: 579,
  captured_pence: 549,
  shortfall_pence: 30,
};

const MK017 = {
  trip_id: "mk017-fixture",
  trip_code: "MK-260923-017",
  customer_id: "6818f4c3-2645-4bef-897a-30d0abe199bd",
  final_fare_pence: 506,
  captured_pence: 500,
  shortfall_pence: 6,
};

Deno.test("1. definitive decline creates once (30p)", () => {
  const plan = planCreateReceivableFromDeclinedIncrement({
    customer_id: MK012.customer_id,
    source_trip_id: MK012.trip_id,
    final_fare_pence: MK012.final_fare_pence,
    captured_pence: MK012.captured_pence,
    shortfall_pence: MK012.shortfall_pence,
    pickup_waiting_charge_pence: 30,
  });
  assertEquals(plan.should_create, true);
  assertEquals(plan.original_amount_pence, 30);
  assertEquals(
    plan.idempotency_key,
    buildDeclinedWaitingReceivableIdempotencyKey(MK012.trip_id),
  );
});

Deno.test("2. UNKNOWN creates none", () => {
  const plan = planCreateReceivableFromDeclinedIncrement({
    customer_id: MK012.customer_id,
    source_trip_id: MK012.trip_id,
    shortfall_pence: 30,
    provider_state: "UNKNOWN",
  });
  assertEquals(plan.should_create, false);
  assertEquals(plan.reject_reason, "provider_state_unknown");
});

Deno.test("3. duplicate decline idempotent key stable", () => {
  const a = planCreateReceivableFromDeclinedIncrement({
    customer_id: MK012.customer_id,
    source_trip_id: MK012.trip_id,
    shortfall_pence: 30,
  });
  const b = planCreateReceivableFromDeclinedIncrement({
    customer_id: MK012.customer_id,
    source_trip_id: MK012.trip_id,
    shortfall_pence: 30,
  });
  assertEquals(a.idempotency_key, b.idempotency_key);
});

Deno.test("4. allocation persisted before provider (ordering)", () => {
  const plan = planReserveBeforeProviderCall({
    has_pending_payment_session: true,
    open_receivable_count: 2,
  });
  assertEquals(plan.ok, true);
  assertEquals(plan.must_persist_reservation_before_provider, true);
  assertEquals(PREAUTH_RECEIVABLE_ORDERING.indexOf("CALL_REVOLUT_PREAUTH"), 6);
  assertEquals(
    PREAUTH_RECEIVABLE_ORDERING.indexOf("COMMIT_DURABLE_RESERVATION")
      < PREAUTH_RECEIVABLE_ORDERING.indexOf("CALL_REVOLUT_PREAUTH"),
    true,
  );
});

Deno.test("5. failed preauth / no order → release", () => {
  const d = planReleaseOnCancel({
    provider_order_id: null,
    provider_state: null,
    has_capture: false,
  });
  assertEquals(d.action, "RELEASE");
});

Deno.test("6. UNKNOWN retains reservation", () => {
  const d = planReleaseOnCancel({
    provider_order_id: "ord_1",
    provider_state: "UNKNOWN",
    has_capture: false,
  });
  assertEquals(d.action, "KEEP_RESERVED");
  assertEquals(d.reason, "provider_unknown_reconcile_only");
});

Deno.test("7. definitive cancelled → release", () => {
  const d = planReleaseOnCancel({
    provider_order_id: "ord_1",
    provider_state: "CANCELLED",
    has_capture: false,
  });
  assertEquals(d.action, "RELEASE");
});

Deno.test("8. authorisation does not settle", () => {
  const gate = planSettleFromProviderEvidence({
    payment_session_id: "ps1",
    evidence: {
      orderId: "ord_1",
      terminalState: "AUTHORISED",
      confirmedCapturedPence: 900,
      amountFromProviderGet: true,
    },
  });
  assertEquals(gate.ok, false);
  assertEquals(gate.reject_reason, "authorisation_does_not_settle");
});

Deno.test("9. capture POST alone does not settle", () => {
  const gate = planSettleFromProviderEvidence({
    payment_session_id: "ps1",
    evidence: {
      orderId: "ord_1",
      terminalState: "COMPLETED",
      confirmedCapturedPence: 900,
      amountFromProviderGet: false,
    },
  });
  assertEquals(gate.ok, false);
  assertEquals(gate.reject_reason, "capture_post_alone_does_not_settle");
});

Deno.test("10. COMPLETED + GET settles", () => {
  const gate = planSettleFromProviderEvidence({
    payment_session_id: "ps1",
    evidence: {
      orderId: "ord_1",
      terminalState: "COMPLETED",
      confirmedCapturedPence: 936,
      amountFromProviderGet: true,
    },
  });
  assertEquals(gate.ok, true);
  assertEquals(gate.confirmed_captured_pence, 936);
});

Deno.test("11. mark without evidence skipped (local call alone)", () => {
  const gate = planSettleFromProviderEvidence({
    payment_session_id: "ps1",
    evidence: null,
  });
  assertEquals(gate.ok, false);
  assertEquals(gate.reject_reason, "provider_evidence_required");
});

Deno.test("12. partial capture historical first (36 reserved, 20 capture)", () => {
  const plan = planPartialCaptureAllocation({
    reserved_receivables: [
      {
        receivable_id: "r012",
        allocated_amount_pence: 30,
        created_at: "2026-09-23T10:00:00Z",
      },
      {
        receivable_id: "r017",
        allocated_amount_pence: 6,
        created_at: "2026-09-23T11:00:00Z",
      },
    ],
    captured_pence: 20,
    current_trip_fare_pence: 800,
  });
  assertEquals(plan.debt_settled_pence, 20);
  assertEquals(plan.debt_remaining_pence, 16);
  assertEquals(plan.current_trip_fare_allocation_pence, 0);
  assertEquals(plan.receivable_lines[0].settle_pence, 20);
  assertEquals(plan.receivable_lines[0].next_status, "OPEN");
  assertEquals(plan.receivable_lines[0].remaining_outstanding_pence, 10);
  assertEquals(plan.receivable_lines[1].settle_pence, 0);
  assertEquals(plan.receivable_lines[1].remaining_outstanding_pence, 6);
});

Deno.test("13. fold 30+6=36 into next preauth", () => {
  assertEquals(
    sumFixtureOutstandingPence({
      mk012_outstanding_pence: 30,
      mk017_outstanding_pence: 6,
    }),
    36,
  );
  const fold = planFoldReceivablesIntoPreauth({
    ride_fare_pence: 800,
    buffer_pence: 100,
    open_receivables: [
      {
        id: "r012",
        customer_id: MK012.customer_id,
        outstanding_amount_pence: 30,
        status: CUSTOMER_RECEIVABLE_STATUS.OPEN,
        currency: "gbp",
        source_trip_id: MK012.trip_id,
        idempotency_key: "k012",
        created_at: "2026-09-23T10:00:00Z",
      },
      {
        id: "r017",
        customer_id: MK012.customer_id,
        outstanding_amount_pence: 6,
        status: CUSTOMER_RECEIVABLE_STATUS.OPEN,
        currency: "gbp",
        source_trip_id: MK017.trip_id,
        idempotency_key: "k017",
        created_at: "2026-09-23T11:00:00Z",
      },
    ],
  });
  assertEquals(fold.receivables_total_pence, 36);
  assertEquals(fold.authorised_amount_pence, 936);
});

Deno.test("14. no duplicate TEN — repair forbidden on create plan", () => {
  const plan = planCreateReceivableFromDeclinedIncrement({
    customer_id: MK012.customer_id,
    source_trip_id: MK012.trip_id,
    shortfall_pence: 30,
  });
  assertEquals(TEN_REPAIR_FORBIDDEN, true);
  assertEquals(plan.metadata.ten_repair_forbidden, true);
  assertEquals(plan.metadata.no_second_ten, true);
  assertEquals(plan.metadata.no_second_commission, true);
  assertEquals(plan.metadata.no_payout_from_recovery, true);
});

Deno.test("15. FR classification CUSTOMER_OUTSTANDING overview 36p / 2 trips", () => {
  const overview = buildFrCustomerOutstandingOverview({
    trips: [
      {
        trip_code: MK012.trip_code,
        trip_id: MK012.trip_id,
        final_fare_pence: MK012.final_fare_pence,
        capture_amount_pence: MK012.captured_pence,
        receivable_outstanding_pence: 30,
      },
      {
        trip_code: MK017.trip_code,
        trip_id: MK017.trip_id,
        final_fare_pence: MK017.final_fare_pence,
        capture_amount_pence: MK017.captured_pence,
        receivable_outstanding_pence: 6,
      },
    ],
  });
  assertEquals(overview.customer_outstanding_pence, 36);
  assertEquals(overview.affected_trips, 2);
  assertEquals(overview.separate_from_wallet_payout_variance, true);
  assertEquals(
    overview.trips[0].fr_class,
    FR_CUSTOMER_OUTSTANDING_CLASS.CUSTOMER_OUTSTANDING,
  );
});

Deno.test("16. backfill plan amounts 30+6=36", () => {
  const preview = mk012Mk017BackfillPreviewPence();
  assertEquals(preview.mk012_pence, 30);
  assertEquals(preview.mk017_pence, 6);
  assertEquals(preview.total_pence, 36);
  assertEquals(computeDeclinedIncrementReceivablePence({
    final_fare_pence: MK017.final_fare_pence,
    captured_pence: MK017.captured_pence,
  }), 6);
});

Deno.test("17. RECEIVABLE_PERSISTENCE_UNAVAILABLE never soft-success", () => {
  const err = makeReceivablePersistenceUnavailable("relation missing");
  assertEquals(err.code, RECEIVABLE_PERSISTENCE_UNAVAILABLE);
  assertEquals(err.manual_review, true);
  assertEquals(err.decline_evidence_retained, true);
});

Deno.test("18. PROCESSING / UNKNOWN settle rejected", () => {
  assertEquals(
    planSettleFromProviderEvidence({
      payment_session_id: "ps1",
      evidence: {
        orderId: "o",
        terminalState: "PROCESSING",
        confirmedCapturedPence: 100,
        amountFromProviderGet: true,
      },
    }).ok,
    false,
  );
  assertEquals(
    planSettleFromProviderEvidence({
      payment_session_id: "ps1",
      evidence: {
        orderId: "o",
        terminalState: "UNKNOWN",
        confirmedCapturedPence: 100,
        amountFromProviderGet: true,
      },
    }).reject_reason,
    "provider_state_unknown",
  );
});

Deno.test("19. captured/completed cancel → SETTLE not release", () => {
  const d = planReleaseOnCancel({
    provider_order_id: "ord_1",
    provider_state: "COMPLETED",
    has_capture: true,
  });
  assertEquals(d.action, "SETTLE");
});

Deno.test("20. zero shortfall → no receivable", () => {
  const plan = planCreateReceivableFromDeclinedIncrement({
    customer_id: MK012.customer_id,
    source_trip_id: MK012.trip_id,
    final_fare_pence: 549,
    captured_pence: 549,
  });
  assertEquals(plan.should_create, false);
});

Deno.test("21. allocation status PARTIAL exists in SSOT", () => {
  assertEquals(ALLOCATION_STATUS.PARTIAL, "PARTIAL");
  assertEquals(CUSTOMER_RECEIVABLE_STATUS.MANUAL_REVIEW, "MANUAL_REVIEW");
});
