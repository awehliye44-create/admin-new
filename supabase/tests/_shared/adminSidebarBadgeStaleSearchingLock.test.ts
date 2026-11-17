/**
 * Lock: admin_sidebar_badge_counts must exclude unassigned searching trips
 * past searching_expires_at — same defense-in-depth as filterAdminActiveTrips.
 *
 * Run:
 *   deno test --allow-read supabase/tests/_shared/adminSidebarBadgeStaleSearchingLock.test.ts
 *
 * If this fails, fix the code — never delete or soften the lock.
 */
import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { fromFileUrl } from "https://deno.land/std@0.224.0/path/from_file_url.ts";
import { join } from "https://deno.land/std@0.224.0/path/join.ts";

const REPO_ROOT = fromFileUrl(new URL("../../..", import.meta.url));

async function read(rel: string): Promise<string> {
  return await Deno.readTextFile(join(REPO_ROOT, rel));
}

const MIGRATION =
  "supabase/migrations/20270225210000_admin_sidebar_badge_exclude_stale_searching.sql";

Deno.test("admin sidebar badge excludes stale searching (lock)", async () => {
  const sql = await read(MIGRATION);
  const filter = await read("src/lib/adminActiveTripFilter.ts");

  assertStringIncludes(sql, "CREATE OR REPLACE FUNCTION public.admin_sidebar_badge_counts()");
  assertStringIncludes(sql, "searching_expires_at");
  assertStringIncludes(sql, "t.searching_expires_at < now()");
  assertStringIncludes(sql, "t.driver_id IS NULL");
  assertStringIncludes(sql, "t.status = 'searching'");

  // Client board filter remains the list SSOT; badge must stay aligned.
  assert(filter.includes("isAdminStaleSearchingTrip"));
  assert(filter.includes("filterAdminActiveTrips"));
  assert(filter.includes("searching_expires_at"));
});
