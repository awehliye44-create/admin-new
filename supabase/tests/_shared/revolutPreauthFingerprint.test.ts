/**
 * three_ds_fingerprint: returned promptly to capable devices, never logged/persisted,
 * ACS precedence and decline/unknown semantics unchanged; old clients keep Edge polling.
 * Run: deno test --allow-read --allow-env supabase/tests/_shared/revolutPreauthFingerprint.test.ts
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  actionableFingerprintHtml,
  clientSupportsThreeDsFingerprint,
  resolveSavedCardPaymentOutcome,
} from "../../functions/_shared/revolutPreauth.ts";

const FINGERPRINT_HTML = btoa("<html><body><form id='tdsMmethodForm'>SECRET-DEVICE-DATA</form></body></html>");

type Payment = {
  id: string;
  state?: string;
  decline_reason?: string;
  authentication_challenge?: { type?: string; acs_url?: string; fingerprint_html?: string };
};

function harness(sequence: Payment[], orderState = "AUTHORISED") {
  const logs: string[] = [];
  let polls = 0;
  let orderReads = 0;
  const run = (fingerprintCapable: boolean) =>
    resolveSavedCardPaymentOutcome({
      environment: "test",
      secretKey: "sk",
      orderId: "ord-1",
      payment: { id: "pay-1", state: "pending" },
      fingerprintCapable,
      logStep: (step, details) => logs.push(`${step} ${JSON.stringify(details ?? {})}`),
      retrievePayment: (async () => {
        const p = sequence[Math.min(polls, sequence.length - 1)];
        polls += 1;
        return p;
      }) as never,
      retrieveOrder: (async () => {
        orderReads += 1;
        return { id: "ord-1", state: orderState, amount: 750, payments: [{ id: "pay-1", state: "AUTHORISED", authorised_amount: 750 }] };
      }) as never,
      sleep: async () => {},
    });
  return { run, logs, polls: () => polls, orderReads: () => orderReads };
}

const fingerprint: Payment = {
  id: "pay-1",
  state: "authentication_challenge",
  authentication_challenge: { type: "three_ds_fingerprint", fingerprint_html: FINGERPRINT_HTML },
};
const acs: Payment = {
  id: "pay-1",
  state: "authentication_challenge",
  authentication_challenge: { type: "three_ds", acs_url: "https://acs.example/challenge" },
};

Deno.test("capability flag parsing is exact", () => {
  assert(clientSupportsThreeDsFingerprint(["three_ds_fingerprint_v1"]));
  assert(!clientSupportsThreeDsFingerprint(undefined));
  assert(!clientSupportsThreeDsFingerprint("three_ds_fingerprint_v1"));
  assert(!clientSupportsThreeDsFingerprint(["three_ds_fingerprint"]));
});

Deno.test("actionableFingerprintHtml requires type three_ds_fingerprint and non-empty html", () => {
  assertEquals(actionableFingerprintHtml(fingerprint.authentication_challenge), FINGERPRINT_HTML);
  assertEquals(actionableFingerprintHtml({ type: "three_ds_fingerprint", fingerprint_html: "  " }), null);
  assertEquals(actionableFingerprintHtml({ type: "three_ds", fingerprint_html: FINGERPRINT_HTML }), null);
  assertEquals(actionableFingerprintHtml(undefined), null);
});

Deno.test("fingerprint returned early to capable client (first challenge poll), html never logged", async () => {
  const h = harness([{ id: "pay-1", state: "pending" }, fingerprint, { id: "pay-1", state: "authorised" }]);
  const out = await h.run(true);
  assertEquals(out.kind, "requires_fingerprint");
  if (out.kind === "requires_fingerprint") {
    assertEquals(out.fingerprintHtml, FINGERPRINT_HTML);
    assertEquals(out.paymentId, "pay-1");
  }
  assertEquals(h.polls(), 2, "stops polling at the fingerprint challenge");
  assertEquals(h.orderReads(), 0);
  const joined = h.logs.join("\n");
  assert(!joined.includes(FINGERPRINT_HTML), "fingerprint_html must never be logged");
  assert(!joined.includes("SECRET-DEVICE-DATA"));
  assert(joined.includes('"fingerprint_present":true'));
  assert(joined.includes('"challenge_type":"three_ds_fingerprint"'));
});

Deno.test("old client (no capability) keeps Edge polling through fingerprint → authorised", async () => {
  const h = harness([fingerprint, fingerprint, { id: "pay-1", state: "authorised" }]);
  const out = await h.run(false);
  assertEquals(out.kind, "authorised");
  if (out.kind === "authorised") assertEquals(out.order.state, "AUTHORISED");
  assertEquals(h.polls(), 3);
  assert(!h.logs.join("\n").includes(FINGERPRINT_HTML));
});

Deno.test("ACS URL still wins over fingerprint (interactive SCA preserved)", async () => {
  const h = harness([{ ...acs, authentication_challenge: { ...acs.authentication_challenge, fingerprint_html: FINGERPRINT_HTML } }]);
  const out = await h.run(true);
  assertEquals(out.kind, "requires_3ds");
  assert(!h.logs.join("\n").includes("https://acs.example"));
});

Deno.test("provider decline stays terminal failed (capable or not)", async () => {
  for (const cap of [true, false]) {
    const h = harness([{ id: "pay-1", state: "declined", decline_reason: "do_not_honour" }]);
    const out = await h.run(cap);
    assertEquals(out, { kind: "failed", reason: "do_not_honour" });
  }
});

Deno.test("payment authorised but order not AUTHORISED is never reported authorised", async () => {
  const h = harness([{ id: "pay-1", state: "authorised" }], "PENDING");
  const out = await h.run(true);
  assertEquals(out.kind, "in_flight");
});

Deno.test("unknown provider state stays in_flight (fail closed, no authorisation)", async () => {
  const h = harness([{ id: "pay-1", state: "weird_new_state" }]);
  const out = await h.run(true);
  assertEquals(out.kind, "in_flight");
});

Deno.test("source lock: fingerprint html is not persisted or sent to telemetry", async () => {
  const preauth = await Deno.readTextFile(new URL("../../functions/_shared/revolutPreauth.ts", import.meta.url));
  const responseBuilders = preauth.split("three_ds_fingerprint: { fingerprint_html: resolved.fingerprintHtml }").length - 1;
  assertEquals(responseBuilders, 1, "html appears only in the device response body");
  const htmlLines = preauth.split("\n").filter((l) => /fingerprintHtml|fingerprint_html/.test(l));
  for (const line of htmlLines) {
    assert(
      !/insert|update|upsert|markPayment|recordPayment|logStep|console\.|metadata/i.test(line),
      `fingerprint html near a persist/log call: ${line.trim()}`,
    );
  }
  const telemetry = await Deno.readTextFile(new URL("../../functions/ingest-telemetry/index.ts", import.meta.url));
  assert(!telemetry.includes('"fingerprint_html"'));
});
