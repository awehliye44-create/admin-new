/**
 * Certification: admin-register-revolut-webhook reconciles the EXISTING Revolut
 * webhook (PATCH url/events), never creates a second one while a webhook for the
 * ONECAB URL exists, never rotates the signing secret, and subscribes to the three
 * ORDER_INCREMENTAL_AUTHORISATION_* events. Revolut is stubbed at fetch.
 */
import { assert, assertEquals, assertStrictEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ensureOnecabRevolutWebhook,
  ONECAB_REVOLUT_WEBHOOK_EVENTS,
} from "../../functions/_shared/revolutWebhooks.ts";
import { stubFetch, type FetchCall } from "./support/inMemorySupabase.ts";

const URL_ONECAB = "https://project.example.supabase.co/functions/v1/revolut-webhook";
const WEBHOOK_ID = "123e4567-e89b-12d3-a456-426614174000";
const SIGNING_SECRET = "wsk_fixture_not_a_real_secret_000";
const INCREMENT_EVENTS = [
  "ORDER_INCREMENTAL_AUTHORISATION_AUTHORISED",
  "ORDER_INCREMENTAL_AUTHORISATION_DECLINED",
  "ORDER_INCREMENTAL_AUTHORISATION_FAILED",
];
const PRE_RELEASE_EVENTS = ONECAB_REVOLUT_WEBHOOK_EVENTS.filter((e) => !INCREMENT_EVENTS.includes(e));

type Hook = { id: string; url: string; events: string[]; signing_secret?: string };

function revolutStub(opts: { hooks: Hook[]; getFails?: boolean }) {
  const hooks = opts.hooks.map((h) => ({ ...h, events: [...h.events] }));
  return stubFetch((call: FetchCall) => {
    const path = new URL(call.url).pathname.replace(/^\/api/, "");
    if (path.endsWith("/rotate-signing-secret")) return { status: 500, body: { message: "rotation must never be called" } };
    if (call.method === "GET" && path === "/webhooks") {
      return { status: 200, body: hooks.map(({ signing_secret: _s, ...h }) => h) };
    }
    const one = path.match(/^\/webhooks\/([^/]+)$/);
    if (one) {
      const hook = hooks.find((h) => h.id === decodeURIComponent(one[1]));
      if (call.method === "GET") {
        if (opts.getFails || !hook) return { status: 404, body: { message: "not found" } };
        return { status: 200, body: hook };
      }
      if (call.method === "PATCH" && hook) {
        const body = call.body as { url?: string; events?: string[] };
        if (body.url) hook.url = body.url;
        if (body.events) hook.events = [...body.events];
        return { status: 200, body: hook };
      }
    }
    if (call.method === "POST" && path === "/webhooks") {
      const created = { id: `created-${hooks.length}`, ...(call.body as object), signing_secret: "wsk_new_secret" } as Hook;
      hooks.push(created);
      return { status: 200, body: created };
    }
    return { status: 500, body: { message: `unexpected ${call.method} ${path}` } };
  });
}

function writes(calls: FetchCall[]) {
  return calls.filter((c) => c.method !== "GET");
}

function assertNoCreateNoRotate(calls: FetchCall[]) {
  assertStrictEquals(calls.some((c) => c.method === "POST" && new URL(c.url).pathname.endsWith("/webhooks")), false, "must not create a webhook");
  assertStrictEquals(calls.some((c) => c.url.includes("rotate-signing-secret")), false, "must not rotate the secret");
}

Deno.test("event list subscribes to the three incremental authorisation events (13 total, no duplicates)", () => {
  for (const e of INCREMENT_EVENTS) assert((ONECAB_REVOLUT_WEBHOOK_EVENTS as readonly string[]).includes(e), e);
  assertEquals(ONECAB_REVOLUT_WEBHOOK_EVENTS.length, 13);
  assertEquals(new Set(ONECAB_REVOLUT_WEBHOOK_EVENTS).size, 13);
});

