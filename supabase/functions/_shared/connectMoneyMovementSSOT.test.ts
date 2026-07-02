import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { connectBalanceMismatchMessage } from "./connectMoneyMovementSSOT.ts";
import { computeNetPayableAfterRecoveryPence } from "./tripSettlementFinanceSSOT.ts";

Deno.test("computeNetPayableAfterRecoveryPence: liability fully offset by recovery", () => {
  assertEquals(computeNetPayableAfterRecoveryPence(901, 901), 0);
  assertEquals(computeNetPayableAfterRecoveryPence(1000, 300), 700);
});

Deno.test("connectBalanceMismatchMessage: Stripe exceeds liability", () => {
  const msg = connectBalanceMismatchMessage(973, 6407);
  assertEquals(msg.includes("Stripe physical cash exceeds ONECAB liability"), true);
});

Deno.test("connectBalanceMismatchMessage: liability exceeds Stripe", () => {
  const msg = connectBalanceMismatchMessage(5000, 1000);
  assertEquals(msg.includes("ONECAB ledger liability exceeds Stripe Connect available"), true);
});
