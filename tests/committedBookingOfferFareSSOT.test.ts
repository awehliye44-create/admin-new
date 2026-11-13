/**
 * Committed booking offer fare SSOT (MK-261113-004/005).
 * Offer gross = committed booking payable, never a stale fare_breakdown.
 * Commission rates here are fixture inputs, not production constants.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  overlayCommittedPayableOnFareFields,
  planCommittedFareDriftRestamp,
  resolveCommittedOfferGross,
  resolveCommittedOfferGrossPence,
  stampOfferDriverNetFromCommittedFare,
} from "../supabase/functions/_shared/committedBookingOfferFareSSOT.ts";
import { enrichOfferSnapshotDriverNet } from "../supabase/functions/_shared/driverOfferNetPreview.ts";
import { resolveNegotiationBaseFarePence } from "../supabase/functions/_shared/negotiationBaseFare.ts";
import { tripFareFieldsForOfferSnapshot } from "../supabase/functions/_shared/tripFareSnapshot.ts";
import {
  resolveActivationGrossPenceForPreview,
  resolveExclusiveActivationDriverNetPence,
} from "../supabase/functions/_shared/scheduledActivationExclusiveSSOT.ts";
import {
  bookingFareSplitFromQuote,
  planExistingPendingOfferRestamp,
} from "../supabase/functions/_shared/airportChargeFareSplitSSOT.ts";
import { applyBookingFinancialSnapshotToTripData } from "../supabase/functions/_shared/tripDisplayFareSSOT.ts";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, "..", rel), "utf8");

/** MK-261113-004 shape: committed columns/snapshot 480, stale breakdown 500. */
function mk004Trip(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    locked_base_fare_pence: 480,
    gross_fare_pence: 480,
    final_customer_fare_pence: 480,
    fare_snapshot_json: {
      committed_fare_pence: 480,
      canonical_payable_fare_pence: 480,
      original_fare_pence: 480,
    },
    fare_breakdown: {
      trip_fare_pence: 500,
      totalFare: 5,
      final_fare_pence: 500,
      finalFare: 4.8,
      fareSource: "standard_only_fallback",
    },
    ...overrides,
  };
}

describe("resolveCommittedOfferGrossPence priority", () => {
  it("MK-004: columns 480 + stale breakdown 500 → 480", () => {
    expect(resolveCommittedOfferGrossPence(mk004Trip())).toBe(480);
  });

  it("never prefers breakdown over a committed snapshot that disagrees", () => {
    const trip = {
      fare_snapshot_json: { canonical_payable_fare_pence: 480 },
      fare_breakdown: { trip_fare_pence: 500, totalFare: 5, final_fare_pence: 500 },
    };
    const r = resolveCommittedOfferGross(trip);
    expect(r.pence).toBe(480);
    expect(r.source).toBe("fare_snapshot_committed");
    expect(r.committed).toBe(true);
  });

  it("follows the documented column order", () => {
    expect(resolveCommittedOfferGrossPence({
      locked_base_fare_pence: 480,
      final_customer_fare_pence: 470,
      final_fare_pence: 460,
      estimated_total_pence: 450,
    })).toBe(480);
    expect(resolveCommittedOfferGrossPence({
      final_customer_fare_pence: 470,
      final_fare_pence: 460,
      estimated_total_pence: 450,
    })).toBe(470);
    expect(resolveCommittedOfferGrossPence({ final_fare_pence: 460, estimated_total_pence: 450 })).toBe(460);
    expect(resolveCommittedOfferGrossPence({ estimated_total_pence: 450 })).toBe(450);
  });

  it("falls to trip / payment-session authorised amount before breakdown", () => {
    const breakdown = { final_fare_pence: 500 };
    expect(resolveCommittedOfferGross({ authorised_amount_pence: 480, fare_breakdown: breakdown }))
      .toMatchObject({ pence: 480, source: "authorised_amount_pence", committed: true });
    expect(resolveCommittedOfferGross(
      { fare_breakdown: breakdown },
      { paymentSession: { authorised_amount_pence: 480 } },
    )).toMatchObject({ pence: 480, source: "authorised_amount_pence", committed: true });
  });

  it("ONLY breakdown present → still works from breakdown (not committed)", () => {
    expect(resolveCommittedOfferGross({ fare_breakdown: { final_fare_pence: 500 } }))
      .toEqual({ pence: 500, source: "fare_breakdown", committed: false });
    expect(resolveCommittedOfferGross({ fare_breakdown: { finalFare: 4.8, tripFare: 5 } }))
      .toEqual({ pence: 480, source: "fare_breakdown", committed: false });
    expect(resolveCommittedOfferGross({ fare_breakdown: { tripFare: 70, airportCharge: 7 } }))
      .toEqual({ pence: 7700, source: "fare_breakdown", committed: false });
  });

  it("a gross locked_base is not used as payable when a discount exists", () => {
    const trip = {
      locked_base_fare_pence: 1000,
      gross_fare_pence: 1000,
      offer_discount_pence: 100,
      discount_source: "global_offer",
      final_customer_fare_pence: 900,
      fare_breakdown: { final_fare_pence: 1000 },
    };
    expect(resolveCommittedOfferGrossPence(trip)).toBe(900);
  });

  it("waiting charges are not part of an offer gross", () => {
    const trip = { ...mk004Trip(), total_waiting_charge_pence: 150, pickup_waiting_charge_pence: 150 };
    expect(resolveCommittedOfferGrossPence(trip)).toBe(480);
  });

  it("returns 0 / none when nothing resolves", () => {
    expect(resolveCommittedOfferGross({})).toEqual({ pence: 0, source: "none", committed: false });
    expect(resolveCommittedOfferGross(null).pence).toBe(0);
  });
});

