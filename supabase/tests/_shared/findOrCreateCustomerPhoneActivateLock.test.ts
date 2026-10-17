/**
 * LOCK — find_or_create_customer must activate when Auth phone is confirmed.
 * Drivers (and any verified identity) may register as Customer; phone is the
 * only gate. Never leave sticky pending_verification + email_verified=false
 * after phone verify (Admin "Pending Verification" false positive).
 *
 * If this fails, fix the migration/function — never delete or soften the lock.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fromFileUrl } from "https://deno.land/std@0.224.0/path/mod.ts";
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const root = join(fromFileUrl(new URL("../../functions/_shared", import.meta.url)), "../../..");

function read(rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

Deno.test("find_or_create_customer activates when phone confirmed — no email gate", () => {
  const src = read(
    "supabase/migrations/20261218120000_find_or_create_customer_activate_when_phone_verified.sql",
  );
  assert(src.includes("CREATE OR REPLACE FUNCTION public.find_or_create_customer"));
  assert(src.includes("phone_confirmed_at"));
  assert(src.includes("v_phone_ok"));
  assert(src.includes("no email-verification gate") || src.includes("no email gate"));
  assert(src.includes("WHEN v_phone_ok THEN 'active'"));
  // Must not invent sticky pending for phone-verified identities.
  assertEquals(src.includes("|| \"000000\""), false);
  // Must still leave pending when phone is not confirmed.
  assert(src.includes("'pending_verification'"));
});
