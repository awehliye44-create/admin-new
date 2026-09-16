import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  attachRunningNetOnecabBalanceNewestFirst,
  buildCommissionFeeBreakdownRow,
  computeOnecabCommissionAfterProviderFee,
  estimateProviderFeePence,
  summarizeCommissionFeeRows,
} from "./driverWalletCommissionFeeSSOT.ts";

Deno.test("gross − provider fee = net; fee is never ONECAB revenue", () => {
  const split = computeOnecabCommissionAfterProviderFee({
    grossCommissionPence: 102,
    providerFeePence: 20,
  });
  assertEquals(split.gross_onecab_commission_pence, 102);
  assertEquals(split.total_provider_fee_pence, 20);
  assertEquals(split.net_onecab_commission_pence, 82);
});

Deno.test("estimate provider fee from versioned config (1% + £0.20)", () => {
  const est = estimateProviderFeePence({
    commissionableFarePence: 680,
    percentageFeeBps: 100,
    fixedFeePence: 20,
  });
  assertEquals(est.percentage_fee_pence, 7);
  assertEquals(est.fixed_fee_pence, 20);
  assertEquals(est.total_fee_pence, 27);
});

Deno.test("MK-260708-008 style row: confirmed session fee reduces net", () => {
  const row = buildCommissionFeeBreakdownRow({
    trip: {
      trip_id: "t1",
      trip_code: "MK-260708-008",
      completed_at: "2026-07-08T12:00:00Z",
      payment_provider: "revolut",
      payment_method: "card",
      commissionable_fare_pence: 680,
      commission_rate_percent: 15,
      gross_commission_pence: 102,
    },
    session: {
      payment_session_id: "ps1",
      payment_provider: "revolut",
      payment_method: "card",
      provider_processing_fee_pence: 27,
      fee_status: "ACTUAL",
      provider_fee_version_snapshot: "REVOLUT_GB_V2",
      provider_transaction_id: "rev_tx_1",
    },
    feeConfig: {
      provider_name: "revolut",
      percentage_fee_bps: 100,
      fixed_fee_pence: 20,
      version: "REVOLUT_GB_V2",
    },
  });
  assertEquals(row.gross_onecab_commission_pence, 102);
  assertEquals(row.total_provider_fee_pence, 27);
  assertEquals(row.net_onecab_commission_pence, 75);
  assertEquals(row.provider_fee_status, "CONFIRMED");
  assertEquals(row.fee_configuration_version, "REVOLUT_GB_V2");
});

Deno.test("cash: provider fee NOT_APPLICABLE", () => {
  const row = buildCommissionFeeBreakdownRow({
    trip: {
      trip_id: "t2",
      payment_method: "cash",
      commissionable_fare_pence: 1000,
      commission_rate_percent: 15,
      gross_commission_pence: 150,
    },
  });
  assertEquals(row.total_provider_fee_pence, 0);
  assertEquals(row.net_onecab_commission_pence, 150);
  assertEquals(row.provider_fee_status, "NOT_APPLICABLE");
});

Deno.test("summary + running net balance", () => {
  const rows = [
    buildCommissionFeeBreakdownRow({
      trip: {
        trip_id: "a",
        completed_at: "2026-07-09T10:00:00Z",
        gross_commission_pence: 100,
        payment_method: "card",
      },
      session: { provider_processing_fee_pence: 20, fee_status: "ACTUAL" },
    }),
    buildCommissionFeeBreakdownRow({
      trip: {
        trip_id: "b",
        completed_at: "2026-07-08T10:00:00Z",
        gross_commission_pence: 50,
        payment_method: "card",
      },
      session: { provider_processing_fee_pence: 10, fee_status: "ACTUAL" },
    }),
  ];
  const summary = summarizeCommissionFeeRows(rows);
  assertEquals(summary.gross_onecab_commission_pence, 150);
  assertEquals(summary.payment_provider_fees_pence, 30);
  assertEquals(summary.net_onecab_commission_pence, 120);
  const withBal = attachRunningNetOnecabBalanceNewestFirst(rows);
  assertEquals(withBal[0].running_net_onecab_balance_pence, 120);
  assertEquals(withBal[1].running_net_onecab_balance_pence, 40);
});
