/**
 * Phase 4 — Just-in-Time departure deadline SSOT (confirmed-driver path only).
 *
 * deadline = scheduled_at − target_early_arrival − driver_to_pickup_eta − safety_buffer
 *
 * Feature-gated execution mode (default ack-safe):
 * - ack_nro: arm exclusive activation offer (existing Driver Accept) — DEFAULT
 * - auto_en_route: direct driver_en_route (requires explicit flag; Phase 5 supersedes)
 * - Phase 5 reserved: arm_ack (45s countdown) — never returned until Phase 5 ships
 *
 * Unclaimed Local/Long conversion timings stay on scheduledActivationSSOT.
 */

export type ScheduledJitDistanceKind = "local" | "long";

/** Safe default until Phase 5 acknowledgement is live. */
export type ScheduledJitExecutionMode = "ack_nro" | "auto_en_route";

export type ScheduledJitActivationConfig = {
  targetEarlyArrivalMinutes: number;
  localSafetyBufferMinutes: number;
  longSafetyBufferMinutes: number;
  longDistanceEtaThresholdMinutes: number;
  oscillationToleranceMinutes: number;
  /**
   * Only monitor / refresh ETA when now ≥ pickup − this horizon.
   * Prevents hours-early sticky deadlines from transient ETA spikes.
   */
  planningHorizonMinutes: number;
  /**
   * Cap how much earlier than the fixed Local/Long activation a JIT deadline
   * may pull (minutes). Spikes cannot yank activation hours early.
   */
  maxEarlyPullAheadOfFixedMinutes: number;
  /**
   * When false (default), due deadline arms exclusive NRO acknowledgement.
   * When true, due deadline may auto-activate to en_route (ops-only until Phase 5).
   */
  autoActivateEnabled: boolean;
};

export const SCHEDULED_JIT_ACTIVATION_DEFAULTS: ScheduledJitActivationConfig = {
  targetEarlyArrivalMinutes: 5,
  localSafetyBufferMinutes: 3,
  longSafetyBufferMinutes: 5,
  longDistanceEtaThresholdMinutes: 30,
  oscillationToleranceMinutes: 2,
  planningHorizonMinutes: 90,
  maxEarlyPullAheadOfFixedMinutes: 20,
  autoActivateEnabled: false,
};

export type ScheduledJitDbRow = {
  jit_target_early_arrival_minutes?: number | null;
  jit_local_safety_buffer_minutes?: number | null;
  jit_long_safety_buffer_minutes?: number | null;
  jit_long_distance_eta_threshold_minutes?: number | null;
  jit_oscillation_tolerance_minutes?: number | null;
  jit_planning_horizon_minutes?: number | null;
  jit_max_early_pull_ahead_of_fixed_minutes?: number | null;
  jit_auto_activate_enabled?: boolean | null;
};

