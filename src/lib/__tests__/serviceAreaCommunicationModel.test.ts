import { describe, expect, it } from 'vitest';
import {
  buildUsageMetrics,
  estimateCallCostMinor,
  minutesToSeconds,
  resolveDefaultMethod,
  secondsToMinutes,
  validateCommunicationSettings,
} from '../serviceAreaCommunicationModel';

describe('serviceAreaCommunicationModel', () => {
  it('converts minutes to seconds for backend storage', () => {
    expect(minutesToSeconds(10)).toBe(600);
    expect(secondsToMinutes(600)).toBe(10);
  });

  it('resolves default method from enabled flags', () => {
    expect(resolveDefaultMethod(true, true, 'call_masking')).toBe('call_masking');
    expect(resolveDefaultMethod(true, false, 'call_masking')).toBe('voip');
    expect(resolveDefaultMethod(false, true, 'voip')).toBe('call_masking');
  });

  it('validates default method against enabled toggles', () => {
    expect(
      validateCommunicationSettings({
        voip_enabled: false,
        call_masking_enabled: true,
        default_method: 'voip',
      }),
    ).toContain('VoIP must be enabled');
  });

  it('estimates per-call cost from duration and rate', () => {
    expect(estimateCallCostMinor(120, 50)).toBe(100);
  });

  it('aggregates usage metrics by service area logs', () => {
    const metrics = buildUsageMetrics(
      [{ duration_seconds: 120, status: 'completed' }],
      [{ duration_seconds: 60, status: 'failed' }],
      100,
      50,
    );
    expect(metrics.totalVoipMinutes).toBe(2);
    expect(metrics.totalMaskedMinutes).toBe(1);
    expect(metrics.estimatedCostMinor).toBe(250);
    expect(metrics.callCount).toBe(2);
  });
});
