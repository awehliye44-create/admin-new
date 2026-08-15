/**
 * Lock: Completed Trips UI must tolerate null / AMOUNTS_ON_FR match_status.
 * Phase 2 made amount match FR-owned. Older UI called status.includes(…) on null and crashed.
 * Edge emits AMOUNTS_ON_FR (never null) for wire compat; UI still null-guards.
 *
 * Run: deno test --allow-read --no-check shared/__tests__/paymentSessionsNullMatchStatusUiLock.deno.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isPaymentSessionsAmountsOnFrStatus } from "../paymentSessionsTripMatchSSOT.ts";

const COMPLETED_TRIPS_TABLE = new URL(
  "../../src/components/finance/PaymentSessionsCompletedTripsTable.tsx",
  import.meta.url,
);
const TRIP_COMPARE = new URL(
  "../../supabase/functions/_shared/adminPaymentSessionsTripCompareSSOT.ts",
  import.meta.url,
);

Deno.test("Completed Trips match badge null-guards before .includes", async () => {
  const src = await Deno.readTextFile(COMPLETED_TRIPS_TABLE);
  assertEquals(
    src.includes("if (!status || isPaymentSessionsAmountsOnFrStatus(status)) return 'outline'"),
    true,
  );
  assertEquals(src.includes("isPaymentSessionsAmountsOnFrStatus(row.match_status)"), true);
  const unsafe =
    /function matchBadgeVariant\(status: string\)[\s\S]*?status\.includes/;
  assertEquals(unsafe.test(src), false);
});

Deno.test("Trip compare emits AMOUNTS_ON_FR instead of null match_status", async () => {
  const src = await Deno.readTextFile(TRIP_COMPARE);
  assertEquals(src.includes('"AMOUNTS_ON_FR"'), true);
  assertEquals(src.includes(": null;\n\n    const otherPaymentComponentsPence"), false);
});

Deno.test("AMOUNTS_ON_FR helper treats null/empty/sentinel as FR-owned", () => {
  assertEquals(isPaymentSessionsAmountsOnFrStatus(null), true);
  assertEquals(isPaymentSessionsAmountsOnFrStatus("AMOUNTS_ON_FR"), true);
  assertEquals(isPaymentSessionsAmountsOnFrStatus("NO_PAYMENT_SESSION"), false);
});
