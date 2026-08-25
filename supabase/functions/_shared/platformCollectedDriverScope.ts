/**
 * Resolve driver ids that belong to PLATFORM_COLLECTED service areas.
 * Membership is via driver_service_areas (not drivers.service_area_id alone).
 */
// deno-lint-ignore no-explicit-any
type AnySupabase = any;

export async function resolvePlatformCollectedDriverIds(
  supabase: AnySupabase,
  args: {
    service_area_id?: string | null;
    allowed_service_area_ids: readonly string[];
  },
): Promise<string[]> {
  const areaIds = args.service_area_id
    ? [String(args.service_area_id)]
    : [...args.allowed_service_area_ids];
  if (areaIds.length === 0) return [];

  const { data, error } = await supabase
    .from("driver_service_areas")
    .select("driver_id")
    .in("service_area_id", areaIds);
  if (error) throw error;

  return [
    ...new Set(
      (data ?? [])
        .map((row: { driver_id?: string | null }) => String(row.driver_id ?? ""))
        .filter(Boolean),
    ),
  ];
}