describe("stampOfferDriverNetFromCommittedFare", () => {
  it("MK-004 at 10%: net 432, not 450", () => {
    const stamp = stampOfferDriverNetFromCommittedFare({ trip: mk004Trip(), commissionPercent: 10 });
    expect(stamp.grossPence).toBe(480);
    expect(stamp.driverNetPence).toBe(432);
    expect(stamp.driverNetPence).not.toBe(450);
    expect(stamp.ok).toBe(true);
  });

  it("no airport: commissionable = 480", () => {
    const stamp = stampOfferDriverNetFromCommittedFare({ trip: mk004Trip(), commissionPercent: 10 });
    expect(stamp.airportPence).toBe(0);
    expect(stamp.commissionablePence).toBe(480);
    expect(stamp.commissionPence).toBe(48);
  });

  it("uses the supplied effective (wave) commission — no hardcoded 10%", () => {
    expect(stampOfferDriverNetFromCommittedFare({ trip: mk004Trip(), commissionPercent: 15 }).driverNetPence)
      .toBe(480 - 72);
    expect(stampOfferDriverNetFromCommittedFare({ trip: mk004Trip(), commissionPercent: 5 }).driverNetPence)
      .toBe(480 - 24);
    expect(stampOfferDriverNetFromCommittedFare({ trip: mk004Trip(), commissionPercent: Number.NaN }).ok)
      .toBe(false);
  });

  it("airport 900 on payable 4200 → airport non-commissionable (existing split rules)", () => {
    const trip = {
      final_customer_fare_pence: 4200,
      airport_charge_pence: 900,
      fare_breakdown: { final_fare_pence: 4200, trip_fare_pence: 3300, airport_charge_pence: 900 },
    };
    const stamp = stampOfferDriverNetFromCommittedFare({ trip, commissionPercent: 10 });
    expect(stamp.commissionablePence).toBe(3300);
    expect(stamp.commissionPence).toBe(330);
    expect(stamp.driverNetPence).toBe(3300 - 330 + 900);
  });

  it("airport from explicit input overrides trip lookup; other pass-through is non-commissionable", () => {
    const stamp = stampOfferDriverNetFromCommittedFare({
      trip: { final_customer_fare_pence: 4200 },
      commissionPercent: 10,
      airportPence: 900,
      otherPassThrough: 100,
    });
    expect(stamp.commissionablePence).toBe(3200);
    expect(stamp.driverNetPence).toBe(3200 - 320 + 900 + 100);
  });

  it("breakdown-only trip still stamps from the breakdown", () => {
    const stamp = stampOfferDriverNetFromCommittedFare({
      trip: { fare_breakdown: { final_fare_pence: 500 } },
      commissionPercent: 10,
    });
    expect(stamp.committed).toBe(false);
    expect(stamp.driverNetPence).toBe(450);
  });
});

