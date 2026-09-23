/**
 * Decision helper mirroring deny_direct_driver_payout_pause_write.
 * Explicit behavioural tests (not SQL source inspection alone).
 */
export type DirectPauseWriteDecisionInput = {
  authRole: string | null;
  allowGuc: boolean;
  pauseFieldsChanging: boolean;
  /** True when the UPDATE OF trigger would fire (only pause columns listed). */
  triggerWouldFire: boolean;
};

export type DirectPauseWriteDecision =
  | { allow: true; reason: 'service_role' | 'rpc_guc' | 'unrelated_columns' | 'no_pause_change' }
  | { allow: false; reason: 'direct_payout_pause_write_denied' };

export function decideDirectDriverPayoutPauseWrite(
  input: DirectPauseWriteDecisionInput,
): DirectPauseWriteDecision {
  if (!input.triggerWouldFire) {
    return { allow: true, reason: 'unrelated_columns' };
  }
  if (input.authRole === 'service_role') {
    return { allow: true, reason: 'service_role' };
  }
  if (input.allowGuc) {
    return { allow: true, reason: 'rpc_guc' };
  }
  if (!input.pauseFieldsChanging) {
    return { allow: true, reason: 'no_pause_change' };
  }
  return { allow: false, reason: 'direct_payout_pause_write_denied' };
}
