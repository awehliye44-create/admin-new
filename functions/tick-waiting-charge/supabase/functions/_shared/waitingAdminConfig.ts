/**
 * Admin waiting / no-show settings SSOT — merges fare_pricing_settings + dispatch_settings + stop_waiting_settings.
 *
 * STOP WAITING (multi-stop intermediate) — ONE precedence for all knobs:
 * 1. Trip frozen snapshot (if present)
 * 2. stop_waiting_settings (canonical numeric SSOT: grace, rate, interval, radius, max)
 * 3. dispatch_settings (compat projections + enable_stop_waiting_charge)
 * 4. fare_pricing_settings stop columns (grace minutes / rate only — last resort)
 *
 * Enable lives on dispatch_settings.enable_stop_waiting_charge (only existing column;
 * Admin Fare Engine writes it). NEVER map stop enable from recalculate_on_waiting /
 * pickup_paid_waiting_enabled.
 *
 * Charge interval: UI/tick cadence only for stop waiting — settlement on Drive to Next
 * remains continuous prorate (production). Pickup waiting uses completed intervals.
 */

export const DEFAULT_STOP_WAITING_GRACE_SECONDS = 60;

export type AdminWaitingConfigSnapshot = {
  free_pickup_waiting_minutes: number;
  free_pickup_waiting_seconds: number;
  pickup_grace_source: "fare_pricing" | "dispatch" | "unavailable";
  no_show_waiting_minutes: number;
  no_show_waiting_seconds: number;
  free_stop_waiting_seconds: number;
  stop_grace_source: "stop_waiting_settings" | "dispatch_settings" | "fare_pricing" | "default";
  pickup_paid_waiting_enabled: boolean;
  pickup_paid_waiting_rate_pence_per_minute: number;
  pickup_waiting_max_minutes: number;
  /** Shared Admin charge interval (SA dispatch / stop_waiting_settings). */
  waiting_charge_interval_seconds: number;
  waiting_charge_interval_source: "dispatch_settings" | "stop_waiting_settings" | "unavailable";
  /** completed_intervals | continuous_prorated — pickup uses completed intervals. */
  waiting_charge_rounding: "completed_intervals";
  stop_waiting_rate_pence_per_minute: number;
  stop_waiting_max_minutes: number | null;
  enable_stop_waiting_charge: boolean;
  pickup_radius_enabled: boolean;
  pickup_radius_meters: number;
  stop_radius_enabled: boolean;
  stop_radius_meters: number;
  no_show_fee_pence: number;
  no_show_apply_after_arrival_only: boolean;
  config_available: boolean;
};

export type PickupWaitingStateSnapshot = {
  driver_arrived_at: string | null;
  pickup_waiting_state: "not_arrived" | "blocked_outside_radius" | "free_waiting" | "paid_waiting" | "not_started" | "unavailable";
  pickup_waiting_free_expires_at: string | null;
  pickup_waiting_elapsed_seconds: number;
  pickup_waiting_grace_remaining_seconds: number;
  no_show_eligible_at: string | null;
  no_show_eligible: boolean;
  no_show_remaining_seconds: number;
  admin_waiting_config_snapshot: AdminWaitingConfigSnapshot;
};

export type StopWaitingStateSnapshot = {
  stop_arrived_at: string | null;
  stop_waiting_state: "not_arrived" | "blocked_outside_radius" | "free_waiting" | "paid_waiting" | "not_started";
  stop_waiting_free_expires_at: string | null;
  stop_waiting_elapsed_seconds: number;
  stop_waiting_grace_remaining_seconds: number;
  admin_waiting_config_snapshot: AdminWaitingConfigSnapshot;
};

const FARE_PRICING_COLS =
  "id, updated_at, free_waiting_minutes, no_show_wait_time_minutes, no_show_fee_pence, no_show_apply_after_arrival_only, pickup_paid_waiting_enabled, recalculate_on_waiting, waiting_per_minute_pence, stop_waiting_rate_pence_per_minute, stop_waiting_grace_period_minutes";

const DISPATCH_COLS =
  "pickup_waiting_grace_period_seconds, pickup_paid_waiting_enabled, pickup_paid_waiting_rate_pence_per_minute, pickup_waiting_max_minutes, pickup_radius_enabled, pickup_radius_meters, enable_stop_waiting_charge, stop_radius_enabled, stop_radius_meters, stop_waiting_grace_period_seconds, stop_waiting_rate_pence_per_minute, stop_waiting_max_minutes, stop_waiting_charge_interval_seconds";

