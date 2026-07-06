import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { DriverOption } from '@/components/finance/DriverSelector';

type AdminDriverRow = {
  id: string;
  driver_code: string | null;
  first_name: string | null;
  last_name: string | null;
  region_id: string | null;
  service_area_id: string | null;
  approval_status: string | null;
  deleted_at: string | null;
  stripe_account_id: string | null;
};

function toDriverOption(row: AdminDriverRow): DriverOption {
  return {
    id: row.id,
    driver_code: row.driver_code,
    first_name: row.first_name,
    last_name: row.last_name,
  };
}

/** Admin driver list — uses admin_list_drivers RPC (bypasses RLS) with correct service-area junction filtering. */
export function useAdminDriverOptions(args?: {
  regionId?: string | null;
  serviceAreaId?: string | null;
  /** When true, only drivers with a Provider account (wallet SSOT scope). */
  stripeConnectOnly?: boolean;
}) {
  const regionId = args?.regionId ?? null;
  const serviceAreaId = args?.serviceAreaId ?? null;
  const stripeConnectOnly = args?.stripeConnectOnly ?? false;

  return useQuery({
    queryKey: ['admin-driver-options', regionId, serviceAreaId, stripeConnectOnly],
    queryFn: async (): Promise<DriverOption[]> => {
      const [{ data: drivers, error: driversError }, junctionRes] = await Promise.all([
        supabase.rpc('admin_list_drivers'),
        serviceAreaId
          ? supabase
            .from('driver_service_areas')
            .select('driver_id')
            .eq('service_area_id', serviceAreaId)
          : Promise.resolve({ data: null, error: null }),
      ]);

      if (driversError) throw driversError;
      if (junctionRes.error) throw junctionRes.error;

      const junctionIds = new Set((junctionRes.data ?? []).map((row) => row.driver_id));

      let list = ((drivers ?? []) as AdminDriverRow[]).filter((d) => {
        if (d.deleted_at) return false;
        if (d.approval_status && d.approval_status !== 'approved') return false;
        if (stripeConnectOnly && !d.stripe_account_id) return false;
        return true;
      });

      if (serviceAreaId) {
        list = list.filter(
          (d) => d.service_area_id === serviceAreaId || junctionIds.has(d.id),
        );
      } else if (regionId) {
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
