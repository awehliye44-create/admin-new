import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkOfferSchedule } from "../../../supabase/functions/_shared/offerSchedule.ts";
import {
  buildPresetOptionsFromAdminOffers,
  computePresetOfferFarePence,
  PRESET_SLOT_COUNT,
} from "../../../supabase/functions/_shared/presetOptionsCanonical.ts";
import {
  isCorporateTripIneligibleForPresetNegotiation,
  isScheduledTripIneligibleForPresetNegotiation,
  isWhatsAppTripIneligibleForPresetNegotiation,
  presetNegotiationSnapshotFields,
  resolvePresetNegotiation,
} from "../../../supabase/functions/_shared/presetNegotiationEligibility.ts";

const slots = (
  amounts: Array<{ multiplier?: number; fixed?: number }>,
) =>
  amounts.map((a, i) => ({
    offer_key: `offer_${i + 1}`,
    label: `Preset ${i + 1}`,
    multiplier: a.multiplier ?? null,
    fixed_amount_pence: a.fixed ?? null,
    display_order: i,
    is_active: true,
  }));

describe("preset fare math SSOT", () => {
  it("percentage 100 keeps the original fare", () => {
    expect(computePresetOfferFarePence(784, { multiplier: 1, fixed_amount_pence: null }, "multiplier")).toBe(784);
  });

  it("percentage 110 is original × 1.10, rounded", () => {
    expect(computePresetOfferFarePence(784, { multiplier: 1.1, fixed_amount_pence: null }, "multiplier")).toBe(862);
  });

  it("fixed 50 pence is +£0.50 on the original fare", () => {
    expect(computePresetOfferFarePence(784, { multiplier: null, fixed_amount_pence: 50 }, "fixed")).toBe(834);
  });

  it("fixed never treats a large pence value as an absolute fare", () => {
    expect(computePresetOfferFarePence(784, { multiplier: null, fixed_amount_pence: 5000 }, "fixed")).toBe(5784);
  });
});

describe("exactly 3 slots", () => {
  it("builds 3 chips from the first 3 active rows", () => {
    const built = buildPresetOptionsFromAdminOffers(
      1000,
      slots([{ multiplier: 1 }, { multiplier: 1.1 }, { multiplier: 1.2 }]),
      "multiplier",
    );
    expect(built).toHaveLength(PRESET_SLOT_COUNT);
    expect(built.map((o) => o.grossFarePence)).toEqual([1000, 1100, 1200]);
  });

  it("does not pull a 4th row to replace a duplicate or inactive slot", () => {
    const duplicate = buildPresetOptionsFromAdminOffers(
      1000,
      [
        ...slots([{ multiplier: 1 }, { multiplier: 1 }, { multiplier: 1.2 }]),
        { offer_key: "offer_4", label: "Extra", multiplier: 1.3, fixed_amount_pence: null, display_order: 3, is_active: true },
      ],
      "multiplier",
    );
    expect(duplicate).toEqual([]);

    const inactive = buildPresetOptionsFromAdminOffers(
      1000,
      [
        { offer_key: "offer_1", label: "Preset 1", multiplier: 1, fixed_amount_pence: null, display_order: 0, is_active: true },
        { offer_key: "offer_2", label: "Preset 2", multiplier: 1.1, fixed_amount_pence: null, display_order: 1, is_active: false },
        { offer_key: "offer_3", label: "Preset 3", multiplier: 1.2, fixed_amount_pence: null, display_order: 2, is_active: true },
        { offer_key: "offer_4", label: "Extra", multiplier: 1.3, fixed_amount_pence: null, display_order: 3, is_active: true },
      ],
      "multiplier",
    );
    expect(inactive).toEqual([]);
  });

  it("fails when fewer than 3 active slots exist", () => {
    expect(
      buildPresetOptionsFromAdminOffers(
        1000,
        slots([{ multiplier: 1 }, { multiplier: 1.1 }]),
        "multiplier",
      ),
    ).toEqual([]);
  });
});

