import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildFinanceBackendAuditV1,
  buildPayoutAuditRows,
  sumLedgerPayoutDebits,
} from "./financeBackendAuditV1.ts";

Deno.test("flags completed payout without ledger — wallet stays inflated", () => {
  const audit = buildFinanceBackendAuditV1({
    period: { from: "2026-01-01", to: "2026-06-09" },
    currencyCode: "gbp",
    trips: [{
      id: "trip-1",
      capture_amount_pence: 5000,
      refund_amount_pence: 0,
      driver_net_pence: 4208,
      commission_pence: 792,
      stripe_processing_fee_pence: 50,
      onecab_net_pence: 742,
      gross_fare_pence: 5000,
      final_fare_pence: 5000,
      commissionable_fare_pence: 4208,
      tip_pence: 0,
      tip_amount_pence: 0,
      payment_method: "card",
      stripe_settlement_verified: true,
      driver_tier_commission_percent: 15,
      commission_pct: 15,
      completed_at: "2026-06-01T12:00:00Z",
    }],
    ledgerRows: [{
      id: "earn-1",
      driver_id: "drv-1",
      type: "TRIP_EARNING_NET",
      amount_pence: 4208,
    }],
    payoutItems: [{
      id: "pay-1",
      driver_id: "drv-1",
      amount_pence: 4116,
      status: "completed",
      ledger_entry_id: null,
      created_at: "2026-06-02T10:00:00Z",
      completed_at: "2026-06-02T10:01:00Z",
      batch: { kind: "MANUAL_ADMIN" },
    }],
    earlyCashouts: [],
    walletByDriver: new Map([["drv-1", 4208]]),
    ledgerWalletSumByDriver: new Map([["drv-1", 4208]]),
    drivers: [{ id: "drv-1", first_name: "Test", last_name: "Driver" }],
    stripeAvailablePence: 10000,
    stripePendingPence: 0,
    stripePlatformPayoutsPence: 0,
    stripeBalanceError: null,
  });

  assertEquals(audit.paid_out.driver_paid_out_total_pence, 0);
  assertEquals(audit.remaining_money.driver_remaining_liability_pence, 4208);
  assertEquals(
    audit.critical_checks.find((c) => c.id === "successful_payout_creates_negative_ledger")?.passed,
    false,
  );
  assertEquals(audit.wallet_integrity[0]?.wallet_balance_pence, 4208);
  assertEquals(audit.wallet_integrity[0]?.completed_payouts_without_ledger_pence, 4116);
});

Deno.test("counts ledger payout debit", () => {
  const debits = sumLedgerPayoutDebits([
    { id: "l1", driver_id: "d", type: "PAYOUT", amount_pence: -4116 },
  ]);
  assertEquals(debits.total, 4116);

  const rows = buildPayoutAuditRows({
    payoutItems: [{
      id: "pi-1",
      driver_id: "d",
      amount_pence: 4116,
      status: "completed",
      ledger_entry_id: "l1",
      created_at: "2026-06-02",
      completed_at: "2026-06-02",
      batch: { kind: "MANUAL_ADMIN" },
    }],
    earlyCashouts: [],
    ledgerById: new Map([["l1", { id: "l1", driver_id: "d", type: "PAYOUT", amount_pence: -4116 }]]),
  });
  assertEquals(rows[0].ledger_entry_created, true);
  assertEquals(rows[0].ledger_amount_pence, -4116);
});

Deno.test("driver_available_now is min(liability, provider_available)", () => {
  const audit = buildFinanceBackendAuditV1({
    period: { from: "2026-01-01", to: "2026-06-09" },
    currencyCode: "gbp",
    trips: [{
      id: "t1",
      capture_amount_pence: 3000,
      driver_net_pence: 2500,
      commission_pence: 500,
      stripe_processing_fee_pence: 30,
      onecab_net_pence: 470,
      gross_fare_pence: 3000,
      final_fare_pence: 3000,
      commissionable_fare_pence: 2500,
      tip_pence: 0,
      tip_amount_pence: 0,
      payment_method: "card",
      stripe_settlement_verified: true,
      driver_tier_commission_percent: 15,
      commission_pct: 15,
      completed_at: "2026-06-01",
    }],
    ledgerRows: [],
    payoutItems: [],
    earlyCashouts: [],
    walletByDriver: new Map(),
    ledgerWalletSumByDriver: new Map(),
    drivers: [],
    stripeAvailablePence: 1000,
    stripePendingPence: 0,
    stripePlatformPayoutsPence: 0,
    stripeBalanceError: null,
  });

  assertEquals(audit.remaining_money.driver_remaining_liability_pence, 2500);
  assertEquals(audit.remaining_money.driver_available_now_pence, 1000);
  assertEquals(audit.remaining_money.driver_pending_settlement_pence, 1500);
});

Deno.test("mixed card+cash does not false MISMATCH on backend audit", () => {
  const audit = buildFinanceBackendAuditV1({
    period: { from: "2026-01-01", to: "2026-06-12" },
    currencyCode: "gbp",
    trips: [
      {
        id: "card-1",
        capture_amount_pence: 480,
        driver_net_pence: 408,
        commission_pence: 72,
        stripe_processing_fee_pence: 27,
        onecab_net_pence: 45,
        gross_fare_pence: 480,
        final_fare_pence: 480,
        commissionable_fare_pence: 480,
        tip_pence: 0,
        tip_amount_pence: 0,
        payment_method: "card",
        stripe_settlement_verified: true,
        driver_tier_commission_percent: 15,
        commission_pct: 15,
        completed_at: "2026-06-12",
      },
      {
        id: "cash-1",
        capture_amount_pence: 0,
        driver_net_pence: 714,
        commission_pence: 126,
        stripe_processing_fee_pence: 0,
        onecab_net_pence: 126,
        gross_fare_pence: 840,
        final_fare_pence: 840,
        commissionable_fare_pence: 840,
        tip_pence: 0,
        tip_amount_pence: 0,
        payment_method: "CASH",
        stripe_settlement_verified: false,
        driver_tier_commission_percent: 15,
        commission_pct: 15,
        completed_at: "2026-06-12",
      },
    ],
    ledgerRows: [{
      id: "earn-1",
      driver_id: "drv-1",
      type: "TRIP_EARNING_NET",
      amount_pence: 282,
    }, {
      id: "cash-comm",
      driver_id: "drv-1",
      type: "CASH_COMMISSION_DEBIT",
      amount_pence: -126,
    }],
    payoutItems: [],
    earlyCashouts: [],
    walletByDriver: new Map([["drv-1", 282]]),
    ledgerWalletSumByDriver: new Map([["drv-1", 282]]),
    drivers: [{ id: "drv-1", first_name: "asriya", last_name: "wahbiya" }],
    stripeAvailablePence: 1336,
    stripePendingPence: 564,
    stripePlatformPayoutsPence: 6176,
    stripeBalanceError: null,
  });

  assertEquals(audit.reconciliation.reconciliation_status, "BALANCED");
  assertEquals(audit.incoming_money.card_customer_revenue_pence, 480);
  assertEquals(audit.incoming_money.cash_collected_by_driver_pence, 840);
  assertEquals(audit.remaining_money.driver_remaining_liability_pence, 408);
});