const STOP_WAITING_SETTINGS_COLS =
  "stop_waiting_grace_period_seconds, stop_waiting_rate_pence_per_minute, stop_waiting_max_minutes, stop_waiting_charge_interval_seconds, stop_radius_enabled, stop_radius_meters";

function elapsedSecondsSince(iso: string, nowMs = Date.now()): number {
  return Math.max(0, Math.floor((nowMs - new Date(iso).getTime()) / 1000));
}

function addSecondsIso(iso: string, seconds: number): string {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString();
}

function asNonNegInt(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

function asBool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  return null;
}

/**
 * Prefer the newest fare_pricing_settings row for the service area.
 */
// deno-lint-ignore no-explicit-any
async function loadFarePricingRow(
  supabase: any,
  serviceAreaId: string | null,
  vehicleTypeId: string | null,
): Promise<Record<string, unknown> | null> {
  if (!serviceAreaId) return null;

  const pickLatest = (rows: Record<string, unknown>[] | null): Record<string, unknown> | null => {
    if (!rows || rows.length === 0) return null;
    if (rows.length > 1) {
      console.warn(
        "[waitingAdminConfig] multiple fare_pricing_settings rows; using latest updated_at",
        { serviceAreaId, vehicleTypeId, count: rows.length },
      );
    }
    return rows[0] ?? null;
  };

  if (vehicleTypeId) {
    const { data } = await supabase
      .from("fare_pricing_settings")
      .select(FARE_PRICING_COLS)
      .eq("service_area_id", serviceAreaId)
      .eq("vehicle_type_id", vehicleTypeId)
      .order("updated_at", { ascending: false })
      .limit(5);
    const row = pickLatest((data as Record<string, unknown>[] | null) ?? null);
    if (row) return row;
  }

  {
    const { data } = await supabase
      .from("fare_pricing_settings")
      .select(FARE_PRICING_COLS)
      .eq("service_area_id", serviceAreaId)
      .is("vehicle_type_id", null)
      .order("updated_at", { ascending: false })
      .limit(5);
    return pickLatest((data as Record<string, unknown>[] | null) ?? null);
  }
  // Do NOT fall back to an arbitrary other vehicle_type_id for this SA.
}

/**
 * Load SA dispatch row. When serviceAreaId is known, do NOT fall back to global.
 */
// deno-lint-ignore no-explicit-any
async function loadDispatchRow(
  supabase: any,
  serviceAreaId: string | null,
): Promise<Record<string, unknown> | null> {
  if (serviceAreaId) {
    const { data } = await supabase
      .from("dispatch_settings")
      .select(DISPATCH_COLS)
      .eq("service_area_id", serviceAreaId)
      .maybeSingle();
    return data ? (data as Record<string, unknown>) : null;
  }
  // Only when SA unknown (should be rare): global singleton.
  const { data } = await supabase
    .from("dispatch_settings")
    .select(DISPATCH_COLS)
    .is("service_area_id", null)
    .maybeSingle();
  return data ? (data as Record<string, unknown>) : null;
}

// deno-lint-ignore no-explicit-any
async function loadStopWaitingSettingsRow(
  supabase: any,
  serviceAreaId: string | null,
): Promise<Record<string, unknown> | null> {
  if (!serviceAreaId) return null;
  const { data } = await supabase
    .from("stop_waiting_settings")
    .select(STOP_WAITING_SETTINGS_COLS)
    .eq("service_area_id", serviceAreaId)
    .maybeSingle();
  return data ? (data as Record<string, unknown>) : null;
}

export function resolvePickupGraceSeconds(
  fareRow: Record<string, unknown> | null,
  dispatchRow: Record<string, unknown> | null,
): { seconds: number; source: AdminWaitingConfigSnapshot["pickup_grace_source"] } {
  const fareMinutes = asNonNegInt(fareRow?.free_waiting_minutes);
  if (fareMinutes != null) {
    return { seconds: fareMinutes * 60, source: "fare_pricing" };
  }
  const dispatchSeconds = asNonNegInt(dispatchRow?.pickup_waiting_grace_period_seconds);
  if (dispatchSeconds != null) {
    return { seconds: dispatchSeconds, source: "dispatch" };
  }
  return { seconds: 0, source: "unavailable" };
}

