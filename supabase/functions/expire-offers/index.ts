import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  securityHeaders,
  jsonHeaders,
  handleCORSPreflight,
  checkRateLimit,
  rateLimitResponse,
  getClientIP,
  successResponse,
  errorResponse,
  isValidUUID,
} from "../_shared/security.ts";
import { assertGlobalRebroadcastAllowed } from "../_shared/rebroadcastPolicy.ts";
import { finalizeNegotiationFailureAndRebroadcast } from "../_shared/negotiationFailureRematch.ts";
import {
  buildRebroadcastInvocations,
  buildVehicleTypeSelectedStuckInvocations,
  filterTripIdsWithNoPendingOffers,
  findStuckVehicleTypeSelectedTrips,
  isOfferExpiryWaveEnabled,
  DEFAULT_MAX_BROADCAST_SEQUENCES,
  OFFER_EXPIRED_TRIGGER_REASON,
  sweepExpiredOffers,
} from "../_shared/sweepExpiredOffers.ts";
import {
  filterTripIdsExcludingTerminal,
  isTripTerminalForDispatch,
} from "../_shared/tripTerminalDispatch.ts";
import { FINDING_ANOTHER_DRIVER_UPDATED_FARE_BODY } from "../_shared/negotiationPushCopy.ts";
import {
  shouldTimeoutAbandonedDecisionHold,
  shouldTimeoutWaitingCustomer,
} from "../_shared/customerNegotiationDecisionHold.ts";
import { enterDriverSecondChanceAtOriginalFare } from "../_shared/customerNegotiationGrace.ts";
import {
  EXPIRE_OFFERS_AUTO_DISPATCH_SOURCE,
  invokeAutoDispatchWithServiceRole,
  type DispatchTripContext,
} from "../_shared/invokeAutoDispatchServiceRole.ts";

// Rate limit: 60 requests per minute (for cron jobs)
const RATE_LIMIT_CONFIG = { limit: 60, windowMs: 60000, keyPrefix: 'expire-offers' };

/**
 * Fire-and-forget negotiation expiry push to customer and driver.
 */
async function sendNegotiationExpiredPush(
  supabaseUrl: string,
  serviceKey: string,
  supabase: ReturnType<typeof createClient>,
  tripId: string,
  offerId: string,
  driverId: string | null,
) {
  try {
    const { data: tripRow } = await supabase
      .from("trips")
      .select("passenger_id")
      .eq("id", tripId)
      .maybeSingle();

    if (tripRow?.passenger_id) {
      await fetch(`${supabaseUrl}/functions/v1/send-trip-notification`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${serviceKey}`,
        },
        body: JSON.stringify({
          userId: tripRow.passenger_id,
          tripId,
          event: "negotiation_offer_expired",
        }),
      });
    }

    if (driverId) {
      await fetch(`${supabaseUrl}/functions/v1/send-driver-notification`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${serviceKey}`,
        },
        body: JSON.stringify({
          driverId,
          type: "NEGOTIATION_UPDATE",
          title: "Fare offer expired",
          body: "The fare offer timed out.",
          data: {
            type: "NEGOTIATION_UPDATE",
            notificationType: "negotiation_offer_expired",
            offer_id: offerId,
            trip_id: tripId,
            tripId,
            offerId,
          },
        }),
      });
    }
  } catch (e) {
    console.warn("[expire-offers] negotiation_offer_expired push error:", e);
  }
}

async function loadDispatchTripContext(
  supabase: ReturnType<typeof createClient>,
  tripId: string,
): Promise<DispatchTripContext> {
  const { data } = await supabase
    .from("trips")
    .select("id, trip_number, current_broadcast_round, searching_expires_at, expires_at")
    .eq("id", tripId)
    .maybeSingle();
  const row = data as {
    trip_number?: string | null;
    current_broadcast_round?: number | null;
    searching_expires_at?: string | null;
    expires_at?: string | null;
  } | null;
  return {
    tripId,
    publicTripId: row?.trip_number ?? null,
    currentSequence: row?.current_broadcast_round ?? null,
    ttlDeadline: row?.searching_expires_at ?? row?.expires_at ?? null,
  };
}

