import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isAutomaticPayoutSchedule } from "./connectPayoutLockdown.ts";

Deno.test("isAutomaticPayoutSchedule false for manual", () => {
  assertEquals(isAutomaticPayoutSchedule("manual"), false);
});

Deno.test("isAutomaticPayoutSchedule true for daily", () => {
  assertEquals(isAutomaticPayoutSchedule("daily"), true);
});

Deno.test("isAutomaticPayoutSchedule false for null", () => {
  assertEquals(isAutomaticPayoutSchedule(null), false);
});