describe("scheduled trip exclusion", () => {
  it("uses the audited is_scheduled / dispatch_mode / trip_type check", () => {
    expect(isScheduledTripIneligibleForPresetNegotiation({ is_scheduled: true })).toBe(true);
    expect(isScheduledTripIneligibleForPresetNegotiation({ dispatch_mode: "scheduled" })).toBe(true);
    expect(isScheduledTripIneligibleForPresetNegotiation({ trip_type: "scheduled" })).toBe(true);
    expect(isScheduledTripIneligibleForPresetNegotiation({ is_scheduled: false, dispatch_mode: "broadcast" })).toBe(false);
  });

  it("resolvePresetNegotiation rejects scheduled trips even when config is enabled", () => {
    const result = resolvePresetNegotiation({
      trip: { is_scheduled: true },
      serviceAreaId: "sa-1",
      baseFarePence: 1000,
      config: {
        is_enabled: true,
        schedule_enabled: false,
        schedule_days: [1, 2, 3, 4, 5, 6, 7],
        schedule_start_time: "00:00",
        schedule_end_time: "23:59",
        price_mode: "multiplier",
        countdown_seconds: 30,
      },
      offers: slots([{ multiplier: 1 }, { multiplier: 1.1 }, { multiplier: 1.2 }]),
      timezone: "Europe/London",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("ineligible_scheduled");
    expect(result.presetOptions).toEqual([]);
  });
});

describe("corporate and WhatsApp exclusions", () => {
  const enabled = {
    serviceAreaId: "sa-1",
    baseFarePence: 1000,
    config: {
      is_enabled: true,
      schedule_enabled: false,
      schedule_days: [1, 2, 3, 4, 5, 6, 7],
      schedule_start_time: "00:00",
      schedule_end_time: "23:59",
      price_mode: "multiplier",
      countdown_seconds: 25,
    },
    offers: slots([{ multiplier: 1 }, { multiplier: 1.1 }, { multiplier: 1.2 }]),
    timezone: "Europe/London",
  };

  it("rejects corporate_account_id even when negotiation is enabled", () => {
    expect(isCorporateTripIneligibleForPresetNegotiation({ corporate_account_id: "corp-1" })).toBe(true);
    const result = resolvePresetNegotiation({
      ...enabled,
      trip: { booking_source: "customer", corporate_account_id: "corp-1" },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("ineligible_corporate");
    expect(result.presetOptions).toEqual([]);
  });

  it("rejects WhatsApp booking_source even when negotiation is enabled", () => {
    expect(isWhatsAppTripIneligibleForPresetNegotiation({ booking_source: "whatsapp-booking" })).toBe(true);
    expect(isWhatsAppTripIneligibleForPresetNegotiation({ booking_source: "guest" })).toBe(true);
    const result = resolvePresetNegotiation({
      ...enabled,
      trip: { booking_source: "whatsapp_booking", is_scheduled: false },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("ineligible_whatsapp");
    expect(result.presetOptions).toEqual([]);
  });

  it("still attaches 3 chips for instant Customer app bookings", () => {
    const result = resolvePresetNegotiation({
      ...enabled,
      trip: { booking_source: "customer", is_scheduled: false, dispatch_mode: "instant" },
    });
    expect(result.ok).toBe(true);
    expect(result.presetOptions).toHaveLength(PRESET_SLOT_COUNT);
    expect(result.countdownSeconds).toBe(25);
  });

  it("keeps excluded sources ineligible after unused rebroadcast chance", () => {
    const result = resolvePresetNegotiation({
      ...enabled,
      trip: {
        booking_source: "corporate",
        is_scheduled: false,
        negotiation_disabled: false,
      },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("ineligible_corporate");
  });
});

describe("availability window", () => {
  const fridayEvening = new Date("2026-08-14T18:00:00Z"); // Friday

  it("allows instant trips inside the window", () => {
    const check = checkOfferSchedule(
      {
        is_enabled: true,
        schedule_enabled: true,
        schedule_days: [5],
        schedule_start_time: "08:00",
        schedule_end_time: "22:00",
      },
      "UTC",
      fridayEvening,
    );
    expect(check.offersAllowedNow).toBe(true);
  });

  it("blocks instant trips outside the window", () => {
    const check = checkOfferSchedule(
      {
        is_enabled: true,
        schedule_enabled: true,
        schedule_days: [1],
        schedule_start_time: "08:00",
        schedule_end_time: "22:00",
      },
      "UTC",
      fridayEvening,
    );
    expect(check.offersAllowedNow).toBe(false);
    expect(check.reason).toBe("OFFERS_OUTSIDE_SCHEDULE");
  });
});

describe("no auto-accept", () => {
  it("snapshot never enables countdown_auto_select", () => {
    const snap = presetNegotiationSnapshotFields({
      baseFarePence: 1000,
      countdownSeconds: 30,
      presetOptions: buildPresetOptionsFromAdminOffers(
        1000,
        slots([{ multiplier: 1 }, { multiplier: 1.1 }, { multiplier: 1.2 }]),
        "multiplier",
      ),
    });
    expect(snap.countdown_auto_select).toBe(false);
    expect(snap.presets_enabled).toBe(true);
    expect(snap.countdown_seconds).toBe(30);
  });
});

describe("Admin UI lock", () => {
  const ui = readFileSync(
    fileURLToPath(new URL("../../components/pricing/PresetOffersConfig.tsx", import.meta.url)),
    "utf8",
  );

  it("does not expose Add Offer", () => {
    expect(ui).not.toMatch(/Add Offer/);
    expect(ui).not.toMatch(/addOffer/);
  });

  it("renders exactly 3 named slots", () => {
    expect(ui).toMatch(/Preset 1/);
    expect(ui).toMatch(/Preset 2/);
    expect(ui).toMatch(/Preset 3/);
    expect(ui).toMatch(/PRESET_SLOT_COUNT = 3/);
  });

  it("does not expose auto-select-on-expiry", () => {
    expect(ui).not.toMatch(/Auto-select on expiry/);
    expect(ui).not.toMatch(/Automatically accept the default offer/);
  });

  it("does not hardcode chip fare amounts", () => {
    expect(ui).not.toMatch(/8\.50|9\.00|10\.00/);
    expect(ui).not.toMatch(/grossFarePence:\s*(850|900|1000)/);
    expect(ui).not.toMatch(/\[8\.5,\s*9,\s*10\]/);
  });

  it("describes one negotiation countdown for Driver and Customer", () => {
    expect(ui).toMatch(/Negotiation countdown used for both Driver and Customer/);
    expect(ui).not.toMatch(/Driver offer countdown for this service area/);
    expect(ui).toMatch(/Expiry never auto-accepts an offer/);
    expect(ui).toMatch(/countdown_enabled/);
    expect(ui).toMatch(/Countdown Duration \(seconds\)/);
    expect(ui).not.toMatch(/disabled=\{!config.countdown_enabled\}/);
    expect(ui).toMatch(/Not controlled by the toggle/);
  });
});
