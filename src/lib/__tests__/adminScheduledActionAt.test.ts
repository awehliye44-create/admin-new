import { describe, expect, it } from 'vitest';
import { validateAdminScheduledActionAt } from '../adminScheduledActionAt';

describe('validateAdminScheduledActionAt', () => {
  const nowMs = Date.parse('2026-09-23T12:00:00.000Z');
  const pickup = '2026-09-23T14:00:00.000Z';

  it('rejects past/current timestamps', () => {
    expect(
      validateAdminScheduledActionAt({
        actionAtIsoOrLocal: '2026-09-23T11:59:00.000Z',
        scheduledAt: pickup,
        nowMs,
      }).ok,
    ).toBe(false);
  });

  it('rejects action_at >= scheduled_at', () => {
    expect(
      validateAdminScheduledActionAt({
        actionAtIsoOrLocal: '2026-09-23T14:00:00.000Z',
        scheduledAt: pickup,
        nowMs,
      }).ok,
    ).toBe(false);
  });

  it('accepts NOW < action_at < scheduled_at', () => {
    const result = validateAdminScheduledActionAt({
      actionAtIsoOrLocal: '2026-09-23T13:00:00.000Z',
      scheduledAt: pickup,
      nowMs,
    });
    expect(result.ok).toBe(true);
  });
});
