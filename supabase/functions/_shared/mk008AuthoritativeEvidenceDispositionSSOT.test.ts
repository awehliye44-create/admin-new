/**
 * Step 9.3A lock — MK-260817-008 evidence disposition + stacked stamp atomicity.
 * Read-only fixtures. Never credits money.
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyMk008Evidence,
  DISPOSITION,
  entitlementFromAcceptedOfferSnapshot,
  entitlementFromNullStampFallbacks,
  mk008ProductionEvidenceFixture,
  MK008_ACCEPTED_OFFER_ID,
  orphanOfferCannotAuthorise,
} from "./mk008AuthoritativeEvidenceDispositionSSOT.ts";
import {
  classifyMissingTen,
  MISSING_TEN_CLASS,
} from "./missingTripEarningNetDetectSSOT.ts";

Deno.test("orphan / pending offer cannot authorise money", () => {
  assertEquals(
    orphanOfferCannotAuthorise({
      id: "x",
      trip_id: "t",
      driver_id: "d",
      status: "pending",
      offered_driver_net_pence: 609,
      offer_snapshot_net_pence: 609,
      is_stacked: true,
    }),
    true,
  );
  assertEquals(
    orphanOfferCannotAuthorise({
      id: "x",
      trip_id: "t",
      driver_id: "d",
      status: "accepted",
      offered_driver_net_pence: 609,
      offer_snapshot_net_pence: 609,
      is_stacked: true,
    }),
    false,
  );
  assertEquals(
    entitlementFromAcceptedOfferSnapshot({
      tripId: "t",
      driverId: "d",
      offers: [{
        id: "o1",
        trip_id: "t",
        driver_id: "d",
        status: "pending",
        offered_driver_net_pence: 609,
        offer_snapshot_net_pence: 609,
        is_stacked: true,
      }],
      acceptanceAudits: [],
    }),
    null,
  );
});

Deno.test("accepted offer linked by immutable ID + audit authorises exact entitlement", () => {
  const fx = mk008ProductionEvidenceFixture();
  const got = entitlementFromAcceptedOfferSnapshot({
    tripId: fx.trip.id,
    driverId: fx.trip.driver_id!,
    offers: fx.offers,
    acceptanceAudits: fx.acceptanceAudits,
  });
  assertEquals(got, { entitlement_pence: 609, offer_id: MK008_ACCEPTED_OFFER_ID });

  const classified = classifyMk008Evidence(fx);
  assertEquals(classified.primary, DISPOSITION.AUTHORITATIVE_UNPAID_DRIVER_LIABILITY);
  assertEquals(classified.authoritative_entitlement_pence, 609);
  assertEquals(classified.accepted_offer_link_proven, true);
  assertEquals(classified.credit_approved_by_evidence, true);
  assertEquals(classified.accompanying_defect, DISPOSITION.SOURCE_WORKFLOW_DEFECT_CONFIRMED);
});

Deno.test("conflicting accepted offers remain PENDING_EVIDENCE", () => {
  const fx = mk008ProductionEvidenceFixture();
  fx.offers.push({
    id: "other-accepted",
    trip_id: fx.trip.id,
    driver_id: fx.trip.driver_id!,
    status: "accepted",
    offered_driver_net_pence: 633,
    offer_snapshot_net_pence: 633,
    is_stacked: true,
  });
  const classified = classifyMk008Evidence(fx);
  assertEquals(classified.primary, DISPOSITION.PENDING_EVIDENCE);
  assertEquals(classified.authoritative_entitlement_pence, null);
  assertEquals(classified.credit_approved_by_evidence, false);
});

Deno.test("null saved entitlement never falls back to captured amount or percentage", () => {
  assertEquals(
    entitlementFromNullStampFallbacks({
      driver_net_pence: null,
      captured_amount_pence: 716,
      gross_fare_pence: 745,
      commission_percent: 15,
    }),
    null,
  );
  // Detector SSOT also refuses invention
  const det = classifyMissingTen({
    financialModel: "PLATFORM_COLLECTED",
    tripStatus: "completed",
    driverId: "d",
    driverNetPence: null,
    tenCount: 0,
    rideBookingSessions: [{
      id: "ps",
      status: "trip_created",
      provider_state: "COMPLETED",
      provider_order_id: "o",
      provider_capture_id: "c",
      captured_amount_pence: 716,
      captured_at: "2026-08-17T18:51:51Z",
      financial_operation_state: "CAPTURED",
      released_amount_pence: 0,
      refunded_amount_pence: 0,
    }],
  });
  assertEquals(det?.classification, MISSING_TEN_CLASS.PENDING_EVIDENCE_MISSING_TEN);
  assertEquals(det?.authoritative_amount_pence, null);
});

Deno.test("row/snapshot net mismatch is not authoritative", () => {
  const fx = mk008ProductionEvidenceFixture();
  fx.offers[0].offer_snapshot_net_pence = 633;
  const classified = classifyMk008Evidence(fx);
  assertEquals(classified.primary, DISPOSITION.PENDING_EVIDENCE);
  assertEquals(classified.authoritative_entitlement_pence, null);
});

Deno.test("stacked accept SQL stamps offer id + net atomically before queue", async () => {
  const sql = await Deno.readTextFile(
    new URL("../../migrations/20260927190000_stacked_accept_wave_commission_snapshot.sql", import.meta.url),
  );
  const fn = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.accept_stacked_ride"));
  const offerStamp = fn.indexOf("accepted_ride_offer_id = p_offer_id");
  const snapshot = fn.indexOf("PERFORM public.snapshot_accepted_wave_commission");
  const failClosed = fn.indexOf("stacked_fare_snapshot_failed::driver_net");
  const queued = fn.indexOf("status           = 'queued'");
  assertEquals(offerStamp > 0, true);
  assertEquals(snapshot > offerStamp, true);
  assertEquals(failClosed > snapshot, true);
  assertEquals(queued > failClosed, true);
});

Deno.test("FR / disposition modules do not credit wallet money", async () => {
  const disp = await Deno.readTextFile(
    new URL("./mk008AuthoritativeEvidenceDispositionSSOT.ts", import.meta.url),
  );
  const det = await Deno.readTextFile(
    new URL("./missingTripEarningNetDetectSSOT.ts", import.meta.url),
  );
  const mon = await Deno.readTextFile(
    new URL("../financial-ssot-monitor/index.ts", import.meta.url),
  );
  for (const src of [disp, det, mon]) {
    assertEquals(src.includes("creditCapturedCardTripLedger"), false);
    assertEquals(src.includes('from("driver_wallet_ledger").insert'), false);
    assertEquals(src.includes("financial_ssot_repairs"), false);
  }
});

Deno.test("no DRIVER_COLLECTED contamination in disposition", () => {
  const fx = mk008ProductionEvidenceFixture();
  fx.trip.financial_model = "DRIVER_COLLECTED_COMMISSION_WALLET";
  const classified = classifyMk008Evidence(fx);
  assertEquals(classified.primary, DISPOSITION.PENDING_EVIDENCE);
  assertEquals(classified.credit_approved_by_evidence, false);

  const det = classifyMissingTen({
    financialModel: "DRIVER_COLLECTED_COMMISSION_WALLET",
    tripStatus: "completed",
    driverId: "d",
    driverNetPence: null,
    tenCount: 0,
    rideBookingSessions: [],
  });
  assertEquals(det, null);
});

Deno.test("detector keeps unresolved null entitlement open (PENDING_EVIDENCE)", () => {
  const det = classifyMissingTen({
    financialModel: "PLATFORM_COLLECTED",
    tripStatus: "completed",
    driverId: "cd8bae4c-3827-4b90-98c6-10be70eb0e52",
    driverNetPence: null,
    tenCount: 0,
    rideBookingSessions: [{
      id: "7453c3e4-677b-4424-b603-297b321fc90e",
      status: "trip_created",
      provider_state: "COMPLETED",
      provider_order_id: "6a835612-c64d-aa32-b5cb-cf25cf0af4c2",
      provider_capture_id: "6a835613-d31b-ab07-bfc8-3fbca251cc05",
      captured_amount_pence: 716,
      captured_at: "2026-08-17T18:51:51.96+00:00",
      financial_operation_state: "CAPTURED",
      released_amount_pence: 0,
      refunded_amount_pence: 0,
    }],
  });
  assertEquals(det?.classification, MISSING_TEN_CLASS.PENDING_EVIDENCE_MISSING_TEN);
  assertEquals(det?.authoritative_amount_pence, null);
  assertStringIncludes(det?.reason ?? "", "do not invent entitlement");
});
