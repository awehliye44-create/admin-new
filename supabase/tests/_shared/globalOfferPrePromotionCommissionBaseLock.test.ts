/**
 * Lock: MK-007 global_offer driver earnings are 6820 (NOT 6640) + the two rollout-safety migrations that
 * ship with it (ack-timeout trip-first lock order 20270222220000, warn-by-default FO001/FO002 20270222230000).
 *
 * SSOT (tripSettlement.ts golden / canonicalSettlementSSOT.ts):
 *   global_offer is ONECAB-funded from commission. `locked_promotion_pence` is deducted from ONECAB only.
 *   The driver entitlement uses the PRE-promotion commissionable fare — a promotion NEVER reduces driver_net.
 *   MK-007: quote ride 6800 + airport 700, discount 200 -> customer pays 7300.
 *     driver total = 6800 x 0.9 + 700 = 6820 ; platform absorbs 200 of the 680 commission.
 *     capture identity: 6120 + 680 + 700 - 200 = 7300.
 *
 * The SQL execution proof lives in supabase/tests/{committed_offer_fare_sql_ssot,airport_split_commissionable_follows_payable,
 * financial_offer_invariant_guard}.sql and supabase/tests/ack_timeout_lock_order_concurrency_isolated.sh (mandatory pg-harness).
 *
 * Run: deno test --no-check --allow-read supabase/tests/_shared/globalOfferPrePromotionCommissionBaseLock.test.ts
 * If this fails, fix the code — never delete or soften the lock.
 */
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assessPersistedAirportSplit,
  bookingFareSplitFromQuote,
  decideAlreadyOfferedRestamp,
  driverNetFromCustomerTotal,
  planExistingPendingOfferRestamp,
  prePromotionCustomerPence,
  resolveGlobalOfferPromotionPence,
} from "../../functions/_shared/airportChargeFareSplitSSOT.ts";
import { stampOfferDriverNetFromCommittedFare } from "../../functions/_shared/committedBookingOfferFareSSOT.ts";
import { enrichOfferSnapshotDriverNet } from "../../functions/_shared/driverOfferNetPreview.ts";
import { calculateTripSettlementFromTripRow } from "../../functions/_shared/tripSettlement.ts";

const read = (rel: string) => Deno.readTextFile(new URL(rel, import.meta.url));
const stripSqlComments = (sql: string) => sql.replace(/--.*$/gm, "");
const M = "../../migrations/";

// MK-007 as the settlement SSOT sees it (original ride 6800 + airport 700, global_offer -200, 10% tier).
const MK007_SETTLEMENT_TRIP = {
  fare_snapshot_json: { gross_fare_pence: 6800, original_fare_pence: 6800 },
  locked_base_fare_pence: 6800,
  offer_discount_pence: 200,
  discount_source: "global_offer",
  customer_modification_charge_pence: 0,
  airport_charge_pence: 700,
  final_fare_pence: 7300,
  final_customer_fare_pence: 7300,
  capture_amount_pence: 7300,
  accepted_commission_percent: 10,
};

// The same trip as the offer / booking write path sees it (committed payable 7300, quote ride 6800).
const MK007_OFFER_TRIP = {
  final_customer_fare_pence: 7300,
  final_fare_pence: 7300,
  estimated_total_pence: 7300,
  gross_fare_pence: 7500,
  airport_charge_pence: 700,
  offer_discount_pence: 200,
  discount_pence: 200,
  discount_source: "global_offer",
  commissionable_fare_pence: 6800,
};

// ---------------------------------------------------------------------------
// 1. tripSettlement golden: promotion never reduces driver entitlement
// ---------------------------------------------------------------------------
Deno.test("tripSettlement golden MK-007: driver 6820, commission 680, ONECAB absorbs 200, identity 6120+680+700-200 = 7300", () => {
  const s = calculateTripSettlementFromTripRow(MK007_SETTLEMENT_TRIP);
  assert(s);
  assertEquals(s.commissionable_fare_pence, 6800);
  assertEquals(s.commission_pence, 680);
  assertEquals(s.driver_net_pence, 6120);
  assertEquals(s.driver_total_earnings_pence, 6820);
  assertEquals(s.locked_promotion_pence, 200);
  assertEquals(s.applied_customer_promotion_pence, 200);
  assertEquals(s.commission_after_promotion_pence, 480);
  assertEquals(s.driver_net_pence + s.commission_pence + s.airport_charge_pence - s.applied_customer_promotion_pence, 7300);
  assert(s.driver_total_earnings_pence !== 6640, "6640 would take the ONECAB-funded promotion out of the driver's pocket");
});

