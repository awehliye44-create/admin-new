/**
 * user_safety_contacts migration lock — owner-only RLS.
 * Run: deno test --allow-read supabase/functions/_shared/userSafetyContactsLock.test.ts
 */
import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

const sql = await Deno.readTextFile(
  new URL("../../migrations/20260923120000_user_safety_contacts.sql", import.meta.url),
);

Deno.test("creates the shared auth-user table with expected columns", () => {
  assert(sql.includes("CREATE TABLE IF NOT EXISTS public.user_safety_contacts"));
  assert(sql.includes("user_id uuid NOT NULL REFERENCES auth.users(id)"));
  assert(sql.includes("contact_name text NOT NULL"));
  assert(sql.includes("phone_number text NOT NULL"));
  assert(sql.includes("contact_type IN ('emergency', 'police', 'family', 'friend', 'other')"));
  assert(sql.includes("user_safety_contacts_cap_exceeded"));
});

Deno.test("enforces owner-only RLS via auth.uid()", () => {
  assert(sql.includes("ENABLE ROW LEVEL SECURITY"));
  assert(sql.includes("FORCE ROW LEVEL SECURITY"));
  assert(sql.includes("USING (auth.uid() = user_id)"));
  assert(sql.includes("WITH CHECK (auth.uid() = user_id)"));
  assert(sql.includes("Users select own safety contacts"));
  assert(sql.includes("Users insert own safety contacts"));
  assert(sql.includes("Users update own safety contacts"));
  assert(sql.includes("Users delete own safety contacts"));
  assert(!/has_role\(/.test(sql));
  assert(!/FOR SELECT[\s\S]*USING \(true\)/.test(sql));
  assert(sql.includes("REVOKE ALL ON TABLE public.user_safety_contacts FROM anon"));
});

Deno.test("does not attach contacts to trips or offers", () => {
  assert(!sql.includes("REFERENCES public.trips"));
  assert(!sql.includes("ride_offers"));
});
