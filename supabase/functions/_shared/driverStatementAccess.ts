import type { AnySupabaseClient } from "./supabaseClientTypes.ts";

/**
 * Driver-facing earnings statements (driver-invoices, driver-statement-pdf) are only
 * for drivers who are still approved and not removed. Mirrors the database check
 * `current_approved_driver_id()` used by the statement and invoice read rules.
 */
export async function loadStatementDriver(
  supabase: AnySupabaseClient,
  userId: string,
): Promise<{ id: string; region_id: string | null } | null> {
  const { data, error } = await supabase
    .from("drivers")
    .select("id, region_id, approval_status, driver_status, deleted_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as {
    id: string;
    region_id: string | null;
    approval_status: string | null;
    driver_status: string | null;
    deleted_at: string | null;
  };
  if (row.approval_status !== "approved") return null;
  if (row.deleted_at || row.driver_status === "deleted") return null;
  return { id: row.id, region_id: row.region_id };
}
