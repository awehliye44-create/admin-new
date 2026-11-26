/**
 * P6 M4 — WhatsApp durable inbound: failure never sets processed_at; duplicate
 * delivery re-claims an unprocessed row with a CAS; attempts are capped.
 * If these fail, fix the code — never delete or soften the lock.
 */
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildInboundFailurePatch,
  buildInboundSuccessPatch,
  isInboundAttemptsExhausted,
  truncateInboundError,
  WHATSAPP_INBOUND_FAILURE_ACTION_EXHAUSTED,
  WHATSAPP_INBOUND_FAILURE_ACTION_RETRYABLE,
  WHATSAPP_INBOUND_LAST_ERROR_MAX_CHARS,
  WHATSAPP_INBOUND_MAX_ATTEMPTS,
} from "../../functions/whatsapp-webhook/lib/inboundDurabilitySSOT.ts";

const read = (rel: string) => Deno.readTextFile(new URL(rel, import.meta.url));
const src = await read("../../functions/whatsapp-webhook/index.ts");
const mig = await read("../../migrations/20270302100000_whatsapp_inbound_durable_retry_p6_m4.sql");

Deno.test("failure patch never contains processed_at and releases the claim", () => {
  const p = buildInboundFailurePatch({ attemptCount: 1, error: new Error("graph 500") });
  assert(!("processed_at" in p));
  assertEquals(p.processing_started_at, null);
  assertEquals(p.last_error, "graph 500");
  assertEquals(p.workflow_action, WHATSAPP_INBOUND_FAILURE_ACTION_RETRYABLE);
});

Deno.test("cap: attempts >= max => exhausted action, still no processed_at", () => {
  assertEquals(isInboundAttemptsExhausted(WHATSAPP_INBOUND_MAX_ATTEMPTS - 1), false);
  assertEquals(isInboundAttemptsExhausted(WHATSAPP_INBOUND_MAX_ATTEMPTS), true);
  const p = buildInboundFailurePatch({ attemptCount: WHATSAPP_INBOUND_MAX_ATTEMPTS, error: "x" });
  assertEquals(p.workflow_action, WHATSAPP_INBOUND_FAILURE_ACTION_EXHAUSTED);
  assert(!("processed_at" in p));
});

Deno.test("only the success patch sets processed_at, and it clears error + claim", () => {
  const p = buildInboundSuccessPatch({ workflowAction: "welcome", nowIso: "2027-03-02T10:00:00.000Z" });
  assertEquals(p.processed_at, "2027-03-02T10:00:00.000Z");
  assertEquals(p.last_error, null);
  assertEquals(p.processing_started_at, null);
});

Deno.test("last_error is truncated", () => {
  assertEquals(truncateInboundError("x".repeat(5000)).length, WHATSAPP_INBOUND_LAST_ERROR_MAX_CHARS);
});

Deno.test("webhook: workflow failure path does not call markInboundProcessed", () => {
  const catchStart = src.indexOf("} catch (error) {\n      console.error(\"[whatsapp-webhook] workflow failed\"");
  assert(catchStart > 0, "workflow catch block present");
  const catchEnd = src.indexOf("continue;", catchStart);
  const block = src.slice(catchStart, catchEnd);
  assertStringIncludes(block, "recordInboundFailure(");
  assert(!block.includes("markInboundProcessed("), "failure must not mark processed");
  assert(!src.includes('"workflow_error"'), "legacy processed-on-failure marker is gone");
});

Deno.test("webhook: markInboundProcessed is only invoked after a successful workflow", () => {
  const calls = [...src.matchAll(/await markInboundProcessed\(/g)];
  assertEquals(calls.length, 1);
  const idx = calls[0].index!;
  // The failure branch `continue`s before reaching the success-only mark.
  const tryIdx = src.indexOf("action = await processWhatsAppInboundMessage");
  const contIdx = src.indexOf("continue;", src.indexOf("recordInboundFailure(client, message.metaMessageId"));
  assert(tryIdx > 0 && contIdx > tryIdx && idx > contIdx, "mark must follow the failure branch's continue");
  assertStringIncludes(src, '.is("processed_at", null)');
});

Deno.test("webhook: 23505 duplicate claims via CAS RPC, capped, otherwise skips", () => {
  assertStringIncludes(src, 'error.code === "23505"');
  assertStringIncludes(src, "WHATSAPP_INBOUND_CLAIM_RPC");
  assertStringIncludes(src, "p_max_attempts: WHATSAPP_INBOUND_MAX_ATTEMPTS");
  assertStringIncludes(src, "p_stale_after_seconds: WHATSAPP_INBOUND_STALE_CLAIM_SECONDS");
  assertStringIncludes(src, "if (attemptCount > 0)");
  // First delivery stamps attempt 1 + claim at insert time.
  assertStringIncludes(src, "attempt_count: 1");
  assertStringIncludes(src, "processing_started_at:");
});

Deno.test("webhook: retryable single-message failure returns non-2xx so Meta redelivers", () => {
  assertStringIncludes(src, "retryableFailures > 0");
  assertStringIncludes(src, 'json(500, { error: "workflow_failed_retryable" })');
  assertStringIncludes(src, "if (!isInboundAttemptsExhausted(attemptCount)) retryableFailures++");
});

Deno.test("migration: durable columns + atomic CAS claim, service_role only", () => {
  for (const col of ["attempt_count integer NOT NULL DEFAULT 0", "processing_started_at timestamptz", "last_error text"]) {
    assertStringIncludes(mig, col);
  }
  assertStringIncludes(mig, "claim_whatsapp_inbound_retry");
  assertStringIncludes(mig, "m.processed_at IS NULL");
  assertStringIncludes(mig, "m.attempt_count < GREATEST(1, p_max_attempts)");
  assertStringIncludes(mig, "m.processing_started_at IS NULL");
  assertStringIncludes(mig, "m.processing_started_at < now() - make_interval");
  assertStringIncludes(mig, "SECURITY DEFINER");
  assertStringIncludes(mig, "TO service_role");
  assert(!/GRANT[^;]*TO (anon|authenticated|PUBLIC)/i.test(mig));
  // Legacy rows (processed by the old failure-swallowing code) are not reopened.
  assert(!/UPDATE public\.whatsapp_inbound_messages\s+SET processed_at\s*=\s*NULL/i.test(mig));
});
