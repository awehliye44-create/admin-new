/**
 * Phase 4 JIT hardening tests.
 * Run: deno test --no-check --allow-read supabase/functions/_shared/scheduledJitActivationSSOT.test.ts
 */
import {
  assertEquals,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyDriverAvailabilityForJit,
  classifyJitDistanceKind,
  clampJitDeadlineToFixedFloor,
  computeJitDepartureDeadlineMs,
  decideConfirmedScheduledActivation,
  isWithinJitPlanningHorizon,
  reconcileStickyJitDeadline,
  resolveJitExecutionMode,
  SCHEDULED_JIT_ACTIVATION_DEFAULTS,
} from "./scheduledJitActivationSSOT.ts";
import {
  evaluateScheduledCommitmentFeasibility,
  activeJourneyThreatensScheduledCommitment,
} from "./scheduledCommitmentFeasibilitySSOT.ts";
import {
  buildConfirmedActivationPatch,
  buildExclusiveActivationArmPatch,
  isAlreadyConfirmedActivated,
  PHASE5_ACK_BOUNDARY,
} from "./scheduledConfirmedActivationSSOT.ts";
import { evaluateJitDriverLocationFreshness } from "./scheduledJitEtaMonitorSSOT.ts";
import { estimateEtaMinutes } from "./scheduledDispatchConfig.ts";

Deno.test("JIT example: 20:30 pickup, ETA 8, buffers → 20:14", () => {
  const pickup = Date.parse("2026-11-12T20:30:00.000Z");
  const r = computeJitDepartureDeadlineMs({
    scheduledAtMs: pickup,
    driverToPickupEtaMinutes: 8,
    config: SCHEDULED_JIT_ACTIVATION_DEFAULTS,
  });
  assertEquals(r.kind, "local");
  assertEquals(new Date(r.deadlineMs).toISOString(), "2026-11-12T20:14:00.000Z");
});

Deno.test("default execution mode is ack_nro — not auto en_route", () => {
  assertEquals(resolveJitExecutionMode(SCHEDULED_JIT_ACTIVATION_DEFAULTS), "ack_nro");
  assertEquals(
    resolveJitExecutionMode({ autoActivateEnabled: true }),
    "auto_en_route",
  );
});

Deno.test("due deadline defaults to arm_exclusive_nro not activate_now", () => {
  const pickup = Date.parse("2026-11-12T20:30:00.000Z");
  const fixedAt = pickup - 11 * 60_000;
  const d = decideConfirmedScheduledActivation({
    nowMs: pickup - 14 * 60_000,
    scheduledAtMs: pickup,
    jitDeadlineMs: pickup - 16 * 60_000,
    fixedFallbackDue: false,
    fixedFallbackActivationAtMs: fixedAt,
    fixedFallbackKind: "local",
    intentionallyHeld: false,
    activeJourneyThreatensCommitment: false,
    driverAvailableForActivation: true,
    availabilityClass: "available",
    executionMode: "ack_nro",
  });
  assertEquals(d.action, "arm_exclusive_nro");
  if (d.action === "arm_exclusive_nro") {
    assertEquals(d.phase5AckDeadlineAtMs, null);
  }
});

Deno.test("unavailable / stale / offline → rescue — never blind fixed activate", () => {
  const pickup = Date.parse("2026-11-12T20:30:00.000Z");
  const fixedAt = pickup - 11 * 60_000;
  for (const availability of ["stale_location", "offline", "unreachable", "missing_location"] as const) {
    const d = decideConfirmedScheduledActivation({
      nowMs: fixedAt + 1_000,
      scheduledAtMs: pickup,
      jitDeadlineMs: null,
      fixedFallbackDue: true,
      fixedFallbackActivationAtMs: fixedAt,
      fixedFallbackKind: "local",
      intentionallyHeld: false,
      activeJourneyThreatensCommitment: false,
      driverAvailableForActivation: false,
      availabilityClass: availability,
      executionMode: "ack_nro",
    });
    assertEquals(d.action, "unavailable_rescue");
  }
});

Deno.test("ETA spike cannot pull sticky deadline hours before fixed floor", () => {
  const pickup = Date.parse("2026-11-12T20:30:00.000Z");
  const fixedAt = pickup - 11 * 60_000; // 20:19
  // Spiked ETA 120 min → raw deadline 20:30-5-120-5 = 18:20
  const raw = computeJitDepartureDeadlineMs({
    scheduledAtMs: pickup,
    driverToPickupEtaMinutes: 120,
    config: SCHEDULED_JIT_ACTIVATION_DEFAULTS,
  });
  const clamped = clampJitDeadlineToFixedFloor({
    candidateDeadlineMs: raw.deadlineMs,
    fixedActivationAtMs: fixedAt,
    maxEarlyPullAheadOfFixedMinutes: 20,
  });
  // earliest allowed = 20:19 - 20 = 19:59
  assertEquals(new Date(clamped).toISOString(), "2026-11-12T19:59:00.000Z");
  assert(clamped > raw.deadlineMs);

  const sticky = reconcileStickyJitDeadline({
    previousDeadlineMs: null,
    candidateDeadlineMs: raw.deadlineMs,
    fixedActivationAtMs: fixedAt,
    oscillationToleranceMinutes: 2,
    maxEarlyPullAheadOfFixedMinutes: 20,
    currentScheduledAtMs: pickup,
  });
  assertEquals(sticky.deadlineMs, clamped);
});

