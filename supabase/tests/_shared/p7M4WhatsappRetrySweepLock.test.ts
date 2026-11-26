/**
 * P7 M4 — WhatsApp durable replay without Meta: send-failure actions are failures, a 2-minute
 * cron sweep replays via the claim RPC, exhaustion leaves a durable alert.
 * If these fail, fix the code — never delete or soften the lock.
 */
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isInboundSendFailureAction,
  recordInboundFailure,
  WHATSAPP_INBOUND_MAX_ATTEMPTS,
  WHATSAPP_INBOUND_RETRY_EXHAUSTED_EVENT,
} from "../../functions/_shared/whatsappInboundDurability.ts";
import { rebuildInboundMessage, runWhatsAppInboundRetrySweep } from "../../functions/whatsapp-inbound-retry-sweep/lib/sweepCore.ts";

const read = (rel: string) => Deno.readTextFile(new URL(rel, import.meta.url));
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const webhook = await read("../../functions/whatsapp-webhook/index.ts");
const workflow = await read("../../functions/_shared/whatsappWorkflow.ts");
const sweepIndex = await read("../../functions/whatsapp-inbound-retry-sweep/index.ts");
const sweepCore = await read("../../functions/whatsapp-inbound-retry-sweep/lib/sweepCore.ts");
const mig = await read("../../migrations/20270303091000_p7_m4_whatsapp_inbound_retry_sweep_cron.sql");
const config = await read("../../config.toml");

Deno.test("send-failure classifier covers every *_send_failed action the workflow can return", () => {
  const returned = [...workflow.matchAll(/return\s+"([a-z_]+_send_failed)"/g)].map((m) => m[1]);
  assert(returned.length >= 6, "workflow still returns send-failure actions");
  for (const a of returned) assertEquals(isInboundSendFailureAction(a), true, a);
  assertEquals(isInboundSendFailureAction("welcome_sent:book_link_send_failed"), true);
  assertEquals(isInboundSendFailureAction("outbound_unconfigured"), true);
  for (const ok of ["welcome_sent", "welcome_sent:book_link_sent", "book_link_sent", "", null, undefined]) {
    assertEquals(isInboundSendFailureAction(ok as string), false);
  }
});

Deno.test("webhook: returned send-failure action records failure and skips markInboundProcessed", () => {
  assertStringIncludes(webhook, "isInboundSendFailureAction(action)");
  const start = webhook.indexOf("if (isInboundSendFailureAction(action))");
  const end = webhook.indexOf("continue;", start);
  const block = webhook.slice(start, end);
  assertStringIncludes(block, "recordInboundFailure(");
  assert(!block.includes("markInboundProcessed("));
  assertStringIncludes(block, "retryableFailures++");
  const mark = webhook.indexOf("await markInboundProcessed(");
  assert(start > 0 && end > start && mark > end, "mark follows the send-failure branch's continue");
});

