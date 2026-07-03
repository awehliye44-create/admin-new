import { useMutation } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

type SyncTripPaymentFromStripeButtonProps = {
  tripId: string;
  tripCode?: string | null;
  onSynced?: () => void;
  size?: 'sm' | 'default';
  variant?: 'outline' | 'secondary' | 'default' | 'ghost';
  className?: string;
  disabled?: boolean;
};

export function SyncTripPaymentFromStripeButton({
  tripId,
  tripCode,
  onSynced,
  size = 'sm',
  variant = 'outline',
  className,
  disabled = false,
}: SyncTripPaymentFromStripeButtonProps) {
  const syncMutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, string> = { trip_id: tripId };
      if (tripCode) body.trip_code = tripCode;
      const { data, error } = await supabase.functions.invoke('admin-sync-trip-payment-from-stripe', { body });
      if (error) throw new Error(data?.error || error.message);
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: (data) => {
      const parts: string[] = [];
      if (data.capture_synced) parts.push('capture');
      if (data.refund_synced) parts.push('refund');
      if (data.stripe_fields_updated) parts.push('Stripe fields');
      toast.success(data.message || 'Synced from Stripe', {
        description: parts.length ? `Updated: ${parts.join(', ')}` : undefined,
      });
      onSynced?.();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <Button
      type="button"
      size={size}
      variant={variant}
      className={className}
      onClick={() => syncMutation.mutate()}
      disabled={disabled || syncMutation.isPending}
    >
      <RefreshCw className={`h-4 w-4 mr-1 ${syncMutation.isPending ? 'animate-spin' : ''}`} />
      Sync from Stripe
    </Button>
  );
}
