import { useMutation } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

type SyncStripeRefundButtonProps = {
  tripId: string;
  tripCode?: string | null;
  onSynced?: () => void;
  size?: 'sm' | 'default';
  variant?: 'outline' | 'secondary' | 'default';
};

export function SyncStripeRefundButton({
  tripId,
  tripCode,
  onSynced,
  size = 'sm',
  variant = 'outline',
}: SyncStripeRefundButtonProps) {
  const syncMutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, string> = { trip_id: tripId };
      if (tripCode) body.trip_code = tripCode;
      const { data, error } = await supabase.functions.invoke('admin-sync-refund-from-stripe', { body });
      if (error) throw new Error(data?.error || error.message);
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: (data) => {
      toast.success(data.message || 'Refund synced from Stripe');
      onSynced?.();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <Button
      type="button"
      size={size}
      variant={variant}
      onClick={() => syncMutation.mutate()}
      disabled={syncMutation.isPending}
    >
      <RefreshCw className={`h-4 w-4 mr-1 ${syncMutation.isPending ? 'animate-spin' : ''}`} />
      Sync refund from Stripe
    </Button>
  );
}
