/**
 * stop-workflow must boot: every named import must exist on the target module.
 * A missing export crashes the isolate → 503 BOOT_ERROR / Function failed to start.
 * Run: deno test --allow-read supabase/functions/_shared/stopWorkflowBootLock.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test("stop-workflow imports getDriverCommissionPct, not the removed getDriverCommission", async () => {
  const src = await Deno.readTextFile(
    new URL("../stop-workflow/index.ts", import.meta.url),
  );
  const commission = await Deno.readTextFile(
    new URL("./commission.ts", import.meta.url),
  );
  assertEquals(src.includes('from "../_shared/commission.ts"'), true);
  assertEquals(src.includes("getDriverCommissionPct"), true);
  assertEquals(src.includes("getDriverCommission(") || src.includes("{ getDriverCommission }"), false);
  assertEquals(commission.includes("export async function getDriverCommissionPct"), true);
  assertEquals(commission.includes("export async function getDriverCommission("), false);
});

Deno.test("stop-workflow statically imports capture helpers used on complete_trip", async () => {
  const src = await Deno.readTextFile(
    new URL("../stop-workflow/index.ts", import.meta.url),
  );
  const capture = await Deno.readTextFile(
    new URL("./digitalPaymentCapture.ts", import.meta.url),
  );
  const provider = await Deno.readTextFile(
    new URL("./tripPaymentProviderSSOT.ts", import.meta.url),
  );
  assertEquals(src.includes('from "../_shared/digitalPaymentCapture.ts"'), true);
  assertEquals(src.includes('from "../_shared/tripPaymentProviderSSOT.ts"'), true);
  assertEquals(src.includes("requiresProviderSettlement"), true);
  assertEquals(src.includes("isCardPaymentMethod"), true);
  assertEquals(src.includes("recordTripCaptureFailure"), true);
  assertEquals(src.includes("tripProviderOrderId"), true);
  assertEquals(src.includes('await import("../_shared/digitalPaymentCapture.ts")'), false);
  assertEquals(src.includes('await import("../_shared/tripPaymentProviderSSOT.ts")'), false);
  assertEquals(capture.includes("export function requiresProviderSettlement"), true);
  assertEquals(capture.includes("export function isCardPaymentMethod"), true);
  assertEquals(capture.includes("export async function recordTripCaptureFailure"), true);
  assertEquals(provider.includes("export function tripProviderOrderId"), true);
});

Deno.test("complete_trip settles from accepted snapshot via resolveTripTierPercent", async () => {
  const src = await Deno.readTextFile(
    new URL("../stop-workflow/index.ts", import.meta.url),
  );
  assertEquals(src.includes("resolveTripTierPercent"), true);
  assertEquals(src.includes("calculateTripSettlementFromTripRow"), true);
  assertEquals(src.includes("buildSettlementTripRow"), true);
  assertEquals(src.includes("driverNetBeforeTip + settlement.airport_charge_pence"), true);
});

Deno.test("complete_trip forces waiting into settlement stamp row", async () => {
  const src = await Deno.readTextFile(
    new URL("../stop-workflow/index.ts", import.meta.url),
  );
  assertEquals(src.includes("pickupWaitingChargePence: resolvedFare.arrival_waiting_charge_pence"), true);
  assertEquals(src.includes("stopWaitingChargePence: resolvedFare.stop_waiting_charge_pence"), true);
});

Deno.test("post-capture settlement persists stamp columns with wallet credit", async () => {
  const src = await Deno.readTextFile(
    new URL("./applyCanonicalSettlementAfterCapture.ts", import.meta.url),
  );
  assertEquals(src.includes("tripSettlementDbColumns"), true);
  assertEquals(src.includes("credit.settlement"), true);
});
