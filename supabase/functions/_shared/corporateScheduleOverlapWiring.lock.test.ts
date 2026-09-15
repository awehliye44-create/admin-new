import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";
import { fromFileUrl } from "https://deno.land/std@0.224.0/path/from_file_url.ts";
import { join } from "https://deno.land/std@0.224.0/path/join.ts";

const REPO_ROOT = fromFileUrl(new URL("../../..", import.meta.url));

Deno.test("corporate overlap edge does not call driver check_schedule_overlap RPC", async () => {
  const src = await Deno.readTextFile(
    join(REPO_ROOT, "supabase/functions/check-corporate-schedule-overlap/index.ts"),
  );
  assert(!src.includes('rpc("check_schedule_overlap"'));
  assert(!src.includes("rpc('check_schedule_overlap'"));
  assert(src.includes("findCorporateScheduleOverlap"));
  assert(src.includes("SCHEDULE_OVERLAP"));
});

Deno.test("A6 lock migration still revokes authenticated execute on driver RPC", async () => {
  const mig = await Deno.readTextFile(
    join(
      REPO_ROOT,
      "supabase/migrations/20261109050000_phase_a6_check_schedule_overlap_execute_lock.sql",
    ),
  );
  assert(mig.includes("REVOKE ALL ON FUNCTION public.check_schedule_overlap"));
  assert(mig.includes("FROM authenticated"));
});