export function resolveStopGraceSeconds(
  fareRow: Record<string, unknown> | null,
  dispatchRow: Record<string, unknown> | null,
  stopWaitingRow: Record<string, unknown> | null = null,
): { seconds: number; source: AdminWaitingConfigSnapshot["stop_grace_source"] } {
  const stopSettingsGrace = asNonNegInt(stopWaitingRow?.stop_waiting_grace_period_seconds);
  if (stopSettingsGrace != null) {
    return { seconds: stopSettingsGrace, source: "stop_waiting_settings" };
  }
  const dispatchGrace = asNonNegInt(dispatchRow?.stop_waiting_grace_period_seconds);
  if (dispatchGrace != null) {
    return { seconds: dispatchGrace, source: "dispatch_settings" };
  }
  const fareMinutes = asNonNegInt(fareRow?.stop_waiting_grace_period_minutes);
  if (fareMinutes != null) {
    return { seconds: fareMinutes * 60, source: "fare_pricing" };
  }
  return { seconds: DEFAULT_STOP_WAITING_GRACE_SECONDS, source: "default" };
}

export function resolveWaitingChargeIntervalSeconds(
  dispatchRow: Record<string, unknown> | null,
  stopWaitingRow: Record<string, unknown> | null,
): { seconds: number; source: AdminWaitingConfigSnapshot["waiting_charge_interval_source"] } {
  // Canonical: stop_waiting_settings first (matches Admin primary write + stop-workflow merge).
  const fromStop = asNonNegInt(stopWaitingRow?.stop_waiting_charge_interval_seconds);
  if (fromStop != null && fromStop > 0) {
    return { seconds: fromStop, source: "stop_waiting_settings" };
  }
  const fromDispatch = asNonNegInt(dispatchRow?.stop_waiting_charge_interval_seconds);
  if (fromDispatch != null && fromDispatch > 0) {
    return { seconds: fromDispatch, source: "dispatch_settings" };
  }
  return { seconds: 0, source: "unavailable" };
}

/**
 * Pickup paid charge using completed intervals only (not continuous prorate).
 * amount = floor(paidSeconds / interval) * round(ratePencePerMin * interval / 60)
 */
export function computePickupWaitingChargePence(input: {
  paidSeconds: number;
  ratePencePerMinute: number;
  intervalSeconds: number;
  maxMinutes: number;
}): {
  charge_pence: number;
  intervals_charged: number;
  paid_seconds_capped: number;
  interval_seconds: number;
  pence_per_interval: number;
  rounding: "completed_intervals";
} {
  const maxPaidSeconds =
    input.maxMinutes > 0
      ? Math.max(0, Math.round(input.maxMinutes) * 60)
      : Number.MAX_SAFE_INTEGER;
  const paidSeconds = Math.max(0, Math.min(Math.floor(input.paidSeconds), maxPaidSeconds));
  const interval = Math.max(0, Math.floor(input.intervalSeconds));
  const rate = Math.max(0, Math.round(input.ratePencePerMinute));

  if (interval <= 0 || rate <= 0 || paidSeconds <= 0) {
    return {
      charge_pence: 0,
      intervals_charged: 0,
      paid_seconds_capped: paidSeconds,
      interval_seconds: interval,
      pence_per_interval: 0,
      rounding: "completed_intervals",
    };
  }

  const pencePerInterval = Math.round((rate * interval) / 60);
  const intervals = Math.floor(paidSeconds / interval);
  return {
    charge_pence: intervals * pencePerInterval,
    intervals_charged: intervals,
    paid_seconds_capped: paidSeconds,
    interval_seconds: interval,
    pence_per_interval: pencePerInterval,
    rounding: "completed_intervals",
  };
}

