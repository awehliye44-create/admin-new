/**
 * Lock: 2027-02-22 negotiation lock order, stacked-offer financial guard, breakdown-only recovery,
 * commissionable stamp, monitor cron, and the CI PostgreSQL gate.
 *
 * Static (no DB): the execution proof lives in
 *   supabase/tests/financial_offer_invariant_guard.sql
 *   supabase/tests/airport_split_commissionable_follows_payable.sql
 *   supabase/tests/negotiation_lock_order_concurrency_isolated.sh
 * and is run by the mandatory `pg-harness` CI job (REQUIRE_PG_HARNESS=1).
 *
 * Run: deno test --no-check --allow-read supabase/tests/_shared/negotiationAndOfferGuard20270222.lock.test.ts
 * If this fails, fix the code — never delete or soften the lock.
 */
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isFinancialOfferInvariantError,
  isStaleTripRebroadcastCandidateV2,
  tripPatchAfterTransientOfferCreateFailure,
} from "../../functions/_shared/dispatchWaveCommitResumeSSOT.ts";

const read = (rel: string) => Deno.readTextFile(new URL(rel, import.meta.url));
const stripSqlComments = (sql: string) => sql.replace(/--.*$/gm, "");
const M = "../../migrations/";
const GUARD_160 = `${M}20270222160000_financial_offer_invariant_guard.sql`;
const GUARD_170 = `${M}20270222170000_financial_offer_invariant_guard_stacked_and_recovery.sql`;
const NEG_180 = `${M}20270222180000_negotiation_rpc_trip_first_lock_order.sql`;
const SPLIT_190 = `${M}20270222190000_airport_split_commissionable_follows_payable.sql`;
const CRON_200 = `${M}20270222200000_schedule_financial_ssot_monitor_cron.sql`;

// ---------------------------------------------------------------------------
// 1. Stacked offers get the same financial protection
// ---------------------------------------------------------------------------
Deno.test("guard 170000: stacked offers are validated, not skipped", async () => {
  const sql = stripSqlComments(await read(GUARD_170));
  assert(
    !/IF\s+COALESCE\(NEW\.is_stacked,\s*false\)\s+THEN\s+RETURN\s+NEW/i.test(sql),
    "the 160000 early-return for stacked offers must be gone",
  );
  assertStringIncludes(sql, "v_stacked boolean := COALESCE(NEW.is_stacked, false)");
  for (const reason of [
    "stale_quote_over_committed",
    "airport_missing",
    "airport_mismatch",
    "airport_double_counted",
    "fabricated_earnings",
    "wrong_commission",
  ]) {
    assertStringIncludes(sql, reason);
  }
  // Same SQL SSOTs as the stamp: committed payable + net split + airport resolver.
  assertStringIncludes(sql, "trip_negotiation_base_fare_pence");
  assertStringIncludes(sql, "offer_driver_net_split");
  assertStringIncludes(sql, "offer_resolve_airport_pence");
  // Preserved semantics.
  assertStringIncludes(sql, "ERRCODE = 'FO001'");
  assertStringIncludes(sql, "ERRCODE = 'FO002'");
  assertStringIncludes(sql, "RAISE WARNING"); // accepted is never blocked
  assertStringIncludes(sql, "EXCEPTION WHEN OTHERS THEN"); // technical failure of the check fails OPEN
  assertStringIncludes(sql, "WHEN (NEW.status IN ('pending', 'accepted'))");
  // The check must not change stacked eligibility / workflow / payments: it only reads and raises.
  assert(!/UPDATE\s+public\.(trips|ride_offers)\s+SET/i.test(sql), "guard never writes offers/trips");
});

Deno.test("guard 170000: breakdown-only legacy trips recover instead of being skipped", async () => {
  const sql = stripSqlComments(await read(GUARD_170));
  assertStringIncludes(sql, "'committed'");
  assertStringIncludes(sql, "'recovered'");
  assertStringIncludes(sql, "'none'");
  // The unverifiable fallbacks are dropped, snapshot / payment-session kept.
  for (const probe of ["fare_breakdown := NULL", "fare := NULL", "estimated_fare := NULL", "base_fare_pence := NULL"]) {
    assertStringIncludes(sql, `v_probe.${probe}`);
  }
  assert(!/v_probe\.fare_snapshot_json\s*:=/.test(sql), "fare_snapshot_json must stay");
  assert(!/v_probe\.payment_session_id\s*:=/.test(sql), "payment_session must stay");
  // New actionable offer without a verifiable snapshot fails closed; closed/other statuses untouched.
  assertStringIncludes(sql, "TG_OP = 'INSERT' AND NEW.status = 'pending'");
  assertStringIncludes(sql, "v_unverifiable := true");
});

