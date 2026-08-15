/**
 * Clearing-delay smoke tests (27h default).
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
} from "./driverPayoutEligibilitySSOT.ts";

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

Deno.test("provider available_on clears immediately even under 27h", () => {
  const r = evaluateLedgerEntryEligibility(
    earning({ provider_available_on: CLEARED_AT, captured_at: FRESH_CAPTURE }),
    POLICY_27H,
  );
  assertEquals(r.status, PAYOUT_ELIGIBILITY_STATUS.ELIGIBLE);
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
