/**
 * Admin page-gated data access (client).
 *
 * Non-Owner UI must use these helpers instead of direct JWT on gated tables.
 * Shared-table RPCs: 20261231130000 (applied). Restrictive RLS: 20261231140000 + 20261231150000 (applied).
 * document-type in-use: 20261231160000 (LOCAL / UNAPPLIED).
 * Catalog RPCs: 20261231170000 (LOCAL / UNAPPLIED). Catalog RLS: 20261231180000 (LOCAL / UNAPPLIED).
 *
 * Owner still works via RPCs (staff_has_page_access treats Owner as all pages)
 * and, after shared fail-closed, via direct table RLS as well.
 */

import { supabase } from '@/integrations/supabase/client';

export type AdminSharedTable =
  | 'trips'
  | 'drivers'
  | 'customers'
  | 'documents'
  | 'vehicles'
  | 'driver_service_areas'
  | 'fare_pricing_settings'
  | 'corporate_fare_rules'
  | 'document_types'
  | 'service_area_document_rules'
  | 'stop_waiting_settings'
  | 'dispatch_settings'
  | 'service_area_cancellation_fees'
  | 'service_area_vehicle_pricing';

export type AdminPageFilterOp =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'is_null'
  | 'not_null'
  | 'ilike'
  | 'in'
  | 'not_in';

export type AdminPageFilter = {
  op: AdminPageFilterOp;
  col: string;
  val?: unknown;
};

export type AdminPageSelectArgs = {
  columns?: string[];
  filters?: AdminPageFilter[];
  /** OR of AND-groups, combined with filters (AND). */
  or_groups?: AdminPageFilter[][];
  /** Extra OR-blocks ANDed with filters/or_groups (PostgREST multi-.or()). */
  and_or_groups?: AdminPageFilter[][][];
  order?: Array<{ col: string; asc?: boolean }>;
  limit?: number;
  offset?: number;
  count_only?: boolean;
  include_count?: boolean;
};

export type AdminPageSelectResult<T = Record<string, unknown>> = {
  rows: T[];
  count: number | null;
};

type RpcClient = {
  rpc: (
    fn: string,
    args?: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message?: string } | null }>;
};

function rpcClient(): RpcClient {
  return supabase as unknown as RpcClient;
}

function asRows<T>(payload: unknown): AdminPageSelectResult<T> {
  const obj = (payload ?? {}) as { rows?: T[]; count?: number | null };
  return {
    rows: Array.isArray(obj.rows) ? obj.rows : [],
    count: typeof obj.count === 'number' ? obj.count : obj.count === null ? null : null,
  };
}

/** Page-gated SELECT for shared tables. */
export async function adminPageSelect<T = Record<string, unknown>>(
  pageSlug: string,
  table: AdminSharedTable,
  args: AdminPageSelectArgs = {},
): Promise<AdminPageSelectResult<T>> {
  const { data, error } = await rpcClient().rpc('admin_page_select', {
    p_page_slug: pageSlug,
    p_table: table,
    p_args: args,
  });
  if (error) throw error;
  return asRows<T>(data);
}

/** Page-gated mutate (update / insert / delete). Trips: insert=manual-trip; update=scheduled-rides|…. */
export async function adminPageMutate<T = Record<string, unknown>>(
  pageSlug: string,
  table: AdminSharedTable,
  op: 'update' | 'insert' | 'delete',
  args: {
    id?: string;
    ids?: string[];
    patch?: Record<string, unknown>;
    filters?: AdminPageFilter[];
    or_groups?: AdminPageFilter[][];
    and_or_groups?: AdminPageFilter[][][];
  },
): Promise<{ row?: T | null; rows?: T[]; deleted?: number }> {
  const { data, error } = await rpcClient().rpc('admin_page_mutate', {
    p_page_slug: pageSlug,
    p_table: table,
    p_op: op,
    p_args: args,
  });
  if (error) throw error;
  return (data ?? {}) as { row?: T | null; rows?: T[]; deleted?: number };
}

export async function adminLookupByIds<T = Record<string, unknown>>(
  pageSlug: string,
  table: AdminSharedTable,
  ids: string[],
  columns: string[],
): Promise<T[]> {
  const unique = Array.from(new Set(ids.filter(Boolean)));
  if (unique.length === 0) return [];
  const out: T[] = [];
  const CHUNK = 200;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    const { rows } = await adminPageSelect<T>(pageSlug, table, {
      columns,
      filters: [{ op: 'in', col: 'id', val: chunk }],
      limit: chunk.length,
    });
    out.push(...rows);
  }
  return out;
}

