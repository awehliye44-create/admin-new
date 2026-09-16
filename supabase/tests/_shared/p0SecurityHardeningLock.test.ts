/**
 * P0 security hardening lock — staged fail-closed controls must not be softened.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

async function read(pathFromRepoRoot: string): Promise<string> {
  const repoRoot = new URL("../../../", import.meta.url);
  return await Deno.readTextFile(new URL(pathFromRepoRoot, repoRoot));
}

Deno.test("OTP country SSOT migration locks public table read", async () => {
  const sql = await read("supabase/migrations/20260831120000_p0_otp_country_ssot.sql");
  assertEquals(sql.includes('DROP POLICY IF EXISTS "Anyone can read enabled OTP countries"'), true);
  assertEquals(sql.includes("list_enabled_otp_country_codes"), true);
  assertEquals(sql.includes("REVOKE ALL ON TABLE public.otp_allowed_countries FROM anon"), true);
});

Deno.test("corporate migration removes anon insert policy", async () => {
  const sql = await read("supabase/migrations/20260831120100_p0_corporate_account_request_edge_only.sql");
  assertEquals(sql.includes('DROP POLICY IF EXISTS "Anonymous can submit account requests"'), true);
  assertEquals(sql.includes("REVOKE INSERT ON TABLE public.corporate_account_requests FROM anon"), true);
});

Deno.test("search_path migration pins all 11 advisor functions", async () => {
  const sql = await read("supabase/migrations/20260831120200_p0_function_search_path_hardening.sql");
  const required = [
    "enforce_negotiation_pre_hold_assignment",
    "driver_wallet_provider_funds_cleared",
    "is_scheduled_instant_conversion_pending",
    "trg_payout_item_ledger_allocations_immutable",
    "payout_item_status_releases_ledger_allocation",
    "payout_ledger_type_is_payout_eligible",
    "resolve_trip_locked_promotion_pence",
    "trip_promotion_superseded_by_negotiation",
    "resolve_trip_pre_promotion_ride_fare_pence",
    "resolve_trip_negotiated_commissionable_fare_pence",
    "resolve_trip_commissionable_fare_pence",
  ];
  for (const fn of required) {
    assertEquals(sql.includes(fn), true, `missing search_path pin for ${fn}`);
  }
  assertEquals(sql.includes("SET search_path = pg_catalog, public"), true);
  assertEquals(sql.includes("SET search_path = pg_catalog;"), true);
});

Deno.test("RPC audit revokes anon from admin_driver_financial_summaries", async () => {
  const sql = await read("supabase/migrations/20260831120300_p0_rpc_execution_privilege_audit.sql");
  assertEquals(sql.includes("admin_driver_financial_summaries"), true);
  assertEquals(sql.includes("list_enabled_otp_country_codes"), true);
  assertEquals(sql.includes("check_identity_exists"), false);
  assertEquals(sql.includes("upsert_pending_customer_signup"), false);
  assertEquals(sql.includes("REVOKE ALL ON FUNCTION %s FROM anon"), true);
});

Deno.test("OTP edge policies enforce server-side country gate", async () => {
  const customer = await read("supabase/functions/_shared/customerPhoneOtpPolicy.ts");
  const driver = await read("supabase/functions/_shared/driverPhoneOtpPolicy.ts");
  const ssot = await read("supabase/functions/_shared/otpPhoneCountryPolicy.ts");
  assertEquals(ssot.includes("assertOtpPhoneCountryAllowed"), true);
  assertEquals(ssot.includes("fail closed") || ssot.includes("Fail closed"), true);
  assertEquals(customer.includes("assertOtpPhoneCountryAllowed"), true);
  assertEquals(driver.includes("assertOtpPhoneCountryAllowed"), true);
});

Deno.test("submit-corporate-account-request forces pending and rate limits", async () => {
  const edge = await read("supabase/functions/submit-corporate-account-request/index.ts");
  assertEquals(edge.includes('status: "pending"'), true);
  assertEquals(edge.includes("checkRateLimit"), true);
  assertEquals(edge.includes("service_role"), false);
  assertEquals(edge.includes("SUPABASE_SERVICE_ROLE_KEY"), true);
  assertEquals(edge.includes("reviewed_at"), true);
});
