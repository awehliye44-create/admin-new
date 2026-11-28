import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  normalizeOnecabAccessRole,
  resolveAuthSessionIdFromClaims,
  sessionRoleAllowsAccess,
  sessionRolesAreIndependent,
} from "./offline/sessionAccessRoleSSOT.ts";

Deno.test("#57F/G unbound role fails closed for customer and driver gates", () => {
  assertEquals(
    sessionRoleAllowsAccess({ boundRole: null, requiredRole: "customer" }),
    false,
  );
  assertEquals(
    sessionRoleAllowsAccess({ boundRole: undefined, requiredRole: "driver" }),
    false,
  );
  assertEquals(
    sessionRoleAllowsAccess({ boundRole: "", requiredRole: "customer" }),
    false,
  );
});

Deno.test("#57F/G bound roles are exclusive — no fall-through", () => {
  assertEquals(
    sessionRoleAllowsAccess({ boundRole: "customer", requiredRole: "customer" }),
    true,
  );
  assertEquals(
    sessionRoleAllowsAccess({ boundRole: "customer", requiredRole: "driver" }),
    false,
  );
  assertEquals(
    sessionRoleAllowsAccess({ boundRole: "driver", requiredRole: "driver" }),
    true,
  );
  assertEquals(
    sessionRoleAllowsAccess({ boundRole: "driver", requiredRole: "customer" }),
    false,
  );
});

Deno.test("#57F/G simultaneous Customer+Driver sessions stay independent", () => {
  const customerSession = {
    sessionId: "11111111-1111-4111-8111-111111111111",
    role: "customer" as const,
  };
  const driverSession = {
    sessionId: "22222222-2222-4222-8222-222222222222",
    role: "driver" as const,
  };
  assertEquals(
    sessionRolesAreIndependent({
      sessionA: customerSession,
      sessionB: driverSession,
    }),
    true,
  );
  // Reversed bind order must still be independent.
  assertEquals(
    sessionRolesAreIndependent({
      sessionA: driverSession,
      sessionB: customerSession,
    }),
    true,
  );
});

Deno.test("#57F/G forged / missing session_id rejected", () => {
  assertEquals(resolveAuthSessionIdFromClaims(null), null);
  assertEquals(resolveAuthSessionIdFromClaims({}), null);
  assertEquals(resolveAuthSessionIdFromClaims({ session_id: "not-a-uuid" }), null);
  assertEquals(
    resolveAuthSessionIdFromClaims({
      session_id: "33333333-3333-4333-8333-333333333333",
    }),
    "33333333-3333-4333-8333-333333333333",
  );
});

Deno.test("#57F/G role normalize rejects forged admin/access claims", () => {
  assertEquals(normalizeOnecabAccessRole("admin"), null);
  assertEquals(normalizeOnecabAccessRole("onecab_access"), null);
  assertEquals(normalizeOnecabAccessRole("customer"), "customer");
  assertEquals(normalizeOnecabAccessRole("driver"), "driver");
});
