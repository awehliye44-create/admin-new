/**
 * Execution tests for the SQL offer financial SSOT (migration 20270222150000).
 *
 *  - MK-261113-004/005: committed 480 beside breakdown 500, 10% -> net 432 AT CREATION.
 *  - MK-261113-007 (Heathrow, no promotion): committed 7300 incl. airport 700 -> journey 5940 + airport 700 = 6640.
 *  - MK-007 global_offer (20270222210000): ride 6800 + airport 700, promotion 200 -> payable 7300,
 *    driver = 6800 x 0.9 + 700 = 6820 (promotion is ONECAB-funded, never a driver deduction).
 *  - SQL trip_negotiation_base_fare_pence agrees with TS resolveCommittedOfferGrossPence
 *    over a generated priority grid (no drift between the two SSOTs).
 *
 * Runs against the LOCAL Supabase Postgres only (127.0.0.1:54322 by default), applies
 * the candidate migration INSIDE a transaction and ROLLS BACK. Skips itself when no
 * local database is reachable. Never touches a linked / production database.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveCommittedOfferGrossPence } from "../supabase/functions/_shared/committedBookingOfferFareSSOT.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const MIGRATION = join(root, "supabase/migrations/20270222150000_committed_offer_fare_sql_ssot.sql");
const GLOBAL_OFFER_MIGRATION = join(root, "supabase/migrations/20270222210000_global_offer_commission_base_pre_promotion.sql");
const SQL_TEST = join(root, "supabase/tests/committed_offer_fare_sql_ssot.sql");
const DB_URL = process.env.LOCAL_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ENV = { ...process.env, PATH: `/opt/homebrew/bin:/opt/homebrew/opt/postgresql@17/bin:/usr/local/bin:${process.env.PATH ?? ""}` };

const isLocal = /@(127\.0\.0\.1|localhost)[:/]/.test(DB_URL);

function psql(args: string[], input?: string) {
  return spawnSync("psql", [DB_URL, "-X", "-v", "ON_ERROR_STOP=1", ...args], {
    encoding: "utf8",
    env: ENV,
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
}

const dbReady = isLocal && (() => {
  const r = psql(["-At", "-c", "select to_regclass('public.ride_offers') is not null and to_regclass('public.trips') is not null"]);
  return r.status === 0 && r.stdout.trim() === "t";
})();

const describeDb = dbReady ? describe : describe.skip;

describe("SQL offer SSOT migration — static guarantees", () => {
  const sql = readFileSync(MIGRATION, "utf8");

  it("replaces trip_negotiation_base_fare_pence with committed-first priority", () => {
    const fn = sql.slice(
      sql.indexOf("CREATE OR REPLACE FUNCTION public.trip_negotiation_base_fare_pence"),
      sql.indexOf("-- 2. Airport resolver"),
    );
    const order = [
      "locked_base_fare_pence",
      "final_customer_fare_pence",
      "final_fare_pence",
      "estimated_total_pence",
      "fare_snapshot_json",
      "authorised_amount_pence",
      "fare_breakdown",
    ].map((token) => fn.indexOf(token, fn.indexOf("1. locked_base")));
    expect(order.every((i) => i > -1)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // The breakdown tier is guarded as the last committed-less fallback.
    expect(fn).toContain("7. ONLY THEN fare_breakdown");
  });

  it("never hardcodes a commission rate or airport amount", () => {
    expect(sql).not.toMatch(/\*\s*0\.9\b|\b0\.90\b|\*\s*10\s*\/\s*100|\bcommission[^\n]*:=\s*10\b/);
    expect(sql).toContain("resolve_wave_commission_percent(v_wave, 0)");
    expect(sql).not.toMatch(/\b(700|7300|6640|5940)\b/);
  });

  it("states airport explicitly: present | zero | unknown (missing is never zero)", () => {
    expect(sql).toContain("'airport_charge_state'");
    expect(sql).toMatch(/WHEN v_airport_known IS NULL THEN 'unknown'/);
    expect(sql).toMatch(/ELSIF v_airport_state = 'zero'/);
  });
});

describe("global_offer pre-promotion commission base migration (20270222210000) — static guarantees", () => {
  const sql = readFileSync(GLOBAL_OFFER_MIGRATION, "utf8");
  const code = sql.replace(/--.*$/gm, "");

  it("never touches payment amounts and never rewrites rows", () => {
    expect(code).not.toMatch(/\b(UPDATE\s+public\.|DELETE\s+FROM|INSERT\s+INTO)\b/i);
    expect(code).not.toMatch(/revolut|capture|increment/i);
  });

  it("adds the promotion back to the payable for the commission base only", () => {
    expect(code).toContain("offer_global_offer_promotion_pence");
    expect(code).toContain("offer_driver_net_split_for_trip");
    expect(code).toContain("v_payable + v_promo >= v_trip_fare + v_airport");
    expect(code).toContain("v_commissionable := GREATEST(0, v_payable + v_promo - v_airport);");
  });
});

describeDb("SQL offer SSOT — execution (local DB, rolled back)", () => {
  it("MK-004 (480/500/10% -> 432 at creation), Heathrow (no promotion 6640) and MK-007 global_offer (6820)", () => {
    const r = psql(["-v", `migration=${MIGRATION}`, "-v", `global_offer_migration=${GLOBAL_OFFER_MIGRATION}`, "-f", SQL_TEST]);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(out).not.toMatch(/ERROR:/);
    expect(r.status).toBe(0);
    expect(out).toContain("PASS MK-004 offer net at creation = 480 x (1 - 10%) = 432");
    // Heathrow without a promotion: commission base = payable - airport.
    expect(out).toContain("PASS Heathrow total driver payable = journey + airport = 6640");
    expect(out).toContain("PASS Heathrow journey net = 6600 - 660 = 5940");
    // MK-007 global_offer: commission base = quote ride (pre-promotion); 200 comes out of ONECAB commission.
    expect(out).toContain("PASS MK-007 global_offer total driver payable = 6820 = 6820");
    expect(out).toContain("PASS MK-007 global_offer journey net = 6800 - 680 = 6120");
    expect(out).toContain("PASS MK-007 global_offer is NOT 6640");
    expect(out).toContain("PASS MK-007 global_offer capture identity 6120 + 680 + 700 - 200 = 7300 = 7300");
    expect(out).toContain("ALL committed_offer_fare_sql_ssot CHECKS PASSED");
    expect(out).toContain("ROLLED BACK - nothing committed");
  }, 120_000);

  it("SQL trip_negotiation_base_fare_pence === TS resolveCommittedOfferGrossPence over a priority grid", () => {
    const fixtures: Array<Record<string, unknown>> = [];
    for (let mask = 0; mask < 128; mask++) {
      for (const discount of [0, 20]) {
        for (const mod of [0, 100]) {
          for (const gross of [null, 500]) {
            const f: Record<string, unknown> = {};
            if (mask & 1) f.locked_base_fare_pence = 480;
            if (mask & 2) f.final_customer_fare_pence = 470;
            if (mask & 4) f.final_fare_pence = 460;
            if (mask & 8) f.estimated_total_pence = 450;
            if (mask & 16) f.fare_snapshot_json = { committed_fare_pence: 440 };
            if (mask & 32) f.authorised_amount_pence = 430;
            if (mask & 64) f.fare_breakdown = { final_fare_pence: 500, trip_fare_pence: 490 };
            if (discount) f.discount_pence = discount;
            if (mod) f.customer_modification_charge_pence = mod;
            if (gross) f.gross_fare_pence = gross;
            fixtures.push(f);
          }
        }
      }
    }
    // discount-source and legacy-column variants
    fixtures.push(
      { offer_discount_pence: 20, discount_source: "global_offer", gross_fare_pence: 500, final_fare_pence: 500 },
      { voucher_discount_pence: 30, discount_source: "personal_voucher", gross_fare_pence: 500, final_fare_pence: 500 },
      { offer_discount_pence: 10, voucher_discount_pence: 40, locked_base_fare_pence: 500, final_customer_fare_pence: 460 },
      { fare_snapshot_json: { original_fare_pence: 500 }, discount_pence: 20 },
      { fare_breakdown: { trip_fare_pence: 6800, airport_charge_pence: 700 } },
      { fare_breakdown: { finalFare: 5, tripFare: 4.5 } },
      { fare: 4.8 },
      { estimated_fare: 4.8 },
    );

    const dir = mkdtempSync(join(tmpdir(), "offer-parity-"));
    try {
      const fxPath = join(dir, "fx.json");
      writeFileSync(fxPath, JSON.stringify(fixtures));
      const script = [
        "BEGIN;",
        `\\i ${MIGRATION}`,
        `\\set fx \`cat ${fxPath}\``,
        "SELECT ord || '|' || public.trip_negotiation_base_fare_pence(jsonb_populate_record(NULL::public.trips, f))",
        "FROM jsonb_array_elements(:'fx'::jsonb) WITH ORDINALITY AS t(f, ord) ORDER BY ord;",
        "ROLLBACK;",
      ].join("\n");
      const r = psql(["-q", "-At"], script);
      expect(r.status, r.stderr).toBe(0);
      const rows = r.stdout
        .split("\n")
        .filter((l) => /^\d+\|\d+$/.test(l.trim()))
        .map((l) => l.trim().split("|").map(Number));
      expect(rows.length).toBe(fixtures.length);

      const mismatches: unknown[] = [];
      for (const [ord, sqlValue] of rows) {
        const fixture = fixtures[ord - 1];
        const ts = resolveCommittedOfferGrossPence(fixture);
        if (ts !== sqlValue) mismatches.push({ fixture, ts, sql: sqlValue });
      }
      expect(mismatches.slice(0, 5)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
