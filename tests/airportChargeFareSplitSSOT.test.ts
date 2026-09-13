/**
 * Airport pass-through fare split. Fixture amounts and wave rates are inputs,
 * not production constants. No wallet, payment, refund, or recapture mutation.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  airportAlreadyInsidePayable,
  assessPersistedAirportSplit,
  bookingFareSplitFromQuote,
  commissionPercentFromActiveWave,
  decideAlreadyOfferedRestamp,
  decideDispatchAfterFareEnrich,
  driverNetFromActiveWave,
  planExistingPendingOfferRestamp,
  stampOfferSnapshotAirportPassThrough,
  type ExistingOfferForRestamp,
  type WaveCommissionRate,
} from "../supabase/functions/_shared/airportChargeFareSplitSSOT.ts";
import { draftAlreadyOfferedRestamp } from "../supabase/drafts/airport_charge_fare_split/autoDispatchRestampExistingPendingOffer.draft.ts";
import {
  computeCaptureAmount,
  computeFinalFarePence,
} from "../supabase/functions/_shared/tripFareSSOT.ts";
import { tripFareFieldsForOfferSnapshot } from "../supabase/functions/_shared/tripFareSnapshot.ts";

const ssotPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../supabase/functions/_shared/airportChargeFareSplitSSOT.ts",
);

/** Stand-in for resolveWaveCommission / resolve_wave_commission_percent. */
function mockedActiveWave(effectivePercent: number): WaveCommissionRate {
  return { effectivePercent };
}

const quote = {
  tripFare: 70,
  airportCharge: 7,
  finalFare: 77,
  pricing_mode: "ROUTE_PRICING",
};

