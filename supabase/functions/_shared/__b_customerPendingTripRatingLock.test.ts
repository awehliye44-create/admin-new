/**
 * Lock: Customer pending Rate Your Trip SSOT is get_customer_pending_trip_rating.
 * rider_feedback only — never passenger_ratings. Oldest completed first.
 *
 * Run: deno test --allow-read supabase/functions/_shared/customerPendingTripRatingLock.test.ts
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const sqlPath = new URL(
  "../../migrations/20260927210000_customer_pending_trip_rating_ssot.sql",
  import.meta.url,
);

Deno.test("pending rating RPC is auth.uid customer-owned completed minus rider_feedback", async () => {
  const sql = await Deno.readTextFile(sqlPath);
  assertStringIncludes(sql, "CREATE OR REPLACE FUNCTION public.get_customer_pending_trip_rating()");
  assertStringIncludes(sql, "v_uid uuid := auth.uid()");
  assertStringIncludes(sql, "WHERE c.user_id = v_uid");
  assertStringIncludes(sql, "t.passenger_id = v_customer_id");
  assertStringIncludes(sql, "lower(t.status::text) = 'completed'");
  assertStringIncludes(sql, "FROM public.rider_feedback rf");
  assertStringIncludes(sql, "rf.customer_id = v_customer_id");
  assertStringIncludes(sql, "ORDER BY COALESCE(t.completed_at, t.updated_at, t.created_at) ASC NULLS LAST");
  assertEquals(sql.includes("FROM public.passenger_ratings"), false);
  assertEquals(sql.includes("driver_passenger_rating"), false);
  assertEquals(sql.includes("payment_status"), false);
  assertEquals(sql.includes("INSERT INTO public.rider_feedback"), false);
  assertEquals(sql.includes("UPDATE public.trips"), false);
});
