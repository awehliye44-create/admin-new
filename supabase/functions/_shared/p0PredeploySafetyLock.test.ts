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

Deno.test("corporate web ContactSection uses edge function not direct insert", async () => {
  const contact = await Deno.readTextFile(centralHubPath("src/components/ContactSection.tsx"));
  assertEquals(contact.includes("submitCorporateAccountRequest"), true);
  assertEquals(contact.includes('from("corporate_account_requests").insert'), false);
});

Deno.test("corporate web helper invokes submit-corporate-account-request", async () => {
  const lib = await Deno.readTextFile(centralHubPath("src/lib/submitCorporateAccountRequest.ts"));
  assertEquals(lib.includes('invoke("submit-corporate-account-request"'), true);
  assertEquals(lib.includes("corporate_account_requests"), false);
});

Deno.test("rollback restores production RPC ACLs deterministically", async () => {
  const rollback = await read("supabase/rollback/p0_security_hardening_rollback_20260831.sql");
  assertEquals(rollback.includes("admin_driver_financial_summaries(uuid,uuid)"), true);
  assertEquals(rollback.includes("GRANT EXECUTE ON FUNCTION public.admin_driver_financial_summaries(uuid,uuid) TO anon"), true);
  assertEquals(rollback.includes("ALTER FUNCTION public.enforce_negotiation_pre_hold_assignment() RESET search_path"), true);
  assertEquals(rollback.includes('CREATE POLICY "Anonymous can submit account requests"'), true);
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
