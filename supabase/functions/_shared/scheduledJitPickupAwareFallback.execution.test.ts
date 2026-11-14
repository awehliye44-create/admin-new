/**
 * MK-261114-002 — pickup-aware JIT fallback + freshness execution regressions.
 * Run:
 *   deno test --no-check --allow-read \
 *     supabase/functions/_shared/scheduledJitPickupAwareFallback.execution.test.ts \
 *     supabase/functions/_shared/scheduledJitActivationSSOT.test.ts \
 *     supabase/functions/_shared/scheduledJitStickyDeadline.execution.test.ts
 */
import {
  assertEquals,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  computeJitDepartureDeadlineMs,
  decideConfirmedScheduledActivation,
  reconcileStickyJitDeadline,
  resolveReusableStickyJitDeadlineMs,
  SCHEDULED_JIT_ACTIVATION_DEFAULTS,
} from "./scheduledJitActivationSSOT.ts";
import { evaluateJitDriverLocationFreshness } from "./scheduledJitEtaMonitorSSOT.ts";
import {
  applyLastKnownUncertaintyMinutes,
  computeDegradedUnknownEtaMinutes,
  evaluateJitLateRisk,
  resolvePickupAwareJitDeadline,
  shouldEscalateScheduledLocationReadiness,
  SCHEDULED_JIT_FALLBACK_DEFAULTS,
} from "./scheduledJitPickupAwareFallbackSSOT.ts";

const DRIVER = "56136f5f-1a3a-4a14-bb23-439b3951415a";
const OTHER = "other-driver";
const PICKUP = Date.parse("2026-11-14T20:30:00.000Z");
const TARGET = PICKUP - 5 * 60_000; // 20:25
const FIXED_LONG = PICKUP - 30 * 60_000; // 20:00 — forbidden silent assume

Deno.test("INCIDENT MK-261114-002: ETA 34 + long buffer 5 → activate 19:46", () => {
  const r = computeJitDepartureDeadlineMs({
    scheduledAtMs: PICKUP,
    driverToPickupEtaMinutes: 34,
    config: SCHEDULED_JIT_ACTIVATION_DEFAULTS,
  });
  assertEquals(r.kind, "long");
  assertEquals(r.safetyBufferMinutes, 5);
  assertEquals(r.earlyArrivalMinutes, 5);
  assertEquals(new Date(r.deadlineMs).toISOString(), "2026-11-14T19:46:00.000Z");
  assert(r.deadlineMs < FIXED_LONG);

  const aware = resolvePickupAwareJitDeadline({
    nowMs: Date.parse("2026-11-14T18:00:00.000Z"),
    scheduledAtMs: PICKUP,
    jitConfig: SCHEDULED_JIT_ACTIVATION_DEFAULTS,
    freshRouteEtaMinutes: 34,
    evaluatingConfirmedDriverId: DRIVER,
    tripConfirmedDriverId: DRIVER,
  });
  assertEquals(aware.tier, "route_fresh");
  assertEquals(new Date(aware.deadlineMs).toISOString(), "2026-11-14T19:46:00.000Z");
});

Deno.test("1. local pickup ETA uses 3-minute buffer", () => {
  const r = computeJitDepartureDeadlineMs({
    scheduledAtMs: PICKUP,
    driverToPickupEtaMinutes: 8,
    config: SCHEDULED_JIT_ACTIVATION_DEFAULTS,
  });
  assertEquals(r.kind, "local");
  assertEquals(r.safetyBufferMinutes, 3);
  // 20:30 - 5 - 8 - 3 = 20:14
  assertEquals(new Date(r.deadlineMs).toISOString(), "2026-11-14T20:14:00.000Z");
});

Deno.test("2. long pickup ETA uses 5-minute buffer", () => {
  const r = computeJitDepartureDeadlineMs({
    scheduledAtMs: PICKUP,
    driverToPickupEtaMinutes: 40,
    config: SCHEDULED_JIT_ACTIVATION_DEFAULTS,
  });
  assertEquals(r.kind, "long");
  assertEquals(r.safetyBufferMinutes, 5);
});