export async function adminListRidersPage(args: {
  status?: string;
  search?: string;
  limit?: number;
  offset?: number;
  id?: string;
  count_only?: boolean;
  min_trip_count?: number;
  created_gte?: string;
}): Promise<AdminPageSelectResult> {
  const { data, error } = await rpcClient().rpc('admin_list_riders_page', {
    p_args: args,
  });
  if (error) throw error;
  return asRows(data);
}

export async function adminDashboardPeriodStatsRpc(args: {
  startIso: string;
  endIso: string;
  serviceAreaId: string | 'all';
}): Promise<Record<string, unknown>> {
  const { data, error } = await rpcClient().rpc('admin_dashboard_period_stats', {
    p_start: args.startIso,
    p_end: args.endIso,
    p_service_area_id: args.serviceAreaId,
  });
  if (error) throw error;
  return (data ?? {}) as Record<string, unknown>;
}

export async function adminDashboardChartRowsRpc(args: {
  startIso: string;
  endIso: string;
  serviceAreaId: string | 'all';
  limit?: number;
}): Promise<Array<{ status: string | null; created_at: string }>> {
  const { data, error } = await rpcClient().rpc('admin_dashboard_chart_rows', {
    p_start: args.startIso,
    p_end: args.endIso,
    p_service_area_id: args.serviceAreaId,
    p_limit: args.limit ?? 2000,
  });
  if (error) throw error;
  return (Array.isArray(data) ? data : []) as Array<{
    status: string | null;
    created_at: string;
  }>;
}

export async function adminSidebarBadgeCountsRpc(): Promise<{
  activeTrips: number;
  scheduledRides: number;
  pendingFeedback: number;
  pendingDocuments: number;
  activePromoCodes: number;
  pendingAccountRequests: number;
  pendingDrivers: number;
  pendingVehicleChanges: number;
}> {
  const { data, error } = await rpcClient().rpc('admin_sidebar_badge_counts');
  if (error) throw error;
  const d = (data ?? {}) as Record<string, number>;
  return {
    activeTrips: d.activeTrips ?? 0,
    scheduledRides: d.scheduledRides ?? 0,
    pendingFeedback: d.pendingFeedback ?? 0,
    pendingDocuments: d.pendingDocuments ?? 0,
    activePromoCodes: d.activePromoCodes ?? 0,
    pendingAccountRequests: d.pendingAccountRequests ?? 0,
    pendingDrivers: d.pendingDrivers ?? 0,
    pendingVehicleChanges: d.pendingVehicleChanges ?? 0,
  };
}

/**
 * document-management only: whether any documents row references this type
 * (by document_type_id or legacy document_type slug). Server asserts page grant;
 * does not weaken documents Owner-only RLS.
 */
export async function adminDocumentTypeInUse(documentTypeId: string): Promise<boolean> {
  const { data, error } = await rpcClient().rpc('admin_document_type_in_use', {
    p_document_type_id: documentTypeId,
  });
  if (error) throw error;
  return data === true;
}

/** Page-gated service_areas label/filter lookup (region currency join). */
export async function adminServiceAreasLookup<T = Record<string, unknown>>(
  pageSlug: string,
  args: {
    active_only?: boolean;
    include_archived?: boolean;
    ids?: string[];
    limit?: number;
  } = {},
): Promise<AdminPageSelectResult<T>> {
  const { data, error } = await rpcClient().rpc('admin_service_areas_lookup', {
    p_page_slug: pageSlug,
    p_args: args,
  });
  if (error) throw error;
  return asRows<T>(data);
}

/** Convert a simple PostgREST-ish `.in('status', vals)` style list to filters. */
export function eqFilter(col: string, val: unknown): AdminPageFilter {
  return { op: 'eq', col, val };
}
export function inFilter(col: string, val: unknown[]): AdminPageFilter {
  return { op: 'in', col, val };
}
export function isNullFilter(col: string): AdminPageFilter {
  return { op: 'is_null', col };
}
export function notNullFilter(col: string): AdminPageFilter {
  return { op: 'not_null', col };
}