export function buildAdminWaitingConfigSnapshot(
  fareRow: Record<string, unknown> | null,
  dispatchRow: Record<string, unknown> | null,
  stopWaitingRow: Record<string, unknown> | null = null,
): AdminWaitingConfigSnapshot {
  const pickupGrace = resolvePickupGraceSeconds(fareRow, dispatchRow);
  const stopGrace = resolveStopGraceSeconds(fareRow, dispatchRow, stopWaitingRow);
  const interval = resolveWaitingChargeIntervalSeconds(dispatchRow, stopWaitingRow);

  const freeWaitMin = pickupGrace.seconds / 60;
  const noShowWaitMinRaw = asNonNegInt(fareRow?.no_show_wait_time_minutes);
  const noShowWaitMin = noShowWaitMinRaw != null ? noShowWaitMinRaw : freeWaitMin;

  // Fare paid flag first (recalculate_on_waiting mirrors Admin "Enable Pickup Waiting Charge").
  const farePaid =
    asBool(fareRow?.pickup_paid_waiting_enabled) ??
    asBool(fareRow?.recalculate_on_waiting);
  const dispatchPaid = asBool(dispatchRow?.pickup_paid_waiting_enabled);
  const paidEnabled = farePaid ?? dispatchPaid ?? false;

  const fareRate = asNonNegInt(fareRow?.waiting_per_minute_pence);
  const dispatchRate = asNonNegInt(dispatchRow?.pickup_paid_waiting_rate_pence_per_minute);
  const pickupRate = fareRate ?? dispatchRate ?? 0;

  const stopRate =
    asNonNegInt(stopWaitingRow?.stop_waiting_rate_pence_per_minute) ??
    asNonNegInt(dispatchRow?.stop_waiting_rate_pence_per_minute) ??
    asNonNegInt(fareRow?.stop_waiting_rate_pence_per_minute) ??
    0;

  // Max minutes: stop_waiting_settings first, then dispatch projection.
  const stopMaxMinutes =
    (stopWaitingRow?.stop_waiting_max_minutes as number | null | undefined) ??
    (dispatchRow?.stop_waiting_max_minutes as number | null | undefined) ??
    null;

  // Max minutes: Admin dispatch only. Missing → uncapped (0 sentinel in compute).
  const maxMinutesRaw = asNonNegInt(dispatchRow?.pickup_waiting_max_minutes);

  const configAvailable =
    pickupGrace.source !== "unavailable" &&
    (fareRow != null || dispatchRow != null || stopWaitingRow != null);

  const stopRadiusEnabled =
    asBool(stopWaitingRow?.stop_radius_enabled) ??
    asBool(dispatchRow?.stop_radius_enabled) ??
    true;
  const stopRadiusMeters =
    asNonNegInt(stopWaitingRow?.stop_radius_meters) ??
    asNonNegInt(dispatchRow?.stop_radius_meters) ??
    0;

  // Enable: dispatch_settings only — never pickup recalculate_on_waiting.
  const enableStopWaiting =
    asBool(dispatchRow?.enable_stop_waiting_charge) ?? true;

  return {
    free_pickup_waiting_minutes: freeWaitMin,
    free_pickup_waiting_seconds: pickupGrace.seconds,
    pickup_grace_source: pickupGrace.source,
    no_show_waiting_minutes: noShowWaitMin,
    no_show_waiting_seconds: Math.round(noShowWaitMin * 60),
    free_stop_waiting_seconds: stopGrace.seconds,
    stop_grace_source: stopGrace.source,
    pickup_paid_waiting_enabled: paidEnabled,
    pickup_paid_waiting_rate_pence_per_minute: pickupRate,
    pickup_waiting_max_minutes: maxMinutesRaw ?? 0,
    waiting_charge_interval_seconds: interval.seconds,
    waiting_charge_interval_source: interval.source,
    waiting_charge_rounding: "completed_intervals",
    stop_waiting_rate_pence_per_minute: stopRate,
    stop_waiting_max_minutes: stopMaxMinutes,
    enable_stop_waiting_charge: enableStopWaiting,
    pickup_radius_enabled: dispatchRow?.pickup_radius_enabled !== false,
    pickup_radius_meters: (() => {
      const enabled = dispatchRow?.pickup_radius_enabled !== false;
      const raw = asNonNegInt(dispatchRow?.pickup_radius_meters) ?? 0;
      return enabled && raw <= 0 ? 100 : raw;
    })(),
    stop_radius_enabled: stopRadiusEnabled,
    stop_radius_meters: stopRadiusEnabled && stopRadiusMeters <= 0 ? 100 : stopRadiusMeters,
    no_show_fee_pence: Math.max(0, asNonNegInt(fareRow?.no_show_fee_pence) ?? 0),
    no_show_apply_after_arrival_only:
      asBool(fareRow?.no_show_apply_after_arrival_only) ?? true,
    config_available: configAvailable,
  };
}

