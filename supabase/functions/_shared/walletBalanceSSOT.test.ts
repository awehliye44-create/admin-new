import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  sumLedgerWalletBalanceByDriver,
  sumLedgerWalletBalancePence,
} from "./walletBalanceSSOT.ts";

Deno.test("excludes COMMISSION_RECOVERED from wallet balance SSOT", () => {
  const rows = [
    { type: "TRIP_EARNING_NET", amount_pence: 436 },
    { type: "DEBT_RECOVERY", amount_pence: -414 },
    { type: "COMMISSION_RECOVERED", amount_pence: 414 },
    { type: "PLATFORM_COMMISSION", amount_pence: 77 },
    { type: "CASH_TRIP_EARNING", amount_pence: 840 },
  ];
  assertEquals(sumLedgerWalletBalancePence(rows), 22);
});

Deno.test("Ahmed Osman class: net 437p excludes commission recovered mirror", () => {
  const rows = [
    { driver_id: "ahmed", type: "TRIP_EARNING_NET", amount_pence: 2129 },
    { driver_id: "ahmed", type: "CASH_COMMISSION_DEBT", amount_pence: -846 },
    { driver_id: "ahmed", type: "DEBT_RECOVERY", amount_pence: -846 },
    { driver_id: "ahmed", type: "COMMISSION_RECOVERED", amount_pence: 846 },
  ];
  const byDriver = sumLedgerWalletBalanceByDriver(rows);
  assertEquals(byDriver.get("ahmed"), 437);
});

Deno.test("groups wallet balance by driver", () => {
  const byDriver = sumLedgerWalletBalanceByDriver([
    { driver_id: "a", type: "TRIP_EARNING_NET", amount_pence: 100 },
    { driver_id: "b", type: "TRIP_EARNING_NET", amount_pence: 200 },
    { driver_id: "a", type: "COMMISSION_RECOVERED", amount_pence: 50 },
  ]);
  assertEquals(byDriver.get("a"), 100);
  assertEquals(byDriver.get("b"), 200);
});
