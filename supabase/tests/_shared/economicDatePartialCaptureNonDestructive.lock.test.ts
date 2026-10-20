/**
 * Lock: narrow PARTIAL_CAPTURE_ONLY economic-date exception
 * (MK-260923-017 — verified capture, released_amount=0, financial CAPTURED).
 *
 * deno test --allow-read supabase/tests/_shared/economicDatePartialCaptureNonDestructive.lock.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { specResolveEconomicDate } from "../../functions/_shared/economicEarnedAtResolverSpec.ts";
import {
  classifyWeeklyPeriodCredit,
  WEEKLY_CREDIT_BUCKET,
} from "../../functions/_shared/weeklyPayoutPeriodSSOT.ts";
const CAPTURED_AT = "2026-09-23T18:55:33.581Z";
const POSTING = "2026-09-23T18:47:23.202Z";

const mk0923Session = {
  purpose: "RIDE_BOOKING",
  status: "PARTIAL_CAPTURE_ONLY",
  financial_operation_state: "CAPTURED",
  provider_state: "COMPLETED",
  provider_state_verified_at: CAPTURED_AT,
  captured_at: CAPTURED_AT,
  captured_amount_pence: 500,
  authorised_amount_pence: 500,
  released_at: CAPTURED_AT,
  released_amount_pence: 0,
  hold_release_state: "released",
  refunded_at: null,
  refunded_amount_pence: 0,
} as const;

Deno.test("MK-260923-017 shape resolves to RESOLVED at original capture time", () => {
  const r = specResolveEconomicDate({
    type: "TRIP_EARNING_NET",
    related_trip_id: "174df647-2417-4da3-9e55-7261a4e7d3e7",
    created_at: POSTING,
    financial_model: "PLATFORM_COLLECTED",
    sessions: [mk0923Session],
  });
  assertEquals(r.economic_date_status, "RESOLVED");
  assertEquals(r.economic_earned_at, CAPTURED_AT);
  assertEquals(r.captured_at, CAPTURED_AT);
});

Deno.test("RESOLVED 430p unpaid is OLDER_UNPAID (not UNATTRIBUTED) for a later weekly period", () => {
  const bucket = classifyWeeklyPeriodCredit({
    period_start: "2026-10-18T23:00:00.000Z",
    period_end: "2026-10-25T23:00:00.000Z",
    entry: {
      ledger_entry_id: "92121551-2fa1-44bc-9556-7f3f55ff5479",
      amount_pence: 430,
      unpaid_pence: 430,
      type: "TRIP_EARNING_NET",
      economic_earned_at: CAPTURED_AT,
    },
  });
  assertEquals(bucket, WEEKLY_CREDIT_BUCKET.OLDER_UNPAID);
});

Deno.test("destructive PARTIAL release (released_amount > 0) stays CAPTURE_RELEASED", () => {
  const r = specResolveEconomicDate({
    type: "TRIP_EARNING_NET",
    related_trip_id: "t-destructive",
    created_at: POSTING,
    financial_model: "PLATFORM_COLLECTED",
    sessions: [{
      ...mk0923Session,
      released_amount_pence: 100,
    }],
  });
  assertEquals(r.economic_date_status, "CAPTURE_RELEASED");
  assertEquals(r.economic_earned_at, null);
});

Deno.test("NULL released_amount_pence on PARTIAL with release stamps stays fail-closed", () => {
  const r = specResolveEconomicDate({
    type: "TRIP_EARNING_NET",
    related_trip_id: "t-null-release-amount",
    created_at: POSTING,
    financial_model: "PLATFORM_COLLECTED",
    sessions: [{
      ...mk0923Session,
      released_amount_pence: null,
    }],
  });
  assertEquals(r.economic_date_status, "CAPTURE_RELEASED");
  assertEquals(r.economic_earned_at, null);
});

Deno.test("PARTIAL without financial CAPTURED stays CAPTURE_RELEASED", () => {
  const r = specResolveEconomicDate({
    type: "TRIP_EARNING_NET",
    related_trip_id: "t-nofin",
    created_at: POSTING,
    financial_model: "PLATFORM_COLLECTED",
    sessions: [{
      ...mk0923Session,
      financial_operation_state: "AUTHORISED",
    }],
  });
  assertEquals(r.economic_date_status, "CAPTURE_RELEASED");
  assertEquals(r.economic_earned_at, null);
});

Deno.test("unverified PARTIAL stays CAPTURE_NOT_VERIFIED / fail-closed", () => {
  const r = specResolveEconomicDate({
    type: "TRIP_EARNING_NET",
    related_trip_id: "t-unverified",
    created_at: POSTING,
    financial_model: "PLATFORM_COLLECTED",
    sessions: [{
      ...mk0923Session,
      hold_release_state: null,
      released_at: null,
      provider_state_verified_at: null,
    }],
  });
  assertEquals(r.economic_earned_at, null);
  assertEquals(
    ["CAPTURE_NOT_VERIFIED", "CAPTURE_RELEASED", "PAYMENT_SESSION_MISSING"].includes(
      r.economic_date_status,
    ),
    true,
  );
});

Deno.test("refunded capture stays CAPTURE_REFUNDED", () => {
  const r = specResolveEconomicDate({
    type: "TRIP_EARNING_NET",
    related_trip_id: "t-refund",
    created_at: POSTING,
    financial_model: "PLATFORM_COLLECTED",
    sessions: [{
      purpose: "RIDE_BOOKING",
      status: "PARTIAL_CAPTURE_ONLY",
      financial_operation_state: "CAPTURED",
      provider_state: "COMPLETED",
      provider_state_verified_at: CAPTURED_AT,
      captured_at: CAPTURED_AT,
      captured_amount_pence: 500,
      refunded_at: "2026-09-24T00:00:00Z",
      refunded_amount_pence: 500,
      released_at: null,
      released_amount_pence: 0,
      hold_release_state: null,
    }],
  });
  assertEquals(r.economic_date_status, "CAPTURE_REFUNDED");
  assertEquals(r.economic_earned_at, null);
});

Deno.test("existing CAPTURED + residual release still RESOLVED", () => {
  const r = specResolveEconomicDate({
    type: "TRIP_EARNING_NET",
    related_trip_id: "t-captured-residual",
    created_at: POSTING,
    financial_model: "PLATFORM_COLLECTED",
    sessions: [{
      purpose: "RIDE_BOOKING",
      status: "CAPTURED",
      financial_operation_state: "CAPTURED",
      provider_state: "COMPLETED",
      provider_state_verified_at: CAPTURED_AT,
      captured_at: CAPTURED_AT,
      captured_amount_pence: 517,
      released_at: CAPTURED_AT,
      released_amount_pence: 83,
      hold_release_state: "released",
      refunded_at: null,
      refunded_amount_pence: 0,
    }],
  });
  assertEquals(r.economic_date_status, "RESOLVED");
  assertEquals(r.economic_earned_at, CAPTURED_AT);
});

Deno.test("migration SQL contains only economic-date REPLACE and narrow predicate", () => {
  const sql = Deno.readTextFileSync(
    new URL(
      "../../migrations/20261220120000_economic_date_partial_capture_non_destructive_release.sql",
      import.meta.url,
    ),
  );
  assertEquals(sql.includes("CREATE OR REPLACE FUNCTION public.driver_wallet_resolve_economic_date"), true);
  assertEquals(sql.includes("PARTIAL_CAPTURE_ONLY"), true);
  assertEquals(sql.includes("financial_operation_state"), true);
  // Explicit 0 only — coalesce must not widen NULL into the PARTIAL exception.
  assertEquals(sql.includes("AND ps.released_amount_pence = 0"), true);
  assertEquals(sql.includes("AND coalesce(ps.released_amount_pence, 0) = 0\n            )"), false);
  assertEquals(sql.includes("finalize_driver_payout_completion"), false);
  assertEquals(/^\s*INSERT\s+INTO\b/im.test(sql), false);
  assertEquals(
    (sql.match(/CREATE OR REPLACE FUNCTION public\.(\w+)/g) ?? []).length,
    1,
  );
  assertEquals(sql.includes("STABLE SECURITY DEFINER"), true);
  assertEquals(sql.includes("SET search_path TO 'pg_catalog'"), true);
  assertEquals(sql.includes("GRANT EXECUTE ON FUNCTION public.driver_wallet_resolve_economic_date"), true);
});
