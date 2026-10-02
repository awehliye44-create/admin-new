/**
 * Campaign audience — global / users / region / service_area.
 * Drivers filter on drivers.service_area_id.
 * Customers have no home SA column; region/SA uses distinct trip passengers.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";

export type CampaignAudienceRow = {
  target_scope: string | null;
  target_app?: string | null;
  target_region_id: string | null;
  target_service_area_id: string | null;
  target_user_ids: unknown;
  target_user_segment?: string | null;
};

export type CampaignAudience =
  | { ok: true; scope: "global" }
  | { ok: true; scope: "users"; userIds: string[] }
  | { ok: true; scope: "geo"; serviceAreaIds: string[]; regionId: string | null }
  | { ok: false; error: string };

function uuidList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((id): id is string => typeof id === "string" && id.length > 0);
}

export function chunkIds(ids: string[], size = 200): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += size) {
    chunks.push(ids.slice(i, i + size));
  }
  return chunks.length ? chunks : [];
}

/** Accept auth user ids, customers.id, or drivers.id — expand to auth.users ids. */
export async function normalizeCampaignTargetUserIds(
  supabase: SupabaseClient,
  rawIds: string[],
): Promise<string[]> {
  const out = new Set<string>();
  for (const id of rawIds) {
    if (id) out.add(id);
  }
  for (const chunk of chunkIds(rawIds)) {
    const [
      { data: customersByUser, error: cUserErr },
      { data: customersById, error: cIdErr },
      { data: driversByUser, error: dUserErr },
      { data: driversById, error: dIdErr },
    ] = await Promise.all([
      supabase.from("customers").select("user_id").in("user_id", chunk).is("deleted_at", null),
      supabase.from("customers").select("user_id").in("id", chunk).is("deleted_at", null),
      supabase.from("drivers").select("user_id").in("user_id", chunk).is("deleted_at", null),
      supabase.from("drivers").select("user_id").in("id", chunk).is("deleted_at", null),
    ]);
    if (cUserErr) throw cUserErr;
    if (cIdErr) throw cIdErr;
    if (dUserErr) throw dUserErr;
    if (dIdErr) throw dIdErr;
    for (const row of customersByUser ?? []) {
      if (row.user_id) out.add(row.user_id);
    }
    for (const row of customersById ?? []) {
      if (row.user_id) out.add(row.user_id);
    }
    for (const row of driversByUser ?? []) {
      if (row.user_id) out.add(row.user_id);
    }
    for (const row of driversById ?? []) {
      if (row.user_id) out.add(row.user_id);
    }
  }
  return [...out];
}

/** Keep users-scope IDs that match the campaign target app (auth user ids). */
export async function filterCampaignUserIdsForTargetApp(
  supabase: SupabaseClient,
  userIds: string[],
  targetApp: string | null | undefined,
): Promise<string[]> {
  if (userIds.length === 0) return [];
  const app = (targetApp ?? "customer").trim();
  if (app === "both") {
    const allowed = new Set<string>();
    for (const chunk of chunkIds(userIds)) {
      const [{ data: customers, error: cErr }, { data: drivers, error: dErr }] =
        await Promise.all([
          supabase.from("customers").select("user_id").in("user_id", chunk).is("deleted_at", null),
          supabase.from("drivers").select("user_id").in("user_id", chunk).is("deleted_at", null),
        ]);
      if (cErr) throw cErr;
      if (dErr) throw dErr;
      for (const row of [...(customers ?? []), ...(drivers ?? [])]) {
        if (row.user_id) allowed.add(row.user_id);
      }
    }
    return userIds.filter((id) => allowed.has(id));
  }

  const allowed = new Set<string>();
  for (const chunk of chunkIds(userIds)) {
    if (app === "customer") {
      const { data, error } = await supabase
        .from("customers")
        .select("user_id")
        .in("user_id", chunk)
        .is("deleted_at", null);
      if (error) throw error;
      for (const row of data ?? []) {
        if (row.user_id) allowed.add(row.user_id);
      }
    } else if (app === "driver") {
      const { data, error } = await supabase
        .from("drivers")
        .select("user_id")
        .in("user_id", chunk)
        .is("deleted_at", null);
      if (error) throw error;
      for (const row of data ?? []) {
        if (row.user_id) allowed.add(row.user_id);
      }
    }
  }
  return userIds.filter((id) => allowed.has(id));
}

