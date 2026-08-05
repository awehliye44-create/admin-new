/**
 * Admin waiting / no-show settings SSOT — merges fare_pricing_settings + dispatch_settings + stop_waiting_settings.
 * Pickup grace: fare_pricing.free_waiting_minutes (canonical) with dispatch fallback.
 * Stop grace: stop_waiting_settings.stop_waiting_grace_period_seconds (canonical, admin writes minutes * 60),
 * with dispatch_settings + fare_pricing.stop_waiting_grace_period_minutes fallbacks; default 60s (1 min).
 */

export const DEFAULT_STOP_WAITING_GRACE_SECONDS = 60;

export type AdminWaitingConfigSnapshot = {
  free_pickup_waiting_minutes: number;
  free_pickup_waiting_seconds: number;
  pickup_grace_source: "fare_pricing" | "dispatch";
  no_show_waiting_minutes: number;
  no_show_waiting_seconds: number;
  free_stop_waiting_seconds: number;
  stop_grace_source: "stop_waiting_settings" | "dispatch_settings" | "fare_pricing" | "default";
  pickup_paid_waiting_enabled: boolean;
  pickup_paid_waiting_rate_pence_per_minute: number;
  pickup_waiting_max_minutes: number;
  stop_waiting_rate_pence_per_minute: number;
  stop_waiting_max_minutes: number | null;
  enable_stop_waiting_charge: boolean;
  pickup_radius_enabled: boolean;
  pickup_radius_meters: number;
  stop_radius_enabled: boolean;
  stop_radius_meters: number;
  no_show_fee_pence: number;
  no_show_apply_after_arrival_only: boolean;
};