describe("airport charge fare split", () => {
  it("persists payable inclusive, airport column, and commissionable ride fare from the quote", () => {
    const payablePence = 7700;
    const split = bookingFareSplitFromQuote({
      payablePence,
      fareBreakdown: quote,
    });
    expect(split).toEqual({
      airport_charge_pence: 700,
      commissionable_fare_pence: 7000,
    });
    expect(payablePence).toBe(7700);
  });

  it("offer net excludes airport from commission using the mocked active wave rate", () => {
    const wave = mockedActiveWave(15);
    const rate = commissionPercentFromActiveWave(wave);
    expect(rate).toBe(wave.effectivePercent);

    const net = driverNetFromActiveWave({
      customerPence: 7700,
      airportPence: 700,
      wave,
    });
    expect(net.commissionablePence).toBe(7000);
    expect(net.commissionPence).toBe(Math.round((7000 * rate) / 100));
    expect(net.driverNetPence).toBe(6650);
  });

  it("uses a wave-reduced rate from the helper, not a baked-in rate", () => {
    const baseWave = mockedActiveWave(15);
    const reducedWave = mockedActiveWave(baseWave.effectivePercent - 5);
    expect(commissionPercentFromActiveWave(reducedWave)).not.toBe(
      commissionPercentFromActiveWave(baseWave),
    );

    const net = driverNetFromActiveWave({
      customerPence: 7700,
      airportPence: 700,
      wave: reducedWave,
    });
    const rate = commissionPercentFromActiveWave(reducedWave);
    expect(net.commissionablePence).toBe(7000);
    expect(net.commissionPence).toBe(Math.round((7000 * rate) / 100));
    expect(net.driverNetPence).toBe(7000 - net.commissionPence + 700);
    expect(net.driverNetPence).not.toBe(6650);
  });

  it("preset chip total excludes airport from commission then adds it back", () => {
    const wave = mockedActiveWave(15);
    const stamped = stampOfferSnapshotAirportPassThrough({
      snapshot: {
        baseFarePence: 7700,
        preset_options: [{ key: "faster", label: "Faster", grossFarePence: 7800 }],
      },
      customerGrossPence: 7700,
      airportPence: 700,
      commissionPercent: commissionPercentFromActiveWave(wave),
    });
    const preset = (stamped.snapshot.preset_options as Array<Record<string, number>>)[0];
    const rate = commissionPercentFromActiveWave(wave);
    const commissionable = 7800 - 700;
    expect(commissionable).toBe(7100);
    expect(preset.grossFarePence).toBe(7800);
    expect(preset.driverNetPence).toBe(
      commissionable - Math.round((commissionable * rate) / 100) + 700,
    );
  });

  it("leaves a normal route with airport 0 unchanged", () => {
    const wave = mockedActiveWave(15);
    const net = driverNetFromActiveWave({
      customerPence: 5000,
      airportPence: 0,
      wave,
    });
    expect(net.commissionablePence).toBe(5000);
    expect(net.driverNetPence).toBe(5000 - Math.round((5000 * wave.effectivePercent) / 100));

    const stamped = stampOfferSnapshotAirportPassThrough({
      snapshot: { driver_net_fare_pence: net.driverNetPence },
      customerGrossPence: 5000,
      airportPence: 0,
      commissionPercent: wave.effectivePercent,
    });
    expect(stamped.offeredDriverNetPence).toBeNull();
    expect(stamped.snapshot.route_extra_items).toBeUndefined();
    expect(stamped.snapshot.driver_net_fare_pence).toBe(net.driverNetPence);
  });

  it("completion/capture does not add airport again when the locked payable already includes it", () => {
    const inclusive = {
      final_customer_fare_pence: 7700,
      final_fare_pence: 7700,
      locked_base_fare_pence: 7700,
      airport_charge_pence: 700,
      commissionable_fare_pence: 7000,
      fare_breakdown: quote,
    };
    expect(airportAlreadyInsidePayable({
      payablePence: 7700,
      airportPence: 700,
      commissionableFarePence: 7000,
      quoteRideFarePence: 7000,
      quoteFinalFarePence: 7700,
    })).toBe(true);
    expect(computeFinalFarePence(inclusive)).toBe(7700);
    expect(computeCaptureAmount(inclusive, "completed").capture_amount_pence).toBe(7700);
    expect(computeFinalFarePence(inclusive)).not.toBe(8400);

    const jsonOnlyInclusive = {
      final_customer_fare_pence: 7700,
      final_fare_pence: 7700,
      airport_charge_pence: 0,
      fare_breakdown: quote,
    };
    expect(computeFinalFarePence(jsonOnlyInclusive)).toBe(7700);
    expect(computeCaptureAmount(jsonOnlyInclusive, "completed").capture_amount_pence).toBe(7700);

    const rideOnlyPayable = {
      final_customer_fare_pence: 7000,
      final_fare_pence: 7000,
      airport_charge_pence: 700,
      fare_breakdown: { tripFare: 70, airportCharge: 7, finalFare: 77 },
    };
    expect(computeFinalFarePence(rideOnlyPayable)).toBe(7700);
  });

  it("driver offer payload includes the airport chip field and does not invent earnings", () => {
    const wave = mockedActiveWave(15);
    const stamped = stampOfferSnapshotAirportPassThrough({
      snapshot: { driver_net_fare_pence: 6545, baseFarePence: 7700 },
      customerGrossPence: 7700,
      airportPence: 700,
      commissionPercent: commissionPercentFromActiveWave(wave),
    });
    expect(stamped.snapshot.airport_charge_pence).toBe(700);
    expect(stamped.snapshot.route_extra_items).toEqual([
      { type: "airport", label: "Airport", amount_pence: 700 },
    ]);
    expect(stamped.offeredDriverNetPence).toBe(6650);
    expect(stamped.snapshot.driver_net_fare_pence).toBe(6650);
  });

  it("does not mutate wallets, payments, refunds, or recapture", () => {
    const src = readFileSync(ssotPath, "utf8");
    expect(src).not.toMatch(/supabase\.from/);
    expect(src).not.toMatch(/from\("trips"\)|from\("ride_offers"\)|from\("payments"\)/);
    expect(src).not.toMatch(/\b(700|15)\b/);
  });

  it("allows dispatch only after a confirmed airport column write", () => {
    const persisted = decideDispatchAfterFareEnrich({
      quoteAirportPence: 700,
      persistedAirportPence: 700,
      updateFailed: false,
    });
    expect(persisted).toEqual({
      allowDispatch: true,
      holdBroadcast: false,
      reason: "airport_persisted",
    });

    const failed = decideDispatchAfterFareEnrich({
      quoteAirportPence: 700,
      persistedAirportPence: 0,
      updateFailed: true,
    });
    expect(failed.allowDispatch).toBe(false);
    expect(failed.holdBroadcast).toBe(true);
    expect(failed.reason).toBe("airport_persist_failed");

    const normal = decideDispatchAfterFareEnrich({
      quoteAirportPence: 0,
      persistedAirportPence: null,
      updateFailed: true,
    });
    expect(normal).toEqual({
      allowDispatch: true,
      holdBroadcast: false,
      reason: "airport_absent",
    });
  });

  it("does not dispatch an airport quote when booking enrich persist fails", () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../supabase/functions/_shared/bookingPostCommit.ts"),
      "utf8",
    );
    const gate = src.indexOf("if (!enrich.allowDispatch)");
    const dispatch = src.indexOf("invokeAutoDispatch(ctx.supabase");
    expect(gate).toBeGreaterThan(-1);
    expect(dispatch).toBeGreaterThan(gate);
    expect(src).toContain("AIRPORT_FARE_PERSIST_FAILED_DISPATCH_BLOCKED");
    expect(src).toContain("broadcast_enabled: false");
    expect(src).not.toMatch(/from\("payment_sessions"\)|from\("wallets"\)/);
  });

  it("treats airportCharge as major units, including 100, and prefers explicit pence", () => {
    expect(tripFareFieldsForOfferSnapshot({
      fare_breakdown: { airportCharge: 7, tripFare: 70 },
    }).airport_charge_pence).toBe(700);

    expect(tripFareFieldsForOfferSnapshot({
      fare_breakdown: { airport_charge_pence: 700, airportCharge: 7 },
    }).airport_charge_pence).toBe(700);

    const hundred = tripFareFieldsForOfferSnapshot({
      fare_breakdown: { airportCharge: 100, tripFare: 70 },
    });
    expect(hundred.airport_charge_pence).toBe(10000);
    expect(hundred.airport_charge_pence).not.toBe(100);
    expect(hundred.route_extra_items).toEqual([
      { type: "airport", label: "Airport", amount_pence: 10000 },
    ]);
  });

  it("does not add airport again when waiting is separate, or when a folded modification is already in the payable", () => {
    const waitingSeparate = {
      final_customer_fare_pence: 7700,
      final_fare_pence: 7700,
      airport_charge_pence: 700,
      commissionable_fare_pence: 7000,
      pickup_waiting_charge_pence: 200,
      fare_breakdown: quote,
    };
    expect(computeFinalFarePence(waitingSeparate)).toBe(7900);
    expect(computeCaptureAmount(waitingSeparate, "completed").capture_amount_pence).toBe(7900);

    const foldedModification = {
      final_customer_fare_pence: 7966,
      final_fare_pence: 7966,
      fare_locked: true,
      airport_charge_pence: 700,
      commissionable_fare_pence: 7000,
      customer_modification_charge_pence: 266,
      fare_breakdown: quote,
    };
    expect(airportAlreadyInsidePayable({
      payablePence: 7966,
      airportPence: 700,
      commissionableFarePence: 7000,
      quoteRideFarePence: 7000,
      extraAlreadyInPayablePence: 266,
    })).toBe(true);
    expect(computeFinalFarePence(foldedModification)).toBe(7966);
    expect(computeFinalFarePence(foldedModification)).not.toBe(8666);
  });

  it("restamps the early pending offer after the trip split is persisted, once", () => {
    const payablePence = 7700;
    const airportPence = 700;
    const commissionablePence = payablePence - airportPence;
    const wave = mockedActiveWave(15);
    const rate = commissionPercentFromActiveWave(wave);
    const expectedNet = driverNetFromActiveWave({
      customerPence: payablePence,
      airportPence,
      wave,
    });
    const presetGrossPence = 7800;
    const presetCommissionable = presetGrossPence - airportPence;
    const presetNet = presetCommissionable
      - Math.round((presetCommissionable * rate) / 100)
      + airportPence;
    const offerId = "existing-pending-offer";
    const expiresAt = "2026-09-13T11:16:27.940Z";
    const earlyOffer: ExistingOfferForRestamp = {
      id: offerId,
      status: "pending",
      is_stacked: false,
      expires_at: expiresAt,
      dispatch_wave: 1,
      effective_commission_percent: rate,
      offered_driver_net_pence: payablePence - Math.round((payablePence * rate) / 100),
      offer_snapshot: {
        baseFarePence: payablePence,
        trigger_reason: "trip_insert",
        preset_options: [{ key: "standard", grossFarePence: presetGrossPence }],
      },
    };
    const revoked = {
      ...earlyOffer,
      id: "revoked-offer",
      status: "revoked",
    };
    let offers = [earlyOffer];
    let notifications = 1;

    const split = bookingFareSplitFromQuote({
      payablePence,
      fareBreakdown: quote,
    });
    expect(split).toEqual({
      airport_charge_pence: airportPence,
      commissionable_fare_pence: commissionablePence,
    });

    const command = draftAlreadyOfferedRestamp({
      tripId: "trip-early-offer",
      nowMs: Date.parse("2026-09-13T11:11:29.000Z"),
      payablePence,
      airportPence: split!.airport_charge_pence,
      offers: [...offers, revoked],
      resolveWavePercent: () => {
        throw new Error("stored wave rate must be reused");
      },
    });

    expect(command.createOffer).toBe(false);
    expect(command.notify).toBe(false);
    expect(command.extendExpiry).toBe(false);
    expect(command.updates).toHaveLength(1);
    expect(command.updates[0].id).toBe(offerId);
    expect(command.updates[0].offered_driver_net_pence).toBe(expectedNet.driverNetPence);
    expect(command.updates[0].offer_snapshot.airport_charge_pence).toBe(airportPence);
    expect(command.updates[0].offer_snapshot.route_extra_items).toEqual([
      { type: "airport", label: "Airport", amount_pence: airportPence },
    ]);
    const preset = (command.updates[0].offer_snapshot.preset_options as Array<Record<string, number>>)[0];
    expect(preset.grossFarePence).toBe(presetGrossPence);
    expect(preset.driverNetPence).toBe(presetNet);
    expect(presetNet).toBe(6735);

    offers = offers.map((row) => row.id === offerId
      ? {
        ...row,
        offered_driver_net_pence: command.updates[0].offered_driver_net_pence,
        offer_snapshot: command.updates[0].offer_snapshot,
        expires_at: expiresAt,
        status: "pending",
      }
      : row);
    notifications += command.notify ? 1 : 0;

    expect(offers).toHaveLength(1);
    expect(offers[0].status).toBe("pending");
    expect(offers[0].expires_at).toBe(expiresAt);
    expect(offers[0].offered_driver_net_pence).toBe(expectedNet.driverNetPence);
    expect(chipFromPence(airportPence)).toBe("Airport +£7");
    expect(notifications).toBe(1);

    const again = planExistingPendingOfferRestamp({
      nowMs: Date.parse("2026-09-13T11:11:30.000Z"),
      payablePence,
      airportPence,
      offers,
      resolveWavePercent: () => wave.effectivePercent,
    });
    expect(again.updates).toEqual([]);
    expect(again.skipped).toEqual([{ id: offerId, reason: "already_stamped" }]);
    expect(again.notify).toBe(false);
    expect(again.createOffer).toBe(false);

    const draft = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "../supabase/drafts/airport_charge_fare_split/autoDispatchRestampExistingPendingOffer.draft.ts",
      ),
      "utf8",
    );
    expect(draft).toContain("decideAlreadyOfferedRestamp");
    expect(draft).toContain("Do not use storedRound + 1");
    expect(draft).not.toMatch(/from\("ride_offers"\)\.insert|functions\.invoke|expires_at:/);
    expect(draft).not.toMatch(/\b(700|15)\b/);

    const dispatch = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "../supabase/functions/auto-dispatch/index.ts",
      ),
      "utf8",
    );
    const restampAt = dispatch.indexOf("async function applyAlreadyOfferedAirportRestamp");
    const alreadyOfferedAt = dispatch.indexOf('message: "Trip already offered"');
    const createOffersAt = dispatch.indexOf("p_offers: offersToCreate");
    const restampFn = dispatch.slice(restampAt, dispatch.indexOf("Deno.serve", restampAt));
    expect(restampAt).toBeGreaterThan(-1);
    expect(alreadyOfferedAt).toBeGreaterThan(restampAt);
    expect(createOffersAt).toBeGreaterThan(alreadyOfferedAt);
    expect(dispatch).toContain("AIRPORT_OFFER_STAMP_UNREPRESENTABLE");
    expect(restampFn).toContain("offer_snapshot: update.offer_snapshot");
    expect(restampFn).toContain("offered_driver_net_pence: update.offered_driver_net_pence");
    expect(restampFn).not.toMatch(/functions\.invoke|\.insert\(|expires_at:/);
    expect(restampFn).not.toMatch(/\b(700|15)\b/);
  });

  it("fails closed when a known airport charge is not on the trip column", () => {
    const decision = decideAlreadyOfferedRestamp({
      nowMs: Date.parse("2026-09-13T11:11:29.000Z"),
      trip: {
        airport_charge_pence: 0,
        final_fare_pence: 7700,
        commissionable_fare_pence: 7700,
        fare_breakdown: quote,
      },
      offers: [pendingOffer()],
    });
    expect(decision.action).toBe("fail_closed");
    expect(decision.reason).toBe("airport_not_on_column");
    expect(decision.createOffer).toBe(false);
    expect(decision.notify).toBe(false);
    expect(decision.updates).toEqual([]);
  });

  it("fails closed when the persisted split does not add up or the wave rate is missing", () => {
    expect(assessPersistedAirportSplit({
      airport_charge_pence: 700,
      commissionable_fare_pence: 7700,
      final_fare_pence: 7700,
      fare_breakdown: quote,
    }).ok).toBe(false);

    const missingRate = decideAlreadyOfferedRestamp({
      nowMs: Date.parse("2026-09-13T11:11:29.000Z"),
      trip: persistedSplit(),
      offers: [{ ...pendingOffer(), effective_commission_percent: null }],
    });
    expect(missingRate.action).toBe("fail_closed");
    expect(missingRate.reason).toBe("rate_unresolved");
    expect(missingRate.notify).toBe(false);
    expect(missingRate.createOffer).toBe(false);

    const stackedOnly = decideAlreadyOfferedRestamp({
      nowMs: Date.parse("2026-09-13T11:11:29.000Z"),
      trip: persistedSplit(),
      offers: [{ ...pendingOffer(), is_stacked: true }],
    });
    expect(stackedOnly.action).toBe("fail_closed");
    expect(stackedOnly.reason).toBe("no_pending_offer_for_stamp");
    expect(stackedOnly.updates).toEqual([]);
  });
});

function persistedSplit() {
  return {
    airport_charge_pence: 700,
    commissionable_fare_pence: 7000,
    final_fare_pence: 7700,
    final_customer_fare_pence: 7700,
    fare_breakdown: quote,
  };
}

function pendingOffer(): ExistingOfferForRestamp {
  return {
    id: "existing-pending-offer",
    status: "pending",
    is_stacked: false,
    expires_at: "2026-09-13T11:16:27.940Z",
    dispatch_wave: 1,
    effective_commission_percent: 15,
    offered_driver_net_pence: 6545,
    offer_snapshot: { baseFarePence: 7700 },
  };
}

function chipFromPence(amountPence: number): string {
  const pounds = amountPence / 100;
  const text = Number.isInteger(pounds) ? String(pounds) : pounds.toFixed(2);
  return `Airport +£${text}`;
}