Deno.test("guard 160000 stays pushed history (not rewritten); 170000 replaces the function in a NEW migration", async () => {
  const old = await read(GUARD_160);
  assertStringIncludes(old, "IF COALESCE(NEW.is_stacked, false) THEN RETURN NEW; END IF;");
  const sql = await read(GUARD_170);
  assertStringIncludes(sql, "CREATE OR REPLACE FUNCTION public.tr_ride_offer_financial_invariant_guard_fn()");
  assertStringIncludes(sql, "CREATE TRIGGER zz_ride_offer_financial_invariant_guard");
  assertStringIncludes(sql, "BEFORE INSERT OR UPDATE OF offer_snapshot, offered_driver_net_pence");
  assertStringIncludes(await read(`${M}rollback/rollback_20270222170000_financial_offer_invariant_guard_stacked_and_recovery.sql`),
    "IF COALESCE(NEW.is_stacked, false) THEN RETURN NEW; END IF;");
});

// ---------------------------------------------------------------------------
// 2. Negotiation RPCs: trip first, then offer; bounded retry; domain errors
// ---------------------------------------------------------------------------
const NEGOTIATION_RPCS = [
  "customer_counter_ride_offer",
  "driver_send_preset_offer",
  "driver_cancel_negotiation",
  "expire_negotiation_offer",
  "decline_ride_offer",
  "apply_customer_decline_grace",
];

Deno.test("negotiation 180000: every RPC is a core + retry wrapper with the trip-first lock", async () => {
  const sql = await read(NEG_180);
  const code = stripSqlComments(sql);
  // Trip lock injected directly BEFORE the offer lock (same pattern as accept_ride_offer_core).
  const inject = code.indexOf("PERFORM 1 FROM public.trips t WHERE t.id = (SELECT o.trip_id FROM public.ride_offers o WHERE o.id = p_offer_id) FOR UPDATE;");
  const marker = code.indexOf("SELECT * INTO v_offer FROM public.ride_offers WHERE id = p_offer_id FOR UPDATE;");
  assert(inject > 0 && marker > 0, "trip-lock injection + offer-lock marker present");
  assertStringIncludes(code, "v_def := replace(v_def, v_marker, v_inject || v_marker);");
  for (const name of NEGOTIATION_RPCS) {
    assertStringIncludes(code, `public.${name}_core(`);
    assertStringIncludes(code, `CREATE OR REPLACE FUNCTION public.${name}(`);
  }
  // Patched from the LIVE definition: no historical negotiation logic re-typed.
  assertStringIncludes(code, "pg_get_functiondef(to_regprocedure(v_spec[2]))");
  assert(!/finalize_negotiation_failure|commit_negotiation_fare|release_trip_negotiation_lock/.test(code.replace(/COMMENT[\s\S]*$/m, "")),
    "negotiation internals must not be re-typed in the lock-order migration");
  // Bounded retry (3) on deadlock / serialization / lock-not-available, never raw 40P01.
  assertEquals((code.match(/WHEN deadlock_detected OR serialization_failure OR lock_not_available THEN/g) ?? []).length, 6);
  assertEquals((code.match(/v_max_attempts constant integer := 3/g) ?? []).length, 6);
  assertEquals((code.match(/pg_sleep\(0\.02 \* v_attempt \+ random\(\) \* 0\.03\)/g) ?? []).length, 6);
  // Domain outcomes the existing callers already map.
  for (const outcome of ["not_waiting_customer", "offer_not_found", "offer_not_pending", "trip_already_assigned", "negotiation_contention"]) {
    assertStringIncludes(code, `'${outcome}'`);
  }
  // Cores are internal.
  assertEquals((code.match(/FROM PUBLIC, anon, authenticated, service_role;/g) ?? []).length, 6);
  // No payment / fare-policy change.
  assert(!/revolut|increment|capture/i.test(code), "no payment change in a lock-order migration");
});

