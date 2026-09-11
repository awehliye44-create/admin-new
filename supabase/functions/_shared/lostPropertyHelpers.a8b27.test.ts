/**
 * Phase A8B27 — lost-property requireAdmin page-gate unit tests.
 * Synthetic identities only. No production calls.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  evaluateStaffHasPageAccess,
  staffHasPageAccessForUser,
  LOST_PROPERTY_PAGE_SLUG,
  authenticateCaller,
  requireAdmin,
} from "./lostPropertyHelpers.ts";

Deno.test("evaluateStaffHasPageAccess: active staff with page allowed", () => {
  assertEquals(
    evaluateStaffHasPageAccess({
      pageSlug: LOST_PROPERTY_PAGE_SLUG,
      staff: { role: "operator", is_active: true },
      pagePermission: { can_access: true },
    }),
    true,
  );
});

Deno.test("evaluateStaffHasPageAccess: inactive staff denied", () => {
  assertEquals(
    evaluateStaffHasPageAccess({
      pageSlug: LOST_PROPERTY_PAGE_SLUG,
      staff: { role: "operator", is_active: false },
      pagePermission: { can_access: true },
    }),
    false,
  );
});

Deno.test("evaluateStaffHasPageAccess: active staff without page denied", () => {
  assertEquals(
    evaluateStaffHasPageAccess({
      pageSlug: LOST_PROPERTY_PAGE_SLUG,
      staff: { role: "finance_manager", is_active: true },
      pagePermission: { can_access: false },
    }),
    false,
  );
  assertEquals(
    evaluateStaffHasPageAccess({
      pageSlug: LOST_PROPERTY_PAGE_SLUG,
      staff: { role: "finance_manager", is_active: true },
      pagePermission: null,
    }),
    false,
  );
});

Deno.test("evaluateStaffHasPageAccess: missing staff denied", () => {
  assertEquals(
    evaluateStaffHasPageAccess({
      pageSlug: LOST_PROPERTY_PAGE_SLUG,
      staff: null,
      pagePermission: { can_access: true },
    }),
    false,
  );
});

Deno.test("evaluateStaffHasPageAccess: empty page slug denied", () => {
  assertEquals(
    evaluateStaffHasPageAccess({
      pageSlug: "",
      staff: { role: "admin", is_active: true },
      pagePermission: { can_access: true },
    }),
    false,
  );
});

Deno.test("evaluateStaffHasPageAccess: super_admin with page allowed", () => {
  assertEquals(
    evaluateStaffHasPageAccess({
      pageSlug: LOST_PROPERTY_PAGE_SLUG,
      staff: { role: "super_admin", is_active: true },
      pagePermission: { can_access: true },
    }),
    true,
  );
});

type FakeRow = Record<string, unknown> | null;

function fakeClient(opts: {
  staff?: FakeRow;
  perm?: FakeRow;
  staffError?: unknown;
  permError?: unknown;
}) {
  return {
    from(table: string) {
      return {
        select(_cols: string) {
          const eqs: Array<[string, unknown]> = [];
          const api = {
            eq(col: string, val: unknown) {
              eqs.push([col, val]);
              return api;
            },
            async maybeSingle() {
              if (table === "staff_profiles") {
                return { data: opts.staff ?? null, error: opts.staffError ?? null };
              }
              if (table === "role_page_permissions") {
                return { data: opts.perm ?? null, error: opts.permError ?? null };
              }
              return { data: null, error: null };
            },
          };
          return api;
        },
      };
    },
  };
}

Deno.test("staffHasPageAccessForUser binds verified user id path", async () => {
  const sb = fakeClient({
    staff: { role: "customer_support", is_active: true },
    perm: { can_access: true },
  });
  assertEquals(
    await staffHasPageAccessForUser(sb as never, "11111111-1111-1111-1111-111111111111"),
    true,
  );
});

Deno.test("staffHasPageAccessForUser denies inactive / no page / errors", async () => {
  assertEquals(
    await staffHasPageAccessForUser(
      fakeClient({ staff: null }) as never,
      "11111111-1111-1111-1111-111111111111",
    ),
    false,
  );
  assertEquals(
    await staffHasPageAccessForUser(
      fakeClient({
        staff: { role: "operator", is_active: true },
        perm: { can_access: false },
      }) as never,
      "11111111-1111-1111-1111-111111111111",
    ),
    false,
  );
  assertEquals(
    await staffHasPageAccessForUser(
      fakeClient({ staffError: { message: "boom" } }) as never,
      "11111111-1111-1111-1111-111111111111",
    ),
    false,
  );
});

Deno.test("authenticateCaller: missing Authorization → 401", async () => {
  const res = await authenticateCaller(new Request("https://example.test", { method: "POST" }));
  assertEquals(res instanceof Response, true);
  if (res instanceof Response) {
    assertEquals(res.status, 401);
    const body = await res.json();
    assertEquals(body.success, false);
    assertEquals(body.error, "Unauthorized");
  }
});

Deno.test("authenticateCaller: malformed Bearer → 401", async () => {
  const res = await authenticateCaller(
    new Request("https://example.test", {
      method: "POST",
      headers: { Authorization: "Token abc" },
    }),
  );
  assertEquals(res instanceof Response, true);
  if (res instanceof Response) assertEquals(res.status, 401);
});

Deno.test("requireAdmin source order: auth before page evaluation is structural", async () => {
  // Structural contract covered by source-lock; keep a smoke that missing auth never reaches DB.
  const res = await requireAdmin(new Request("https://example.test", { method: "POST" }));
  assertEquals(res instanceof Response, true);
  if (res instanceof Response) assertEquals(res.status, 401);
});
