/**
 * expire-offers → auto-dispatch rebroadcast batch.
 * Bounded concurrency drains synchronized wave expiries without changing
 * per-trip invoke body / policy / service-role auth.
 */

import { assertGlobalRebroadcastAllowed } from "./rebroadcastPolicy.ts";
import {
  EXPIRE_OFFERS_AUTO_DISPATCH_SOURCE,
  invokeAutoDispatchWithServiceRole,
  type AutoDispatchServiceRoleBody,
  type DispatchTripContext,
  type InvokeAutoDispatchServiceRoleResult,
} from "./invokeAutoDispatchServiceRole.ts";
import { mapWithConcurrency } from "./mapWithConcurrency.ts";
import { OFFER_EXPIRED_TRIGGER_REASON } from "./sweepExpiredOffers.ts";

/** Default parallel auto-dispatch invokes per expire-offers tick. */
export const EXPIRE_OFFERS_REBROADCAST_CONCURRENCY_DEFAULT = 8;
export const EXPIRE_OFFERS_REBROADCAST_CONCURRENCY_MAX = 16;

export type ExpireOffersRebroadcastInvocation = {
  tripId: string;
  body: AutoDispatchServiceRoleBody;
};

export type ExpireOffersRebroadcastResult = {
  trip_id: string;
  success: boolean;
  trigger_reason?: string;
  outcome?: string;
  http_status?: number | null;
  error?: string;
};

export function resolveExpireOffersRebroadcastConcurrency(
  raw: string | undefined = typeof Deno !== "undefined" ? Deno.env.get("EXPIRE_OFFERS_REBROADCAST_CONCURRENCY") : undefined,
): number {
  if (raw == null || raw.trim() === "") return EXPIRE_OFFERS_REBROADCAST_CONCURRENCY_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return EXPIRE_OFFERS_REBROADCAST_CONCURRENCY_DEFAULT;
  return Math.max(1, Math.min(EXPIRE_OFFERS_REBROADCAST_CONCURRENCY_MAX, Math.floor(n)));
}

export function rebroadcastSourceForTrigger(triggerReason: string | undefined): string {
  if (triggerReason === "offer_expired") return "expire-offers:offer_expired_sweep";
  if (triggerReason === "search_window_recheck") return "expire-offers:search_window_recheck";
  if (triggerReason === "vehicle_type_selected_stuck_recovery") {
    return "expire-offers:vehicle_type_selected_stuck_recovery";
  }
  return "expire-offers:stale_trip_scan";
}

export type RunExpireOffersRebroadcastBatchDeps = {
  // deno-lint-ignore no-explicit-any
  supabase: any;
  supabaseUrl: string;
  serviceRoleKey: string;
  invocations: readonly ExpireOffersRebroadcastInvocation[];
  concurrency?: number;
  // deno-lint-ignore no-explicit-any
  loadDispatchTripContext: (supabase: any, tripId: string) => Promise<DispatchTripContext | undefined>;
  invokeAutoDispatch?: typeof invokeAutoDispatchWithServiceRole;
  assertRebroadcastAllowed?: typeof assertGlobalRebroadcastAllowed;
};

function resultFromDispatch(
  tripId: string,
  triggerReason: string | undefined,
  dispatchResult: InvokeAutoDispatchServiceRoleResult,
): ExpireOffersRebroadcastResult {
  if (!dispatchResult.ok) {
    return {
      trip_id: tripId,
      success: false,
      trigger_reason: triggerReason,
      outcome: dispatchResult.outcome,
      http_status: dispatchResult.httpStatus,
      error: dispatchResult.errorCode ?? "non-2xx",
    };
  }
  return {
    trip_id: tripId,
    success: true,
    trigger_reason: triggerReason,
    outcome: dispatchResult.outcome,
    http_status: dispatchResult.httpStatus,
  };
}

/**
 * Run one auto-dispatch invoke per trip with bounded concurrency.
 * Skipped policy denials are omitted from results (same as prior serial loop `continue`).
 */
export async function runExpireOffersRebroadcastBatch(
  deps: RunExpireOffersRebroadcastBatchDeps,
): Promise<ExpireOffersRebroadcastResult[]> {
  const concurrency = deps.concurrency ?? resolveExpireOffersRebroadcastConcurrency();
  const invoke = deps.invokeAutoDispatch ?? invokeAutoDispatchWithServiceRole;
  const assertAllowed = deps.assertRebroadcastAllowed ?? assertGlobalRebroadcastAllowed;

  const settled = await mapWithConcurrency(deps.invocations, concurrency, async ({ tripId, body }) => {
    const rebroadcastSource = rebroadcastSourceForTrigger(body.trigger_reason);

    try {
      const allowed = await assertAllowed(deps.supabase, tripId, rebroadcastSource);
      if (!allowed) return null;

      const tripContext = await deps.loadDispatchTripContext(deps.supabase, tripId);
      const dispatchResult = await invoke({
        supabaseUrl: deps.supabaseUrl,
        serviceRoleKey: deps.serviceRoleKey,
        body,
        source: EXPIRE_OFFERS_AUTO_DISPATCH_SOURCE,
        tripContext,
      });

      if (!dispatchResult.ok) {
        console.error("[expire-offers] auto-dispatch non-2xx", dispatchResult.logPayload);
      } else {
        const isOfferExpiredWave = body.trigger_reason === OFFER_EXPIRED_TRIGGER_REASON;
        if (isOfferExpiredWave) {
          console.log("[expire-offers] next_wave_started", {
            trip_id: tripId,
            reason_for_next_wave: body.reason_for_next_wave ?? OFFER_EXPIRED_TRIGGER_REASON,
            outcome: dispatchResult.outcome,
            http_status: dispatchResult.httpStatus,
            dispatchResult: dispatchResult.responseBody,
          });
        }
        console.log("[expire-offers] Rebroadcast success for", tripId, {
          trigger_reason: body.trigger_reason,
          reason_for_next_wave: body.reason_for_next_wave ?? null,
          outcome: dispatchResult.outcome,
          http_status: dispatchResult.httpStatus,
          dispatchResult: dispatchResult.responseBody,
        });
      }

      return resultFromDispatch(tripId, body.trigger_reason, dispatchResult);
    } catch (err) {
      console.error("[expire-offers] Rebroadcast exception for", tripId, err);
      return {
        trip_id: tripId,
        success: false,
        trigger_reason: body.trigger_reason,
        error: String(err),
      } satisfies ExpireOffersRebroadcastResult;
    }
  });

  return settled.filter((row): row is ExpireOffersRebroadcastResult => row != null);
}
