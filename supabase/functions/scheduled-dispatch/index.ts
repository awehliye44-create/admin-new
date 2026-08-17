import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  securityHeaders,
  jsonHeaders,
  checkRateLimit,
  getClientIP,
  rateLimitResponse,
  handleCORSPreflight,
  successResponse,
  errorResponse,
} from "../_shared/security.ts";
import { recordDispatchWaveSnapshot } from "../_shared/recordDispatchWaveSnapshot.ts";
import {
  resolveScheduledDispatchConfig,
  shouldConvertScheduledToUrgent,
  estimateEtaMinutes,
  computeCommitmentTime,
  predictedArrivalMs,
  isMovingAway,
} from "../_shared/scheduledDispatchConfig.ts";
import {
  blockedTerminalTripLogPayload,
  isTripTerminalForDispatch,
  revokePendingOffersForTerminalTrip,
} from "../_shared/tripTerminalDispatch.ts";
import {
  loadStackedRideConfig,
  logStackedRideDisabledSafeGuard,
} from "../_shared/stackedRideConfig.ts";

declare const EdgeRuntime:
  | { waitUntil?: (promise: Promise<unknown>) => void }
  | undefined;

const RATE_LIMIT_CONFIG = {
  limit: 30,
  windowMs: 60000,
  keyPrefix: "scheduled-dispatch",
};

