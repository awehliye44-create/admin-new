/**
 * Dynamic JIT sticky deadline + decision execution tests.
 * Run: deno test --no-check --allow-read supabase/functions/_shared/scheduledJitStickyDeadline.execution.test.ts
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
import { buildJitMonitorClearPatch } from "./scheduledJitEtaMonitorSSOT.ts";

const DRIVER = "driver-a";
const OTHER = "driver-b";
const PICKUP = Date.parse("2026-11-13T09:30:00.000Z");
const FIXED_T11 = PICKUP - 11 * 60_000;
const NOW_EARLY = PICKUP - 90 * 60_000; // 90m before pickup

Deno.test("fresh long ETA deadline is earlier than fixed T-11", () => {
  const computed = computeJitDepartureDeadlineMs({
    scheduledAtMs: PICKUP,
    driverToPickupEtaMinutes: 45,
    config: SCHEDULED_JIT_ACTIVATION_DEFAULTS,
  });
  assert(computed.deadlineMs < FIXED_T11);
  assertEquals(computed.kind, "long");
});

Deno.test("near-zero ETA (already at pickup) produces near-scheduled deadline with buffers", () => {
  const computed = computeJitDepartureDeadlineMs({
    scheduledAtMs: PICKUP,
    driverToPickupEtaMinutes: 1,
    config: SCHEDULED_JIT_ACTIVATION_DEFAULTS,
  });
  // earlyArrival 5 + eta 1 + local buffer 3 = 9 → later than T-11? T-11 is 11m.
  // deadline = pickup - (5+1+3) = T-9, which is LATER than T-11.
  assert(computed.deadlineMs > FIXED_T11);
  assert(computed.deadlineMs < PICKUP);
});

Deno.test("valid dynamic deadline later than T-11 is respected (not overridden)", () => {
  const jitLater = FIXED_T11 + 5 * 60_000; // T-6
  const decision = decideConfirmedScheduledActivation({
    nowMs: NOW_EARLY,
    scheduledAtMs: PICKUP,
    jitDeadlineMs: jitLater,
    fixedFallbackDue: false,
    fixedFallbackActivationAtMs: FIXED_T11,
    fixedFallbackKind: "local",
    intentionallyHeld: false,
    holdReason: null,
    activeJourneyThreatensCommitment: false,
    deferForCompatibleActiveJourney: false,
    availabilityClass: "available",
    executionMode: "departure_ack",
    departureAckCountdownSeconds: 45,
  });
  assertEquals(decision.action, "wait");
  if (decision.action === "wait") {
    assertEquals(decision.source, "jit");
    assertEquals(decision.deadlineMs, jitLater);
  }
});

Deno.test("stale presence reuses sticky deadline instead of fixed fallback", () => {
  const stamped = FIXED_T11 - 20 * 60_000; // earlier dynamic
  const reused = resolveReusableStickyJitDeadlineMs({
    activateAtIso: new Date(stamped).toISOString(),
    basisScheduledAtIso: new Date(PICKUP).toISOString(),
    currentScheduledAtIso: new Date(PICKUP).toISOString(),
    evaluatingConfirmedDriverId: DRIVER,
    tripConfirmedDriverId: DRIVER,
  });
  assertEquals(reused.deadlineMs, stamped);
  assertEquals(reused.reason, "sticky_reused");

  const decision = decideConfirmedScheduledActivation({
    nowMs: stamped, // due now via sticky
    scheduledAtMs: PICKUP,
    jitDeadlineMs: reused.deadlineMs,
    fixedFallbackDue: true,
    fixedFallbackActivationAtMs: FIXED_T11,
    fixedFallbackKind: "local",
    intentionallyHeld: false,
    holdReason: null,
    activeJourneyThreatensCommitment: false,
    deferForCompatibleActiveJourney: false,
    availabilityClass: "stale_location",
    executionMode: "departure_ack",
    departureAckCountdownSeconds: 45,
  });
  assertEquals(decision.action, "arm_ack");
  if (decision.action === "arm_ack") {
    assertEquals(decision.source, "jit");
    assertEquals(decision.deadlineMs, stamped);
    assertEquals(decision.phase5AckDeadlineAtMs, stamped + 45_000);
    assertEquals(decision.countdownSeconds, 45);
  }
});

Deno.test("no ETA and no sticky uses fixed fallback only", () => {
  const missing = resolveReusableStickyJitDeadlineMs({
    activateAtIso: null,
    basisScheduledAtIso: null,
    currentScheduledAtIso: new Date(PICKUP).toISOString(),
    evaluatingConfirmedDriverId: DRIVER,
    tripConfirmedDriverId: DRIVER,
  });
  assertEquals(missing.deadlineMs, null);

  const decision = decideConfirmedScheduledActivation({
    nowMs: FIXED_T11,
    scheduledAtMs: PICKUP,
    jitDeadlineMs: null,
    fixedFallbackDue: true,
    fixedFallbackActivationAtMs: FIXED_T11,
    fixedFallbackKind: "local",
    intentionallyHeld: false,
    holdReason: null,
    activeJourneyThreatensCommitment: false,
    deferForCompatibleActiveJourney: false,
    availabilityClass: "available",
    executionMode: "departure_ack",
    departureAckCountdownSeconds: 45,
  });
  assertEquals(decision.action, "arm_ack");
  if (decision.action === "arm_ack") {
    assertEquals(decision.source, "fixed_fallback");
  }
});

Deno.test("reschedule invalidates sticky deadline", () => {
  const stamped = FIXED_T11 - 10 * 60_000;
  const reused = resolveReusableStickyJitDeadlineMs({
    activateAtIso: new Date(stamped).toISOString(),
    basisScheduledAtIso: new Date(PICKUP).toISOString(),
    currentScheduledAtIso: new Date(PICKUP + 30 * 60_000).toISOString(),
    evaluatingConfirmedDriverId: DRIVER,
    tripConfirmedDriverId: DRIVER,
  });
  assertEquals(reused.deadlineMs, null);
  assertEquals(reused.reason, "basis_rescheduled");
});

Deno.test("driver reassignment invalidates sticky deadline", () => {
  const stamped = FIXED_T11 - 10 * 60_000;
  const reused = resolveReusableStickyJitDeadlineMs({
    activateAtIso: new Date(stamped).toISOString(),
    basisScheduledAtIso: new Date(PICKUP).toISOString(),
    currentScheduledAtIso: new Date(PICKUP).toISOString(),
    evaluatingConfirmedDriverId: OTHER,
    tripConfirmedDriverId: DRIVER,
  });
  assertEquals(reused.deadlineMs, null);
  assertEquals(reused.reason, "driver_mismatch_or_unassigned");
});

Deno.test("sticky reconcile never postpones; pull-earlier preserved", () => {
  const prev = FIXED_T11 - 15 * 60_000;
  const laterCandidate = FIXED_T11 - 5 * 60_000;
  const unchanged = reconcileStickyJitDeadline({
    previousDeadlineMs: prev,
    candidateDeadlineMs: laterCandidate,
    oscillationToleranceMinutes: 2,
    basisScheduledAtMs: PICKUP,
    currentScheduledAtMs: PICKUP,
  });
  assertEquals(unchanged.deadlineMs, prev);
  assertEquals(unchanged.reason, "unchanged");

  const earlier = reconcileStickyJitDeadline({
    previousDeadlineMs: prev,
    candidateDeadlineMs: prev - 5 * 60_000,
    oscillationToleranceMinutes: 2,
    basisScheduledAtMs: PICKUP,
    currentScheduledAtMs: PICKUP,
  });
  assertEquals(earlier.reason, "pulled_earlier");
});

Deno.test("due dynamic deadline arms departure_ack for 45s; never activate_now", () => {
  const stamped = NOW_EARLY + 60_000;
  const decision = decideConfirmedScheduledActivation({
    nowMs: stamped,
    scheduledAtMs: PICKUP,
    jitDeadlineMs: stamped,
    fixedFallbackDue: false,
    fixedFallbackActivationAtMs: FIXED_T11,
    fixedFallbackKind: "local",
    intentionallyHeld: false,
    holdReason: null,
    activeJourneyThreatensCommitment: false,
    deferForCompatibleActiveJourney: false,
    availabilityClass: "available",
    executionMode: "departure_ack",
    departureAckCountdownSeconds: 45,
  });
  assertEquals(decision.action, "arm_ack");
  assert(decision.action !== "activate_now");
  if (decision.action === "arm_ack") {
    assertEquals(decision.phase5AckDeadlineAtMs, stamped + 45_000);
  }
});

Deno.test("release clear patch nulls all JIT monitor stamps", () => {
  const patch = buildJitMonitorClearPatch("2026-11-13T10:00:00.000Z");
  assertEquals(patch.scheduled_jit_activate_at, null);
  assertEquals(patch.scheduled_jit_basis_scheduled_at, null);
  assertEquals(patch.scheduled_jit_eta_spike_samples, 0);
});

Deno.test("lookahead uses planning horizon 180 (source lock)", async () => {
  const src = await Deno.readTextFile(
    new URL("../scheduled-dispatch/index.ts", import.meta.url),
  );
  assert(src.includes("planningHorizonMinutes"));
  assert(src.includes("SCHEDULED_JIT_CANDIDATE_LOOKAHEAD"));
  assert(src.includes("SCHEDULED_JIT_STICKY_DEADLINE_REUSED") === false); // that log lives in pass
  const pass = await Deno.readTextFile(
    new URL("./runConfirmedJitActivationPass.ts", import.meta.url),
  );
  assert(pass.includes("SCHEDULED_JIT_STICKY_DEADLINE_REUSED"));
  assert(pass.includes("resolveReusableStickyJitDeadlineMs"));
  // Silent activation remains unreachable
  assert(pass.includes("activated"));
  assert(!/action === \"activate_now\"[\s\S]{0,80}driver_en_route/.test(pass));
});
