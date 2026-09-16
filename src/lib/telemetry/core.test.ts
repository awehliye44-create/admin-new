import { afterEach, describe, expect, it, vi } from 'vitest';
import { OnecabTelemetry } from './core';

function createTelemetry() {
  return new OnecabTelemetry({
    supabaseUrl: 'https://example.supabase.co',
    supabaseAnonKey: 'publishable-test-key',
    appName: 'admin_panel',
    platform: 'web',
    batchSize: 20,
    flushIntervalMs: 60_000,
    requestTimeoutMs: 50,
    failureCooldownMs: 60_000,
  });
}

describe('OnecabTelemetry outage isolation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('does not reject when Supabase returns a 522 HTML response', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('<!DOCTYPE html><title>522: Connection timed out</title>', { status: 522 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const telemetry = createTelemetry();

    telemetry.trackFlowStep('PaymentSessions', 1_000, 'load');

    await expect(telemetry.flush()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('drops new batches during the cooldown after a transient failure', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const fetchMock = vi.fn().mockResolvedValue(new Response('upstream unavailable', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const telemetry = createTelemetry();

    telemetry.trackFlowStep('Audit', 1_000, 'first');
    await telemetry.flush();
    telemetry.trackFlowStep('Audit', 1_000, 'second');
    await telemetry.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('honours the receiver cooldown when storage is unavailable', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ success: false, error_code: 'TELEMETRY_STORAGE_UNAVAILABLE' }),
        { status: 202, headers: { 'Retry-After': '60' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const telemetry = createTelemetry();

    telemetry.trackFlowStep('Audit', 1_000, 'first');
    await telemetry.flush();
    telemetry.trackFlowStep('Audit', 1_000, 'second');
    await telemetry.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not reject when the telemetry request throws a network error', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const telemetry = createTelemetry();

    telemetry.trackFlowStep('DriverWallet', 1_000, 'load');

    await expect(telemetry.flush()).resolves.toBeUndefined();
  });
});