export async function listActiveCustomerUserIds(
  supabase: SupabaseClient,
  filterUserIds: string[] | null,
): Promise<string[]> {
  if (filterUserIds && filterUserIds.length === 0) return [];
  const out: string[] = [];

  if (filterUserIds) {
    for (const chunk of chunkIds(filterUserIds)) {
      const { data, error } = await supabase
        .from("customer_active_devices")
        .select("user_id")
        .in("user_id", chunk);
      if (error) throw error;
      for (const row of data ?? []) {
        if (row?.user_id) out.push(row.user_id);
      }
    }
    return [...new Set(out)];
  }

  const page = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("customer_active_devices")
      .select("user_id")
      .order("user_id", { ascending: true })
      .range(from, from + page - 1);
    if (error) throw error;
    const rows = data ?? [];
    for (const row of rows) {
      if (row?.user_id) out.push(row.user_id);
    }
    if (rows.length < page) break;
    from += page;
  }
  return [...new Set(out)];
}

export async function listActiveDriverIds(
  supabase: SupabaseClient,
  filterDriverIds: string[] | null,
): Promise<string[]> {
  if (filterDriverIds && filterDriverIds.length === 0) return [];
  const out: string[] = [];

  if (filterDriverIds) {
    for (const chunk of chunkIds(filterDriverIds)) {
      const { data, error } = await supabase
        .from("driver_active_devices")
        .select("driver_id")
        .in("driver_id", chunk);
      if (error) throw error;
      for (const row of data ?? []) {
        if (row?.driver_id) out.push(row.driver_id);
      }
    }
    return [...new Set(out)];
  }

  const page = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("driver_active_devices")
      .select("driver_id")
      .order("driver_id", { ascending: true })
      .range(from, from + page - 1);
    if (error) throw error;
    const rows = data ?? [];
    for (const row of rows) {
      if (row?.driver_id) out.push(row.driver_id);
    }
    if (rows.length < page) break;
    from += page;
  }
  return [...new Set(out)];
}


export async function resolveCampaignAudience(
  supabase: SupabaseClient,
  campaign: CampaignAudienceRow,
): Promise<CampaignAudience> {
  const scope = (campaign.target_scope ?? "global").trim();
  const segment = (campaign.target_user_segment ?? "").trim();
  if (segment) {
    return {
      ok: false,
      error: "target_user_segment is not supported for delivery — leave it empty",
    };
  }

  if (scope === "users") {
    const userIds = uuidList(campaign.target_user_ids);
    if (userIds.length === 0) {
      return { ok: false, error: "target_user_ids required when target_scope is users" };
    }
    const normalized = await normalizeCampaignTargetUserIds(supabase, userIds);
    const filtered = await filterCampaignUserIdsForTargetApp(
      supabase,
      normalized,
      campaign.target_app,
    );
    if (filtered.length === 0) {
      return {
        ok: false,
        error: "No matching users for target app — check user IDs and target app",
      };
    }
    return { ok: true, scope: "users", userIds: filtered };
  }

  if (scope === "service_area") {
    const saId = campaign.target_service_area_id?.trim() ?? "";
    if (!saId) {
      return { ok: false, error: "target_service_area_id required when target_scope is service_area" };
    }
    return { ok: true, scope: "geo", serviceAreaIds: [saId], regionId: null };
  }

  if (scope === "region") {
    const regionId = campaign.target_region_id?.trim() ?? "";
    if (!regionId) {
      return { ok: false, error: "target_region_id required when target_scope is region" };
    }
    const { data, error } = await supabase
      .from("service_areas")
      .select("id")
      .eq("region_id", regionId)
      .order("id", { ascending: true });
    if (error) return { ok: false, error: error.message };
    return {
      ok: true,
      scope: "geo",
      serviceAreaIds: (data ?? []).map((row) => row.id).filter(Boolean),
      regionId,
    };
  }

  return { ok: true, scope: "global" };
}

