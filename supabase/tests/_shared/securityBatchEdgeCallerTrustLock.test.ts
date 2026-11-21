/**
 * Lock: edge functions must not trust caller-supplied text, phone numbers or
 * fallback roles for identity, permissions or outbound notifications.
 */
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const read = (rel: string) => Deno.readTextFile(new URL(`../../functions/${rel}`, import.meta.url));

Deno.test("lost property: driver push wording never repeats passenger-typed category", async () => {
  const src = await read("create-lost-property-case/index.ts");
  assertStringIncludes(src, "itemCategoryPushLabel(item_category)");
  assertEquals(src.includes("lost ${item_category}"), false);
  assertStringIncludes(src, "MAX_DESCRIPTION_LENGTH");
});

Deno.test("guest checkout: a typed phone never books under an existing account", async () => {
  const src = await read("create-guest-payment-intent/index.ts");
  assertStringIncludes(src, "if (!input.phoneVerified) return existingAccountNeedsVerifiedBooking();");
  // phoneVerified is only set from a verified continuation token
  assertEquals((src.match(/phoneVerified = true/g) ?? []).length, 1);
  const tokenBranch = src.indexOf("activeContinuationToken = rawContinuation;");
  assert(tokenBranch > 0 && src.indexOf("phoneVerified = true", tokenBranch) - tokenBranch < 80);
});

Deno.test("admin trip action: driver-assigned notice wording is fixed server-side", async () => {
  const src = await read("admin-trip-action/index.ts");
  assertStringIncludes(src, "DRIVER_ASSIGNED_NOTICES");
  assertEquals(/body\.title|typeof body\.body|body\.path|body\.notification_id/.test(src), false);
});

Deno.test("corporate cancel: staff need a trips/corporate page; role is server-derived", async () => {
  const src = await read("cancel-corporate-trip/index.ts");
  assertStringIncludes(src, "requireAnyPageAccess(");
  assertStringIncludes(src, "cancelled_by_role: callerRole");
  assertEquals(src.includes("cancelled_by_role ||"), false);
});

Deno.test("shortfall recapture: no super_admin fallback for missing staff profile", async () => {
  const src = await read("admin-recapture-trip-shortfall/index.ts");
  assertEquals(src.includes(': "super_admin"'), false);
  assertStringIncludes(src, 'requirePageAccess(gate, "payments-trip-shortfall-recapture")');
});

Deno.test("driver statements: approved drivers only, fresh links only", async () => {
  for (const rel of ["driver-invoices/index.ts", "driver-statement-pdf/index.ts"]) {
    assertStringIncludes(await read(rel), "loadStatementDriver(");
  }
  const shared = await read("_shared/deliverDriverStatement.ts");
  assertEquals(shared.includes("return invoice.invoice_pdf_url;"), false);
  const access = await read("_shared/driverStatementAccess.ts");
  assertStringIncludes(access, 'row.approval_status !== "approved"');
});