Deno.test("3. short passenger journey but long driver pickup → long JIT", () => {
  // Passenger booked 12 min trip; driver is 40 min away — classify on pickup ETA.
  const r = computeJitDepartureDeadlineMs({
    scheduledAtMs: PICKUP,
    driverToPickupEtaMinutes: 40,
    config: SCHEDULED_JIT_ACTIVATION_DEFAULTS,
  });
  assertEquals(r.kind, "long");
  assert(r.deadlineMs < PICKUP - 12 * 60_000);
});

Deno.test("4. long passenger journey but short driver pickup → local JIT", () => {
  const r = computeJitDepartureDeadlineMs({
    scheduledAtMs: PICKUP,
    driverToPickupEtaMinutes: 10,
    config: SCHEDULED_JIT_ACTIVATION_DEFAULTS,
  });
  assertEquals(r.kind, "local");
  assertEquals(r.safetyBufferMinutes, 3);
});

Deno.test("5. fresh GPS + successful road ETA → route_fresh tier", () => {
  const now = Date.parse("2026-11-14T19:00:00.000Z");
  const fresh = evaluateJitDriverLocationFreshness({
    lat: 51.99,
    lng: -0.80,
    gpsSampleAtMs: now - 20_000,
    heartbeatAtMs: now - 5_000,
    nowMs: now,
    presenceMaxAgeSeconds: 60,
  });
  assertEquals(fresh.fresh, true);
  assertEquals(fresh.reason, "ok");
  assertEquals(fresh.usableLastKnown, true);

  const aware = resolvePickupAwareJitDeadline({
    nowMs: now,
    scheduledAtMs: PICKUP,
    jitConfig: SCHEDULED_JIT_ACTIVATION_DEFAULTS,
    freshRouteEtaMinutes: 20,
    evaluatingConfirmedDriverId: DRIVER,
    tripConfirmedDriverId: DRIVER,
  });
  assertEquals(aware.tier, "route_fresh");
});

Deno.test("6. temporary stale GPS after valid sticky → sticky reused", () => {
  const stamped = Date.parse("2026-11-14T19:46:00.000Z");
  const now = Date.parse("2026-11-14T19:50:00.000Z");
  const fresh = evaluateJitDriverLocationFreshness({
    lat: 51.99,
    lng: -0.80,
    gpsSampleAtMs: now - 180_000, // 3m old GPS
    heartbeatAtMs: now - 5_000, // heartbeat fresh — must NOT make GPS fresh
    nowMs: now,
    presenceMaxAgeSeconds: 60,
  });
  assertEquals(fresh.fresh, false);
  assertEquals(fresh.reason, "stale_gps");
  assertEquals(fresh.usableLastKnown, true);

  const aware = resolvePickupAwareJitDeadline({
    nowMs: now,
    scheduledAtMs: PICKUP,
    jitConfig: SCHEDULED_JIT_ACTIVATION_DEFAULTS,
    stickyActivateAtIso: new Date(stamped).toISOString(),
    stickyBasisScheduledAtIso: new Date(PICKUP).toISOString(),
    evaluatingConfirmedDriverId: DRIVER,
    tripConfirmedDriverId: DRIVER,
  });
  assertEquals(aware.tier, "sticky");
  assertEquals(aware.deadlineMs, stamped);
});

Deno.test("7. routing failure after valid sticky → sticky reused (not fixed T-30)", () => {
  const stamped = Date.parse("2026-11-14T19:40:00.000Z");
  const aware = resolvePickupAwareJitDeadline({
    nowMs: Date.parse("2026-11-14T19:55:00.000Z"),
    scheduledAtMs: PICKUP,
    jitConfig: SCHEDULED_JIT_ACTIVATION_DEFAULTS,
    stickyActivateAtIso: new Date(stamped).toISOString(),
    stickyBasisScheduledAtIso: new Date(PICKUP).toISOString(),
    evaluatingConfirmedDriverId: DRIVER,
    tripConfirmedDriverId: DRIVER,
  });
  assertEquals(aware.tier, "sticky");
  assertEquals(aware.deadlineMs, stamped);
  assert(aware.deadlineMs < FIXED_LONG);
});

