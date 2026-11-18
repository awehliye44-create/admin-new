/**
 * Bug #44 — JIT-aware pre-dispatch scheduled commitment eligibility.
 *
 * deno test --allow-read supabase/tests/_shared/bug44JitAwarePredispatchEligibility.test.ts
 */
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { fromFileUrl } from "https://deno.land/std@0.224.0/path/from_file_url.ts";
import { join } from "https://deno.land/std@0.224.0/path/join.ts";
import {
  COMMITMENT_INSTANT_PICKUP_WAITING_MINUTES_DEFAULT,
  COMMITMENT_TRAVEL_ETA_FALLBACK_MINUTES,
  composeInstantAdditionalWorkRemainingMinutes,
  evaluateScheduledCommitmentFeasibility,
  isJitDepartureActivationProtected,
  resolveCommitmentPickupWaitingMinutes,
  selectEarliestConfirmedCommitment,
  type ConfirmedScheduledCommitment,
} from "../../functions/_shared/scheduledCommitmentFeasibilitySSOT.ts";
import { estimateEtaMinutes } from "../../functions/_shared/scheduledDispatchConfig.ts";
import {
  SCHEDULED_JIT_ACTIVATION_DEFAULTS,
  computeJitDepartureDeadlineMs,
} from "../../functions/_shared/scheduledJitActivationSSOT.ts";

const REPO = fromFileUrl(new URL("../../..", import.meta.url));

async function read(rel: string): Promise<string> {
  return await Deno.readTextFile(join(REPO, rel));
}

const CONFIG = SCHEDULED_JIT_ACTIVATION_DEFAULTS;

/** Local MK-ish coords: short hop. */
const DRIVER = { lat: 52.04, lng: -0.76 };
const NEAR_PICKUP = { lat: 52.041, lng: -0.761 };
const NEAR_DROPOFF = { lat: 52.05, lng: -0.77 };
/** Distant scheduled pickup (Aylesbury-ish). */
const FAR_SCHEDULED = { lat: 51.81915, lng: -0.8219167 };

Deno.test("compose remaining includes travel + waiting + duration (+ stacked)", () => {
  const idle = composeInstantAdditionalWorkRemainingMinutes({
    travelToCandidatePickupMinutes: 8,
    pickupWaitingMinutes: 5,
    candidateDurationMinutes: 12,
  });
  assertEquals(idle, 8 + 5 + 12);

  const stacked = composeInstantAdditionalWorkRemainingMinutes({
    stackedRemainingMinutes: 20,
    travelToCandidatePickupMinutes: 8,
    pickupWaitingMinutes: 5,
    candidateDurationMinutes: 12,
  });
  assertEquals(stacked, 20 + 8 + 5 + 12);
});

Deno.test("compatible short instant well before scheduled remains feasible", () => {
  const nowMs = Date.parse("2026-11-18T10:00:00Z");
  const scheduledAtMs = Date.parse("2026-11-18T12:00:00Z");
  const travelToCand = estimateEtaMinutes(
    DRIVER.lat,
    DRIVER.lng,
    NEAR_PICKUP.lat,
    NEAR_PICKUP.lng,
  )!;
  const remaining = composeInstantAdditionalWorkRemainingMinutes({
    travelToCandidatePickupMinutes: travelToCand,
    pickupWaitingMinutes: COMMITMENT_INSTANT_PICKUP_WAITING_MINUTES_DEFAULT,
    candidateDurationMinutes: 10,
  });
  const travelDropoffToSched = estimateEtaMinutes(
    NEAR_DROPOFF.lat,
    NEAR_DROPOFF.lng,
    FAR_SCHEDULED.lat,
    FAR_SCHEDULED.lng,
  )!;
  const f = evaluateScheduledCommitmentFeasibility({
    nowMs,
    remainingJourneyMinutes: remaining,
    travelToPickupEtaMinutes: travelDropoffToSched,
    scheduledAtMs,
    config: CONFIG,
  });
  assertEquals(f.feasible, true);
});

