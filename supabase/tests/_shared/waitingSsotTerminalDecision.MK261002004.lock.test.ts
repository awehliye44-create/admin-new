/**
 * Waiting SSOT terminal-decision lock — MK-261002-004.
 *
 * Customer cancel and No-Show decide from counted waiting resolved from
 * trip_waiting_segments at the decision time. The trips counter is a cache:
 * it may be 0 (as in MK-261002-004) and must not change the outcome.
 * Unreadable segments block the decision; they never become NO_FEE.
 *
 * If this fails, fix the code — never delete or soften the lock.
 */
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isArrivalCancellationFeeEligible,
  resolveTerminalPaymentDecision,
  type FarePricingFeeConfig,
  type TerminalTripEvidence,
} from "../../functions/_shared/terminalFeeDecisionSSOT.ts";
import { disposeTerminalTripPayment } from "../../functions/_shared/terminalTripPaymentDisposition.ts";
import {
  noShowEligibleFromCountedSeconds,
  resolveCanonicalWaitingSeconds,
  WAITING_EVIDENCE_UNAVAILABLE,
} from "../../functions/_shared/waitingSegmentClock.ts";
import { evaluateCanMarkNoShow } from "../../functions/_shared/tripNoShowRules.ts";
import { postTerminalEntitlementFromSettlement } from "../../functions/_shared/terminalOutcomeEntitlementSSOT.ts";
import {
  createFakeDb,
  type FakeRow,
  INCIDENT_CANCELLED_AT,
  INCIDENT_SEGMENTS,
} from "./waitingSsotFakeDb.ts";

const TRIP = "5ece2be1-dee0-4109-adef-ff9c49f9a004";
const DRIVER = "driver-mk261002004";
const SESSION = "ps-mk261002004";
const ARRIVED = "2026-10-02T10:07:36.310Z";
const FREE_EXPIRES = "2026-10-02T10:10:36.310Z";
const AUTHORISED = 750;

/** GO policy row 9ab39ea8-536c-4e4a-864e-218db52b7263 (MK service area). */
const GO_POLICY: FarePricingFeeConfig = {
  cancellation_fee_pence: 0,
  cancellation_grace_period_minutes: 3,
  cancellation_apply_after_arrival_only: true,
  no_show_fee_pence: 450,
  no_show_wait_time_minutes: 5,
  no_show_apply_after_arrival_only: true,
  late_cancel_enabled: true,
  late_cancel_threshold_minutes: 30,
  late_cancel_fee_pence: 450,
  arrival_cancellation_enabled: true,
  arrival_cancellation_fee_pence: 450,
  arrival_cancellation_apply_after_free_waiting_expired: true,
  arrival_cancellation_after_arrival_only: true,
  free_waiting_minutes: 3,
};

function evidence(over: Partial<TerminalTripEvidence>): TerminalTripEvidence {
  return {
    trip_id: TRIP,
    trip_status: "cancelled",
    started_at: null,
    arrived_at: ARRIVED,
    free_wait_expires_at: FREE_EXPIRES,
    cancelled_at: INCIDENT_CANCELLED_AT,
    cancelled_by: "rider",
    scheduled_at: null,
    cancellation_grace_expires_at: null,
    driver_id: DRIVER,
    confirmed_driver_id: DRIVER,
    no_show_recorded: false,
    authorised_amount_pence: AUTHORISED,
    previously_captured_amount_pence: 0,
    payment_session_id: SESSION,
    provider: "revolut",
    ...over,
  };
}

function segmentsDb(segments: Array<{ started_at: string; ended_at: string | null }>, cached = 0) {
  return createFakeDb({
    trip_waiting_segments: segments.map((s, i) => ({
      id: `seg-${i + 1}`,
      trip_id: TRIP,
      location_type: "pickup",
      stop_id: null,
      ...s,
    })),
    trips: [{ id: TRIP, pickup_waiting_counted_seconds: cached }],
  });
}

async function canonicalAt(segments: Array<{ started_at: string; ended_at: string | null }>, atIso: string) {
  const r = await resolveCanonicalWaitingSeconds(segmentsDb(segments).client, {
    tripId: TRIP,
    locationType: "pickup",
    atIso,
  });
  assert(r.ok, "segments must resolve");
  return r.countedSeconds;
}

