/**
 * Admin lock: Apple Pay Phase 1 Edge residual instrumentation + safety.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  createPreauthEdgeTiming,
  mergeIntervalWallMs,
} from "./preauthEdgeTimingSSOT.ts";

Deno.test("mergeIntervalWallMs merges overlapping intervals (parallel-aware)", () => {
  const wall = mergeIntervalWallMs([
    { start: 1000, end: 1500 },
    { start: 1200, end: 1800 },
    { start: 2000, end: 2100 },
  ]);
  assertEquals(wall, 900); // 800 merged + 100
});

Deno.test("preauthEdgeTiming exposes residual stages + unaccounted", async () => {
  const t = createPreauthEdgeTiming(1_000);
  t.markAuthStart();
  await new Promise((r) => setTimeout(r, 5));
  t.markAuthEnd();
  t.markEligibilityStart();
  t.markEligibilityEnd();
  t.markFareQuoteStart();
  await new Promise((r) => setTimeout(r, 5));
  t.markFareQuoteEnd();
  t.markCustomerLookupStart();
  t.markCustomerLookupEnd();
  t.markFinancialModelStart();
  t.markFinancialModelEnd();
  t.markGatewayStart();
  t.markGatewayEnd();
  t.markBufferStart();
  t.markCurrencyStart();
  await new Promise((r) => setTimeout(r, 5));
  t.markBufferEnd();
  t.markCurrencyEnd();
  t.markValidationStart();
  t.markValidationEnd();
  t.markDbLookupStart();
  t.markDbLookupEnd();
  t.markPaymentSessionStart();
  t.markPaymentSessionEnd();
  t.markReceivableStart();
  t.markReceivableEnd();
  t.markRevolutRequestStart();
  await new Promise((r) => setTimeout(r, 5));
  t.markRevolutRequestEnd();
  t.markPersistStart();
  t.markPersistEnd();
  const body = t.attachToBody({ success: true });
  if (typeof body.edge_total_ms !== "number" || body.edge_total_ms < 10) {
    throw new Error(`edge_total_ms missing/low: ${body.edge_total_ms}`);
  }
  if (typeof body.edge_accounted_wall_ms !== "number") {
    throw new Error("edge_accounted_wall_ms missing");
  }
  if (typeof body.edge_unaccounted_ms !== "number") {
    throw new Error("edge_unaccounted_ms missing");
  }
  if (body.edge_unaccounted_ms! > body.edge_total_ms) {
    throw new Error("unaccounted cannot exceed total");
  }
  if (typeof body.edge_fare_quote_ms !== "number") {
    throw new Error("edge_fare_quote_ms missing");
  }
});

Deno.test("create-preauth still requires opaque quote path + order before wallet", () => {
  const fnRoot = new URL("../", import.meta.url).pathname;
  const preauth = Deno.readTextFileSync(
    `${fnRoot}create-preauth-payment-intent/index.ts`,
  );
  const revolut = Deno.readTextFileSync(`${fnRoot}_shared/revolutPreauth.ts`);
  if (!preauth.includes("quoteFareServerSide")) {
    throw new Error("create-preauth must still validate fare via server quote");
  }
  if (!preauth.includes("createRevolutPreauthResponse")) {
    throw new Error("create-preauth must still create Revolut order");
  }
  // Customer dedupe must not put cache fields into Revolut metadata.
  if (preauth.includes("__cached_customer")) {
    throw new Error("must not leak customer cache into metadataExtra");
  }
  // Buffer+currency parallelization is allowed.
  if (!preauth.includes("Promise.all")) {
    throw new Error("expected buffer/currency Promise.all parallelization");
  }
  // onAuthorize must remain in native module only — Edge must not invent wallet authorize.
  if (revolut.includes("presentApplePay") || revolut.includes("onAuthorize")) {
    throw new Error("revolutPreauth must not present Apple Pay");
  }
});