Deno.test("incompatible long instant near scheduled is rejected", () => {
  const nowMs = Date.parse("2026-11-18T11:40:00Z");
  const scheduledAtMs = Date.parse("2026-11-18T12:00:00Z");
  const remaining = composeInstantAdditionalWorkRemainingMinutes({
    travelToCandidatePickupMinutes: 10,
    pickupWaitingMinutes: 5,
    candidateDurationMinutes: 25,
  });
  const travelDropoffToSched = estimateEtaMinutes(
    NEAR_DROPOFF.lat,
    NEAR_DROPOFF.lng,
    FAR_SCHEDULED.lat,
    FAR_SCHEDULED.lng,
  )!;
  const f = evaluateScheduledCommitmentFeasibility({
    nowMs,
    remainingJourneyMinutes: remaining,
    travelToPickupEtaMinutes: travelDropoffToSched,
    scheduledAtMs,
    config: CONFIG,
  });
  assertEquals(f.feasible, false);
  assertEquals(f.reason, "insufficient_lead");
});

Deno.test("approaching JIT: sticky deadline hard-excludes new offers", () => {
  const nowMs = Date.parse("2026-11-18T11:50:00Z");
  const scheduledAtMs = Date.parse("2026-11-18T12:30:00Z");
  const deadline = computeJitDepartureDeadlineMs({
    scheduledAtMs,
    driverToPickupEtaMinutes: 20,
    config: CONFIG,
  });
  // Simulate sticky deadline already reached.
  const g = isJitDepartureActivationProtected({
    nowMs: deadline.deadlineMs,
    scheduledStatus: "driver_assigned",
    jitActivateAtMs: deadline.deadlineMs,
    scheduledAtMs,
    travelEtaToScheduledPickupMinutes: 20,
    config: CONFIG,
  });
  assertEquals(g.protected, true);
  assertEquals(g.reason, "jit_departure_deadline_reached");

  // Before deadline: not protected by stage (feasibility may still exclude).
  const before = isJitDepartureActivationProtected({
    nowMs: deadline.deadlineMs - 10 * 60_000,
    scheduledStatus: "driver_assigned",
    jitActivateAtMs: deadline.deadlineMs,
    scheduledAtMs,
    travelEtaToScheduledPickupMinutes: 20,
    config: CONFIG,
  });
  assertEquals(before.protected, false);
  void nowMs;
});

Deno.test("awaiting_activation_accept hard-excludes regardless of remaining slack", () => {
  const g = isJitDepartureActivationProtected({
    nowMs: Date.parse("2026-11-18T10:00:00Z"),
    scheduledStatus: "awaiting_activation_accept",
    jitActivateAtMs: null,
    scheduledAtMs: Date.parse("2026-11-18T14:00:00Z"),
    travelEtaToScheduledPickupMinutes: 5,
    config: CONFIG,
  });
  assertEquals(g.protected, true);
  assertEquals(g.reason, "jit_activation_armed");
});

Deno.test("long-distance scheduled pickup uses banded ETA in remaining check", () => {
  const travel = estimateEtaMinutes(
    NEAR_DROPOFF.lat,
    NEAR_DROPOFF.lng,
    FAR_SCHEDULED.lat,
    FAR_SCHEDULED.lng,
  );
  assert(travel != null && travel > 15);
  assert(travel! < 90, `travel=${travel} unexpectedly huge`);
});

Deno.test("stacked commitment remaining is strictly larger than idle", () => {
  const idle = composeInstantAdditionalWorkRemainingMinutes({
    travelToCandidatePickupMinutes: 6,
    pickupWaitingMinutes: 5,
    candidateDurationMinutes: 15,
  });
  const stacked = composeInstantAdditionalWorkRemainingMinutes({
    stackedRemainingMinutes: 22,
    travelToCandidatePickupMinutes: 6,
    pickupWaitingMinutes: 5,
    candidateDurationMinutes: 15,
  });
  assert(stacked > idle);
  assertEquals(stacked - idle, 22);
});

