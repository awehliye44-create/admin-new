/**
 * Bug #29 — JIT ETA accuracy lock (MK-261115-002).
 *
 * Google road ETA must win over conservative haversine. Never label haversine
 * as route_fresh. Sticky earlier deadlines must not auto-postpone.
 */
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildJitEtaSourceAttribution,
  computeJitDepartureDeadlineMs,
  decideConfirmedScheduledActivation,
  reconcileStickyJitDeadline,
  SCHEDULED_JIT_ACTIVATION_DEFAULTS,
  validateJitEtaMinutes,
} from "../../functions/_shared/scheduledJitActivationSSOT.ts";
import { resolvePickupAwareJitDeadline } from "../../functions/scheduled-dispatch/lib/scheduledJitPickupAwareFallbackSSOT.ts";
import { estimateEtaMinutes } from "../../functions/_shared/scheduledDispatchConfig.ts";

Deno.test("Bug #29 MK-261115-002 replay: Google 15 / haversine 53 → selected 15", () => {
  const road = 15;
  const hav = 53; // estimateEtaMinutes at 20 km/h × 1.45 for ~12 km chord
  assert(road < hav * 0.7, "precondition: would have triggered the old override");

  const validated = validateJitEtaMinutes({
    proposedEtaMinutes: road,
    previousEtaMinutes: null,
    haversineEtaMinutes: hav,
    consecutiveElevatedSamples: 0,
    config: SCHEDULED_JIT_ACTIVATION_DEFAULTS,
  });
  assertEquals(validated.acceptedEtaMinutes, 15);
  assertEquals(validated.haversineOverrideApplied, false);
  assertEquals(validated.rejectedInvalid, false);
  assertEquals(validated.rejectedSpike, false);

  const pickup = Date.parse("2026-11-15T20:30:00.000Z");
  const aware = resolvePickupAwareJitDeadline({
    nowMs: Date.parse("2026-11-15T20:23:41.000Z"),
    scheduledAtMs: pickup,
    jitConfig: SCHEDULED_JIT_ACTIVATION_DEFAULTS,
    freshRouteEtaMinutes: validated.acceptedEtaMinutes,
    previousDeadlineMs: Date.parse("2026-11-15T18:24:00.000Z"),
  });
  assertEquals(aware.tier, "route_fresh");
  assertEquals(aware.etaMinutes, 15);
  // Sticky earlier 18:24 must not postpone when candidate is later.
  assertEquals(
    aware.deadlineMs,
    Date.parse("2026-11-15T18:24:00.000Z"),
  );
});

Deno.test("Bug #29: valid motorway-class road ETA below haversine is kept", () => {
  // ~40 km N-S chord. After MK-261116-009 distance-banded speeds, haversine is
  // ~64 min (not the old flat-20km/h ~174). Motorway road ETA 45 must still win.
  const hav = estimateEtaMinutes(52.0, -0.8, 52.36, -0.8);
  assert(hav != null && hav > 45 && hav < 100);
  const validated = validateJitEtaMinutes({
    proposedEtaMinutes: 45,
    previousEtaMinutes: 48,
    haversineEtaMinutes: hav,
    consecutiveElevatedSamples: 0,
    config: SCHEDULED_JIT_ACTIVATION_DEFAULTS,
  });
  assertEquals(validated.acceptedEtaMinutes, 45);
  assertEquals(validated.haversineOverrideApplied, false);
});

Deno.test("Bug #29: rural dual-carriageway road ETA below haversine is kept", () => {
  const validated = validateJitEtaMinutes({
    proposedEtaMinutes: 22,
    previousEtaMinutes: 25,
    haversineEtaMinutes: 40,
    consecutiveElevatedSamples: 0,
    config: SCHEDULED_JIT_ACTIVATION_DEFAULTS,
  });
  assertEquals(validated.acceptedEtaMinutes, 22);
});

Deno.test("Bug #29: invalid / absurd road ETA rejected", () => {
  const bad = validateJitEtaMinutes({
    proposedEtaMinutes: Number.NaN,
    previousEtaMinutes: 20,
    haversineEtaMinutes: 30,
    consecutiveElevatedSamples: 0,
    config: SCHEDULED_JIT_ACTIVATION_DEFAULTS,
  });
  assertEquals(bad.rejectedInvalid, true);
  assertEquals(bad.acceptedEtaMinutes, 20);

  const zero = validateJitEtaMinutes({
    proposedEtaMinutes: -5,
    previousEtaMinutes: null,
    haversineEtaMinutes: 10,
    consecutiveElevatedSamples: 0,
    config: SCHEDULED_JIT_ACTIVATION_DEFAULTS,
  });
  assertEquals(zero.rejectedInvalid, true);

  const absurd = validateJitEtaMinutes({
    proposedEtaMinutes: 9999,
    previousEtaMinutes: 30,
    haversineEtaMinutes: 40,
    consecutiveElevatedSamples: 0,
    config: SCHEDULED_JIT_ACTIVATION_DEFAULTS,
  });
  assertEquals(absurd.rejectedInvalid, true);
  assertEquals(absurd.acceptedEtaMinutes, 30);
});

