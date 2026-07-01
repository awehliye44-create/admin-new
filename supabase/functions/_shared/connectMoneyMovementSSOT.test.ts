import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { connectBalanceMismatchMessage } from "./connectMoneyMovementSSOT.ts";

Deno.test("connectBalanceMismatchMessage: Stripe exceeds liability", () => {
  const msg = connectBalanceMismatchMessage(973, 6407);
  assertEquals(msg.includes("Stripe physical cash exceeds ONECAB liability"), true);
});

Deno.test("connectBalanceMismatchMessage: liability exceeds Stripe", () => {
  const msg = connectBalanceMismatchMessage(5000, 1000);
  assertEquals(msg.includes("ONECAB ledger liability exceeds Stripe Connect available"), true);
});
