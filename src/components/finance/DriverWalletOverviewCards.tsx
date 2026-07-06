import { Loader2 } from 'lucide-react';
import type { DriverWalletSsotRow } from '@/hooks/useDriverWalletSsot';

export function DriverWalletOverviewCards({
  driver,
  isLoading,
  driverId = null,
}: {
  driver: DriverWalletSsotRow | null | undefined;
  currencyCode?: string;
  regionId?: string | null;
  isLoading?: boolean;
  driverId?: string | null;
}) {
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading payout position…
      </div>
    );
  }

  if (!driver && !driverId) {
    return (
      <p className="text-sm text-muted-foreground py-8">
        Select a driver above to view their payout position.
      </p>
    );
  }

  if (!driver) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading driver payout position…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Trip earnings are calculated on Trip History (Trip Settlement SSOT).
      </p>
      <p className="text-sm text-muted-foreground py-4">
        No provider balance available yet.
      </p>
    </div>
  );
}
