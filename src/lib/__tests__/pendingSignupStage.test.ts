import { describe, expect, it } from 'vitest';
import {
  countPendingSignupStages,
  pendingSignupStageLabel,
  resolvePendingSignupStage,
} from '../pendingSignupStage';

describe('pending signup stage labels', () => {
  it('email verified but phone not verified shows "Pending phone", never "Pending email"', () => {
    expect(pendingSignupStageLabel('pending_phone')).toBe('Pending phone');
  });

  it('phone verified but email not verified shows "Pending email"', () => {
    expect(pendingSignupStageLabel('pending_email')).toBe('Pending email');
  });

  it('neither verified shows "Pending email & phone"', () => {
    expect(pendingSignupStageLabel('pending_email_and_phone')).toBe('Pending email & phone');
  });

  it('both verified shows "Ready to activate"', () => {
    expect(pendingSignupStageLabel('awaiting_activation')).toBe('Ready to activate');
  });

  it('legacy rows show "Legacy"', () => {
    expect(pendingSignupStageLabel('legacy_ghost')).toBe('Legacy');
  });

  it('missing or unrecognised stage is not guessed as a pending stage', () => {
    expect(resolvePendingSignupStage(undefined)).toBe('unknown');
    expect(resolvePendingSignupStage('email_verified')).toBe('unknown');
  });

  it('counts each row once under its own stage', () => {
    const counts = countPendingSignupStages([
      { verification_stage: 'pending_phone' },
      { verification_stage: 'pending_phone' },
      { verification_stage: 'pending_phone' },
      { verification_stage: 'legacy_ghost' },
    ]);
    expect(counts.all).toBe(4);
    expect(counts.pending_phone).toBe(3);
    expect(counts.pending_email).toBe(0);
    expect(counts.legacy_ghost).toBe(1);
  });
});