Deno.test("negotiation 180000: revoked/expired/declined/accepted offers are never resurrected by a late counter", async () => {
  // Raw text: the markers live inside E'' literals that contain `--` comments.
  const sql = await read(NEG_180);
  assertStringIncludes(sql, "OR v_offer.status IN (''revoked'', ''expired'', ''declined'', ''accepted'') THEN -- terminal offer guard");
  assertStringIncludes(sql, "-- assigned-trip guard");
  assertStringIncludes(sql, "IF v_spec[1] IN ('customer_counter_ride_offer', 'apply_customer_decline_grace') THEN");
});

Deno.test("negotiation edge callers map the new domain outcomes (no raw 500 / no unsafe manual fallback)", async () => {
  const fare = await read("../../functions/driver-fare-offer/index.ts");
  assertStringIncludes(fare, "negotiation_contention");
  const decision = await read("../../functions/customer-fare-decision/index.ts");
  assertStringIncludes(decision, "negotiation_contention");
  const decline = await read("../../functions/decline-offer/index.ts");
  assertStringIncludes(decline, "NEGOTIATION_CONTENTION");
});

Deno.test("accept_ride_offer_core order is the reference the negotiation RPCs now match", async () => {
  const accept = await read(`${M}20270222130000_accept_ride_offer_lock_order_deadlock_fix.sql`);
  assertStringIncludes(accept, "PERFORM 1 FROM public.trips t WHERE t.id = v_lock_trip_id FOR UPDATE;");
});

// ---------------------------------------------------------------------------
// 4. FO001 / FO002 rejection recovery in auto-dispatch (bounded, no hold change)
// ---------------------------------------------------------------------------
Deno.test("isFinancialOfferInvariantError recognises the guard errors only", () => {
  assert(isFinancialOfferInvariantError({ message: "FINANCIAL_OFFER_INVARIANT: stale_quote_over_committed ..." }));
  assert(isFinancialOfferInvariantError({ code: "FO001", message: "x" }));
  assert(isFinancialOfferInvariantError({ code: "FO002" }));
  assert(isFinancialOfferInvariantError("ERROR: FINANCIAL_OFFER_INVARIANT: no verifiable financial snapshot"));
  assert(isFinancialOfferInvariantError({ details: "SQLSTATE FO001" }));
  assert(!isFinancialOfferInvariantError("VERSION_MISMATCH"));
  assert(!isFinancialOfferInvariantError({ code: "23505", message: "duplicate key ride_offers_trip_id_driver_id_broadcast_round_key" }));
  assert(!isFinancialOfferInvariantError(null));
  assert(!isFinancialOfferInvariantError({ message: "FO0011 not a code" }));
});

Deno.test("FO001 rejection leaves the trip resumable then terminal through the EXISTING escalation (never stuck)", () => {
  const nowIso = "2026-11-13T12:00:00.000Z";
  const patch = tripPatchAfterTransientOfferCreateFailure({
    nowIso, storedRound: 0, maxExistingOfferRound: 0, attemptedBroadcastRound: 1,
  });
  // broadcast_enabled MUST stay true: expire_trip_when_search_exhausted returns false when it is false.
  assertEquals(patch.broadcast_enabled, true);
  assertEquals(patch.dispatch_status, "broadcasting");
  assert(patch.current_broadcast_round >= 1);

  const base = {
    dispatch_status: patch.dispatch_status,
    current_broadcast_round: patch.current_broadcast_round,
    max_broadcast_rounds: 9,
    pending_offer_count: 0,
    max_existing_offer_round: 0,
    nowMs: Date.parse(nowIso),
  };
  // While the find window is open and the round budget remains: expire-offers resumes dispatch.
  assert(isStaleTripRebroadcastCandidateV2({ ...base, searching_expires_at: "2026-11-13T12:03:00.000Z" }));
  // Window over: resume stops and expire_trip_when_search_exhausted (TTL) ends the search.
  assert(!isStaleTripRebroadcastCandidateV2({ ...base, searching_expires_at: "2026-11-13T11:59:00.000Z" }));
  // Round budget exhausted: no endless guard-rejection loop.
  assert(!isStaleTripRebroadcastCandidateV2({
    ...base, current_broadcast_round: 9, searching_expires_at: "2026-11-13T12:03:00.000Z",
  }));
  // Each rejected attempt consumes a round (bounded loop).
  const next = tripPatchAfterTransientOfferCreateFailure({
    nowIso, storedRound: patch.current_broadcast_round, maxExistingOfferRound: 0, attemptedBroadcastRound: 2,
  });
  assertEquals(next.current_broadcast_round, 2);
});

