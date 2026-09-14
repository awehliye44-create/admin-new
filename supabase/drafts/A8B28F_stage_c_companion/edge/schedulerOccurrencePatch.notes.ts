/**
 * A8B28F Stage C companion DRAFT — scheduler / execute occurrence call-site patches.
 *
 * Files:
 * - supabase/functions/admin-weekly-payout-scheduler/index.ts
 * - supabase/functions/admin-execute-weekly-payout-occurrence/index.ts
 *
 * Driver select:
 *   ADD payout_operational_paused
 *   KEEP approval_status, driver_status
 *   payouts_enabled may remain in select for logging only — MUST NOT gate eligibility
 *
 * held:
 *   BEFORE: ["suspended","blocked","banned","held"]  // misses live enum
 *   AFTER:  ["disabled","deleted","suspended","blocked","banned","held","inactive"]
 *
 * evaluateDriverBatchEligibility args:
 *   BEFORE: payouts_enabled: driver.payouts_enabled !== false
 *   AFTER:  payout_operational_paused: driver.payout_operational_paused === true
 *
 * Global controlCentre.payouts_enabled remains GL kill-switch (settings.payouts_enabled) — KEEP.
 */

export const SCHEDULER_OCCURRENCE_PATCH = {
  driverSelect:
    'id, region_id, service_area_id, first_name, last_name, payout_operational_paused, approval_status, driver_status',
  heldStatuses: [
    'disabled',
    'deleted',
    'suspended',
    'blocked',
    'banned',
    'held',
    'inactive',
  ],
  batchEligibilityArg:
    'payout_operational_paused: driver.payout_operational_paused === true',
} as const;
