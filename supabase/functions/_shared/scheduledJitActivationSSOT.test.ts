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
  computeJitDepartureDeadlineMs,
  decideConfirmedScheduledActivation,
  effectiveJitPlanningHorizonMinutes,
  isWithinJitPlanningHorizon,
  reconcileStickyJitDeadline,
  resolveJitExecutionMode,
  resolveScheduledJitActivationConfig,
  SCHEDULED_JIT_ACTIVATION_DEFAULTS,
  validateJitEtaMinutes,
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

Deno.test("long-distance JIT deadline is not delayed by fixed timing clamp", () => {
  // Pickup 20:30, ETA 45, early 5, long buffer 5 → required departure 19:35.
  // Old 20m pull-earlier clamp vs fixed ~20:19 would have delayed to 19:59 — forbidden.
  const pickup = Date.parse("2026-11-12T20:30:00.000Z");
  const r = computeJitDepartureDeadlineMs({
    scheduledAtMs: pickup,
    driverToPickupEtaMinutes: 45,
    config: SCHEDULED_JIT_ACTIVATION_DEFAULTS,
  });
  assertEquals(r.kind, "long");
  assertEquals(new Date(r.deadlineMs).toISOString(), "2026-11-12T19:35:00.000Z");

  const sticky = reconcileStickyJitDeadline({
    previousDeadlineMs: null,
    candidateDeadlineMs: r.deadlineMs,
    oscillationToleranceMinutes: 2,
    currentScheduledAtMs: pickup,
  });
  assertEquals(new Date(sticky.deadlineMs).toISOString(), "2026-11-12T19:35:00.000Z");
  // Must not be postponed to 19:59 (fixed − 20m clamp).
  assert(sticky.deadlineMs < Date.parse("2026-11-12T19:59:00.000Z"));
});

Deno.test("DB auto_activate cannot enable no-ack; Phase 5 defaults fail-closed to ack_nro", () => {
  assertEquals(resolveJitExecutionMode(SCHEDULED_JIT_ACTIVATION_DEFAULTS), "ack_nro");
  assertEquals(
    resolveJitExecutionMode({ autoActivateEnabled: true, departureAckEnabled: true }),
    "departure_ack",
  );
  const cfg = resolveScheduledJitActivationConfig({
    jit_auto_activate_enabled: true,
    scheduled_departure_ack_enabled: false,
  });
  assertEquals(cfg.autoActivateEnabled, false);
  assertEquals(cfg.departureAckEnabled, false);
  assertEquals(resolveJitExecutionMode(cfg), "ack_nro");
});

Deno.test("due deadline with ack_nro fallback arms exclusive NRO not activate_now", () => {
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
    availabilityClass: "available",
    executionMode: "ack_nro",
  });
  assertEquals(d.action, "arm_exclusive_nro");
  if (d.action === "arm_exclusive_nro") {
    assertEquals(d.phase5AckDeadlineAtMs, null);
  }
});

Deno.test("offline / stale at deadline still arm acknowledgement — no premature rescue", () => {
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
      availabilityClass: availability,
      executionMode: "departure_ack",
    });
    assertEquals(d.action, "arm_ack");
  }
});

Deno.test("compatible active journey defers arm — retains assignment", () => {
  const pickup = Date.parse("2026-11-12T20:30:00.000Z");
  const d = decideConfirmedScheduledActivation({
    nowMs: pickup - 40 * 60_000,
    scheduledAtMs: pickup,
    jitDeadlineMs: pickup - 45 * 60_000,
    fixedFallbackDue: false,
    fixedFallbackActivationAtMs: pickup - 11 * 60_000,
    fixedFallbackKind: "local",
    intentionallyHeld: false,
    activeJourneyThreatensCommitment: false,
    deferForCompatibleActiveJourney: true,
    availabilityClass: "on_active_journey",
    executionMode: "ack_nro",
  });
  assertEquals(d.action, "wait");
  if (d.action === "wait") {
    assertEquals(d.kind, "defer_compatible_active_journey");
  }
});

Deno.test("infeasible active journey triggers conflict rescue (safe rematch)", () => {
  const pickup = Date.parse("2026-11-12T20:30:00.000Z");
  const d = decideConfirmedScheduledActivation({
    nowMs: pickup - 20 * 60_000,
    scheduledAtMs: pickup,
    jitDeadlineMs: pickup - 25 * 60_000,
    fixedFallbackDue: false,
    fixedFallbackActivationAtMs: pickup - 11 * 60_000,
    fixedFallbackKind: "local",
    intentionallyHeld: false,
    activeJourneyThreatensCommitment: true,
    activeJourneyThreatReason: "active_journey_makes_scheduled_pickup_infeasible",
    availabilityClass: "on_active_journey",
    executionMode: "ack_nro",
  });
  assertEquals(d.action, "conflict_rescue");
});

