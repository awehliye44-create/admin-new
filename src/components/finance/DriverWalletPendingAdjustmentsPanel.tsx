import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { formatNullablePence } from '@/lib/formatNullablePence';
import {
  DRIVER_WALLET_ADJUSTMENT_REASON_LABELS,
  type DriverWalletAdjustmentReasonCategory,
} from '../../../shared/driverWalletManualAdjustmentSSOT';
import { toast } from 'sonner';
import { useStaffProfile } from '@/hooks/useStaffProfile';

type PendingAdjustment = {
  id: string;
  status: string;
  direction: string;
  amount_pence: number;
  reason_category: string;
  reason_note: string;
  requires_owner_approval: boolean;
  approval_reason_codes: string[] | null;
  created_at: string;
  created_by_admin_id: string;
};

export function DriverWalletPendingAdjustmentsPanel({
  driverId,
  currencyCode = 'GBP',
}: {
  driverId: string;
  currencyCode?: string;
}) {
  const queryClient = useQueryClient();
  const { isOwner } = useStaffProfile();

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['driver-wallet-pending-adjustments', driverId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('driver_wallet_admin_adjustments')
        .select(
          'id, status, direction, amount_pence, reason_category, reason_note, requires_owner_approval, approval_reason_codes, created_at, created_by_admin_id',
        )
        .eq('driver_id', driverId)
        .in('status', ['PENDING_APPROVAL', 'REJECTED'])
        .order('created_at', { ascending: false })
        .limit(20);
      if (error) throw error;
      return (data ?? []) as PendingAdjustment[];
    },
    enabled: Boolean(driverId),
  });

  const approveMutation = useMutation({
    mutationFn: async (adjustmentId: string) => {
      const { data, error } = await supabase.functions.invoke('admin-driver-adjustment', {
        body: { action: 'approve', adjustment_id: adjustmentId },
      });
      if (error) throw error;
      if (data?.error) throw new Error(String(data.error));
      return data;
    },
    onSuccess: () => {
      toast.success('Adjustment approved and applied');
      void queryClient.invalidateQueries({ queryKey: ['driver-wallet-pending-adjustments', driverId] });
      void queryClient.invalidateQueries({ queryKey: ['finance-ledger-transactions'] });
      void queryClient.invalidateQueries({ queryKey: ['driver-wallet-ssot-detail', driverId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rejectMutation = useMutation({
    mutationFn: async (adjustmentId: string) => {
      const { data, error } = await supabase.functions.invoke('admin-driver-adjustment', {
        body: { action: 'reject', adjustment_id: adjustmentId },
      });
      if (error) throw error;
      if (data?.error) throw new Error(String(data.error));
      return data;
    },
    onSuccess: () => {
      toast.success('Adjustment rejected');
      void queryClient.invalidateQueries({ queryKey: ['driver-wallet-pending-adjustments', driverId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading || rows.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Wallet adjustments — approval queue</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {rows.map((row) => {
          const category = row.reason_category as DriverWalletAdjustmentReasonCategory;
          const label = DRIVER_WALLET_ADJUSTMENT_REASON_LABELS[category] ?? row.reason_category;
          const signed = row.direction === 'DEBIT' ? -row.amount_pence : row.amount_pence;
          return (
            <div key={row.id} className="rounded-md border p-3 space-y-2">
              <div className="flex flex-wrap items-center gap-2 justify-between">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={row.status === 'REJECTED' ? 'destructive' : 'secondary'}>
                    {row.status === 'PENDING_APPROVAL' ? 'Pending approval' : 'Rejected'}
                  </Badge>
                  <span className="text-sm font-medium">
                    {formatNullablePence(signed, currencyCode)}
                  </span>
                  <span className="text-sm text-muted-foreground">{label}</span>
                </div>
                {row.status === 'PENDING_APPROVAL' && isOwner ? (
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={rejectMutation.isPending}
                      onClick={() => rejectMutation.mutate(row.id)}
                    >
                      Reject
                    </Button>
                    <Button
                      size="sm"
                      disabled={approveMutation.isPending}
                      onClick={() => approveMutation.mutate(row.id)}
                    >
                      Approve
                    </Button>
                  </div>
                ) : null}
              </div>
              <p className="text-sm">{row.reason_note}</p>
              <p className="text-xs text-muted-foreground">
                {new Date(row.created_at).toLocaleString()}
                {row.approval_reason_codes?.length
                  ? ` · ${row.approval_reason_codes.join(', ')}`
                  : ''}
              </p>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