Deno.test("auto-dispatch wires FO001 before the generic DB error and never touches payments / holds there", async () => {
  const src = await read("../../functions/auto-dispatch/index.ts");
  const fo = src.indexOf("isFinancialOfferInvariantError(createError)");
  const generic = src.indexOf('abortDispatch("DB_ERROR_CREATE_OFFERS"');
  assert(fo > 0 && generic > fo, "FO001 handler must precede the generic DB_ERROR_CREATE_OFFERS abort");
  const block = src.slice(fo, src.indexOf("isCommitDispatchWaveVersionMismatch(createError)", fo));
  assertStringIncludes(block, "tripPatchAfterTransientOfferCreateFailure");
  assertStringIncludes(block, "FINANCIAL_OFFER_INVARIANT_REASON");
  assertStringIncludes(block, "recoverable: true");
  assertStringIncludes(block, "permanent: false");
  assert(!/hold|release|revolut|payment_session|capture|cancel|expire_trip_when_search_exhausted/i.test(
    block.replace(/\/\/.*$/gm, ""),
  ), "guard-rejection handler must not touch payment holds or terminate the trip itself");
});

// ---------------------------------------------------------------------------
// 4b. MK-007 commissionable stamp follows the payable (new stamps only)
// ---------------------------------------------------------------------------
Deno.test("airport split 190000 (pushed history; superseded for global_offer by 210000): commissionable = payable - airport when payable undershoots ride + airport", async () => {
  const sql = await read(SPLIT_190);
  const code = stripSqlComments(sql);
  assertStringIncludes(code, "v_trip_fare > 0 AND (v_payable <= 0 OR v_payable >= v_trip_fare + v_airport)");
  assertStringIncludes(code, "v_commissionable := GREATEST(0, v_payable - v_airport);");
  assertStringIncludes(code, "commissionable_fare_pence = v_commissionable,");
  assertStringIncludes(code, "pg_get_functiondef(to_regprocedure(v_sig))"); // patched from live
  // New-data write path only: no backfill / historical rewrite.
  assert(!/UPDATE\s+public\./i.test(code), "the migration itself updates no rows (function body is patched from the live definition)");
  assert(!/\b(INSERT\s+INTO|DELETE\s+FROM|DROP\s+(TABLE|COLUMN))\b/i.test(code), "no data rewrite");
  assert(!/payment_sessions|ledger|settlement|revolut|capture/i.test(code), "no payment / settlement change");
  // TypeScript twin keeps the same rule for NON-subsidised discounts; global_offer adds the ONECAB-funded
  // promotion back first (MK-007 6820, see globalOfferPrePromotionCommissionBaseLock.test.ts + 20270222210000).
  const ts = await read("../../functions/_shared/airportChargeFareSplitSSOT.ts");
  assertStringIncludes(ts, "const preGross = prePromotionCustomerPence(payable, input.lockedPromotionPence);");
  assertStringIncludes(ts, "const rideCoveredByPayable = ride > 0 && (payable <= 0 || preGross >= ride + airport);");
  assertStringIncludes(ts, "Math.max(0, preGross - airport)");
  const superseding = await read(`${M}20270222210000_global_offer_commission_base_pre_promotion.sql`);
  assertStringIncludes(superseding, "v_payable + v_promo >= v_trip_fare + v_airport");
});