Deno.test("pickup reschedule invalidates sticky basis", () => {
  const oldPickup = Date.parse("2026-11-12T20:30:00.000Z");
  const newPickup = Date.parse("2026-11-12T21:00:00.000Z");
  const fixedAt = newPickup - 11 * 60_000;
  const sticky = reconcileStickyJitDeadline({
    previousDeadlineMs: oldPickup - 16 * 60_000,
    candidateDeadlineMs: newPickup - 16 * 60_000,
    fixedActivationAtMs: fixedAt,
    oscillationToleranceMinutes: 2,
    maxEarlyPullAheadOfFixedMinutes: 20,
    basisScheduledAtMs: oldPickup,
    currentScheduledAtMs: newPickup,
  });
  assertEquals(sticky.reason, "basis_reset");
});

Deno.test("planning horizon gates early ETA monitoring", () => {
  const pickup = Date.parse("2026-11-12T20:30:00.000Z");
  assertEquals(
    isWithinJitPlanningHorizon({
      nowMs: pickup - 2 * 60 * 60_000,
      scheduledAtMs: pickup,
      planningHorizonMinutes: 90,
    }),
    false,
  );
  assertEquals(
    isWithinJitPlanningHorizon({
      nowMs: pickup - 60 * 60_000,
      scheduledAtMs: pickup,
      planningHorizonMinutes: 90,
    }),
    true,
  );
});

Deno.test("haversine fallback is conservative (min 3 min, slow speed)", () => {
  // ~1 km apart
  const eta = estimateEtaMinutes(52.04, -0.76, 52.049, -0.76);
  assert(eta != null && eta >= 3);
  // Must not be unrealistically fast for ~1km
  assert(eta! >= 4);
});

Deno.test("stale location classification", () => {
  assertEquals(
    classifyDriverAvailabilityForJit({
      presenceStatus: "online",
      locationFresh: false,
      locationReason: "stale_heartbeat",
      hasActiveJourney: false,
      routingFailedWithFreshLocation: false,
    }),
    "stale_location",
  );
  assertEquals(
    classifyDriverAvailabilityForJit({
      presenceStatus: "offline",
      locationFresh: false,
      locationReason: "missing_presence",
      hasActiveJourney: false,
      routingFailedWithFreshLocation: false,
    }),
    "offline",
  );
});

Deno.test("commitment feasibility + conflict rescue semantics", () => {
  const pickup = Date.parse("2026-11-12T20:30:00.000Z");
  const bad = evaluateScheduledCommitmentFeasibility({
    nowMs: Date.parse("2026-11-12T20:10:00.000Z"),
    remainingJourneyMinutes: 25,
    travelToPickupEtaMinutes: 15,
    scheduledAtMs: pickup,
    config: SCHEDULED_JIT_ACTIVATION_DEFAULTS,
  });
  assertEquals(bad.feasible, false);
  assertEquals(
    activeJourneyThreatensScheduledCommitment({
      hasActiveJourney: true,
      feasibility: bad,
    }).threatens,
    true,
  );
  // Idle + infeasible numbers alone does not threaten (no active journey)
  assertEquals(
    activeJourneyThreatensScheduledCommitment({
      hasActiveJourney: false,
      feasibility: bad,
    }).threatens,
    false,
  );
});

Deno.test("arm patch preserves acknowledgement; Phase 5 boundary reserved", () => {
  const arm = buildExclusiveActivationArmPatch({
    nowIso: "2026-11-12T20:14:00.000Z",
  });
  assertEquals(arm.scheduled_status, "awaiting_activation_accept");
  assertEquals(PHASE5_ACK_BOUNDARY.countdownSeconds, 45);
  assertEquals(PHASE5_ACK_BOUNDARY.reservedAction, "arm_ack");

  const patch = buildConfirmedActivationPatch({
    confirmedDriverId: "d1",
    nowIso: "2026-11-12T20:14:00.000Z",
    activationSource: "jit",
  });
  assertEquals(patch.scheduled_status, "driver_en_route");
  assert(
    isAlreadyConfirmedActivated({
      scheduledStatus: "driver_en_route",
      tripStatus: "en_route_to_pickup",
      driverId: "d1",
      confirmedDriverId: "d1",
    }),
  );
});

Deno.test("long distance classification at ETA ≥ 30", () => {
  assertEquals(
    classifyJitDistanceKind({
      driverToPickupEtaMinutes: 30,
      longDistanceEtaThresholdMinutes: 30,
    }).kind,
    "long",
  );
});

Deno.test("source lock: default ack NRO path; auto-activate gated", async () => {
  const src = await Deno.readTextFile(
    new URL("../scheduled-dispatch/index.ts", import.meta.url),
  );
  assert(src.includes("runConfirmedJitActivationPass"));
  assert(src.includes("jit_auto_activate_enabled"));

  const runner = await Deno.readTextFile(
    new URL("./runConfirmedJitActivationPass.ts", import.meta.url),
  );
  assert(runner.includes("arm_exclusive_nro"));
  assert(runner.includes("unavailable_rescue"));
  assert(runner.includes("SCHEDULED_JIT_ARM_EXCLUSIVE_NRO"));

  const ssot = await Deno.readTextFile(
    new URL("./scheduledJitActivationSSOT.ts", import.meta.url),
  );
  assert(ssot.includes("autoActivateEnabled: false"));
  assert(!/action: \"arm_ack\"[\s\S]*return \{[\s\S]*action: \"arm_ack\"/.test(ssot));
});