describe("resolveNegotiationBaseFarePence / offer snapshot wiring", () => {
  it("MK-004 base fare is the committed 480 (preset base, standard_only_fallback)", () => {
    expect(resolveNegotiationBaseFarePence(mk004Trip() as never)).toBe(480);
  });

  it("breakdown-only trips keep legacy negotiation base", () => {
    expect(resolveNegotiationBaseFarePence({ fare_breakdown: { finalFare: 5 } } as never)).toBe(500);
    expect(resolveNegotiationBaseFarePence({ estimated_fare: 5 } as never)).toBe(500);
  });

  it("tripFareFieldsForOfferSnapshot cannot advertise 500 beside committed 480", () => {
    const fields = tripFareFieldsForOfferSnapshot(mk004Trip());
    expect(fields.trip_fare_pence).toBe(480);
    expect(fields.final_fare_pence).toBe(480);
    expect(fields.finalFare).toBe(4.8);
    expect(fields.totalFare).toBe(4.8);
    expect(fields.tripFare).toBe(4.8);
    expect(fields.fareSource).toBe("standard_only_fallback");
    expect(fields.committed_fare_pence).toBe(480);
  });

  it("with airport the ride portion excludes airport; final stays payable", () => {
    const fields = tripFareFieldsForOfferSnapshot({
      final_customer_fare_pence: 4200,
      airport_charge_pence: 900,
      fare_breakdown: { trip_fare_pence: 3300, airport_charge_pence: 900, final_fare_pence: 4200 },
    });
    expect(fields.trip_fare_pence).toBe(3300);
    expect(fields.final_fare_pence).toBe(4200);
    expect(fields.airport_charge_pence).toBe(900);
  });

  it("breakdown-only trips keep breakdown fields untouched", () => {
    const fields = tripFareFieldsForOfferSnapshot({ fare_breakdown: { tripFare: 5, finalFare: 5 } });
    expect(fields.trip_fare_pence).toBe(500);
    expect(fields.final_fare_pence).toBeUndefined();
  });

  it("standard_only_fallback path: committed 480 → enrich stamps net 432 (not 450)", () => {
    const trip = mk004Trip();
    const baseFarePence = resolveNegotiationBaseFarePence(trip as never);
    const snapshot = enrichOfferSnapshotDriverNet(
      {
        baseFarePence,
        ...tripFareFieldsForOfferSnapshot(trip),
        negotiationLocked: true,
        rebroadcastStandardOnly: true,
        preset_options: [],
        fareSource: "standard_only_fallback",
      },
      {},
      10,
      baseFarePence,
      "GBP",
    );
    expect(snapshot.driver_net_fare_pence).toBe(432);
    expect(snapshot.driver_net_preview_pence).toBe(432);
    expect(snapshot.final_trip_fare_pence).toBe(480);
    expect(snapshot.trip_fare_pence).toBe(480);
    expect(snapshot.final_fare_pence).toBe(480);
    expect(snapshot.platform_commission_pence).toBe(48);
  });

  it("Phase 5 / exclusive activation prefers computed committed net over stale stamped 450", () => {
    const trip = {
      ...mk004Trip(),
      driver_net_pence: 450,
      offered_driver_net_pence: 450,
      driver_net_before_tip_pence: 450,
    };
    expect(resolveActivationGrossPenceForPreview(trip as never)).toBe(480);
    expect(
      resolveExclusiveActivationDriverNetPence({
        trip: trip as never,
        computedPreviewPence: 432,
      }),
    ).toBe(432);
    expect(
      resolveExclusiveActivationDriverNetPence({
        trip: trip as never,
        computedPreviewPence: null,
      }),
    ).toBe(450);
  });

  it("negotiation presets keep their own negotiated gross", () => {
    const snapshot = enrichOfferSnapshotDriverNet(
      { baseFarePence: 480, preset_options: [{ key: "up", grossFarePence: 600 }] },
      {},
      10,
      480,
    );
    const preset = (snapshot.preset_options as Array<Record<string, number>>)[0];
    expect(preset.grossFarePence).toBe(600);
    expect(preset.driverNetPence).toBe(540);
    expect(snapshot.driver_net_fare_pence).toBe(432);
  });

  it("scheduled exclusive activation gross uses committed 480 (not breakdown 500)", () => {
    expect(resolveActivationGrossPenceForPreview(mk004Trip() as never)).toBe(480);
    expect(resolveActivationGrossPenceForPreview({ estimated_total_pence: 5000, final_customer_fare_pence: 5000 } as never))
      .toBe(5000);
    expect(resolveActivationGrossPenceForPreview({ estimated_fare: 50 } as never)).toBe(5000);
    expect(resolveActivationGrossPenceForPreview({} as never)).toBeNull();
  });

  it("restamp planner prefers committed payable over a stale snapshot baseFarePence", () => {
    const plan = planExistingPendingOfferRestamp({
      nowMs: Date.parse("2026-11-13T12:00:00Z"),
      payablePence: 4200,
      airportPence: 900,
      offers: [{
        id: "o1",
        status: "pending",
        expires_at: "2026-11-13T12:05:00Z",
        dispatch_wave: 1,
        effective_commission_percent: 10,
        offer_snapshot: { baseFarePence: 5000 },
        offered_driver_net_pence: 4500,
      }],
      resolveWavePercent: () => 10,
    });
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].offered_driver_net_pence).toBe(3300 - 330 + 900);
  });
});

