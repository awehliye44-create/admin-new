/**
 * LOCK — route ACCESS is open; financial artifact CREATION is verified-user only.
 *
 * WhatsApp / Guest booking is anonymous by business rule. calculate-route must
 * keep live access for anonymous website calls, create-guest-payment-intent,
 * service-role callers and session-less callers — never a 401 for "no user".
 * route_quote_artifacts / server_fare_quotes are owned only by a user that
 * auth.getUser verified. Guests never create or consume Customer artifacts.
 *
 * If this fails, fix the code — never delete or soften the lock.
 */
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveOptionalVerifiedUserId, type VerifyUserToken } from "./optionalVerifiedUser.ts";

const ANON = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.anon-signature";
const SERVICE = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.service-signature";
const USER_JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLWEifQ.user-signature";
const EXPIRED_JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJleHBpcmVkIn0.expired-signature";
const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

Deno.env.set("SUPABASE_ANON_KEY", ANON);
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE);

function req(token?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  return new Request("http://edge.local/calculate-route", { method: "POST", headers });
}

function recordingVerifier(map: Record<string, string>): { verify: VerifyUserToken; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    verify: (r) => {
      const t = r.headers.get("Authorization")!.slice(7);
      calls.push(t);
      return Promise.resolve(map[t] ?? null);
    },
  };
}

const routeSrc = await Deno.readTextFile(new URL("../calculate-route/index.ts", import.meta.url));
const fareSrc = await Deno.readTextFile(new URL("../calculate-fare/index.ts", import.meta.url));
const quoteEdgeSrc = await Deno.readTextFile(
  new URL("../customer-receivable-booking-quote/index.ts", import.meta.url),
);
const faSrc = await Deno.readTextFile(new URL("./serverFareAuthoritySSOT.ts", import.meta.url));
const guestSrc = await Deno.readTextFile(
  new URL("../create-guest-payment-intent/index.ts", import.meta.url),
);

Deno.test("1. anonymous (no token, anon key, publishable key) → null user, verifier never called", async () => {
  const v = recordingVerifier({ [USER_JWT]: USER_ID });
  assertEquals(await resolveOptionalVerifiedUserId(req(), v.verify), null);
  assertEquals(await resolveOptionalVerifiedUserId(req(ANON), v.verify), null);
  assertEquals(await resolveOptionalVerifiedUserId(req("sb_publishable_abc123"), v.verify), null);
  assertEquals(await resolveOptionalVerifiedUserId(new Request("http://x", { headers: { Authorization: "Basic abc" } }), v.verify), null);
  assertEquals(v.calls.length, 0);
});

Deno.test("2. verified Customer → user id (auth.getUser is the only verifier)", async () => {
  const v = recordingVerifier({ [USER_JWT]: USER_ID });
  assertEquals(await resolveOptionalVerifiedUserId(req(USER_JWT), v.verify), USER_ID);
  assertEquals(v.calls, [USER_JWT]);
  const src = await Deno.readTextFile(new URL("./optionalVerifiedUser.ts", import.meta.url));
  assertStringIncludes(src, "requireAuthenticatedUser(");
  assertEquals(/atob|JSON\.parse|base64/i.test(src), false);
});

Deno.test("3. service-role key → null user (never a Customer owner), verifier never called", async () => {
  const v = recordingVerifier({ [SERVICE]: USER_ID });
  assertEquals(await resolveOptionalVerifiedUserId(req(SERVICE), v.verify), null);
  assertEquals(v.calls.length, 0);
});

Deno.test("4. invalid / expired session or verifier failure → null user, never throws", async () => {
  const v = recordingVerifier({});
  assertEquals(await resolveOptionalVerifiedUserId(req(EXPIRED_JWT), v.verify), null);
  const throwing: VerifyUserToken = () => Promise.reject(new Error("auth down"));
  assertEquals(await resolveOptionalVerifiedUserId(req(USER_JWT), throwing), null);
});

Deno.test("5. calculate-route never gates access on identity", () => {
  assertEquals(/requireSignedInOrService|callerGate|requireAuthenticatedUser/.test(routeSrc), false);
  assertEquals(/status:\s*401/.test(routeSrc), false);
  assertStringIncludes(routeSrc, "const userIdP = resolveOptionalVerifiedUserId(req);");
  const handlerIdx = routeSrc.indexOf("serve(async (req) => {");
  const resolveIdx = routeSrc.indexOf("resolveOptionalVerifiedUserId(req)");
  const firstAwaitAfter = routeSrc.indexOf("await", handlerIdx);
  assert(resolveIdx > handlerIdx && resolveIdx < firstAwaitAfter, "user resolution must not block the route");
});

Deno.test("6. route artifact only when a verified user exists", () => {
  assertStringIncludes(routeSrc, "if (!userId) return null;");
  assertStringIncludes(routeSrc, 'if (!ctx || result.source !== "mapbox_directions") {');
  assertStringIncludes(routeSrc, "userId,");
  assertEquals(/userId:\s*(body|rawBody|req)\./.test(routeSrc), false);
});

Deno.test("7. calculate-fare uses the same verified-user resolver; artifacts never for anonymous", () => {
  assertStringIncludes(fareSrc, "resolveOptionalVerifiedUserId(req)");
  assertEquals(/function resolveOptionalUserId/.test(fareSrc), false);
  assertStringIncludes(faSrc, '.eq("user_id", ctx.userId)');
});

Deno.test("8. Customer booking quote requires a verified user — guests cannot reach Customer artifacts", () => {
  assertStringIncludes(quoteEdgeSrc, "auth.getUser()");
  assertStringIncludes(quoteEdgeSrc, "issueServerAuthoritativeBookingQuote(admin, { userId: user.id, body })");
});

Deno.test("9. Guest checkout keeps its own server repricing — no Customer quote/artifact path", () => {
  assertStringIncludes(guestSrc, "/functions/v1/calculate-route");
  assertStringIncludes(guestSrc, "/functions/v1/calculate-fare");
  assertEquals(
    /booking_payment_quotes|server_fare_quotes|route_quote_artifacts|create-preauth-payment-intent|serverFareAuthoritySSOT/.test(guestSrc),
    false,
  );
});