Deno.test("ETA spike requires confirmation — does not pull sticky early on noise", () => {
  const first = validateJitEtaMinutes({
    proposedEtaMinutes: 12,
    previousEtaMinutes: null,
    haversineEtaMinutes: 10,
    consecutiveElevatedSamples: 0,
    config: SCHEDULED_JIT_ACTIVATION_DEFAULTS,
  });
  assertEquals(first.acceptedEtaMinutes, 12);

  const spike = validateJitEtaMinutes({
    proposedEtaMinutes: 120,
    previousEtaMinutes: 12,
    haversineEtaMinutes: 10,
    consecutiveElevatedSamples: 0,
    config: SCHEDULED_JIT_ACTIVATION_DEFAULTS,
  });
  assertEquals(spike.rejectedSpike, true);
  assertEquals(spike.acceptedEtaMinutes, 12);
  assertEquals(spike.consecutiveElevatedSamples, 1);

  const confirmed = validateJitEtaMinutes({
    proposedEtaMinutes: 120,
    previousEtaMinutes: 12,
    haversineEtaMinutes: 10,
    consecutiveElevatedSamples: 1,
    config: SCHEDULED_JIT_ACTIVATION_DEFAULTS,
  });
  assertEquals(confirmed.rejectedSpike, false);
  assertEquals(confirmed.acceptedEtaMinutes, 120);
});

Deno.test("pickup reschedule invalidates sticky basis", () => {
  const oldPickup = Date.parse("2026-11-12T20:30:00.000Z");
  const newPickup = Date.parse("2026-11-12T21:00:00.000Z");
  const sticky = reconcileStickyJitDeadline({
    previousDeadlineMs: oldPickup - 16 * 60_000,
    candidateDeadlineMs: newPickup - 16 * 60_000,
    oscillationToleranceMinutes: 2,
    basisScheduledAtMs: oldPickup,
    currentScheduledAtMs: newPickup,
  });
  assertEquals(sticky.reason, "basis_reset");
});

Deno.test("planning horizon expands so distant ETA is not concealed by 90m floor", () => {
  // ETA 100 → JIT deadline ≈ T-110 (100+5+5). Base 90m horizon would open too late.
  const horizon = effectiveJitPlanningHorizonMinutes({
    config: {
      ...SCHEDULED_JIT_ACTIVATION_DEFAULTS,
      planningHorizonMinutes: 90,
    },
    lastKnownEtaMinutes: 100,
    fixedLongActivationMinutes: 45,
  });
  assert(horizon >= 100 + 5 + 5 + 30); // ≥140
  assert(horizon > 90);

  const pickup = Date.parse("2026-11-12T20:30:00.000Z");
  assertEquals(
    isWithinJitPlanningHorizon({
      nowMs: pickup - 100 * 60_000,
      scheduledAtMs: pickup,
      planningHorizonMinutes: 90,
    }),
    false,
  );
  assertEquals(
    isWithinJitPlanningHorizon({
      nowMs: pickup - 100 * 60_000,
      scheduledAtMs: pickup,
      planningHorizonMinutes: horizon,
    }),
    true,
  );
});

Deno.test("haversine fallback is estimate (conservative) not guaranteed upper bound", () => {
  const eta = estimateEtaMinutes(52.04, -0.76, 52.049, -0.76);
  assert(eta != null && eta >= 3);
  assert(eta! >= 4);
  // Documented contract: estimate only — callers must not treat as max road time.
  const src = Deno.readTextFileSync(
    new URL("./scheduledDispatchConfig.ts", import.meta.url),
  );
  assert(src.includes("not a guaranteed upper bound"));
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
  const ok = evaluateScheduledCommitmentFeasibility({
    nowMs: Date.parse("2026-11-12T19:30:00.000Z"),
    remainingJourneyMinutes: 20,
    travelToPickupEtaMinutes: 10,
    scheduledAtMs: pickup,
    config: SCHEDULED_JIT_ACTIVATION_DEFAULTS,
  });
  assertEquals(ok.feasible, true);
  assertEquals(
    activeJourneyThreatensScheduledCommitment({
      hasActiveJourney: true,
      feasibility: ok,
    }).threatens,
    false,
  );
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

Deno.test("source lock: Phase 5 departure_ack; auto-activate fail-closed; no activate_now", async () => {
  const src = await Deno.readTextFile(
    new URL("../scheduled-dispatch/index.ts", import.meta.url),
  );
  assert(src.includes("runConfirmedJitActivationPass"));
  assert(src.includes("jit_auto_activate_enabled"));

  const runner = await Deno.readTextFile(
    new URL("./runConfirmedJitActivationPass.ts", import.meta.url),
  );
  assert(runner.includes("SCHEDULED_JIT_ARM_DEPARTURE_ACK"));
  assert(runner.includes("deferForCompatibleActiveJourney"));
  assert(runner.includes("Phase 5 fail-closed"));
  // Must not stamp en_route in runner (activate_now unreachable).
  assert(!runner.includes("buildConfirmedActivationPatch"));

  const ssot = await Deno.readTextFile(
    new URL("./scheduledJitActivationSSOT.ts", import.meta.url),
  );
  assert(ssot.includes("autoActivateEnabled: false"));
  assert(ssot.includes("departureAckEnabled: false"));
  assert(ssot.includes('return "departure_ack"'));
  assert(!/return \{\s*action: \"activate_now\"/.test(ssot));
  assert(!ssot.includes("clampJitDeadlineToFixedFloor"));
});