Deno.test("a global_offer promotion NEVER reduces driver entitlement (any promotion size)", () => {
  // Same trip at full price (no promotion): the driver's entitlement is the yardstick.
  const base = calculateTripSettlementFromTripRow({
    ...MK007_SETTLEMENT_TRIP,
    offer_discount_pence: 0,
    discount_source: null,
    final_fare_pence: 7500,
    final_customer_fare_pence: 7500,
    capture_amount_pence: 7500,
  });
  assert(base);
  for (const promo of [1, 50, 200, 340, 680]) {
    const s = calculateTripSettlementFromTripRow({
      ...MK007_SETTLEMENT_TRIP,
      offer_discount_pence: promo,
      final_fare_pence: 7500 - promo,
      final_customer_fare_pence: 7500 - promo,
      capture_amount_pence: 7500 - promo,
    });
    assert(s);
    assertEquals(s.driver_total_earnings_pence, base.driver_total_earnings_pence, `promotion ${promo} changed driver earnings`);
    assertEquals(s.driver_net_pence, base.driver_net_pence);
    assertEquals(s.commission_pence, base.commission_pence);
  }
});

// ---------------------------------------------------------------------------
// 2. TS write paths agree with the settlement golden
// ---------------------------------------------------------------------------
Deno.test("bookingFareSplitFromQuote: global_offer keeps the quote ride as commissionable (never payable - airport)", () => {
  const fareBreakdown = { trip_fare_pence: 6800, airport_charge_pence: 700 };
  assertEquals(
    bookingFareSplitFromQuote({ payablePence: 7300, fareBreakdown, lockedPromotionPence: 200 }),
    { airport_charge_pence: 700, commissionable_fare_pence: 6800 },
  );
  // Not ONECAB-funded (voucher / unknown / negotiated): 190000 behaviour retained.
  assertEquals(
    bookingFareSplitFromQuote({ payablePence: 7300, fareBreakdown }),
    { airport_charge_pence: 700, commissionable_fare_pence: 6600 },
  );
  // A promotion can never lift commissionable above the pre-promotion total.
  assertEquals(
    bookingFareSplitFromQuote({ payablePence: 7300, fareBreakdown, lockedPromotionPence: 100 }),
    { airport_charge_pence: 700, commissionable_fare_pence: 6700 },
  );
  // Undiscounted trips unchanged.
  assertEquals(
    bookingFareSplitFromQuote({ payablePence: 7500, fareBreakdown }),
    { airport_charge_pence: 700, commissionable_fare_pence: 6800 },
  );
});

Deno.test("offer stamp (stampOfferDriverNetFromCommittedFare) = settlement driver total for global_offer, any rate / promotion", () => {
  const stamp = stampOfferDriverNetFromCommittedFare({ trip: MK007_OFFER_TRIP, commissionPercent: 10 });
  assertEquals(stamp.grossPence, 7300, "offer gross stays the customer's committed payable");
  assertEquals(stamp.lockedPromotionPence, 200);
  assertEquals(stamp.commissionablePence, 6800);
  assertEquals(stamp.commissionPence, 680);
  assertEquals(stamp.driverNetPence, 6820);

  for (const pct of [0, 5, 10, 15, 22]) {
    for (const promo of [0, 50, 200, 500]) {
      const original = 6800;
      const payable = original + 700 - promo;
      const settlement = calculateTripSettlementFromTripRow({
        ...MK007_SETTLEMENT_TRIP,
        offer_discount_pence: promo,
        discount_source: promo > 0 ? "global_offer" : null,
        final_fare_pence: payable,
        final_customer_fare_pence: payable,
        capture_amount_pence: payable,
        accepted_commission_percent: pct,
      });
      assert(settlement);
      const offer = stampOfferDriverNetFromCommittedFare({
        trip: {
          final_customer_fare_pence: payable,
          final_fare_pence: payable,
          estimated_total_pence: payable,
          airport_charge_pence: 700,
          offer_discount_pence: promo,
          discount_pence: promo,
          discount_source: promo > 0 ? "global_offer" : null,
        },
        commissionPercent: pct,
      });
      assertEquals(offer.driverNetPence, settlement.driver_total_earnings_pence, `rate ${pct}% promo ${promo}`);
    }
  }
});