Deno.test("8. missing route cache falls through to last-known or degraded", () => {
  const now = Date.parse("2026-11-14T19:00:00.000Z");
  const aware = resolvePickupAwareJitDeadline({
    nowMs: now,
    scheduledAtMs: PICKUP,
    jitConfig: SCHEDULED_JIT_ACTIVATION_DEFAULTS,
    recentRoute: null,
    lastKnown: {
      lat: 51.99,
      lng: -0.80,
      gpsMeasuredAtMs: now - 10 * 60_000,
      conservativeEtaMinutes: applyLastKnownUncertaintyMinutes(34),
    },
    evaluatingConfirmedDriverId: DRIVER,
    tripConfirmedDriverId: DRIVER,
  });
  assertEquals(aware.tier, "last_known_conservative");
  assert(aware.deadlineMs <= Date.parse("2026-11-14T19:46:00.000Z"));
});

Deno.test("9. no valid ETA throughout monitoring → degraded_unknown earlier than T-30", () => {
  const now = Date.parse("2026-11-14T18:00:00.000Z");
  const aware = resolvePickupAwareJitDeadline({
    nowMs: now,
    scheduledAtMs: PICKUP,
    jitConfig: SCHEDULED_JIT_ACTIVATION_DEFAULTS,
    evaluatingConfirmedDriverId: DRIVER,
    tripConfirmedDriverId: DRIVER,
  });
  assertEquals(aware.tier, "degraded_unknown");
  assert(aware.deadlineMs < FIXED_LONG);
  const assumed = computeDegradedUnknownEtaMinutes(SCHEDULED_JIT_ACTIVATION_DEFAULTS);
  assertEquals(assumed, 30 + 15);
});

Deno.test("10. stale GPS before initial ETA — heartbeat cannot fake freshness", () => {
  const now = Date.parse("2026-11-14T19:59:00.000Z");
  const fresh = evaluateJitDriverLocationFreshness({
    lat: 51.99,
    lng: -0.80,
    gpsSampleAtMs: now - 120_000,
    heartbeatAtMs: now - 1_000,
    nowMs: now,
    presenceMaxAgeSeconds: 60,
  });
  assertEquals(fresh.fresh, false);
  assertEquals(fresh.reason, "stale_gps");
  assert(fresh.heartbeatAgeSeconds != null && fresh.heartbeatAgeSeconds < 60);
});

Deno.test("11. location recovery before departure deadline → route_fresh wins", () => {
  const stamped = Date.parse("2026-11-14T19:50:00.000Z");
  const recovered = resolvePickupAwareJitDeadline({
    nowMs: Date.parse("2026-11-14T19:20:00.000Z"),
    scheduledAtMs: PICKUP,
    jitConfig: SCHEDULED_JIT_ACTIVATION_DEFAULTS,
    freshRouteEtaMinutes: 34,
    stickyActivateAtIso: new Date(stamped).toISOString(),
    stickyBasisScheduledAtIso: new Date(PICKUP).toISOString(),
    previousDeadlineMs: stamped,
    evaluatingConfirmedDriverId: DRIVER,
    tripConfirmedDriverId: DRIVER,
  });
  // Fresh ETA 34 → 19:46 earlier than sticky 19:50 → pull earlier
  assertEquals(recovered.tier, "route_fresh");
  assertEquals(new Date(recovered.deadlineMs).toISOString(), "2026-11-14T19:46:00.000Z");
});

Deno.test("12. driver movement increasing pickup ETA pulls sticky earlier", () => {
  const prev = Date.parse("2026-11-14T19:50:00.000Z");
  const next = computeJitDepartureDeadlineMs({
    scheduledAtMs: PICKUP,
    driverToPickupEtaMinutes: 40,
    config: SCHEDULED_JIT_ACTIVATION_DEFAULTS,
  });
  const sticky = reconcileStickyJitDeadline({
    previousDeadlineMs: prev,
    candidateDeadlineMs: next.deadlineMs,
    oscillationToleranceMinutes: 2,
    currentScheduledAtMs: PICKUP,
  });
  assertEquals(sticky.reason, "pulled_earlier");
  assert(sticky.deadlineMs < prev);
});