function queueBackground(promise: Promise<unknown>) {
  if (typeof EdgeRuntime !== "undefined" && typeof EdgeRuntime.waitUntil === "function") {
    EdgeRuntime.waitUntil(promise);
    return;
  }
  void promise;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

interface ScheduledTrip {
  id: string;
  scheduled_at: string;
  scheduled_status: string;
  dispatch_mode: string;
  scheduled_broadcast_at: string | null;
  scheduled_convert_at: string | null;
  confirm_deadline_at: string | null;
  confirmed_driver_id: string | null;
  driver_id: string | null;
  status: string;
  dispatch_status?: string | null;
  searching_expires_at?: string | null;
  updated_at?: string | null;
  pickup_address: string;
  pickup_latitude: number | null;
  pickup_longitude: number | null;
  dropoff_address: string;
  dropoff_latitude: number | null;
  dropoff_longitude: number | null;
  estimated_fare: number;
  passenger_name: string;
  passenger_id?: string | null;
  trip_number?: string | null;
  final_fare_pence?: number | null;
  gross_fare_pence?: number | null;
  estimated_total_pence?: number | null;
  base_fare_pence?: number | null;
  currency_code?: string | null;
  fare?: number | null;
  // Commitment mode columns
  commitment_time?: string | null;
  scheduled_committed_at?: string | null;
  last_eta_minutes?: number | null;
  last_eta_calculated_at?: string | null;
  not_moving_alert_sent_at?: string | null;
  moving_away_alert_sent_at?: string | null;
  // §10 ETA risk + §14 driver-at-risk
  eta_risk_alert_sent_at?: string | null;
  scheduled_driver_risk?: boolean;
  // §13 admin escalation tracking
  no_driver_admin_alert_sent_at?: string | null;
  no_driver_customer_alert_sent_at?: string | null;
}

/** Send a push notification to a driver via send-driver-notification. */
async function sendDriverPush(
  supabase: ReturnType<typeof createClient>,
  args: { driverId: string; type: string; title: string; body: string; data?: Record<string, string> },
) {
  try {
    await supabase.functions.invoke("send-driver-notification", {
      body: {
        driverId: args.driverId,
        type: args.type,
        title: args.title,
        body: args.body,
        data: args.data ?? {},
      },
    });
  } catch (err) {
    console.warn("[scheduled-dispatch] driver push failed:", args.type, err);
  }
}

/** Send a push notification to a customer via send-customer-notification. */
async function sendCustomerPush(
  supabase: ReturnType<typeof createClient>,
  args: { passengerId: string; type: string; title: string; body: string; data?: Record<string, string> },
) {
  try {
    await supabase.functions.invoke("send-customer-notification", {
      body: {
        passengerId: args.passengerId,
        type: args.type,
        title: args.title,
        body: args.body,
        data: args.data ?? {},
      },
    });
  } catch (err) {
    console.warn("[scheduled-dispatch] customer push failed:", args.type, err);
  }
}

/** Send an admin alert via send-admin-notification (non-fatal). */
async function sendAdminAlert(
  supabase: ReturnType<typeof createClient>,
  args: { type: string; title: string; body: string; data?: Record<string, string> },
) {
  try {
    await supabase.functions.invoke("send-admin-notification", {
      body: {
        type: args.type,
        title: args.title,
        body: args.body,
        data: args.data ?? {},
      },
    });
  } catch (err) {
    console.warn("[scheduled-dispatch] admin alert failed:", args.type, err);
  }
}

async function logSnapshot(
  supabase: ReturnType<typeof createClient>,
  input: {
    tripId: string;
    action: string;
    stage?: "considered" | "offer_inserted";
    driverId?: string | null;
    metadata?: Record<string, unknown>;
  },
) {
  try {
    await recordDispatchWaveSnapshot(supabase, {
      tripId: input.tripId,
      dispatchRound: 1,
      stage: input.stage ?? "considered",
      driverId: input.driverId ?? null,
      rideOfferId: null,
      source: "scheduled_dispatch",
      metadata: { scheduled_action: input.action, ...(input.metadata ?? {}) },
    });
  } catch (err) {
    console.warn("[scheduled-dispatch] snapshot audit failed:", input.action, err);
  }
}

async function triggerAutoDispatch(args: {
  supabaseUrl: string;
  supabaseServiceKey: string;
  tripId: string;
  forceRebroadcast?: boolean;
  triggerReason: string;
}) {
  const { supabaseUrl, supabaseServiceKey, tripId, forceRebroadcast = true, triggerReason } = args;
  try {
    const resp = await fetch(`${supabaseUrl}/functions/v1/auto-dispatch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${supabaseServiceKey}`,
      },
      body: JSON.stringify({
        trip_id: tripId,
        force_rebroadcast: forceRebroadcast,
        trigger_reason: triggerReason,
      }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      console.error("[scheduled-dispatch] auto-dispatch failed:", resp.status, data);
      return { ok: false, data };
    }
    return { ok: true, data };
  } catch (err) {
    console.error("[scheduled-dispatch] auto-dispatch exception:", err);
    return { ok: false, data: { error: String(err) } };
  }
}

/** Release a committed driver back to broadcast: clear assignment and rebroadcast. */
async function releaseAndRebroadcast(
  supabase: ReturnType<typeof createClient>,
  args: {
    trip: ScheduledTrip;
    reason: string;
    now: Date;
    nowMs: number;
    supabaseUrl: string;
    supabaseServiceKey: string;
    urgent?: boolean;
  },
) {
  const { trip, reason, now } = args;
  const { error } = await supabase
    .from("trips")
    .update({
      driver_id: null,
      confirmed_driver_id: null,
      scheduled_status: "broadcasting",
      status: "offered",
      commitment_time: null,
      scheduled_committed_at: null,
      updated_at: now.toISOString(),
    })
    .eq("id", trip.id)
    .in("scheduled_status", ["scheduled_committed", "driver_assigned"]);

  if (error) {
    console.error("[scheduled-dispatch] releaseAndRebroadcast update failed:", trip.id, error);
    return;
  }

  console.log("SCHEDULED_DRIVER_RELEASED", {
    trip_id: trip.id,
    driver_id: trip.driver_id ?? trip.confirmed_driver_id,
    reason,
  });

  queueBackground(
    triggerAutoDispatch({
      supabaseUrl: args.supabaseUrl,
      supabaseServiceKey: args.supabaseServiceKey,
      tripId: trip.id,
      forceRebroadcast: true,
      triggerReason: reason,
    }),
  );

  // Notify customer
  if (trip.passenger_id) {
    queueBackground(
      sendCustomerPush(supabase, {
        passengerId: trip.passenger_id,
        type: "DRIVER_UNAVAILABLE",
        title: "Finding you a new driver",
        body: "Your driver is unavailable. We're finding a replacement now.",
        data: { trip_id: trip.id, reason },
      }),
    );
  }
}

// ─── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleCORSPreflight();

  const clientIP = getClientIP(req);
  const rateLimitResult = checkRateLimit(clientIP, RATE_LIMIT_CONFIG);
  if (!rateLimitResult.allowed) return rateLimitResponse(rateLimitResult);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const now = new Date();
    const nowMs = now.getTime();
    console.log(`[scheduled-dispatch] Running at ${now.toISOString()}`);

    const { data: globalSettings } = await supabase
      .from("global_dispatch_settings")
      .select(
        `enable_scheduled_to_urgent_conversion, scheduled_response_window_minutes,
         urgent_dispatch_trigger_minutes_before_pickup, locked_driver_response_minutes,
         max_driver_find_time_minutes, scheduled_urgent_card_label,
         target_arrival_minutes_before_pickup, not_moving_alert_after_seconds,
         moving_away_threshold_metres, moving_alert_debounce_minutes,
         critical_late_auto_release`,
      )
      .eq("singleton", true)
      .maybeSingle();

    const schedConfig = resolveScheduledDispatchConfig(globalSettings);
    const maxFindDriverMinutes = schedConfig.maxFindDriverMinutes;

    let committedCount = 0;
    let movementAlertsCount = 0;
    let broadcastStarted = 0;
    let convertedToInstant = 0;
    let expired = 0;
    let stackedRedispatched = 0;

    // ============================================================
    // STEP 1: COMMITMENT MODE — confirmed-driver path only
    // Admin Two paths: check-in / leave-by / Start journey / risk / rescue
    // — NOT the fixed urgent_dispatch_trigger_minutes_before_pickup.
    //
    // No second "accept" required. When now >= commitment_time
    // (which = scheduled_at − targetArrival − liveEta), the driver
    // is automatically committed: driver_id is set, the pickup card
    // is pushed to the driver, and the customer is notified.
    // ============================================================

    const lookAheadMs = 90 * 60 * 1000; // look 90 min ahead
    const lookAheadThreshold = new Date(nowMs + lookAheadMs).toISOString();

    const { data: tripsForActivation, error: activationError } = await supabase
      .from("trips")
      .select("*")
      .eq("dispatch_mode", "scheduled")
      .in("scheduled_status", ["scheduled", "driver_assigned"])
      .not("confirmed_driver_id", "is", null)
      .is("driver_id", null)
      .lte("scheduled_at", lookAheadThreshold)
      .gt("scheduled_at", new Date(nowMs - 30 * 60_000).toISOString());

    if (activationError) {
      console.error("[scheduled-dispatch] Error fetching trips for activation:", activationError);
    } else if (tripsForActivation && tripsForActivation.length > 0) {
      // Batch-fetch driver presence locations
      const driverIds = [...new Set(tripsForActivation.map((t: ScheduledTrip) => t.confirmed_driver_id).filter(Boolean))] as string[];

      const { data: presenceRows } = await supabase
        .from("driver_presence")
        .select("driver_id, lat, lng, last_location_at, status")
        .in("driver_id", driverIds);

      const presenceMap = new Map(
        (presenceRows ?? []).map((p: { driver_id: string; lat: number | null; lng: number | null; last_location_at: string | null; status: string }) => [p.driver_id, p]),
      );

      for (const trip of tripsForActivation as ScheduledTrip[]) {
        if (isTripTerminalForDispatch(trip)) continue;
        if (!trip.pickup_latitude || !trip.pickup_longitude) {
          console.warn(`[scheduled-dispatch] Trip ${trip.id} missing pickup coords — skipping`);
          continue;
        }

        const confirmedDriverId = trip.confirmed_driver_id!;
        const pickupMs = Date.parse(trip.scheduled_at);
        const targetArrivalMs = pickupMs - schedConfig.targetArrivalMinutesBeforePickup * 60_000;

        const presence = presenceMap.get(confirmedDriverId);
        const etaMinutes = estimateEtaMinutes(
          presence?.lat,
          presence?.lng,
          trip.pickup_latitude,
          trip.pickup_longitude,
        );

        // Recompute commitment_time on every tick for accuracy
        let commitmentTimeMs: number;
        if (etaMinutes != null) {
          commitmentTimeMs = computeCommitmentTime({
            scheduledAtMs: pickupMs,
            etaMinutes,
            targetArrivalMinutesBeforePickup: schedConfig.targetArrivalMinutesBeforePickup,
          }).getTime();
        } else {
          // Admin Two paths: confirmed drivers use Commitment Policy buffers —
          // never the no-preconfirmed urgent_dispatch_trigger_minutes_before_pickup.
          commitmentTimeMs =
            pickupMs - schedConfig.targetArrivalMinutesBeforePickup * 60_000;
        }

        // Not yet commitment time — update cached ETA and move on
        if (nowMs < commitmentTimeMs) {
          if (etaMinutes != null) {
            await supabase
              .from("trips")
              .update({
                commitment_time: new Date(commitmentTimeMs).toISOString(),
                last_eta_minutes: etaMinutes,
                last_eta_calculated_at: now.toISOString(),
              })
              .eq("id", trip.id);
          }
          console.log(`[scheduled-dispatch] Trip ${trip.id}: commitment not due until ${new Date(commitmentTimeMs).toISOString()}`);
          continue;
        }

        // ── Commit the driver ──────────────────────────────────
        console.log("SCHEDULED_COMMITMENT_MODE_TRIGGERED", {
          trip_id: trip.id,
          confirmed_driver_id: confirmedDriverId,
          scheduled_at: trip.scheduled_at,
          commitment_time: new Date(commitmentTimeMs).toISOString(),
          eta_minutes: etaMinutes,
          driver_lat: presence?.lat,
          driver_lng: presence?.lng,
        });

        const { error: commitError } = await supabase
          .from("trips")
          .update({
            driver_id: confirmedDriverId,
            scheduled_status: "scheduled_committed",
            status: "en_route_to_pickup",
            dispatch_status: "scheduled_committed",  // §9 SSOT
            scheduled_committed_at: now.toISOString(),
            commitment_time: new Date(commitmentTimeMs).toISOString(),
            last_eta_minutes: etaMinutes,
            last_eta_calculated_at: now.toISOString(),
            updated_at: now.toISOString(),
          })
          .eq("id", trip.id)
          .in("scheduled_status", ["scheduled", "driver_assigned"]);

        if (commitError) {
          console.error(`[scheduled-dispatch] Commit update failed for trip ${trip.id}:`, commitError);
          continue;
        }

        await logSnapshot(supabase, {
          tripId: trip.id,
          action: "commitment_mode_activated",
          stage: "considered",
          driverId: confirmedDriverId,
          metadata: {
            eta_minutes: etaMinutes,
            commitment_time: new Date(commitmentTimeMs).toISOString(),
            scheduled_at: trip.scheduled_at,
          },
        });

        // Push to driver: head to pickup
        queueBackground(
          sendDriverPush(supabase, {
            driverId: confirmedDriverId,
            type: "SCHEDULED_COMMITMENT",
            title: "Time to head to pickup",
            body: `Your scheduled job is starting. Head to ${trip.pickup_address}.`,
            data: {
              trip_id: trip.id,
              type: "scheduled_commitment",
              pickup_address: trip.pickup_address ?? "",
              scheduled_at: trip.scheduled_at,
            },
          }),
        );

        // Push to customer: driver is on the way
        if (trip.passenger_id) {
          queueBackground(
            sendCustomerPush(supabase, {
              passengerId: trip.passenger_id,
              type: "DRIVER_EN_ROUTE",
              title: "Your driver is on the way",
              body: "Your driver is heading to your pickup location.",
              data: {
                trip_id: trip.id,
                type: "driver_en_route",
              },
            }),
          );
        }

        committedCount++;
      }
    }

    // ============================================================
    // STEP 1b: MOVEMENT MONITORING for committed drivers
    //
    // For every trip in scheduled_committed, check:
    //   a) Not moving for >notMovingAlertAfterSeconds → reminder push
    //   b) Moving away from pickup by >movingAwayThresholdMetres → alert
    //   c) predicted_arrival > scheduled_at → critical late → auto-release
    // ============================================================

    const { data: committedTrips, error: committedError } = await supabase
      .from("trips")
      .select("*")
      .eq("scheduled_status", "scheduled_committed")
      .not("driver_id", "is", null)
      .gt("scheduled_at", new Date(nowMs - 60 * 60_000).toISOString());

    if (committedError) {
      console.error("[scheduled-dispatch] Error fetching committed trips:", committedError);
    } else if (committedTrips && committedTrips.length > 0) {
      const committedDriverIds = [...new Set(committedTrips.map((t: ScheduledTrip) => t.driver_id).filter(Boolean))] as string[];

      const { data: committedPresence } = await supabase
        .from("driver_presence")
        .select("driver_id, lat, lng, last_location_at, last_significant_move_at, last_significant_move_lat, last_significant_move_lng")
        .in("driver_id", committedDriverIds);

      const committedPresenceMap = new Map(
        (committedPresence ?? []).map((p: {
          driver_id: string;
          lat: number | null;
          lng: number | null;
          last_location_at: string | null;
          last_significant_move_at: string | null;
          last_significant_move_lat: number | null;
          last_significant_move_lng: number | null;
        }) => [p.driver_id, p]),
      );

      const debounceMs = schedConfig.movingAlertDebounceMinutes * 60_000;

      for (const trip of committedTrips as ScheduledTrip[]) {
        if (isTripTerminalForDispatch(trip)) continue;
        if (!trip.driver_id || !trip.pickup_latitude || !trip.pickup_longitude) continue;

        const presence = committedPresenceMap.get(trip.driver_id);
        const pickupMs = Date.parse(trip.scheduled_at);

        // Refresh ETA
        const etaNow = estimateEtaMinutes(
          presence?.lat,
          presence?.lng,
          trip.pickup_latitude,
          trip.pickup_longitude,
        );

        if (etaNow != null) {
          await supabase
            .from("trips")
            .update({
              last_eta_minutes: etaNow,
              last_eta_calculated_at: now.toISOString(),
            })
            .eq("id", trip.id);
        }

        // ── (a) Not-moving check ─────────────────────────────
        const lastMoveAt = presence?.last_significant_move_at
          ? Date.parse(presence.last_significant_move_at)
          : null;
        const secondsSinceMove = lastMoveAt != null
          ? (nowMs - lastMoveAt) / 1000
          : null;
        const isNotMoving =
          secondsSinceMove != null &&
          secondsSinceMove >= schedConfig.notMovingAlertAfterSeconds;

        if (isNotMoving) {
          const lastAlertMs = trip.not_moving_alert_sent_at
            ? Date.parse(trip.not_moving_alert_sent_at)
            : 0;
          if (nowMs - lastAlertMs >= debounceMs) {
            queueBackground(
              sendDriverPush(supabase, {
                driverId: trip.driver_id,
                type: "SCHEDULED_NOT_MOVING",
                title: "You have a scheduled pickup",
                body: `Please start heading to ${trip.pickup_address}.`,
                data: { trip_id: trip.id, type: "scheduled_not_moving" },
              }),
            );
            await supabase
              .from("trips")
              .update({ not_moving_alert_sent_at: now.toISOString() })
              .eq("id", trip.id);
            movementAlertsCount++;
            console.log("SCHEDULED_NOT_MOVING_ALERT", { trip_id: trip.id, driver_id: trip.driver_id });
          }
        }

        // ── (b) Moving-away check ────────────────────────────
        if (presence?.lat != null && presence?.lng != null) {
          const movingAway = isMovingAway({
            driverLat: presence.lat,
            driverLng: presence.lng,
            pickupLat: trip.pickup_latitude,
            pickupLng: trip.pickup_longitude,
            previousLat: presence.last_significant_move_lat,
            previousLng: presence.last_significant_move_lng,
            thresholdMetres: schedConfig.movingAwayThresholdMetres,
          });

          if (movingAway) {
            const lastAlertMs = trip.moving_away_alert_sent_at
              ? Date.parse(trip.moving_away_alert_sent_at)
              : 0;
            if (nowMs - lastAlertMs >= debounceMs) {
              queueBackground(
                sendDriverPush(supabase, {
                  driverId: trip.driver_id,
                  type: "SCHEDULED_MOVING_AWAY",
                  title: "You're moving away from pickup",
                  body: `Turn around — your passenger is at ${trip.pickup_address}.`,
                  data: { trip_id: trip.id, type: "scheduled_moving_away" },
                }),
              );
              await supabase
                .from("trips")
                .update({ moving_away_alert_sent_at: now.toISOString() })
                .eq("id", trip.id);
              movementAlertsCount++;
              console.log("SCHEDULED_MOVING_AWAY_ALERT", { trip_id: trip.id, driver_id: trip.driver_id });
            }
          }
        }

        // ── (c) §10 ETA risk — predicted > target_arrival ────
        if (etaNow != null) {
          const predictedMs = predictedArrivalMs(nowMs, etaNow);
          const targetArrivalMs = pickupMs - schedConfig.targetArrivalMinutesBeforePickup * 60_000;
          const isEtaRisk = predictedMs > targetArrivalMs && predictedMs <= pickupMs;

          if (isEtaRisk) {
            const lastEtaAlertMs = trip.eta_risk_alert_sent_at
              ? Date.parse(trip.eta_risk_alert_sent_at)
              : 0;
            if (nowMs - lastEtaAlertMs >= debounceMs) {
              queueBackground(
                sendDriverPush(supabase, {
                  driverId: trip.driver_id,
                  type: "SCHEDULED_ETA_RISK",
                  title: "You may be running late",
                  body: `You might arrive after your target time. Please head to ${trip.pickup_address} now.`,
                  data: { trip_id: trip.id, type: "scheduled_eta_risk" },
                }),
              );
              await supabase
                .from("trips")
                .update({ eta_risk_alert_sent_at: now.toISOString() })
                .eq("id", trip.id);
              movementAlertsCount++;
              console.log("SCHEDULED_ETA_RISK_ALERT", { trip_id: trip.id, driver_id: trip.driver_id, predicted_arrival: new Date(predictedMs).toISOString() });
            }
          }

          // §14 — driver-at-risk: not moved for >2 min after commitment
          const committedAtMs = trip.scheduled_committed_at
            ? Date.parse(trip.scheduled_committed_at)
            : null;
          const minutesSinceCommit = committedAtMs != null ? (nowMs - committedAtMs) / 60_000 : null;
          const isAtRisk = isNotMoving && minutesSinceCommit != null && minutesSinceCommit >= 2 && !trip.scheduled_driver_risk;

          if (isAtRisk) {
            await supabase
              .from("trips")
              .update({ scheduled_driver_risk: true, updated_at: now.toISOString() })
              .eq("id", trip.id);
            console.log("SCHEDULED_DRIVER_AT_RISK", { trip_id: trip.id, driver_id: trip.driver_id, minutes_since_commit: Math.round(minutesSinceCommit!) });
            // Admin alert: committed driver not moving
            queueBackground(
              sendAdminAlert(supabase, {
                type: "SCHEDULED_COMMITTED_DRIVER_NOT_MOVING",
                title: "Committed driver not moving",
                body: `Driver has not moved for ${Math.round(minutesSinceCommit!)} min after commitment. Trip ${trip.trip_number ?? trip.id}, pickup at ${new Date(pickupMs).toLocaleTimeString()}.`,
                data: {
                  trip_id: trip.id,
                  driver_id: trip.driver_id!,
                  minutes_since_commit: String(Math.round(minutesSinceCommit!)),
                },
              }),
            );
            movementAlertsCount++;
          }
        }

        // ── (d) Critical late — auto-release ────────────────
        if (etaNow != null && schedConfig.criticalLateAutoRelease) {
          const predictedMs = predictedArrivalMs(nowMs, etaNow);
          const isCriticallyLate = predictedMs > pickupMs;

          if (isCriticallyLate) {
            console.log("SCHEDULED_CRITICAL_LATE_AUTO_RELEASE", {
              trip_id: trip.id,
              driver_id: trip.driver_id,
              predicted_arrival: new Date(predictedMs).toISOString(),
              scheduled_at: trip.scheduled_at,
              eta_minutes: etaNow,
            });
            await releaseAndRebroadcast(supabase, {
              trip,
              reason: "critical_late_auto_release",
              now,
              nowMs,
              supabaseUrl,
              supabaseServiceKey,
              urgent: true,
            });
            // Alert driver they've been unassigned
            queueBackground(
              sendDriverPush(supabase, {
                driverId: trip.driver_id,
                type: "SCHEDULED_RELEASED",
                title: "Scheduled pickup reassigned",
                body: "You won't make it in time. The job has been passed to another driver.",
                data: { trip_id: trip.id, type: "scheduled_released" },
              }),
            );
          }
        }
      }
    }

    // ============================================================
    // STEP 2: BROADCAST — Trips without any confirmed driver
    // (No confirmed_driver_id → go straight to auto-dispatch)
    // ============================================================

    const { data: ridesToBroadcast, error: broadcastError } = await supabase
      .from("trips")
      .select("*")
      .eq("dispatch_mode", "scheduled")
      .eq("scheduled_status", "scheduled")
      .is("confirmed_driver_id", null)
      .is("driver_id", null)
      .lte("scheduled_broadcast_at", now.toISOString());

    if (broadcastError) {
      console.error("[scheduled-dispatch] Error fetching rides to broadcast:", broadcastError);
    } else if (ridesToBroadcast && ridesToBroadcast.length > 0) {
      for (const trip of ridesToBroadcast as ScheduledTrip[]) {
        if (isTripTerminalForDispatch(trip)) continue;

        const { error: updateError } = await supabase
          .from("trips")
          .update({
            scheduled_status: "broadcasting",
            status: "offered",
            updated_at: now.toISOString(),
          })
          .eq("id", trip.id)
          .eq("scheduled_status", "scheduled");

        if (updateError) {
          console.error(`[scheduled-dispatch] Error broadcasting trip ${trip.id}:`, updateError);
          continue;
        }

        await logSnapshot(supabase, {
          tripId: trip.id,
          action: "broadcast_start",
          metadata: { trigger_reason: "scheduled_broadcast_no_locked_driver" },
        });

        // §13 — Escalation by minutes_to_pickup
        const minutesToPickup = (Date.parse(trip.scheduled_at) - nowMs) / 60_000;
        const mtp = Math.round(minutesToPickup);

        if (minutesToPickup <= 5 && !trip.no_driver_customer_alert_sent_at) {
          // ≤5 min: critical — notify customer + admin
          console.log("SCHEDULED_NO_DRIVER_CRITICAL_5MIN", { trip_id: trip.id, minutes_to_pickup: mtp });
          queueBackground(
            sendAdminAlert(supabase, {
              type: "SCHEDULED_NO_DRIVER_5MIN",
              title: "🚨 Scheduled ride — NO DRIVER in 5 minutes",
              body: `Trip ${trip.trip_number ?? trip.id}: no driver found with ${mtp} min to pickup. Immediate intervention needed.`,
              data: { trip_id: trip.id, minutes_to_pickup: String(mtp) },
            }),
          );
          if (trip.passenger_id) {
            queueBackground(
              sendCustomerPush(supabase, {
                passengerId: trip.passenger_id,
                type: "NO_DRIVER_RISK",
                title: "Finding your driver",
                body: "We're urgently searching for a driver for your scheduled ride. We'll update you shortly.",
                data: { trip_id: trip.id, type: "no_driver_risk" },
              }),
            );
          }
          await supabase
            .from("trips")
            .update({ no_driver_customer_alert_sent_at: now.toISOString() })
            .eq("id", trip.id);
        } else if (minutesToPickup <= 15 && !trip.no_driver_admin_alert_sent_at) {
          // ≤15 min: admin alert
          console.log("SCHEDULED_NO_DRIVER_ALERT_15MIN", { trip_id: trip.id, minutes_to_pickup: mtp });
          queueBackground(
            sendAdminAlert(supabase, {
              type: "SCHEDULED_NO_DRIVER_15MIN",
              title: "Scheduled ride — no driver with 15 min to pickup",
              body: `Trip ${trip.trip_number ?? trip.id}: no confirmed driver with ${mtp} min to pickup. Needs attention.`,
              data: { trip_id: trip.id, minutes_to_pickup: String(mtp) },
            }),
          );
          await supabase
            .from("trips")
            .update({ no_driver_admin_alert_sent_at: now.toISOString() })
            .eq("id", trip.id);
        } else if (minutesToPickup <= 30) {
          // ≤30 min: log urgent broadcast (auto-dispatch handles priority)
          console.log("SCHEDULED_URGENT_BROADCAST", { trip_id: trip.id, minutes_to_pickup: mtp });
        }

        await triggerAutoDispatch({
          supabaseUrl,
          supabaseServiceKey,
          tripId: trip.id,
          forceRebroadcast: true,
          triggerReason: "scheduled_broadcast_no_locked_driver",
        });
        broadcastStarted++;
      }
    }

    // ============================================================
    // STEP 2b: §13 ESCALATION SWEEP — Already-broadcasting, still no driver
    // Trips already in 'broadcasting' miss the Step 2 transition loop.
    // This dedicated pass fires admin/customer alerts at ≤15min and ≤5min.
    // ============================================================

    const { data: escalationTrips } = await supabase
      .from("trips")
      .select("id, scheduled_at, trip_number, passenger_id, no_driver_admin_alert_sent_at, no_driver_customer_alert_sent_at, confirmed_driver_id, driver_id, status, scheduled_status")
      .eq("dispatch_mode", "scheduled")
      .eq("scheduled_status", "broadcasting")
      .is("confirmed_driver_id", null)
      .is("driver_id", null)
      .gt("scheduled_at", now.toISOString())
      .lte("scheduled_at", new Date(nowMs + 15 * 60_000).toISOString()); // only trips within 15 min

    if (escalationTrips && escalationTrips.length > 0) {
      for (const trip of escalationTrips as ScheduledTrip[]) {
        if (isTripTerminalForDispatch(trip)) continue;
        const minutesToPickup = (Date.parse(trip.scheduled_at) - nowMs) / 60_000;
        const mtp = Math.round(minutesToPickup);

        if (minutesToPickup <= 5 && !trip.no_driver_customer_alert_sent_at) {
          console.log("SCHEDULED_NO_DRIVER_CRITICAL_5MIN_SWEEP", { trip_id: trip.id, minutes_to_pickup: mtp });
          queueBackground(
            sendAdminAlert(supabase, {
              type: "SCHEDULED_NO_DRIVER_5MIN",
              title: "🚨 Scheduled ride — NO DRIVER in 5 minutes",
              body: `Trip ${trip.trip_number ?? trip.id}: no driver found with ${mtp} min to pickup. Immediate intervention needed.`,
              data: { trip_id: trip.id, minutes_to_pickup: String(mtp) },
            }),
          );
          if (trip.passenger_id) {
            queueBackground(
              sendCustomerPush(supabase, {
                passengerId: trip.passenger_id,
                type: "NO_DRIVER_RISK",
                title: "Finding your driver",
                body: "We're urgently searching for a driver for your scheduled ride. We'll update you shortly.",
                data: { trip_id: trip.id, type: "no_driver_risk" },
              }),
            );
          }
          await supabase
            .from("trips")
            .update({ no_driver_customer_alert_sent_at: now.toISOString() })
            .eq("id", trip.id);
        } else if (minutesToPickup <= 15 && !trip.no_driver_admin_alert_sent_at) {
          console.log("SCHEDULED_NO_DRIVER_ALERT_15MIN_SWEEP", { trip_id: trip.id, minutes_to_pickup: mtp });
          queueBackground(
            sendAdminAlert(supabase, {
              type: "SCHEDULED_NO_DRIVER_15MIN",
              title: "Scheduled ride — no driver with 15 min to pickup",
              body: `Trip ${trip.trip_number ?? trip.id}: no confirmed driver with ${mtp} min to pickup. Needs attention.`,
              data: { trip_id: trip.id, minutes_to_pickup: String(mtp) },
            }),
          );
          await supabase
            .from("trips")
            .update({ no_driver_admin_alert_sent_at: now.toISOString() })
            .eq("id", trip.id);
        }
      }
    }

    // ============================================================
    // STEP 3: CONVERT TO INSTANT — No-preconfirmed path only
    // (Admin Two paths: confirmed drivers stay on Commitment Policy)
    // ============================================================

    const { data: ridesToConvert, error: convertError } = await supabase
      .from("trips")
      .select(
        "id, scheduled_at, scheduled_broadcast_at, scheduled_convert_at, driver_id, confirmed_driver_id, scheduled_status, status, dispatch_status, dispatch_mode",
      )
      .eq("dispatch_mode", "scheduled")
      .in("scheduled_status", ["broadcasting", "dispatching"])
      .is("driver_id", null)
      .is("confirmed_driver_id", null);

    if (convertError) {
      console.error("[scheduled-dispatch] Error fetching rides to convert:", convertError);
    } else if (ridesToConvert && ridesToConvert.length > 0) {
      const convertTripIds = ridesToConvert.map((t: { id: string }) => t.id);
      const { data: convertOffers } = await supabase
        .from("ride_offers")
        .select("trip_id, status, offered_at, created_at")
        .in("trip_id", convertTripIds)
        .order("created_at", { ascending: true });

      const offersByTrip = new Map<string, typeof convertOffers>();
      for (const offer of convertOffers || []) {
        const list = offersByTrip.get(offer.trip_id) ?? [];
        list.push(offer);
        offersByTrip.set(offer.trip_id, list);
      }

      for (const trip of ridesToConvert as ScheduledTrip[]) {
        if (isTripTerminalForDispatch(trip)) continue;

        const tripOffers = offersByTrip.get(trip.id) ?? [];
        const hasAcceptedOffer = tripOffers.some((o) => o.status === "accepted");
        const firstOffer = tripOffers[0] ?? null;
        const decision = shouldConvertScheduledToUrgent({
          trip,
          config: schedConfig,
          nowMs,
          firstOfferAnchor: firstOffer,
          hasAcceptedOffer,
        });

        if (!decision.convert) continue;

        const searchingExpiresAt = new Date(nowMs + maxFindDriverMinutes * 60_000).toISOString();

        const { error: updateError } = await supabase
          .from("trips")
          .update({
            dispatch_mode: "instant",
            scheduled_status: "converted_to_instant",
            status: "searching",
            dispatch_status: "broadcasting",
            broadcast_enabled: true,
            searching_expires_at: searchingExpiresAt,
            updated_at: now.toISOString(),
          })
          .eq("id", trip.id)
          .in("scheduled_status", ["broadcasting", "dispatching"])
          .is("driver_id", null);

        if (updateError) {
          console.error(`[scheduled-dispatch] Error converting trip ${trip.id}:`, updateError);
          continue;
        }

        // Mark any still-open offers as urgent so Driver shows the nearby card
        // (Scheduled • Urgent path) instead of diverting to Scheduled Jobs only.
        await supabase
          .from("ride_offers")
          .update({ is_urgent_dispatch: true })
          .eq("trip_id", trip.id)
          .in("status", ["pending", "offered", "countered"]);

        await logSnapshot(supabase, {
          tripId: trip.id,
          action: "convert_to_instant",
          metadata: { convert_reason: decision.reason },
        });
        await triggerAutoDispatch({
          supabaseUrl,
          supabaseServiceKey,
          tripId: trip.id,
          forceRebroadcast: true,
          triggerReason: `scheduled_convert_to_instant:${decision.reason}`,
        });
        convertedToInstant++;
      }
    }

    // ============================================================
    // STEP 3b: RE-DISPATCH FOR STACKED RIDES
    // ============================================================

    const stackedRideConfig = await loadStackedRideConfig(supabase, null);
    const stackedEnabled = stackedRideConfig.operational;

    if (stackedEnabled) {
      const { data: tripsNeedingStacked, error: stackedError } = await supabase
        .from("trips")
        .select("id, status, scheduled_status, dispatch_status, service_area_id")
        .eq("dispatch_mode", "scheduled")
        .in("status", ["offered", "searching"])
        .is("driver_id", null)
        .gt("created_at", new Date(nowMs - 30 * 60_000).toISOString());

      if (stackedError) {
        console.error("[scheduled-dispatch] Error fetching trips for stacked re-dispatch:", stackedError);
      } else if (tripsNeedingStacked && tripsNeedingStacked.length > 0) {
        for (const trip of tripsNeedingStacked) {
          if (isTripTerminalForDispatch(trip)) continue;

          const { data: existingStacked } = await supabase
            .from("ride_offers")
            .select("id")
            .eq("trip_id", trip.id)
            .eq("is_stacked", true)
            .eq("status", "pending")
            .gt("expires_at", now.toISOString())
            .limit(1);

          if (existingStacked && existingStacked.length > 0) continue;

          await triggerAutoDispatch({
            supabaseUrl,
            supabaseServiceKey,
            tripId: trip.id,
            forceRebroadcast: true,
            triggerReason: "scheduled_stacked_redispatch",
          });
          stackedRedispatched++;
          if (stackedRedispatched >= 5) break;
        }
      }
    } else {
      logStackedRideDisabledSafeGuard({ phase: "scheduled_stacked_redispatch_skipped" }, stackedRideConfig);
    }

    // ============================================================
    // STEP 4: EXPIRE — Searching too long without a driver
    // ============================================================

    const { data: expireCandidates, error: expireError } = await supabase
      .from("trips")
      .select("id, status, scheduled_status, dispatch_status, dispatch_mode, updated_at, searching_expires_at, passenger_id")
      .in("status", ["searching", "searching_new_driver", "offered", "broadcasting"])
      .is("driver_id", null)
      .eq("scheduled_status", "converted_to_instant");

    if (expireError) {
      console.error("[scheduled-dispatch] Error fetching rides to expire:", expireError);
    } else if (expireCandidates && expireCandidates.length > 0) {
      for (const trip of expireCandidates as ScheduledTrip[]) {
        if (isTripTerminalForDispatch(trip)) continue;

        if (!trip.searching_expires_at) continue;
        const searchDeadlineMs = new Date(trip.searching_expires_at).getTime();
        if (!Number.isFinite(searchDeadlineMs) || searchDeadlineMs > nowMs) continue;

        const { data: didExpire, error: rpcError } = await supabase.rpc(
          "expire_trip_when_search_exhausted",
          { p_trip_id: trip.id },
        );

        if (rpcError) {
          console.warn("[scheduled-dispatch] expire_trip_when_search_exhausted failed:", trip.id, rpcError);
          continue;
        }

        if (didExpire === true) {
          await revokePendingOffersForTerminalTrip(supabase, trip.id, "trip_expired_no_driver");
          await supabase
            .from("trips")
            .update({
              scheduled_status: "no_driver_found",
              broadcast_enabled: false,
              updated_at: now.toISOString(),
            })
            .eq("id", trip.id)
            .in("scheduled_status", ["broadcasting", "dispatching", "converted_to_instant", "scheduled"]);

          await logSnapshot(supabase, {
            tripId: trip.id,
            action: "expire_no_driver",
            metadata: { missed_reason: "search_window_exhausted" },
          });

          // Notify customer
          if (trip.passenger_id) {
            queueBackground(
              sendCustomerPush(supabase, {
                passengerId: trip.passenger_id,
                type: "NO_DRIVER_AVAILABLE",
                title: "No driver available",
                body: "We couldn't find a driver for your scheduled trip. Please try booking again.",
                data: { trip_id: trip.id, type: "no_driver_available" },
              }),
            );
          }

          expired++;
        }
      }
    }

    const summary = {
      timestamp: now.toISOString(),
      committedCount,
      movementAlertsCount,
      broadcastStarted,
      convertedToInstant,
      stackedRedispatched,
      expired,
    };

    console.log("[scheduled-dispatch] Summary:", summary);
    return successResponse({ success: true, ...summary });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Internal server error";
    console.error("[scheduled-dispatch] Error:", error);
    return errorResponse("INTERNAL_ERROR", errorMessage, 500);
  }
});