Deno.test("REVOLUT_WEBHOOK_ID set: PATCHes the existing webhook, keeps url and signing secret, no second webhook", async () => {
  const stub = revolutStub({ hooks: [{ id: WEBHOOK_ID, url: URL_ONECAB, events: [...PRE_RELEASE_EVENTS], signing_secret: SIGNING_SECRET }] });
  try {
    const r = await ensureOnecabRevolutWebhook({ environment: "live", secretKey: "sk_fixture", webhookUrl: URL_ONECAB, existingWebhookId: WEBHOOK_ID });
    assertEquals(r.created, false);
    assertEquals(r.updated, true);
    assertEquals(r.webhook.id, WEBHOOK_ID);
    assertEquals(r.webhook.url, URL_ONECAB);
    assertEquals(r.webhook.signing_secret, SIGNING_SECRET);
    const w = writes(stub.calls);
    assertEquals(w.length, 1);
    assertEquals(w[0].method, "PATCH");
    assert(w[0].url.endsWith(`/webhooks/${WEBHOOK_ID}`));
    const sent = w[0].body as { url: string; events: string[] };
    assertEquals(sent.url, URL_ONECAB);
    assertEquals([...sent.events].sort(), [...ONECAB_REVOLUT_WEBHOOK_EVENTS].sort());
    assertNoCreateNoRotate(stub.calls);
  } finally {
    stub.restore();
  }
});

Deno.test("stored id unreadable: falls back to URL match and PATCHes that webhook, never creates", async () => {
  const stub = revolutStub({
    hooks: [{ id: WEBHOOK_ID, url: URL_ONECAB, events: [...PRE_RELEASE_EVENTS], signing_secret: SIGNING_SECRET }],
    getFails: true,
  });
  try {
    const r = await ensureOnecabRevolutWebhook({ environment: "live", secretKey: "sk_fixture", webhookUrl: URL_ONECAB, existingWebhookId: WEBHOOK_ID });
    assertEquals(r.created, false);
    assertEquals(r.webhook.id, WEBHOOK_ID);
    assertEquals(writes(stub.calls).map((c) => c.method), ["PATCH"]);
    assertNoCreateNoRotate(stub.calls);
  } finally {
    stub.restore();
  }
});

Deno.test("no stored id: URL match is PATCHed, never duplicated", async () => {
  const stub = revolutStub({
    hooks: [
      { id: "other-merchant-hook", url: "https://elsewhere.example/hook", events: ["ORDER_COMPLETED"] },
      { id: WEBHOOK_ID, url: URL_ONECAB, events: [...PRE_RELEASE_EVENTS], signing_secret: SIGNING_SECRET },
    ],
  });
  try {
    const r = await ensureOnecabRevolutWebhook({ environment: "live", secretKey: "sk_fixture", webhookUrl: URL_ONECAB, existingWebhookId: null });
    assertEquals(r.created, false);
    assertEquals(r.webhook.id, WEBHOOK_ID);
    const w = writes(stub.calls);
    assertEquals(w.length, 1);
    assert(w[0].url.endsWith(`/webhooks/${WEBHOOK_ID}`));
    assertNoCreateNoRotate(stub.calls);
  } finally {
    stub.restore();
  }
});

Deno.test("already up to date: no write at all (idempotent re-run)", async () => {
  const stub = revolutStub({ hooks: [{ id: WEBHOOK_ID, url: URL_ONECAB, events: [...ONECAB_REVOLUT_WEBHOOK_EVENTS], signing_secret: SIGNING_SECRET }] });
  try {
    const r = await ensureOnecabRevolutWebhook({ environment: "live", secretKey: "sk_fixture", webhookUrl: URL_ONECAB, existingWebhookId: WEBHOOK_ID });
    assertEquals(r.created, false);
    assertEquals(r.updated, false);
    assertEquals(writes(stub.calls).length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test("register handler never rotates the secret and only stores a secret Revolut returned", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/admin-register-revolut-webhook/index.ts", import.meta.url),
  );
  assertStrictEquals(src.includes("rotate-signing-secret"), false);
  assertStrictEquals(/Deno\.env\.set\(/.test(src), false);
  assert(src.includes("if (result.webhook.signing_secret?.trim()) {"));
  assert(src.includes('Deno.env.get("REVOLUT_WEBHOOK_ID")'));
});