function ledgerFake() {
  const rows: Array<FakeRow & { type: string; related_trip_id: string; amount_pence: number }> = [];
  const supabase = {
    from(table: string) {
      if (table !== "driver_wallet_ledger") throw new Error(`unexpected table ${table}`);
      const filters: Record<string, string> = {};
      const api = {
        select() {
          return api;
        },
        eq(k: string, v: string) {
          filters[k] = v;
          return api;
        },
        in() {
          return Promise.resolve({
            data: rows.filter((r) => r.related_trip_id === filters.related_trip_id).map((r) => ({ type: r.type, id: r.id })),
          });
        },
        maybeSingle() {
          const m = rows.find((r) => r.related_trip_id === filters.related_trip_id && r.type === filters.type);
          return Promise.resolve({ data: m ? { id: m.id, type: m.type } : null });
        },
        insert(row: FakeRow & { type: string; related_trip_id: string; amount_pence: number }) {
          if (rows.some((r) => r.related_trip_id === row.related_trip_id && r.type === row.type)) {
            return Promise.resolve({ error: { code: "23505" } });
          }
          rows.push({ id: `l-${rows.length + 1}`, ...row });
          return Promise.resolve({ error: null });
        },
      };
      return api;
    },
  };
  return { supabase: supabase as never, rows };
}

Deno.test("replay MK-261002-004: canonical 244 s ≥ 180 → ARRIVAL_CANCELLATION 450, capture 450, release 300", async () => {
  const counted = await canonicalAt(INCIDENT_SEGMENTS, INCIDENT_CANCELLED_AT);
  assertEquals(counted, 244);

  assertEquals(isArrivalCancellationFeeEligible({
    arrivedAtMs: Date.parse(ARRIVED),
    cancelledAtMs: Date.parse(INCIDENT_CANCELLED_AT),
    freeExpiresMs: Date.parse(FREE_EXPIRES),
    requireFreeWaitExpired: true,
    freeWaitingMinutes: 3,
    countedInRadiusSeconds: counted,
  }), true);

  const d = resolveTerminalPaymentDecision({
    evidence: evidence({ pickup_waiting_counted_seconds: counted }),
    config: GO_POLICY,
    feePolicyId: "9ab39ea8-536c-4e4a-864e-218db52b7263",
  });
  assertEquals(d.disposition_reason, "ARRIVAL_CANCELLATION_FEE");
  assertEquals(d.fee_type, "arrival_cancellation");
  assertEquals(d.fee_amount_pence, 450);
  assertEquals(d.capture_required_pence, 450);
  assertEquals(d.release_required_pence, 300);
  assertEquals(d.provider_action, "partial_capture_fee");
  assertEquals(d.decision_evidence.pickup_waiting_counted_seconds, 244);
});

Deno.test("replay MK-261002-004: the zeroed cache would have decided NO_FEE — the cache must not decide", () => {
  const fromCache = resolveTerminalPaymentDecision({
    evidence: evidence({ pickup_waiting_counted_seconds: 0 }),
    config: GO_POLICY,
  });
  assertEquals(fromCache.disposition_reason, "NO_FEE_FULL_RELEASE");
  assertEquals(fromCache.release_required_pence, 750);
});

Deno.test("replay MK-261002-004: after confirmed capture, one TEN = 450 − actual provider fee, commission 0", async () => {
  for (const providerFee of [0, 9, 23, 37]) {
    const fake = ledgerFake();
    const ev = {
      payment_session_id: SESSION,
      captured_pence: 450,
      provider_fee_pence: providerFee,
      provider_fee_confirmed: true,
    };
    const first = await postTerminalEntitlementFromSettlement({
      supabase: fake.supabase,
      tripId: TRIP,
      driverId: DRIVER,
      outcome: "ARRIVAL_CANCELLATION",
      currency: "GBP",
      evidence: ev,
    });
    const replay = await postTerminalEntitlementFromSettlement({
      supabase: fake.supabase,
      tripId: TRIP,
      driverId: DRIVER,
      outcome: "ARRIVAL_CANCELLATION",
      currency: "GBP",
      evidence: ev,
    });
    assertEquals(first.entitlement_pence, 450 - providerFee);
    assertEquals(first.commission_pence, 0);
    assertEquals(first.ledger_type, "TRIP_EARNING_NET");
    assertEquals(replay.credited, true);
    assertEquals(fake.rows.filter((r) => r.type === "TRIP_EARNING_NET").length, 1);
    assertEquals(fake.rows[0].amount_pence, 450 - providerFee);
    assertEquals(fake.rows[0].driver_id, DRIVER);
  }
});

