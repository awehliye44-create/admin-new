import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { DriverOption } from '@/components/finance/DriverSelector';
import {
  FINANCIAL_MODEL,
  type FinancialModel,
  normaliseServiceAreaFinancialModel,
} from '../../shared/financialModelScopeSSOT';

type AdminDriverRow = {
  id: string;
  driver_code: string | null;
  first_name: string | null;
  last_name: string | null;
  region_id: string | null;
  service_area_id: string | null;
  approval_status: string | null;
  deleted_at: string | null;
  payouts_enabled?: boolean | null;
};

function toDriverOption(row: AdminDriverRow): DriverOption {
  return {
    id: row.id,
    driver_code: row.driver_code,
    first_name: row.first_name,
    last_name: row.last_name,
  };
}

/** Admin driver list — uses admin_list_drivers RPC with page-gated DSA / SA filters. */
export function useAdminDriverOptions(args: {
  /** Exact page grant for DSA / service_areas lookups. */
  pageSlug: string;
  regionId?: string | null;
  serviceAreaId?: string | null;
  /** When true, only drivers with payouts enabled. */
  payoutsEnabledOnly?: boolean;
  /**
   * When set, only drivers belonging to service areas of this financial model.
   * PLATFORM pages (Payout Ledger Settings) must pass PLATFORM_COLLECTED.
   */
  financialModel?: FinancialModel | null;
}) {
  const pageSlug = args.pageSlug;
  const regionId = args.regionId ?? null;
  const serviceAreaId = args.serviceAreaId ?? null;
  const payoutsEnabledOnly = args.payoutsEnabledOnly ?? false;
  const financialModel = args.financialModel ?? null;

  return useQuery({
    queryKey: ['admin-driver-options', pageSlug, regionId, serviceAreaId, payoutsEnabledOnly, financialModel],
    queryFn: async (): Promise<DriverOption[]> => {
      const { adminPageSelect, adminServiceAreasLookup } = await import('@/lib/adminPageGatedData');
      const [{ data: drivers, error: driversError }, junctionRows, areasRows] = await Promise.all([
        supabase.rpc('admin_list_drivers'),
        serviceAreaId || financialModel
          ? adminPageSelect<{ driver_id: string; service_area_id?: string }>(
              pageSlug,
              'driver_service_areas',
              {
                columns: serviceAreaId ? ['driver_id'] : ['driver_id', 'service_area_id'],
                filters: serviceAreaId
                  ? [{ op: 'eq', col: 'service_area_id', val: serviceAreaId }]
                  : undefined,
                limit: 5000,
              },
            ).then((r) => r.rows)
          : Promise.resolve([] as Array<{ driver_id: string; service_area_id?: string }>),
        financialModel
          ? adminServiceAreasLookup<{ id: string; financial_model?: unknown }>(pageSlug, {
              include_archived: true,
            }).then((r) => r.rows)
          : Promise.resolve([] as Array<{ id: string; financial_model?: unknown }>),
      ]);

      if (driversError) throw driversError;

      const modelAllowedSaIds = financialModel
        ? new Set(
          areasRows
            .filter((sa) => normaliseServiceAreaFinancialModel(sa.financial_model) === financialModel)
            .map((sa) => sa.id),
        )
        : null;

      const junctionIds = new Set(
        junctionRows
          .filter((row) => {
            if (!modelAllowedSaIds) return true;
            if (serviceAreaId) return true;
            return modelAllowedSaIds.has(String(row.service_area_id ?? ''));
          })
          .map((row) => row.driver_id),
      );

      let list = ((drivers ?? []) as AdminDriverRow[]).filter((d) => {
        if (d.deleted_at) return false;
        if (d.approval_status && d.approval_status !== 'approved') return false;
        if (payoutsEnabledOnly && d.payouts_enabled === false) return false;
        return true;
      });

      if (serviceAreaId) {
        list = list.filter(
          (d) => d.service_area_id === serviceAreaId || junctionIds.has(d.id),
        );
        if (modelAllowedSaIds && !modelAllowedSaIds.has(serviceAreaId)) {
          list = [];
        }
      } else if (financialModel && modelAllowedSaIds) {
        list = list.filter(
          (d) =>
            junctionIds.has(d.id)
            || (d.service_area_id != null && modelAllowedSaIds.has(d.service_area_id)),
        );
      } else if (regionId) {
        list = list.filter((d) => d.region_id === regionId);
      }

      if (regionId && !serviceAreaId) {
        list = list.filter((d) => d.region_id === regionId);
      }

      list.sort((a, b) => {
        const an = `${a.first_name ?? ''} ${a.last_name ?? ''}`.trim().toLowerCase();
        const bn = `${b.first_name ?? ''} ${b.last_name ?? ''}`.trim().toLowerCase();
        return an.localeCompare(bn);
      });

      return list.map(toDriverOption);
    },
    staleTime: 60_000,
  });
}

export { FINANCIAL_MODEL };

export function findDriverOption(options: DriverOption[], driverId: string | null | undefined): DriverOption | null {
  if (!driverId) return null;
  return options.find((d) => d.id === driverId) ?? null;
}

export function filterDriverOptions(options: DriverOption[], search: string, limit = 25): DriverOption[] {
  const q = search.trim().toLowerCase();
  if (!q) return options.slice(0, limit);
  return options
    .filter((d) => {
      const name = `${d.first_name ?? ''} ${d.last_name ?? ''}`.trim().toLowerCase();
      const code = (d.driver_code ?? '').toLowerCase();
      return name.includes(q) || code.includes(q) || d.id.toLowerCase().startsWith(q);
    })
    .slice(0, limit);
}
