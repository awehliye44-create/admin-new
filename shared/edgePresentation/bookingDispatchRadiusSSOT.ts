/** Admin presentation-only helpers; not part of Edge uploads. */
import { BookingDispatchWaveRadiiMeters, BookingDispatchWaveRadiusIssue, FIELDS, BOOKING_DISPATCH_WAVE_RADIUS_MIN_METERS, BOOKING_DISPATCH_WAVE_RADIUS_MAX_METERS } from "../../supabase/functions/_shared/bookingDispatchRadiusSSOT.ts";


/** Live values on 2026-10-02. Admin Reset target and column defaults only — dispatch never reads these. */
export const BOOKING_DISPATCH_WAVE_RADIUS_DEFAULTS_METERS = Object.freeze({
  wave1: 13_000,
  wave2: 17_000,
  wave3: 29_000,
});


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

export * from "../../supabase/functions/_shared/bookingDispatchRadiusSSOT.ts";
