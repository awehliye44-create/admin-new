/**
 * A8B28F Stage C companion DRAFT — PayoutLedgerSettingsPanel per-driver override.
 * Replace driverOverrideMutation body that writes payouts_enabled directly.
 */

import {
  adminSetDriverPayoutOperationalPause,
} from '../../A8B28F_stage_b/B5/adminSetDriverPayoutOperationalPause';

export async function driverOverrideMutationStageC(input: {
  overrideDriverId: string;
  /** UI "enabled" toggle — true means payouts allowed (not paused) */
  enabled: boolean;
  reason: string;
  assertPlatformCollectedMember: () => Promise<void>;
}): Promise<void> {
  await input.assertPlatformCollectedMember();
  const result = await adminSetDriverPayoutOperationalPause({
    driverId: input.overrideDriverId,
    paused: !input.enabled,
    reason: input.reason,
  });
  if (!result.ok) throw new Error(result.reason);
}

/**
 * UI: require reason field (min 3 chars) before saving override.
 * Keep PLATFORM_COLLECTED scope guard (never CW-only drivers) — unchanged.
 * Global admin_settings.payouts_enabled platform toggle remains GL — unchanged.
 */
