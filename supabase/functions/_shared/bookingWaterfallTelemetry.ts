/**
 * P0 — Server-side booking waterfall step telemetry.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  type BookingWaterfallServerStepInput,
  type BookingWaterfallStep,
  buildBookingWaterfallStepRecord,
  previousStepFromOrder,
} from "../../../shared/bookingWaterfallSSOT.ts";

export type { BookingWaterfallServerStepInput };

export type BookingWaterfallCollector = {
  clientActionId: string | null;
  tripId: string | null;
  startStep: (
    step: BookingWaterfallStep,
    source: string,
    metadata?: Record<string, string | number | boolean | null | undefined>,
  ) => void;
  completeStep: (
    step: BookingWaterfallStep,
    source: string,
    metadata?: Record<string, string | number | boolean | null | undefined>,
  ) => void;
  recordStep: (input: BookingWaterfallServerStepInput) => void;
  toResponseFragment: () => { booking_waterfall: BookingWaterfallServerStepInput[] };
  logTimeline: (label?: string) => void;
  persistOpsLog: (adminClient: SupabaseClient, extra?: Record<string, unknown>) => Promise<void>;
};

export function createBookingWaterfallCollector(input?: {
  client_action_id?: string | null;
  trip_id?: string | null;
  pay_tapped_at_ms?: number | null;
}): BookingWaterfallCollector {
  const clientActionId = input?.client_action_id?.trim() || null;
  const tripId = input?.trip_id?.trim() || null;
  const stepStarts = new Map<BookingWaterfallStep, number>();
  const steps: BookingWaterfallServerStepInput[] = [];

  const recordStep = (record: BookingWaterfallServerStepInput) => {
    const existingIdx = steps.findIndex((s) => s.step === record.step);
    if (existingIdx >= 0) {
      steps[existingIdx] = record;
    } else {
      steps.push(record);
    }
    console.info("BOOKING_WATERFALL_STEP", {
      client_action_id: clientActionId,
      trip_id: tripId,
      ...record,
      duration_ms: Math.max(0, record.finish_time_ms - record.start_time_ms),
    });
  };

  const startStep = (
    step: BookingWaterfallStep,
    source: string,
    metadata?: Record<string, string | number | boolean | null | undefined>,
  ) => {
    stepStarts.set(step, Date.now());
    recordStep({
      step,
      start_time_ms: stepStarts.get(step)!,
      finish_time_ms: stepStarts.get(step)!,
      source,
      blocking_dependency: previousStepFromOrder(step),
      metadata,
    });
  };

  const completeStep = (
    step: BookingWaterfallStep,
    source: string,
    metadata?: Record<string, string | number | boolean | null | undefined>,
  ) => {
    const finish = Date.now();
    const start = stepStarts.get(step) ?? finish;
    recordStep({
      step,
      start_time_ms: start,
      finish_time_ms: finish,
      source,
      blocking_dependency: previousStepFromOrder(step),
      metadata,
    });
  };

  if (input?.pay_tapped_at_ms) {
    recordStep({
      step: "pay_tapped",
      start_time_ms: input.pay_tapped_at_ms,
      finish_time_ms: input.pay_tapped_at_ms,
      source: "client:SelectVehicle/handleConfirmRide",
      blocking_dependency: null,
    });
  }

  return {
    clientActionId,
    tripId,
    startStep,
    completeStep,
    recordStep,
    toResponseFragment: () => ({ booking_waterfall: [...steps] }),
    logTimeline: (label = "BOOKING_WATERFALL_SERVER") => {
      console.info(label, {
        client_action_id: clientActionId,
        trip_id: tripId,
        steps: steps.map((s) => ({
          step: s.step,
          duration_ms: Math.max(0, s.finish_time_ms - s.start_time_ms),
          source: s.source,
        })),
      });
    },
    persistOpsLog: async (adminClient, extra = {}) => {
      if (!clientActionId && !tripId) return;
      try {
        await adminClient.from("ops_logs").insert({
          level: "info",
          source: "booking_waterfall",
          app: "customer_app",
          message: `booking_waterfall ${clientActionId ?? tripId}`,
          metadata: {
            client_action_id: clientActionId,
            trip_id: tripId,
            steps,
            ...extra,
          },
        });
      } catch (err) {
        console.warn("[bookingWaterfallTelemetry] ops_logs insert failed:", err);
      }
    },
  };
}

export function bookingWaterfallRecordsFromFragment(
  fragment: { booking_waterfall?: BookingWaterfallServerStepInput[] } | null | undefined,
) {
  if (!fragment?.booking_waterfall?.length) return [];
  return fragment.booking_waterfall.map((step) =>
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
