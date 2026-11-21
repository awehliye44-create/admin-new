/**
 * #67A lock — fare Edges stamp Realtime negotiation view, defer notify via
 * scheduleReliableEdgeNotify, and emit Edge timing.
 *
 * Run: deno test --no-check --allow-read supabase/tests/_shared/negotiationPerf67aLock.test.ts
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const root = new URL("../../functions/", import.meta.url);

async function read(rel: string): Promise<string> {
  return await Deno.readTextFile(new URL(rel, root));
}

Deno.test("shared helpers exist", async () => {
  const notify = await read("_shared/scheduleReliableEdgeNotify.ts");
  assertStringIncludes(notify, "export function scheduleReliableEdgeNotify");
  assertStringIncludes(notify, "scheduleEdgeBackground");
  const stamp = await read("_shared/stampCustomerNegotiationView.ts");
  assertStringIncludes(stamp, "stampNegotiationViewFromOfferId");
  assertStringIncludes(stamp, "clearCustomerNegotiationViewOnTrip");
});

Deno.test("maps fare Edges into EDGE_FUNCTION_PERF_ACTION", async () => {
  const src = await read("_shared/performanceHealthControl.ts");
  assertStringIncludes(src, "'driver-fare-offer': 'edge_driver_fare_offer'");
  assertStringIncludes(src, "'customer-fare-decision': 'edge_customer_fare_decision'");
  assertStringIncludes(src, "'driver-fare-final': 'edge_driver_fare_final'");
});

Deno.test("driver-fare-offer stamps then defers push", async () => {
  const src = await read("driver-fare-offer/index.ts");
  assertStringIncludes(src, "scheduleReliableEdgeNotify");
  assertStringIncludes(src, "stampNegotiationViewFromOfferId");
  assertStringIncludes(src, "finishEdgeRequestLog");
  assertStringIncludes(src, "customer_new_fare_offer");
  const afterStamp = src.slice(src.indexOf("stampNegotiationViewFromOfferId"));
  assertStringIncludes(afterStamp, 'scheduleReliableEdgeNotify("driver-fare-offer-notify"');
  // Push fetch must live inside the deferred notify task, not before it.
  const notifyIdx = afterStamp.indexOf('scheduleReliableEdgeNotify("driver-fare-offer-notify"');
  const fetchIdx = afterStamp.indexOf("await fetch");
  assertEquals(fetchIdx > notifyIdx, true);
});

Deno.test("customer-fare-decision defers counter broadcast/push", async () => {
  const src = await read("customer-fare-decision/index.ts");
  assertStringIncludes(src, "scheduleReliableEdgeNotify");
  assertStringIncludes(src, "stampNegotiationViewFromOfferId");
  assertStringIncludes(src, "finishEdgeRequestLog");
  assertStringIncludes(src, "customer-fare-decision-counter-notify");
});

Deno.test("driver-fare-final clears view and defers notify", async () => {
  const src = await read("driver-fare-final/index.ts");
  assertStringIncludes(src, "clearCustomerNegotiationViewOnTrip");
  assertStringIncludes(src, "scheduleReliableEdgeNotify");
  assertStringIncludes(src, "finishEdgeRequestLog");
  assertStringIncludes(src, "Promise.all");
});

Deno.test("customer-fare-decision parallelises independent reads", async () => {
  const src = await read("customer-fare-decision/index.ts");
  assertStringIncludes(src, "Promise.all");
  assertStringIncludes(src, "from(\"customers\")");
});

Deno.test("expire-offers emits Edge timing", async () => {
  const src = await read("expire-offers/index.ts");
  assertStringIncludes(src, "finishEdgeRequestLog");
  assertStringIncludes(src, "startRequestTimer");
});

Deno.test("maps expire-offers into EDGE_FUNCTION_PERF_ACTION", async () => {
  const src = await read("_shared/performanceHealthControl.ts");
  assertStringIncludes(src, "'expire-offers': 'edge_expire_offers'");
});
