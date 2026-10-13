/**
 * LOCK — strict 27h clearing for PLATFORM_COLLECTED earnings.
 * Stable clearing origin + payout_clearing_delay_hours, with no provider
 * early-clear exception (business policy 2026-10-02).
 * Run: deno test --allow-read supabase/functions/_shared/driverWalletClearingDelay27h.test.ts
 */
import {
  assertEquals,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DEFAULT_PAYOUT_CLEARING_DELAY_HOURS,
  PAYOUT_ELIGIBILITY_STATUS,
  aggregateDriverPayoutEligibility,
  evaluateLedgerEntryEligibility,
  isPayoutClearedForPlatformCollected,
  type LedgerEligibilityEvidence,
} from "../../functions/_shared/driverPayoutEligibilitySSOT.ts";

const NOW_MS = Date.parse("2026-08-15T16:00:00.000Z");
const FRESH_CAPTURE = "2026-08-15T15:00:00.000Z";
const CLEARED_AT = "2026-08-13T12:00:00.000Z";
const POLICY_27H = { now_ms: NOW_MS, clearing_delay_hours: 27 };

Deno.test("default payout clearing delay is 27 hours", () => {
  assertEquals(DEFAULT_PAYOUT_CLEARING_DELAY_HOURS, 27);
});

Deno.test("fresh capture within 27h stays uncleared", () => {
  assertEquals(
    isPayoutClearedForPlatformCollected({
      payment_collection_model: "PLATFORM_COLLECTED",
      payment_method: "card",
      captured_at: FRESH_CAPTURE,
    }, POLICY_27H),
    false,
  );
});

Deno.test("capture older than 27h clears via fallback", () => {
  assertEquals(
    isPayoutClearedForPlatformCollected({
      payment_collection_model: "PLATFORM_COLLECTED",
      payment_method: "card",
      captured_at: CLEARED_AT,
    }, POLICY_27H),
    true,
  );
});

Deno.test("26h59m still pending; 27h00m available", () => {
  const origin = "2026-08-14T13:00:00.000Z";
  const justBefore = Date.parse("2026-08-15T15:59:00.000Z"); // 26h59m
  const exactly = Date.parse("2026-08-15T16:00:00.000Z"); // 27h
  assertEquals(
    isPayoutClearedForPlatformCollected({
      payment_collection_model: "PLATFORM_COLLECTED",
      payment_method: "card",
      captured_at: origin,
    }, { now_ms: justBefore, clearing_delay_hours: 27 }),
    false,
  );
  assertEquals(
    isPayoutClearedForPlatformCollected({
      payment_collection_model: "PLATFORM_COLLECTED",
      payment_method: "card",
      captured_at: origin,
    }, { now_ms: exactly, clearing_delay_hours: 27 }),
    true,
  );
});

function earning(overrides: Partial<LedgerEligibilityEvidence> = {}): LedgerEligibilityEvidence {
  return {
    ledger_entry_id: "earn-1",
    trip_id: "trip-1",
    ledger_type: "TRIP_EARNING_NET",
    amount_pence: 421,
    trip_exists: true,
    payment_session_id: "ps-1",
    captured_amount_pence: 495,
    canonical_driver_net_pence: 421,
    fr_trip_status: "BALANCED",
    refunded_amount_pence: 0,
    des_present: false,
    payment_collection_model: "PLATFORM_COLLECTED",
    payment_method: "card",
    trip_status: "completed",
    completed_at: FRESH_CAPTURE,
    captured_at: FRESH_CAPTURE,
    earning_credited_at: FRESH_CAPTURE,
    ...overrides,
  };
}

Deno.test("uncleared PLATFORM_COLLECTED → SETTLEMENT_PENDING", () => {
  const r = evaluateLedgerEntryEligibility(earning(), POLICY_27H);
  assertEquals(r.status, PAYOUT_ELIGIBILITY_STATUS.SETTLEMENT_PENDING);
  const agg = aggregateDriverPayoutEligibility({
    live_balance_pence: 421,
    entries: [earning()],
    clearing_policy: POLICY_27H,
  });
  assertEquals(agg.pending_balance_pence, 421);
  assertEquals(agg.available_balance_pence, 0);
});

Deno.test("DRIVER_COLLECTED TRIP_EARNING_NET is never payout-eligible", () => {
  const r = evaluateLedgerEntryEligibility(
    earning({
      payment_collection_model: "DRIVER_COLLECTED_COMMISSION_WALLET",
      financial_model: "DRIVER_COLLECTED_COMMISSION_WALLET",
      payment_method: "cash",
      provider_available_on: CLEARED_AT,
    }),
    POLICY_27H,
  );
  assertEquals(r.status, PAYOUT_ELIGIBILITY_STATUS.UNKNOWN_ELIGIBILITY_ERROR);
  assertEquals(r.payable_pence, 0);
});

/**
 * STRICT 27h policy: provider availability / settlement can never shorten the
 * configured delay, and a pending provider state never extends it. The SQL
 * mirror (driver_wallet_eligibility_balances) carries the same rule.
 */
const PROVIDER_EARLY_STATES = ["AVAILABLE", "PAID_OUT", "FUNDS_AVAILABLE", "BALANCE_AVAILABLE", "SETTLE", "SETTLED"];
const CAPTURE_1H = "2026-08-15T15:00:00.000Z"; // earning age 1h at NOW_MS
const PROVIDER_AVAILABLE_AT_PLUS_1H = "2026-08-15T16:00:00.000Z"; // capture + 1h, reached at NOW_MS

