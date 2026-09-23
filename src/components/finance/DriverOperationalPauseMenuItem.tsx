import { useQueryClient } from '@tanstack/react-query';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import {
  promptAndSetDriverOperationalPause,
  resolveDriverOperationalPauseMenuAction,
  type DriverOperationalPauseMenuInput,
} from '@/lib/driverOperationalPauseMenu';

type Props = {
  driverId: string;
  driverName?: string | null;
  driverCode?: string | null;
  pauseState: DriverOperationalPauseMenuInput;
  onCompleted?: () => void;
};

/**
 * Shared Pause/Resume DropdownMenuItem for Driver Wallet + Payout Ledger.
 * Opening/cancelling creates no mutation.
 */
export function DriverOperationalPauseMenuItem({
  driverId,
  driverName,
  driverCode,
  pauseState,
  onCompleted,
}: Props) {
  const queryClient = useQueryClient();
  const menu = resolveDriverOperationalPauseMenuAction(pauseState);

  const run = async () => {
    const outcome = await promptAndSetDriverOperationalPause({
      driverId,
      driverName,
      driverCode,
      currentlyPaused: menu.currentlyPaused,
    });
    if (outcome.outcome === 'cancelled') return;
    if (!outcome.result.ok) {
      window.alert(outcome.result.message);
      return;
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['admin-payout-ledger'] }),
      queryClient.invalidateQueries({ queryKey: ['driver-wallet-ssot'] }),
      queryClient.invalidateQueries({ queryKey: ['driver-wallet-ssot-detail'] }),
      queryClient.invalidateQueries({ queryKey: ['driver-wallet-ssot-all'] }),
      queryClient.invalidateQueries({ queryKey: ['payout-driver-override'] }),
    ]);
    onCompleted?.();
  };

  return (
    <DropdownMenuItem
      data-testid={menu.testId}
      aria-label={menu.ariaLabel}
      onClick={() => void run()}
    >
      {menu.label}
    </DropdownMenuItem>
  );
}
