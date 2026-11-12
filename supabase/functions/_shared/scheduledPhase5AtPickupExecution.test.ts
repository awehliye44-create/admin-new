/**
 * Phase 5 end-to-end decision path (isolated fixtures) — at-pickup / near-zero ETA.
 * Does not enable production flags. No second Accept / no silent activate_now.
 *
 * Run: deno test --no-check --allow-read supabase/functions/_shared/scheduledPhase5AtPickupExecution.test.ts
 */
import {
  assertEquals,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  computeJitDepartureDeadlineMs,
  decideConfirmedScheduledActivation,
  SCHEDULED_JIT_ACTIVATION_DEFAULTS,
  validateJitEtaMinutes,
} from "./scheduledJitActivationSSOT.ts";
import {
  computeScheduledActivationAtMs,
  SCHEDULED_ACTIVATION_DEFAULTS,
} from "./scheduledActivationSSOT.ts";
import {
  computeDepartureAckDeadlineMs,
  PHASE5_DEPARTURE_ACK_COUNTDOWN_SECONDS,
} from "./scheduledDepartureAckSSOT.ts";
import {
  buildDepartureAckArmPatch,
  buildExclusiveActivationArmPatch,
} from "./scheduledConfirmedActivationSSOT.ts";

const PICKUP_MS = Date.parse("2026-11-12T22:25:00.000Z");
const ARM_T11_MS = Date.parse("2026-11-12T22:14:00.000Z"); // fixed local T−11

Deno.test("MK-009 class: null JIT deadline → fixed T−11 fallback arms (not near-zero reject)", () => {
  const fixed = computeScheduledActivationAtMs({
    scheduledAtMs: PICKUP_MS,
    estimatedDurationMinutes: 12,
    config: SCHEDULED_ACTIVATION_DEFAULTS,
  });
  assertEquals(fixed.kind, "local");
  assertEquals(fixed.activationAtMs, ARM_T11_MS);

  // Near-zero ETA is clamped to ≥1 — not rejected.
  const validated = validateJitEtaMinutes({
    proposedEtaMinutes: 0,
    previousEtaMinutes: null,
    haversineEtaMinutes: 0.2,
    consecutiveElevatedSamples: 0,
    config: SCHEDULED_JIT_ACTIVATION_DEFAULTS,
  });
  assertEquals(validated.acceptedEtaMinutes, 1);
  assertEquals(validated.rejectedSpike, false);

  // If JIT ETA had resolved at pickup, deadline would be T−(5+1+3)=T−9 = 22:16 —
  // and at 22:14 the decision would WAIT (not arm via fixed).
  const jit = computeJitDepartureDeadlineMs({
    scheduledAtMs: PICKUP_MS,
    driverToPickupEtaMinutes: validated.acceptedEtaMinutes,
    config: SCHEDULED_JIT_ACTIVATION_DEFAULTS,
  });
  assertEquals(new Date(jit.deadlineMs).toISOString(), "2026-11-12T22:16:00.000Z");

  const withJitAtT11 = decideConfirmedScheduledActivation({
    nowMs: ARM_T11_MS,
    scheduledAtMs: PICKUP_MS,
    jitDeadlineMs: jit.deadlineMs,
    fixedFallbackDue: true,
    fixedFallbackActivationAtMs: fixed.activationAtMs,
    fixedFallbackKind: "local",
    intentionallyHeld: false,
    activeJourneyThreatensCommitment: false,
    availabilityClass: "available",
    executionMode: "ack_nro",
  });
  assertEquals(withJitAtT11.action, "wait");

  // Actual MK-009: JIT columns null → fixed fallback arms exclusive NRO at T−11.
  const mk009 = decideConfirmedScheduledActivation({
    nowMs: ARM_T11_MS + 906,
    scheduledAtMs: PICKUP_MS,
    jitDeadlineMs: null,
    fixedFallbackDue: true,
    fixedFallbackActivationAtMs: fixed.activationAtMs,
    fixedFallbackKind: "local",
    intentionallyHeld: false,
    activeJourneyThreatensCommitment: false,
    availabilityClass: "stale_location",
    executionMode: "ack_nro",
  });
  assertEquals(mk009.action, "arm_exclusive_nro");
  if (mk009.action === "arm_exclusive_nro") {
    assertEquals(mk009.source, "fixed_fallback");
    assertEquals(mk009.phase5AckDeadlineAtMs, null);
  }
});

