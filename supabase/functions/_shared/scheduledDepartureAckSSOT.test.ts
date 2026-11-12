/**
 * Phase 5 departure acknowledgement SSOT tests.
 * Run: deno test --no-check --allow-read supabase/functions/_shared/scheduledDepartureAckSSOT.test.ts
 */
import {
  assertEquals,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  canAcknowledgeDeparture,
  computeDepartureAckDeadlineMs,
  isDepartureAckTimedOut,
  isSoftPresenceIneligibilityForDepartureAck,
  PHASE5_DEPARTURE_ACK_COUNTDOWN_SECONDS,
  resolveDepartureAckConfig,
} from "./scheduledDepartureAckSSOT.ts";
import { shouldRescueAwaitingActivation } from "./scheduledDepartureAckRescueGateSSOT.ts";
import {
  decideConfirmedScheduledActivation,
  resolveJitExecutionMode,
  SCHEDULED_JIT_ACTIVATION_DEFAULTS,
} from "./scheduledJitActivationSSOT.ts";
import { PHASE5_ACK_BOUNDARY } from "./scheduledConfirmedActivationSSOT.ts";
import { SCHEDULED_ACTIVATION_EXCLUSIVE_REASON } from "./scheduledActivationExclusiveSSOT.ts";

Deno.test("Phase 5 default execution mode is departure_ack", () => {
  assertEquals(
    resolveJitExecutionMode(SCHEDULED_JIT_ACTIVATION_DEFAULTS),
    "departure_ack",
  );
  assertEquals(
    resolveJitExecutionMode({
      autoActivateEnabled: true,
      departureAckEnabled: true,
    }),
    "departure_ack",
  );
  assertEquals(
    resolveJitExecutionMode({
      autoActivateEnabled: false,
      departureAckEnabled: false,
    }),
    "ack_nro",
  );
});

Deno.test("due deadline arms arm_ack with 45s countdown — not activate_now", () => {
  const pickup = Date.parse("2026-11-12T20:30:00.000Z");
  const nowMs = pickup - 14 * 60_000;
  const d = decideConfirmedScheduledActivation({
    nowMs,
    scheduledAtMs: pickup,
    jitDeadlineMs: pickup - 16 * 60_000,
    fixedFallbackDue: false,
    fixedFallbackActivationAtMs: pickup - 11 * 60_000,
    fixedFallbackKind: "local",
    intentionallyHeld: false,
    activeJourneyThreatensCommitment: false,
    availabilityClass: "offline",
    executionMode: "departure_ack",
    departureAckCountdownSeconds: 45,
  });
  assertEquals(d.action, "arm_ack");
  if (d.action === "arm_ack") {
    assertEquals(d.countdownSeconds, 45);
    assertEquals(d.phase5AckDeadlineAtMs, nowMs + 45_000);
  }
});

Deno.test("compatible active journey defers countdown", () => {
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
    executionMode: "departure_ack",
  });
  assertEquals(d.action, "wait");
  if (d.action === "wait") {
    assertEquals(d.kind, "defer_compatible_active_journey");
  }
});

Deno.test("ack deadline + grace gates timeout rescue", () => {
  const deadline = Date.parse("2026-11-12T19:35:00.000Z");
  assertEquals(
    isDepartureAckTimedOut({
      nowMs: deadline + 5_000,
      deadlineMs: deadline,
      graceSeconds: 10,
    }),
    false,
  );
  assertEquals(
    isDepartureAckTimedOut({
      nowMs: deadline + 10_000,
      deadlineMs: deadline,
      graceSeconds: 10,
    }),
    true,
  );
  assertEquals(
    canAcknowledgeDeparture({
      nowMs: deadline + 5_000,
      deadlineMs: deadline,
      ackStatus: "pending",
      graceSeconds: 10,
    }),
    true,
  );
  assertEquals(
    canAcknowledgeDeparture({
      nowMs: deadline + 11_000,
      deadlineMs: deadline,
      ackStatus: "pending",
      graceSeconds: 10,
    }),
    false,
  );
});

Deno.test("rescue gate: pending ack waits even without open offer (offline reconnect)", () => {
  const deadline = Date.parse("2026-11-12T19:35:00.000Z");
  const mid = shouldRescueAwaitingActivation({
    nowMs: deadline + 1_000,
    ackStatus: "pending",
    ackDeadlineAt: new Date(deadline).toISOString(),
    graceSeconds: 10,
    hasOpenLiveOffer: false,
  });
  assertEquals(mid.rescue, false);

  const late = shouldRescueAwaitingActivation({
    nowMs: deadline + 15_000,
    ackStatus: "pending",
    ackDeadlineAt: new Date(deadline).toISOString(),
    graceSeconds: 10,
    hasOpenLiveOffer: false,
  });
  assertEquals(late.rescue, true);
  assertEquals(late.reason, "acknowledgement_timeout");
});

Deno.test("soft presence reasons do not hard-block departure ack arm", () => {
  for (const r of ["driver_offline", "stale_heartbeat", "online_intent_false"]) {
    assert(isSoftPresenceIneligibilityForDepartureAck(r));
  }
  assertEquals(isSoftPresenceIneligibilityForDepartureAck("wallet_ineligible"), false);
});

Deno.test("countdown constant and exclusive timeout reason", () => {
  assertEquals(PHASE5_DEPARTURE_ACK_COUNTDOWN_SECONDS, 45);
  assertEquals(PHASE5_ACK_BOUNDARY.countdownSeconds, 45);
  assertEquals(PHASE5_ACK_BOUNDARY.headingToPickupAction, "heading_to_pickup");
  assertEquals(
    SCHEDULED_ACTIVATION_EXCLUSIVE_REASON.acknowledgementTimeout,
    "acknowledgement_timeout",
  );
  const now = Date.parse("2026-11-12T19:00:00.000Z");
  assertEquals(
    computeDepartureAckDeadlineMs({ nowMs: now, countdownSeconds: 45 }),
    now + 45_000,
  );
});

Deno.test("config resolves ack settings; auto_activate cannot enable no-ack", () => {
  const cfg = resolveDepartureAckConfig({
    scheduled_departure_ack_enabled: true,
    scheduled_departure_ack_seconds: 45,
    scheduled_departure_ack_grace_seconds: 10,
  });
  assertEquals(cfg.enabled, true);
  assertEquals(cfg.countdownSeconds, 45);
});

Deno.test("source lock: runner arms departure ack; never activate_now", async () => {
  const runner = await Deno.readTextFile(
    new URL("./runConfirmedJitActivationPass.ts", import.meta.url),
  );
  assert(runner.includes("SCHEDULED_JIT_ARM_DEPARTURE_ACK"));
  assert(runner.includes("allowOfflineForDepartureAck"));
  assert(runner.includes("departureAcknowledgement"));
  assert(!runner.includes("buildConfirmedActivationPatch"));
  assert(runner.includes("Phase 5 fail-closed"));

  const checkin = await Deno.readTextFile(
    new URL("../scheduled-checkin/index.ts", import.meta.url),
  );
  assert(checkin.includes("SCHEDULED_DEPARTURE_ACK_SUCCESS"));
  assert(checkin.includes("heading_to_pickup"));
  assert(checkin.includes("buildDepartureAckAcknowledgedFields"));
});