Deno.test("voucher / negotiated / unknown sources do NOT keep the pre-promotion base", () => {
  for (const trip of [
    { ...MK007_OFFER_TRIP, discount_source: "personal_voucher" },
    { ...MK007_OFFER_TRIP, discount_source: null },
    { ...MK007_OFFER_TRIP, locked_offer_type: "negotiated_offer" },
    { ...MK007_OFFER_TRIP, fare_snapshot_json: { promotion_application_status: "SUPERSEDED_BY_NEGOTIATION" } },
  ]) {
    assertEquals(resolveGlobalOfferPromotionPence(trip), 0);
    assertEquals(stampOfferDriverNetFromCommittedFare({ trip, commissionPercent: 10 }).driverNetPence, 6640);
  }
  assertEquals(resolveGlobalOfferPromotionPence(MK007_OFFER_TRIP), 200);
  assertEquals(prePromotionCustomerPence(7300, 200), 7500);
  assertEquals(prePromotionCustomerPence(0, 200), 0);
});

Deno.test("enrichOfferSnapshotDriverNet: promotion lifts the commission base, the offer still advertises the payable", () => {
  const promoted = enrichOfferSnapshotDriverNet(
    { airport_charge_pence: 700 }, {}, 10, 7300, "GBP", 200,
  );
  assertEquals(promoted.driver_net_fare_pence, 6820);
  assertEquals(promoted.driver_journey_net_pence, 6120);
  assertEquals(promoted.final_trip_fare_pence, 7300);
  assertEquals(promoted.platform_commission_pence, 680);
  const plain = enrichOfferSnapshotDriverNet({ airport_charge_pence: 700 }, {}, 10, 7300, "GBP");
  assertEquals(plain.driver_net_fare_pence, 6640);
});

Deno.test("persisted split + pending-offer restamp accept the global_offer commissionable (6800 + 700 = 7300 + 200)", () => {
  const trip = { ...MK007_OFFER_TRIP, other_pass_through_charges_pence: 0, fare_breakdown: { trip_fare_pence: 6800, airport_charge_pence: 700, final_fare_pence: 7500 } };
  const assessed = assessPersistedAirportSplit(trip);
  assert(assessed.ok, "global_offer trip must not fail closed as split_mismatch");
  if (assessed.ok && assessed.reason === "split_persisted") {
    assertEquals(assessed.lockedPromotionPence, 200);
    assertEquals(assessed.commissionablePence, 6800);
  }
  // Without the promotion evidence the same row IS a mismatch (guards against masking a real defect).
  assertEquals(assessPersistedAirportSplit({ ...trip, discount_source: null }), { ok: false, reason: "split_mismatch" });

  const offer = {
    id: "o1", status: "pending", is_stacked: false, expires_at: "2026-11-13T12:10:00.000Z", dispatch_wave: 1,
    effective_commission_percent: 10, offer_snapshot: { baseFarePence: 7300 }, offered_driver_net_pence: 6570,
  };
  const decision = decideAlreadyOfferedRestamp({ nowMs: Date.parse("2026-11-13T12:00:00.000Z"), trip, offers: [offer] });
  assertEquals(decision.action, "restamp");
  assertEquals(decision.updates[0].offered_driver_net_pence, 6820);

  const plan = planExistingPendingOfferRestamp({
    nowMs: Date.parse("2026-11-13T12:00:00.000Z"), payablePence: 7300, airportPence: 700, lockedPromotionPence: 200,
    offers: [offer], resolveWavePercent: () => Number.NaN, requireStoredCommissionPercent: true,
  });
  assertEquals(plan.updates[0].offered_driver_net_pence, 6820);
  // The helper never deducts: promo 0 is the old behaviour.
  assertEquals(driverNetFromCustomerTotal({ customerPence: 7300, airportPence: 700, commissionPercent: 10 }).driverNetPence, 6640);
});