Deno.test("13. earlier deadline recalculation applied", () => {
  const aware = resolvePickupAwareJitDeadline({
    nowMs: Date.parse("2026-11-14T18:30:00.000Z"),
    scheduledAtMs: PICKUP,
    jitConfig: SCHEDULED_JIT_ACTIVATION_DEFAULTS,
    freshRouteEtaMinutes: 50,
    previousDeadlineMs: Date.parse("2026-11-14T19:46:00.000Z"),
    evaluatingConfirmedDriverId: DRIVER,
    tripConfirmedDriverId: DRIVER,
  });
  assert(aware.deadlineMs < Date.parse("2026-11-14T19:46:00.000Z"));
});

Deno.test("14. improved ETA does not postpone committed sticky deadline", () => {
  const committed = Date.parse("2026-11-14T19:46:00.000Z");
  const improved = computeJitDepartureDeadlineMs({
    scheduledAtMs: PICKUP,
    driverToPickupEtaMinutes: 10, // much better
    config: SCHEDULED_JIT_ACTIVATION_DEFAULTS,
  });
  assert(improved.deadlineMs > committed);
  const sticky = reconcileStickyJitDeadline({
    previousDeadlineMs: committed,
    candidateDeadlineMs: improved.deadlineMs,
    oscillationToleranceMinutes: 2,
    currentScheduledAtMs: PICKUP,
  });
  assertEquals(sticky.reason, "unchanged");
  assertEquals(sticky.deadlineMs, committed);
});

Deno.test("15. confirmed driver reassignment invalidates old sticky", () => {
  const reused = resolveReusableStickyJitDeadlineMs({
    activateAtIso: new Date(Date.parse("2026-11-14T19:46:00.000Z")).toISOString(),
    basisScheduledAtIso: new Date(PICKUP).toISOString(),
    currentScheduledAtIso: new Date(PICKUP).toISOString(),
    evaluatingConfirmedDriverId: OTHER,
    tripConfirmedDriverId: DRIVER,
  });
  assertEquals(reused.deadlineMs, null);
  assertEquals(reused.reason, "driver_mismatch_or_unassigned");
});

Deno.test("16. driver on active trip — decision defers arm when compatible", () => {
  const d = decideConfirmedScheduledActivation({
    nowMs: Date.parse("2026-11-14T19:46:00.000Z"),
    scheduledAtMs: PICKUP,
    jitDeadlineMs: Date.parse("2026-11-14T19:46:00.000Z"),
    fixedFallbackDue: false,
    fixedFallbackActivationAtMs: FIXED_LONG,
    fixedFallbackKind: "long",
    intentionallyHeld: false,
    activeJourneyThreatensCommitment: false,
    deferForCompatibleActiveJourney: true,
    availabilityClass: "on_active_journey",
    executionMode: "departure_ack",
    departureAckCountdownSeconds: 45,
  });
  assertEquals(d.action, "wait");
});

Deno.test("17. multiple scheduled commitments — sticky ownership is per trip+driver", () => {
  const a = resolveReusableStickyJitDeadlineMs({
    activateAtIso: "2026-11-14T19:46:00.000Z",
    basisScheduledAtIso: "2026-11-14T20:30:00.000Z",
    currentScheduledAtIso: "2026-11-14T20:30:00.000Z",
    evaluatingConfirmedDriverId: DRIVER,
    tripConfirmedDriverId: DRIVER,
  });
  const b = resolveReusableStickyJitDeadlineMs({
    activateAtIso: "2026-11-14T19:46:00.000Z",
    basisScheduledAtIso: "2026-11-14T21:00:00.000Z", // different commitment
    currentScheduledAtIso: "2026-11-14T21:00:00.000Z",
    evaluatingConfirmedDriverId: DRIVER,
    tripConfirmedDriverId: DRIVER,
  });
  assertEquals(a.reason, "sticky_reused");
  // basis matches current for each independently
  assertEquals(b.reason, "sticky_reused");
});

