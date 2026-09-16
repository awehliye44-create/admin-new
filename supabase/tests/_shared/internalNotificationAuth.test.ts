/**
 * Phase A8B5B2 — send-driver-notification admission gate.
 * Run: deno test supabase/functions/_shared/internalNotificationAuth.test.ts
 *
 * Synthetic secrets only. Never log or assert raw production credentials.
 */
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  authorizeInternalNotificationRequest,
  methodNotAllowedResponse,
  parseExactBearerToken,
  timingSafeEqualString,
  INTERNAL_NOTIFICATION_TOKEN_HEADER,
} from "./internalNotificationAuth.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SDN = "supabase/functions/send-driver-notification/index.ts";
const HELPER = "supabase/functions/_shared/internalNotificationAuth.ts";

const SYN_SR = "test-service-role-key-aaaaaaaaaaaaaaaaaaaaaaaa";
const SYN_INTERNAL = "test-internal-notification-token-bbbbbbbbbbbbbbbb";
const SYN_ANON = "test-anon-publishable-key-cccccccccccccccccccc";
const SYN_USER_JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoidXNlciIsInN1YiI6InUifQ.sig";

const env = {
  serviceRoleKey: SYN_SR,
  internalNotificationToken: SYN_INTERNAL,
  anonKey: SYN_ANON,
};

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function req(
  method: string,
  headers: Record<string, string> = {},
  body?: string,
): Request {
  return new Request("https://example.test/functions/v1/send-driver-notification", {
    method,
    headers,
    body,
  });
}

Deno.test("timingSafeEqualString rejects length mismatch and unequal bytes", () => {
  assertEquals(timingSafeEqualString("abc", "ab"), false);
  assertEquals(timingSafeEqualString("abc", "abd"), false);
  assertEquals(timingSafeEqualString("abc", "abc"), true);
});

Deno.test("parseExactBearerToken requires exact Bearer SP token shape", () => {
  assertEquals(parseExactBearerToken(null), null);
  assertEquals(parseExactBearerToken(""), null);
  assertEquals(parseExactBearerToken("bearer x"), null);
  assertEquals(parseExactBearerToken("Bearer"), null);
  assertEquals(parseExactBearerToken("Bearer "), null);
  assertEquals(parseExactBearerToken("Bearer  x"), null); // double space
  assertEquals(parseExactBearerToken("Bearer x y"), null);
  assertEquals(parseExactBearerToken("Bearer\tx"), null);
  assertEquals(parseExactBearerToken(`Bearer ${SYN_SR}`), SYN_SR);
});

Deno.test("missing credentials → 401", () => {
  const r = authorizeInternalNotificationRequest(req("POST"), env);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.response.status, 401);
});

Deno.test("anon Bearer → 401", () => {
  const r = authorizeInternalNotificationRequest(
    req("POST", { Authorization: `Bearer ${SYN_ANON}` }),
    env,
  );
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.response.status, 401);
});

Deno.test("ordinary user JWT → 401", () => {
  const r = authorizeInternalNotificationRequest(
    req("POST", { Authorization: `Bearer ${SYN_USER_JWT}` }),
    env,
  );
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.response.status, 401);
});

Deno.test("malformed Bearer → 401", () => {
  for (const bad of ["Bearer", "Bearer ", "Token x", `bearer ${SYN_SR}`, `Bearer  ${SYN_SR}`]) {
    const r = authorizeInternalNotificationRequest(req("POST", { Authorization: bad }), env);
    assertEquals(r.ok, false);
    if (!r.ok) assertEquals(r.response.status, 401);
  }
});

Deno.test("wrong internal token → 401", () => {
  const r = authorizeInternalNotificationRequest(
    req("POST", { [INTERNAL_NOTIFICATION_TOKEN_HEADER]: "wrong-token-value-xxxxxxxxxxxx" }),
    env,
  );
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.response.status, 401);
});

Deno.test("correct service-role Bearer → ok", () => {
  const r = authorizeInternalNotificationRequest(
    req("POST", { Authorization: `Bearer ${SYN_SR}` }),
    env,
  );
  assertEquals(r.ok, true);
  if (r.ok) assertEquals(r.source, "service_role_bearer");
});

