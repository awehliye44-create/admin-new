import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
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
  className?: string;
};

/**
 * Inline Pause/Resume control shown beside the operational-pause status badge
 * on Driver Wallet account header (the screen that displays the pause).
 */
export function DriverOperationalPauseInlineButton({
  driverId,
  driverName,
  driverCode,
  pauseState,
  className,
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
      window.alert(('message' in outcome.result ? outcome.result.message : 'Action failed'));
      return;
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['admin-payout-ledger'] }),
      queryClient.invalidateQueries({ queryKey: ['driver-wallet-ssot'] }),
      queryClient.invalidateQueries({ queryKey: ['driver-wallet-ssot-detail'] }),
      queryClient.invalidateQueries({ queryKey: ['driver-wallet-ssot-all'] }),
      queryClient.invalidateQueries({ queryKey: ['payout-driver-override'] }),
    ]);
  };

  return (
    <Button
      type="button"
      variant={menu.currentlyPaused ? 'default' : 'outline'}
      size="sm"
      className={className}
      data-testid={menu.testId}
      aria-label={menu.ariaLabel}
      onClick={() => void run()}
    >
      {menu.label}
    </Button>
  );
}
