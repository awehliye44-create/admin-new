/**
 * Shared Pause/Resume menu visibility for Driver Wallet Ledger + Payout Ledger.
 * Label is driven ONLY by payout_operational_paused (or the accounts SSOT `paused`
 * alias that is proven equal to that flag). Legacy payouts_enabled never controls
 * the label.
 */
import {
  adminSetDriverPayoutOperationalPause,
  operationalPauseConfirmCopy,
  type AdminSetDriverPayoutOperationalPauseResult,
  type OperationalPauseAction,
} from '@/lib/adminSetDriverPayoutOperationalPause';

export type DriverOperationalPauseMenuInput = {
  /** Canonical gate — preferred. */
  payout_operational_paused?: boolean | null;
  /**
   * Payout Ledger accounts_overview alias. Must be mapped from
   * drivers.payout_operational_paused only (never from payouts_enabled).
   */
  paused?: boolean | null;
  /** Deliberately ignored for label / visibility — Stage C legacy diagnostic. */
  payouts_enabled?: boolean | null;
};

export type DriverOperationalPauseMenuAction = {
  visible: true;
  action: OperationalPauseAction;
  label: 'Resume payouts' | 'Pause payouts';
  /** Value to pass as p_paused on the canonical RPC. */
  nextPaused: boolean;
  currentlyPaused: boolean;
  testId: 'driver-operational-pause-resume' | 'driver-operational-pause-pause';
  ariaLabel: 'Resume payouts' | 'Pause payouts';
};

/**
 * Resolve Pause/Resume menu presentation.
 * Always visible when the caller opts to render the control (permission is
 * enforced by the RPC). Label ignores legacy payouts_enabled.
 */
export function resolveDriverOperationalPauseMenuAction(
  input: DriverOperationalPauseMenuInput,
): DriverOperationalPauseMenuAction {
  // Prefer canonical field. Fall back to SSOT `paused` only when canonical is absent.
  const currentlyPaused =
    input.payout_operational_paused === true
    || (input.payout_operational_paused == null && input.paused === true);

  // Reference legacy so callers cannot accidentally "use" it for branching via typo —
  // and so tests can prove it does not flip the label.
  void input.payouts_enabled;

  if (currentlyPaused) {
    return {
      visible: true,
      action: 'resume',
      label: 'Resume payouts',
      nextPaused: false,
      currentlyPaused: true,
      testId: 'driver-operational-pause-resume',
      ariaLabel: 'Resume payouts',
    };
  }
  return {
    visible: true,
    action: 'pause',
    label: 'Pause payouts',
    nextPaused: true,
    currentlyPaused: false,
    testId: 'driver-operational-pause-pause',
    ariaLabel: 'Pause payouts',
  };
}

export type PromptOperationalPauseResult =
  | { outcome: 'cancelled' }
  | { outcome: 'completed'; result: AdminSetDriverPayoutOperationalPauseResult };

/**
 * Confirm + mandatory reason + canonical RPC.
 * Cancel at confirm or reason prompt creates no mutation.
 */
export async function promptAndSetDriverOperationalPause(args: {
  driverId: string;
  driverName?: string | null;
  driverCode?: string | null;
  currentlyPaused: boolean;
  confirmFn?: (message: string) => boolean;
  promptFn?: (message: string, defaultValue?: string) => string | null;
}): Promise<PromptOperationalPauseResult> {
  const action: OperationalPauseAction = args.currentlyPaused ? 'resume' : 'pause';
  const copy = operationalPauseConfirmCopy({
    action,
    driverName: args.driverName,
    driverCode: args.driverCode,
  });
  const confirmFn = args.confirmFn ?? ((message: string) => window.confirm(message));
  const promptFn = args.promptFn
    ?? ((message: string, defaultValue?: string) => window.prompt(message, defaultValue ?? ''));

  if (!confirmFn(`${copy.title}\n\n${copy.body}`)) {
    return { outcome: 'cancelled' };
  }
  const reason = promptFn(
    action === 'resume'
      ? 'Admin reason for resuming payouts (3–500 characters):'
      : 'Admin reason for pausing payouts (3–500 characters):',
    '',
  );
  if (reason == null) {
    return { outcome: 'cancelled' };
  }

  const result = await adminSetDriverPayoutOperationalPause({
    driverId: args.driverId,
    paused: !args.currentlyPaused,
    reason,
  });
  return { outcome: 'completed', result };
}
