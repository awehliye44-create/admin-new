import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  FINANCE_RECONCILIATION_TRIP_TERMINAL_OR,
  resolveFinanceReconciliationAuditLimit,
} from "./financeReconciliationTripQuery.ts";

Deno.test("terminal filter matches Trip History SSOT", () => {
  assertEquals(
    FINANCE_RECONCILIATION_TRIP_TERMINAL_OR,
    "financial_outcome.in.(COMPLETED,NO_SHOW,LATE_PASSENGER_CANCELLATION),status.in.(completed,no_show)",
  );
});

Deno.test("full FR audit limit defaults to 10000 not 100", () => {
  assertEquals(resolveFinanceReconciliationAuditLimit(null, "full"), 10_000);
  assertEquals(resolveFinanceReconciliationAuditLimit("100", "full"), 100);
  assertEquals(resolveFinanceReconciliationAuditLimit(null, "summary"), 500);
});