Deno.test("18. driver offline/stale still arms when deadline due (Phase 5)", () => {
  const d = decideConfirmedScheduledActivation({
    nowMs: Date.parse("2026-11-14T19:46:00.000Z"),
    scheduledAtMs: PICKUP,
    jitDeadlineMs: Date.parse("2026-11-14T19:46:00.000Z"),
    fixedFallbackDue: false,
    fixedFallbackActivationAtMs: FIXED_LONG,
    fixedFallbackKind: "long",
    intentionallyHeld: false,
    activeJourneyThreatensCommitment: false,
    availabilityClass: "offline",
    executionMode: "departure_ack",
    departureAckCountdownSeconds: 45,
  });
  assertEquals(d.action, "arm_ack");
});

Deno.test("19. location readiness escalation is silent (no Heading)", () => {
  const escalate = shouldEscalateScheduledLocationReadiness({
    nowMs: Date.parse("2026-11-14T18:50:00.000Z"),
    degradedDeadlineMs: Date.parse("2026-11-14T19:35:00.000Z"),
    hasStickyDeadline: false,
    gpsFreshForRouting: false,
    leadMinutes: 45,
  });
  assertEquals(escalate, true);
  const noEscalateWithSticky = shouldEscalateScheduledLocationReadiness({
    nowMs: Date.parse("2026-11-14T18:50:00.000Z"),
    degradedDeadlineMs: Date.parse("2026-11-14T19:35:00.000Z"),
    hasStickyDeadline: true,
    gpsFreshForRouting: false,
  });
  assertEquals(noEscalateWithSticky, false);
});

Deno.test("20. Phase 5 acknowledgement 45s window preserved", () => {
  const now = Date.parse("2026-11-14T19:46:00.000Z");
  const d = decideConfirmedScheduledActivation({
    nowMs: now,
    scheduledAtMs: PICKUP,
    jitDeadlineMs: now,
    fixedFallbackDue: false,
    fixedFallbackActivationAtMs: FIXED_LONG,
    fixedFallbackKind: "long",
    intentionallyHeld: false,
    activeJourneyThreatensCommitment: false,
    availabilityClass: "available",
    executionMode: "departure_ack",
    departureAckCountdownSeconds: 45,
  });
  assertEquals(d.action, "arm_ack");
  if (d.action === "arm_ack") {
    assertEquals(d.phase5AckDeadlineAtMs, now + 45_000);
    assertEquals(d.countdownSeconds, 45);
  }
});

Deno.test("21. payment gate / fixed fallback not selected when pickup-aware present", () => {
  const d = decideConfirmedScheduledActivation({
    nowMs: FIXED_LONG,
    scheduledAtMs: PICKUP,
    jitDeadlineMs: Date.parse("2026-11-14T19:46:00.000Z"),
    fixedFallbackDue: true, // would have won pre-hardening
    fixedFallbackActivationAtMs: FIXED_LONG,
    fixedFallbackKind: "long",
    intentionallyHeld: false,
    activeJourneyThreatensCommitment: false,
    availabilityClass: "available",
    executionMode: "departure_ack",
    departureAckCountdownSeconds: 45,
  });
  assertEquals(d.action, "arm_ack");
  if (d.action === "arm_ack") {
    assertEquals(d.source, "jit");
    assertEquals(d.deadlineMs, Date.parse("2026-11-14T19:46:00.000Z"));
  }
});

Deno.test("22. five-minute early arrival target encoded in late-risk", () => {
  const late = evaluateJitLateRisk({
    nowMs: Date.parse("2026-11-14T20:00:00.000Z"),
    scheduledAtMs: PICKUP,
    targetEarlyArrivalMinutes: 5,
    etaMinutes: 34,
  });
  assertEquals(late.targetArrivalMs, TARGET);
  assertEquals(late.predictedArrivalMs, Date.parse("2026-11-14T20:34:00.000Z"));
  assertEquals(late.lateVsTargetMinutes, 9);
  assertEquals(late.cannotMeetTarget, true);
});

