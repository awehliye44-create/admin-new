import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { nextWeeklyPayoutDateIso } from "./payoutScheduleSSOT.ts";

Deno.test("nextWeeklyPayoutDateIso respects weekly_payout_day from control centre", () => {
  // Fixed Wednesday 2026-07-08 in London → next Friday is 2026-07-10
  const now = new Date("2026-07-08T12:00:00Z");
  const friday = nextWeeklyPayoutDateIso({
    weeklyPayoutDay: "friday",
    timeZone: "Europe/London",
    now,
  });
  const monday = nextWeeklyPayoutDateIso({
    weeklyPayoutDay: "monday",
    timeZone: "Europe/London",
    now,
  });
  assertEquals(new Date(friday).getUTCDay() !== new Date(monday).getUTCDay(), true);
  // Friday local date should be later in the week than Monday's next occurrence from Wed
  assertEquals(new Date(friday).getTime() < new Date(monday).getTime(), true);
});