/** Prefer frozen trip snapshot over live Admin reload. */
export function resolveFrozenOrLiveWaitingConfig(
  frozen: unknown,
  live: AdminWaitingConfigSnapshot,
): AdminWaitingConfigSnapshot {
  if (!frozen || typeof frozen !== "object") return live;
  const f = frozen as Record<string, unknown>;
  const freeSec = asNonNegInt(f.free_pickup_waiting_seconds);
  if (freeSec == null) return live;
  const interval = asNonNegInt(f.waiting_charge_interval_seconds) ?? live.waiting_charge_interval_seconds;
  return {
    ...live,
    free_pickup_waiting_minutes:
      asNonNegInt(f.free_pickup_waiting_minutes) ?? freeSec / 60,
    free_pickup_waiting_seconds: freeSec,
    pickup_grace_source:
      (f.pickup_grace_source as AdminWaitingConfigSnapshot["pickup_grace_source"]) ??
      live.pickup_grace_source,
    pickup_paid_waiting_enabled:
      asBool(f.pickup_paid_waiting_enabled) ?? live.pickup_paid_waiting_enabled,
    pickup_paid_waiting_rate_pence_per_minute:
      asNonNegInt(f.pickup_paid_waiting_rate_pence_per_minute) ??
      live.pickup_paid_waiting_rate_pence_per_minute,
    pickup_waiting_max_minutes:
      asNonNegInt(f.pickup_waiting_max_minutes) ?? live.pickup_waiting_max_minutes,
    waiting_charge_interval_seconds: interval,
    waiting_charge_interval_source:
      (f.waiting_charge_interval_source as AdminWaitingConfigSnapshot["waiting_charge_interval_source"]) ??
      live.waiting_charge_interval_source,
    waiting_charge_rounding: "completed_intervals",
    config_available: asBool(f.config_available) ?? true,
  };
}

// deno-lint-ignore no-explicit-any
export async function loadAdminWaitingConfig(
  supabase: any,
  serviceAreaId: string | null,
  vehicleTypeId: string | null = null,
): Promise<AdminWaitingConfigSnapshot> {
  const [fareRow, dispatchRow, stopWaitingRow] = await Promise.all([
    loadFarePricingRow(supabase, serviceAreaId, vehicleTypeId),
    loadDispatchRow(supabase, serviceAreaId),
    loadStopWaitingSettingsRow(supabase, serviceAreaId),
  ]);
  const snapshot = buildAdminWaitingConfigSnapshot(fareRow, dispatchRow, stopWaitingRow);
  console.log("WAITING_ADMIN_SETTINGS_LOADED", {
    service_area_id: serviceAreaId,
    vehicle_type_id: vehicleTypeId,
    pickup_grace_source: snapshot.pickup_grace_source,
    free_pickup_waiting_seconds: snapshot.free_pickup_waiting_seconds,
    pickup_paid_waiting_enabled: snapshot.pickup_paid_waiting_enabled,
    pickup_paid_waiting_rate_pence_per_minute: snapshot.pickup_paid_waiting_rate_pence_per_minute,
    waiting_charge_interval_seconds: snapshot.waiting_charge_interval_seconds,
    waiting_charge_interval_source: snapshot.waiting_charge_interval_source,
    config_available: snapshot.config_available,
    stop_grace_source: snapshot.stop_grace_source,
    free_stop_waiting_seconds: snapshot.free_stop_waiting_seconds,
  });
  return snapshot;
}

