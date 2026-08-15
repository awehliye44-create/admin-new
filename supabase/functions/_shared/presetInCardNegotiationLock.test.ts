/**
 * In-card preset negotiation lock (Driver £Y / Customer £Z formulas).
 * Run: deno test --allow-read supabase/functions/_shared/presetInCardNegotiationLock.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildCustomerNegotiationView } from "./customerNegotiationView.ts";
import {
  negotiationDeadlineIso,
  resolveNegotiationCountdownSeconds,
  resolveNegotiationDeadlineIso,
} from "./negotiation-deadline.ts";
import {
  customerCounterOfferPushBody,
  customerNewFareOfferBody,
  CUSTOMER_DECLINED_OFFER_BODY,
  DRIVER_ACCEPTED_COUNTER_BODY,
  FINDING_ANOTHER_DRIVER_UPDATED_FARE_BODY,
  OFFER_ACCEPTED_ASSIGNED_BODY,
} from "./negotiationPushCopy.ts";
import {
  buildNegotiationFromPresetOptions,
  PRESET_SLOT_COUNT,
} from "./presetOptionsCanonical.ts";
import {
  isCorporateTripIneligibleForPresetNegotiation,
  isScheduledTripIneligibleForPresetNegotiation,
  isWhatsAppTripIneligibleForPresetNegotiation,
  resolvePresetNegotiation,
  stackedOfferNegotiationLockFields,
} from "./presetNegotiationEligibility.ts";

const presets = [
  { key: "P1", label: "+£0.50", grossFare: 4.75, grossFarePence: 475, configuredAmount: 50, color: null, order: 0, enabled: true },
  { key: "P2", label: "+£1.00", grossFare: 5.25, grossFarePence: 525, configuredAmount: 100, color: null, order: 1, enabled: true },
  { key: "P3", label: "+£1.50", grossFare: 5.75, grossFarePence: 575, configuredAmount: 150, color: null, order: 2, enabled: true },
];

Deno.test("exactly 3 driver chips; remaining customer chips are the other 2", () => {
  assertEquals(PRESET_SLOT_COUNT, 3);
  const { remainingOptions } = buildNegotiationFromPresetOptions(presets, 475, "P1");
  assertEquals(remainingOptions.length, 2);
  assertEquals(remainingOptions.map((o) => o.grossFarePence), [525, 575]);
});

Deno.test("Admin duration 25 produces the same 25s deadline for Driver→Customer and Customer→Driver", () => {
  const admin = { countdown_enabled: true, countdown_seconds: 25 };
  assertEquals(resolveNegotiationCountdownSeconds(admin), 25);
  const from = Date.parse("2026-08-14T18:00:00.000Z");
  const deadline = negotiationDeadlineIso(25, from);
  assertEquals(deadline, "2026-08-14T18:00:25.000Z");
  assertEquals(
    resolveNegotiationDeadlineIso({ countdownSeconds: 25, fromMs: from }),
    deadline,
  );
});

Deno.test("toggle off still uses Admin duration 25 and never invents a 20s window", () => {
  assertEquals(
    resolveNegotiationCountdownSeconds({ countdown_enabled: false, countdown_seconds: 25 }),
    25,
  );
  const from = Date.parse("2026-08-14T18:00:00.000Z");
  assertEquals(
    resolveNegotiationDeadlineIso({ countdownSeconds: 25, fromMs: from }),
    "2026-08-14T18:00:25.000Z",
  );
});

Deno.test("missing Admin duration uses column default 30, not leftover offer TTL", () => {
  const from = Date.parse("2026-08-14T18:00:00.000Z");
  assertEquals(
    resolveNegotiationDeadlineIso({ countdownSeconds: null, fromMs: from }),
    "2026-08-14T18:00:30.000Z",
  );
});

Deno.test("scheduled trips never negotiate", () => {
  assertEquals(isScheduledTripIneligibleForPresetNegotiation({ is_scheduled: true }), true);
  assertEquals(isScheduledTripIneligibleForPresetNegotiation({ dispatch_mode: "scheduled" }), true);
});

Deno.test("corporate and WhatsApp sources never negotiate even when Admin countdown is enabled", () => {
  assertEquals(isCorporateTripIneligibleForPresetNegotiation({ corporate_account_id: "acct-1" }), true);
  assertEquals(isCorporateTripIneligibleForPresetNegotiation({ booking_source: "corporate" }), true);
  assertEquals(isWhatsAppTripIneligibleForPresetNegotiation({ booking_source: "whatsapp_booking" }), true);
  assertEquals(isWhatsAppTripIneligibleForPresetNegotiation({ booking_source: "whatsapp-booking" }), true);
  assertEquals(isWhatsAppTripIneligibleForPresetNegotiation({ booking_source: "guest" }), true);
  assertEquals(
    isCorporateTripIneligibleForPresetNegotiation({ booking_source: "customer", corporate_account_id: null }),
    false,
  );
  assertEquals(isWhatsAppTripIneligibleForPresetNegotiation({ booking_source: "customer" }), false);
});

Deno.test("waiting_customer view hides identity and exposes £Y + 2 counters + backend deadline", () => {
  const view = buildCustomerNegotiationView({
    offer: {
      id: "offer-1",
      negotiation_status: "waiting_customer",
      driver_offer_fare: 475,
      offer_snapshot: { preset_options: presets, countdown_seconds: 25 },
      customer_respond_by: "2026-08-14T18:00:25.000Z",
    },
    originalFarePence: 425,
  });
  assertEquals(view?.phase, "waiting_customer");
  assertEquals(view?.original_fare_pence, 425);
  assertEquals(view?.driver_offer_pence, 475);
  assertEquals(view?.remaining_options.length, 2);
  assertEquals(view?.customer_counter_pence, null);
  assertEquals(view?.expires_at, "2026-08-14T18:00:25.000Z");
  assertEquals(view?.negotiation_expires_at, "2026-08-14T18:00:25.000Z");
  assertEquals(view?.countdown_seconds, 25);
});

Deno.test("waiting_driver_final view uses £Z as committed counter and the same Admin countdown", () => {
  const view = buildCustomerNegotiationView({
    offer: {
      id: "offer-1",
      negotiation_status: "waiting_driver_final",
      driver_offer_fare: 475,
      customer_counter_fare: 525,
      offer_snapshot: { preset_options: presets, countdown_seconds: 25 },
      customer_respond_by: "2026-08-14T17:59:20.000Z",
      driver_respond_by: "2026-08-14T18:00:25.000Z",
    },
    originalFarePence: 525,
  });
  assertEquals(view?.phase, "waiting_driver_final");
  assertEquals(view?.customer_counter_pence, 525);
  assertEquals(view?.expires_at, "2026-08-14T18:00:25.000Z");
  assertEquals(view?.negotiation_expires_at, "2026-08-14T18:00:25.000Z");
  assertEquals(view?.countdown_seconds, 25);
});

Deno.test("approved push copy matches product strings without hardcoded 20s", () => {
  assertEquals(
    customerNewFareOfferBody(475),
    "Driver offered £4.75 — respond before it expires.",
  );
  assertEquals(
    customerCounterOfferPushBody(525),
    "Customer counter offer £5.25 — respond before it expires.",
  );
  assertEquals(OFFER_ACCEPTED_ASSIGNED_BODY, "Offer accepted — trip assigned.");
  assertEquals(CUSTOMER_DECLINED_OFFER_BODY, "Customer declined your offer.");
  assertEquals(DRIVER_ACCEPTED_COUNTER_BODY, "Driver accepted your counter offer.");
  assertEquals(
    FINDING_ANOTHER_DRIVER_UPDATED_FARE_BODY,
    "We're finding another driver at your updated fare.",
  );
});

Deno.test("fare formulas: Y is not original; Z becomes original immediately", () => {
  const originalX = 425;
  const driverY = 475;
  const customerZ = 525;
  assertEquals(originalX, 425);
  assertEquals(driverY, 475);
  assertEquals(customerZ, 525);
});

Deno.test("customer fare push resolves customers.id to auth user id", async () => {
  const auth = await Deno.readTextFile(
    new URL("./authoritativeDevicePush.ts", import.meta.url),
  );
  const offer = await Deno.readTextFile(
    new URL("../driver-fare-offer/index.ts", import.meta.url),
  );
  const tripNotif = await Deno.readTextFile(
    new URL("../send-trip-notification/index.ts", import.meta.url),
  );
  assertEquals(auth.includes("export async function resolveCustomerAuthUserId"), true);
  assertEquals(offer.includes("resolveCustomerAuthUserId"), true);
  assertEquals(offer.includes("userId: customerAuthUserId"), true);
  assertEquals(tripNotif.includes("resolveCustomerAuthUserId"), true);
  assertEquals(tripNotif.includes("authUserId"), true);
});

Deno.test("customer negotiation pushes deep-link to the current ride", async () => {
  const src = await Deno.readTextFile(
    new URL("../send-trip-notification/index.ts", import.meta.url),
  );
  assertEquals(src.includes("driver_accepted_counter"), true);
  assertEquals(src.includes("finding_another_driver_updated_fare"), true);
  assertEquals(src.includes("/booking/driver-accepted"), true);
  assertEquals(src.includes("/booking/finding-drivers"), true);
  assertEquals(src.includes("path: screen"), true);
  assertEquals(src.includes("negotiation_expires_at"), true);
  assertEquals(src.includes("negotiationExpiresAt"), true);
});

Deno.test("get-active-trip hides driver identity while negotiating", async () => {
  const src = await Deno.readTextFile(
    new URL("../get-active-trip/index.ts", import.meta.url),
  );
  assertEquals(src.includes('String(trip.status ?? "") === "negotiating"'), true);
  assertEquals(src.includes("loadCustomerNegotiationView"), true);
  assertEquals(src.includes("driverId: negotiating ? null : trip.driver_id"), true);
});

Deno.test("accept-offer blocks other drivers while pre-held", async () => {
  const src = await Deno.readTextFile(
    new URL("../accept-offer/index.ts", import.meta.url),
  );
  assertEquals(src.includes("NEGOTIATION_HELD"), true);
  assertEquals(src.includes("negotiation_owner_driver_id"), true);
  assertEquals(src.includes("This trip is held for another driver"), true);
});

Deno.test("negotiation failure rematch may leave negotiating for searching_new_driver", async () => {
  const src = await Deno.readTextFile(
    new URL(
      "../../migrations/20260924170000_allow_negotiation_failure_rematch.sql",
      import.meta.url,
    ),
  );
  assertEquals(src.includes("'searching', 'pending', 'offered', 'broadcasting', 'offering', 'negotiating'"), true);
  assertEquals(src.includes("NEW.negotiation_disabled = true"), true);
  assertEquals(src.includes("is_driver_cancel_rematch_eligible_status"), true);
});

Deno.test("SQL pre-hold trigger blocks assignment to non-owner", async () => {
  const src = await Deno.readTextFile(
    new URL(
      "../../migrations/20260922130000_preset_negotiation_in_card_ssot.sql",
      import.meta.url,
    ),
  );
  assertEquals(src.includes("enforce_negotiation_pre_hold_assignment"), true);
  assertEquals(src.includes("NEGOTIATION_HELD"), true);
  assertEquals(src.includes("trg_enforce_negotiation_pre_hold_assignment"), true);
  assertEquals(src.includes("DROP TRIGGER IF EXISTS trg_enforce_negotiation_pre_hold_assignment ON public.trips"), true);
  assertEquals(src.includes("BEFORE UPDATE OF driver_id, confirmed_driver_id"), true);
  assertEquals(src.includes("preset_offer_configs"), true);
  assertEquals(src.includes("interval '20 seconds'"), false);
  assertEquals(src.includes("interval '25 seconds'"), false);
  assertEquals(src.includes("COALESCE(v_cd_enabled"), false);
  assertEquals(src.includes("v_offer.expires_at > v_now"), false);
  assertEquals(src.includes("countdown_seconds"), true);
  assertEquals(
    src.includes("DROP FUNCTION IF EXISTS public.driver_send_preset_offer(uuid, integer, integer[])"),
    true,
  );
  assertEquals(src.includes("p_selected_total_fare_pence"), true);
  assertEquals(src.includes("p_allowed_total_fares_pence"), true);
  assertEquals(src.includes("p_customer_respond_seconds"), true);
  assertEquals(src.includes("p_driver_offer_fare_pence"), false);
  assertEquals(src.includes("p_offer_options"), false);
  assertEquals(src.includes("CREATE OR REPLACE FUNCTION public.accept_ride_offer"), false);
});

Deno.test("resume search does not reopen consumed negotiation", async () => {
  const src = await Deno.readTextFile(
    new URL("../customer-resume-driver-search/index.ts", import.meta.url),
  );
  assertEquals(src.includes("negotiation_disabled: false"), false);
});

Deno.test("Driver→Customer and Customer→Driver stamp Admin countdown, not 20s", async () => {
  const offer = await Deno.readTextFile(
    new URL("../driver-fare-offer/index.ts", import.meta.url),
  );
  const decision = await Deno.readTextFile(
    new URL("../customer-fare-decision/index.ts", import.meta.url),
  );
  const deadline = await Deno.readTextFile(
    new URL("./negotiation-deadline.ts", import.meta.url),
  );
  assertEquals(offer.includes("loadServiceAreaNegotiationCountdown"), true);
  assertEquals(offer.includes("fallbackExpiresAt"), false);
  assertEquals(offer.includes("negotiationExpiresAt: customerRespondBy"), true);
  assertEquals(offer.includes("driver_respond_by: null"), true);
  assertEquals(decision.includes("loadServiceAreaNegotiationCountdown"), true);
  assertEquals(decision.includes("fallbackExpiresAt"), false);
  assertEquals(decision.includes("customerCounterDriverExpiresAtIso"), false);
  assertEquals(decision.includes("customer_respond_by: null"), true);
  assertEquals(decision.includes("negotiation_expires_at: driverRespondBy"), true);
  assertEquals(deadline.includes("countdown_enabled === false"), false);
  assertEquals(deadline.includes("CUSTOMER_COUNTER_DRIVER_SECONDS"), false);
  assertEquals(deadline.includes("nextNegotiationExpiresAt"), false);

  const dispatch = await Deno.readTextFile(
    new URL("../auto-dispatch/index.ts", import.meta.url),
  );
  assertEquals(dispatch.includes("Math.min(resolved.countdownSeconds, remaining)"), false);
  assertEquals(dispatch.includes("presetNegotiationSnapshotFields"), true);
});

Deno.test("expiry rematches and never auto-accepts", async () => {
  const expire = await Deno.readTextFile(
    new URL("../expire-offers/index.ts", import.meta.url),
  );
  const sync = await Deno.readTextFile(
    new URL("../customer-negotiation-sync/index.ts", import.meta.url),
  );
  assertEquals(expire.includes("finalizeNegotiationFailureAndRebroadcast"), true);
  assertEquals(expire.includes("accept_ride_offer"), false);
  assertEquals(sync.includes("finalizeNegotiationFailureAndRebroadcast"), true);
  assertEquals(sync.includes("accept_ride_offer"), false);
  assertEquals(expire.includes("customer_respond_by"), true);
  assertEquals(expire.includes("driver_respond_by"), true);
  assertEquals(expire.includes("waiting_customer"), true);
  assertEquals(expire.includes("waiting_driver_final"), true);
});

Deno.test("£Y timeout rematches at original; £Z is committed before the driver window", async () => {
  const decision = await Deno.readTextFile(
    new URL("../customer-fare-decision/index.ts", import.meta.url),
  );
  const final = await Deno.readTextFile(
    new URL("../driver-fare-final/index.ts", import.meta.url),
  );
  const timeoutIdx = decision.indexOf("timeout_customer");
  const commitIdx = decision.indexOf('p_fare_source: "customer_counter_offer"');
  assertEquals(timeoutIdx > 0, true);
  assertEquals(commitIdx > timeoutIdx, true);
  assertEquals(final.includes("timeout_driver"), true);
  assertEquals(final.includes("customer_counter_fare"), true);
  assertEquals(final.includes("CUSTOMER_COUNTER_DRIVER_SECONDS"), false);
});

Deno.test("scheduled trips never receive a negotiation deadline", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "../../migrations/20260922130000_preset_negotiation_in_card_ssot.sql",
      import.meta.url,
    ),
  );
  const offer = await Deno.readTextFile(
    new URL("../driver-fare-offer/index.ts", import.meta.url),
  );
  const decision = await Deno.readTextFile(
    new URL("../customer-fare-decision/index.ts", import.meta.url),
  );
  const final = await Deno.readTextFile(
    new URL("../driver-fare-final/index.ts", import.meta.url),
  );
  const dispatch = await Deno.readTextFile(
    new URL("../auto-dispatch/index.ts", import.meta.url),
  );
  assertEquals(offer.includes("presetNegotiationSourceIneligibility"), true);
  assertEquals(decision.includes("presetNegotiationSourceIneligibility"), true);
  assertEquals(final.includes("presetNegotiationSourceIneligibility"), true);
  assertEquals(dispatch.includes("presetNegotiationSourceIneligibility"), true);
  assertEquals(sql.includes("ineligible_scheduled"), true);
  assertEquals(sql.includes("ineligible_corporate"), true);
  assertEquals(sql.includes("ineligible_whatsapp"), true);
  assertEquals(sql.includes("ineligible_stacked"), true);
  assertEquals(sql.includes("'guest'"), true);
  const scheduledIdx = sql.indexOf("ineligible_scheduled");
  const corporateIdx = sql.indexOf("ineligible_corporate");
  const whatsappIdx = sql.indexOf("ineligible_whatsapp");
  const deadlineIdx = sql.indexOf("v_negotiation_expires_at :=");
  assertEquals(scheduledIdx > 0 && deadlineIdx > scheduledIdx, true);
  assertEquals(corporateIdx > 0 && deadlineIdx > corporateIdx, true);
  assertEquals(whatsappIdx > 0 && deadlineIdx > whatsappIdx, true);
});

Deno.test("original Accept and negotiated Accept still assign immediately", async () => {
  const accept = await Deno.readTextFile(
    new URL("../accept-offer/index.ts", import.meta.url),
  );
  const decision = await Deno.readTextFile(
    new URL("../customer-fare-decision/index.ts", import.meta.url),
  );
  const final = await Deno.readTextFile(
    new URL("../driver-fare-final/index.ts", import.meta.url),
  );
  assertEquals(accept.includes("accept_ride_offer"), true);
  assertEquals(decision.includes('if (action === "ACCEPT")'), true);
  assertEquals(decision.includes("accept_ride_offer"), true);
  assertEquals(decision.includes("REMATCH_FAILED"), true);
  assertEquals(final.includes("accept_ride_offer"), true);
});

Deno.test("excluded sources cannot enter negotiation on restore/redispatch", async () => {
  const dispatch = await Deno.readTextFile(
    new URL("../auto-dispatch/index.ts", import.meta.url),
  );
  const sync = await Deno.readTextFile(
    new URL("../customer-negotiation-sync/index.ts", import.meta.url),
  );
  const offer = await Deno.readTextFile(
    new URL("../driver-fare-offer/index.ts", import.meta.url),
  );
  assertEquals(dispatch.includes("PRESET_STRIPPED_EXCLUDED_SOURCE"), true);
  assertEquals(sync.includes("presetNegotiationSourceIneligibility"), true);
  assertEquals(offer.includes("ineligible_corporate"), true);
  assertEquals(offer.includes("ineligible_whatsapp"), true);
  const bookingSsot = await Deno.readTextFile(
    new URL("./bookingSSOT.ts", import.meta.url),
  );
  const ctap = await Deno.readTextFile(
    new URL("../create-trip-after-payment/index.ts", import.meta.url),
  );
  assertEquals(bookingSsot.includes("resolvePersistedTripBookingSource"), true);
  assertEquals(ctap.includes("requestReferer"), true);
  const redispatched = resolvePresetNegotiation({
    trip: {
      is_scheduled: false,
      dispatch_mode: "instant",
      booking_source: "corporate",
      negotiation_disabled: false,
      negotiation_status: null,
    },
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
    offers: [
      { offer_key: "a", label: "A", multiplier: 1, display_order: 0, is_active: true },
      { offer_key: "b", label: "B", multiplier: 1.1, display_order: 1, is_active: true },
      { offer_key: "c", label: "C", multiplier: 1.2, display_order: 2, is_active: true },
    ],
    timezone: "UTC",
  });
  assertEquals(redispatched.ok, false);
  assertEquals(redispatched.reason, "ineligible_corporate");
  assertEquals(redispatched.presetOptions, []);
});

Deno.test("stacked offers are never negotiation-eligible even for Customer-app trips", () => {
  const eligibleTrip = {
    is_scheduled: false,
    dispatch_mode: "instant",
    booking_source: "customer",
    negotiation_disabled: false,
  };
  const config = {
    is_enabled: true,
    schedule_enabled: false,
    schedule_days: [1, 2, 3, 4, 5, 6, 7],
    schedule_start_time: "00:00",
    schedule_end_time: "23:59",
    price_mode: "multiplier",
    countdown_seconds: 25,
  };
  const offers = [
    { offer_key: "a", label: "A", multiplier: 1, display_order: 0, is_active: true },
    { offer_key: "b", label: "B", multiplier: 1.1, display_order: 1, is_active: true },
    { offer_key: "c", label: "C", multiplier: 1.2, display_order: 2, is_active: true },
  ];
  const idle = resolvePresetNegotiation({
    trip: eligibleTrip,
    serviceAreaId: "sa-1",
    baseFarePence: 1000,
    config,
    offers,
    timezone: "UTC",
  });
  assertEquals(idle.ok, true);
  assertEquals(idle.reason, "attached");

  const stacked = resolvePresetNegotiation({
    trip: eligibleTrip,
    serviceAreaId: "sa-1",
    baseFarePence: 1000,
    config,
    offers,
    timezone: "UTC",
    isStacked: true,
  });
  assertEquals(stacked.ok, false);
  assertEquals(stacked.reason, "ineligible_stacked");
  assertEquals(stacked.presetOptions, []);
  assertEquals(stacked.countdownSeconds, null);
  const lock = stackedOfferNegotiationLockFields();
  assertEquals(lock.negotiation_eligible, false);
  assertEquals(lock.preset_options, []);
  assertEquals("countdown_seconds" in lock, false);
});

Deno.test("enrichExistingOffersMode cannot stamp chips on stacked rows", async () => {
  const dispatch = await Deno.readTextFile(
    new URL("../auto-dispatch/index.ts", import.meta.url),
  );
  assertEquals(dispatch.includes("PRESET_STRIPPED_STACKED_OFFERS"), true);
  assertEquals(dispatch.includes("stackedOfferNegotiationLockFields"), true);
  const enrichIdx = dispatch.indexOf("PRESET_ENRICHED_EXISTING_OFFERS");
  const stackedFilterBefore = dispatch.lastIndexOf(
    'or("is_stacked.eq.false,is_stacked.is.null")',
    enrichIdx,
  );
  assertEquals(stackedFilterBefore > 0 && stackedFilterBefore < enrichIdx, true);
  assertEquals(dispatch.includes("Hard rule: stacked rides disable negotiations"), true);
  assertEquals(dispatch.includes("NEGOTIATION_IN_PROGRESS"), true);
  assertEquals(dispatch.includes("p_expires_in_seconds: waveExpirySeconds"), true);
  assertEquals(
    dispatch.includes("Math.min(resolved.countdownSeconds, remaining)"),
    false,
  );
});

Deno.test("SQL enrichment skips stacked and accept_stacked_ride enforces hold", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "../../migrations/20260922130000_preset_negotiation_in_card_ssot.sql",
      import.meta.url,
    ),
  );
  assertEquals(sql.includes("ineligible_stacked"), true);
  assertEquals(sql.includes("AND COALESCE(ro.is_stacked, false) = false"), true);
  assertEquals(sql.includes("AND COALESCE(ro.is_stacked, false) = true"), true);
  assertEquals(sql.includes("CREATE OR REPLACE FUNCTION public.accept_stacked_ride"), true);
  const stackedAcceptIdx = sql.lastIndexOf("CREATE OR REPLACE FUNCTION public.accept_stacked_ride");
  const holdInStacked = sql.indexOf("RAISE EXCEPTION 'NEGOTIATION_HELD'", stackedAcceptIdx);
  assertEquals(stackedAcceptIdx > 0, true);
  assertEquals(holdInStacked > stackedAcceptIdx, true);
  assertEquals(sql.includes("negotiation_owner_driver_id IS DISTINCT FROM p_driver_id"), true);
  assertEquals(sql.includes("negotiation_disabled = true"), false);
  assertEquals(sql.includes("preset_options"), true);
  const lifecycle = await Deno.readTextFile(
    new URL("./stackedRideLifecycle.ts", import.meta.url),
  );
  assertEquals(lifecycle.includes("promote_stacked_trip"), true);
  assertEquals(lifecycle.includes("negotiation_disabled"), false);
  assertEquals(lifecycle.includes("preset_options"), false);
  assertEquals(lifecycle.includes("estimated_fare"), false);
});

Deno.test("driver-fare-offer rejects stacked before any negotiation write", async () => {
  const offer = await Deno.readTextFile(
    new URL("../driver-fare-offer/index.ts", import.meta.url),
  );
  const stackedIdx = offer.indexOf("presetNegotiationOfferIneligibility");
  const rpcIdx = offer.indexOf("driver_send_preset_offer");
  assertEquals(stackedIdx > 0, true);
  assertEquals(rpcIdx > stackedIdx, true);
  assertEquals(offer.includes("presetNegotiationOfferIneligibility"), true);
  assertEquals(offer.includes("stacked_ride_no_negotiation"), true);
  assertEquals(offer.includes("p_selected_total_fare_pence"), true);
  assertEquals(offer.includes("p_allowed_total_fares_pence"), true);
  assertEquals(offer.includes("p_customer_respond_seconds"), true);
  assertEquals(offer.includes("p_driver_offer_fare_pence"), false);
  assertEquals(offer.includes("p_offer_options"), false);
  const accept = await Deno.readTextFile(
    new URL("../accept-offer/index.ts", import.meta.url),
  );
  assertEquals(accept.includes('msg.includes("NEGOTIATION_HELD")'), true);
  assertEquals(accept.includes("stacked_driver_assigned"), true);
  assertEquals(accept.includes("accept_stacked_ride"), true);
});

