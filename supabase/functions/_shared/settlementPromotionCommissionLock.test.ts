/**
 * Lock: accept-time SQL writers must use pre-promotion commissionable base for global_offer.
 * MK-260818-001: 500p original, 20p promo, 15% → commissionable 500, driver 425, after-promo 55.
 *
 * Run: deno test --allow-read supabase/functions/_shared/settlementPromotionCommissionLock.test.ts
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const sqlPath = new URL(
  "../../migrations/20260928150000_canonical_promotion_settlement_ssot.sql",
  import.meta.url,
);

Deno.test("SQL SSOT defines promotion-aware commissionable resolver", async () => {
  const sql = await Deno.readTextFile(sqlPath);
  assertStringIncludes(sql, "CREATE OR REPLACE FUNCTION public.resolve_trip_locked_promotion_pence");
  assertStringIncludes(sql, "CREATE OR REPLACE FUNCTION public.resolve_trip_pre_promotion_ride_fare_pence");
  assertStringIncludes(sql, "CREATE OR REPLACE FUNCTION public.resolve_trip_commissionable_fare_pence");
  assertStringIncludes(sql, "discount_source, '') = 'global_offer'");
  assertStringIncludes(sql, "original_fare_pence");
  assertStringIncludes(sql, "customer_modification_charge_pence");
});

Deno.test("fail-closed: PRE_PROMOTION_FARE_EVIDENCE_MISSING in resolver", async () => {
  const sql = await Deno.readTextFile(sqlPath);
  assertStringIncludes(sql, "PRE_PROMOTION_FARE_EVIDENCE_MISSING");
  assertStringIncludes(sql, "IF v_pre_ride <= 0 THEN");
  assertEquals(sql.includes("p_fallback_gross"), false);
});

Deno.test("negotiated fare supersedes global_offer promotion for settlement", async () => {
  const sql = await Deno.readTextFile(sqlPath);
  assertStringIncludes(sql, "trip_promotion_superseded_by_negotiation");
  assertStringIncludes(sql, "SUPERSEDED_BY_NEGOTIATION");
  assertStringIncludes(sql, "negotiated_commissionable_fare_pence");
  assertStringIncludes(sql, "previous_locked_promotion_pence");
});

Deno.test("commit_negotiation_fare uses pre-promotion base, not committed payable", async () => {
  const sql = await Deno.readTextFile(sqlPath);
  const commit = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.commit_negotiation_fare"));
  assertStringIncludes(commit, "resolve_trip_commissionable_fare_pence(");
  assertStringIncludes(commit, "applied_customer_promotion_pence");
  assertStringIncludes(commit, "commission_after_promotion_pence");
  assertStringIncludes(commit, "platform_net_revenue_pence = CASE WHEN v_settle THEN v_commission_after_promotion_pence");
  assertStringIncludes(commit, "gross_fare_pence = CASE WHEN v_settle THEN NULLIF(v_gross_pence, 0)");
  assertEquals(commit.includes("v_commissionable_pence := GREATEST(0, p_committed_fare_pence - v_airport_pence)"), false);
  assertEquals(commit.includes("gross_fare_pence = CASE WHEN v_settle THEN NULLIF(v_commissionable_pence, 0)"), false);
});

Deno.test("snapshot_accepted_wave_commission stamps promotion-adjusted ONECAB net", async () => {
  const sql = await Deno.readTextFile(sqlPath);
  const snapshot = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.snapshot_accepted_wave_commission"));
  assertStringIncludes(snapshot, "resolve_trip_commissionable_fare_pence(");
  assertStringIncludes(snapshot, "'applied_customer_promotion_pence', v_applied_promotion");
  assertStringIncludes(snapshot, "'commission_after_promotion_pence', v_commission_after_promotion");
  assertStringIncludes(snapshot, "platform_net_revenue_pence = CASE WHEN v_commissionable > 0 THEN v_commission_after_promotion");
  assertEquals(
    snapshot.includes("NULLIF(v_trip.final_fare_pence, 0),\n    NULLIF(v_trip.gross_fare_pence, 0), 0) - v_airport"),
    false,
  );
});

Deno.test("snapshot_driver_tier_commission_on_trip redirects through resolver", async () => {
  const sql = await Deno.readTextFile(sqlPath);
  const tier = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.snapshot_driver_tier_commission_on_trip"));
  assertStringIncludes(tier, "resolve_trip_commissionable_fare_pence(");
  assertStringIncludes(tier, "commission_after_promotion_pence");
});
