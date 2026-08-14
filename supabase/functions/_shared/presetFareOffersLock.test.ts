/**
 * Preset Fare Offers lock tests (Deno — this repo's vitest binary is currently broken locally).
 * Run: deno test supabase/functions/_shared/presetFareOffersLock.test.ts
 */
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { checkOfferSchedule } from "./offerSchedule.ts";
import {
  buildPresetOptionsFromAdminOffers,
  computePresetOfferFarePence,
  PRESET_SLOT_COUNT,
} from "./presetOptionsCanonical.ts";
import {
  isCorporateTripIneligibleForPresetNegotiation,
  isPresetNegotiationEligible,
  isScheduledTripIneligibleForPresetNegotiation,
  isWhatsAppTripIneligibleForPresetNegotiation,
  presetNegotiationSnapshotFields,
  resolvePersistedTripBookingSource,
  resolvePresetNegotiation,
} from "./presetNegotiationEligibility.ts";

const slots = (
  amounts: Array<{ multiplier?: number; fixed?: number; active?: boolean }>,
) =>
  amounts.map((a, i) => ({
    offer_key: `offer_${i + 1}`,
    label: `Preset ${i + 1}`,
    multiplier: a.multiplier ?? null,
    fixed_amount_pence: a.fixed ?? null,
    display_order: i,
    is_active: a.active ?? true,
  }));

Deno.test("percentage 100 keeps the original fare", () => {
  assertEquals(
    computePresetOfferFarePence(784, { multiplier: 1, fixed_amount_pence: null }, "multiplier"),
    784,
  );
});

Deno.test("percentage 110 is original × 1.10, rounded", () => {
  assertEquals(
    computePresetOfferFarePence(784, { multiplier: 1.1, fixed_amount_pence: null }, "multiplier"),
    862,
  );
});

Deno.test("fixed 50 pence is +£0.50 on the original fare", () => {
  assertEquals(
    computePresetOfferFarePence(784, { multiplier: null, fixed_amount_pence: 50 }, "fixed"),
    834,
  );
});

Deno.test("fixed never treats a large pence value as an absolute fare", () => {
  assertEquals(
    computePresetOfferFarePence(784, { multiplier: null, fixed_amount_pence: 5000 }, "fixed"),
    5784,
  );
});

Deno.test("builds exactly 3 chips from the canonical first 3 slots", () => {
  const built = buildPresetOptionsFromAdminOffers(
    1000,
    slots([{ multiplier: 1 }, { multiplier: 1.1 }, { multiplier: 1.2 }]),
    "multiplier",
  );
  assertEquals(built.length, PRESET_SLOT_COUNT);
  assertEquals(built.map((o) => o.grossFarePence), [1000, 1100, 1200]);
});

Deno.test("does not pull a 4th row to replace a duplicate or inactive slot", () => {
  const duplicate = buildPresetOptionsFromAdminOffers(
    1000,
    [
      ...slots([{ multiplier: 1 }, { multiplier: 1 }, { multiplier: 1.2 }]),
      { offer_key: "offer_4", label: "Extra", multiplier: 1.3, fixed_amount_pence: null, display_order: 3, is_active: true },
    ],
    "multiplier",
  );
  assertEquals(duplicate, []);

  const inactive = buildPresetOptionsFromAdminOffers(
    1000,
    [
      ...slots([{ multiplier: 1 }, { multiplier: 1.1, active: false }, { multiplier: 1.2 }]),
      { offer_key: "offer_4", label: "Extra", multiplier: 1.3, fixed_amount_pence: null, display_order: 3, is_active: true },
    ],
    "multiplier",
  );
  assertEquals(inactive, []);
});

Deno.test("fails when fewer than 3 slots exist", () => {
  assertEquals(
    buildPresetOptionsFromAdminOffers(
      1000,
      slots([{ multiplier: 1 }, { multiplier: 1.1 }]),
      "multiplier",
    ),
    [],
  );
});

Deno.test("scheduled trips are never negotiation-eligible", () => {
  assertEquals(isScheduledTripIneligibleForPresetNegotiation({ is_scheduled: true }), true);
  assertEquals(isScheduledTripIneligibleForPresetNegotiation({ dispatch_mode: "scheduled" }), true);
  assertEquals(isScheduledTripIneligibleForPresetNegotiation({ trip_type: "scheduled" }), true);
  assertEquals(
    isScheduledTripIneligibleForPresetNegotiation({ is_scheduled: false, dispatch_mode: "broadcast" }),
    false,
  );

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
    timezone: "UTC",
  });
  assertEquals(result.ok, false);
  assertEquals(result.reason, "ineligible_scheduled");
  assertEquals(result.presetOptions, []);
});

