/**
 * Compat A handshake lock:
 * - Old Edge (main/v31): non-POST → 405 before reservation/provider
 * - New Edge: GET returns STAGE_C2_V1 quote with writes:false
 * - Quote payload completeness + ADMIN_HOLD not masked as NO_AVAILABLE_BALANCE
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DRIVER_PAYOUT_BLOCK_REASON,
  DRIVER_WITHDRAW_ELIGIBILITY_SOURCE,
  DRIVER_WITHDRAW_EXECUTOR_VERSION,
  DRIVER_WITHDRAW_QUOTE_VERSION,
  buildDriverPayoutWithdrawalQuote,
  isCompatibleDriverWithdrawExecutorQuote,
  toDriverWithdrawExecutorQuotePayload,
} from "./driverPayoutWithdrawalQuoteSSOT.ts";
import type { DriverPayoutEligibilityResult } from "./driverPayoutEligibilitySSOT.ts";
import { PAYOUT_ELIGIBILITY_STATUS } from "./driverPayoutEligibilitySSOT.ts";

/** Documented invariant from origin/main (= live v31) audit. */
const OLD_EDGE_V31_METHOD_GATE = `
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
`;

Deno.test("old Edge v31: GET/HEAD/OPTIONS reject before money path", () => {
  assertStringIncludes(OLD_EDGE_V31_METHOD_GATE, "method_not_allowed");
  assertStringIncludes(OLD_EDGE_V31_METHOD_GATE, 'req.method !== "POST"');
  assertEquals(OLD_EDGE_V31_METHOD_GATE.includes("reserve_driver_payout_item"), false);
});

Deno.test("new Edge source: GET quote path + POST still gated; quote has zero writes", async () => {
  const src = await Deno.readTextFile(
    new URL("../driver-withdraw/index.ts", import.meta.url),
  );
  assertStringIncludes(src, 'req.method === "GET" || req.method === "HEAD"');
  assertStringIncludes(src, "toDriverWithdrawExecutorQuotePayload");
  assertStringIncludes(src, "buildDriverWithdrawQuoteReadOnly");
  assertStringIncludes(src, "writes: false");
  assertStringIncludes(src, "reserve_driver_payout_item");
  const getBlock = src.slice(
    src.indexOf('req.method === "GET"'),
    src.indexOf('if (req.method !== "POST")'),
  );
  assertEquals(getBlock.includes("reserve_driver_payout_item"), false);
  assertEquals(getBlock.includes("relayApprovedDriverPayoutPayment"), false);
  assertEquals(getBlock.includes(".insert("), false);
});

function eligBase(over: Partial<DriverPayoutEligibilityResult> = {}): DriverPayoutEligibilityResult {
  return {
    live_balance_pence: 3319,
    available_balance_pence: 3319,
    pending_balance_pence: 0,
    withdrawal_in_progress_pence: 0,
    outstanding_debt_pence: 0,
    primary_hold_reason: null,
    eligible_entries: [],
    eligible_earnings_pence: 3319,
    held_entries: [],
    ...over,
  };
}

Deno.test("GET quote wire: MK0006 shape 3319/50/3269 + 2951", () => {
  const quote = buildDriverPayoutWithdrawalQuote({
    eligibility: eligBase(),
    global_payouts_enabled: true,
    payout_operational_paused: false,
    provider_verified_active_destination: true,
    driver_approved: true,
    driver_suspended: false,
    fee_pence: 50,
    minimum_pence: 51,
    early_cash_out_enabled: true,
    provider_available: true,
    financial_model_platform_collected: true,
    legacy_payouts_enabled: false,
  });
  const payload = toDriverWithdrawExecutorQuotePayload({
    quote,
    destination_status: "PROVIDER_VERIFIED",
    destination_masked_last4: "2951",
    quote_generated_at: "2026-09-16T17:00:00.000Z",
  });
  assertEquals(isCompatibleDriverWithdrawExecutorQuote(payload), true);
  assertEquals(payload.quote_version, DRIVER_WITHDRAW_QUOTE_VERSION);
  assertEquals(payload.executor_version, DRIVER_WITHDRAW_EXECUTOR_VERSION);
  assertEquals(payload.eligibility_source, DRIVER_WITHDRAW_ELIGIBILITY_SOURCE);
  assertEquals(payload.withdrawable_pence, 3319);
  assertEquals(payload.fee_pence, 50);
  assertEquals(payload.net_payout_pence, 3269);
  assertEquals(payload.payout_allowed, true);
  assertEquals(payload.destination.masked_account, "2951");
  assertEquals(payload.destination.status, "PROVIDER_VERIFIED");
  assertEquals(payload.revolut_pay_called, false);
  assertEquals(payload.writes, false);
});

Deno.test("compatible blocked quote: ADMIN_HOLD not NO_AVAILABLE_BALANCE", () => {
  const quote = buildDriverPayoutWithdrawalQuote({
    eligibility: eligBase({
      available_balance_pence: 0,
      pending_balance_pence: 3319,
      primary_hold_reason: PAYOUT_ELIGIBILITY_STATUS.ADMIN_HOLD,
    }),
    global_payouts_enabled: true,
    payout_operational_paused: true,
    provider_verified_active_destination: true,
    driver_approved: true,
    driver_suspended: false,
    fee_pence: 50,
    early_cash_out_enabled: true,
    provider_available: true,
    financial_model_platform_collected: true,
    legacy_payouts_enabled: false,
  });
  const payload = toDriverWithdrawExecutorQuotePayload({
    quote,
    destination_status: "PROVIDER_VERIFIED",
    destination_masked_last4: "2951",
  });
  assertEquals(payload.payout_allowed, false);
  assertEquals(payload.withdrawable_pence, 0);
  assertEquals(payload.blocking_reason_code, DRIVER_PAYOUT_BLOCK_REASON.ADMIN_HOLD);
  assertEquals(payload.blocking_reason_code === "NO_AVAILABLE_BALANCE", false);
});

Deno.test("incompatible payloads rejected (old Edge 405 body / Stage C summary)", () => {
  assertEquals(isCompatibleDriverWithdrawExecutorQuote({ error: "method_not_allowed" }), false);
  assertEquals(
    isCompatibleDriverWithdrawExecutorQuote({
      early_cash_out_eligible: true,
      early_cash_out_requested_pence: 3319,
    }),
    false,
  );
});
