/**
 * Capture composition SSOT locks — MK-260925-002.
 * If these fail, fix the code — never delete or soften the lock.
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildCaptureIdempotencyKey,
  captureCompositionPersistPatch,
  mk260925002IncidentCaptureComposition,
  planCaptureComposition,
  planReceivableSettlementFromCaptureComposition,
} from "../../functions/_shared/captureCompositionSSOT.ts";

const SESSION = "71a39184-4efd-462c-8465-6b1f2e03d251";
const ORDER = "6ab61c09-a366-ab77-84a2-498142cf3420";

const reserved36 = [
  {
    id: "a30",
    payment_session_id: SESSION,
    status: "RESERVED",
    allocated_amount_pence: 30,
  },
  {
    id: "a6",
    payment_session_id: SESSION,
    status: "RESERVED",
    allocated_amount_pence: 6,
  },
];

Deno.test("1. fare 500 + receivable 36 + no tip → target 536", () => {
  const p = planCaptureComposition({
    trip_fare_component_pence: 500,
    tip_component_pence: 0,
    payment_session_id: SESSION,
    provider_order_id: ORDER,
    authorised_total_pence: 536,
    allocations: reserved36,
  });
  assertEquals(p.ok, true);
  if (!p.ok) return;
  assertEquals(p.provider_capture_target_pence, 536);
  assertEquals(p.receivable_component_pence, 36);
  assertEquals(p.trip_fare_component_pence, 500);
  assertEquals(p.tip_component_pence, 0);
});

Deno.test("2. Skip and Submit tip=0 use the same 536 target", () => {
  const skip = planCaptureComposition({
    trip_fare_component_pence: 500,
    tip_component_pence: 0,
    payment_session_id: SESSION,
    provider_order_id: ORDER,
    authorised_total_pence: 536,
    allocations: reserved36,
  });
  const submit0 = planCaptureComposition({
    trip_fare_component_pence: 500,
    tip_component_pence: 0,
    payment_session_id: SESSION,
    provider_order_id: ORDER,
    authorised_total_pence: 536,
    allocations: reserved36,
  });
  assertEquals(skip.ok && submit0.ok, true);
  if (!skip.ok || !submit0.ok) return;
  assertEquals(skip.provider_capture_target_pence, submit0.provider_capture_target_pence);
  assertEquals(skip.capture_idempotency_key, submit0.capture_idempotency_key);
});

Deno.test("3. fare 500 + receivable 36 + successful tip 100 → target 636", () => {
  const p = planCaptureComposition({
    trip_fare_component_pence: 500,
    tip_component_pence: 100,
    payment_session_id: SESSION,
    provider_order_id: ORDER,
    authorised_total_pence: 636,
    allocations: reserved36,
  });
  assertEquals(p.ok, true);
  if (!p.ok) return;
  assertEquals(p.provider_capture_target_pence, 636);
});

Deno.test("4. declined tip → no fare capture (orchestration + completion)", async () => {
  const p = planCaptureComposition({
    trip_fare_component_pence: 500,
    tip_component_pence: 100,
    tip_authorisation_declined: true,
    payment_session_id: SESSION,
    provider_order_id: ORDER,
    authorised_total_pence: 536,
    allocations: reserved36,
  });
  assertEquals(p.ok, true);
  if (!p.ok) return;
  assertEquals(p.tip_component_pence, 0);
  assertEquals(p.provider_capture_target_pence, 536);
  const orch = await Deno.readTextFile(
    new URL("../../functions/_shared/tipWindowCaptureOrchestrationSSOT.ts", import.meta.url),
  );
  assertStringIncludes(orch, "tip_authorisation_declined");
  const completion = await Deno.readTextFile(
    new URL("../../functions/_shared/revolutCompletionCapture.ts", import.meta.url),
  );
  assertStringIncludes(completion, "tip_authorisation_declined_no_fare_capture");
  assertStringIncludes(completion, "TIP_AUTHORISATION_DECLINED");
});

Deno.test("5. expiry → target 536 exactly once (stable idempotency key)", () => {
  const a = planCaptureComposition({
    trip_fare_component_pence: 500,
    tip_component_pence: 0,
    payment_session_id: SESSION,
    provider_order_id: ORDER,
    authorised_total_pence: 536,
    allocations: reserved36,
  });
  const b = planCaptureComposition({
    trip_fare_component_pence: 500,
    tip_component_pence: 0,
    payment_session_id: SESSION,
    provider_order_id: ORDER,
    authorised_total_pence: 536,
    allocations: reserved36,
  });
  assertEquals(a.ok && b.ok, true);
  if (!a.ok || !b.ok) return;
  assertEquals(a.capture_idempotency_key, b.capture_idempotency_key);
  assertEquals(
    a.capture_idempotency_key,
    buildCaptureIdempotencyKey({
      payment_session_id: SESSION,
      provider_order_id: ORDER,
      provider_capture_target_pence: 536,
    }),
  );
});

Deno.test("6. persisted capture composition before POST", () => {
  const p = planCaptureComposition({
    trip_fare_component_pence: 500,
    tip_component_pence: 0,
    payment_session_id: SESSION,
    provider_order_id: ORDER,
    authorised_total_pence: 536,
    allocations: reserved36,
  });
  assertEquals(p.ok, true);
  if (!p.ok) return;
  const patch = captureCompositionPersistPatch(p);
  assertEquals(patch.provider_capture_target_pence, 536);
  assertEquals(patch.receivable_component_pence, 36);
  assertEquals(patch.trip_fare_component_pence, 500);
  assertEquals(typeof patch.capture_idempotency_key, "string");
});

Deno.test("7. GET COMPLETED 536 → settle 36 once", () => {
  const s = planReceivableSettlementFromCaptureComposition({
    persisted_receivable_component_pence: 36,
    provider_confirmed_captured_pence: 536,
    reserved_allocation_total_pence: 36,
    trip_fare_component_pence: 500,
    amount_from_provider_get: true,
  });
  assertEquals(s.settle_pence, 36);
  assertEquals(s.release_remainder, false);
});

Deno.test("8. POST target 500 with receivable component 0 → settle 0 and release 36", () => {
  // Incident: wrong path posted 500; plan should have been 536. Settlement from
  // persisted component 0 must not settle; must release reserved.
  const s = planReceivableSettlementFromCaptureComposition({
    persisted_receivable_component_pence: 0,
    provider_confirmed_captured_pence: 500,
    reserved_allocation_total_pence: 36,
    trip_fare_component_pence: 500,
    amount_from_provider_get: true,
  });
  assertEquals(s.settle_pence, 0);
  assertEquals(s.release_remainder, true);
  assertEquals(s.reason, "no_planned_receivable_component");
});

Deno.test("9. UNKNOWN → retain RESERVED (settlement planner does not invent)", () => {
  // Capture owners must not POST on UNKNOWN; settlement alone never clears RESERVED
  // without a planned component + confirmed capture GET.
  const s = planReceivableSettlementFromCaptureComposition({
    persisted_receivable_component_pence: 36,
    provider_confirmed_captured_pence: 0,
    reserved_allocation_total_pence: 36,
    trip_fare_component_pence: 500,
    amount_from_provider_get: false,
  });
  assertEquals(s.settle_pence, 0);
  assertEquals(s.release_remainder, false);
  assertEquals(s.reason, "retain_reserved_unknown_or_unconfirmed_capture");
});

Deno.test("10. partial capture follows persisted component ordering (cap settle)", () => {
  // Fare-first: captured 520 − fare 500 = 20 covered receivable.
  const s = planReceivableSettlementFromCaptureComposition({
    persisted_receivable_component_pence: 36,
    provider_confirmed_captured_pence: 520,
    reserved_allocation_total_pence: 36,
    trip_fare_component_pence: 500,
    amount_from_provider_get: true,
  });
  assertEquals(s.settle_pence, 20);
  assertEquals(s.release_remainder, true);
});

Deno.test("11. duplicate reconciliation produces no duplicate settlement intent", () => {
  const a = planReceivableSettlementFromCaptureComposition({
    persisted_receivable_component_pence: 36,
    provider_confirmed_captured_pence: 536,
    reserved_allocation_total_pence: 36,
    trip_fare_component_pence: 500,
    amount_from_provider_get: true,
  });
  const b = planReceivableSettlementFromCaptureComposition({
    persisted_receivable_component_pence: 36,
    provider_confirmed_captured_pence: 536,
    reserved_allocation_total_pence: 0, // already settled
    trip_fare_component_pence: 500,
    amount_from_provider_get: true,
  });
  assertEquals(a.settle_pence, 36);
  assertEquals(b.settle_pence, 0);
});

Deno.test("12. receivable creates no TEN/commission in planner (fare-only components)", () => {
  const p = mk260925002IncidentCaptureComposition();
  assertEquals(p.ok, true);
  if (!p.ok) return;
  // Driver TEN/commission use trip fare only — receivable is a separate component.
  assertEquals(p.trip_fare_component_pence, 500);
  assertEquals(p.receivable_component_pence, 36);
  assertEquals(p.provider_capture_target_pence, 536);
});

Deno.test("13. all capture owners import the canonical planner (source lock)", async () => {
  const owners = [
    "revolutCompletionCapture.ts",
    "capture-expired-tip-windows/index.ts",
    "paymentSessionSSOT.ts",
    "tipWindowCaptureOrchestrationSSOT.ts",
    "adminCaptureTripPaymentSSOT.ts",
    "admin-capture-trip-payment/index.ts",
    "sweep-revolut-stale-holds/index.ts",
  ];
  for (const rel of owners) {
    const path = rel.includes("/")
      ? new URL(`../../functions/${rel}`, import.meta.url)
      : new URL(`../../functions/_shared/${rel}`, import.meta.url);
    const src = await Deno.readTextFile(path);
    assertStringIncludes(src, "captureCompositionSSOT");
    assertStringIncludes(src, "planCaptureComposition");
  }
});

Deno.test("14. target exceeding authorised fails closed", () => {
  const p = planCaptureComposition({
    trip_fare_component_pence: 500,
    tip_component_pence: 0,
    payment_session_id: SESSION,
    provider_order_id: ORDER,
    authorised_total_pence: 500,
    allocations: reserved36,
  });
  assertEquals(p.ok, false);
  if (p.ok) return;
  assertEquals(p.reject_reason, "capture_target_exceeds_authorised");
});

Deno.test("15. MK-260925-002 incident planner yields 536 not payable-alone 500", () => {
  const p = mk260925002IncidentCaptureComposition();
  assertEquals(p.ok, true);
  if (!p.ok) return;
  assertEquals(p.provider_capture_target_pence, 536);
  assertEquals(p.receivable_component_pence, 36);
});
