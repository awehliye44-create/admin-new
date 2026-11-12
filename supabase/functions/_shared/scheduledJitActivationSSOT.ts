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
   * Base planning horizon (minutes before pickup). Effective horizon also expands
   * with last-known ETA / long-distance lead so distant drivers are not concealed.
   */
  planningHorizonMinutes: number;
  /**
   * Consecutive elevated-ETA samples required before sticky deadline pulls earlier
   * past the previous ETA (spike damping — not a fixed-activation clamp).
   */
  etaSpikeConfirmSamples: number;
  /**
   * Max relative ETA jump accepted in one sample without confirmation (e.g. 1.35 = +35%).
   */
  etaSpikeMaxRelativeJump: number;
  /**
   * Kept for migration compatibility; IGNORED for deadline math.
   * Fixed Local/Long is fallback-only when ETA unavailable — never delays a genuine JIT deadline.
   * @deprecated
   */
  maxEarlyPullAheadOfFixedMinutes: number;
  /**
   * Always forced false in resolveJitExecutionMode until Phase 5.
   * DB column may exist but cannot enable no-ack en_route in Phase 4.
   */
  autoActivateEnabled: boolean;
};

export const SCHEDULED_JIT_ACTIVATION_DEFAULTS: ScheduledJitActivationConfig = {
  targetEarlyArrivalMinutes: 5,
  localSafetyBufferMinutes: 3,
  longSafetyBufferMinutes: 5,
  longDistanceEtaThresholdMinutes: 30,
  oscillationToleranceMinutes: 2,
  planningHorizonMinutes: 180,
  etaSpikeConfirmSamples: 2,
  etaSpikeMaxRelativeJump: 1.35,
  maxEarlyPullAheadOfFixedMinutes: 20, // unused for clamp — retained for column compat
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
  jit_eta_spike_confirm_samples?: number | null;
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
    etaSpikeConfirmSamples: parsePositiveInt(
      row.jit_eta_spike_confirm_samples,
      SCHEDULED_JIT_ACTIVATION_DEFAULTS.etaSpikeConfirmSamples,
    ),
    etaSpikeMaxRelativeJump:
      SCHEDULED_JIT_ACTIVATION_DEFAULTS.etaSpikeMaxRelativeJump,
    maxEarlyPullAheadOfFixedMinutes: parsePositiveInt(
      row.jit_max_early_pull_ahead_of_fixed_minutes,
      SCHEDULED_JIT_ACTIVATION_DEFAULTS.maxEarlyPullAheadOfFixedMinutes,
    ),
    // Phase 4: DB flag ignored — always false (no-ack path cannot be enabled).
    autoActivateEnabled: false,
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

/**
 * Effective horizon must cover distant drivers (ETA-based lead), not only 90/180m.
 * Example: ETA 45 + early 5 + buffer 5 + margin 30 → ≥85; default floor 180.
 */
export function effectiveJitPlanningHorizonMinutes(input: {
  config: ScheduledJitActivationConfig;
  lastKnownEtaMinutes?: number | null;
  fixedLongActivationMinutes?: number | null;
}): number {
  const early = Math.max(0, Math.floor(input.config.targetEarlyArrivalMinutes));
  const buffer = Math.max(
    input.config.localSafetyBufferMinutes,
    input.config.longSafetyBufferMinutes,
  );
  const fromEta =
    input.lastKnownEtaMinutes != null && Number.isFinite(input.lastKnownEtaMinutes)
      ? Math.ceil(Number(input.lastKnownEtaMinutes)) + early + buffer + 30
      : 0;
  const fromLongThreshold =
    input.config.longDistanceEtaThresholdMinutes + early + buffer + 45;
  const fromFixedLong =
    input.fixedLongActivationMinutes != null &&
      Number.isFinite(input.fixedLongActivationMinutes)
      ? Math.ceil(Number(input.fixedLongActivationMinutes)) + 30
      : 0;
  return Math.max(
    Math.floor(input.config.planningHorizonMinutes),
    fromEta,
    fromLongThreshold,
    fromFixedLong,
  );
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
 * Validate ETA against prior sample + optional haversine floor.
 * Haversine is an *estimate*, not a guaranteed upper bound on road time.
 * Spikes require consecutive confirmation before sticky pull-earlier.
 */
export function validateJitEtaMinutes(input: {
  proposedEtaMinutes: number;
  previousEtaMinutes: number | null | undefined;
  haversineEtaMinutes: number | null | undefined;
  consecutiveElevatedSamples: number;
  config: Pick<
    ScheduledJitActivationConfig,
    "etaSpikeConfirmSamples" | "etaSpikeMaxRelativeJump"
  >;
}): {
  acceptedEtaMinutes: number;
  consecutiveElevatedSamples: number;
  rejectedSpike: boolean;
} {
  const proposed = Math.max(1, Math.ceil(input.proposedEtaMinutes));
  const prev =
    input.previousEtaMinutes != null && Number.isFinite(input.previousEtaMinutes)
      ? Math.max(1, Math.ceil(Number(input.previousEtaMinutes)))
      : null;
  const hav =
    input.haversineEtaMinutes != null && Number.isFinite(input.haversineEtaMinutes)
      ? Math.max(1, Math.ceil(Number(input.haversineEtaMinutes)))
      : null;

  // Soft sanity: if routing ETA is far below conservative haversine, prefer haversine
  // (haversine is estimate — not an upper bound — but under-routing is worse for JIT).
  let candidate = proposed;
  if (hav != null && proposed < hav * 0.7) {
    candidate = hav;
  }

  if (prev == null) {
    return {
      acceptedEtaMinutes: candidate,
      consecutiveElevatedSamples: 0,
      rejectedSpike: false,
    };
  }

  const jump = candidate / prev;
  const needsConfirm = jump > input.config.etaSpikeMaxRelativeJump;
  if (!needsConfirm) {
    return {
      acceptedEtaMinutes: candidate,
      consecutiveElevatedSamples: 0,
      rejectedSpike: false,
    };
  }

  const elevated = input.consecutiveElevatedSamples + 1;
  if (elevated >= Math.max(1, input.config.etaSpikeConfirmSamples)) {
    return {
      acceptedEtaMinutes: candidate,
      consecutiveElevatedSamples: 0,
      rejectedSpike: false,
    };
  }
  // Hold previous ETA until spike confirms — avoids hours-early false arm from noise.
  return {
    acceptedEtaMinutes: prev,
    consecutiveElevatedSamples: elevated,
    rejectedSpike: true,
  };
}

/**
 * Sticky deadline: never postpone; only pull earlier when delta ≥ tolerance.
 * No fixed Local/Long floor clamp — genuine long ETA (e.g. 45m → 19:35) must win.
 */
export function reconcileStickyJitDeadline(input: {
  previousDeadlineMs: number | null | undefined;
  candidateDeadlineMs: number;
  oscillationToleranceMinutes: number;
  /** When scheduled_at changed, previous sticky is invalid. */
  basisScheduledAtMs?: number | null;
  currentScheduledAtMs: number;
}): { deadlineMs: number; changed: boolean; reason: "initial" | "pulled_earlier" | "unchanged" | "basis_reset" } {
  const candidate = input.candidateDeadlineMs;

  const basisOk =
    input.basisScheduledAtMs == null ||
    !Number.isFinite(input.basisScheduledAtMs) ||
    Math.abs(input.basisScheduledAtMs - input.currentScheduledAtMs) < 1_000;

  if (!basisOk) {
    return { deadlineMs: candidate, changed: true, reason: "basis_reset" };
  }

  const prev = input.previousDeadlineMs;
  if (prev == null || !Number.isFinite(prev)) {
    return { deadlineMs: candidate, changed: true, reason: "initial" };
  }
  const toleranceMs =
    Math.max(0, Math.floor(input.oscillationToleranceMinutes)) * 60_000;
  if (candidate <= prev - toleranceMs) {
    return { deadlineMs: candidate, changed: true, reason: "pulled_earlier" };
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

/**
 * Phase 4 hard-lock: always ack_nro. DB/env cannot enable no-ack en_route.
 * Phase 5 will own acknowledgement countdown before any en_route stamp.
 */
export function resolveJitExecutionMode(
  _config?: Pick<ScheduledJitActivationConfig, "autoActivateEnabled">,
): ScheduledJitExecutionMode {
  return "ack_nro";
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
  /**
   * Compatible active journey that still meets early-arrival target.
   * Wait / reassess after completion — do not arm Phase 5 countdown yet.
   */
  deferForCompatibleActiveJourney?: boolean;
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

  // Fixed Local/Long is fallback only when JIT ETA deadline unavailable.
  const due = dueFromJit ||
    (input.jitDeadlineMs == null && input.fixedFallbackDue);
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

  // Compatible stacked/active journey: keep assignment, wait to reassess after dropoff.
  if (input.deferForCompatibleActiveJourney) {
    return {
      action: "wait",
      deadlineMs,
      source,
      kind: "defer_compatible_active_journey",
    };
  }

  // Phase 4/5: offline/stale/unreachable still ARM acknowledgement NRO
  // (Phase 5 will push urgent + 45s even if offline). Do NOT premature rescue.
  void input.availabilityClass;
  void input.executionMode;

  // activate_now is unreachable in Phase 4 (executionMode forced ack_nro).
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
