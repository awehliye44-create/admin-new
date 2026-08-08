import { describe, expect, it } from 'vitest';
import {
  buildUsageMetrics,
  estimateCallCostMinor,
  minutesToSeconds,
  resolveServiceAreaCommunication,
  secondsToMinutes,
} from '../serviceAreaCommunicationModel';

describe('serviceAreaCommunicationModel', () => {
  it('converts minutes to seconds for backend storage', () => {
    expect(minutesToSeconds(10)).toBe(600);
    expect(secondsToMinutes(600)).toBe(10);
  });

  it('always reports VoIP as available regardless of legacy flags', () => {
    const resolved = resolveServiceAreaCommunication({ call_masking_enabled: false });
    expect(resolved.voipAvailable).toBe(true);
    expect(resolved.voipProvider).toBe('livekit');
    expect(resolved.callMaskingAvailable).toBe(false);
    expect(resolved.maskedOutboundCallerId).toBeNull();
  });

  it('exposes call masking only when enabled for that service area with an active config', () => {
    const off = resolveServiceAreaCommunication({
      call_masking_enabled: false,
      masking: { is_active: true, outbound_caller_id: '+441908831211' },
    });
    expect(off.callMaskingAvailable).toBe(false);
    expect(off.voipAvailable).toBe(true);

    const on = resolveServiceAreaCommunication({
      call_masking_enabled: true,
      masking: { is_active: true, outbound_caller_id: '+441908831211' },
      maximum_call_duration_seconds: 240,
    });
    expect(on.callMaskingAvailable).toBe(true);
    expect(on.maskedOutboundCallerId).toBe('+441908831211');
    expect(on.maximumCallDurationSeconds).toBe(240);
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
