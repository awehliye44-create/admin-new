import { describe, expect, it } from "vitest";
import {
  computeDriverLocationState,
  DRIVER_LOCATION_THRESHOLDS,
  isDriverLocationFrozen,
  resolveDriverFleetDisplayStatus,
} from "./driverLocationStateSSOT";

const NOW = new Date("2026-01-01T00:00:00.000Z");

describe("computeDriverLocationState (mirrors SQL driver_location_state())", () => {
  it("driver_online_intent=false is always location_unavailable, even with fresh everything", () => {
    expect(
      computeDriverLocationState({
        driverOnlineIntent: false,
        lastHeartbeatAt: NOW,
        lastGpsSampleAt: NOW,
        speed: 5,
        now: NOW,
      }),
    ).toBe("location_unavailable");
  });

  it("no heartbeat ever recorded is location_unavailable", () => {
    expect(
      computeDriverLocationState({
        driverOnlineIntent: true,
        lastHeartbeatAt: null,
        lastGpsSampleAt: NOW,
        now: NOW,
      }),
    ).toBe("location_unavailable");
  });

  it("stale heartbeat beyond heartbeatFreshSeconds is location_stale regardless of GPS", () => {
    const staleHb = new Date(
      NOW.getTime() - (DRIVER_LOCATION_THRESHOLDS.heartbeatFreshSeconds + 1) * 1000,
    );
    expect(
      computeDriverLocationState({
        driverOnlineIntent: true,
        lastHeartbeatAt: staleHb,
        lastGpsSampleAt: NOW,
        now: NOW,
      }),
    ).toBe("location_stale");
  });

  it("fresh heartbeat but no GPS sample ever is location_unavailable", () => {
    expect(
      computeDriverLocationState({
        driverOnlineIntent: true,
        lastHeartbeatAt: NOW,
        lastGpsSampleAt: null,
        now: NOW,
      }),
    ).toBe("location_unavailable");
  });

  it("FROZEN: fresh heartbeat but GPS sample older than gpsFreshSeconds — the confirmed bug pattern", () => {
    const staleGps = new Date(
      NOW.getTime() - (DRIVER_LOCATION_THRESHOLDS.gpsFreshSeconds + 1) * 1000,
    );
    expect(
      computeDriverLocationState({
        driverOnlineIntent: true,
        lastHeartbeatAt: NOW,
        lastGpsSampleAt: staleGps,
        speed: 0,
        now: NOW,
      }),
    ).toBe("location_frozen");
    expect(
      isDriverLocationFrozen({
        driverOnlineIntent: true,
        lastHeartbeatAt: NOW,
        lastGpsSampleAt: staleGps,
        now: NOW,
      }),
    ).toBe(true);
  });

  it("fresh heartbeat + fresh GPS + low speed is location_stationary (not frozen)", () => {
    expect(
      computeDriverLocationState({
        driverOnlineIntent: true,
        lastHeartbeatAt: NOW,
        lastGpsSampleAt: NOW,
        speed: 0.1,
        now: NOW,
      }),
    ).toBe("location_stationary");
  });

  it("fresh heartbeat + fresh GPS + real speed is location_live", () => {
    expect(
      computeDriverLocationState({
        driverOnlineIntent: true,
        lastHeartbeatAt: NOW,
        lastGpsSampleAt: NOW,
        speed: 8.3,
        now: NOW,
      }),
    ).toBe("location_live");
  });

  it("null/undefined speed defaults to stationary (not live) when GPS is fresh", () => {
    expect(
      computeDriverLocationState({
        driverOnlineIntent: true,
        lastHeartbeatAt: NOW,
        lastGpsSampleAt: NOW,
        speed: null,
        now: NOW,
      }),
    ).toBe("location_stationary");
  });
});

describe("resolveDriverFleetDisplayStatus (Admin Live Fleet — audit item #7)", () => {
  it("is_online=false is always Offline, regardless of stale location data", () => {
    expect(
      resolveDriverFleetDisplayStatus({
        isOnline: false,
        driverOnlineIntent: true,
        lastHeartbeatAt: NOW,
        lastGpsSampleAt: NOW,
        now: NOW,
      }),
    ).toBe("Offline");
  });

  it("maps location_frozen to Frozen", () => {
    const staleGps = new Date(
      NOW.getTime() - (DRIVER_LOCATION_THRESHOLDS.gpsFreshSeconds + 1) * 1000,
    );
    expect(
      resolveDriverFleetDisplayStatus({
        isOnline: true,
        driverOnlineIntent: true,
        lastHeartbeatAt: NOW,
        lastGpsSampleAt: staleGps,
        now: NOW,
      }),
    ).toBe("Frozen");
  });

  it("maps location_stale and location_unavailable to Delayed", () => {
    const staleHb = new Date(
      NOW.getTime() - (DRIVER_LOCATION_THRESHOLDS.heartbeatFreshSeconds + 1) * 1000,
    );
    expect(
      resolveDriverFleetDisplayStatus({
        isOnline: true,
        driverOnlineIntent: true,
        lastHeartbeatAt: staleHb,
        lastGpsSampleAt: NOW,
        now: NOW,
      }),
    ).toBe("Delayed");
    expect(
      resolveDriverFleetDisplayStatus({
        isOnline: true,
        driverOnlineIntent: true,
        lastHeartbeatAt: NOW,
        lastGpsSampleAt: null,
        now: NOW,
      }),
    ).toBe("Delayed");
  });

  it("maps location_live/location_stationary straight through", () => {
    expect(
      resolveDriverFleetDisplayStatus({
        isOnline: true,
        driverOnlineIntent: true,
        lastHeartbeatAt: NOW,
        lastGpsSampleAt: NOW,
        speed: 10,
        now: NOW,
      }),
    ).toBe("Live");
    expect(
      resolveDriverFleetDisplayStatus({
        isOnline: true,
        driverOnlineIntent: true,
        lastHeartbeatAt: NOW,
        lastGpsSampleAt: NOW,
        speed: 0,
        now: NOW,
      }),
    ).toBe("Stationary");
  });
});
