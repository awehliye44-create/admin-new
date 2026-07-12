import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isStripeRuntimeDisabled,
  resolveActivePaymentProviderName,
  resolveActivePayoutProviderName,
} from "./stripeRuntimeDisabled.ts";
import { requiresStripeSettlement } from "./payoutEligibilitySSOT.ts";
import { computeFrDriverReconciliation } from "./frDriverReconciliationSSOT.ts";

Deno.test("Stripe runtime disabled by default", () => {
  assertEquals(isStripeRuntimeDisabled(() => undefined), true);
});

Deno.test("empty/stripe provider never selected for active finance", () => {
  assertEquals(resolveActivePaymentProviderName(""), "unavailable");
  assertEquals(resolveActivePaymentProviderName("stripe"), "unavailable");
  assertEquals(resolveActivePayoutProviderName("stripe"), "unavailable");
});

Deno.test("requiresStripeSettlement always false after retirement", () => {
  assertEquals(requiresStripeSettlement("card", "stripe"), false);
  assertEquals(requiresStripeSettlement("card", ""), false);
  assertEquals(requiresStripeSettlement("card", "revolut"), false);
});

Deno.test("Ahmed wallet truth without Connect balance", () => {
  const row = computeFrDriverReconciliation({
    ledger: [
      { type: "TRIP_EARNING_NET", amount_pence: 408 },
      { type: "PLATFORM_COMMISSION", amount_pence: 72 },
      { type: "TRIP_EARNING_NET", amount_pence: 593 },
      { type: "PLATFORM_COMMISSION", amount_pence: 105 },
    ],
    settledTrips: [
      { trip_id: "007", driver_net_pence: 408 },
      { trip_id: "008", driver_net_pence: 593 },
    ],
    completedPayoutItems: [],
    walletEvidenceAvailable: true,
    settlementEvidenceAvailable: true,
    identityMappingValid: true,
    accountVerified: true,
    payout_provider: "revolut",
    finance_cleared_pence: 1001,
    provider_account_balance_pence: null,
    provider_account_balance_status: "NOT_APPLICABLE",
  });
  assertEquals(row.current_wallet_balance_pence, 1001);
  assertEquals(row.expected_payable_pence, 1001);
  assertEquals(row.reconciliation_status, "BALANCED");
  assertEquals(row.provider_account_balance_status, "NOT_APPLICABLE");
});

Deno.test("Bosteyo wallet truth without Connect balance", () => {
  const row = computeFrDriverReconciliation({
    ledger: [
      { type: "TRIP_EARNING_NET", amount_pence: 408 },
      { type: "PLATFORM_COMMISSION", amount_pence: 72 },
    ],
    settledTrips: [{ trip_id: "010", driver_net_pence: 408 }],
    completedPayoutItems: [],
    walletEvidenceAvailable: true,
    settlementEvidenceAvailable: true,
    identityMappingValid: true,
    accountVerified: true,
    payout_provider: "revolut",
    finance_cleared_pence: 408,
    provider_account_balance_pence: null,
    provider_account_balance_status: "NOT_APPLICABLE",
  });
  assertEquals(row.current_wallet_balance_pence, 408);
  assertEquals(row.expected_payable_pence, 408);
  assertEquals(row.reconciliation_status, "BALANCED");
});
