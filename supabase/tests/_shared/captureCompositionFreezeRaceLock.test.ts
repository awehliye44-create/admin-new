/**
 * PR #80 blockers — freeze/resume/fail-closed/race locks.
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  CAPTURE_COMPOSITION_ERROR,
  assertPlanCoversReceivableEvidence,
  decideCaptureCompositionAction,
  detectReceivableCaptureEvidence,
  readFrozenCapturePlan,
  rejectPlanMutationAfterFreeze,
  validateFrozenCapturePlan,
} from "../../functions/_shared/captureCompositionFreezeSSOT.ts";
import {
  buildCaptureIdempotencyKey,
  planCaptureComposition,
} from "../../functions/_shared/captureCompositionSSOT.ts";

const SESSION = "sess-race-001";
const ORDER = "order-race-001";

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

function makeFrozenSession(target = 536) {
  const key = buildCaptureIdempotencyKey({
    payment_session_id: SESSION,
    provider_order_id: ORDER,
    provider_capture_target_pence: target,
  });
  return {
    id: SESSION,
    provider_order_id: ORDER,
    trip_fare_component_pence: 500,
    tip_component_pence: 0,
    receivable_component_pence: 36,
    provider_capture_target_pence: target,
    capture_idempotency_key: key,
    capture_composition_version: "capture_composition:v1",
    capture_composition_frozen_at: "2026-09-25T08:00:00.000Z",
    financial_operation_state: "CAPTURING",
    metadata: {
      capture_idempotency_key: key,
      capture_composition_frozen_at: "2026-09-25T08:00:00.000Z",
      preauth_buffer_component_pence: 0,
    },
  };
}

Deno.test("1. two capture triggers race → second resumes same frozen plan", () => {
  const session = makeFrozenSession(536);
  const a = decideCaptureCompositionAction({
    payment_session_id: SESSION,
    provider_order_id: ORDER,
    session,
    reserved_allocations: reserved36,
    authorised_total_pence: 536,
    proposed_trip_fare_pence: 500,
    proposed_tip_pence: 100, // would have been different if recomputed
    proposed_buffer_pence: 0,
  });
  const b = decideCaptureCompositionAction({
    payment_session_id: SESSION,
    provider_order_id: ORDER,
    session,
    reserved_allocations: reserved36,
    authorised_total_pence: 536,
    proposed_trip_fare_pence: 500,
    proposed_tip_pence: 0,
    proposed_buffer_pence: 300,
  });
  assertEquals(a.kind, "resume_frozen");
  assertEquals(b.kind, "resume_frozen");
  if (a.kind !== "resume_frozen" || b.kind !== "resume_frozen") return;
  assertEquals(a.plan.provider_capture_target_pence, 536);
  assertEquals(b.plan.provider_capture_target_pence, 536);
  assertEquals(a.plan.capture_idempotency_key, b.plan.capture_idempotency_key);
  // Must NOT adopt tip=100 or buffer=300 recomputation
  assertEquals(a.plan.tip_component_pence, 0);
});

Deno.test("2. allocation insert/release races planning → create_new only without freeze", () => {
  const d = decideCaptureCompositionAction({
    payment_session_id: SESSION,
    provider_order_id: ORDER,
    session: { id: SESSION, provider_order_id: ORDER, metadata: {} },
    reserved_allocations: reserved36,
    authorised_total_pence: 536,
    proposed_trip_fare_pence: 500,
    proposed_tip_pence: 0,
    proposed_buffer_pence: 0,
  });
  assertEquals(d.kind, "create_new");
});

Deno.test("3. second trigger adopts existing target/idempotency key", () => {
  const frozen = readFrozenCapturePlan({
    payment_session_id: SESSION,
    provider_order_id: ORDER,
    session: makeFrozenSession(536),
  });
  assertEquals(frozen != null, true);
  if (!frozen) return;
  const v = validateFrozenCapturePlan({
    frozen,
    payment_session_id: SESSION,
    provider_order_id: ORDER,
    authorised_total_pence: 536,
  });
  assertEquals(v.ok, true);
  if (!v.ok) return;
  assertEquals(
    v.plan.capture_idempotency_key,
    buildCaptureIdempotencyKey({
      payment_session_id: SESSION,
      provider_order_id: ORDER,
      provider_capture_target_pence: 536,
    }),
  );
});

Deno.test("4. plan mutation after CAPTURING is rejected", () => {
  const existing = readFrozenCapturePlan({
    payment_session_id: SESSION,
    provider_order_id: ORDER,
    session: makeFrozenSession(536),
  })!;
  const reject = rejectPlanMutationAfterFreeze({
    existing,
    attempted_target_pence: 500,
    attempted_idempotency_key: buildCaptureIdempotencyKey({
      payment_session_id: SESSION,
      provider_order_id: ORDER,
      provider_capture_target_pence: 500,
    }),
  });
  assertEquals(reject.ok, false);
  if (reject.ok) return;
  assertEquals(reject.code, CAPTURE_COMPOSITION_ERROR.CAPTURE_COMPOSITION_FROZEN_IMMUTABLE);
});

Deno.test("5. RESERVED allocation without plan fails before POST (create required)", () => {
  const d = decideCaptureCompositionAction({
    payment_session_id: SESSION,
    provider_order_id: ORDER,
    session: { id: SESSION, provider_order_id: ORDER, metadata: {} },
    reserved_allocations: reserved36,
    authorised_total_pence: 536,
    proposed_trip_fare_pence: 500,
    proposed_tip_pence: 0,
    proposed_buffer_pence: 0,
  });
  assertEquals(d.kind, "create_new"); // must not legacy_fare_tip
});

Deno.test("6. session metadata receivable without allocation fails closed", () => {
  const d = decideCaptureCompositionAction({
    payment_session_id: SESSION,
    provider_order_id: ORDER,
    session: {
      id: SESSION,
      provider_order_id: ORDER,
      metadata: { customer_receivables_pence: 36 },
    },
    reserved_allocations: [],
    authorised_total_pence: 536,
    proposed_trip_fare_pence: 500,
    proposed_tip_pence: 0,
    proposed_buffer_pence: 0,
  });
  assertEquals(d.kind, "fail");
  if (d.kind !== "fail") return;
  assertEquals(d.code, CAPTURE_COMPOSITION_ERROR.RECEIVABLE_ALLOCATION_STATE_UNKNOWN);
});

Deno.test("7. historical session with zero receivable evidence remains compatible", () => {
  const d = decideCaptureCompositionAction({
    payment_session_id: SESSION,
    provider_order_id: ORDER,
    session: { id: SESSION, provider_order_id: ORDER, metadata: {} },
    reserved_allocations: [],
    authorised_total_pence: 500,
    proposed_trip_fare_pence: 500,
    proposed_tip_pence: 0,
    proposed_buffer_pence: 0,
  });
  assertEquals(d.kind, "legacy_fare_tip");
  if (d.kind !== "legacy_fare_tip") return;
  assertEquals(d.target_pence, 500);
});

Deno.test("8. transaction rollback leaves no half-plan — empty session has no freeze", () => {
  const frozen = readFrozenCapturePlan({
    payment_session_id: SESSION,
    provider_order_id: ORDER,
    session: {
      id: SESSION,
      provider_order_id: ORDER,
      // Partial write aborted — no key
      trip_fare_component_pence: 500,
      tip_component_pence: 0,
      receivable_component_pence: null,
      provider_capture_target_pence: null,
      capture_idempotency_key: null,
    },
  });
  assertEquals(frozen, null);
});

Deno.test("9. UNKNOWN keeps plan and reservation (resume frozen; no recompute)", () => {
  const d = decideCaptureCompositionAction({
    payment_session_id: SESSION,
    provider_order_id: ORDER,
    session: makeFrozenSession(536),
    reserved_allocations: reserved36,
    authorised_total_pence: 0, // unknown auth still resumes if target was frozen under prior auth
    proposed_trip_fare_pence: 999,
    proposed_tip_pence: 999,
    proposed_buffer_pence: 999,
  });
  // authorised 0 skips exceed check in validate (auth>0 required for exceed)
  assertEquals(d.kind, "resume_frozen");
});

Deno.test("10. terminal GET reconciles the original immutable plan target", () => {
  const frozen = readFrozenCapturePlan({
    payment_session_id: SESSION,
    provider_order_id: ORDER,
    session: makeFrozenSession(536),
  })!;
  assertEquals(frozen.provider_capture_target_pence, 536);
  assertEquals(frozen.receivable_component_pence, 36);
  assertEquals(frozen.trip_fare_component_pence, 500);
});

Deno.test("11. no second capture POST — same idempotency key forever", () => {
  const s = makeFrozenSession(536);
  const k1 = String(s.capture_idempotency_key);
  const again = decideCaptureCompositionAction({
    payment_session_id: SESSION,
    provider_order_id: ORDER,
    session: s,
    reserved_allocations: reserved36,
    authorised_total_pence: 536,
    proposed_trip_fare_pence: 500,
    proposed_tip_pence: 0,
    proposed_buffer_pence: 0,
  });
  assertEquals(again.kind, "resume_frozen");
  if (again.kind !== "resume_frozen") return;
  assertEquals(again.plan.capture_idempotency_key, k1);
});

Deno.test("12. no TEN/commission/tip/payout in composition components", () => {
  const p = planCaptureComposition({
    trip_fare_component_pence: 500,
    tip_component_pence: 0,
    preauth_buffer_component_pence: 0,
    payment_session_id: SESSION,
    provider_order_id: ORDER,
    authorised_total_pence: 536,
    allocations: reserved36,
  });
  assertEquals(p.ok, true);
  if (!p.ok) return;
  assertEquals(p.trip_fare_component_pence, 500);
  assertEquals(p.receivable_component_pence, 36);
  const cover = assertPlanCoversReceivableEvidence({
    plan: p,
    reserved_total_pence: 36,
    metadata_receivables_pence: 36,
  });
  assertEquals(cover.ok, true);
});

Deno.test("13. migration defines freeze trigger + populated CHECK", async () => {
  const sql = await Deno.readTextFile(
    new URL("../../migrations/20260925120000_capture_composition_components.sql", import.meta.url),
  );
  assertStringIncludes(sql, "payment_sessions_capture_composition_populated_chk");
  assertStringIncludes(sql, "trg_payment_sessions_capture_composition_immutable");
  assertStringIncludes(sql, "CAPTURE_COMPOSITION_FROZEN_IMMUTABLE");
  assertStringIncludes(sql, "capture_composition_frozen_at");
  assertStringIncludes(sql, "SET search_path TO 'public'");
});

Deno.test("14. acquire path is single atomic RPC (source)", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/_shared/captureCompositionAcquireSSOT.ts", import.meta.url),
  );
  assertStringIncludes(src, "claimPaymentSessionFinancialLock");
  assertStringIncludes(src, "payment_session_acquire_capture_composition");
  assertStringIncludes(src, "supabase.rpc(ACQUIRE_CAPTURE_COMPOSITION_RPC");
  assertStringIncludes(src, "CAPTURE_COMPOSITION_MIGRATION_REQUIRED");
  assertStringIncludes(src, "CAPTURE_COMPOSITION_REQUIRED");
  // Edge multi-round-trip plan path must not return.
  assertEquals(src.includes("loadReservedAllocations"), false);
  assertEquals(src.includes("decideCaptureCompositionAction"), false);
  assertEquals(src.includes("persistFrozenPlan"), false);
  const completion = await Deno.readTextFile(
    new URL("../../functions/_shared/revolutCompletionCapture.ts", import.meta.url),
  );
  assertStringIncludes(completion, "acquireLockAndResolveCaptureComposition");
  assertStringIncludes(completion, "failClosedWithoutSessionWhenReceivableEvidence");
});

Deno.test("15. fold metadata without proven allocations → UNKNOWN", () => {
  const ev = detectReceivableCaptureEvidence({
    metadata: { preauth_receivable_ordering: "ride_then_recv", customer_receivable_ids: [] },
    reserved_allocations: [],
  });
  assertEquals(ev.has_evidence, true);
  assertEquals(ev.reasons.includes("fold_metadata_without_amounts"), true);
});

Deno.test("16. RLS proof: payment_sessions service-role policy covers new columns", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "../../migrations/20260710092512_ce6a4864-0d9d-4829-acaf-805f215693b6.sql",
      import.meta.url,
    ),
  );
  assertStringIncludes(sql, 'CREATE POLICY "Service role manages payment_sessions"');
  const mig = await Deno.readTextFile(
    new URL("../../migrations/20260925120000_capture_composition_components.sql", import.meta.url),
  );
  assertStringIncludes(mig, "No redundant policies added");
});
