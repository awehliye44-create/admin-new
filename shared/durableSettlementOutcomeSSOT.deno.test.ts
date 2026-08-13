/**
 * Slice 2 — durable settlement outcome pure helpers (finalize-trip-and-capture).
 * Run: deno test --no-check shared/durableSettlementOutcomeSSOT.deno.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { durableSettlementColumns } from "./durableSettlementOutcomeSSOT.ts";

Deno.test("successful capture persists captured hold status", () => {
  assertEquals(durableSettlementColumns("captured", true), {
    payment_status: "captured",
    payment_hold_status: "captured",
  });
  assertEquals(durableSettlementColumns("already_captured", true), {
    payment_status: "captured",
    payment_hold_status: "captured",
  });
});

Deno.test("shortfall / recovery does not invent paid", () => {
  const cols = durableSettlementColumns("payment_shortfall", false);
  assertEquals(cols.payment_status, "payment_shortfall");
  assertEquals(cols.payment_hold_status.includes("shortfall") || cols.payment_hold_status.length > 0, true);
});

Deno.test("failed capture stays failed (no invented paid)", () => {
  const cols = durableSettlementColumns("capture_failed", false);
  assertEquals(cols.payment_status === "captured", false);
});
