/**
 * admin-driver-invoice: generate/send write invoices; aggregation is consume-only.
 * TEN period filter must use SQL economic_earned_at and never created_at fallback.
 *
 * Run: deno test --allow-read --no-check supabase/functions/_shared/adminDriverInvoiceLock.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { assertFalse } from "https://deno.land/std@0.224.0/assert/assert_false.ts";
import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/assert_string_includes.ts";
import { isInstantInClosedRange } from "./economicEarnedAtSSOT.ts";

Deno.test("admin-driver-invoice handler actions: preview is sample/stored HTML; generate/send are writes", async () => {
  const src = await Deno.readTextFile(
    new URL("../admin-driver-invoice/index.ts", import.meta.url),
  );
  assertStringIncludes(src, '"generate"');
  assertStringIncludes(src, '"preview"');
  assertStringIncludes(src, '"send_email"');
  assertStringIncludes(src, "handleDriverInvoiceAction");
  assertStringIncludes(src, "previewDriverInvoiceHtml");
  assertEquals(src.includes("action === \"preview\""), true);
  assertFalse(src.includes(".from(\"payment_sessions\")"));
  assertFalse(src.includes("creditCapturedCardTripLedger"));
  assertFalse(src.includes("capturedTripWalletRecovery"));
});

Deno.test("invoice aggregation consumes SQL economic clocks; TEN never falls back to created_at", async () => {
  const src = await Deno.readTextFile(
    new URL("./driverInvoiceAggregation.ts", import.meta.url),
  );
  assertStringIncludes(src, "loadDriverWalletEconomicFields");
  assertStringIncludes(src, "mergeBackendEconomicFields");
  assertStringIncludes(src, "isInstantInClosedRange(row.economic_earned_at");
  assertStringIncludes(src, "isInstantInClosedRange(row.created_at");
  assertFalse(src.includes(".from(\"payment_sessions\")"));
  assertFalse(src.includes(".insert("));
  assertFalse(src.includes(".update("));
  assertFalse(src.includes("creditCapturedCardTripLedger"));
  assertFalse(src.includes("api.revolut"));
  assertEquals(src.includes('gte("created_at", params.periodStart)'), false);
});

Deno.test("invoice TEN period filter: current 637/1275; simulated 17 Aug 1768 excluding MK-008", () => {
  const MK005 = {
    type: "TRIP_EARNING_NET",
    amount_pence: 637,
    economic_earned_at: "2026-08-17T08:42:50.690Z",
    created_at: "2026-08-17T11:44:02.234Z",
  };
  const MK007 = {
    type: "TRIP_EARNING_NET",
    amount_pence: 425,
    economic_earned_at: "2026-08-17T18:50:46.198Z",
    created_at: "2026-08-18T15:00:00.000Z",
  };
  const MK009 = {
    type: "TRIP_EARNING_NET",
    amount_pence: 706,
    economic_earned_at: "2026-08-17T19:27:16.212Z",
    created_at: "2026-08-18T15:00:01.000Z",
  };
  const MK008 = {
    type: "TRIP_EARNING_NET",
    amount_pence: 0,
    economic_earned_at: null,
    created_at: "2026-08-17T18:51:51.960Z",
  };
  const MK002 = {
    type: "TRIP_EARNING_NET",
    amount_pence: 425,
    economic_earned_at: "2026-08-18T10:52:08.848Z",
    created_at: "2026-08-18T15:24:15.863Z",
  };
  const MK003 = {
    type: "TRIP_EARNING_NET",
    amount_pence: 425,
    economic_earned_at: "2026-08-18T13:35:47.011Z",
    created_at: "2026-08-18T15:24:16.628Z",
  };
  const MK004 = {
    type: "TRIP_EARNING_NET",
    amount_pence: 425,
    economic_earned_at: "2026-08-18T14:24:23.478Z",
    created_at: "2026-08-18T14:24:24.846Z",
  };
  const unresolved = {
    type: "TRIP_EARNING_NET",
    amount_pence: 100,
    economic_earned_at: null,
    created_at: "2026-08-17T12:00:00.000Z",
  };

  const inPeriod = (
    row: { type: string; economic_earned_at: string | null; created_at: string },
    start: string,
    end: string,
  ) => {
    if (row.type === "TRIP_EARNING_NET") {
      return isInstantInClosedRange(row.economic_earned_at, start, end);
    }
    return isInstantInClosedRange(row.created_at, start, end);
  };

  const start17 = "2026-08-16T23:00:00.000Z";
  const end17 = "2026-08-17T22:59:59.999Z";
  const start18 = "2026-08-17T23:00:00.000Z";
  const end18 = "2026-08-18T22:59:59.999Z";

  const current = [MK005, MK002, MK003, MK004, MK008, unresolved];
  const cur17 = current.filter((r) => inPeriod(r, start17, end17));
  const cur18 = current.filter((r) => inPeriod(r, start18, end18));
  assertEquals(cur17.reduce((s, r) => s + r.amount_pence, 0), 637);
  assertEquals(cur18.reduce((s, r) => s + r.amount_pence, 0), 1275);
  assertEquals(cur17.some((r) => r === MK008 || r === unresolved), false);

  const simulated = [MK005, MK007, MK009, MK008, MK002, MK003];
  const sim17 = simulated.filter((r) => inPeriod(r, start17, end17));
  assertEquals(sim17.reduce((s, r) => s + r.amount_pence, 0), 1768);
  assertEquals(sim17.includes(MK008), false);
});
