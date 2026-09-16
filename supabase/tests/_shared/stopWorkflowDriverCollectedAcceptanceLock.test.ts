/**
 * Driver-Collected acceptance — code and fixture only.
 * No production trip, wallet, or provider call.
 * Run: deno test --allow-read --no-check supabase/functions/_shared/stopWorkflowDriverCollectedAcceptanceLock.test.ts
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  OPERATIONAL_CASH_VIOLATION,
  completeTripCashDecision,
  isDriverCollectedCashTrip,
  isPlatformCollectedOperationalCash,
} from "./stopWorkflowSecurity.ts";
import { requiresProviderSettlement } from "./digitalPaymentCapture.ts";

const DC = {
  financial_model: "DRIVER_COLLECTED_COMMISSION_WALLET",
  payment_method: "cash",
  payment_status: "driver_collects_upfront",
};

function slice(src: string, start: string, end: string): string {
  const i = src.indexOf(start);
  const j = src.indexOf(end, i);
  assert(i >= 0 && j > i, `missing slice ${start}`);
  return src.slice(i, j);
}

Deno.test("valid Driver-Collected cash completion is allowed", () => {
  assertEquals(isDriverCollectedCashTrip(DC), true);
  assertEquals(completeTripCashDecision(DC), "allow_driver_collected");
  assertEquals(isPlatformCollectedOperationalCash(DC), false);
});

Deno.test("PLATFORM_COLLECTED cash is rejected; card is not", () => {
  assertEquals(completeTripCashDecision({
    financial_model: "PLATFORM_COLLECTED",
    payment_method: "cash",
  }), "fail_closed_operational_cash");
  assertEquals(completeTripCashDecision({
    financial_model: "PLATFORM_COLLECTED",
    payment_method: "card",
    payment_status: "authorized",
  }), "not_cash");
  assertEquals(
    OPERATIONAL_CASH_VIOLATION.includes("FINANCIAL_MODEL_VIOLATION"),
    true,
  );
});

Deno.test("platform card/Revolut is settled; Driver-Collected never invokes provider", () => {
  assertEquals(requiresProviderSettlement({
    financial_model: "DRIVER_COLLECTED_COMMISSION_WALLET",
    payment_method: "cash",
    payment_status: "driver_collects_upfront",
    payment_session_id: "should-be-ignored",
    provider_order_id: "should-be-ignored",
    payment_provider: "revolut",
  }), false);
  assertEquals(requiresProviderSettlement({
    financial_model: "PLATFORM_COLLECTED",
    payment_method: "card",
    payment_provider: "revolut",
    provider_order_id: "ord_1",
  }), true);
  assertEquals(requiresProviderSettlement({
    financial_model: "PLATFORM_COLLECTED",
    payment_method: "cash",
    payment_provider: "revolut",
    provider_order_id: "ord_1",
  }), false);
});

Deno.test("stop-workflow completion, cancel, stacked, waiting, and isolation locks", async () => {
  const src = await Deno.readTextFile(
    new URL("../stop-workflow/index.ts", import.meta.url),
  );
  const complete = slice(src, "case 'complete_trip':", "default:");
  const failAt = complete.indexOf("fail_closed_operational_cash");
  const waitingAt = complete.indexOf("waiting_finalize_start");
  const statusAt = complete.indexOf("status: 'completed'");
  const providerAt = complete.indexOf("if (needsProviderSettlement)");
  const walletAt = complete.indexOf("mayPostDriverWalletLedger");
  const idempotentAt = complete.indexOf("Trip already completed (idempotent)");

  assert(idempotentAt >= 0 && idempotentAt < failAt, "completed retry returns before writes");
  assert(failAt >= 0 && failAt < waitingAt, "platform cash fails before waiting writes");
  assert(waitingAt < statusAt, "driver-collected waiting finalizes before completion stamp");
  assert(statusAt < providerAt, "status stamp precedes provider gate");
  assertEquals(complete.includes("success: true, idempotent: true"), true);
  assertEquals(complete.includes("mayPostDriverWalletLedger = tripFinancialModel === \"PLATFORM_COLLECTED\""), true);
  assertEquals(complete.includes("type: 'CASH_TRIP_EARNING'"), false);
  assertEquals(complete.includes("type: 'CASH_COMMISSION_DEBT'"), false);
  assertEquals(complete.includes("payout_items"), false);
  assertEquals(complete.includes("payment_sessions"), false);
  assertEquals(complete.includes("record_cash_trip_completion"), false);
  assertEquals(complete.includes("invokeFinalizeTripCapture"), true);
  assert(
    complete.indexOf("invokeFinalizeTripCapture") > providerAt,
    "provider capture is inside the needsProviderSettlement branch",
  );
  assertEquals(complete.includes("tryPromoteStackedTripAfterCompletion"), true);
  assertEquals(src.includes("queued_trip_cannot_progress_before_promotion"), true);
  assertEquals(src.includes("executeDriverTerminalCancel"), true);
  assertEquals(src.includes("cancel_queued_stacked"), true);

  const guard = await Deno.readTextFile(
    new URL(
      "../../migrations/20261107214500_phase3_platform_collected_cash_insert_guard.sql",
      import.meta.url,
    ),
  );
  assertEquals(
    guard.includes("DRIVER_COLLECTED_COMMISSION_WALLET + cash is not rejected"),
    true,
  );
  assertEquals(
    guard.includes("upper(coalesce(NEW.financial_model::text, '')) <> 'PLATFORM_COLLECTED'"),
    true,
  );

  const isolation = await Deno.readTextFile(
    new URL("../../migrations/20260927180100_financial_model_isolation.sql", import.meta.url),
  );
  assertEquals(isolation.includes("convert_driver_commission_wallet_on_trip_complete"), true);
  assertEquals(isolation.includes("COMMISSION_DEDUCTION"), true);
  assertEquals(isolation.includes("trg_commission_wallet_on_trip_complete"), true);
  assertEquals(
    isolation.includes("Commission Wallet reservation forbidden"),
    true,
  );
  assertEquals(
    isolation.includes("Commission Wallet deduction/subsidy forbidden"),
    true,
  );
  assertEquals(isolation.includes("prevent_platform_wallet_ledger_on_cw_trip"), true);
  const convert = slice(
    isolation,
    "CREATE OR REPLACE FUNCTION public.convert_driver_commission_wallet_on_trip_complete",
    "CREATE OR REPLACE FUNCTION public.trg_commission_wallet_on_trip_complete",
  );
  assertEquals(convert.includes("COMMISSION_DEDUCTION"), true);
  assertEquals(convert.includes("CASH_TRIP_EARNING"), false);
  assertEquals(convert.includes("CASH_COMMISSION_DEBT"), false);
  assertEquals(convert.includes("driver_wallet_ledger"), false);
  assertEquals(convert.includes("payment_sessions"), false);
  assertEquals(isolation.includes("trg_commission_wallet_release_on_cancel"), true);

  const rematch = await Deno.readTextFile(
    new URL("../driver-cancel-before-pickup/index.ts", import.meta.url),
  );
  assertEquals(rematch.includes("searching_new_driver"), true);
  assertEquals(rematch.includes("cancelled_driver_ids"), true);
  assertEquals(rematch.includes("excluded_driver_ids"), true);
  assertEquals(rematch.includes("status: \"cancelled\""), false);

  const terminal = await Deno.readTextFile(
    new URL("./driverTripCancel.ts", import.meta.url),
  );
  assertEquals(terminal.includes("USE_DRIVER_CANCEL_REMATCH"), true);
  assertEquals(terminal.includes("status: \"cancelled\""), true);
});