Deno.test("strict 27h: provider_available_on at +1h, earning age 1h → Pending", () => {
  const e = earning({
    captured_at: CAPTURE_1H,
    earning_credited_at: CAPTURE_1H,
    completed_at: CAPTURE_1H,
    provider_available_on: PROVIDER_AVAILABLE_AT_PLUS_1H,
  });
  assertEquals(isPayoutClearedForPlatformCollected(e, POLICY_27H), false);
  assertEquals(evaluateLedgerEntryEligibility(e, POLICY_27H).status, PAYOUT_ELIGIBILITY_STATUS.SETTLEMENT_PENDING);
  const agg = aggregateDriverPayoutEligibility({ live_balance_pence: 421, entries: [e], clearing_policy: POLICY_27H });
  assertEquals([agg.pending_balance_pence, agg.available_balance_pence], [421, 0]);
});

for (const state of PROVIDER_EARLY_STATES) {
  Deno.test(`strict 27h: provider state ${state} at +1h, earning age 1h → Pending`, () => {
    const e = earning({
      captured_at: CAPTURE_1H,
      earning_credited_at: CAPTURE_1H,
      completed_at: CAPTURE_1H,
      provider_state: state,
    });
    assertEquals(isPayoutClearedForPlatformCollected(e, POLICY_27H), false);
    assertEquals(evaluateLedgerEntryEligibility(e, POLICY_27H).status, PAYOUT_ELIGIBILITY_STATUS.SETTLEMENT_PENDING);
    const agg = aggregateDriverPayoutEligibility({ live_balance_pence: 421, entries: [e], clearing_policy: POLICY_27H });
    assertEquals([agg.pending_balance_pence, agg.available_balance_pence], [421, 0]);
  });
}

Deno.test("strict 27h: 26:59:59 Pending and 27:00:00 Available regardless of provider fields", () => {
  const origin = "2026-08-14T13:00:00.000Z";
  const at265959 = Date.parse("2026-08-15T15:59:59.000Z");
  const at270000 = Date.parse("2026-08-15T16:00:00.000Z");
  const providerVariants: Array<Partial<LedgerEligibilityEvidence>> = [
    {},
    { provider_available_on: "2026-08-14T14:00:00.000Z" },
    ...PROVIDER_EARLY_STATES.map((provider_state) => ({ provider_state })),
    { provider_state: "PENDING" },
    { provider_state: "PROCESSING" },
    { provider_available_on: "2026-08-20T00:00:00.000Z" },
  ];
  for (const variant of providerVariants) {
    const e = earning({ captured_at: origin, earning_credited_at: origin, completed_at: origin, ...variant });
    const label = JSON.stringify(variant);
    assertEquals(isPayoutClearedForPlatformCollected(e, { now_ms: at265959, clearing_delay_hours: 27 }), false, label);
    assertEquals(isPayoutClearedForPlatformCollected(e, { now_ms: at270000, clearing_delay_hours: 27 }), true, label);
    assertEquals(
      evaluateLedgerEntryEligibility(e, { now_ms: at265959, clearing_delay_hours: 27 }).status,
      PAYOUT_ELIGIBILITY_STATUS.SETTLEMENT_PENDING,
      label,
    );
    assertEquals(
      evaluateLedgerEntryEligibility(e, { now_ms: at270000, clearing_delay_hours: 27 }).status,
      PAYOUT_ELIGIBILITY_STATUS.ELIGIBLE,
      label,
    );
  }
});

Deno.test("strict 27h: SQL wallet SSOT has no provider early-clear branch", () => {
  const sql = Deno.readTextFileSync(
    new URL(
      "../../migrations/20261205120000_terminal_wallet_eligibility_and_stamp_invariant.sql",
      import.meta.url,
    ),
  );
  const body = sql.slice(
    sql.indexOf("CREATE OR REPLACE FUNCTION public.driver_wallet_eligibility_balances"),
    sql.indexOf("$function$;", sql.indexOf("CREATE OR REPLACE FUNCTION public.driver_wallet_eligibility_balances")),
  );
  assert(body.length > 0);
  assert(!body.includes("provider_available_on"), "provider_available_on must not clear early");
  assert(!body.includes("driver_wallet_provider_funds_cleared"), "provider state must not clear early");
  assert(body.includes("v_origin := public.driver_wallet_stable_clearing_origin("));
  assert(body.includes("(v_origin + (v_delay_hours * interval '1 hour')) <= now()"));
});

Deno.test("strict 27h: TS mirror has no provider early-clear branch", () => {
  const src = Deno.readTextFileSync(
    new URL("../../functions/_shared/driverPayoutEligibilitySSOT.ts", import.meta.url),
  );
  const fn = src.slice(
    src.indexOf("export function isPayoutClearedForPlatformCollected"),
    src.indexOf("export type LedgerEligibilityEvidence"),
  );
  assert(!fn.includes("evidence.provider_available_on"));
  assert(!fn.includes("evidence.provider_state"));
  assert(!src.includes("isProviderFundsClearedState"));
});

Deno.test("Pending + Available = live for unpaid set", () => {
  const pending = earning({ ledger_entry_id: "p", amount_pence: 1436, canonical_driver_net_pence: 1436, captured_amount_pence: 1600 });
  const available = earning({
    ledger_entry_id: "a",
    amount_pence: 803,
    canonical_driver_net_pence: 803,
    captured_amount_pence: 900,
    captured_at: CLEARED_AT,
    earning_credited_at: CLEARED_AT,
  });
  const agg = aggregateDriverPayoutEligibility({
    live_balance_pence: 2239,
    entries: [pending, available],
    clearing_policy: POLICY_27H,
  });
  assertEquals(agg.live_balance_pence, 2239);
  assert(agg.pending_balance_pence + agg.available_balance_pence === 2239);
});