describe("planCommittedFareDriftRestamp (offers created before committed payable was visible)", () => {
  const nowMs = Date.parse("2026-11-13T12:00:00Z");
  const offer = (over: Record<string, unknown> = {}) => ({
    id: "offer-1",
    status: "pending",
    is_stacked: false,
    expires_at: "2026-11-13T12:05:00Z",
    dispatch_wave: 1,
    effective_commission_percent: 10,
    offer_snapshot: {
      baseFarePence: 500,
      final_trip_fare_pence: 500,
      trip_fare_pence: 500,
      driver_net_fare_pence: 450,
      preset_options: [{ key: "up", grossFarePence: 600, driverNetPence: 540 }],
    },
    offered_driver_net_pence: 450,
    ...over,
  });

  it("restamps 450 → 432 and aligns snapshot to committed 480, presets untouched", () => {
    const plan = planCommittedFareDriftRestamp({ nowMs, trip: mk004Trip(), offers: [offer()] as never });
    expect(plan.updates).toHaveLength(1);
    const u = plan.updates[0];
    expect(u.offered_driver_net_pence).toBe(432);
    expect(u.offer_snapshot.baseFarePence).toBe(480);
    expect(u.offer_snapshot.final_trip_fare_pence).toBe(480);
    expect(u.offer_snapshot.trip_fare_pence).toBe(480);
    expect(u.offer_snapshot.final_fare_pence).toBe(480);
    expect(u.offer_snapshot.driver_net_fare_pence).toBe(432);
    expect(u.offer_snapshot.driver_net_preview_pence).toBe(432);
    expect(u.offer_snapshot.platform_commission_pence).toBe(48);
    expect(u.offer_snapshot.preset_options).toEqual([{ key: "up", grossFarePence: 600, driverNetPence: 540 }]);
  });

  it("is a no-op when already aligned", () => {
    const aligned = offer({
      offered_driver_net_pence: 432,
      offer_snapshot: { baseFarePence: 480, final_trip_fare_pence: 480 },
    });
    const plan = planCommittedFareDriftRestamp({ nowMs, trip: mk004Trip(), offers: [aligned] as never });
    expect(plan.updates).toHaveLength(0);
    expect(plan.skipped[0].reason).toBe("already_committed");
  });

  it("skips non-pending, stacked, expired, rate-less offers and breakdown-only trips", () => {
    const plan = planCommittedFareDriftRestamp({
      nowMs,
      trip: mk004Trip(),
      offers: [
        offer({ id: "a", status: "revoked" }),
        offer({ id: "b", is_stacked: true }),
        offer({ id: "c", expires_at: "2026-11-13T11:00:00Z" }),
        offer({ id: "d", effective_commission_percent: null }),
      ] as never,
    });
    expect(plan.updates).toHaveLength(0);
    expect(plan.skipped.map((s) => s.reason)).toEqual(["not_pending", "stacked", "expired", "rate_unresolved"]);

    const breakdownOnly = planCommittedFareDriftRestamp({
      nowMs,
      trip: { fare_breakdown: { final_fare_pence: 500 } },
      offers: [offer()] as never,
    });
    expect(breakdownOnly.updates).toHaveLength(0);
    expect(breakdownOnly.skipped[0].reason).toBe("no_committed_fare");
  });

  it("overlay helper only touches fare fields", () => {
    const out = overlayCommittedPayableOnFareFields({ keep: "x", trip_fare_pence: 500 }, 480, 0);
    expect(out).toMatchObject({ keep: "x", trip_fare_pence: 480, final_fare_pence: 480, totalFare: 4.8 });
  });
});

