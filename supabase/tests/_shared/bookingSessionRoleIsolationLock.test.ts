/**
 * #57F/G — Session-scoped role isolation lock.
 * If this fails, fix the code — never delete or soften the lock.
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test("#57F/G lock: migration fails closed without coalesce unbound fallback", async () => {
  const mig = await Deno.readTextFile(
    new URL(
      "../../migrations/20270227190000_booking_session_role_isolation.sql",
      import.meta.url,
    ),
  );
  assertStringIncludes(mig, "onecab_auth_session_roles");
  assertStringIncludes(mig, "session_id");
  assertStringIncludes(mig, "onecab_jwt_access_role() = 'customer'");
  assertStringIncludes(mig, "onecab_jwt_access_role() = 'driver'");
  assertEquals(mig.includes("coalesce(public.onecab_jwt_access_role()"), false);
  // Must not resolve role from JWT app_metadata (legacy race).
  assertEquals(mig.includes("app_metadata ->> 'onecab_access'"), false);
  assertEquals(mig.includes("-> 'app_metadata'"), false);
  assertStringIncludes(mig, "SECURITY DEFINER");
});

Deno.test("#57F/G lock: bind Edge uses session table — not app_metadata write", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/bind-onecab-access-role/index.ts", import.meta.url),
  );
  assertStringIncludes(src, "onecab_auth_session_roles");
  assertStringIncludes(src, "resolveAuthSessionIdFromClaims");
  assertStringIncludes(src, "scope: \"session\"");
  assertStringIncludes(src, "delete nextMeta.onecab_access");
  // Must not set user-wide onecab_access as SSOT.
  assertEquals(src.includes("onecab_access: roleRaw"), false);
});

Deno.test("#57F/G lock: cancel-trip ownership SSOT still present", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/cancel-trip/index.ts", import.meta.url),
  );
  assertStringIncludes(src, "resolveCancelTripCallerAuthority");
  assertStringIncludes(src, "Never fall through");
});
