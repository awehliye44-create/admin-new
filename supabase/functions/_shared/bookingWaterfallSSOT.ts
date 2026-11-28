/**
 * P0 — Booking waterfall SSOT (Pay tap → Finding Driver).
 * One ordered timeline per booking attempt; used for 80% wait-time analysis.
 */

export const BOOKING_WATERFALL_STEP_ORDER = [
  "pay_tapped",
  "payment_session_created",
  "revolut_order_created",
  "revolut_authorised",
  "trip_inserted",
  "dispatch_started",
  "first_ride_offer_created",
  "push_sent",
  "customer_entered_finding_driver",
] as const;

export type BookingWaterfallStep = (typeof BOOKING_WATERFALL_STEP_ORDER)[number];

export const BOOKING_WATERFALL_STEP_LABELS: Record<BookingWaterfallStep, string> = {
  pay_tapped: "Pay tapped",
  payment_session_created: "payment_session created",
  revolut_order_created: "Revolut order created",
  revolut_authorised: "Revolut authorised",
  trip_inserted: "Trip inserted",
  dispatch_started: "Dispatch started",
  first_ride_offer_created: "First ride_offer created",
  push_sent: "Push sent",
  customer_entered_finding_driver: "Customer entered Finding Driver",
};

export type BookingWaterfallStepRecord = {
  step: BookingWaterfallStep;
  label: string;
  start_time_ms: number;
  finish_time_ms: number;
  duration_ms: number;
  blocking_dependency: BookingWaterfallStep | null;
  source: string;
  metadata?: Record<string, string | number | boolean | null | undefined>;
};

export type BookingWaterfallDominance = {
  step: BookingWaterfallStep;
  label: string;
  duration_ms: number;
  share_pct: number;
};

export type BookingWaterfallMilestones = {
  book_tap_ms?: number | null;
  hold_start_ms?: number | null;
  hold_authorised_ms?: number | null;
  ctap_start_ms?: number | null;
  trip_inserted_ms?: number | null;
  ctap_response_ms?: number | null;
  dispatch_started_ms?: number | null;
  ride_offers_created_ms?: number | null;
  customer_finding_driver_ms?: number | null;
};

export type BookingWaterfallReportRow = {
  step: string;
  duration_ms: number;
  source: string;
  blocking_reason: string | null;
};

export function buildBookingWaterfallMilestoneReport(input: {
  milestones: BookingWaterfallMilestones;
  steps?: BookingWaterfallStepRecord[];
}): BookingWaterfallReportRow[] {
  const m = input.milestones;
  const rows: BookingWaterfallReportRow[] = [];

  const pairs: Array<[string, number | null | undefined, number | null | undefined, string]> = [
    ["book_tap → hold_start", m.book_tap_ms, m.hold_start_ms, "client preauth invoke"],
    ["hold_start → hold_authorised", m.hold_start_ms, m.hold_authorised_ms, "revolutPreauth.ts"],
    ["hold_authorised → ctap_start", m.hold_authorised_ms, m.ctap_start_ms, "client createTripAfterPayment"],
    ["ctap_start → trip_inserted", m.ctap_start_ms, m.trip_inserted_ms, "create-trip-after-payment"],
    ["trip_inserted → ctap_response", m.trip_inserted_ms, m.ctap_response_ms, "create-trip-after-payment HTTP"],
    ["ctap_response → dispatch_started", m.ctap_response_ms, m.dispatch_started_ms, "bookingPostCommit.ts"],
    ["dispatch_started → ride_offers_created", m.dispatch_started_ms, m.ride_offers_created_ms, "auto-dispatch"],
    ["ctap_response → finding_driver", m.ctap_response_ms, m.customer_finding_driver_ms, "client navigation"],
  ];

  for (const [label, start, end, source] of pairs) {
    if (start == null || end == null) continue;
    rows.push({
      step: label,
      duration_ms: Math.max(0, end - start),
      source,
      blocking_reason: rows.length === 0 ? null : pairs[rows.length]?.[3] ?? null,
    });
  }

  for (const step of input.steps ?? []) {
    rows.push({
      step: step.label,
      duration_ms: step.duration_ms,
      source: step.source,
      blocking_reason: step.blocking_dependency,
    });
  }

  return rows;
}

export type BookingWaterfallServerStepInput = {
  step: BookingWaterfallStep;
  start_time_ms: number;
  finish_time_ms: number;
  source: string;
  blocking_dependency?: BookingWaterfallStep | null;
  metadata?: Record<string, string | number | boolean | null | undefined>;
};

function previousStep(step: BookingWaterfallStep): BookingWaterfallStep | null {
  const idx = BOOKING_WATERFALL_STEP_ORDER.indexOf(step);
  return idx > 0 ? BOOKING_WATERFALL_STEP_ORDER[idx - 1]! : null;
}

/** Exported for server collectors. */
export function previousStepFromOrder(step: BookingWaterfallStep): BookingWaterfallStep | null {
  return previousStep(step);
}

export function buildBookingWaterfallStepRecord(input: {
  step: BookingWaterfallStep;
  start_time_ms: number;
  finish_time_ms: number;
  source: string;
  blocking_dependency?: BookingWaterfallStep | null;
  metadata?: Record<string, string | number | boolean | null | undefined>;
}): BookingWaterfallStepRecord {
  const finish = Math.max(input.start_time_ms, input.finish_time_ms);
  const start = Math.min(input.start_time_ms, finish);
  return {
    step: input.step,
    label: BOOKING_WATERFALL_STEP_LABELS[input.step],
    start_time_ms: start,
    finish_time_ms: finish,
    duration_ms: Math.max(0, finish - start),
    blocking_dependency: input.blocking_dependency ?? previousStep(input.step),
    source: input.source,
    metadata: input.metadata,
  };
}

