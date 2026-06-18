import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  sumLedgerWalletBalanceByDriver,
  sumLedgerWalletBalancePence,
  WALLET_BALANCE_EXCLUDED_LEDGER_TYPES,
} from "./walletBalanceSSOT.ts";
import { computeLedgerWalletBalancePence } from "./onecabFinanceLedger.ts";

Deno.test("wallet SSOT excludes only PLATFORM_COMMISSION and CASH_TRIP_EARNING", () => {
  assertEquals([...WALLET_BALANCE_EXCLUDED_LEDGER_TYPES].sort(), [
    "CASH_TRIP_EARNING",
    "PLATFORM_COMMISSION",
  ]);
});

Deno.test("includes COMMISSION_RECOVERED in wallet balance SSOT", () => {
  const rows = [
    { type: "TRIP_EARNING_NET", amount_pence: 436 },
    { type: "DEBT_RECOVERY", amount_pence: -414 },
    { type: "COMMISSION_RECOVERED", amount_pence: 414 },
    { type: "PLATFORM_COMMISSION", amount_pence: 77 },
    { type: "CASH_TRIP_EARNING", amount_pence: 840 },
  ];
  assertEquals(sumLedgerWalletBalancePence(rows), 436);
  assertEquals(computeLedgerWalletBalancePence(rows), 436);
});

Deno.test("MK0002 class: COMMISSION_RECOVERED offsets DEBT_RECOVERY in wallet", () => {
  const rows = [
    { driver_id: "mk0002", type: "TRIP_EARNING_NET", amount_pence: 4609 },
    { driver_id: "mk0002", type: "DEBT_RECOVERY", amount_pence: -2708 },
    { driver_id: "mk0002", type: "COMMISSION_RECOVERED", amount_pence: 2708 },
  ];
  const byDriver = sumLedgerWalletBalanceByDriver(rows);
  assertEquals(byDriver.get("mk0002"), 4609);
});

Deno.test("groups wallet balance by driver", () => {
  const byDriver = sumLedgerWalletBalanceByDriver([
    { driver_id: "a", type: "TRIP_EARNING_NET", amount_pence: 100 },
    { driver_id: "b", type: "TRIP_EARNING_NET", amount_pence: 200 },
    { driver_id: "a", type: "COMMISSION_RECOVERED", amount_pence: 50 },
  ]);
  assertEquals(byDriver.get("a"), 150);
  assertEquals(byDriver.get("b"), 200);
});
