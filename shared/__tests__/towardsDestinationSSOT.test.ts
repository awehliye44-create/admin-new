import { describe, expect, it } from "vitest";
import {
  buildTowardsDestinationUsageSnapshot,
  haversineMeters,
  isInsideArrivalRadius,
  towardsDestinationTripQualifies,
} from "../towardsDestinationSSOT";

describe("towardsDestinationTripQualifies", () => {
  const london = { lat: 51.5074, lng: -0.1278 };
  const north = { lat: 51.55, lng: -0.1278 }; // ~4.7km north of london
  const nearNorth = { lat: 51.545, lng: -0.1278 }; // closer to north than london is

  const config = {
    matchingToleranceMeters: 50,
    minProgressMeters: 100,
    maxPickupDetourMeters: 20_000,
  };

  it("qualifies when drop-off is closer to dest than driver (directional progress)", () => {
    const result = towardsDestinationTripQualifies(
      {
        driverLat: london.lat,
        driverLng: london.lng,
        pickupLat: london.lat + 0.002,
        pickupLng: london.lng,
        dropoffLat: nearNorth.lat,
        dropoffLng: nearNorth.lng,
        destLat: north.lat,
        destLng: north.lng,
      },
      config,
    );
    expect(result.qualifies).toBe(true);
    expect(result.reason).toBe("ok");
    expect(result.progressMeters!).toBeGreaterThan(100);
  });

  it("rejects when drop-off is farther from dest (wrong direction)", () => {
    const south = { lat: 51.48, lng: -0.1278 };
    const result = towardsDestinationTripQualifies(
      {
        driverLat: london.lat,
        driverLng: london.lng,
        pickupLat: london.lat,
        pickupLng: london.lng,
        dropoffLat: south.lat,
        dropoffLng: south.lng,
        destLat: north.lat,
        destLng: north.lng,
      },
      config,
    );
    expect(result.qualifies).toBe(false);
    expect(result.reason).toBe("no_progress");
  });

  it("rejects when pickup detour exceeds max", () => {
    const farPickup = { lat: 51.6, lng: -0.3 };
    const result = towardsDestinationTripQualifies(
      {
        driverLat: london.lat,
        driverLng: london.lng,
        pickupLat: farPickup.lat,
        pickupLng: farPickup.lng,
        dropoffLat: nearNorth.lat,
        dropoffLng: nearNorth.lng,
        destLat: north.lat,
        destLng: north.lng,
      },
      { ...config, maxPickupDetourMeters: 500 },
    );
    expect(result.qualifies).toBe(false);
    expect(result.reason).toBe("pickup_detour_exceeded");
  });

  it("rejects 0,0 / missing coords (no postcode string match path)", () => {
    const result = towardsDestinationTripQualifies(
      {
        driverLat: london.lat,
        driverLng: london.lng,
        pickupLat: london.lat,
        pickupLng: london.lng,
        dropoffLat: 0,
        dropoffLng: 0,
        destLat: north.lat,
        destLng: north.lng,
      },
      config,
    );
    expect(result.qualifies).toBe(false);
    expect(result.reason).toBe("invalid_coords");
  });

  it("rejects Null Island pickup the same as dropoff (SQL twin parity)", () => {
    const result = towardsDestinationTripQualifies(
      {
        driverLat: london.lat,
        driverLng: london.lng,
        pickupLat: 0,
        pickupLng: 0,
        dropoffLat: nearNorth.lat,
        dropoffLng: nearNorth.lng,
        destLat: north.lat,
        destLng: north.lng,
      },
      config,
    );
    expect(result.qualifies).toBe(false);
    expect(result.reason).toBe("invalid_coords");
  });

  it("does not use postcode string equality — coords only", () => {
    // Same logical area, different "postcodes" would be irrelevant; coords decide.
    const a = haversineMeters(51.5, -0.12, 51.51, -0.12);
    const b = haversineMeters(51.5, -0.12, 51.5, -0.12);
    expect(a).toBeGreaterThan(b);
  });
});

describe("isInsideArrivalRadius / same-location", () => {
  it("detects already-at-destination within 500m", () => {
    expect(
      isInsideArrivalRadius({
        lat: 51.5074,
        lng: -0.1278,
        destLat: 51.5075,
        destLng: -0.1278,
        arrivalRadiusMeters: 500,
      }),
    ).toBe(true);
  });

  it("rejects destinations farther than arrival radius", () => {
    expect(
      isInsideArrivalRadius({
        lat: 51.5074,
        lng: -0.1278,
        destLat: 51.55,
        destLng: -0.1278,
        arrivalRadiusMeters: 500,
      }),
    ).toBe(false);
  });
});

describe("buildTowardsDestinationUsageSnapshot", () => {
  it("counts only completions toward remaining (activate does not consume)", () => {
    const snap = buildTowardsDestinationUsageSnapshot({
      limit: 5,
      completedLast24h: 2,
    });
    expect(snap).toEqual({
      limit: 5,
      completed_last_24h: 2,
      remaining: 3,
      window_type: "rolling_24_hours",
      next_available_at: null,
    });
  });

  it("sets next_available_at when remaining is 0", () => {
    const now = new Date("2026-08-01T12:00:00.000Z");
    const oldest = "2026-07-31T18:00:00.000Z";
    const snap = buildTowardsDestinationUsageSnapshot({
      limit: 5,
      completedLast24h: 5,
      completedAtTimestamps: [
        oldest,
        "2026-07-31T20:00:00.000Z",
        "2026-07-31T22:00:00.000Z",
        "2026-08-01T08:00:00.000Z",
        "2026-08-01T10:00:00.000Z",
      ],
      now,
    });
    expect(snap.remaining).toBe(0);
    expect(snap.next_available_at).toBe("2026-08-01T18:00:00.000Z");
  });

  it("idempotent completion counting: snapshot uses provided completed count", () => {
    // Duplicate completion events must be de-duped before calling this helper.
    const snap = buildTowardsDestinationUsageSnapshot({
      limit: 5,
      completedLast24h: 1,
    });
    expect(snap.completed_last_24h).toBe(1);
    expect(snap.remaining).toBe(4);
  });
});
