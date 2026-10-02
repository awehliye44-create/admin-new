/**
 * Booking dispatch wave radius SSOT — Admin → Auto-Dispatch Rules.
 *
 * global_dispatch_settings (global singleton) holds three ABSOLUTE radii from
 * the pickup, one per wave of every dispatch round (W1 → W2 → W3, round 2
 * restarts at W1):
 *   start_radius_meters  = Wave 1
 *   expand_radius_meters = Wave 2 (legacy column name — NOT an increment)
 *   max_radius_meters    = Wave 3, and the cap for every wave
 * Postgres `valid_radii` enforces 0 < W1 ≤ W2 ≤ W3. SQL dispatch_trip_offers
 * and Edge auto-dispatch must both use these values with no substitute.
 *
 * Independent of the Customer map nearby-driver radius, the stacked-ride
 * radius and towards-destination matching.
 */

export const BOOKING_DISPATCH_WAVE_RADIUS_MIN_METERS = 500;
export const BOOKING_DISPATCH_WAVE_RADIUS_MAX_METERS = 100_000;

/** Live values on 2026-10-02. Admin Reset target and column defaults only — dispatch never reads these. */
export const BOOKING_DISPATCH_WAVE_RADIUS_DEFAULTS_METERS = Object.freeze({
  wave1: 13_000,
  wave2: 17_000,
  wave3: 29_000,
});

export type BookingDispatchWave = 1 | 2 | 3;

export type BookingDispatchWaveRadiiMeters = {
  wave1: number;
  wave2: number;
  wave3: number;
};

export type BookingDispatchWaveRadiusField = keyof BookingDispatchWaveRadiiMeters;

export type BookingDispatchWaveRadiusIssue = {
  field: BookingDispatchWaveRadiusField;
  code: "required" | "out_of_range" | "not_increasing";
  message: string;
};

const FIELDS: ReadonlyArray<[BookingDispatchWaveRadiusField, string]> = [
  ["wave1", "Wave 1"],
  ["wave2", "Wave 2"],
  ["wave3", "Wave 3"],
];

export function validateBookingDispatchWaveRadii(
  radii: BookingDispatchWaveRadiiMeters,
): BookingDispatchWaveRadiusIssue[] {
  const issues: BookingDispatchWaveRadiusIssue[] = [];
  for (const [field, label] of FIELDS) {
    const value = radii[field];
    if (!Number.isInteger(value)) {
      issues.push({ field, code: "required", message: `${label} radius is required` });
    } else if (
      value < BOOKING_DISPATCH_WAVE_RADIUS_MIN_METERS ||
      value > BOOKING_DISPATCH_WAVE_RADIUS_MAX_METERS
    ) {
      issues.push({
        field,
        code: "out_of_range",
        message: `${label} radius must be between ${BOOKING_DISPATCH_WAVE_RADIUS_MIN_METERS / 1000} km and ${BOOKING_DISPATCH_WAVE_RADIUS_MAX_METERS / 1000} km`,
      });
    }
  }
  if (issues.length > 0) return issues;
  if (radii.wave2 < radii.wave1) {
    issues.push({
      field: "wave2",
      code: "not_increasing",
      message: "Wave 2 radius must be at least the Wave 1 radius",
    });
  }
  if (radii.wave3 < radii.wave2) {
    issues.push({
      field: "wave3",
      code: "not_increasing",
      message: "Wave 3 radius must be at least the Wave 2 radius",
    });
  }
  return issues;
}

function positiveIntOrNull(raw: unknown): number | null {
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : null;
}

/** Null when any wave is missing — callers fail closed instead of guessing. */
export function bookingDispatchWaveRadiiFromRow(
  row: Record<string, unknown> | null | undefined,
): BookingDispatchWaveRadiiMeters | null {
  if (!row) return null;
  const wave1 = positiveIntOrNull(row.start_radius_meters);
  const wave2 = positiveIntOrNull(row.expand_radius_meters);
  const wave3 = positiveIntOrNull(row.max_radius_meters);
  if (wave1 == null || wave2 == null || wave3 == null) return null;
  return { wave1, wave2, wave3 };
}

export function bookingDispatchWaveRadiiToRow(radii: BookingDispatchWaveRadiiMeters): {
  start_radius_meters: number;
  expand_radius_meters: number;
  max_radius_meters: number;
} {
  return {
    start_radius_meters: radii.wave1,
    expand_radius_meters: radii.wave2,
    max_radius_meters: radii.wave3,
  };
}

/** Mirrors SQL `LEAST(v_radius, max_radius_meters)`. */
export function bookingDispatchRadiusForWave(
  radii: BookingDispatchWaveRadiiMeters,
  wave: BookingDispatchWave,
): number {
  const configured = wave === 1 ? radii.wave1 : wave === 2 ? radii.wave2 : radii.wave3;
  return Math.min(configured, radii.wave3);
}