export function buildPickupWaitingSnapshot(input: {
  driverArrivedAt: string | null;
  waitingStatus: "not_started" | "blocked_outside_radius" | "free_waiting" | "paid_waiting" | "unavailable";
  config: AdminWaitingConfigSnapshot;
  nowMs?: number;
  /**
   * Trusted in-radius counted waiting seconds (segment clock).
   * When provided, free-wait remaining + no-show eligibility use counted time —
   * never Arrived wall-clock alone.
   */
  countedInRadiusSeconds?: number | null;
}): PickupWaitingStateSnapshot {
  const { driverArrivedAt, waitingStatus, config } = input;
  const nowMs = input.nowMs ?? Date.now();
  const countedRaw = input.countedInRadiusSeconds;
  const useCounted =
    countedRaw != null && Number.isFinite(Number(countedRaw));
  const countedElapsed = useCounted
    ? Math.max(0, Math.floor(Number(countedRaw)))
    : null;

  if (!config.config_available && waitingStatus === "unavailable") {
    return {
      driver_arrived_at: driverArrivedAt,
      pickup_waiting_state: "unavailable",
      pickup_waiting_free_expires_at: null,
      pickup_waiting_elapsed_seconds: 0,
      pickup_waiting_grace_remaining_seconds: 0,
      no_show_eligible_at: null,
      no_show_eligible: false,
      no_show_remaining_seconds: 0,
      admin_waiting_config_snapshot: config,
    };
  }

  if (!driverArrivedAt) {
    return {
      driver_arrived_at: null,
      pickup_waiting_state: "not_arrived",
      pickup_waiting_free_expires_at: null,
      pickup_waiting_elapsed_seconds: 0,
      pickup_waiting_grace_remaining_seconds: config.free_pickup_waiting_seconds,
      no_show_eligible_at: null,
      no_show_eligible: false,
      no_show_remaining_seconds: config.no_show_waiting_seconds,
      admin_waiting_config_snapshot: config,
    };
  }

  const wallElapsed = elapsedSecondsSince(driverArrivedAt, nowMs);
  const elapsed = countedElapsed ?? wallElapsed;
  const graceRemaining = Math.max(0, config.free_pickup_waiting_seconds - elapsed);
  // Wall ISO free-expires remains a session anchor; grace/no-show remaining use counted when set.
  const freeExpiresAt = addSecondsIso(driverArrivedAt, config.free_pickup_waiting_seconds);
  // Counted path: never advertise a wall-clock eligible_at (Driver UI must use remaining seconds).
  const noShowEligibleAt = useCounted
    ? null
    : addSecondsIso(driverArrivedAt, config.no_show_waiting_seconds);
  const noShowRemaining = Math.max(0, config.no_show_waiting_seconds - elapsed);
  const hasArrivalForNoShow = !config.no_show_apply_after_arrival_only || !!driverArrivedAt;
  const noShowEligible =
    hasArrivalForNoShow &&
    (config.no_show_waiting_seconds <= 0 || elapsed >= config.no_show_waiting_seconds);

  let pickupState: PickupWaitingStateSnapshot["pickup_waiting_state"] = waitingStatus;
  if (waitingStatus === "free_waiting" && elapsed >= config.free_pickup_waiting_seconds && config.pickup_paid_waiting_enabled) {
    pickupState = "paid_waiting";
  } else if (waitingStatus === "free_waiting" && elapsed < config.free_pickup_waiting_seconds) {
    pickupState = "free_waiting";
  }

  return {
    driver_arrived_at: driverArrivedAt,
    pickup_waiting_state: pickupState,
    pickup_waiting_free_expires_at: freeExpiresAt,
    pickup_waiting_elapsed_seconds: elapsed,
    pickup_waiting_grace_remaining_seconds: graceRemaining,
    no_show_eligible_at: noShowEligibleAt,
    no_show_eligible: noShowEligible,
    no_show_remaining_seconds: noShowRemaining,
    admin_waiting_config_snapshot: config,
  };
}

export function buildStopWaitingSnapshot(input: {
  stopArrivedAt: string | null;
  waitingStatus: "not_started" | "blocked_outside_radius" | "free_waiting" | "paid_waiting";
  config: AdminWaitingConfigSnapshot;
  nowMs?: number;
}): StopWaitingStateSnapshot {
  const { stopArrivedAt, waitingStatus, config } = input;
  const nowMs = input.nowMs ?? Date.now();

  if (!stopArrivedAt) {
    return {
      stop_arrived_at: null,
      stop_waiting_state: "not_arrived",
      stop_waiting_free_expires_at: null,
      stop_waiting_elapsed_seconds: 0,
      stop_waiting_grace_remaining_seconds: config.free_stop_waiting_seconds,
      admin_waiting_config_snapshot: config,
    };
  }

  const elapsed = elapsedSecondsSince(stopArrivedAt, nowMs);
  const graceRemaining = Math.max(0, config.free_stop_waiting_seconds - elapsed);
  const freeExpiresAt = addSecondsIso(stopArrivedAt, config.free_stop_waiting_seconds);

  let stopState: StopWaitingStateSnapshot["stop_waiting_state"] = waitingStatus;
  if (waitingStatus === "free_waiting" && elapsed >= config.free_stop_waiting_seconds && config.enable_stop_waiting_charge) {
    stopState = "paid_waiting";
  }

  return {
    stop_arrived_at: stopArrivedAt,
    stop_waiting_state: stopState,
    stop_waiting_free_expires_at: freeExpiresAt,
    stop_waiting_elapsed_seconds: elapsed,
    stop_waiting_grace_remaining_seconds: graceRemaining,
    admin_waiting_config_snapshot: config,
  };
}