function parsePositiveInt(raw: unknown, fallback: number): number {
  if (raw == null || raw === "") return fallback;
  const n = parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseBool(raw: unknown, fallback: boolean): boolean {
  if (raw == null || raw === "") return fallback;
  if (typeof raw === "boolean") return raw;
  const v = String(raw).trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  return fallback;
}

export function resolveScheduledJitActivationConfig(
  row: ScheduledJitDbRow | null | undefined,
): ScheduledJitActivationConfig {
  if (!row) return { ...SCHEDULED_JIT_ACTIVATION_DEFAULTS };
  return {
    targetEarlyArrivalMinutes: parsePositiveInt(
      row.jit_target_early_arrival_minutes,
      SCHEDULED_JIT_ACTIVATION_DEFAULTS.targetEarlyArrivalMinutes,
    ),
    localSafetyBufferMinutes: parsePositiveInt(
      row.jit_local_safety_buffer_minutes,
      SCHEDULED_JIT_ACTIVATION_DEFAULTS.localSafetyBufferMinutes,
    ),
    longSafetyBufferMinutes: parsePositiveInt(
      row.jit_long_safety_buffer_minutes,
      SCHEDULED_JIT_ACTIVATION_DEFAULTS.longSafetyBufferMinutes,
    ),
    longDistanceEtaThresholdMinutes: parsePositiveInt(
      row.jit_long_distance_eta_threshold_minutes,
      SCHEDULED_JIT_ACTIVATION_DEFAULTS.longDistanceEtaThresholdMinutes,
    ),
    oscillationToleranceMinutes: parsePositiveInt(
      row.jit_oscillation_tolerance_minutes,
      SCHEDULED_JIT_ACTIVATION_DEFAULTS.oscillationToleranceMinutes,
    ),
    planningHorizonMinutes: parsePositiveInt(
      row.jit_planning_horizon_minutes,
      SCHEDULED_JIT_ACTIVATION_DEFAULTS.planningHorizonMinutes,
    ),
    maxEarlyPullAheadOfFixedMinutes: parsePositiveInt(
      row.jit_max_early_pull_ahead_of_fixed_minutes,
      SCHEDULED_JIT_ACTIVATION_DEFAULTS.maxEarlyPullAheadOfFixedMinutes,
    ),
    // Fail closed: auto en_route off unless explicitly enabled.
    autoActivateEnabled: parseBool(
      row.jit_auto_activate_enabled,
      SCHEDULED_JIT_ACTIVATION_DEFAULTS.autoActivateEnabled,
    ),
  };
}

export function classifyJitDistanceKind(input: {
  driverToPickupEtaMinutes: number;
  longDistanceEtaThresholdMinutes: number;
}): { kind: ScheduledJitDistanceKind; etaMinutes: number } {
  const threshold = Math.max(1, Math.floor(input.longDistanceEtaThresholdMinutes));
  const eta = Math.max(0, Math.ceil(Number(input.driverToPickupEtaMinutes) || 0));
  const kind: ScheduledJitDistanceKind = eta >= threshold ? "long" : "local";
  return { kind, etaMinutes: eta };
}

export function safetyBufferMinutesForJitKind(
  kind: ScheduledJitDistanceKind,
  config: Pick<
    ScheduledJitActivationConfig,
    "localSafetyBufferMinutes" | "longSafetyBufferMinutes"
  >,
): number {
  return kind === "long"
    ? Math.max(1, Math.floor(config.longSafetyBufferMinutes))
    : Math.max(1, Math.floor(config.localSafetyBufferMinutes));
}

export function computeJitDepartureDeadlineMs(input: {
  scheduledAtMs: number;
  driverToPickupEtaMinutes: number;
  config: ScheduledJitActivationConfig;
}): {
  kind: ScheduledJitDistanceKind;
  deadlineMs: number;
  etaMinutes: number;
  earlyArrivalMinutes: number;
  safetyBufferMinutes: number;
} {
  const classified = classifyJitDistanceKind({
    driverToPickupEtaMinutes: input.driverToPickupEtaMinutes,
    longDistanceEtaThresholdMinutes: input.config.longDistanceEtaThresholdMinutes,
  });
  const early = Math.max(0, Math.floor(input.config.targetEarlyArrivalMinutes));
  const buffer = safetyBufferMinutesForJitKind(classified.kind, input.config);
  const deadlineMs =
    input.scheduledAtMs -
    (early + classified.etaMinutes + buffer) * 60_000;
  return {
    kind: classified.kind,
    deadlineMs,
    etaMinutes: classified.etaMinutes,
    earlyArrivalMinutes: early,
    safetyBufferMinutes: buffer,
  };
}

/** True when ETA monitoring / sticky updates are allowed. */
export function isWithinJitPlanningHorizon(input: {
  nowMs: number;
  scheduledAtMs: number;
  planningHorizonMinutes: number;
}): boolean {
  if (!Number.isFinite(input.scheduledAtMs)) return false;
  const openAt =
    input.scheduledAtMs -
    Math.max(1, Math.floor(input.planningHorizonMinutes)) * 60_000;
  return input.nowMs >= openAt;
}

/**
 * Clamp candidate so a transient long ETA cannot schedule activation hours early.
 * Floor = fixed Local/Long activation − maxEarlyPullAheadOfFixedMinutes.
 */
export function clampJitDeadlineToFixedFloor(input: {
  candidateDeadlineMs: number;
  fixedActivationAtMs: number;
  maxEarlyPullAheadOfFixedMinutes: number;
}): number {
  const maxPull = Math.max(0, Math.floor(input.maxEarlyPullAheadOfFixedMinutes));
  const earliestAllowed = input.fixedActivationAtMs - maxPull * 60_000;
  return Math.max(input.candidateDeadlineMs, earliestAllowed);
}

/**
 * Sticky deadline: never postpone; only pull earlier when delta ≥ tolerance.
 * Always respects fixed-floor clamp.
 */
export function reconcileStickyJitDeadline(input: {
  previousDeadlineMs: number | null | undefined;
  candidateDeadlineMs: number;
  fixedActivationAtMs: number;
  oscillationToleranceMinutes: number;
  maxEarlyPullAheadOfFixedMinutes: number;
  /** When scheduled_at changed, previous sticky is invalid. */
  basisScheduledAtMs?: number | null;
  currentScheduledAtMs: number;
}): { deadlineMs: number; changed: boolean; reason: "initial" | "pulled_earlier" | "unchanged" | "basis_reset" } {
  const clamped = clampJitDeadlineToFixedFloor({
    candidateDeadlineMs: input.candidateDeadlineMs,
    fixedActivationAtMs: input.fixedActivationAtMs,
    maxEarlyPullAheadOfFixedMinutes: input.maxEarlyPullAheadOfFixedMinutes,
  });

  const basisOk =
    input.basisScheduledAtMs == null ||
    !Number.isFinite(input.basisScheduledAtMs) ||
    Math.abs(input.basisScheduledAtMs - input.currentScheduledAtMs) < 1_000;

  if (!basisOk) {
    return { deadlineMs: clamped, changed: true, reason: "basis_reset" };
  }

  const prev = input.previousDeadlineMs;
  if (prev == null || !Number.isFinite(prev)) {
    return { deadlineMs: clamped, changed: true, reason: "initial" };
  }
  const toleranceMs =
    Math.max(0, Math.floor(input.oscillationToleranceMinutes)) * 60_000;
  if (clamped <= prev - toleranceMs) {
    return { deadlineMs: clamped, changed: true, reason: "pulled_earlier" };
  }
  return { deadlineMs: prev, changed: false, reason: "unchanged" };
}

export function isJitDepartureDue(input: {
  deadlineMs: number;
  scheduledAtMs: number;
  nowMs: number;
}): { due: boolean; pastPickup: boolean } {
  if (!Number.isFinite(input.deadlineMs) || !Number.isFinite(input.scheduledAtMs)) {
    return { due: false, pastPickup: false };
  }
  const pastPickup = input.nowMs > input.scheduledAtMs;
  const due = input.nowMs >= input.deadlineMs || pastPickup;
  return { due, pastPickup };
}

export type DriverAvailabilityClass =
  | "available"
  | "on_active_journey"
  | "routing_api_failure"
  | "stale_location"
  | "offline"
  | "unreachable"
  | "missing_location";

/**
 * Phase 4/5 integration boundary.
 * Phase 4 default: arm_exclusive_nro (keeps acknowledgement).
 * Phase 5 will insert arm_ack (45s) before activate_now.
 */
export type ConfirmedActivationDecision =
  | {
    action: "wait";
    deadlineMs: number;
    source: "jit" | "fixed_fallback";
    kind: string;
  }
  | {
    action: "arm_exclusive_nro";
    deadlineMs: number;
    source: "jit" | "fixed_fallback";
    kind: string;
    /** Phase 5 reserved — null until Phase 5. */
    phase5AckDeadlineAtMs: null;
  }
  | {
    action: "activate_now";
    deadlineMs: number;
    source: "jit" | "fixed_fallback";
    kind: string;
    phase5AckDeadlineAtMs: null;
  }
  | {
    /** Reserved for Phase 5 — never emitted by Phase 4 decide*. */
    action: "arm_ack";
    deadlineMs: number;
    phase5AckDeadlineAtMs: number;
    countdownSeconds: 45;
  }
  | {
    action: "conflict_rescue";
    reason: string;
  }
  | {
    action: "unavailable_rescue";
    reason: string;
    availability: DriverAvailabilityClass;
  }
  | {
    action: "hold_skip";
    reason: string;
  };

export const PHASE5_ACK_COUNTDOWN_SECONDS = 45 as const;

export function resolveJitExecutionMode(
  config: Pick<ScheduledJitActivationConfig, "autoActivateEnabled">,
): ScheduledJitExecutionMode {
  return config.autoActivateEnabled ? "auto_en_route" : "ack_nro";
}

export function decideConfirmedScheduledActivation(input: {
  nowMs: number;
  scheduledAtMs: number;
  jitDeadlineMs: number | null;
  fixedFallbackDue: boolean;
  fixedFallbackActivationAtMs: number;
  fixedFallbackKind: string;
  intentionallyHeld: boolean;
  holdReason?: string | null;
  activeJourneyThreatensCommitment: boolean;
  activeJourneyThreatReason?: string;
  /** Driver reachable + fresh enough to arm/activate. */
  driverAvailableForActivation: boolean;
  availabilityClass: DriverAvailabilityClass;
  executionMode: ScheduledJitExecutionMode;
}): ConfirmedActivationDecision {
  if (input.intentionallyHeld) {
    return {
      action: "hold_skip",
      reason: String(input.holdReason ?? "intentional_hold"),
    };
  }
  if (input.activeJourneyThreatensCommitment) {
    return {
      action: "conflict_rescue",
      reason: String(input.activeJourneyThreatReason ?? "active_journey_conflict"),
    };
  }

  const dueFromJit =
    input.jitDeadlineMs != null &&
    Number.isFinite(input.jitDeadlineMs) &&
    isJitDepartureDue({
      deadlineMs: input.jitDeadlineMs,
      scheduledAtMs: input.scheduledAtMs,
      nowMs: input.nowMs,
    }).due;

  const due = dueFromJit || input.fixedFallbackDue;
  const deadlineMs = dueFromJit && input.jitDeadlineMs != null
    ? input.jitDeadlineMs
    : input.fixedFallbackActivationAtMs;
  const source: "jit" | "fixed_fallback" = dueFromJit ? "jit" : "fixed_fallback";
  const kind = dueFromJit ? "jit" : input.fixedFallbackKind;

  if (!due) {
    return {
      action: "wait",
      deadlineMs,
      source: input.jitDeadlineMs != null ? "jit" : "fixed_fallback",
      kind: input.jitDeadlineMs != null ? "jit" : input.fixedFallbackKind,
    };
  }

  // Never activate / arm an unavailable driver via fixed fallback alone.
  if (!input.driverAvailableForActivation) {
    return {
      action: "unavailable_rescue",
      reason: `driver_${input.availabilityClass}`,
      availability: input.availabilityClass,
    };
  }

  if (input.executionMode === "auto_en_route") {
    return {
      action: "activate_now",
      deadlineMs,
      source,
      kind,
      phase5AckDeadlineAtMs: null,
    };
  }

  // Default Phase 4: preserve acknowledgement NRO for Phase 5 compatibility.
  return {
    action: "arm_exclusive_nro",
    deadlineMs,
    source,
    kind,
    phase5AckDeadlineAtMs: null,
  };
}

/** Classify availability for activation decisions. */
export function classifyDriverAvailabilityForJit(input: {
  presenceStatus: string | null | undefined;
  locationFresh: boolean;
  locationReason: string;
  hasActiveJourney: boolean;
  routingFailedWithFreshLocation: boolean;
}): DriverAvailabilityClass {
  if (input.hasActiveJourney) return "on_active_journey";
  const status = String(input.presenceStatus ?? "").trim().toLowerCase();
  if (status === "offline" || status === "") {
    if (input.locationReason === "missing_presence" || status === "offline") {
      return status === "offline" ? "offline" : "unreachable";
    }
  }
  if (!input.locationFresh) {
    if (input.locationReason === "stale_heartbeat") return "stale_location";
    if (input.locationReason === "missing_coords") return "missing_location";
    if (input.locationReason === "missing_presence") return "unreachable";
    return "stale_location";
  }
  if (input.routingFailedWithFreshLocation) return "routing_api_failure";
  if (status && status !== "online" && status !== "on_trip") {
    return "offline";
  }
  return "available";
}