Deno.test("stale / missing ETA falls back conservatively to 30 minutes", () => {
  assertEquals(COMMITMENT_TRAVEL_ETA_FALLBACK_MINUTES, 30);
  const remaining = composeInstantAdditionalWorkRemainingMinutes({
    travelToCandidatePickupMinutes: COMMITMENT_TRAVEL_ETA_FALLBACK_MINUTES,
    pickupWaitingMinutes: resolveCommitmentPickupWaitingMinutes(null),
    candidateDurationMinutes: 10,
  });
  assertEquals(
    remaining,
    30 + COMMITMENT_INSTANT_PICKUP_WAITING_MINUTES_DEFAULT + 10,
  );
});

Deno.test("waiting minutes prefer dispatch grace seconds", () => {
  assertEquals(
    resolveCommitmentPickupWaitingMinutes({
      pickup_waiting_grace_period_seconds: 300,
    }),
    5,
  );
  assertEquals(
    resolveCommitmentPickupWaitingMinutes({
      pickup_waiting_grace_period_seconds: 180,
    }),
    3,
  );
});

Deno.test("selectEarliestConfirmedCommitment skips stale rows", () => {
  const nowMs = Date.parse("2026-11-18T12:00:00Z");
  const rows: ConfirmedScheduledCommitment[] = [
    {
      tripId: "old",
      scheduledAtMs: nowMs - 20 * 60_000,
      pickupLat: 1,
      pickupLng: 1,
      scheduledStatus: "driver_assigned",
      jitActivateAtMs: null,
    },
    {
      tripId: "next",
      scheduledAtMs: nowMs + 60 * 60_000,
      pickupLat: 2,
      pickupLng: 2,
      scheduledStatus: "scheduled_committed",
      jitActivateAtMs: null,
    },
  ];
  const earliest = selectEarliestConfirmedCommitment(rows, nowMs);
  assertEquals(earliest?.tripId, "next");
});

Deno.test("auto-dispatch + accept-offer wire Bug #44 gate; SQL twin exists", async () => {
  const dispatch = await read("supabase/functions/auto-dispatch/index.ts");
  assertStringIncludes(dispatch, "evaluateInstantOfferScheduledCommitmentGate");
  assertStringIncludes(dispatch, "Bug #44");
  // Fresh now per wave — no eligibility snapshot reuse.
  assertStringIncludes(dispatch, "const nowMsGate = Date.now()");

  const accept = await read("supabase/functions/accept-offer/index.ts");
  assertStringIncludes(accept, "evaluateInstantOfferScheduledCommitmentGate");
  assertStringIncludes(accept, "driver_scheduled_commitment_gate");

  const sql = await read(
    "supabase/migrations/20270226160000_bug44_jit_aware_commitment_gate.sql",
  );
  assertStringIncludes(sql, "jit_activation_armed");
  assertStringIncludes(sql, "jit_departure_deadline_reached");
  assertStringIncludes(sql, "v_travel_to_cand");
  assertStringIncludes(sql, "v_waiting");
  assertStringIncludes(sql, "scheduled_jit_activate_at");

  const gate = await read(
    "supabase/functions/_shared/scheduledCommitmentOfferGateSSOT.ts",
  );
  assertStringIncludes(gate, "composeInstantAdditionalWorkRemainingMinutes");
  assertStringIncludes(gate, "isJitDepartureActivationProtected");
});

Deno.test("duration-only remaining (pre-Bug #44) under-counts vs composed", () => {
  const durationOnly = 15;
  const composed = composeInstantAdditionalWorkRemainingMinutes({
    travelToCandidatePickupMinutes: 8,
    pickupWaitingMinutes: 5,
    candidateDurationMinutes: 15,
  });
  assert(composed > durationOnly);
  assertEquals(composed - durationOnly, 13);
});