export async function resolveDriverIdsForAudience(
  supabase: SupabaseClient,
  audience: CampaignAudience,
): Promise<string[] | null> {
  if (!audience.ok) return [];
  if (audience.scope === "global") return null;

  if (audience.scope === "users") {
    const ids: string[] = [];
    for (const chunk of chunkIds(audience.userIds)) {
      const [{ data: byUser, error: byUserErr }, { data: byId, error: byIdErr }] =
        await Promise.all([
          supabase.from("drivers").select("id").in("user_id", chunk).is("deleted_at", null),
          supabase.from("drivers").select("id").in("id", chunk).is("deleted_at", null),
        ]);
      if (byUserErr) throw byUserErr;
      if (byIdErr) throw byIdErr;
      for (const row of [...(byUser ?? []), ...(byId ?? [])]) {
        if (row.id) ids.push(row.id);
      }
    }
    return [...new Set(ids)];
  }

  if (audience.serviceAreaIds.length === 0 && !audience.regionId) return [];
  const ids = new Set<string>();
  const page = 1000;
  for (const chunk of chunkIds(audience.serviceAreaIds)) {
    let from = 0;
    for (;;) {
      const { data, error } = await supabase
        .from("drivers")
        .select("id")
        .in("service_area_id", chunk)
        .is("deleted_at", null)
        .order("id", { ascending: true })
        .range(from, from + page - 1);
      if (error) throw error;
      const rows = data ?? [];
      for (const row of rows) {
        if (row.id) ids.add(row.id);
      }
      if (rows.length < page) break;
      from += page;
    }
  }
  // drivers.service_area_id can be null; region_id is the fallback for region campaigns.
  if (audience.regionId) {
    let from = 0;
    for (;;) {
      const { data, error } = await supabase
        .from("drivers")
        .select("id")
        .eq("region_id", audience.regionId)
        .is("deleted_at", null)
        .order("id", { ascending: true })
        .range(from, from + page - 1);
      if (error) throw error;
      const rows = data ?? [];
      for (const row of rows) {
        if (row.id) ids.add(row.id);
      }
      if (rows.length < page) break;
      from += page;
    }
  }
  return [...ids];
}

export async function resolveCustomerUserIdsForAudience(
  supabase: SupabaseClient,
  audience: CampaignAudience,
): Promise<string[] | null> {
  if (!audience.ok) return [];
  if (audience.scope === "global") return null;
  if (audience.scope === "users") return audience.userIds;
  if (audience.serviceAreaIds.length === 0) return [];

  const passengerIds = new Set<string>();
  const since = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();
  for (const chunk of chunkIds(audience.serviceAreaIds)) {
    const page = 1000;
    let from = 0;
    for (;;) {
      const { data: trips, error: tripErr } = await supabase
        .from("trips")
        .select("passenger_id")
        .in("service_area_id", chunk)
        .not("passenger_id", "is", null)
        .gte("created_at", since)
        .order("id", { ascending: true })
        .range(from, from + page - 1);
      if (tripErr) throw tripErr;
      const rows = trips ?? [];
      for (const row of rows) {
        if (typeof row.passenger_id === "string" && row.passenger_id) {
          passengerIds.add(row.passenger_id);
        }
      }
      if (rows.length < page) break;
      from += page;
    }
  }
  if (passengerIds.size === 0) return [];

  const userIds = new Set<string>();
  for (const chunk of chunkIds([...passengerIds])) {
    const { data: customers, error: custErr } = await supabase
      .from("customers")
      .select("user_id")
      .in("id", chunk)
      .is("deleted_at", null);
    if (custErr) throw custErr;
    for (const row of customers ?? []) {
      if (typeof row.user_id === "string" && row.user_id) userIds.add(row.user_id);
    }
  }
  return [...userIds];
}