export type PickupWaitingStateSnapshot = {
  driver_arrived_at: string | null;
  pickup_waiting_state: "not_arrived" | "blocked_outside_radius" | "free_waiting" | "paid_waiting" | "not_started";
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
  "id, updated_at, free_waiting_minutes, no_show_wait_time_minutes, no_show_fee_pence, no_show_apply_after_arrival_only, pickup_paid_waiting_enabled, waiting_per_minute_pence, stop_waiting_rate_pence_per_minute, stop_waiting_grace_period_minutes";

const DISPATCH_COLS =
  "pickup_waiting_grace_period_seconds, pickup_paid_waiting_enabled, pickup_paid_waiting_rate_pence_per_minute, pickup_waiting_max_minutes, pickup_radius_enabled, pickup_radius_meters, enable_stop_waiting_charge, stop_radius_enabled, stop_radius_meters, stop_waiting_grace_period_seconds, stop_waiting_rate_pence_per_minute, stop_waiting_max_minutes";

const STOP_WAITING_SETTINGS_COLS =
  "stop_waiting_grace_period_seconds, stop_waiting_rate_pence_per_minute, stop_waiting_max_minutes";

function elapsedSecondsSince(iso: string, nowMs = Date.now()): number {
  return Math.max(0, Math.floor((nowMs - new Date(iso).getTime()) / 1000));
}

function addSecondsIso(iso: string, seconds: number): string {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString();
}

/**
 * Prefer the newest fare_pricing_settings row for the service area.
 * Duplicate rows (same area / vehicle) must not be picked arbitrarily via limit(1).
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
    const row = pickLatest((data as Record<string, unknown>[] | null) ?? null);
    if (row) return row;
  }

  {
    const { data } = await supabase
      .from("fare_pricing_settings")
      .select(FARE_PRICING_COLS)
      .eq("service_area_id", serviceAreaId)
      .order("updated_at", { ascending: false })
      .limit(5);
    return pickLatest((data as Record<string, unknown>[] | null) ?? null);
  }
}

// deno-lint-ignore no-explicit-any
async function loadDispatchRow(
  supabase: any,
  serviceAreaId: string | null,
): Promise<Record<string, unknown> | null> {
  let row: Record<string, unknown> | null = null;
  if (serviceAreaId) {
    const { data } = await supabase
      .from("dispatch_settings")
      .select(DISPATCH_COLS)
      .eq("service_area_id", serviceAreaId)
      .maybeSingle();
    if (data) row = data as Record<string, unknown>;
  }
  if (!row) {
    const { data } = await supabase
      .from("dispatch_settings")
      .select(DISPATCH_COLS)
      .is("service_area_id", null)
      .maybeSingle();
    if (data) row = data as Record<string, unknown>;
  }
  if (!row) {
    const { data } = await supabase
      .from("dispatch_settings")
      .select(DISPATCH_COLS)
      .limit(1)
      .maybeSingle();
    if (data) row = data as Record<string, unknown>;
  }
  return row;
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
  const fareMinutes = fareRow?.free_waiting_minutes;
  if (typeof fareMinutes === "number" && fareMinutes >= 0) {
    return { seconds: Math.round(fareMinutes * 60), source: "fare_pricing" };
  }
  const dispatchSeconds = dispatchRow?.pickup_waiting_grace_period_seconds;
  if (typeof dispatchSeconds === "number" && dispatchSeconds >= 0) {
    return { seconds: dispatchSeconds, source: "dispatch" };
  }
  return { seconds: 0, source: "fare_pricing" };
}

export function resolveStopGraceSeconds(
  fareRow: Record<string, unknown> | null,
  dispatchRow: Record<string, unknown> | null,
  stopWaitingRow: Record<string, unknown> | null = null,
): { seconds: number; source: AdminWaitingConfigSnapshot["stop_grace_source"] } {
  const stopSettingsGrace = stopWaitingRow?.stop_waiting_grace_period_seconds;
  if (typeof stopSettingsGrace === "number" && stopSettingsGrace >= 0) {
    return { seconds: stopSettingsGrace, source: "stop_waiting_settings" };
  }
  const dispatchGrace = dispatchRow?.stop_waiting_grace_period_seconds;
  if (typeof dispatchGrace === "number" && dispatchGrace >= 0) {
    return { seconds: dispatchGrace, source: "dispatch_settings" };
  }
  const fareMinutes = fareRow?.stop_waiting_grace_period_minutes;
  if (typeof fareMinutes === "number" && fareMinutes >= 0) {
    return { seconds: Math.round(fareMinutes * 60), source: "fare_pricing" };
  }
  return { seconds: DEFAULT_STOP_WAITING_GRACE_SECONDS, source: "default" };
}

export function buildAdminWaitingConfigSnapshot(
  fareRow: Record<string, unknown> | null,
  dispatchRow: Record<string, unknown> | null,
  stopWaitingRow: Record<string, unknown> | null = null,
): AdminWaitingConfigSnapshot {
  const pickupGrace = resolvePickupGraceSeconds(fareRow, dispatchRow);
  const stopGrace = resolveStopGraceSeconds(fareRow, dispatchRow, stopWaitingRow);

  const freeWaitMin = pickupGrace.seconds / 60;
  const noShowWaitMinRaw = fareRow?.no_show_wait_time_minutes;
  const noShowWaitMin =
    typeof noShowWaitMinRaw === "number" && noShowWaitMinRaw >= 0
      ? noShowWaitMinRaw
      : freeWaitMin;

  const paidEnabled =
    (dispatchRow?.pickup_paid_waiting_enabled as boolean | undefined) ??
    (fareRow?.pickup_paid_waiting_enabled as boolean | undefined) ??
    false;

  const pickupRate =
    (dispatchRow?.pickup_paid_waiting_rate_pence_per_minute as number | undefined) ??
    (fareRow?.waiting_per_minute_pence as number | undefined) ??
    0;

  const stopRate =
    (dispatchRow?.stop_waiting_rate_pence_per_minute as number | undefined) ??
    (fareRow?.stop_waiting_rate_pence_per_minute as number | undefined) ??
    0;

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
    pickup_waiting_max_minutes:
      (dispatchRow?.pickup_waiting_max_minutes as number | undefined) ?? 15,
    stop_waiting_rate_pence_per_minute: stopRate,
    stop_waiting_max_minutes:
      (dispatchRow?.stop_waiting_max_minutes as number | null | undefined) ?? null,
    enable_stop_waiting_charge: dispatchRow?.enable_stop_waiting_charge !== false,
    pickup_radius_enabled: dispatchRow?.pickup_radius_enabled !== false,
    pickup_radius_meters: (dispatchRow?.pickup_radius_meters as number | undefined) ?? 0,
    stop_radius_enabled: dispatchRow?.stop_radius_enabled !== false,
    stop_radius_meters: (dispatchRow?.stop_radius_meters as number | undefined) ?? 0,
    no_show_fee_pence: Math.max(0, (fareRow?.no_show_fee_pence as number | undefined) ?? 0),
    no_show_apply_after_arrival_only:
      (fareRow?.no_show_apply_after_arrival_only as boolean | undefined) ?? true,
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
    stop_grace_source: snapshot.stop_grace_source,
    free_stop_waiting_seconds: snapshot.free_stop_waiting_seconds,
    no_show_waiting_minutes: snapshot.no_show_waiting_minutes,
  });
  return snapshot;
}

export function buildPickupWaitingSnapshot(input: {
  driverArrivedAt: string | null;
  waitingStatus: "not_started" | "blocked_outside_radius" | "free_waiting" | "paid_waiting";
  config: AdminWaitingConfigSnapshot;
  nowMs?: number;
}): PickupWaitingStateSnapshot {
  const { driverArrivedAt, waitingStatus, config } = input;
  const nowMs = input.nowMs ?? Date.now();

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

  const elapsed = elapsedSecondsSince(driverArrivedAt, nowMs);
  const graceRemaining = Math.max(0, config.free_pickup_waiting_seconds - elapsed);
  const freeExpiresAt = addSecondsIso(driverArrivedAt, config.free_pickup_waiting_seconds);
  const noShowEligibleAt = addSecondsIso(driverArrivedAt, config.no_show_waiting_seconds);
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

  console.log("PICKUP_WAITING_ANCHOR_DRIVER_ARRIVED_AT", {
    driver_arrived_at: driverArrivedAt,
    elapsed_seconds: elapsed,
    free_pickup_waiting_seconds: config.free_pickup_waiting_seconds,
    pickup_waiting_state: pickupState,
  });
  console.log("NO_SHOW_ANCHOR_DRIVER_ARRIVED_AT", {
    driver_arrived_at: driverArrivedAt,
    no_show_eligible: noShowEligible,
    no_show_eligible_at: noShowEligibleAt,
    no_show_waiting_seconds: config.no_show_waiting_seconds,
  });

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

  console.log("STOP_WAITING_ANCHOR_STOP_ARRIVED_AT", {
    stop_arrived_at: stopArrivedAt,
    elapsed_seconds: elapsed,
    free_stop_waiting_seconds: config.free_stop_waiting_seconds,
    stop_waiting_state: stopState,
  });

  return {
    stop_arrived_at: stopArrivedAt,
    stop_waiting_state: stopState,
    stop_waiting_free_expires_at: freeExpiresAt,
    stop_waiting_elapsed_seconds: elapsed,
    stop_waiting_grace_remaining_seconds: graceRemaining,
    admin_waiting_config_snapshot: config,
  };
}
