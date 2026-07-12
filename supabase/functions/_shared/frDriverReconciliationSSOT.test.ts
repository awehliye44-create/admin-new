/**
 * FR per-driver reconciliation — wallet vs payable (never Connect as wallet truth).
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  aggregateFrDriverAuditOverview,
  computeFrDriverReconciliation,
  sumActualWalletTripCreditsPence,
  sumExpectedPayablePence,
} from "./frDriverReconciliationSSOT.ts";

const ahmedLedger = [
  { type: "TRIP_EARNING_NET", amount_pence: 408 },
  { type: "PLATFORM_COMMISSION", amount_pence: 72 },
  { type: "TRIP_EARNING_NET", amount_pence: 593 },
  { type: "PLATFORM_COMMISSION", amount_pence: 105 },
];

const bosteyoLedger = [
  { type: "TRIP_EARNING_NET", amount_pence: 408 },
  { type: "PLATFORM_COMMISSION", amount_pence: 72 },
];

Deno.test("1. Ahmed expected payable £10.01 equals wallet credits £10.01", () => {
  const expected = sumExpectedPayablePence([
    { trip_id: "007", driver_net_pence: 408 },
    { trip_id: "008", driver_net_pence: 593 },
  ]);
  const actual = sumActualWalletTripCreditsPence(ahmedLedger);
  assertEquals(expected, 1001);
  assertEquals(actual, 1001);
  const row = computeFrDriverReconciliation({
    ledger: ahmedLedger,
    settledTrips: [
      { trip_id: "007", driver_net_pence: 408 },
      { trip_id: "008", driver_net_pence: 593 },
    ],
    completedPayoutItems: [],
    walletEvidenceAvailable: true,
    settlementEvidenceAvailable: true,
    identityMappingValid: true,
    accountVerified: true,
    finance_cleared_pence: 1001,
    provider_account_balance_pence: 0,
    provider_account_balance_status: "AVAILABLE",
  });
  assertEquals(row.expected_payable_pence, 1001);
  assertEquals(row.actual_wallet_trip_credits_pence, 1001);
  assertEquals(row.wallet_variance_pence, 0);
  assertEquals(row.current_wallet_balance_pence, 1001);
  assertEquals(row.reconciliation_status, "BALANCED");
  assertEquals(row.provider_account_balance_pence, 0);
  assertEquals(row.provider_balance_is_reference_only, true);
});

Deno.test("2. Bosteyo expected payable £4.08 equals wallet credits £4.08", () => {
  const row = computeFrDriverReconciliation({
    ledger: bosteyoLedger,
    settledTrips: [{ trip_id: "010", driver_net_pence: 408 }],
    completedPayoutItems: [],
    walletEvidenceAvailable: true,
    settlementEvidenceAvailable: true,
    identityMappingValid: true,
    accountVerified: true,
    payout_provider: "revolut",
    finance_cleared_pence: 408,
    provider_account_balance_pence: 853,
    provider_account_balance_status: "AVAILABLE",
  });
  assertEquals(row.expected_payable_pence, 408);
  assertEquals(row.actual_wallet_trip_credits_pence, 408);
  assertEquals(row.wallet_variance_pence, 0);
  assertEquals(row.current_wallet_balance_pence, 408);
  assertEquals(row.reconciliation_status, "BALANCED");
});

Deno.test("3. Missing Stripe balance displays UNAVAILABLE, not £0.00", () => {
  const row = computeFrDriverReconciliation({
    ledger: ahmedLedger,
    settledTrips: [
      { trip_id: "007", driver_net_pence: 408 },
      { trip_id: "008", driver_net_pence: 593 },
    ],
    completedPayoutItems: [],
    walletEvidenceAvailable: true,
    settlementEvidenceAvailable: true,
    identityMappingValid: true,
    accountVerified: true,
    finance_cleared_pence: 1001,
    provider_account_balance_pence: null,
    provider_account_balance_status: "UNAVAILABLE",
  });
  assertEquals(row.provider_account_balance_pence, null);
  assertEquals(row.provider_account_balance_status, "UNAVAILABLE");
  assertEquals(row.reconciliation_status, "PROVIDER_BALANCE_UNAVAILABLE");
});

Deno.test("4. Stripe balance £8.53 does not become Driver Wallet balance", () => {
  const row = computeFrDriverReconciliation({
    ledger: bosteyoLedger,
    settledTrips: [{ trip_id: "010", driver_net_pence: 408 }],
    completedPayoutItems: [],
    walletEvidenceAvailable: true,
    settlementEvidenceAvailable: true,
    identityMappingValid: true,
    accountVerified: true,
    payout_provider: "revolut",
    finance_cleared_pence: 408,
    provider_account_balance_pence: 853,
    provider_account_balance_status: "AVAILABLE",
  });
  assertEquals(row.current_wallet_balance_pence, 408);
  assertEquals(row.provider_account_balance_pence, 853);
  assertEquals(row.provider_balance_is_reference_only, true);
  assertEquals(row.wallet_variance_pence, 0);
});

Deno.test("5. A wallet shortfall of 1p produces DRIVER_WALLET_MISMATCH", () => {
  const row = computeFrDriverReconciliation({
    ledger: [{ type: "TRIP_EARNING_NET", amount_pence: 407 }],
    settledTrips: [{ trip_id: "010", driver_net_pence: 408 }],
    completedPayoutItems: [],
    walletEvidenceAvailable: true,
    settlementEvidenceAvailable: true,
    identityMappingValid: true,
    accountVerified: true,
    finance_cleared_pence: 407,
    provider_account_balance_pence: 0,
    provider_account_balance_status: "AVAILABLE",
  });
  assertEquals(row.wallet_variance_pence, -1);
  assertEquals(row.reconciliation_status, "DRIVER_WALLET_MISMATCH");
});

Deno.test("6. One driver mismatch cannot be offset by another driver", () => {
  const short = computeFrDriverReconciliation({
    ledger: [{ type: "TRIP_EARNING_NET", amount_pence: 400 }],
    settledTrips: [{ trip_id: "a", driver_net_pence: 408 }],
    completedPayoutItems: [],
    walletEvidenceAvailable: true,
    settlementEvidenceAvailable: true,
    identityMappingValid: true,
    accountVerified: true,
    finance_cleared_pence: 400,
    provider_account_balance_pence: 0,
    provider_account_balance_status: "AVAILABLE",
  });
  const surplus = computeFrDriverReconciliation({
    ledger: [{ type: "TRIP_EARNING_NET", amount_pence: 416 }],
    settledTrips: [{ trip_id: "b", driver_net_pence: 408 }],
    completedPayoutItems: [],
    walletEvidenceAvailable: true,
    settlementEvidenceAvailable: true,
    identityMappingValid: true,
    accountVerified: true,
    finance_cleared_pence: 416,
    provider_account_balance_pence: 0,
    provider_account_balance_status: "AVAILABLE",
  });
  assertEquals(short.reconciliation_status, "DRIVER_WALLET_MISMATCH");
  assertEquals(surplus.reconciliation_status, "DRIVER_WALLET_MISMATCH");
  const overview = aggregateFrDriverAuditOverview([short, surplus], {
    settlementIdentityBalanced: true,
  });
  assertEquals(overview.driver_wallet_mismatches_count, 2);
  assertEquals(overview.drivers_balanced_count, 0);
  assertEquals(overview.overview_driver_audit_status, "DRIVER_AUDIT_MISMATCH");
});

Deno.test("7. Missing required wallet evidence cannot produce BALANCED", () => {
  const row = computeFrDriverReconciliation({
    ledger: [],
    settledTrips: [{ trip_id: "010", driver_net_pence: 408 }],
    completedPayoutItems: [],
    walletEvidenceAvailable: false,
    settlementEvidenceAvailable: true,
    identityMappingValid: true,
    accountVerified: true,
    finance_cleared_pence: 0,
    provider_account_balance_pence: 0,
    provider_account_balance_status: "AVAILABLE",
  });
  assertEquals(row.reconciliation_status, "MISSING_WALLET_EVIDENCE");
});

Deno.test("8. Provider balance unavailable does not produce a fake zero", () => {
  const row = computeFrDriverReconciliation({
    ledger: bosteyoLedger,
    settledTrips: [{ trip_id: "010", driver_net_pence: 408 }],
    completedPayoutItems: [],
    walletEvidenceAvailable: true,
    settlementEvidenceAvailable: true,
    identityMappingValid: true,
    accountVerified: true,
    finance_cleared_pence: 408,
    provider_account_balance_pence: null,
    provider_account_balance_status: "UNAVAILABLE",
  });
  assertEquals(row.provider_account_balance_pence, null);
  assertEquals(row.provider_account_balance_pence === 0, false);
});

Deno.test("9. Overview reports driver mismatch counts separately from trip settlement identity", () => {
  const balanced = computeFrDriverReconciliation({
    ledger: ahmedLedger,
    settledTrips: [
      { trip_id: "007", driver_net_pence: 408 },
      { trip_id: "008", driver_net_pence: 593 },
    ],
    completedPayoutItems: [],
    walletEvidenceAvailable: true,
    settlementEvidenceAvailable: true,
    identityMappingValid: true,
    accountVerified: true,
    finance_cleared_pence: 1001,
    provider_account_balance_pence: 0,
    provider_account_balance_status: "AVAILABLE",
  });
  const mismatch = computeFrDriverReconciliation({
    ledger: [{ type: "TRIP_EARNING_NET", amount_pence: 400 }],
    settledTrips: [{ trip_id: "010", driver_net_pence: 408 }],
    completedPayoutItems: [],
    walletEvidenceAvailable: true,
    settlementEvidenceAvailable: true,
    identityMappingValid: true,
    accountVerified: true,
    finance_cleared_pence: 400,
    provider_account_balance_pence: 0,
    provider_account_balance_status: "AVAILABLE",
  });
  const overview = aggregateFrDriverAuditOverview([balanced, mismatch], {
    settlementIdentityBalanced: true,
  });
  assertEquals(overview.drivers_balanced_count, 1);
  assertEquals(overview.driver_wallet_mismatches_count, 1);
  assertEquals(overview.overview_driver_audit_status, "DRIVER_AUDIT_MISMATCH");
});

Deno.test("10. Revolut payout mode does not depend on Stripe Connect balance", () => {
  const row = computeFrDriverReconciliation({
    ledger: bosteyoLedger,
    settledTrips: [{ trip_id: "010", driver_net_pence: 408 }],
    completedPayoutItems: [],
    walletEvidenceAvailable: true,
    settlementEvidenceAvailable: true,
    identityMappingValid: true,
    accountVerified: true,
    payout_provider: "revolut",
    finance_cleared_pence: 408,
    provider_account_balance_pence: null,
    provider_account_balance_status: "UNAVAILABLE",
  });
  assertEquals(row.available_for_payout_pence, 408);
  assertEquals(row.reconciliation_status, "BALANCED");
  assertEquals(row.current_wallet_balance_pence, 408);
});

Deno.test("12. Provider Account Balance remains reference-only", () => {
  const row = computeFrDriverReconciliation({
    ledger: bosteyoLedger,
    settledTrips: [{ trip_id: "010", driver_net_pence: 408 }],
    completedPayoutItems: [],
    walletEvidenceAvailable: true,
    settlementEvidenceAvailable: true,
    identityMappingValid: true,
    accountVerified: true,
    payout_provider: "revolut",
    finance_cleared_pence: 408,
    provider_account_balance_pence: 853,
    provider_account_balance_status: "AVAILABLE",
  });
  assertEquals(row.provider_balance_is_reference_only, true);
  assertEquals(row.provider_account_balance_pence !== row.current_wallet_balance_pence, true);
});