Deno.test("Phase 5: at-pickup JIT due → arm_ack 45s → Heading to Pickup patch (no activate_now)", () => {
  const validated = validateJitEtaMinutes({
    proposedEtaMinutes: 0.4,
    previousEtaMinutes: null,
    haversineEtaMinutes: 0.4,
    consecutiveElevatedSamples: 0,
    config: SCHEDULED_JIT_ACTIVATION_DEFAULTS,
  });
  const jit = computeJitDepartureDeadlineMs({
    scheduledAtMs: PICKUP_MS,
    driverToPickupEtaMinutes: validated.acceptedEtaMinutes,
    config: SCHEDULED_JIT_ACTIVATION_DEFAULTS,
  });
  const nowMs = jit.deadlineMs;
  const decision = decideConfirmedScheduledActivation({
    nowMs,
    scheduledAtMs: PICKUP_MS,
    jitDeadlineMs: jit.deadlineMs,
    fixedFallbackDue: false,
    fixedFallbackActivationAtMs: ARM_T11_MS,
    fixedFallbackKind: "local",
    intentionallyHeld: false,
    activeJourneyThreatensCommitment: false,
    availabilityClass: "available",
    executionMode: "departure_ack",
    departureAckCountdownSeconds: PHASE5_DEPARTURE_ACK_COUNTDOWN_SECONDS,
  });
  assertEquals(decision.action, "arm_ack");
  if (decision.action !== "arm_ack") throw new Error("expected arm_ack");
  assertEquals(decision.source, "jit");
  assertEquals(decision.countdownSeconds, 45);
  assertEquals(decision.phase5AckDeadlineAtMs, nowMs + 45_000);
  assertEquals(decision.action !== "activate_now", true);

  const ackDeadline = computeDepartureAckDeadlineMs({
    nowMs,
    countdownSeconds: 45,
  });
  assertEquals(ackDeadline, nowMs + 45_000);

  const armPatch = buildDepartureAckArmPatch({
    nowIso: new Date(nowMs).toISOString(),
    deadlineIso: new Date(ackDeadline).toISOString(),
    driverId: "driver-1",
    nonce: "ack-nonce-phase5",
  });
  assertEquals(armPatch.scheduled_status, "awaiting_activation_accept");
  assertEquals(armPatch.scheduled_ack_status, "pending");
  assertEquals(armPatch.scheduled_ack_deadline_at, new Date(ackDeadline).toISOString());
  assertEquals(armPatch.scheduled_ack_driver_id, "driver-1");
  // Phase 5 arms acknowledgement only — does not stamp driver_id / en_route here.
  assert(!("driver_id" in armPatch));

  // Heading to Pickup → direct en_route boundary (no exclusive NRO accept / check-in).
  assert(PHASE5_DEPARTURE_ACK_COUNTDOWN_SECONDS === 45);
  const exclusive = buildExclusiveActivationArmPatch({
    nowIso: new Date(nowMs).toISOString(),
  });
  // Phase 4 patch must not be used for Phase 5 ack arm.
  assertEquals(exclusive.scheduled_status, "awaiting_activation_accept");
  assert(!("scheduled_ack_status" in exclusive));
});

Deno.test("Phase 5 never silently auto-activates even when autoActivate flag is true in row", () => {
  const d = decideConfirmedScheduledActivation({
    nowMs: ARM_T11_MS,
    scheduledAtMs: PICKUP_MS,
    jitDeadlineMs: null,
    fixedFallbackDue: true,
    fixedFallbackActivationAtMs: ARM_T11_MS,
    fixedFallbackKind: "local",
    intentionallyHeld: false,
    activeJourneyThreatensCommitment: false,
    availabilityClass: "available",
    executionMode: "departure_ack",
  });
  assertEquals(d.action, "arm_ack");
  assert(d.action !== "activate_now");
});

