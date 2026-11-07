/**
 * Pending customer signup stage — single mapping for the Pending Customer
 * Signups page. The stage itself is decided server-side by
 * `admin_list_pending_customer_signups().verification_stage`; this module only
 * turns that value into labels, tab keys and counts.
 */

export const PENDING_SIGNUP_STAGES = [
  'pending_email',
  'pending_phone',
  'pending_email_and_phone',
  'awaiting_activation',
  'legacy_ghost',
] as const;

export type PendingSignupStage = (typeof PENDING_SIGNUP_STAGES)[number];
export type ResolvedPendingSignupStage = PendingSignupStage | 'unknown';

export const PENDING_SIGNUP_STAGE_LABELS: Record<ResolvedPendingSignupStage, string> = {
  pending_email: 'Pending email',
  pending_phone: 'Pending phone',
  pending_email_and_phone: 'Pending email & phone',
  awaiting_activation: 'Ready to activate',
  legacy_ghost: 'Legacy',
  unknown: 'Unknown stage',
};

export function resolvePendingSignupStage(
  verificationStage: string | null | undefined,
): ResolvedPendingSignupStage {
  return (PENDING_SIGNUP_STAGES as readonly string[]).includes(verificationStage ?? '')
    ? (verificationStage as PendingSignupStage)
    : 'unknown';
}

export function pendingSignupStageLabel(verificationStage: string | null | undefined): string {
  return PENDING_SIGNUP_STAGE_LABELS[resolvePendingSignupStage(verificationStage)];
}

export function countPendingSignupStages(
  rows: ReadonlyArray<{ verification_stage: string | null | undefined }>,
): Record<ResolvedPendingSignupStage | 'all', number> {
  const counts: Record<ResolvedPendingSignupStage | 'all', number> = {
    all: rows.length,
    pending_email: 0,
    pending_phone: 0,
    pending_email_and_phone: 0,
    awaiting_activation: 0,
    legacy_ghost: 0,
    unknown: 0,
  };
  for (const row of rows) counts[resolvePendingSignupStage(row.verification_stage)] += 1;
  return counts;
}