describe("bookingFareSplitFromQuote — commissionable follows payable", () => {
  it("payable 480, quote ride 500, airport 0 → commissionable 480 (not 500)", () => {
    expect(bookingFareSplitFromQuote({
      payablePence: 480,
      fareBreakdown: { trip_fare_pence: 500, airport_charge_pence: 0, final_fare_pence: 500 },
    })).toEqual({ airport_charge_pence: 0, commissionable_fare_pence: 480 });
  });

  it("consistent quote is unchanged (4200 = 3300 + 900)", () => {
    expect(bookingFareSplitFromQuote({
      payablePence: 4200,
      fareBreakdown: { trip_fare_pence: 3300, airport_charge_pence: 900 },
    })).toEqual({ airport_charge_pence: 900, commissionable_fare_pence: 3300 });
  });

  it("payable above ride + airport keeps the quote ride fare", () => {
    expect(bookingFareSplitFromQuote({
      payablePence: 7700,
      fareBreakdown: { tripFare: 70, airportCharge: 5 },
    })).toEqual({ airport_charge_pence: 500, commissionable_fare_pence: 7000 });
  });

  it("applyBookingFinancialSnapshotToTripData stamps commissionable 480 for payable 480 / quote 500", () => {
    const tripData: Record<string, unknown> = {};
    applyBookingFinancialSnapshotToTripData(
      tripData,
      { trip_fare_pence: 500, airport_charge_pence: 0 },
      { grossFarePence: 480, finalPayableFarePence: 480, pricingSource: "test" },
    );
    expect(tripData.final_customer_fare_pence).toBe(480);
    expect(tripData.commissionable_fare_pence).toBe(480);
    expect(tripData.airport_charge_pence).toBe(0);
  });
});