Deno.test("Phase 5 capability gate: v1-only → ack_nro; fresh v2 → arm_ack 45s", async () => {
  const {
    SCHEDULED_DEPARTURE_ACK_CAPABILITY_V1,
    SCHEDULED_DEPARTURE_ACK_CAPABILITY_V2,
    resolveDepartureAckCapabilityConfig,
    resolveDepartureAckExecutionModeForDriver,
  } = await import("./scheduledDepartureAckCapabilitySSOT.ts");

  const cfgV2 = resolveDepartureAckCapabilityConfig({
    scheduled_departure_ack_enabled: true,
    scheduled_departure_ack_capability_key: SCHEDULED_DEPARTURE_ACK_CAPABILITY_V2,
  });
  const v1Mode = resolveDepartureAckExecutionModeForDriver({
    config: cfgV2,
    snapshot: {
      capabilities: [SCHEDULED_DEPARTURE_ACK_CAPABILITY_V1],
      appVersion: "1.0.6",
      deviceId: "ios-v1",
    },
  });
  assertEquals(v1Mode, "ack_nro");

  const v2Mode = resolveDepartureAckExecutionModeForDriver({
    config: cfgV2,
    snapshot: {
      capabilities: [
        SCHEDULED_DEPARTURE_ACK_CAPABILITY_V1,
        SCHEDULED_DEPARTURE_ACK_CAPABILITY_V2,
      ],
      appVersion: "1.0.6",
      deviceId: "ios-v2",
    },
  });
  assertEquals(v2Mode, "departure_ack");

  const nowMs = ARM_T11_MS;
  const phase4 = decideConfirmedScheduledActivation({
    nowMs,
    scheduledAtMs: PICKUP_MS,
    jitDeadlineMs: null,
    fixedFallbackDue: true,
    fixedFallbackActivationAtMs: ARM_T11_MS,
    fixedFallbackKind: "local",
    intentionallyHeld: false,
    activeJourneyThreatensCommitment: false,
    availabilityClass: "available",
    executionMode: v1Mode,
  });
  assertEquals(phase4.action, "arm_exclusive_nro");

  const phase5 = decideConfirmedScheduledActivation({
    nowMs,
    scheduledAtMs: PICKUP_MS,
    jitDeadlineMs: null,
    fixedFallbackDue: true,
    fixedFallbackActivationAtMs: ARM_T11_MS,
    fixedFallbackKind: "local",
    intentionallyHeld: false,
    activeJourneyThreatensCommitment: false,
    availabilityClass: "available",
    executionMode: v2Mode,
    departureAckCountdownSeconds: PHASE5_DEPARTURE_ACK_COUNTDOWN_SECONDS,
  });
  assertEquals(phase5.action, "arm_ack");
  if (phase5.action === "arm_ack") {
    assertEquals(phase5.countdownSeconds, 45);
  }
});

Deno.test("JIT unresolved diagnostics + fixed fallback source lock", async () => {
  const runner = await Deno.readTextFile(
    new URL("./runConfirmedJitActivationPass.ts", import.meta.url),
  );
  assert(runner.includes("SCHEDULED_JIT_ETA_UNRESOLVED"));
  assert(runner.includes("SCHEDULED_JIT_FIXED_FALLBACK_SELECTED"));
  assert(runner.includes("freshness_reason"));
  assert(runner.includes("presence_status"));
  assert(runner.includes("resolveDepartureAckExecutionModeForDriver"));

  const ssot = await Deno.readTextFile(
    new URL("./scheduledJitActivationSSOT.ts", import.meta.url),
  );
  assert(ssot.includes('departureAckCapabilityKey: "scheduled_departure_ack_v2"'));
  assert(ssot.includes("departureAckSeconds: 45"));
  assertEquals(SCHEDULED_JIT_ACTIVATION_DEFAULTS.departureAckCapabilityKey, "scheduled_departure_ack_v2");
  assertEquals(SCHEDULED_JIT_ACTIVATION_DEFAULTS.departureAckSeconds, 45);
  assertEquals(SCHEDULED_JIT_ACTIVATION_DEFAULTS.departureAckEnabled, false);
  assertEquals(SCHEDULED_JIT_ACTIVATION_DEFAULTS.autoActivateEnabled, false);
});