// ---------------------------------------------------------------------------
// 5. Monitor cron
// ---------------------------------------------------------------------------
Deno.test("financial-ssot-monitor is scheduled by a migration (pattern: expire_offers_sweep / scheduled_dispatch_sweep)", async () => {
  const sql = await read(CRON_200);
  const code = stripSqlComments(sql);
  assertStringIncludes(code, "CREATE OR REPLACE FUNCTION public.financial_ssot_monitor_sweep()");
  assertStringIncludes(code, "/functions/v1/financial-ssot-monitor");
  assertStringIncludes(code, "public.cron_edge_auth_token()");
  assertStringIncludes(code, "net.http_post");
  assertStringIncludes(code, "cron.unschedule('financial-ssot-monitor-hourly')");
  assertStringIncludes(code, "'financial-ssot-monitor-hourly'");
  assertStringIncludes(code, "to_regnamespace('cron') IS NULL"); // no-op where pg_cron is absent
  assert(!/eyJ[A-Za-z0-9_-]{10,}/.test(sql), "no hardcoded JWT");
  assert(!/INSERT\s+INTO|UPDATE\s+public\.|DELETE\s+FROM/i.test(code), "scheduling only");
  // Same auth shape as the existing Edge crons.
  const expire = await read(`${M}20260924120000_expire_offers_sweep_service_role_auth.sql`);
  assertStringIncludes(expire, "public.cron_edge_auth_token()");
  assertStringIncludes(await read("../../functions/financial-ssot-monitor/index.ts"), "assertCronOrServiceRoleAuth");
  // The function really is hourly-scheduled nowhere else (single schedule).
  const all = [];
  for await (const e of Deno.readDir(new URL(M, import.meta.url))) {
    if (e.isFile && e.name.endsWith(".sql")) all.push(e.name);
  }
  const schedulers: string[] = [];
  for (const name of all) {
    const text = await Deno.readTextFile(new URL(`${M}${name}`, import.meta.url));
    if (/cron\.schedule\(\s*'financial-ssot-monitor/.test(text)) schedulers.push(name);
  }
  assertEquals(schedulers, ["20270222200000_schedule_financial_ssot_monitor_cron.sql"]);
});

// ---------------------------------------------------------------------------
// 3. CI: mandatory PostgreSQL gate
// ---------------------------------------------------------------------------
Deno.test("CI workflow has a mandatory PG job: REQUIRE_PG_HARNESS=1, A-F + negotiation + guard + stamp", async () => {
  const yml = await read("../../../.github/workflows/ci.yml");
  assertStringIncludes(yml, "pg-harness:");
  assertStringIncludes(yml, "REQUIRE_PG_HARNESS");
  assertStringIncludes(yml, "REQUIRE_PG_HARNESS: \"1\"");
  assertStringIncludes(yml, "timeout-minutes: 45");
  assertStringIncludes(yml, "public.ecr.aws/supabase/postgres:");
  assertStringIncludes(yml, "scripts/ci/pg-harness-bootstrap.sh");
  assertStringIncludes(yml, "scripts/ci/run-pg-gates.sh");
  const gates = await read("../../../scripts/ci/run-pg-gates.sh");
  for (const needle of [
    "scheduled_rematch_waiting_concurrency_isolated.sh",
    "negotiation_lock_order_concurrency_isolated.sh",
    "financial_offer_invariant_guard.sql",
    "airport_split_commissionable_follows_payable.sql",
    "REQUIRE_PG_HARNESS",
    "skipped=0",
  ]) {
    assertStringIncludes(gates, needle);
  }
  assertStringIncludes(gates, "20270222170000_financial_offer_invariant_guard_stacked_and_recovery.sql");
  assertStringIncludes(gates, "20270222190000_airport_split_commissionable_follows_payable.sql");
  assertStringIncludes(gates, "20270222210000_global_offer_commission_base_pre_promotion.sql");
  assertStringIncludes(gates, "20270222230000_financial_offer_invariant_warn_by_default.sql");
  assertStringIncludes(gates, "ack_timeout_lock_order_concurrency_isolated.sh");
  // The local consolidated script delegates to the same strict gates; REQUIRE_PG_HARNESS=1 makes a missing DB fatal.
  const consolidated = await read("../../../scripts/check-consolidated-regression-gates.sh");
  assertStringIncludes(consolidated, "REQUIRE_PG_HARNESS");
  assertStringIncludes(consolidated, "scripts/ci/run-pg-gates.sh");
  assertStringIncludes(consolidated, "financialSsotMonitorScansFixtures.test.ts");
});
