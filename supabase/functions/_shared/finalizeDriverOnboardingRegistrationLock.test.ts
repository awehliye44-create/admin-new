/**
 * LOCK — finalize_driver_onboarding_registration hardens the existing
 * Driver contract path. Do not deploy until explicitly approved.
 *
 * Run: deno test --allow-read supabase/functions/_shared/finalizeDriverOnboardingRegistrationLock.test.ts
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const MIGRATION = new URL(
  "../../migrations/20261106160000_release_soft_deleted_driver_vehicle_plates.sql",
  import.meta.url,
);

Deno.test("finalize RPC is transactional, idempotent, and ownership-checked", async () => {
  const sql = await Deno.readTextFile(MIGRATION);
  assertEquals(sql.includes("finalize_driver_onboarding_registration"), true);
  assertEquals(sql.includes("SECURITY DEFINER"), true);
  assertEquals(sql.includes("auth.uid()"), true);
  assertEquals(sql.includes("email_confirmed_at"), true);
  assertEquals(sql.includes("phone_confirmed_at"), true);
  assertEquals(sql.includes("ON CONFLICT (user_id)"), true);
  assertEquals(sql.includes("ON CONFLICT (driver_id, service_area_id)"), true);
  assertEquals(sql.includes("DRIVER_OWNERSHIP_CONFLICT"), true);
  assertEquals(sql.includes("VEHICLE_OWNERSHIP_CONFLICT"), true);
  // Soft-deleted drivers must not keep exclusive plate ownership.
  assertEquals(sql.includes("od.deleted_at IS NULL"), true);
  assertEquals(sql.includes("drivers_release_vehicles_on_soft_delete"), true);
  assertEquals(sql.includes("GRANT EXECUTE"), true);
  assertEquals(sql.includes("TO authenticated"), true);
});
