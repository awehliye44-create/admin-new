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

export type BookingWaterfallTimeline = {
  client_action_id: string | null;
  trip_id: string | null;
  payment_session_id: string | null;
  revolut_order_id: string | null;
  pay_tapped_at_ms: number | null;
  completed_at_ms: number | null;
  total_duration_ms: number | null;
  steps: BookingWaterfallStepRecord[];
  measured_duration_ms: number;
  unmeasured_gap_ms: number;
  dominant_steps: BookingWaterfallDominance[];
  /** Step accounting for ≥80% of measured wall time (may be multiple if tied). */
  p80_steps: BookingWaterfallDominance[];
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

export function mergeBookingWaterfallSteps(
  existing: BookingWaterfallStepRecord[],
  incoming: BookingWaterfallStepRecord[],
): BookingWaterfallStepRecord[] {
  const byStep = new Map<BookingWaterfallStep, BookingWaterfallStepRecord>();
  for (const record of existing) byStep.set(record.step, record);
  for (const record of incoming) {
    const prev = byStep.get(record.step);
    if (!prev || record.finish_time_ms >= prev.finish_time_ms) {
      byStep.set(record.step, record);
    }
  }
  return BOOKING_WATERFALL_STEP_ORDER
    .map((step) => byStep.get(step))
    .filter((record): record is BookingWaterfallStepRecord => Boolean(record));
}

export function analyzeBookingWaterfallDominance(
  steps: BookingWaterfallStepRecord[],
): { dominant_steps: BookingWaterfallDominance[]; p80_steps: BookingWaterfallDominance[]; measured_duration_ms: number; unmeasured_gap_ms: number } {
  if (steps.length === 0) {
    return { dominant_steps: [], p80_steps: [], measured_duration_ms: 0, unmeasured_gap_ms: 0 };
  }

  const measured_duration_ms = steps.reduce((sum, step) => sum + step.duration_ms, 0);
  const wall_start = steps[0]!.start_time_ms;
  const wall_end = steps[steps.length - 1]!.finish_time_ms;
  const wall_ms = Math.max(0, wall_end - wall_start);
  const unmeasured_gap_ms = Math.max(0, wall_ms - measured_duration_ms);

  const dominant_steps = [...steps]
    .map((record) => ({
      step: record.step,
      label: record.label,
      duration_ms: record.duration_ms,
      share_pct: measured_duration_ms > 0
        ? Math.round((record.duration_ms / measured_duration_ms) * 1000) / 10
        : 0,
    }))
    .sort((a, b) => b.duration_ms - a.duration_ms);

  let cumulative = 0;
  const p80_steps: BookingWaterfallDominance[] = [];
  for (const entry of dominant_steps) {
    if (cumulative >= 80 && p80_steps.length > 0) break;
    p80_steps.push(entry);
    cumulative += entry.share_pct;
  }

  return { dominant_steps, p80_steps, measured_duration_ms, unmeasured_gap_ms };
}

export function buildBookingWaterfallTimeline(input: {
  client_action_id?: string | null;
  trip_id?: string | null;
  payment_session_id?: string | null;
  revolut_order_id?: string | null;
  steps: BookingWaterfallStepRecord[];
}): BookingWaterfallTimeline {
  const steps = mergeBookingWaterfallSteps([], input.steps);
  const payStep = steps.find((s) => s.step === "pay_tapped") ?? null;
  const lastStep = steps[steps.length - 1] ?? null;
  const analysis = analyzeBookingWaterfallDominance(steps);

  return {
    client_action_id: input.client_action_id ?? null,
    trip_id: input.trip_id ?? null,
    payment_session_id: input.payment_session_id ?? null,
    revolut_order_id: input.revolut_order_id ?? null,
    pay_tapped_at_ms: payStep?.start_time_ms ?? null,
    completed_at_ms: lastStep?.finish_time_ms ?? null,
    total_duration_ms:
      payStep && lastStep
        ? Math.max(0, lastStep.finish_time_ms - payStep.start_time_ms)
        : null,
    steps,
    measured_duration_ms: analysis.measured_duration_ms,
    unmeasured_gap_ms: analysis.unmeasured_gap_ms,
    dominant_steps: analysis.dominant_steps,
    p80_steps: analysis.p80_steps,
  };
}

export function formatBookingWaterfallAscii(timeline: BookingWaterfallTimeline): string {
  const lines: string[] = [
    "BOOKING WATERFALL",
    `client_action_id: ${timeline.client_action_id ?? "—"}`,
    `trip_id: ${timeline.trip_id ?? "—"}`,
    `payment_session_id: ${timeline.payment_session_id ?? "—"}`,
    `revolut_order_id: ${timeline.revolut_order_id ?? "—"}`,
    `total: ${timeline.total_duration_ms ?? "—"}ms | measured: ${timeline.measured_duration_ms}ms | gaps: ${timeline.unmeasured_gap_ms}ms`,
    "",
    "step                              duration  start→finish (ms)  blocking              source",
    "────────────────────────────────────────────────────────────────────────────────────────",
  ];

  for (const step of timeline.steps) {
    const name = step.label.padEnd(32, " ");
    const dur = `${String(step.duration_ms).padStart(5, " ")}ms`;
    const span = `${step.start_time_ms}→${step.finish_time_ms}`;
    const blocker = (step.blocking_dependency ?? "—").padEnd(20, " ");
    lines.push(`${name}  ${dur}  ${span.padEnd(18, " ")}  ${blocker}  ${step.source}`);
  }

  if (timeline.p80_steps.length > 0) {
    lines.push("");
    lines.push("≥80% of measured wait:");
    for (const entry of timeline.p80_steps) {
      lines.push(`  • ${entry.label}: ${entry.duration_ms}ms (${entry.share_pct}%)`);
    }
  }

  return lines.join("\n");
}

export function serverStepsToRecords(
  steps: BookingWaterfallServerStepInput[],
): BookingWaterfallStepRecord[] {
  return steps.map((step) =>
    buildBookingWaterfallStepRecord({
      step: step.step,
      start_time_ms: step.start_time_ms,
      finish_time_ms: step.finish_time_ms,
      source: step.source,
      blocking_dependency: step.blocking_dependency ?? null,
      metadata: step.metadata,
    }),
  );
}
