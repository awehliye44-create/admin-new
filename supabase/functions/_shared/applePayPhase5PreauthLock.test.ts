/**
 * Apple Pay Phase 5 — pre-write reads overlap.
 * Merchant, existing session, ledger, and quote revalidation reads start
 * together. The session order id still wins. The first payment write,
 * quote consume, provider order, order link, and auth event stay serial.
 */
import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const revolut = await Deno.readTextFile(
  new URL("./revolutPreauth.ts", import.meta.url),
);
const ingest = await Deno.readTextFile(
  new URL("../ingest-telemetry/index.ts", import.meta.url),
);

function fnBody(): string {
  return revolut.slice(revolut.indexOf("export async function createRevolutPreauthResponse"));
}

Deno.test("independent pre-write reads join before the first payment write", () => {
  const fn = fnBody();
  const joined = fn.indexOf("merchantP,\n    sessionP,\n    ledgerP,\n    quoteRevalidateP,");
  const pending = fn.indexOf("await upsertPaymentSessionPending");
  const consume = fn.indexOf("await consumeBookingPaymentQuoteViaRpc");
  const order = fn.indexOf("await postPreauthOrder");
  const link = fn.indexOf("providerOrderId: order.id");
  const authEvent = fn.indexOf("await recordPaymentAuthorizationEvent");
  if (!(joined >= 0 && pending > joined && consume > pending && order > consume && link > order && authEvent > link)) {
    throw new Error("reads must finish before pending session, consume, order, link, and auth event");
  }
  assertStringIncludes(fn, "loadPaymentSession");
  assertStringIncludes(fn, "payment_authorization_ledger");
  assertStringIncludes(fn, "resolveRevolutMerchantContext");
  assertStringIncludes(fn, "sumOpenReceivableOutstandingForCustomer");
  assertStringIncludes(fn, "validateBookingPaymentQuoteForPreauth");
});

Deno.test("existing session order id still gates ledger reuse", () => {
  const fn = fnBody();
  assertStringIncludes(fn, "existingOrderId = sessionOrderId || ledgerOrderId");
  const assign = fn.indexOf("existingOrderId = sessionOrderId || ledgerOrderId");
  const retrieve = fn.indexOf("retrieveRevolutOrder");
  const pending = fn.indexOf("await upsertPaymentSessionPending");
  if (!(assign >= 0 && retrieve > assign && pending > retrieve)) {
    throw new Error("session-or-ledger order id must be known before retrieve and before the pending insert");
  }
});

Deno.test("quote revalidation result is applied before consume and a failed read does not write", () => {
  const fn = fnBody();
  const failed = fn.indexOf('note: "quote_revalidate_failed"');
  const validate = fn.indexOf("validateBookingPaymentQuoteForPreauth");
  const pending = fn.indexOf("await upsertPaymentSessionPending");
  const consume = fn.indexOf("await consumeBookingPaymentQuoteViaRpc");
  if (!(failed >= 0 && failed < pending && validate > failed && validate < pending && consume > pending)) {
    throw new Error("quote revalidation must reject before the pending session and before consume");
  }
});

Deno.test("merchant configuration failure stays before any payment write", () => {
  const fn = fnBody();
  const gateway = fn.indexOf('code: "PAYMENT_GATEWAY_NOT_CONFIGURED"');
  const pending = fn.indexOf("await upsertPaymentSessionPending");
  if (!(gateway >= 0 && gateway < pending)) {
    throw new Error("merchant failure must return before the pending session insert");
  }
});

Deno.test("prewrite telemetry keeps individual spans and the group wall", () => {
  const fn = fnBody();
  assertStringIncludes(fn, "markDbLookupStart");
  assertStringIncludes(fn, "markPaymentSessionStart");
  assertStringIncludes(fn, "markLedgerStart");
  assertStringIncludes(fn, "edge_quote_revalidate_ms");
  assertStringIncludes(fn, "edge_prewrite_reads_wall_ms");
  assertStringIncludes(fn, "edge_prewrite_reads_critical_ms");
  assertStringIncludes(fn, 'edge_prewrite_reads_parallel", true');
  assertStringIncludes(ingest, "edge_prewrite_reads_wall_ms");
  assertStringIncludes(ingest, "edge_prewrite_reads_critical_ms");
  assertStringIncludes(ingest, "edge_prewrite_reads_parallel");
});
