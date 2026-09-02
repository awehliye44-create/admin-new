import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  DRIVER_WALLET_ADJUSTMENT_REASON_LABELS,
  driverWalletAdminAdjustmentsDeployed,
  type DriverWalletAdjustmentReasonCategory,
} from '../../shared/driverWalletManualAdjustmentSSOT';

export type DriverWalletAdminAdjustmentRow = {
  id: string;
  status: string;
  direction: string;
  amount_pence: number;
  signed_amount_pence: number | null;
  reason_category: string;
  reason_note: string;
  evidence_reference: string | null;
  ledger_type: string;
  related_trip_id: string | null;
  related_payout_item_id: string | null;
  created_by_admin_id: string;
  approved_by_admin_id: string | null;
  rejected_by_admin_id: string | null;
  ledger_entry_id: string | null;
  created_at: string;
  applied_at: string | null;
  rejected_at: string | null;
};

export function useDriverWalletAdminAdjustments(driverId: string | null | undefined) {
  const deployed = driverWalletAdminAdjustmentsDeployed();
  return useQuery({
    queryKey: ['driver-wallet-admin-adjustments', driverId, deployed],
    queryFn: async () => {
      if (!deployed) return [] as DriverWalletAdminAdjustmentRow[];
      const { data, error } = await supabase
        .from('driver_wallet_admin_adjustments' as 'driver_wallet_ledger')
        .select(
          'id, status, direction, amount_pence, signed_amount_pence, reason_category, reason_note, evidence_reference, ledger_type, related_trip_id, related_payout_item_id, created_by_admin_id, approved_by_admin_id, rejected_by_admin_id, ledger_entry_id, created_at, applied_at, rejected_at',
        )
        .eq('driver_id', driverId!)
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as unknown as DriverWalletAdminAdjustmentRow[];
    },
    enabled: Boolean(driverId) && deployed,
    staleTime: 15_000,
  });
}

export function driverWalletAdminAdjustmentReasonLabel(category: string): string {
  return DRIVER_WALLET_ADJUSTMENT_REASON_LABELS[category as DriverWalletAdjustmentReasonCategory]
    ?? category;
}