/**
 * Fire-and-forget RIDE_STOP push to dismiss native notification on driver's device.
 */
async function sendRideStopPush(
  supabaseUrl: string,
  serviceKey: string,
  driverId: string,
  reason: string,
  ids?: { offer_id?: string; trip_id?: string },
) {
  try {
    const data: Record<string, string> = {
      stopReason: reason,
      stop_reason: reason,
      offer_status: "expired",
    };
    if (ids?.offer_id) {
      data.offer_id = ids.offer_id;
      data.offerId = ids.offer_id;
    }
    if (ids?.trip_id) {
      data.trip_id = ids.trip_id;
      data.tripId = ids.trip_id;
      data.booking_id = ids.trip_id;
      data.bookingId = ids.trip_id;
    }
    await fetch(`${supabaseUrl}/functions/v1/send-driver-notification`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({
        driverId,
        type: "RIDE_STOP",
        title: "Ride Update",
        body: "Ride offer expired",
        data,
      }),
    });
  } catch (e) {
    console.warn(`[expire-offers] RIDE_STOP push error for ${driverId}:`, e);
  }
}

/**
 * Expire Offers Edge Function
 * 
 * This function should be called periodically (e.g., every 5-10 seconds via cron)
 * to expire stale offers and trigger rebroadcasts for trips that need them.
 * 
 * Flow:
 * 1. Expire all pending offers that have passed their expires_at time
 * 2. Find trips that still need drivers (all offers expired/declined)
 * 3. Trigger rebroadcast for those trips (up to max rounds)
 */
