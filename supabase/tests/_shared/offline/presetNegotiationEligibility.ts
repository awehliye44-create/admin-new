/** Offline test/audit-only helpers; not part of Edge uploads. */
/**
 * Preset negotiation eligibility SSOT (instant/on-demand Customer app only).
 * Scheduled, Corporate, WhatsApp, and stacked offers are never eligible.
 */

import { checkOfferSchedule } from "../../../functions/_shared/offerSchedule.ts";

import {
  buildPresetOptionsFromAdminOffers,
  PRESET_SLOT_COUNT,
  type AdminPresetOfferRow,
  type PresetOptionCanonical,
} from "../../../functions/_shared/presetOptionsCanonical.ts";
import { ScheduledTripLike, PresetConfigLike, resolvePresetNegotiation } from "../../../functions/_shared/presetNegotiationEligibility.ts";


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

export * from "../../../functions/_shared/presetNegotiationEligibility.ts";