Deno.test("early cancel: canonical < 180 s → NO_FEE, capture 0, full release — even when wall-clock since Arrived > 180 s", async () => {
  const arrived = "2026-10-02T11:00:00.000Z";
  const cancelledAt = "2026-10-02T11:06:40.000Z"; // 400 s after Arrived
  const segments = [
    { started_at: "2026-10-02T11:00:00.000Z", ended_at: "2026-10-02T11:02:00.000Z" }, // 120 s
    { started_at: "2026-10-02T11:06:10.000Z", ended_at: null }, // 30 s at cancel
  ];
  const counted = await canonicalAt(segments, cancelledAt);
  assertEquals(counted, 150);
  const d = resolveTerminalPaymentDecision({
    evidence: evidence({
      arrived_at: arrived,
      free_wait_expires_at: "2026-10-02T11:03:00.000Z",
      cancelled_at: cancelledAt,
      pickup_waiting_counted_seconds: counted,
    }),
    config: GO_POLICY,
  });
  assertEquals(d.disposition_reason, "NO_FEE_FULL_RELEASE");
  assertEquals(d.capture_required_pence, 0);
  assertEquals(d.release_required_pence, 750);
  assertEquals(d.provider_action, "void_full");
});

Deno.test("No-Show: pause/re-open keeps eligibility (canonical ≥ 300 s); precedence beats arrival fee", async () => {
  const arrived = "2026-10-02T12:00:00.000Z";
  const decisionAt = "2026-10-02T12:06:00.000Z";
  const segments = [
    { started_at: "2026-10-02T12:00:00.000Z", ended_at: "2026-10-02T12:03:20.000Z" }, // 200 s
    { started_at: "2026-10-02T12:04:10.000Z", ended_at: null }, // 110 s at decision
  ];
  const counted = await canonicalAt(segments, decisionAt);
  assertEquals(counted, 310);
  assertEquals(noShowEligibleFromCountedSeconds({ countedSeconds: counted, requiredWaitMinutes: 5 }), true);
  // The pre-fix re-open shortcut left only the open segment (≈110 s) → wrongly ineligible.
  assertEquals(noShowEligibleFromCountedSeconds({ countedSeconds: 110, requiredWaitMinutes: 5 }), false);

  const can = evaluateCanMarkNoShow({
    tripStatus: "arrived",
    arrivedAtIso: arrived,
    pricing: { noShowWaitMinutes: 5, freeWaitingMinutes: 3, noShowFeePence: 450, noShowAfterArrivalOnly: true },
    dispatch: { pickupRadiusEnabled: true, pickupRadiusMeters: 150 },
    countedInRadiusSeconds: counted,
    driverLat: 52.0406,
    driverLng: -0.7594,
    pickupLat: 52.0406,
    pickupLng: -0.7594,
  });
  assertEquals(can.canMark, true);

  const d = resolveTerminalPaymentDecision({
    evidence: evidence({
      trip_status: "no_show",
      cancelled_by: null,
      cancelled_at: null,
      decision_at: decisionAt,
      no_show_recorded: true,
      arrived_at: arrived,
      free_wait_expires_at: "2026-10-02T12:03:00.000Z",
      pickup_waiting_counted_seconds: counted,
    }),
    config: GO_POLICY,
  });
  assertEquals(d.disposition_reason, "CUSTOMER_NO_SHOW");
  assertEquals(d.capture_required_pence, 450);
  assertEquals(d.release_required_pence, 300);

  const short = await canonicalAt(segments, "2026-10-02T12:05:45.000Z");
  assertEquals(short, 295);
  assertEquals(noShowEligibleFromCountedSeconds({ countedSeconds: short, requiredWaitMinutes: 5 }), false);
});

Deno.test("disposition fail-closed: unreadable segments → hold kept, no decision, no provider call, no write", async () => {
  const db = createFakeDb({
    trips: [{
      id: TRIP,
      status: "cancelled",
      started_at: null,
      arrived_at: ARRIVED,
      free_wait_expires_at: FREE_EXPIRES,
      cancelled_at: INCIDENT_CANCELLED_AT,
      cancelled_by: "rider",
      service_area_id: "cb58f1bd-8b6f-45b9-ad31-b3140309892c",
      vehicle_type_id: "a5c59e9b-ed66-4dd1-8043-1f4730691c12",
      payment_provider: "revolut",
      provider_order_id: "order-x",
      payment_session_id: SESSION,
      authorised_amount_pence: AUTHORISED,
      pickup_waiting_counted_seconds: 0,
    }],
    payment_sessions: [{
      id: SESSION,
      trip_id: TRIP,
      purpose: "RIDE_BOOKING",
      provider_order_id: "order-x",
      authorised_amount_pence: AUTHORISED,
      captured_amount_pence: 0,
      metadata: {},
    }],
    fare_pricing_settings: [{
      id: "9ab39ea8-536c-4e4a-864e-218db52b7263",
      service_area_id: "cb58f1bd-8b6f-45b9-ad31-b3140309892c",
      vehicle_type_id: "a5c59e9b-ed66-4dd1-8043-1f4730691c12",
      ...GO_POLICY,
    }],
    trip_waiting_segments: [],
  }, { failSelect: (t: string) => t === "trip_waiting_segments" });

  const realFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (() => {
    fetches += 1;
    throw new Error("provider must not be called");
  }) as typeof fetch;
  try {
    const r = await disposeTerminalTripPayment(db.client as never, {
      tripId: TRIP,
      reason: "customer_cancel",
    });
    assertEquals(r.outcome, "SKIPPED_SAFETY_CHECK");
    assertStringIncludes(String(r.message), WAITING_EVIDENCE_UNAVAILABLE);
    assertEquals(r.decision, undefined);
  } finally {
    globalThis.fetch = realFetch;
  }
  assertEquals(fetches, 0);
  assertEquals(db.writes.length, 0);
});

