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
  isCustomerReceivablePreauthEligible,
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

Deno.test("22. currency isolation — EUR debt not folded into GBP preauth", () => {
  const fold = planFoldReceivablesIntoPreauth({
    ride_fare_pence: 800,
    buffer_pence: 100,
    currency: "gbp",
    open_receivables: [
      {
        id: "gbp-30",
        customer_id: MK012.customer_id,
        outstanding_amount_pence: 30,
        status: CUSTOMER_RECEIVABLE_STATUS.OPEN,
        currency: "gbp",
        source_trip_id: MK012.trip_id,
        idempotency_key: "k-gbp",
      },
      {
        id: "eur-50",
        customer_id: MK012.customer_id,
        outstanding_amount_pence: 50,
        status: CUSTOMER_RECEIVABLE_STATUS.OPEN,
        currency: "eur",
        source_trip_id: "eur-trip",
        idempotency_key: "k-eur",
      },
    ],
  });
  assertEquals(fold.receivables_total_pence, 30);
  assertEquals(fold.receivable_ids, ["gbp-30"]);
});

Deno.test("23. migration denies direct mutation + events append-only", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "../supabase/migrations/20261127150000_customer_receivables_ssot.sql",
      import.meta.url,
    ),
  );
  assertEquals(sql.includes("deny_direct_customer_receivable_mutation"), true);
  assertEquals(sql.includes("customer_receivable_events_append_only"), true);
  assertEquals(sql.includes("trg_deny_customer_receivable_update"), true);
  assertEquals(sql.includes("trg_deny_customer_receivable_event_delete"), true);
  assertEquals(sql.includes("onecab.allow_customer_receivable_write"), true);
  assertEquals(sql.includes("SET search_path TO public"), true);
});

Deno.test("24. migration rollback file present", async () => {
  const rollback = await Deno.readTextFile(
    new URL(
      "../supabase/migrations/rollback/rollback_20261127150000_customer_receivables_ssot.sql",
      import.meta.url,
    ),
  );
  assertEquals(rollback.includes("DROP TABLE IF EXISTS public.customer_receivables"), true);
  assertEquals(
    rollback.includes("DROP FUNCTION IF EXISTS public.customer_receivable_reserve_for_preauth"),
    true,
  );
});

Deno.test("25. FR overview must not mix into wallet/payout variance flags", () => {
  const overview = buildFrCustomerOutstandingOverview({
    trips: [
      {
        trip_code: MK012.trip_code,
        final_fare_pence: 579,
        capture_amount_pence: 549,
        receivable_outstanding_pence: 30,
      },
    ],
  });
  assertEquals(overview.separate_from_wallet_payout_variance, true);
  assertEquals(overview.ten_repair_forbidden, true);
});

Deno.test("26. abandon before provider call releases", () => {
  const d = planReleaseOnCancel({
    provider_order_id: null,
    provider_state: null,
    has_capture: false,
  });
  assertEquals(d.action, "RELEASE");
  assertEquals(d.reason, "no_provider_order");
});

Deno.test("27. abandon after definitive provider failure releases", () => {
  const d = planReleaseOnCancel({
    provider_order_id: "ord_fail",
    provider_state: "FAILED",
    has_capture: false,
  });
  assertEquals(d.action, "RELEASE");
});

Deno.test("28. abandon with AUTHORISED does not settle; needs safe hold release", () => {
  const keep = planReleaseOnCancel({
    provider_order_id: "ord_auth",
    provider_state: "AUTHORISED",
    has_capture: false,
    hold_safely_released: false,
  });
  assertEquals(keep.action, "KEEP_RESERVED");
  assertEquals(keep.reason, "authorised_awaiting_safe_hold_release");
  const settleGate = planSettleFromProviderEvidence({
    payment_session_id: "ps",
    evidence: {
      orderId: "ord_auth",
      terminalState: "AUTHORISED",
      confirmedCapturedPence: 100,
      amountFromProviderGet: true,
    },
  });
  assertEquals(settleGate.ok, false);
});

Deno.test("29. abandon AUTHORISED + hold safely released → RELEASE", () => {
  const d = planReleaseOnCancel({
    provider_order_id: "ord_auth",
    provider_state: "AUTHORISED",
    has_capture: false,
    hold_safely_released: true,
  });
  assertEquals(d.action, "RELEASE");
  assertEquals(d.reason, "authorised_hold_safely_released");
});

Deno.test("30. abandon with UNKNOWN retains reservation", () => {
  const d = planReleaseOnCancel({
    provider_order_id: "ord_unk",
    provider_state: "UNKNOWN",
    has_capture: false,
  });
  assertEquals(d.action, "KEEP_RESERVED");
});

Deno.test("31. abandon after COMPLETED → SETTLE (not release)", () => {
  const d = planReleaseOnCancel({
    provider_order_id: "ord_done",
    provider_state: "COMPLETED",
    has_capture: true,
  });
  assertEquals(d.action, "SETTLE");
});

Deno.test("32. cancel/abandon race — repeated RELEASE decision is stable (idempotent planner)", () => {
  const a = planReleaseOnCancel({
    provider_order_id: null,
    provider_state: null,
    has_capture: false,
  });
  const b = planReleaseOnCancel({
    provider_order_id: null,
    provider_state: null,
    has_capture: false,
  });
  assertEquals(a.action, b.action);
  assertEquals(a.action, "RELEASE");
});

Deno.test("33. abandoned reservation available later only after safe release", () => {
  // While KEEP_RESERVED, fold must not include RESERVED rows (OPEN only).
  const foldWhileReserved = planFoldReceivablesIntoPreauth({
    ride_fare_pence: 800,
    buffer_pence: 0,
    open_receivables: [
      {
        id: "r1",
        customer_id: MK012.customer_id,
        outstanding_amount_pence: 30,
        status: "RESERVED",
        currency: "gbp",
        source_trip_id: MK012.trip_id,
        idempotency_key: "k1",
      },
    ],
  });
  assertEquals(foldWhileReserved.receivables_total_pence, 0);
  const foldAfterRelease = planFoldReceivablesIntoPreauth({
    ride_fare_pence: 800,
    buffer_pence: 0,
    open_receivables: [
      {
        id: "r1",
        customer_id: MK012.customer_id,
        outstanding_amount_pence: 30,
        status: "OPEN",
        currency: "gbp",
        source_trip_id: MK012.trip_id,
        idempotency_key: "k1",
      },
    ],
  });
  assertEquals(foldAfterRelease.receivables_total_pence, 30);
});

Deno.test("34. corporate / guest never eligible to fold personal receivables", () => {
  assertEquals(
    isCustomerReceivablePreauthEligible({
      customer_id: MK012.customer_id,
      booking_source: "corporate_portal",
      corporate_account_id: "corp-1",
    }).eligible,
    false,
  );
  assertEquals(
    isCustomerReceivablePreauthEligible({
      customer_id: MK012.customer_id,
      is_guest: true,
    }).eligible,
    false,
  );
  assertEquals(
    isCustomerReceivablePreauthEligible({
      customer_id: MK012.customer_id,
      booking_source: "choose_ride",
      financial_model: "PLATFORM_COLLECTED",
    }).eligible,
    true,
  );
});

Deno.test("35. abandon-payment-session source wires reconcileReceivablesOnAbandonOrCancel", async () => {
  const src = await Deno.readTextFile(
    new URL(
      "../supabase/functions/abandon-payment-session/index.ts",
      import.meta.url,
    ),
  );
  assertEquals(src.includes("reconcileReceivablesOnAbandonOrCancel"), true);
  assertEquals(src.includes("hold_safely_released"), true);
});
