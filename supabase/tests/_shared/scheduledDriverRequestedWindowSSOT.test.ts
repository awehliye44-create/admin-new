/**
 * MK-260916-038 RC3: Driver Requested / accept wait for marketplace window.
 *
 * Run: deno test --allow-read supabase/tests/_shared/scheduledDriverRequestedWindowSSOT.test.ts
 */
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const MIGRATION = new URL(
  "../../migrations/20261116232000_scheduled_driver_requested_broadcast_window.sql",
  import.meta.url,
);

Deno.test("RC3: Requested and accept share scheduled_marketplace_is_open", async () => {
  const src = await Deno.readTextFile(MIGRATION);
  assertStringIncludes(src, "CREATE OR REPLACE FUNCTION public.scheduled_marketplace_is_open");
  assertStringIncludes(src, "compute_scheduled_dispatch_anchors");
  assertStringIncludes(
    src,
    "IF v_sched NOT IN ('broadcasting', 'awaiting_confirmation') THEN",
  );
  assertEquals(
    /scheduled_status = ANY \(ARRAY\['broadcasting', 'scheduled', 'awaiting_confirmation'\]\)/
      .test(src),
    false,
    "Requested must not list pre-marketplace scheduled_status=scheduled",
  );
  assertStringIncludes(src, "WHERE public.scheduled_marketplace_is_open(");
  const acceptIdx = src.indexOf("CREATE OR REPLACE FUNCTION public.accept_scheduled_ride");
  assert(acceptIdx > 0, "accept_scheduled_ride must be replaced");
  const acceptSrc = src.slice(acceptIdx);
  assertStringIncludes(acceptSrc, "IF NOT public.scheduled_marketplace_is_open(");
  assertEquals(
    acceptSrc.includes("IF v_trip.scheduled_status NOT IN ('broadcasting', 'scheduled', 'awaiting_confirmation')"),
    false,
    "accept must not allow pre-window scheduled_status=scheduled",
  );
});

Deno.test("RC3: NULL legacy anchors reconstruct from created_at, not now()", async () => {
  const src = await Deno.readTextFile(MIGRATION);
  assertStringIncludes(src, "COALESCE(p_created_at, p_now)");
  assertStringIncludes(src, "Do not treat polluted broadcasting + NULL as immediately visible");
});
