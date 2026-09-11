/**
 * Phase A8B27B — lost-property cron internal admission tests.
 * Synthetic secrets only. No production calls. Denial paths must not invoke cleanup/expire work.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  authorizeLostPropertyCronRequest,
  isLostPropertyCronAction,
  timingSafeEqualString,
  INTERNAL_LOST_PROPERTY_CRON_TOKEN_HEADER,
} from "./lostPropertyCronAuth.ts";

const SYN = "a".repeat(32) + "-lost-property-cron-synthetic";

function req(
  method: string,
  headers: Record<string, string> = {},
  url = "https://example.test/functions/v1/lost-property?action=cleanup_photos",
): Request {
  return new Request(url, { method, headers });
}

Deno.test("isLostPropertyCronAction allowlists only the two cron actions", () => {
  assertEquals(isLostPropertyCronAction("cleanup_photos"), true);
  assertEquals(isLostPropertyCronAction("expire_chats"), true);
  assertEquals(isLostPropertyCronAction("admin_unread_count"), false);
  assertEquals(isLostPropertyCronAction("create_case"), false);
  assertEquals(isLostPropertyCronAction(null), false);
});

Deno.test("timingSafeEqualString rejects length/content mismatches", () => {
  assertEquals(timingSafeEqualString(SYN, SYN), true);
  assertEquals(timingSafeEqualString(SYN, SYN + "x"), false);
  assertEquals(timingSafeEqualString("ab", "ac"), false);
});

Deno.test("POST without internal token → 401", async () => {
  const r = authorizeLostPropertyCronRequest(req("POST"), {
    internalLostPropertyCronToken: SYN,
  });
  assertEquals(r.ok, false);
  if (!r.ok) {
    assertEquals(r.response.status, 401);
    const body = await r.response.json();
    assertEquals(body.success, false);
    assertEquals(typeof body.error, "string");
    assertEquals(JSON.stringify(body).includes(SYN), false);
  }
});

Deno.test("GET cron action → 405", async () => {
  const r = authorizeLostPropertyCronRequest(req("GET"), {
    internalLostPropertyCronToken: SYN,
  });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.response.status, 405);
});

Deno.test("incorrect token → 401", async () => {
  const r = authorizeLostPropertyCronRequest(
    req("POST", { [INTERNAL_LOST_PROPERTY_CRON_TOKEN_HEADER]: "b".repeat(40) }),
    { internalLostPropertyCronToken: SYN },
  );
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.response.status, 401);
});

Deno.test("duplicate internal header → 401", async () => {
  // Fetch joins duplicates with ", "
  const r = authorizeLostPropertyCronRequest(
    req("POST", {
      [INTERNAL_LOST_PROPERTY_CRON_TOKEN_HEADER]: `${SYN}, ${SYN}`,
    }),
    { internalLostPropertyCronToken: SYN },
  );
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.response.status, 401);
});

Deno.test("Bearer without internal token → 401", async () => {
  const r = authorizeLostPropertyCronRequest(
    req("POST", { Authorization: "Bearer user-or-admin-jwt" }),
    { internalLostPropertyCronToken: SYN },
  );
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.response.status, 401);
});

Deno.test("dual Bearer + internal token → 401", async () => {
  const r = authorizeLostPropertyCronRequest(
    req("POST", {
      Authorization: "Bearer user-or-admin-jwt",
      [INTERNAL_LOST_PROPERTY_CRON_TOKEN_HEADER]: SYN,
    }),
    { internalLostPropertyCronToken: SYN },
  );
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.response.status, 401);
});

Deno.test("missing Edge env fails closed", async () => {
  const r = authorizeLostPropertyCronRequest(
    req("POST", { [INTERNAL_LOST_PROPERTY_CRON_TOKEN_HEADER]: SYN }),
    { internalLostPropertyCronToken: "" },
  );
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.response.status, 401);
});

Deno.test("short Edge env fails closed", async () => {
  const r = authorizeLostPropertyCronRequest(
    req("POST", { [INTERNAL_LOST_PROPERTY_CRON_TOKEN_HEADER]: "short" }),
    { internalLostPropertyCronToken: "short" },
  );
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.response.status, 401);
});

Deno.test("valid dedicated internal token permits cron auth", () => {
  const r = authorizeLostPropertyCronRequest(
    req("POST", { [INTERNAL_LOST_PROPERTY_CRON_TOKEN_HEADER]: SYN }),
    { internalLostPropertyCronToken: SYN },
  );
  assertEquals(r.ok, true);
});

Deno.test("source lock: helper has no secret literals and scopes cron actions", () => {
  const src = Deno.readTextFileSync(
    new URL("./lostPropertyCronAuth.ts", import.meta.url),
  );
  assertEquals(src.includes("cleanup_photos"), true);
  assertEquals(src.includes("expire_chats"), true);
  assertEquals(src.includes("ONECAB_INTERNAL_LOST_PROPERTY_CRON_TOKEN"), true);
  assertEquals(src.includes("eyJ"), false);
  assertEquals(src.includes("Bearer ${"), false);
  assertEquals(src.includes("profiles.role"), false);
});