// ---------------------------------------------------------------------------
// 3. SQL migration 20270222210000 (static) — execution proof is the pg-harness
// ---------------------------------------------------------------------------
Deno.test("210000: global_offer commission base is added back; 190000 stays pushed history", async () => {
  const sql = await read(`${M}20270222210000_global_offer_commission_base_pre_promotion.sql`);
  const code = stripSqlComments(sql);
  assertStringIncludes(code, "offer_global_offer_promotion_pence");
  assertStringIncludes(code, "offer_driver_net_split_for_trip");
  assertStringIncludes(code, "v_payable + v_promo >= v_trip_fare + v_airport");
  assertStringIncludes(code, "v_commissionable := GREATEST(0, v_payable + v_promo - v_airport);");
  assertStringIncludes(code, "pg_get_functiondef(to_regprocedure(v_sig))"); // patched from live
  // Mirrors tripSettlement.resolveLockedPromotionPence: only global_offer, never a negotiated fare.
  assertStringIncludes(code, "negotiated_offer");
  assertStringIncludes(code, "SUPERSEDED_BY_NEGOTIATION");
  assertStringIncludes(code, "v_src <> 'global_offer'");
  // No payment, no historical rewrite.
  assert(!/\b(UPDATE\s+public\.|DELETE\s+FROM|INSERT\s+INTO)\b/i.test(code), "new-data-only: no row is rewritten");
  assert(!/revolut|capture|increment|payment_sessions\s+SET/i.test(code), "no payment / Revolut change");
  // 190000 is untouched history (superseded, not edited).
  const old = await read(`${M}20270222190000_airport_split_commissionable_follows_payable.sql`);
  assertStringIncludes(old, "v_commissionable := GREATEST(0, v_payable - v_airport);");
  assert(!old.includes("v_promo"), "190000 must not be edited; 210000 supersedes it");
  // Rollback exists and does not reintroduce anything silently.
  assertStringIncludes(
    await read(`${M}rollback/rollback_20270222210000_global_offer_commission_base_pre_promotion.sql`),
    "offer_driver_net_split_for_trip",
  );
});

