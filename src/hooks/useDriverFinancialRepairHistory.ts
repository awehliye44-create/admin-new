import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  mapDriverFinancialRepairHistoryRows,
  type DriverFinancialRepairAuditRow,
  type DriverFinancialRepairHistoryDisplayRow,
  type DriverFinancialRepairRequestRow,
  type StaffNameByUserId,
} from '@/lib/driverFinancialRepairHistory';

/**
 * Finance SELECT-only history for Review & repair.
 * Never mutates; no Edge invoke.
 */
export function useDriverFinancialRepairHistory(driverId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['driver-financial-repair-history', driverId],
    enabled: Boolean(driverId) && enabled,
    queryFn: async (): Promise<DriverFinancialRepairHistoryDisplayRow[]> => {
      const id = String(driverId);
      const { data: requests, error: reqErr } = await supabase
        .from('driver_financial_repair_requests')
        .select(
          'id, repair_token, driver_id, trip_id, preview_hash, classification, status, apply_reason, apply_result, created_by_admin_id, applied_by_admin_id, created_at, applied_at, trips(trip_code)',
        )
        .eq('driver_id', id)
        .order('created_at', { ascending: false })
        .limit(40);
      if (reqErr) throw reqErr;

      const { data: audits, error: auditErr } = await supabase
        .from('driver_financial_repair_audit')
        .select(
          'id, event_type, repair_token, preview_hash, driver_id, trip_id, admin_user_id, reason, details, created_at',
        )
        .eq('driver_id', id)
        .order('created_at', { ascending: true })
        .limit(200);
      if (auditErr) throw auditErr;

      const adminIds = new Set<string>();
      for (const row of requests ?? []) {
        if (row.created_by_admin_id) adminIds.add(String(row.created_by_admin_id));
        if (row.applied_by_admin_id) adminIds.add(String(row.applied_by_admin_id));
      }
      for (const row of audits ?? []) {
        if (row.admin_user_id) adminIds.add(String(row.admin_user_id));
      }

      let staffByUserId: StaffNameByUserId = {};
      if (adminIds.size > 0) {
        const { data: staff } = await supabase
          .from('staff_profiles')
          .select('user_id, full_name')
          .in('user_id', [...adminIds]);
        staffByUserId = Object.fromEntries(
          (staff ?? []).map((s) => [String(s.user_id), String(s.full_name ?? '')]),
        );
      }

      return mapDriverFinancialRepairHistoryRows({
        requests: (requests ?? []) as unknown as DriverFinancialRepairRequestRow[],
        audits: (audits ?? []) as unknown as DriverFinancialRepairAuditRow[],
        staffByUserId,
      });
    },
  });
}