Deno.test("correct internal token → ok", () => {
  const r = authorizeInternalNotificationRequest(
    req("POST", { [INTERNAL_NOTIFICATION_TOKEN_HEADER]: SYN_INTERNAL }),
    env,
  );
  assertEquals(r.ok, true);
  if (r.ok) assertEquals(r.source, "internal_notification_token");
});

Deno.test("both credentials present → fail closed", () => {
  const r = authorizeInternalNotificationRequest(
    req("POST", {
      Authorization: `Bearer ${SYN_SR}`,
      [INTERNAL_NOTIFICATION_TOKEN_HEADER]: SYN_INTERNAL,
    }),
    env,
  );
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.response.status, 401);
});

Deno.test("both present with one invalid → fail closed", () => {
  const a = authorizeInternalNotificationRequest(
    req("POST", {
      Authorization: `Bearer ${SYN_SR}`,
      [INTERNAL_NOTIFICATION_TOKEN_HEADER]: "wrong",
    }),
    env,
  );
  const b = authorizeInternalNotificationRequest(
    req("POST", {
      Authorization: `Bearer ${SYN_ANON}`,
      [INTERNAL_NOTIFICATION_TOKEN_HEADER]: SYN_INTERNAL,
    }),
    env,
  );
  assertEquals(a.ok, false);
  assertEquals(b.ok, false);
});

Deno.test("ambiguous multi Authorization → 401", () => {
  const r = authorizeInternalNotificationRequest(
    req("POST", { Authorization: `Bearer ${SYN_SR}, Bearer ${SYN_SR}` }),
    env,
  );
  assertEquals(r.ok, false);
});

Deno.test("missing service-role env fails Bearer path closed", () => {
  const r = authorizeInternalNotificationRequest(req("POST", { Authorization: `Bearer ${SYN_SR}` }), {
    serviceRoleKey: "",
    internalNotificationToken: SYN_INTERNAL,
  });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.response.status, 401);
});

Deno.test("missing internal env fails internal-header path closed", () => {
  const r = authorizeInternalNotificationRequest(
    req("POST", { [INTERNAL_NOTIFICATION_TOKEN_HEADER]: SYN_INTERNAL }),
    { serviceRoleKey: SYN_SR, internalNotificationToken: "" },
  );
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.response.status, 401);
});

Deno.test("Bearer path still works when internal env unset", () => {
  const r = authorizeInternalNotificationRequest(req("POST", { Authorization: `Bearer ${SYN_SR}` }), {
    serviceRoleKey: SYN_SR,
    internalNotificationToken: "",
  });
  assertEquals(r.ok, true);
  if (r.ok) assertEquals(r.source, "service_role_bearer");
});

Deno.test("internal-header path still works when service-role env unset", () => {
  const r = authorizeInternalNotificationRequest(
    req("POST", { [INTERNAL_NOTIFICATION_TOKEN_HEADER]: SYN_INTERNAL }),
    { serviceRoleKey: "", internalNotificationToken: SYN_INTERNAL },
  );
  assertEquals(r.ok, true);
  if (r.ok) assertEquals(r.source, "internal_notification_token");
});

Deno.test("service-role key cannot authenticate via internal header", () => {
  const r = authorizeInternalNotificationRequest(
    req("POST", { [INTERNAL_NOTIFICATION_TOKEN_HEADER]: SYN_SR }),
    env,
  );
  assertEquals(r.ok, false);
});

Deno.test("internal token cannot authenticate via Bearer", () => {
  const r = authorizeInternalNotificationRequest(
    req("POST", { Authorization: `Bearer ${SYN_INTERNAL}` }),
    env,
  );
  assertEquals(r.ok, false);
});

Deno.test("internal header surrounding whitespace is accepted after trim", () => {
  const r = authorizeInternalNotificationRequest(
    req("POST", { [INTERNAL_NOTIFICATION_TOKEN_HEADER]: `  ${SYN_INTERNAL}  ` }),
    env,
  );
  assertEquals(r.ok, true);
});