Deno.test("210000: the stacked guard (230000) validates the SAME promotion-aware split", async () => {
  const sql = stripSqlComments(await read(`${M}20270222230000_financial_offer_invariant_warn_by_default.sql`));
  assertEquals((sql.match(/offer_driver_net_split_for_trip\(/g) ?? []).length, 2);
  assert(!/public\.offer_driver_net_split\(/.test(sql), "guard must not split the discounted payable directly");
});

// ---------------------------------------------------------------------------
// 4. 20270222220000: ack-timeout sweep locks trip -> offer
// ---------------------------------------------------------------------------
Deno.test("220000: process_ride_offer_ack_timeouts locks TRIP first, then OFFER, never waits, domain-safe", async () => {
  const sql = await read(`${M}20270222220000_ack_timeout_sweep_trip_first_lock_order.sql`);
  const code = stripSqlComments(sql);
  assertStringIncludes(code, "CREATE OR REPLACE FUNCTION public.process_ride_offer_ack_timeouts()");
  // Candidate cursor is non-locking.
  const cursor = code.slice(code.indexOf("FOR r IN"), code.indexOf("LOOP", code.indexOf("FOR r IN")));
  assert(!/FOR\s+UPDATE/i.test(cursor), "candidate cursor must not lock offers (old offer -> trip order)");
  // Trip lock strictly before the offer lock, both SKIP LOCKED.
  const tripLock = code.indexOf("PERFORM 1 FROM public.trips t WHERE t.id = r.tid FOR UPDATE SKIP LOCKED;");
  const offerLock = code.indexOf("FROM public.ride_offers ro\n      WHERE ro.id = r.oid");
  const offerForUpdate = code.indexOf("FOR UPDATE SKIP LOCKED;", offerLock);
  const expire = code.indexOf("UPDATE public.ride_offers o");
  assert(tripLock > 0 && offerLock > tripLock && offerForUpdate > offerLock && expire > offerForUpdate,
    "order must be trip lock -> offer lock -> expire/reassign");
  // Domain-safe: no raw 40P01 escapes the sweep.
  assertStringIncludes(code, "WHEN deadlock_detected OR serialization_failure OR lock_not_available THEN");
  // ack_timeout semantics preserved.
  for (const needle of [
    "status = 'expired'", "delivery_phase = 'ack_timeout'", "responded_at = NULL",
    "COALESCE(o.revoked_reason, 'ack_timeout')", "'non_driver_fault', true", "'responded_at_suppressed', true",
    "'ack_timeout_sweep_edge'", "current_offer_driver_id = NULL",
  ]) assertStringIncludes(code, needle);
  assertStringIncludes(code, "GRANT EXECUTE ON FUNCTION public.process_ride_offer_ack_timeouts() TO service_role;");
  assert(!/revolut|capture|increment|payment/i.test(code), "no payment change in a lock-order migration");
  assertStringIncludes(
    await read(`${M}rollback/rollback_20270222220000_ack_timeout_sweep_trip_first_lock_order.sql`),
    "FOR UPDATE SKIP LOCKED\n  LOOP",
  );
});

Deno.test("ack-timeout harness is wired into the mandatory PG gate with L / LB / A1 / A1b / A2 / A3", async () => {
  const gates = await read("../../../scripts/ci/run-pg-gates.sh");
  assertStringIncludes(gates, "ack_timeout_lock_order_concurrency_isolated.sh");
  assertStringIncludes(gates, "20270222220000_ack_timeout_sweep_trip_first_lock_order.sql");
  assertStringIncludes(gates, "public.process_ride_offer_ack_timeouts()");
  const sh = await read("../ack_timeout_lock_order_concurrency_isolated.sh");
  for (const scn of ["L", "LB", "A1", "A1b", "A2", "A3"]) assertStringIncludes(sh, `=== RUN ${scn}:`);
  const verify = await read("../ack_timeout_lock_order_isolated.sql");
  assertStringIncludes(verify, "offer_row_free_while_trip_lock_is_held_elsewhere");
  assertStringIncludes(verify, "no_raw_40P01_40001_55P03");
  assertStringIncludes(verify, "sweep_skipped_the_offer_being_accepted");
});

// ---------------------------------------------------------------------------
// 5. 20270222230000: rollout-safe FO001 / FO002
// ---------------------------------------------------------------------------
Deno.test("230000: pending FO001/FO002 WARN by default; EXCEPTION only when onecab.enforce_offer_financial_invariant = on", async () => {
  const sql = await read(`${M}20270222230000_financial_offer_invariant_warn_by_default.sql`);
  const code = stripSqlComments(sql);
  assertStringIncludes(code, "current_setting('onecab.enforce_offer_financial_invariant', true)");
  assertStringIncludes(code, "IN ('on', 'true', '1', 'yes')");
  // Every EXCEPTION is behind v_enforce; the pending path otherwise WARNs and lets the write proceed.
  const raises = [...code.matchAll(/RAISE EXCEPTION/g)].map((m) => m.index!);
  assertEquals(raises.length, 2);
  for (const at of raises) {
    assertStringIncludes(code.slice(Math.max(0, at - 40), at), "IF v_enforce THEN");
  }
  assertStringIncludes(code, "ERRCODE = 'FO001'");
  assertStringIncludes(code, "ERRCODE = 'FO002'");
  assertStringIncludes(code, "warn-only: onecab.enforce_offer_financial_invariant is not on");
  // Accepted stays warning-only; technical failure still fails open; trigger shape unchanged.
  assertStringIncludes(code, "FINANCIAL_OFFER_INVARIANT (accepted, not blocked)");
  assertStringIncludes(code, "EXCEPTION WHEN OTHERS THEN");
  assertStringIncludes(code, "WHEN (NEW.status IN ('pending', 'accepted'))");
  // Edge-first deploy + follow-up are documented in the migration itself.
  assertStringIncludes(sql, "ALTER DATABASE postgres SET onecab.enforce_offer_financial_invariant = 'on'");
  assertStringIncludes(sql, "Re-enabling EXCEPTION is a follow-up AFTER Edge cutover");
  assert(!/UPDATE\s+public\.(trips|ride_offers)\s+SET/i.test(code), "guard never writes offers/trips");
  // 170000 stays pushed history (EXCEPTION unconditional there).
  assertStringIncludes(await read(`${M}20270222170000_financial_offer_invariant_guard_stacked_and_recovery.sql`), "ERRCODE = 'FO001'");
});
