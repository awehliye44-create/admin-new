/**
 * Step 9.4D1 — durable OAuth refresh ownership lock (TypeScript contract).
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test("canonical refresh module uses claim/complete/fail RPCs and never /pay", async () => {
  const src = await Deno.readTextFile(
    new URL("./revolutBusinessAccessTokenRefresh.ts", import.meta.url),
  );
  assertStringIncludes(src, "ON_DEMAND_DB_CLAIM_CAS");
  assertStringIncludes(src, "claim_revolut_business_oauth_refresh");
  assertStringIncludes(src, "complete_revolut_business_oauth_refresh");
  assertStringIncludes(src, "fail_revolut_business_oauth_refresh");
  assertStringIncludes(src, "refreshed_via_durable_claim");
  assertStringIncludes(src, "withBusinessGetRetryAfterRefresh");
  assertEquals(src.includes('"/pay"'), false);
  assertEquals(src.includes("/v1/revolut/pay"), false);
  assertEquals(src.includes("relayApprovedDriverPayoutPayment"), false);
  // Direct vault upsert of tokens removed — CAS complete owns persist
  assertEquals(src.includes("upsertVaultSecret"), false);
});

Deno.test("company balance uses canonical ensureFresh (no parallel persistRevolutBusinessTokens refresh)", async () => {
  const src = await Deno.readTextFile(
    new URL("./companyBalanceResolveSSOT.ts", import.meta.url),
  );
  assertStringIncludes(src, "ensureFreshRevolutBusinessAccessToken");
  assertEquals(src.includes("persistRevolutBusinessTokens"), false);
  assertEquals(src.includes("refreshRevolutBusinessAccessToken"), false);
});

Deno.test("migration defines claim/complete/fail with pg_catalog search_path and service_role only", async () => {
  const mig = await Deno.readTextFile(
    new URL(
      "../../migrations/20261022120000_revolut_business_oauth_refresh_ownership.sql",
      import.meta.url,
    ),
  );
  assertStringIncludes(mig, "ON_DEMAND_DB_CLAIM_CAS");
  assertStringIncludes(mig, "SET search_path = pg_catalog");
  assertStringIncludes(mig, "claim_revolut_business_oauth_refresh");
  assertStringIncludes(mig, "complete_revolut_business_oauth_refresh");
  assertStringIncludes(mig, "fail_revolut_business_oauth_refresh");
  assertStringIncludes(mig, "complete_race_after_cas_checks");
  assertStringIncludes(mig, "GRANT EXECUTE");
  assertStringIncludes(mig, "TO service_role");
  assertStringIncludes(mig, "REVOKE ALL");
  assertStringIncludes(mig, "FROM anon, authenticated");
  assertEquals(/\bGRANT EXECUTE\b[\s\S]*\bTO anon\b/.test(mig), false);
  assertStringIncludes(mig, "TO anon, authenticated"); // RLS deny policy targets only
});

Deno.test("pay replay blocked; GET may retry once after refresh", async () => {
  const { classifyPayAuthFailurePolicy, classifyGetAuthFailurePolicy } = await import(
    "./revolutBusinessOAuthContinuitySSOT.ts"
  );
  const pay = classifyPayAuthFailurePolicy({
    revolut_pay_called: true,
    http_status: 401,
    provider_payment_id: null,
  });
  assertEquals(pay.refresh_then_replay_pay, false);
  assertEquals(pay.retry_pay, false);
  const getDesired = classifyGetAuthFailurePolicy(false);
  assertEquals(getDesired.get_retry_max, 1);
  assertEquals(getDesired.refresh_count_max, 1);
});