Deno.test("sweep: service-role/cron auth, claim RPC CAS, shared outcome handling, never marks on failure", () => {
  assertStringIncludes(sweepIndex, "assertCronOrServiceRoleAuth(");
  const core = strip(sweepCore);
  assertStringIncludes(core, "WHATSAPP_INBOUND_CLAIM_RPC");
  assertStringIncludes(core, '.is("processed_at", null)');
  assertStringIncludes(core, ".lt(\"attempt_count\", WHATSAPP_INBOUND_MAX_ATTEMPTS)");
  assertStringIncludes(core, "WHATSAPP_INBOUND_SWEEP_MIN_AGE_SECONDS");
  assertStringIncludes(core, "isInboundSendFailureAction(action)");
  assertStringIncludes(core, "processWhatsAppInboundMessage");
  const claim = core.indexOf("args.client.rpc(WHATSAPP_INBOUND_CLAIM_RPC");
  const proc = core.indexOf("await process(args.client, message)");
  const mark = core.indexOf("await markInboundProcessed(");
  assert(claim > 0 && proc > claim && mark > proc, "claim → process → mark");
  assertEquals((core.match(/await markInboundProcessed\(/g) ?? []).length, 1);
  assert(!/processed_at\s*:/.test(core), "sweep never writes processed_at itself");
  assertStringIncludes(config, "[functions.whatsapp-inbound-retry-sweep]");
});

Deno.test("migration: cron every 2 min → Edge whatsapp-inbound-retry-sweep, vault bearer, idempotent", () => {
  assertStringIncludes(mig, "'whatsapp-inbound-retry-sweep'");
  assertStringIncludes(mig, "'*/2 * * * *'");
  assertStringIncludes(mig, "functions/v1/whatsapp-inbound-retry-sweep");
  assertStringIncludes(mig, "net.http_post(");
  assertStringIncludes(mig, "vault.decrypted_secrets");
  assertStringIncludes(mig, "name = 'service_role_key'");
  assertStringIncludes(mig, "FROM cron.job WHERE jobname = 'whatsapp-inbound-retry-sweep'");
  assertStringIncludes(mig, "to_regnamespace('cron') IS NULL");
  assertEquals((mig.match(/cron\.schedule\(/g) ?? []).length, 1);
  assert(!/cron\.unschedule/i.test(mig) && !/alter_job\([^)]*command/i.test(mig));
  assert(!/UPDATE public\.whatsapp_inbound_messages/i.test(mig), "migration never reopens/edits rows");
});

// ── Behaviour ──────────────────────────────────────────────────────────────
const valueBlock = (id: string) => ({
  messaging_product: "whatsapp",
  metadata: { phone_number_id: "pn1" },
  contacts: [{ wa_id: "447700900000", profile: { name: "A" } }],
  messages: [{ id, from: "447700900000", type: "text", timestamp: "1", text: { body: "Hi" } }],
});

type Row = Record<string, unknown>;
function fakeDb(rows: Row[]) {
  const events: Row[] = [];
  const updates: Array<{ id: string; patch: Row }> = [];
  const claims: string[] = [];
  const client = {
    from(table: string) {
      const q = { table, kind: "select", filters: [] as Array<[string, string, unknown]>, patch: undefined as Row | undefined };
      const b: Record<string, unknown> = {};
      const f = (op: string) => (k: string, v: unknown) => { q.filters.push([op, k, v]); return b; };
      b.select = () => b;
      b.is = f("is"); b.lt = f("lt"); b.gt = f("gt"); b.gte = f("gte"); b.eq = f("eq");
      b.order = () => b; b.limit = () => b;
      b.update = (p: Row) => { q.kind = "update"; q.patch = p; return b; };
      b.insert = (p: Row) => { if (table === "payment_financial_events") events.push(p); return Promise.resolve({ error: null }); };
      b.maybeSingle = () => {
        if (table !== "payment_financial_events") return Promise.resolve({ data: null });
        const key = q.filters.find((x) => x[1] === "execution_id")?.[2];
        return Promise.resolve({ data: events.find((e) => e.execution_id === key) ? { id: 1 } : null });
      };
      const run = () => {
        if (q.kind === "update") {
          const id = String(q.filters.find((x) => x[1] === "meta_message_id")?.[2]);
          const row = rows.find((r) => r.meta_message_id === id);
          // honour `.is(processed_at, null)` CAS
          if (row && row.processed_at == null) { Object.assign(row, q.patch); updates.push({ id, patch: q.patch! }); }
          return { data: null, error: null };
        }
        const isExhaustedScan = q.filters.some((x) => x[0] === "gte" && x[1] === "attempt_count");
        const data = rows.filter((r) => r.processed_at == null && (isExhaustedScan
          ? Number(r.attempt_count) >= WHATSAPP_INBOUND_MAX_ATTEMPTS
          : Number(r.attempt_count) < WHATSAPP_INBOUND_MAX_ATTEMPTS));
        return { data, error: null };
      };
      // deno-lint-ignore no-explicit-any
      b.then = (res: any) => res(run());
      return b;
    },
    rpc(name: string, a: { p_meta_message_id: string }) {
      assertEquals(name, "claim_whatsapp_inbound_retry");
      claims.push(a.p_meta_message_id);
      const row = rows.find((r) => r.meta_message_id === a.p_meta_message_id)!;
      if (row.processed_at != null || Number(row.attempt_count) >= WHATSAPP_INBOUND_MAX_ATTEMPTS || row.processing_started_at) {
        return Promise.resolve({ data: [], error: null });
      }
      row.attempt_count = Number(row.attempt_count) + 1;
      row.processing_started_at = "now";
      return Promise.resolve({ data: [{ attempt_count: row.attempt_count }], error: null });
    },
  };
  return { client, events, updates, claims };
}
const mkRow = (id: string, attempts: number, extra: Row = {}): Row => ({
  meta_message_id: id, message_type: "text", raw_payload: valueBlock(id), attempt_count: attempts,
  last_error: "send_failed:welcome_send_failed", processed_at: null, processing_started_at: null, ...extra,
});

Deno.test("rebuild: stored value block yields the exact inbound message", () => {
  const m = rebuildInboundMessage(mkRow("wamid.A", 1) as never);
  assert(m);
  assertEquals(m.metaMessageId, "wamid.A");
  assertEquals(m.waId, "447700900000");
  assertEquals(m.textBody, "Hi");
});

Deno.test("sweep: replays unprocessed row, marks processed ONLY on a successful workflow", async () => {
  const rows = [mkRow("wamid.OK", 1)];
  const db = fakeDb(rows);
  const s = await runWhatsAppInboundRetrySweep({ client: db.client, deps: { processMessage: () => Promise.resolve("welcome_sent") } });
  assertEquals(db.claims, ["wamid.OK"]);
  assertEquals(s.succeeded, 1);
  assertEquals(rows[0].attempt_count, 2);
  assert(rows[0].processed_at, "processed after success");
});

Deno.test("sweep: send-failure action (returned, not thrown) is a failure — never processed", async () => {
  const rows = [mkRow("wamid.SF", 0, { last_error: null })];
  const db = fakeDb(rows);
  const s = await runWhatsAppInboundRetrySweep({ client: db.client, deps: { processMessage: () => Promise.resolve("welcome_send_failed") } });
  assertEquals(s.failed, 1);
  assertEquals(s.succeeded, 0);
  assertEquals(rows[0].processed_at ?? null, null);
  assertEquals(rows[0].last_error, "send_failed:welcome_send_failed");
  assertEquals(rows[0].workflow_action, "workflow_error_retryable");
  assertEquals(rows[0].processing_started_at, null, "claim released for the next sweep");
  assertEquals(db.events.length, 0, "not exhausted yet → no alert");
});

Deno.test("sweep: thrown error is a failure; final attempt records a durable exhausted alert (once)", async () => {
  const rows = [mkRow("wamid.EX", WHATSAPP_INBOUND_MAX_ATTEMPTS - 1)];
  const db = fakeDb(rows);
  const s = await runWhatsAppInboundRetrySweep({ client: db.client, deps: { processMessage: () => Promise.reject(new Error("graph 500")) } });
  assertEquals(s.failed, 1);
  assertEquals(rows[0].processed_at ?? null, null);
  assertEquals(rows[0].workflow_action, "workflow_error_exhausted");
  assertEquals(db.events.length, 1);
  assertEquals(db.events[0].event_type, WHATSAPP_INBOUND_RETRY_EXHAUSTED_EVENT);
  const d = db.events[0].detail as Record<string, unknown>;
  assertEquals(d.meta_message_id, "wamid.EX");
  assertEquals(d.attempt_count, WHATSAPP_INBOUND_MAX_ATTEMPTS);
  assertEquals(d.customer_reply_sent, false);
  assert(!JSON.stringify(db.events[0]).includes("447700900000"), "no phone number in the alert");
  // second sweep: row is exhausted → not replayed, alert not duplicated
  const s2 = await runWhatsAppInboundRetrySweep({ client: db.client, deps: { processMessage: () => Promise.reject(new Error("must not run")) } });
  assertEquals(s2.claimed, 0);
  assertEquals(db.events.length, 1, "alert is idempotent per message");
});

Deno.test("sweep: already-exhausted row without an alert (worker crashed on last attempt) still gets one", async () => {
  const rows = [mkRow("wamid.CRASH", WHATSAPP_INBOUND_MAX_ATTEMPTS, { processing_started_at: "stale" })];
  const db = fakeDb(rows);
  const s = await runWhatsAppInboundRetrySweep({ client: db.client, deps: { processMessage: () => Promise.reject(new Error("must not run")) } });
  assertEquals(s.claimed, 0);
  assertEquals(s.exhausted_alerts, 1);
  assertEquals(db.events.length, 1);
});

Deno.test("sweep: lost claim race (CAS returns nothing) → no processing", async () => {
  const rows = [mkRow("wamid.BUSY", 1, { processing_started_at: "live-worker" })];
  const db = fakeDb(rows);
  const s = await runWhatsAppInboundRetrySweep({ client: db.client, deps: { processMessage: () => Promise.reject(new Error("must not run")) } });
  assertEquals(s.skipped_unclaimed, 1);
  assertEquals(s.claimed, 0);
});

Deno.test("sweep: dry_run claims and processes nothing", async () => {
  const rows = [mkRow("wamid.DRY", 1)];
  const db = fakeDb(rows);
  const s = await runWhatsAppInboundRetrySweep({ client: db.client, dryRun: true, deps: { processMessage: () => Promise.reject(new Error("must not run")) } });
  assertEquals(s.scanned, 1);
  assertEquals(db.claims.length, 0);
  assertEquals(rows[0].attempt_count, 1);
});

Deno.test("recordInboundFailure: non-final attempt writes no alert; final attempt does", async () => {
  const rows = [mkRow("wamid.R", 1)];
  const db = fakeDb(rows);
  await recordInboundFailure(db.client, "wamid.R", 1, new Error("x"));
  assertEquals(db.events.length, 0);
  await recordInboundFailure(db.client, "wamid.R", WHATSAPP_INBOUND_MAX_ATTEMPTS, new Error("x"), { source: "whatsapp-webhook" });
  assertEquals(db.events.length, 1);
});