Deno.test("internal header case-sensitive name; wrong case does not authenticate", () => {
  const r = authorizeInternalNotificationRequest(
    req("POST", { "X-ONECAB-INTERNAL-NOTIFICATION-TOKEN-WRONG": SYN_INTERNAL }),
    env,
  );
  assertEquals(r.ok, false);
});

Deno.test("ambiguous duplicated internal header values fail closed", () => {
  const r = authorizeInternalNotificationRequest(
    req("POST", { [INTERNAL_NOTIFICATION_TOKEN_HEADER]: `${SYN_INTERNAL}, ${SYN_INTERNAL}` }),
    env,
  );
  assertEquals(r.ok, false);
});

Deno.test("unauthorized body is generic (no token/driver detail)", async () => {
  const r = authorizeInternalNotificationRequest(req("POST"), env);
  assertEquals(r.ok, false);
  if (!r.ok) {
    const text = await r.response.text();
    assertEquals(r.response.status, 401);
    assert(!text.includes(SYN_SR));
    assert(!text.includes(SYN_INTERNAL));
    assert(!text.includes(SYN_ANON));
    assert(!/driver/i.test(text));
    assertEquals(JSON.parse(text).error, "UNAUTHORIZED");
  }
});

Deno.test("methodNotAllowedResponse is 405 with Allow POST, OPTIONS", () => {
  const res = methodNotAllowedResponse();
  assertEquals(res.status, 405);
  assertEquals(res.headers.get("Allow"), "POST, OPTIONS");
});

Deno.test("send-driver-notification auth order: rate-limit memory, auth, POST, then client/body", () => {
  const src = read(SDN);
  const helper = read(HELPER);

  assert(src.includes('from "../_shared/internalNotificationAuth.ts"'));
  assert(src.includes("authorizeInternalNotificationRequest"));
  assert(src.includes("methodNotAllowedResponse"));

  const serveIdx = src.indexOf("Deno.serve");
  const optionsIdx = src.indexOf("OPTIONS", serveIdx);
  const rateIdx = src.indexOf("checkRateLimit", serveIdx);
  const authIdx = src.indexOf("const auth = authorizeInternalNotificationRequest", serveIdx);
  const postIdx = Math.max(
    src.indexOf('req.method !== "POST"', serveIdx),
    src.indexOf("req.method !== 'POST'", serveIdx),
  );
  const jsonIdx = src.indexOf("await req.json()", serveIdx);
  const clientIdx = src.indexOf("createClient(SUPABASE_URL, SERVICE_ROLE_KEY)", serveIdx);
  assert(serveIdx >= 0 && optionsIdx > serveIdx);
  assert(rateIdx > optionsIdx && rateIdx < authIdx);
  assert(authIdx > rateIdx);
  assert(postIdx > authIdx);
  assert(jsonIdx > postIdx);
  assert(clientIdx > postIdx);

  // Rate limit is in-memory IP throttle only (no privileged DB work before auth).
  assert(src.includes("getClientIP"));
  assert(!src.slice(serveIdx, authIdx).includes(".from("));
  assert(!src.slice(serveIdx, authIdx).includes("createClient"));

  // CORS must not broaden for internal header (no browser callers)
  assert(!src.includes("X-ONECAB-INTERNAL-NOTIFICATION-TOKEN"));

  assert(!helper.includes(".includes(serviceRoleKey)"));
  assert(!helper.includes(".includes(internalToken)"));
  assert(helper.includes("timingSafeEqualString"));
  assert(helper.includes("parseExactBearerToken"));
  assert(!/console\.(log|info|warn|error)\([^\)]*(Authorization|SERVICE_ROLE|INTERNAL_NOTIFICATION)/.test(helper));
});

Deno.test("helper source never embeds production-looking JWT literals", () => {
  const helper = read(HELPER);
  const sdn = read(SDN);
  assert(!/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(helper));
  assert(!sdn.includes("ONECAB_INTERNAL_NOTIFICATION_TOKEN="));
  assert(!sdn.includes("SUPABASE_SERVICE_ROLE_KEY=eyJ"));
});
