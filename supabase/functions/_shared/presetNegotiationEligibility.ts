/**
 * Preset negotiation eligibility SSOT (instant/on-demand only).
 * Scheduled/pre-booked trips are never eligible.
 */

import { checkOfferSchedule } from "./offerSchedule.ts";
import {
  buildPresetOptionsFromAdminOffers,
  PRESET_SLOT_COUNT,
  type AdminPresetOfferRow,
  type PresetOptionCanonical,
} from "./presetOptionsCanonical.ts";

export type ScheduledTripLike = {
  is_scheduled?: boolean | null;
  dispatch_mode?: string | null;
  trip_type?: string | null;
  negotiation_disabled?: boolean | null;
  negotiation_status?: string | null;
};

export type PresetConfigLike = {
  is_enabled: boolean;
  schedule_enabled: boolean;
  schedule_days: number[];
  schedule_start_time: string;
  schedule_end_time: string;
  price_mode?: string | null;
  countdown_seconds?: number | null;
  countdown_enabled?: boolean | null;
};

export type PresetEligibilityReason =
  | "attached"
  | "negotiation_disabled"
  | "ineligible_scheduled"
  | "offers_disabled"
  | "outside_schedule"
  | "insufficient_slots"
  | "missing_base_fare"
  | "missing_service_area";

/** Audited scheduled-trip SSOT — do not add scheduled_at as a second identifier. */
export function isScheduledTripIneligibleForPresetNegotiation(
  trip: ScheduledTripLike,
): boolean {
  return (
    trip.is_scheduled === true
    || trip.dispatch_mode === "scheduled"
    || trip.trip_type === "scheduled"
  );
}

export function tripConsumedNegotiationChance(trip: ScheduledTripLike): boolean {
  return (
    trip.negotiation_disabled === true
    || trip.negotiation_status === "failed"
  );
}

export function normalizeCountdownSeconds(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  if (rounded < 5 || rounded > 120) return null;
  return rounded;
}

export function resolvePresetNegotiation(args: {
  trip: ScheduledTripLike;
  serviceAreaId: string | null | undefined;
  baseFarePence: number;
  config: PresetConfigLike | null;
  offers: AdminPresetOfferRow[];
  timezone: string;
  now?: Date;
}): {
  ok: boolean;
  reason: PresetEligibilityReason;
  presetOptions: PresetOptionCanonical[];
  countdownSeconds: number | null;
} {
  if (!args.serviceAreaId) {
    return { ok: false, reason: "missing_service_area", presetOptions: [], countdownSeconds: null };
  }
  if (tripConsumedNegotiationChance(args.trip)) {
    return { ok: false, reason: "negotiation_disabled", presetOptions: [], countdownSeconds: null };
  }
  if (isScheduledTripIneligibleForPresetNegotiation(args.trip)) {
    return { ok: false, reason: "ineligible_scheduled", presetOptions: [], countdownSeconds: null };
  }
  if (args.baseFarePence <= 0) {
    return { ok: false, reason: "missing_base_fare", presetOptions: [], countdownSeconds: null };
  }

  const schedule = checkOfferSchedule(args.config, args.timezone || "UTC", args.now);
  if (!schedule.offersEnabled) {
    return { ok: false, reason: "offers_disabled", presetOptions: [], countdownSeconds: null };
  }
  if (!schedule.offersAllowedNow) {
    return { ok: false, reason: "outside_schedule", presetOptions: [], countdownSeconds: null };
  }

  const presetOptions = buildPresetOptionsFromAdminOffers(
    args.baseFarePence,
    args.offers,
    args.config?.price_mode ?? "multiplier",
  );
  if (presetOptions.length !== PRESET_SLOT_COUNT) {
    return { ok: false, reason: "insufficient_slots", presetOptions: [], countdownSeconds: null };
  }

  const countdownSeconds =
    args.config?.countdown_enabled === false
      ? null
      : normalizeCountdownSeconds(args.config?.countdown_seconds);

  return {
    ok: true,
    reason: "attached",
    presetOptions,
    countdownSeconds,
  };
}

/** Snapshot fields for a driver offer when negotiation is attached. Never auto-accept. */
export function presetNegotiationSnapshotFields(args: {
  baseFarePence: number;
  presetOptions: PresetOptionCanonical[];
  countdownSeconds: number | null;
}): Record<string, unknown> {
  const firstKey = args.presetOptions[0]?.key ?? null;
  const fields: Record<string, unknown> = {
    baseFarePence: args.baseFarePence,
    preset_options: args.presetOptions,
    presets_enabled: true,
    negotiationAllowed: true,
    negotiationLocked: false,
    countdown_auto_select: false,
  };
  if (args.countdownSeconds != null) {
    fields.countdown_seconds = args.countdownSeconds;
    fields.presetCountdownSeconds = args.countdownSeconds;
  }
  if (firstKey) {
    // Visual preselect only — never auto-submit / auto-assign.
    fields.default_selected_offer_id = firstKey;
  }
  return fields;
}
