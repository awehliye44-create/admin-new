import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  isDriverEligibleForAdminCommissionCredit,
  matchesAdminCommissionCreditDriverSearch,
} from '../../shared/commissionWalletSSOT';

export type CommissionWalletCreditDriver = {
  id: string;
  driver_code: string | null;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  approval_status: string | null;
  driver_status: string | null;
  service_area_id: string | null;
  license_plate: string | null;
  usable_balance_minor: number;
  currency: string;
};

type AdminDriverRow = {
  id: string;
  driver_code: string | null;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  approval_status: string | null;
  driver_status: string | null;
  service_area_id: string | null;
  deleted_at: string | null;
};

type LoadedDriver = Omit<CommissionWalletCreditDriver, 'usable_balance_minor' | 'currency'> & {
  usable_balance_minor?: number;
  currency?: string;
};

/**
 * Loads drivers for Admin Add Credit.
 * Canonical filter only: drivers.service_area_id === selected SA.
 * Never uses trip/GPS/city/junction-only inference.
 */
export function useCommissionWalletCreditDrivers(args: {
  serviceAreaId: string | null;
  includeInactive?: boolean;
  search?: string;
  balancesByDriverId?: Record<string, { usable_minor: number; currency: string }>;
  currencyFallback?: string;
}) {
  const serviceAreaId = args.serviceAreaId;
  const includeInactive = args.includeInactive === true;
  const search = args.search ?? '';
  const balancesByDriverId = args.balancesByDriverId;
  const currencyFallback = args.currencyFallback || 'USD';

  const query = useQuery({
    queryKey: ['cw-credit-drivers', serviceAreaId, includeInactive],
    enabled: Boolean(serviceAreaId),
    queryFn: async (): Promise<LoadedDriver[]> => {
      if (!serviceAreaId) return [];

      const { data: drivers, error } = await supabase.rpc('admin_list_drivers');
      if (error) throw error;

      const eligible = ((drivers ?? []) as AdminDriverRow[]).filter((d) =>
        isDriverEligibleForAdminCommissionCredit({
          approvalStatus: d.approval_status,
          driverStatus: d.driver_status,
          deletedAt: d.deleted_at,
          driverServiceAreaId: d.service_area_id,
          selectedServiceAreaId: serviceAreaId,
          includeInactive,
        }),
      );

      const ids = eligible.map((d) => d.id);
      const plateByDriver = new Map<string, string>();
      if (ids.length > 0) {
        const { data: vehicles } = await supabase
          .from('vehicles')
          .select('driver_id, license_plate, is_primary')
          .in('driver_id', ids);
        for (const v of vehicles ?? []) {
          const driverId = String(v.driver_id);
          const plate = String(v.license_plate ?? '').trim();
          if (!plate) continue;
          if (v.is_primary === true || !plateByDriver.has(driverId)) {
            plateByDriver.set(driverId, plate);
          }
        }
      }

      return eligible
        .map((d) => ({
          id: d.id,
          driver_code: d.driver_code,
          first_name: d.first_name,
          last_name: d.last_name,
          phone: d.phone,
          approval_status: d.approval_status,
          driver_status: d.driver_status,
          service_area_id: d.service_area_id,
          license_plate: plateByDriver.get(d.id) ?? null,
        }))
        .sort((a, b) => {
          const an = `${a.first_name ?? ''} ${a.last_name ?? ''}`.trim().toLowerCase();
          const bn = `${b.first_name ?? ''} ${b.last_name ?? ''}`.trim().toLowerCase();
          return an.localeCompare(bn);
        });
    },
    staleTime: 30_000,
  });

  const allDrivers = useMemo((): CommissionWalletCreditDriver[] => {
    return (query.data ?? []).map((d) => {
      const bal = balancesByDriverId?.[d.id];
      return {
        ...d,
        usable_balance_minor: bal?.usable_minor ?? 0,
        currency: bal?.currency || currencyFallback,
      };
    });
  }, [query.data, balancesByDriverId, currencyFallback]);

  const drivers = useMemo(() => {
    if (!search.trim()) return allDrivers;
    return allDrivers.filter((d) => matchesAdminCommissionCreditDriverSearch(d, search));
  }, [allDrivers, search]);

  return {
    ...query,
    drivers,
    allDrivers,
  };
}

export function commissionWalletCreditDriverLabel(d: CommissionWalletCreditDriver): string {
  const name = `${d.first_name ?? ''} ${d.last_name ?? ''}`.trim();
  if (name && d.driver_code) return `${name} (${d.driver_code})`;
  if (name) return name;
  return d.driver_code || d.id.slice(0, 8);
}
