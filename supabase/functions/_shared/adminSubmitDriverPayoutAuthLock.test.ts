/**
 * Lock: admin-submit-driver-payout-payment requires finance execution auth.
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const ADMIN = new URL("../admin-submit-driver-payout-payment/index.ts", import.meta.url);
const GATE = new URL("./adminPaymentGate.ts", import.meta.url);

Deno.test("admin-submit-driver-payout-payment imports requireFinanceExecutionAuth", async () => {
  const src = await Deno.readTextFile(ADMIN);
  assertStringIncludes(src, "requireFinanceExecutionAuth");
  assertStringIncludes(src, "payout-ledger");
});

Deno.test("admin-submit rejects before provider work when auth fails", async () => {
  const src = await Deno.readTextFile(ADMIN);
  const authIdx = src.indexOf("requireFinanceExecutionAuth(req");
  const clientIdx = src.indexOf("const supabase = createClient(");
  assertEquals(authIdx > 0 && clientIdx > authIdx, true);
});

Deno.test("requireFinanceExecutionAuth exists and blocks support roles", async () => {
  const src = await Deno.readTextFile(GATE);
  assertStringIncludes(src, "FINANCE_EXECUTION_ROLES");
  assertStringIncludes(src, "finance_manager");
  assertStringIncludes(src, "FINANCE_EXECUTION_FORBIDDEN");
  assertStringIncludes(src, "assertCronOrServiceRoleAuth");
});
