/**
 * No-show eligibility — fare_pricing_settings (lifecycle) + dispatch_settings (GPS radius).
 * Counted in-radius waiting seconds are required — Arrived wall-time alone is not enough.
 */

import { isTripAtPickupStatus } from "./pickupWaiting.ts";
import {
  DEFAULT_WAITING_RADIUS_METERS,
  noShowEligibleFromCountedSeconds,
} from "./waitingSegmentClock.ts";

export interface NoShowPricingRules {
  noShowWaitMinutes: number;
  freeWaitingMinutes: number;
  noShowFeePence: number;
  noShowAfterArrivalOnly: boolean;
}

export interface NoShowDispatchRules {
  pickupRadiusEnabled: boolean;
  pickupRadiusMeters: number;
}

const PRICING_COLS =
  "no_show_wait_time_minutes, no_show_fee_pence, no_show_apply_after_arrival_only, free_waiting_minutes";

const DISPATCH_COLS = "pickup_radius_enabled, pickup_radius_meters";

// deno-lint-ignore no-explicit-any
export async function loadNoShowPricingRules(
  supabase: any,
  serviceAreaId: string | null,
  vehicleTypeId: string | null,
): Promise<NoShowPricingRules> {
  let row: Record<string, unknown> | null = null;

  if (serviceAreaId) {
    if (vehicleTypeId) {
      const { data } = await supabase
        .from("fare_pricing_settings")
        .select(PRICING_COLS)
        .eq("service_area_id", serviceAreaId)
        .eq("vehicle_type_id", vehicleTypeId)
        .maybeSingle();
      if (data) row = data as Record<string, unknown>;
    }
    if (!row) {
      const { data } = await supabase
        .from("fare_pricing_settings")
        .select(PRICING_COLS)
        .eq("service_area_id", serviceAreaId)
        .is("vehicle_type_id", null)
        .maybeSingle();
      if (data) row = data as Record<string, unknown>;
    }
    if (!row) {
      const { data } = await supabase
        .from("fare_pricing_settings")
        .select(PRICING_COLS)
        .eq("service_area_id", serviceAreaId)
        .limit(1)
        .maybeSingle();
      if (data) row = data as Record<string, unknown>;
    }
  }

  const freeWait =
    typeof row?.free_waiting_minutes === "number" ? row.free_waiting_minutes : 0;
  const noShowWaitRaw = row?.no_show_wait_time_minutes;
  const noShowWait =
    typeof noShowWaitRaw === "number" ? noShowWaitRaw : freeWait;

  return {
    noShowWaitMinutes: Math.max(0, noShowWait),
    freeWaitingMinutes: Math.max(0, freeWait),
    noShowFeePence: Math.max(0, (row?.no_show_fee_pence as number) ?? 0),
    noShowAfterArrivalOnly: (row?.no_show_apply_after_arrival_only as boolean) ?? true,
  };
}

// deno-lint-ignore no-explicit-any
export async function loadNoShowDispatchRules(
  supabase: any,
  serviceAreaId: string | null,
): Promise<NoShowDispatchRules> {
  const selectCols = DISPATCH_COLS;
  let settings: Record<string, unknown> | null = null;

  if (serviceAreaId) {
    const { data } = await supabase
      .from("dispatch_settings")
      .select(selectCols)
      .eq("service_area_id", serviceAreaId)
      .maybeSingle();
    if (data) settings = data as Record<string, unknown>;
  }
  if (!settings) {
    const { data } = await supabase
      .from("dispatch_settings")
      .select(selectCols)
      .is("service_area_id", null)
      .maybeSingle();
    if (data) settings = data as Record<string, unknown>;
  }

  const radiusMeters = settings?.pickup_radius_meters;
  const enabled = (settings?.pickup_radius_enabled as boolean) ?? true;
  const configured =
    typeof radiusMeters === "number" && radiusMeters > 0 ? radiusMeters : 0;
  return {
    pickupRadiusEnabled: enabled,
    pickupRadiusMeters: enabled
      ? configured > 0
        ? configured
        : DEFAULT_WAITING_RADIUS_METERS
      : configured,
  };
}

export function minutesSince(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / 60_000;
}

export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function evaluateCanMarkNoShow(input: {
  tripStatus: string | null | undefined;
  arrivedAtIso: string | null;
  pricing: NoShowPricingRules;
  dispatch: NoShowDispatchRules;
  /** Trusted in-radius counted waiting seconds (segment clock). Required for eligibility. */
  countedInRadiusSeconds: number;
  driverLat?: number;
  driverLng?: number;
  pickupLat?: number | null;
  pickupLng?: number | null;
}): { canMark: boolean; message: string } {
  const {
    tripStatus,
    arrivedAtIso,
    pricing,
    dispatch,
    countedInRadiusSeconds,
    driverLat,
    driverLng,
    pickupLat,
    pickupLng,
  } = input;

  if (!isTripAtPickupStatus(tripStatus)) {
    return {
      canMark: false,
      message: "Trip must be at pickup (arrived) to mark a no-show.",
    };
  }

  if (pricing.noShowAfterArrivalOnly && !arrivedAtIso) {
    return {
      canMark: false,
      message: "Mark Arrived at pickup before you can report a no-show.",
    };
  }

  if (!arrivedAtIso) {
    return {
      canMark: false,
      message: "No arrival time recorded — tap Arrived at pickup first.",
    };
  }

  const waitMinutes =
    pricing.noShowWaitMinutes > 0 ? pricing.noShowWaitMinutes : pricing.freeWaitingMinutes;

  // No-show requires valid counted in-radius waiting — not Arrived wall-time alone.
  if (
    !noShowEligibleFromCountedSeconds({
      countedSeconds: countedInRadiusSeconds,
      requiredWaitMinutes: waitMinutes,
    })
  ) {
    const needSec = Math.max(0, waitMinutes) * 60;
    const remainingSec = Math.max(0, needSec - Math.floor(countedInRadiusSeconds));
    const remMin = Math.floor(remainingSec / 60);
    const remSec = remainingSec % 60;
    console.log("NO_SHOW_BLOCKED_REASON", {
      reason: "counted_in_radius_wait_not_elapsed",
      arrived_at: arrivedAtIso,
      counted_in_radius_seconds: countedInRadiusSeconds,
      required_counted_seconds: needSec,
      wall_elapsed_minutes: minutesSince(arrivedAtIso),
    });
    return {
      canMark: false,
      message: `No-show is not available yet. ${remMin}:${remSec.toString().padStart(2, "0")} remaining (in-radius waiting).`,
    };
  }

  console.log("NO_SHOW_ELIGIBLE", {
    arrived_at: arrivedAtIso,
    counted_in_radius_seconds: countedInRadiusSeconds,
    required_total_minutes_from_arrival: waitMinutes,
  });

  if (
    dispatch.pickupRadiusEnabled &&
    pickupLat != null &&
    pickupLng != null
  ) {
    if (typeof driverLat !== "number" || typeof driverLng !== "number") {
      return {
        canMark: false,
        message: "Enable location services — you must be at the pickup to mark a no-show.",
      };
    }
    const distance = haversineMeters(driverLat, driverLng, pickupLat, pickupLng);
    if (distance > dispatch.pickupRadiusMeters) {
      return {
        canMark: false,
        message: `You must be within ${dispatch.pickupRadiusMeters}m of the pickup (currently ${Math.round(distance)}m away).`,
      };
    }
  }

  return { canMark: true, message: "No-show recorded." };
}
