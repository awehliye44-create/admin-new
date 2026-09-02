/**
 * Resolve driver ids that belong to PLATFORM_COLLECTED service areas.
 * Membership is via driver_service_areas (not drivers.service_area_id alone).
 */
import {
  FINANCIAL_MODEL,
  filterServiceAreasByFinancialModel,
} from "../../../shared/financialModelScopeSSOT.ts";

// deno-lint-ignore no-explicit-any
type AnySupabase = any;

/** All service areas stamped PLATFORM_COLLECTED (global company-funds liability scope). */
export async function loadPlatformCollectedServiceAreaIds(
  supabase: AnySupabase,
): Promise<string[]> {
  const { data, error } = await supabase
    .from("service_areas")
    .select("id, financial_model");
  if (error) throw error;
  return filterServiceAreasByFinancialModel(
    (data ?? []) as { id: string; financial_model?: unknown }[],
    FINANCIAL_MODEL.PLATFORM_COLLECTED,
  ).map((sa) => sa.id);
}

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