const enabledNegotiationArgs = {
  serviceAreaId: "sa-1",
  baseFarePence: 1000,
  config: {
    is_enabled: true,
    schedule_enabled: false,
    schedule_days: [1, 2, 3, 4, 5, 6, 7],
    schedule_start_time: "00:00",
    schedule_end_time: "23:59",
    price_mode: "multiplier" as const,
    countdown_seconds: 25,
  },
  offers: slots([{ multiplier: 1 }, { multiplier: 1.1 }, { multiplier: 1.2 }]),
  timezone: "Europe/London",
};

Deno.test("corporate trips are never negotiation-eligible even when config is enabled", () => {
  assertEquals(isCorporateTripIneligibleForPresetNegotiation({ corporate_account_id: "corp-1" }), true);
  assertEquals(isCorporateTripIneligibleForPresetNegotiation({ booking_source: "corporate" }), true);
  assertEquals(isCorporateTripIneligibleForPresetNegotiation({ booking_source: "corporate_portal" }), true);
  assertEquals(isCorporateTripIneligibleForPresetNegotiation({ booking_source: "customer" }), false);

  const byAccount = resolvePresetNegotiation({
    ...enabledNegotiationArgs,
    trip: { is_scheduled: false, dispatch_mode: "instant", booking_source: "customer", corporate_account_id: "corp-1" },
  });
  assertEquals(byAccount.ok, false);
  assertEquals(byAccount.reason, "ineligible_corporate");
  assertEquals(byAccount.presetOptions, []);
  assertEquals(byAccount.countdownSeconds, null);
});

Deno.test("WhatsApp bookings are never negotiation-eligible even when config is enabled", () => {
  assertEquals(isWhatsAppTripIneligibleForPresetNegotiation({ booking_source: "whatsapp" }), true);
  assertEquals(isWhatsAppTripIneligibleForPresetNegotiation({ booking_source: "whatsapp-booking" }), true);
  assertEquals(isWhatsAppTripIneligibleForPresetNegotiation({ booking_source: "whatsapp_booking" }), true);
  assertEquals(isWhatsAppTripIneligibleForPresetNegotiation({ booking_source: "customer" }), false);

  const result = resolvePresetNegotiation({
    ...enabledNegotiationArgs,
    trip: { is_scheduled: false, dispatch_mode: "instant", booking_source: "whatsapp_booking" },
  });
  assertEquals(result.ok, false);
  assertEquals(result.reason, "ineligible_whatsapp");
  assertEquals(result.presetOptions, []);
  assertEquals(result.countdownSeconds, null);
});

Deno.test("instant Customer app bookings still attach exactly 3 chips", () => {
  const result = resolvePresetNegotiation({
    ...enabledNegotiationArgs,
    trip: { is_scheduled: false, dispatch_mode: "instant", booking_source: "customer" },
  });
  assertEquals(result.ok, true);
  assertEquals(result.reason, "attached");
  assertEquals(result.presetOptions.length, PRESET_SLOT_COUNT);
  assertEquals(result.countdownSeconds, 25);
  assertEquals(
    isPresetNegotiationEligible(
      { is_scheduled: false, dispatch_mode: "instant", booking_source: "customer" },
      enabledNegotiationArgs.config,
      {
        serviceAreaId: enabledNegotiationArgs.serviceAreaId,
        baseFarePence: enabledNegotiationArgs.baseFarePence,
        offers: enabledNegotiationArgs.offers,
        timezone: enabledNegotiationArgs.timezone,
      },
    ),
    true,
  );
  assertEquals(
    isPresetNegotiationEligible(
      { is_scheduled: false, dispatch_mode: "instant", booking_source: "whatsapp_booking" },
      enabledNegotiationArgs.config,
      {
        serviceAreaId: enabledNegotiationArgs.serviceAreaId,
        baseFarePence: enabledNegotiationArgs.baseFarePence,
        offers: enabledNegotiationArgs.offers,
        timezone: enabledNegotiationArgs.timezone,
      },
    ),
    false,
  );
  assertEquals(
    isPresetNegotiationEligible(
      { is_scheduled: false, dispatch_mode: "instant", booking_source: "customer" },
      enabledNegotiationArgs.config,
      {
        serviceAreaId: enabledNegotiationArgs.serviceAreaId,
        baseFarePence: enabledNegotiationArgs.baseFarePence,
        offers: enabledNegotiationArgs.offers,
        timezone: enabledNegotiationArgs.timezone,
        isStacked: true,
      },
    ),
    false,
  );
});

