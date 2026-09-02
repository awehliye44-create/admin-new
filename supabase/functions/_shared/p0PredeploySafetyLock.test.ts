import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

async function read(pathFromRepoRoot: string): Promise<string> {
  const repoRoot = new URL("../../../", import.meta.url);
  return await Deno.readTextFile(new URL(pathFromRepoRoot, repoRoot));
}

Deno.test("submit-corporate-account-request forces pending status server-side", async () => {
  const edge = await read("supabase/functions/submit-corporate-account-request/index.ts");
  assertEquals(edge.includes('status: "pending"'), true);
  assertEquals(edge.includes('"user_id"'), true);
  assertEquals(edge.includes('"status"'), true);
  assertEquals(edge.includes("checkRateLimit"), true);
});

Deno.test("corporate migration removes anon INSERT on table", async () => {
  const sql = await read("supabase/migrations/20260831120100_p0_corporate_account_request_edge_only.sql");
  assertEquals(sql.includes("REVOKE INSERT ON TABLE public.corporate_account_requests FROM anon"), true);
  assertEquals(sql.includes("Authenticated self-service INSERT policy preserved"), true);
});

function centralHubPath(rel: string): URL {
  return new URL(`../../../../onecab-central-hub/${rel}`, import.meta.url);
}

Deno.test("corporate web helper invokes submit-corporate-account-request", async () => {
  const lib = await Deno.readTextFile(centralHubPath("src/lib/submitCorporateAccountRequest.ts"));
  assertEquals(lib.includes('invoke("submit-corporate-account-request"'), true);
  assertEquals(lib.includes("corporate_account_requests"), false);
});

Deno.test("corporate web registration uses edge function not direct insert", async () => {
  const index = await Deno.readTextFile(centralHubPath("src/pages/Index.tsx"));
  assertEquals(index.includes("submitCorporateAccountRequest"), true);
  assertEquals(index.includes('from("corporate_account_requests").insert'), false);
});

Deno.test("corporate marketing FAQ does not submit account requests", async () => {
  const faq = await Deno.readTextFile(centralHubPath("src/components/FaqSection.tsx"));
  assertEquals(faq.includes("submitCorporateAccountRequest"), false);
  assertEquals(faq.includes("corporate_account_requests"), false);
  assertEquals(faq.includes("Request a Quote"), false);
});

Deno.test("rollback restores production RPC ACLs deterministically", async () => {
  const rollback = await read("supabase/rollback/p0_security_hardening_rollback_20260831.sql");
  assertEquals(rollback.includes("admin_driver_financial_summaries(uuid,uuid)"), true);
  assertEquals(rollback.includes("GRANT EXECUTE ON FUNCTION public.admin_driver_financial_summaries(uuid,uuid) TO anon"), true);
  assertEquals(rollback.includes("ALTER FUNCTION public.enforce_negotiation_pre_hold_assignment() RESET search_path"), true);
  assertEquals(rollback.includes('CREATE POLICY "Anonymous can submit account requests"'), true);
});

Deno.test("admin refresh preserves economic captured_at on provider re-verify", async () => {
  const edge = await read("supabase/functions/admin-refresh-payment-sessions/index.ts");
  assertEquals(edge.includes("resolvePaymentSessionCaptureAdvanceExtras"), true);
  assertEquals(edge.includes('statusAdvanceExtras.captured_at = nowIso'), false);
});

Deno.test("eligibility migration ignores restamped captured_at for clearing origin", async () => {
  const sql = await read("supabase/migrations/20260930220000_driver_wallet_clearing_origin_restamp_guard.sql");
  assertEquals(sql.includes("driver_wallet_captured_at_restamp_suspect"), true);
  assertEquals(sql.includes("driver_wallet_stable_clearing_origin"), true);
  assertEquals(sql.includes("v_unpaid := GREATEST(0, r.amount_pence - v_allocated)"), true);
  assertEquals(sql.includes("payout_item_status_releases_ledger_allocation"), true);
});

Deno.test("admin finance RPCs enforce internal admin authorization", async () => {
  const repoRoot = new URL("../../../", import.meta.url);
  const summaries = await Deno.readTextFile(
    new URL("supabase/migrations/20260826140000_admin_driver_financial_summaries_rpc.sql", repoRoot),
  );
  const wallet = await Deno.readTextFile(
    new URL("supabase/migrations/20260926121000_admin_driver_wallet_eligibility_balances.sql", repoRoot),
  );
  assertEquals(summaries.includes("has_role(auth.uid(), 'admin'::app_role)"), true);
  assertEquals(wallet.includes("public.is_admin()"), true);
  assertEquals(wallet.includes("staff_profiles"), true);
});