Deno.test("23. late-risk arms now when target already missed", () => {
  const now = Date.parse("2026-11-14T20:00:00.000Z");
  const aware = resolvePickupAwareJitDeadline({
    nowMs: now,
    scheduledAtMs: PICKUP,
    jitConfig: SCHEDULED_JIT_ACTIVATION_DEFAULTS,
    freshRouteEtaMinutes: 34,
    evaluatingConfirmedDriverId: DRIVER,
    tripConfirmedDriverId: DRIVER,
  });
  assertEquals(aware.lateRisk.cannotMeetTarget, true);
  // Deadline is already past (19:46) or clamped to now — either is due immediately.
  assert(aware.deadlineMs <= now);
  assert(aware.reason.includes("late_risk_arm_now"));
});

Deno.test("24. recent route age/drift guards reject untrustworthy cache", () => {
  const now = Date.parse("2026-11-14T19:00:00.000Z");
  const tooOld = resolvePickupAwareJitDeadline({
    nowMs: now,
    scheduledAtMs: PICKUP,
    jitConfig: SCHEDULED_JIT_ACTIVATION_DEFAULTS,
    recentRoute: {
      durationMin: 34,
      cachedAtMs: now - 60 * 60_000, // 1h old > 15m
      originLat: 51.99,
      originLng: -0.80,
      confirmedDriverId: DRIVER,
    },
    currentDriverLat: 51.99,
    currentDriverLng: -0.80,
    evaluatingConfirmedDriverId: DRIVER,
    tripConfirmedDriverId: DRIVER,
  });
  assertEquals(tooOld.tier, "degraded_unknown");

  const ok = resolvePickupAwareJitDeadline({
    nowMs: now,
    scheduledAtMs: PICKUP,
    jitConfig: SCHEDULED_JIT_ACTIVATION_DEFAULTS,
    recentRoute: {
      durationMin: 34,
      cachedAtMs: now - 5 * 60_000,
      originLat: 51.99,
      originLng: -0.80,
      confirmedDriverId: DRIVER,
    },
    currentDriverLat: 51.99,
    currentDriverLng: -0.80,
    evaluatingConfirmedDriverId: DRIVER,
    tripConfirmedDriverId: DRIVER,
  });
  assertEquals(ok.tier, "route_recent");
  assertEquals(new Date(ok.deadlineMs).toISOString(), "2026-11-14T19:46:00.000Z");
});

Deno.test("source lock: pass suppresses fixed fallback and uses pickup-aware hierarchy", async () => {
  const pass = await Deno.readTextFile(
    new URL("./runConfirmedJitActivationPass.ts", import.meta.url),
  );
  assert(pass.includes("resolvePickupAwareJitDeadline"));
  assert(pass.includes("fixedFallbackDue: false"));
  assert(pass.includes("SCHEDULED_JIT_LOCATION_READINESS"));
  assert(pass.includes("buildJitLateRiskOpsAlert"));
  assert(pass.includes("last_gps_sample_at"));
  const etaMon = await Deno.readTextFile(
    new URL("./scheduledJitEtaMonitorSSOT.ts", import.meta.url),
  );
  assert(etaMon.includes("stale_gps"));
  assert(etaMon.includes("usableLastKnown"));
  assert(!etaMon.includes("using fixed activation fallback"));
});

Deno.test("fallback defaults expose hierarchy constants", () => {
  assertEquals(SCHEDULED_JIT_FALLBACK_DEFAULTS.recentRouteMaxAgeSeconds, 15 * 60);
  assertEquals(SCHEDULED_JIT_FALLBACK_DEFAULTS.lastKnownMaxAgeSeconds, 45 * 60);
  assertEquals(SCHEDULED_JIT_FALLBACK_DEFAULTS.unknownEtaSlackMinutes, 15);
});
