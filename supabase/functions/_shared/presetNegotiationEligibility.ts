/**
 * Preset negotiation eligibility SSOT (instant/on-demand Customer app only).
 * Scheduled, Corporate, WhatsApp, and stacked offers are never eligible.
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
  corporate_account_id?: string | null;
  booking_source?: string | null;
};

export type PresetNegotiationTripLike = ScheduledTripLike;

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
  | "ineligible_corporate"
  | "ineligible_whatsapp"
  | "ineligible_stacked"
  | "offers_disabled"
  | "outside_schedule"
  | "insufficient_slots"
  | "missing_base_fare"
  | "missing_service_area";

export type PresetNegotiationOfferLike = {
  is_stacked?: boolean | null;
};

export function normalizeTripBookingSource(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_")
    .replace(/\s+/g, "_");
}

/** Canonical trips.booking_source written for onecab.net/whatsapp-booking. */
export const WHATSAPP_BOOKING_SOURCE = "whatsapp_booking";

/**
 * Snapshot placeholders are not a booking channel.
 * WhatsApp/guest web historically omitted booking_source or sent select_vehicle.
 */
export function isPlaceholderBookingSource(raw: unknown): boolean {
  const source = normalizeTripBookingSource(raw);
  return source.length === 0 || source === "select_vehicle";
}

/** Request came from https://onecab.net/whatsapp-booking (Referer path). */
export function isWhatsAppBookingRequest(headers: {
  referer?: string | null;
  origin?: string | null;
} | null | undefined): boolean {
  const referer = String(headers?.referer ?? "").toLowerCase();
  if (referer.includes("whatsapp-booking") || referer.includes("whatsapp_booking")) {
    return true;
  }
  return false;
}

export function resolvePersistedTripBookingSource(input: {
  bodySource?: unknown;
  snapshotSource?: unknown;
  referer?: string | null;
  origin?: string | null;
}): string | undefined {
  const body = String(input.bodySource ?? "").trim();
  const snapshot = String(input.snapshotSource ?? "").trim();
  const explicit = body || snapshot;
  const normalizedExplicit = normalizeTripBookingSource(explicit);
  if (isWhatsAppBookingRequest({ referer: input.referer, origin: input.origin })) {
    if (
      !normalizedExplicit.includes("whatsapp")
      && normalizedExplicit !== "guest"
      && normalizedExplicit !== "guest_web"
    ) {
      return WHATSAPP_BOOKING_SOURCE;
    }
  }
  if (explicit && !isPlaceholderBookingSource(explicit)) {
    return explicit;
  }
  return undefined;
}

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

/** Corporate portal / corporate_account_id / booking_source=corporate. */
export function isCorporateTripIneligibleForPresetNegotiation(
  trip: PresetNegotiationTripLike,
): boolean {
  const accountId = String(trip.corporate_account_id ?? "").trim();
  if (accountId.length > 0 && accountId !== "null" && accountId !== "undefined") {
    return true;
  }
  const source = normalizeTripBookingSource(trip.booking_source);
  return source === "corporate" || source.startsWith("corporate_");
}

/**
 * WhatsApp web booking (`onecab.net/whatsapp-booking`).
 * SSOT: trips.booking_source containing whatsapp, or historical guest-web `guest`.
 */
export function isWhatsAppTripIneligibleForPresetNegotiation(
  trip: PresetNegotiationTripLike,
): boolean {
  const source = normalizeTripBookingSource(trip.booking_source);
  return source.includes("whatsapp") || source === "guest" || source === "guest_web";
}

export function presetNegotiationSourceIneligibility(
  trip: PresetNegotiationTripLike,
): { reason: Extract<PresetEligibilityReason, "ineligible_scheduled" | "ineligible_corporate" | "ineligible_whatsapp">; message: string } | null {
  if (isScheduledTripIneligibleForPresetNegotiation(trip)) {
    return { reason: "ineligible_scheduled", message: "Scheduled rides cannot negotiate" };
  }
  if (isCorporateTripIneligibleForPresetNegotiation(trip)) {
    return { reason: "ineligible_corporate", message: "Corporate bookings cannot negotiate" };
  }
  if (isWhatsAppTripIneligibleForPresetNegotiation(trip)) {
    return { reason: "ineligible_whatsapp", message: "WhatsApp bookings cannot negotiate" };
  }
  return null;
}

/** Per-offer SSOT: stacked rides never negotiate (trip source may still be eligible). */
export function isStackedOfferIneligibleForPresetNegotiation(
  offer: PresetNegotiationOfferLike | boolean | null | undefined,
): boolean {
  if (typeof offer === "boolean") return offer === true;
  return offer?.is_stacked === true;
}

export function presetNegotiationOfferIneligibility(
  offer: PresetNegotiationOfferLike | boolean | null | undefined,
): { reason: Extract<PresetEligibilityReason, "ineligible_stacked">; message: string } | null {
  if (isStackedOfferIneligibleForPresetNegotiation(offer)) {
    return {
      reason: "ineligible_stacked",
      message: "Fare negotiation is not available for stacked rides",
    };
  }
  return null;
}

/** Snapshot overlay for stacked offers — original fare only, no chips/deadlines/owner. */
export function stackedOfferNegotiationLockFields(): Record<string, unknown> {
  return {
    negotiationLocked: true,
    negotiationDisabled: true,
    negotiationAllowed: false,
    negotiation_eligible: false,
    presets_enabled: false,
    countdown_auto_select: false,
    preset_options: [],
    fareSource: "stacked_ride",
  };
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
  isStacked?: boolean;
}): {
  ok: boolean;
  reason: PresetEligibilityReason;
  presetOptions: PresetOptionCanonical[];
  countdownSeconds: number | null;
} {
  const stackedBlock = presetNegotiationOfferIneligibility(args.isStacked === true);
  if (stackedBlock) {
    return { ok: false, reason: stackedBlock.reason, presetOptions: [], countdownSeconds: null };
  }
  if (!args.serviceAreaId) {
    return { ok: false, reason: "missing_service_area", presetOptions: [], countdownSeconds: null };
  }
  const sourceBlock = presetNegotiationSourceIneligibility(args.trip);
  if (sourceBlock) {
    return { ok: false, reason: sourceBlock.reason, presetOptions: [], countdownSeconds: null };
  }
  if (tripConsumedNegotiationChance(args.trip)) {
    return { ok: false, reason: "negotiation_disabled", presetOptions: [], countdownSeconds: null };
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

  const countdownSeconds = normalizeCountdownSeconds(args.config?.countdown_seconds);

  return {
    ok: true,
    reason: "attached",
    presetOptions,
    countdownSeconds,
  };
}

/** Named eligibility gate — false for scheduled / Corporate / WhatsApp / stacked. */
export function isPresetNegotiationEligible(
  trip: ScheduledTripLike,
  serviceAreaConfig: PresetConfigLike | null,
  args: {
    serviceAreaId: string | null | undefined;
    baseFarePence: number;
    offers: AdminPresetOfferRow[];
    timezone: string;
    now?: Date;
    isStacked?: boolean;
  },
): boolean {
  return resolvePresetNegotiation({
    trip,
    serviceAreaId: args.serviceAreaId,
    baseFarePence: args.baseFarePence,
    config: serviceAreaConfig,
    offers: args.offers,
    timezone: args.timezone,
    now: args.now,
    isStacked: args.isStacked,
  }).ok;
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
    negotiation_eligible: true,
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