Deno.serve(async (req) => {
  console.log("[expire-offers] Received request:", req.method);

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return handleCORSPreflight();
  }

  // Rate limiting
  const clientIP = getClientIP(req);
  const rateLimitResult = checkRateLimit(clientIP, RATE_LIMIT_CONFIG);
  if (!rateLimitResult.allowed) {
    console.warn("[expire-offers] Rate limit exceeded for IP:", clientIP);
    return rateLimitResponse(rateLimitResult);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // ACK miss (~10s) is handled by pg_cron ack_timeout_sweep() → ack-timeout-sweep edge (work-gated).
    // Do not chain invoke here — it doubled Edge invocations on every expire-offers cron tick.

    // ─── 0a. Negotiation timeouts (two-phase industry standard) ───────────────
    // Customer £Y timeout → Driver second chance at original £X (same as Decline).
    // Driver £Z / second-chance timeout → exclude driver + same-trip rematch.
    const nowIso = new Date().toISOString();

    const { data: customerResponseExpired } = await supabase
      .from("ride_offers")
      .select("id, driver_id, trip_id, negotiation_status, customer_respond_by, responded_at")
      .eq("negotiation_status", "waiting_customer")
      .lt("customer_respond_by", nowIso);

    for (const o of customerResponseExpired || []) {
      try {
        const { data: offerGuard } = await supabase
          .from("ride_offers")
          .select("status, negotiation_status, responded_at")
          .eq("id", o.id)
          .maybeSingle();
        if (offerGuard?.status === "accepted" || offerGuard?.negotiation_status === "confirmed") continue;
        if (
          !shouldTimeoutWaitingCustomer({
            negotiationStatus: offerGuard?.negotiation_status ?? o.negotiation_status,
            customerRespondByIso: o.customer_respond_by,
            respondedAtIso: offerGuard?.responded_at ?? o.responded_at,
            nowMs: Date.now(),
          })
        ) {
          continue;
        }

        if (o.driver_id) {
          await enterDriverSecondChanceAtOriginalFare(supabase, {
            offer_id: o.id,
            trip_id: o.trip_id,
            driver_id: o.driver_id,
            reason: "timeout_customer",
          });
        }
        console.log("[expire-offers] Customer response timeout → Driver second chance £X", o.id);
      } catch (e) {
        console.warn("[expire-offers] customer grace start error", o.id, e);
      }
    }

    const { data: counterResponseExpired } = await supabase
      .from("ride_offers")
      .select("id, driver_id, trip_id, negotiation_status, customer_counter_fare, offer_snapshot, driver_respond_by")
      .eq("negotiation_status", "waiting_driver_final")
      .not("driver_respond_by", "is", null)
      .lt("driver_respond_by", nowIso);

    const { data: graceExpiredOffers } = await supabase
      .from("ride_offers")
      .select("id, driver_id, trip_id, negotiation_status, customer_counter_fare, offer_snapshot, grace_window_expires_at")
      .eq("negotiation_status", "declined_customer_awaiting_driver")
      .not("grace_window_expires_at", "is", null)
      .lt("grace_window_expires_at", nowIso);

    const timedOutNegotiations = [
      ...(counterResponseExpired || []),
      ...(graceExpiredOffers || []),
    ];

    for (const o of timedOutNegotiations) {
      try {
        const { data: offerGuard } = await supabase
          .from("ride_offers")
          .select("status, negotiation_status")
          .eq("id", o.id)
          .maybeSingle();
        if (
          offerGuard?.status === "accepted"
          || offerGuard?.negotiation_status === "confirmed"
        ) {
          continue;
        }

        const { data: tripGuard } = await supabase
          .from("trips")
          .select("status, dispatch_status, driver_id")
          .eq("id", o.trip_id)
          .maybeSingle();
        if (
          tripGuard?.driver_id
          && (tripGuard.status === "accepted" || tripGuard.dispatch_status === "assigned")
        ) {
          continue;
        }

        const graceWindowExpiresAt =
          (o as { grace_window_expires_at?: string | null }).grace_window_expires_at;
        const isGraceExpired =
          o.negotiation_status === "declined_customer_awaiting_driver"
          && graceWindowExpiresAt
          && new Date(graceWindowExpiresAt).getTime() < Date.now();

        if (o.negotiation_status === "declined_customer_awaiting_driver" && !isGraceExpired) {
          continue;
        }

        const isWaitingDriver = o.negotiation_status === "waiting_driver_final";
        const offerNegStatus = isWaitingDriver ? "timeout_driver" : "declined_driver";
        const offerTerminalStatus = isWaitingDriver ? "expired" : "declined";

        if (o.driver_id) {
          await finalizeNegotiationFailureAndRebroadcast(supabase, {
            tripId: o.trip_id,
            failedDriverId: o.driver_id,
            offerId: o.id,
            offerTerminalStatus,
            offerNegotiationStatus: offerNegStatus,
          });
          console.log("[expire-offers] Negotiation rematch after grace/counter timeout", o.trip_id);
          if (isWaitingDriver) {
            try {
              const { data: tripRow } = await supabase
                .from("trips")
                .select("passenger_id")
                .eq("id", o.trip_id)
                .maybeSingle();
              if (tripRow?.passenger_id) {
                await fetch(`${supabaseUrl}/functions/v1/send-trip-notification`, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${supabaseKey}`,
                  },
                  body: JSON.stringify({
                    userId: tripRow.passenger_id,
                    tripId: o.trip_id,
                    event: "finding_another_driver_updated_fare",
                    title: "Finding another driver",
                    body: FINDING_ANOTHER_DRIVER_UPDATED_FARE_BODY,
                  }),
                });
              }
            } catch (pushErr) {
              console.warn("[expire-offers] updated-fare customer push failed", o.id, pushErr);
            }
          }
        }
      } catch (e) {
        console.warn("[expire-offers] Negotiation timeout handler error for offer", o.id, e);
      }
    }

    // ─── 0b. Stuck negotiation safety net ────────────────────────────────────
    // Catch offers stuck in negotiation states with no deadline set (should never happen,
    // but if it does the ride is permanently stuck). Use created_at age > 90s as backstop.
    const stuckCutoff = new Date(Date.now() - 90_000).toISOString();

    const { data: stuckWaitingCustomer } = await supabase
      .from("ride_offers")
      .select("id, driver_id, trip_id, negotiation_status")
      .eq("negotiation_status", "waiting_customer")
      .is("customer_respond_by", null)
      .lt("updated_at", stuckCutoff);

    const { data: abandonedDecisionHolds } = await supabase
      .from("ride_offers")
      .select("id, driver_id, trip_id, negotiation_status, responded_at")
      .eq("negotiation_status", "waiting_customer")
      .not("responded_at", "is", null)
      .lt("responded_at", stuckCutoff);

    for (const o of [...(stuckWaitingCustomer || []), ...(abandonedDecisionHolds || [])]) {
      try {
        const { data: offerGuard } = await supabase
          .from("ride_offers")
          .select("status, negotiation_status")
          .eq("id", o.id)
          .maybeSingle();
        if (offerGuard?.status === "accepted" || offerGuard?.negotiation_status === "confirmed") continue;
        if (
          (o as { responded_at?: string | null }).responded_at
          && !shouldTimeoutAbandonedDecisionHold({
            negotiationStatus: offerGuard?.negotiation_status ?? o.negotiation_status,
            respondedAtIso: (o as { responded_at?: string | null }).responded_at,
            nowMs: Date.now(),
          })
        ) {
          continue;
        }

        if (o.driver_id) {
          await finalizeNegotiationFailureAndRebroadcast(supabase, {
            tripId: o.trip_id,
            failedDriverId: o.driver_id,
            offerId: o.id,
            offerTerminalStatus: "expired",
            offerNegotiationStatus: "timeout_customer",
          });
        }
        console.log("[expire-offers] Stuck waiting_customer (no deadline) → rematch", o.id);
      } catch (e) {
        console.warn("[expire-offers] stuck waiting_customer error", o.id, e);
      }
    }

    const { data: stuckWaitingDriver } = await supabase
      .from("ride_offers")
      .select("id, driver_id, trip_id, negotiation_status")
      .eq("negotiation_status", "waiting_driver_final")
      .is("driver_respond_by", null)
      .lt("updated_at", stuckCutoff);

    for (const o of stuckWaitingDriver || []) {
      try {
        const { data: offerGuard } = await supabase
          .from("ride_offers")
          .select("status, negotiation_status")
          .eq("id", o.id)
          .maybeSingle();
        if (offerGuard?.status === "accepted" || offerGuard?.negotiation_status === "confirmed") continue;

        if (o.driver_id) {
          await finalizeNegotiationFailureAndRebroadcast(supabase, {
            tripId: o.trip_id,
            failedDriverId: o.driver_id,
            offerId: o.id,
            offerTerminalStatus: "expired",
            offerNegotiationStatus: "timeout_driver",
          });
          console.log("[expire-offers] Stuck waiting_driver_final (no deadline) → rematch", o.id);
        }
      } catch (e) {
        console.warn("[expire-offers] stuck waiting_driver_final error", o.id, e);
      }
    }

    // ─── 0c. Stuck trips: negotiating status with no active offer ─────────────
    const { data: stuckNegotiatingTrips } = await supabase
      .from("trips")
      .select("id, negotiation_owner_driver_id, updated_at")
      .eq("status", "negotiating")
      .lt("updated_at", stuckCutoff);

    for (const t of stuckNegotiatingTrips || []) {
      try {
        const { count } = await supabase
          .from("ride_offers")
          .select("id", { count: "exact", head: true })
          .eq("trip_id", t.id)
          .in("negotiation_status", [
            "waiting_customer",
            "waiting_driver_final",
            "declined_customer_awaiting_driver",
          ]);

        if ((count ?? 0) === 0) {
          // Rematch trigger requires exclusion / negotiation_disabled evidence.
          // Prefer the same finalize RPC as Decline / timeout so pre-hold stays intact.
          if (t.negotiation_owner_driver_id) {
            const rematch = await finalizeNegotiationFailureAndRebroadcast(supabase, {
              tripId: t.id,
              failedDriverId: t.negotiation_owner_driver_id,
              offerId: null,
              offerTerminalStatus: "expired",
              offerNegotiationStatus: "timeout_customer",
            });
            console.log(
              "[expire-offers] Stuck negotiating trip (no active offers) → finalize rematch",
              t.id,
              rematch,
            );
            continue;
          }

          await supabase
            .from("trips")
            .update({
              status: "searching_new_driver",
              dispatch_status: "broadcasting",
              broadcast_enabled: true,
              negotiation_owner_driver_id: null,
              negotiation_locked_until: null,
              current_negotiation_id: null,
              negotiation_status: "failed",
              negotiation_disabled: true,
              updated_at: new Date().toISOString(),
            })
            .eq("id", t.id)
            .eq("status", "negotiating");

          console.log("[expire-offers] Stuck negotiating trip (no active offers) → searching_new_driver", t.id);

          await assertGlobalRebroadcastAllowed(supabase, t.id, "expire-offers:stuck_negotiating_trip")
            .then(async (allowed) => {
              if (allowed) {
                const tripContext = await loadDispatchTripContext(supabase, t.id);
                const dispatchResult = await invokeAutoDispatchWithServiceRole({
                  supabaseUrl,
                  serviceRoleKey: supabaseKey,
                  body: { trip_id: t.id, force_rebroadcast: true, trigger_reason: "stuck_negotiation_recovery" },
                  source: EXPIRE_OFFERS_AUTO_DISPATCH_SOURCE,
                  tripContext,
                });
                if (!dispatchResult.ok) {
                  console.error("[expire-offers] auto-dispatch non-2xx", dispatchResult.logPayload);
                }
              }
            })
            .catch((e) => console.warn("[expire-offers] stuck trip rebroadcast error", t.id, e));
        }
      } catch (e) {
        console.warn("[expire-offers] stuck negotiating trip error", t.id, e);
      }
    }

    // 0. Collect pending offers passed expires_at (before RPC marks them expired)
    const { data: soonExpiredOffers } = await supabase
      .from("ride_offers")
      .select("id, driver_id, trip_id, negotiation_status")
      .eq("status", "pending")
      .is("negotiation_status", null)
      .lt("expires_at", new Date().toISOString());

    // 1. sweep_expired_offers — mark stale pending offers expired (expire_stale_offers RPC)
    const sweepResult = await sweepExpiredOffers(supabase);

    if (!sweepResult.ok) {
      console.error("[expire-offers] sweep_expired_offers RPC error:", sweepResult.error);
      return errorResponse(
        "DB_ERROR",
        "Failed to expire offers",
        500,
        sweepResult.error,
      );
    }

    const expireResult = sweepResult.result;

    // Send RIDE_STOP per expiring row so payloads carry offer/booking identities for native clients.
    if (soonExpiredOffers && soonExpiredOffers.length > 0) {
      console.log(`[expire-offers] Sending RIDE_STOP for ${soonExpiredOffers.length} offer row(s)`);
      for (const row of soonExpiredOffers) {
        if (!row.driver_id) continue;
        sendRideStopPush(supabaseUrl, supabaseKey, row.driver_id, "offer_expired", {
          offer_id: row.id,
          trip_id: row.trip_id,
        });
      }
    }

    console.log("[expire-offers] Expired:", expireResult);

    const expiredCount = expireResult?.expired_count || 0;
    const tripsFromRpc: string[] = expireResult?.trips_needing_rebroadcast || [];
    if (expiredCount > 0) {
      console.log("[expire-offers] offer_expired", {
        expired_count: expiredCount,
        trips_from_rpc: tripsFromRpc.length,
      });
    }

    const tripsNeedingRebroadcast = await filterTripIdsExcludingTerminal(
      supabase,
      await filterTripIdsWithNoPendingOffers(supabase, tripsFromRpc),
    );

    if (tripsNeedingRebroadcast.length > 0) {
      console.log("[expire-offers] current_wave_resolved", {
        trip_ids: tripsNeedingRebroadcast,
        count: tripsNeedingRebroadcast.length,
      });
    }

    // 2. Find trips with all offers resolved but still searching
    // Scan & Go retired (trips.scan_go dropped 20260903121500) — do not SELECT or branch on it.
    const { data: staleTrips, error: tripsError } = await supabase
      .from("trips")
      .select("id, current_broadcast_round, max_broadcast_rounds, broadcast_enabled, status, scheduled_status, dispatch_status")
      .in("status", ["searching", "searching_new_driver", "offered", "pending", "broadcasting"])
      .eq("dispatch_status", "broadcasting");

    if (tripsError) {
      console.error("[expire-offers] Error fetching trips:", tripsError);
    }

    // Check which trips have no pending offers left
    const tripsToRebroadcast: string[] = [];
    const searchWindowRecheckTripIds: string[] = [];

    for (const trip of (staleTrips || [])) {
      if (isTripTerminalForDispatch(trip)) {
        continue;
      }
      if ((trip as { broadcast_enabled?: boolean }).broadcast_enabled === false) {
        continue;
      }
      // Validate trip ID
      if (!isValidUUID(trip.id)) {
        console.warn("[expire-offers] Invalid trip ID found, skipping:", trip.id);
        continue;
      }

      // Check if trip has any pending offers
      const { count } = await supabase
        .from("ride_offers")
        .select("id", { count: "exact", head: true })
        .eq("trip_id", trip.id)
        .eq("status", "pending");

      if (count === 0) {
        // No pending offers - check if we should rebroadcast
        const currentRound = trip.current_broadcast_round || 0;
        // trips.max_broadcast_rounds is absolute sequences (cycles × 3).
        const maxRounds = trip.max_broadcast_rounds || DEFAULT_MAX_BROADCAST_SEQUENCES;

        if (currentRound < maxRounds) {
          tripsToRebroadcast.push(trip.id);
        } else {
          // SSOT: expire_trip_when_search_exhausted respects searching_expires_at + legacy created_at fallback.
          const { data: expired, error: expireErr } = await supabase.rpc(
            "expire_trip_when_search_exhausted",
            { p_trip_id: trip.id },
          );
          if (expireErr) {
            console.warn("[expire-offers] expire_trip_when_search_exhausted failed:", trip.id, expireErr);
          } else if (expired === true) {
            console.log("[expire-offers] trip_expired_after_final_wave", {
              trip_id: trip.id,
              current_broadcast_round: currentRound,
              max_broadcast_rounds: maxRounds,
            });
          } else {
            searchWindowRecheckTripIds.push(trip.id);
            console.log("[expire-offers] Max waves done; customer search window still active:", trip.id);
          }
        }
      }
    }

    // 3. Trigger rebroadcast — one invoke per trip; offer_expired reason for expiry sweep
    const offerExpiryWaveEnabled = isOfferExpiryWaveEnabled();
    if (!offerExpiryWaveEnabled && tripsFromRpc.length > 0) {
      console.warn(
        "[expire-offers] DISPATCH_OFFER_EXPIRY_WAVE_ENABLED=false — skipping RPC expiry rebroadcast",
        { trips_skipped: tripsFromRpc.length },
      );
    }

    const stuckVehicleTypeSelectedTripIds = await filterTripIdsExcludingTerminal(
      supabase,
      await findStuckVehicleTypeSelectedTrips(supabase),
    );
    if (stuckVehicleTypeSelectedTripIds.length > 0) {
      console.log("[expire-offers] vehicle_type_selected_stuck_recovery", {
        trip_ids: stuckVehicleTypeSelectedTripIds,
        count: stuckVehicleTypeSelectedTripIds.length,
      });
    }

    const rebroadcastInvocations = offerExpiryWaveEnabled
      ? buildRebroadcastInvocations(
        tripsNeedingRebroadcast,
        tripsToRebroadcast,
        searchWindowRecheckTripIds,
      )
      : buildRebroadcastInvocations([], tripsToRebroadcast, searchWindowRecheckTripIds);

    const coveredTripIds = new Set(rebroadcastInvocations.map((invocation) => invocation.tripId));
    const stuckInvocations = buildVehicleTypeSelectedStuckInvocations(
      stuckVehicleTypeSelectedTripIds.filter((tripId) => !coveredTripIds.has(tripId)),
    );
    const allRebroadcastInvocations = [...rebroadcastInvocations, ...stuckInvocations];

    const rebroadcastResults: {
      trip_id: string;
      success: boolean;
      trigger_reason?: string;
      outcome?: string;
      http_status?: number | null;
      error?: string;
    }[] = [];

    for (const { tripId, body } of allRebroadcastInvocations) {
      const rebroadcastSource =
        body.trigger_reason === "offer_expired"
          ? "expire-offers:offer_expired_sweep"
          : body.trigger_reason === "search_window_recheck"
          ? "expire-offers:search_window_recheck"
          : body.trigger_reason === "vehicle_type_selected_stuck_recovery"
          ? "expire-offers:vehicle_type_selected_stuck_recovery"
          : "expire-offers:stale_trip_scan";

      try {
        const allowed = await assertGlobalRebroadcastAllowed(supabase, tripId, rebroadcastSource);
        if (!allowed) continue;

        const tripContext = await loadDispatchTripContext(supabase, tripId);
        const dispatchResult = await invokeAutoDispatchWithServiceRole({
          supabaseUrl,
          serviceRoleKey: supabaseKey,
          body,
          source: EXPIRE_OFFERS_AUTO_DISPATCH_SOURCE,
          tripContext,
        });

        if (!dispatchResult.ok) {
          console.error("[expire-offers] auto-dispatch non-2xx", dispatchResult.logPayload);
          rebroadcastResults.push({
            trip_id: tripId,
            success: false,
            trigger_reason: body.trigger_reason,
            outcome: dispatchResult.outcome,
            http_status: dispatchResult.httpStatus,
            error: dispatchResult.errorCode ?? "non-2xx",
          });
        } else {
          const isOfferExpiredWave =
            body.trigger_reason === OFFER_EXPIRED_TRIGGER_REASON;
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
          rebroadcastResults.push({
            trip_id: tripId,
            success: true,
            trigger_reason: body.trigger_reason,
            outcome: dispatchResult.outcome,
            http_status: dispatchResult.httpStatus,
          });
        }
      } catch (err) {
        console.error("[expire-offers] Rebroadcast exception for", tripId, err);
        rebroadcastResults.push({
          trip_id: tripId,
          success: false,
          trigger_reason: body.trigger_reason,
          error: String(err),
        });
      }
    }

    return successResponse({
      success: true,
      expired_offers: expiredCount,
      trips_rebroadcast: rebroadcastResults.filter(r => r.success).length,
      trips_expired: (staleTrips || []).length - tripsToRebroadcast.length,
      details: {
        rebroadcast_results: rebroadcastResults,
        stuck_vehicle_type_selected_trips: stuckVehicleTypeSelectedTripIds,
      },
    });

  } catch (error) {
    console.error("[expire-offers] Error:", error);
    return errorResponse("INTERNAL_ERROR", String(error), 500);
  }
});