describe("MK-007 global_offer — commission base is the PRE-promotion total (driver 6820, never 6640)", () => {
  // quote ride 6800 + airport 700 = 7500, global_offer -200 -> payable 7300 (ONECAB-funded from commission).
  const trip = {
    final_customer_fare_pence: 7300,
    final_fare_pence: 7300,
    estimated_total_pence: 7300,
    gross_fare_pence: 7500,
    airport_charge_pence: 700,
    offer_discount_pence: 200,
    discount_pence: 200,
    discount_source: "global_offer",
  };

  it("offer stamp: gross stays the payable 7300, commissionable 6800, driver 6120 + 700 = 6820", () => {
    const stamp = stampOfferDriverNetFromCommittedFare({ trip, commissionPercent: 10 });
    expect(stamp.grossPence).toBe(7300);
    expect(stamp.commissionablePence).toBe(6800);
    expect(stamp.commissionPence).toBe(680);
    expect(stamp.driverNetPence).toBe(6820);
    expect(stamp.driverNetPence).not.toBe(6640);
  });

  it("voucher (not ONECAB-funded) keeps payable - airport: 6640", () => {
    const stamp = stampOfferDriverNetFromCommittedFare({
      trip: { ...trip, discount_source: "personal_voucher", offer_discount_pence: 0, voucher_discount_pence: 200 },
      commissionPercent: 10,
    });
    expect(stamp.driverNetPence).toBe(6640);
  });

  it("bookingFareSplitFromQuote: global_offer never shrinks commissionable to payable - airport", () => {
    const fareBreakdown = { trip_fare_pence: 6800, airport_charge_pence: 700 };
    expect(bookingFareSplitFromQuote({ payablePence: 7300, fareBreakdown, lockedPromotionPence: 200 }))
      .toEqual({ airport_charge_pence: 700, commissionable_fare_pence: 6800 });
    expect(bookingFareSplitFromQuote({ payablePence: 7300, fareBreakdown }))
      .toEqual({ airport_charge_pence: 700, commissionable_fare_pence: 6600 });
  });

  it("applyBookingFinancialSnapshotToTripData: global_offer stamps commissionable 6800 (payable 7300 unchanged)", () => {
    const tripData: Record<string, unknown> = {};
    applyBookingFinancialSnapshotToTripData(
      tripData,
      { trip_fare_pence: 6800, airport_charge_pence: 700 },
      { grossFarePence: 7500, finalPayableFarePence: 7300, offerDiscountPence: 200, discountSource: "global_offer", pricingSource: "test" },
    );
    expect(tripData.final_customer_fare_pence).toBe(7300);
    expect(tripData.commissionable_fare_pence).toBe(6800);
    expect(tripData.airport_charge_pence).toBe(700);
  });

  it("applyBookingFinancialSnapshotToTripData: voucher still follows the payable (6600)", () => {
    const tripData: Record<string, unknown> = {};
    applyBookingFinancialSnapshotToTripData(
      tripData,
      { trip_fare_pence: 6800, airport_charge_pence: 700 },
      { grossFarePence: 7500, finalPayableFarePence: 7300, voucherDiscountPence: 200, discountSource: "personal_voucher", pricingSource: "test" },
    );
    expect(tripData.commissionable_fare_pence).toBe(6600);
  });

  it("planCommittedFareDriftRestamp restamps a stale 6570 offer to 6820 on a global_offer trip", () => {
    const plan = planCommittedFareDriftRestamp({
      nowMs: Date.parse("2026-11-13T12:00:00.000Z"),
      trip,
      offers: [{
        id: "o1", status: "pending", is_stacked: false, expires_at: "2026-11-13T12:10:00.000Z", dispatch_wave: 1,
        effective_commission_percent: 10, offer_snapshot: { baseFarePence: 7300 }, offered_driver_net_pence: 6570,
      }],
    });
    expect(plan.updates[0]?.offered_driver_net_pence).toBe(6820);
  });
});

describe("wiring locks (source)", () => {
  it("negotiationBaseFare delegates to the committed SSOT", () => {
    const src = read("supabase/functions/_shared/negotiationBaseFare.ts");
    expect(src).toContain("resolveCommittedOfferGross");
  });
  it("tripFareSnapshot overlays committed payable", () => {
    const src = read("supabase/functions/_shared/tripFareSnapshot.ts");
    expect(src).toContain("overlayCommittedPayableOnFareFields");
  });
  it("scheduled activation gross delegates to the committed SSOT", () => {
    const src = read("supabase/functions/_shared/scheduledActivationExclusiveSSOT.ts");
    expect(src).toContain("resolveCommittedOfferGross");
    expect(src).toContain("Prefer computed preview from committed gross");
  });
  it("auto-dispatch resolves committed gross and re-stamps drifted offers", () => {
    const src = read("supabase/functions/auto-dispatch/index.ts");
    expect(src).toContain("committedBookingOfferFareSSOT.ts");
    expect(src).toContain("applyCommittedFareDriftRestamp");
    expect(src).toContain("resolveNegotiationBaseFarePence(trip)");
    expect(src).not.toContain("Number(snapshot.baseFarePence ?? baseFarePence)");
  });
  it("committed SSOT never reads fare_breakdown trip_fare_pence before committed columns", () => {
    const src = read("supabase/functions/_shared/committedBookingOfferFareSSOT.ts");
    expect(src.indexOf("authorised_amount_pence")).toBeLessThan(src.indexOf("// 7. fare_breakdown"));
    expect(src.indexOf("final_customer_fare_pence")).toBeLessThan(src.indexOf("// 7. fare_breakdown"));
  });
});