Deno.test("availability window uses service-area timezone days", () => {
  const fridayEvening = new Date("2026-08-14T18:00:00Z");
  const inside = checkOfferSchedule(
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
  assertEquals(inside.offersAllowedNow, true);

  const outside = checkOfferSchedule(
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
  assertEquals(outside.offersAllowedNow, false);
  assertEquals(outside.reason, "OFFERS_OUTSIDE_SCHEDULE");
});

Deno.test("Admin countdown_seconds is used even when the display toggle is off", () => {
  const result = resolvePresetNegotiation({
    trip: { is_scheduled: false },
    serviceAreaId: "sa-1",
    baseFarePence: 1000,
    config: {
      is_enabled: true,
      schedule_enabled: false,
      schedule_days: [1, 2, 3, 4, 5, 6, 7],
      schedule_start_time: "00:00",
      schedule_end_time: "23:59",
      price_mode: "multiplier",
      countdown_enabled: false,
      countdown_seconds: 25,
    },
    offers: slots([{ multiplier: 1 }, { multiplier: 1.1 }, { multiplier: 1.2 }]),
    timezone: "UTC",
  });
  assertEquals(result.ok, true);
  assertEquals(result.countdownSeconds, 25);
});

Deno.test("snapshot never enables countdown_auto_select", () => {
  const snap = presetNegotiationSnapshotFields({
    baseFarePence: 1000,
    countdownSeconds: 30,
    presetOptions: buildPresetOptionsFromAdminOffers(
      1000,
      slots([{ multiplier: 1 }, { multiplier: 1.1 }, { multiplier: 1.2 }]),
      "multiplier",
    ),
  });
  assertEquals(snap.countdown_auto_select, false);
  assertEquals(snap.presets_enabled, true);
  assertEquals(snap.negotiationAllowed, true);
  assertEquals(snap.negotiation_eligible, true);
  assertEquals(snap.countdown_seconds, 30);
});

Deno.test("Admin UI lock: exactly 3 slots, no Add Offer, no auto-accept", async () => {
  const ui = await Deno.readTextFile(
    new URL("../../../src/components/pricing/PresetOffersConfig.tsx", import.meta.url),
  );
  assert(!/Add Offer/.test(ui));
  assert(!/addOffer/.test(ui));
  assert(/Preset 1/.test(ui));
  assert(/Preset 2/.test(ui));
  assert(/Preset 3/.test(ui));
  assert(/PRESET_SLOT_COUNT = 3/.test(ui));
  assert(!/Auto-select on expiry/.test(ui));
  assert(!/Automatically accept the default offer/.test(ui));
  assert(!/8\.50|9\.00|10\.00/.test(ui));
  assert(!/grossFarePence:\s*(850|900|1000)/.test(ui));
  assert(!/\[8\.5,\s*9,\s*10\]/.test(ui));
  assert(/Adjustment \(pence\)/.test(ui));
  assert(/50 = \+/.test(ui));
  assert(/Negotiation countdown used for both Driver and Customer/.test(ui));
  assert(!/Driver offer countdown for this service area/.test(ui));
  assert(/Expiry never auto-accepts an offer/.test(ui));
  assert(!/Countdown Timer/.test(ui));
  assert(/Countdown Duration \(seconds\)/.test(ui));
  assert(!/disabled=\{!config.countdown_enabled\}/.test(ui));
  assert(!/Not controlled by the toggle/.test(ui));
});

Deno.test("guest and WhatsApp referer persist as ineligible sources", () => {
  assertEquals(isWhatsAppTripIneligibleForPresetNegotiation({ booking_source: "guest" }), true);
  assertEquals(
    resolvePersistedTripBookingSource({
      snapshotSource: "select_vehicle",
      referer: "https://onecab.net/whatsapp-booking",
    }),
    "whatsapp_booking",
  );
  assertEquals(
    resolvePersistedTripBookingSource({
      bodySource: "choose_ride",
      snapshotSource: "choose_ride",
    }),
    "choose_ride",
  );
});

Deno.test("excluded trips stay ineligible after rebroadcast chance is unused", () => {
  for (const source of ["corporate", "whatsapp_booking", "guest"] as const) {
    const result = resolvePresetNegotiation({
      ...enabledNegotiationArgs,
      trip: {
        is_scheduled: false,
        dispatch_mode: "instant",
        booking_source: source,
        negotiation_disabled: false,
        negotiation_status: null,
      },
    });
    assertEquals(result.ok, false);
    assertEquals(result.presetOptions, []);
    assertEquals(result.countdownSeconds, null);
  }
  const scheduledResume = resolvePresetNegotiation({
    ...enabledNegotiationArgs,
    trip: {
      is_scheduled: true,
      dispatch_mode: "scheduled",
      booking_source: "customer",
      negotiation_disabled: false,
    },
  });
  assertEquals(scheduledResume.ok, false);
  assertEquals(scheduledResume.reason, "ineligible_scheduled");

  const customerApp = resolvePresetNegotiation({
    ...enabledNegotiationArgs,
    trip: { is_scheduled: false, dispatch_mode: "instant", booking_source: "customer_app" },
  });
  assertEquals(customerApp.ok, true);
  assertEquals(customerApp.presetOptions.length, PRESET_SLOT_COUNT);
});
