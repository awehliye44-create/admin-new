/**
 * A8B28F Stage C companion DRAFT — Admin PayoutLedger pause/resume.
 * Replace live updatePayoutPause in src/pages/PayoutLedger.tsx
 * Prefer importing Stage B5 helper (already drafted):
 *   supabase/drafts/A8B28F_stage_b/B5/adminSetDriverPayoutOperationalPause.ts
 */

import {
  adminSetDriverPayoutOperationalPause,
} from '../../A8B28F_stage_b/B5/adminSetDriverPayoutOperationalPause';

export async function updatePayoutPauseStageCCompanion(row: {
  driver_id: string;
  /** current UI paused flag (true means currently paused) */
  paused: boolean;
  name?: string | null;
  code?: string | null;
}): Promise<void> {
  const action = row.paused ? 'resume' : 'pause';
  const reason = window.prompt(
    `Reason to ${action} payouts for ${row.name ?? row.code ?? 'driver'} (required, 3–500 chars):`,
  );
  if (reason == null) return;

  const result = await adminSetDriverPayoutOperationalPause({
    driverId: row.driver_id,
    paused: !row.paused,
    reason,
  });
  if (!result.ok) throw new Error(result.reason);
}

/**
 * DELETE on deploy:
 *   await supabase.from('drivers').update({ payouts_enabled: row.paused })...
 *
 * Accounts list paused badge:
 *   BEFORE: paused = payouts_enabled === false
 *   AFTER:  paused = payout_operational_paused === true
 *   ADD:    unverified badge from provider_link_status !== PROVIDER_VERIFIED
 */