async function src(rel: string): Promise<string> {
  return await Deno.readTextFile(new URL(`../../functions/${rel}`, import.meta.url));
}

Deno.test("source lock: cancel-trip decides from segments before any mutation and freezes them at cancelled_at", async () => {
  const s = await src("cancel-trip/index.ts");
  assertEquals(s.includes("trip.pickup_waiting_counted_seconds"), false);
  const update = s.indexOf(".update(tripUpdate)");
  const resolveUses = [...s.matchAll(/await resolvePickupWaitingAtDecision\(\)/g)].map((m) => m.index!);
  assertEquals(resolveUses.length, 2);
  for (const i of resolveUses) assert(i < update, "waiting resolved before trip mutation");
  const unavailable = [...s.matchAll(/return waitingEvidenceUnavailableResponse\(\)/g)].map((m) => m.index!);
  assertEquals(unavailable.length, 2);
  for (const i of unavailable) assert(i < update, "fail-closed return precedes trip mutation");
  assertStringIncludes(s, "WAITING_EVIDENCE_UNAVAILABLE");
  const finalize = s.indexOf("finalizeWaitingSegmentsAtTerminal(supabase");
  const dispose = s.indexOf("disposeTerminalTripPayment(supabase");
  assert(update < finalize && finalize < dispose, "segments frozen after the cancel commit, before disposition");
  assertStringIncludes(s.slice(dispose, dispose + 600), "canonicalPickupWaitingSeconds");
  assertStringIncludes(s, "atIso: decisionAtIso");
  assertStringIncludes(s, "cancelled_at: decisionAtIso");
  // Live-only financial behaviour stays.
  assertStringIncludes(s, "maybeResumeTerminalFeeSettlementAfterProviderFee");
  assertStringIncludes(s, "previous_driver_id");
  assertStringIncludes(s, "forceFeePenceOverride: true");
});

Deno.test("source lock: disposition evidence uses the canonical value, never the cache", async () => {
  const s = await src("_shared/terminalTripPaymentDisposition.ts");
  assertEquals(/pickup_waiting_counted_seconds:\s*trip\.pickup_waiting_counted_seconds/.test(s), false);
  assertStringIncludes(s, "pickup_waiting_counted_seconds: pickupWaitingCountedSeconds");
  const failClosed = s.indexOf("WAITING_EVIDENCE_UNAVAILABLE}:");
  const decide = s.indexOf("resolveTerminalPaymentDecision({");
  assert(failClosed > 0 && failClosed < decide, "fail-closed return precedes the decision");
  assertStringIncludes(s, "reconcileReceivablesOnAbandonOrCancel");
});

Deno.test("source lock: pickup-no-show decides from segments at decision time and freezes them", async () => {
  const s = await src("pickup-no-show/index.ts");
  assertEquals(s.includes("trip.pickup_waiting_counted_seconds"), false);
  const resolve = s.indexOf("resolveCanonicalWaitingSeconds(supabase");
  const update = s.indexOf("completed_at: trip.completed_at ?? now");
  const finalize = s.indexOf("finalizeWaitingSegmentsAtTerminal(supabase");
  assert(resolve > 0 && resolve < update && update < finalize);
  assertStringIncludes(s, "WAITING_EVIDENCE_UNAVAILABLE");
  assertStringIncludes(s, "const now = decisionAtIso");
  assertStringIncludes(s, "settleNoShowFee");
});

Deno.test("source lock: waiting ticks never write a charge from incomplete evidence", async () => {
  const pickup = await src("tick-pickup-waiting-charge/index.ts");
  const guard = pickup.indexOf("if (!waitingEvidenceComplete)");
  assert(guard > 0 && guard < pickup.indexOf(".update(updateData)"));
  const stop = await src("tick-waiting-charge/index.ts");
  const stopGuard = stop.indexOf("if (!clock.evidenceComplete)");
  assert(stopGuard > 0 && stopGuard < stop.indexOf('.from("trip_stops")\n      .update('));
});