Deno.test("Bug #29: ETA attribution never claims route_fresh for haversine", () => {
  const attr = buildJitEtaSourceAttribution({
    tierReason: "last_known_conservative:degraded",
    roadEtaMinutes: 53,
    selectedEtaMinutes: 53,
    haversineEtaMinutes: 53,
    roadSource: "haversine_fallback",
    gpsFresh: true,
    gpsAgeSeconds: 12,
    routeAgeSeconds: null,
    originDriftMeters: null,
    fallbackReason: "routing_failed_haversine",
  });
  assert(!attr.includes("route_fresh"), attr);
  assert(attr.includes("road_src=haversine_fallback"));
  assert(attr.includes("hav=53"));
});

Deno.test("Bug #29: sticky earlier deadline preserved (no auto-postpone)", () => {
  const pickup = Date.parse("2026-11-15T20:30:00.000Z");
  const stickyEarlier = Date.parse("2026-11-15T18:24:00.000Z");
  const laterCandidate = computeJitDepartureDeadlineMs({
    scheduledAtMs: pickup,
    driverToPickupEtaMinutes: 15,
    config: SCHEDULED_JIT_ACTIVATION_DEFAULTS,
  });
  // 15+5+buffer → candidate after 18:24
  assert(laterCandidate.deadlineMs > stickyEarlier);

  const sticky = reconcileStickyJitDeadline({
    previousDeadlineMs: stickyEarlier,
    candidateDeadlineMs: laterCandidate.deadlineMs,
    oscillationToleranceMinutes:
      SCHEDULED_JIT_ACTIVATION_DEFAULTS.oscillationToleranceMinutes,
    currentScheduledAtMs: pickup,
  });
  assertEquals(sticky.deadlineMs, stickyEarlier);
  // reconcileStickyJitDeadline reasons: initial | pulled_earlier | unchanged | basis_reset
  assertEquals(sticky.reason, "unchanged");
});

Deno.test("Bug #29 MK-261116-005 sticky: ETA 30 must not postpone a 19:38 stamp", () => {
  // Production stamp stayed 19:38 (≈ ETA 42 long-buffer formula) while a fresh
  // Google 30-min route would compute 19:50. Sticky must keep the earlier time.
  const pickup = Date.parse("2026-11-16T20:30:00.000Z");
  const sticky1938 = Date.parse("2026-11-16T19:38:00.000Z");
  const fresh30 = computeJitDepartureDeadlineMs({
    scheduledAtMs: pickup,
    driverToPickupEtaMinutes: 30,
    config: SCHEDULED_JIT_ACTIVATION_DEFAULTS,
  });
  assertEquals(fresh30.deadlineMs, Date.parse("2026-11-16T19:50:00.000Z"));
  assert(fresh30.deadlineMs > sticky1938);

  const sticky = reconcileStickyJitDeadline({
    previousDeadlineMs: sticky1938,
    candidateDeadlineMs: fresh30.deadlineMs,
    oscillationToleranceMinutes:
      SCHEDULED_JIT_ACTIVATION_DEFAULTS.oscillationToleranceMinutes,
    currentScheduledAtMs: pickup,
  });
  assertEquals(sticky.deadlineMs, sticky1938);
  assertEquals(sticky.reason, "unchanged");
});

Deno.test("Bug #29: due activation + 45s ack mode still arms", () => {
  const pickup = Date.parse("2026-11-15T20:30:00.000Z");
  const deadline = Date.parse("2026-11-15T18:24:00.000Z");
  const nowMs = Date.parse("2026-11-15T20:23:41.000Z");
  const d = decideConfirmedScheduledActivation({
    nowMs,
    scheduledAtMs: pickup,
    jitDeadlineMs: deadline,
    fixedFallbackDue: false,
    fixedFallbackActivationAtMs: pickup - 11 * 60_000,
    fixedFallbackKind: "local",
    intentionallyHeld: false,
    activeJourneyThreatensCommitment: false,
    availabilityClass: "available",
    executionMode: "departure_ack",
    departureAckCountdownSeconds: 45,
  });
  assertEquals(d.action, "arm_ack");
  if (d.action === "arm_ack") {
    assertEquals(d.phase5AckDeadlineAtMs! - nowMs, 45_000);
  }
});

Deno.test("Bug #29: compatible active journey defers arm", () => {
  const pickup = Date.parse("2026-11-15T20:30:00.000Z");
  const deadline = Date.parse("2026-11-15T18:24:00.000Z");
  const d = decideConfirmedScheduledActivation({
    nowMs: Date.parse("2026-11-15T20:23:41.000Z"),
    scheduledAtMs: pickup,
    jitDeadlineMs: deadline,
    fixedFallbackDue: false,
    fixedFallbackActivationAtMs: pickup - 11 * 60_000,
    fixedFallbackKind: "local",
    intentionallyHeld: false,
    activeJourneyThreatensCommitment: false,
    deferForCompatibleActiveJourney: true,
    availabilityClass: "on_active_journey",
    executionMode: "departure_ack",
    departureAckCountdownSeconds: 45,
  });
  assert(
    d.action === "wait" || d.action === "hold_skip",
    `expected defer, got ${d.action}`,
  );
});

Deno.test("Bug #29: lock forbids haversine floor override in SSOT source", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/_shared/scheduledJitActivationSSOT.ts", import.meta.url),
  );
  assert(
    !/proposed\s*<\s*hav\s*\*\s*0\.7/.test(src),
    "haversine 70% floor override must remain deleted",
  );
  assert(src.includes("haversineOverrideApplied: false"));
  assert(src.includes("buildJitEtaSourceAttribution"));
});
