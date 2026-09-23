import type { AnySupabaseClient } from "../_shared/supabaseClientTypes.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
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
  buildScheduledUrgentConversionPatch,
  NO_PRECONFIRMED_CONVERT_SCHEDULED_STATUSES,
} from "../_shared/scheduledDispatchConfig.ts";
import {
  isScheduledActivationDue,
  scheduledActivationLookaheadMs,
} from "../_shared/scheduledActivationSSOT.ts";
import {
  buildAssignNowPatch,
  buildBroadcastNowPatch,
  buildMakeAvailableScheduledJobsPatch,
  isPendingReleaseDue,
} from "../_shared/scheduledAdminReleaseSSOT.ts";
import {
  resolveBackfillSearchingExpiresAtIso,
  shouldExpireConvertedScheduledNoDriver,
} from "../_shared/scheduledNoDriverExpirySSOT.ts";
import {
  blockedTerminalTripLogPayload,
  isTripTerminalForDispatch,
  revokePendingOffersForTerminalTrip,
} from "../_shared/tripTerminalDispatch.ts";
import {
  loadStackedRideConfig,
  logStackedRideDisabledSafeGuard,
} from "../_shared/stackedRideConfig.ts";
import {
  expireTripWhenSearchExhaustedAndNotifyCustomer,
  notifyCustomerTripLifecycle,
} from "../_shared/customerTripLifecycleNotify.ts";
import { notifyCustomerNegotiationRematch } from "../_shared/negotiationFailureRematch.ts";

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
  is_scheduled?: boolean | null;
  base_fare_pence?: number | null;
  currency_code?: string | null;
  fare?: number | null;
  estimated_duration_minutes?: number | null;
  // Legacy columns (no longer drive activation)
  commitment_time?: string | null;
  scheduled_committed_at?: string | null;
  last_eta_minutes?: number | null;
  last_eta_calculated_at?: string | null;
  not_moving_alert_sent_at?: string | null;
  moving_away_alert_sent_at?: string | null;
  eta_risk_alert_sent_at?: string | null;
  scheduled_driver_risk?: boolean;
  pending_release_kind?: string | null;
  pending_release_at?: string | null;
  // §13 admin escalation tracking
  no_driver_admin_alert_sent_at?: string | null;
  no_driver_customer_alert_sent_at?: string | null;
}

/** Send a push notification to a driver via send-driver-notification. */
async function sendDriverPush(
  supabase: AnySupabaseClient,
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
  supabase: AnySupabaseClient,
  args: { passengerId: string; type: string; title: string; body: string; data?: Record<string, string> },
) {
  try {
    await supabase.functions.invoke("send-customer-notification", {
      body: {
        customer_id: args.passengerId,
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
  supabase: AnySupabaseClient,
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
  supabase: AnySupabaseClient,
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
  supabase: AnySupabaseClient,
  args: {
    trip: ScheduledTrip;
    reason: string;
    now: Date;
    nowMs: number;
    supabaseUrl: string;
    supabaseServiceKey: string;
    urgent?: boolean;
    maxFindDriverMinutes?: number;
  },
) {
  const { trip, reason, now } = args;
  const broadcastAt = trip.scheduled_broadcast_at && String(trip.scheduled_broadcast_at).trim()
    ? trip.scheduled_broadcast_at
    : now.toISOString();

  // Urgent (activation NRO expire / critical late): flip to instant nearby-card
  // path then auto-dispatch. Non-urgent: reopen scheduled marketplace only
  // (Requested tab) — auto-dispatch stays off while dispatch_mode=scheduled.
  const urgent = args.urgent === true;
  const maxFind = Math.max(1, Number(args.maxFindDriverMinutes ?? 6));
  const updatePatch = urgent
    ? {
      ...buildScheduledUrgentConversionPatch({
        nowIso: now.toISOString(),
        searchingExpiresAtIso: new Date(now.getTime() + maxFind * 60_000).toISOString(),
      }),
      driver_id: null,
      confirmed_driver_id: null,
      scheduled_broadcast_at: broadcastAt,
      commitment_time: null,
      scheduled_committed_at: null,
    }
    : {
      driver_id: null,
      confirmed_driver_id: null,
      scheduled_status: "broadcasting",
      scheduled_broadcast_at: broadcastAt,
      status: "offered",
      commitment_time: null,
      scheduled_committed_at: null,
      updated_at: now.toISOString(),
    };

  const { error } = await supabase
    .from("trips")
    .update(updatePatch)
    .eq("id", trip.id)
    .in("scheduled_status", [
      "scheduled_committed",
      "driver_assigned",
      "awaiting_activation_accept",
    ]);

  if (error) {
    console.error("[scheduled-dispatch] releaseAndRebroadcast update failed:", trip.id, error);
    return;
  }

  console.log("SCHEDULED_DRIVER_RELEASED", {
    trip_id: trip.id,
    driver_id: trip.driver_id ?? trip.confirmed_driver_id,
    reason,
    urgent,
  });

  if (urgent) {
    voidBackground(
      triggerAutoDispatch({
        supabaseUrl: args.supabaseUrl,
        supabaseServiceKey: args.supabaseServiceKey,
        tripId: trip.id,
        forceRebroadcast: true,
        triggerReason: reason,
      }),
    );
  }

  // Rematch — lifecycle WAV (finding-another), never mute send-customer-notification / trip_cancelled.
  voidBackground(notifyCustomerNegotiationRematch(supabase, trip.id));
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
         long_trip_threshold_minutes, local_activation_minutes_before_pickup,
         long_activation_minutes_before_pickup`,
      )
      .eq("singleton", true)
      .maybeSingle();

    const schedConfig = resolveScheduledDispatchConfig(globalSettings);
    const maxFindDriverMinutes = schedConfig.maxFindDriverMinutes;
    const activationConfig = schedConfig.activation;

    let committedCount = 0;
    let broadcastStarted = 0;
    let convertedToInstant = 0;
    let expired = 0;
    let stackedRedispatched = 0;
    let pendingReleasesExecuted = 0;

    // ============================================================
    // STEP 0: ADMIN PENDING RELEASE (Assign At / Broadcast At)
    // Backend cron — not browser timers. One pending action per trip.
    // ============================================================
    {
      const { data: dueReleases, error: dueErr } = await supabase
        .from("trips")
        .select(
          "id, pending_release_kind, pending_release_at, pending_release_driver_id, confirmed_driver_id, driver_id, scheduled_status, status, dispatch_mode, passenger_id",
        )
        .not("pending_release_kind", "is", null)
        .not("pending_release_at", "is", null)
        .lte("pending_release_at", now.toISOString())
        .limit(50);

      if (dueErr) {
        console.error("[scheduled-dispatch] pending release query failed:", dueErr);
      } else {
        for (const trip of dueReleases ?? []) {
          if (isTripTerminalForDispatch(trip)) continue;
          if (
            !isPendingReleaseDue({
              pending_release_kind: trip.pending_release_kind,
              pending_release_at: trip.pending_release_at,
              nowMs,
            })
          ) {
            continue;
          }
          const kind = String(trip.pending_release_kind ?? "").toLowerCase();
          const statusLower = String(trip.status ?? "").toLowerCase();
          const schedStatusLower = String(trip.scheduled_status ?? "").toLowerCase();
          // T−urgent convert already cleared pending on convert — but if a row
          // still has pending after searching/converted, never re-Assign/Broadcast.
          if (
            schedStatusLower === "converted_to_instant" ||
            statusLower === "searching" ||
            statusLower === "searching_new_driver" ||
            statusLower === "offered" ||
            statusLower === "broadcasting" ||
            statusLower === "en_route_to_pickup" ||
            statusLower === "in_progress"
          ) {
            await supabase
              .from("trips")
              .update({
                pending_release_kind: null,
                pending_release_at: null,
                pending_release_driver_id: null,
              })
              .eq("id", trip.id);
            continue;
          }
          if (kind === "assign") {
            const driverId = String(trip.pending_release_driver_id ?? "").trim();
            if (!driverId) {
              console.warn(`[scheduled-dispatch] pending assign missing driver for ${trip.id}`);
              continue;
            }
            // Skip if already pre-confirmed or live-assigned.
            if (trip.confirmed_driver_id || trip.driver_id) {
              await supabase
                .from("trips")
                .update({
                  pending_release_kind: null,
                  pending_release_at: null,
                  pending_release_driver_id: null,
                })
                .eq("id", trip.id);
              continue;
            }
            const { data: assignRows, error } = await supabase
              .from("trips")
              .update(buildAssignNowPatch({ driverId, nowIso: now.toISOString() }))
              .eq("id", trip.id)
              .eq("pending_release_kind", "assign")
              .in("scheduled_status", ["admin_held", "scheduled", "broadcasting", "pending"])
              .is("driver_id", null)
              .is("confirmed_driver_id", null)
              .select("id");
            if (error) {
              console.error("[scheduled-dispatch] pending assign failed:", trip.id, error);
              continue;
            }
            if (!assignRows?.length) {
              // CAS matched 0 — clear stale pending so cron does not spin.
              await supabase
                .from("trips")
                .update({
                  pending_release_kind: null,
                  pending_release_at: null,
                  pending_release_driver_id: null,
                })
                .eq("id", trip.id)
                .eq("pending_release_kind", "assign");
              continue;
            }
            pendingReleasesExecuted++;
            await logSnapshot(supabase, {
              tripId: trip.id,
              action: "admin_pending_assign_executed",
              metadata: { driver_id: driverId },
            });
            // Same deep-link as Admin Assign Now — preconfirm stays list-only.
            const passengerId =
              typeof trip.passenger_id === "string" ? trip.passenger_id.trim() : "";
            if (passengerId) {
              voidBackground(
                notifyCustomerTripLifecycle(supabase, {
                  passengerId,
                  tripId: trip.id,
                  event: "driver_assigned",
                  title: "Driver confirmed",
                  body: "Your driver is confirmed for your scheduled ride.",
                  notificationId: `driver_assigned-${trip.id}-scheduled_assign_at`,
                  path: "/account/rides",
                }),
              );
            }
          } else if (kind === "broadcast") {
            if (trip.confirmed_driver_id || trip.driver_id) {
              await supabase
                .from("trips")
                .update({
                  pending_release_kind: null,
                  pending_release_at: null,
                  pending_release_driver_id: null,
                })
                .eq("id", trip.id);
              continue;
            }
            const { data: broadcastRows, error } = await supabase
              .from("trips")
              .update(buildBroadcastNowPatch({ nowIso: now.toISOString() }))
              .eq("id", trip.id)
              .eq("pending_release_kind", "broadcast")
              .in("scheduled_status", ["admin_held", "scheduled", "pending"])
              .is("driver_id", null)
              .is("confirmed_driver_id", null)
              .select("id");
            if (error) {
              console.error("[scheduled-dispatch] pending broadcast failed:", trip.id, error);
              continue;
            }
            if (!broadcastRows?.length) {
              await supabase
                .from("trips")
                .update({
                  pending_release_kind: null,
                  pending_release_at: null,
                  pending_release_driver_id: null,
                })
                .eq("id", trip.id)
                .eq("pending_release_kind", "broadcast");
              continue;
            }
            pendingReleasesExecuted++;
            await logSnapshot(supabase, {
              tripId: trip.id,
              action: "admin_pending_broadcast_executed",
              metadata: {},
            });
            // Broadcast At = NRO path (broadcasting). Kick auto-dispatch now —
            // STEP 2 only activates on Local/Long T for published Scheduled Jobs.
            await triggerAutoDispatch({
              supabaseUrl,
              supabaseServiceKey,
              tripId: trip.id,
              forceRebroadcast: true,
              triggerReason: "admin_pending_broadcast_at",
            });
          } else if (kind === "jobs") {
            // Make Available At — Scheduled Jobs publication only (not NRO).
            if (trip.confirmed_driver_id || trip.driver_id) {
              await supabase
                .from("trips")
                .update({
                  pending_release_kind: null,
                  pending_release_at: null,
                  pending_release_driver_id: null,
                })
                .eq("id", trip.id);
              continue;
            }
            const { data: jobsRows, error } = await supabase
              .from("trips")
              .update(buildMakeAvailableScheduledJobsPatch({ nowIso: now.toISOString() }))
              .eq("id", trip.id)
              .eq("pending_release_kind", "jobs")
              .in("scheduled_status", ["admin_held", "scheduled", "pending"])
              .is("driver_id", null)
              .is("confirmed_driver_id", null)
              .select("id");
            if (error) {
              console.error("[scheduled-dispatch] pending jobs publish failed:", trip.id, error);
              continue;
            }
            if (!jobsRows?.length) {
              await supabase
                .from("trips")
                .update({
                  pending_release_kind: null,
                  pending_release_at: null,
                  pending_release_driver_id: null,
                })
                .eq("id", trip.id)
                .eq("pending_release_kind", "jobs");
              continue;
            }
            pendingReleasesExecuted++;
            await logSnapshot(supabase, {
              tripId: trip.id,
              action: "admin_pending_jobs_executed",
              metadata: {},
            });
          }
        }
      }
    }

    // ============================================================
    // STEP 1: PRE-CONFIRMED ACTIVATION — fixed Local/Long T-minutes
    // At activation: SCHEDULED RIDE NRO to confirmed_driver_id.
    // Driver MUST Accept to enter Drive to Pickup (not Start Trip).
    // ============================================================

    const lookAheadMs = scheduledActivationLookaheadMs(activationConfig);
    const lookAheadThreshold = new Date(nowMs + lookAheadMs).toISOString();

    const { data: tripsForActivation, error: activationError } = await supabase
      .from("trips")
      .select("*")
      .eq("dispatch_mode", "scheduled")
      .in("scheduled_status", ["scheduled", "driver_assigned", "scheduled_committed"])
      .not("confirmed_driver_id", "is", null)
      .is("driver_id", null)
      .lte("scheduled_at", lookAheadThreshold)
      .gt("scheduled_at", new Date(nowMs - 30 * 60_000).toISOString());

    if (activationError) {
      console.error("[scheduled-dispatch] Error fetching trips for activation:", activationError);
    } else if (tripsForActivation && tripsForActivation.length > 0) {
      for (const trip of tripsForActivation as ScheduledTrip[]) {
        if (isTripTerminalForDispatch(trip)) continue;
        if (!trip.pickup_latitude || !trip.pickup_longitude) {
          console.warn(`[scheduled-dispatch] Trip ${trip.id} missing pickup coords — skipping`);
          continue;
        }

        const confirmedDriverId = trip.confirmed_driver_id!;
        const due = isScheduledActivationDue({
          scheduledAt: trip.scheduled_at,
          estimatedDurationMinutes: trip.estimated_duration_minutes,
          config: activationConfig,
          nowMs,
        });

        if (due.usedFallbackDuration) {
          console.warn(
            `[scheduled-dispatch] Trip ${trip.id}: missing estimated_duration_minutes — classifying LONG via threshold fallback`,
          );
        }

        if (!due.due) {
          console.log(
            `[scheduled-dispatch] Trip ${trip.id}: ${due.kind} activation not due until ${new Date(due.activationAtMs).toISOString()}`,
          );
          continue;
        }

        // Already awaiting activation NRO — do not spam offers every minute.
        if (String(trip.scheduled_status) === "awaiting_activation_accept") {
          continue;
        }
        // Defense: never arm activation while still Admin HELD.
        if (String(trip.scheduled_status) === "admin_held") {
          continue;
        }

        console.log("SCHEDULED_ACTIVATION_NRO_TRIGGERED", {
          trip_id: trip.id,
          confirmed_driver_id: confirmedDriverId,
          scheduled_at: trip.scheduled_at,
          activation_at: new Date(due.activationAtMs).toISOString(),
          kind: due.kind,
          estimated_duration_minutes: trip.estimated_duration_minutes,
        });

        const responseMinutes = Math.max(
          1,
          Number(schedConfig.lockedDriverResponseMinutes ?? 3),
        );
        const expiresAt = new Date(nowMs + responseMinutes * 60_000).toISOString();

        const netPence = (() => {
          const fromNet = Number(trip.driver_net_pence ?? trip.driver_net_before_tip_pence ?? 0);
          if (Number.isFinite(fromNet) && fromNet > 0) return Math.round(fromNet);
          const fromFarePence = Number(trip.final_fare_pence ?? trip.estimated_total_pence ?? 0);
          if (Number.isFinite(fromFarePence) && fromFarePence > 0) {
            return Math.round(fromFarePence);
          }
          const fromMajor = Number(trip.estimated_fare ?? trip.fare ?? 0);
          if (Number.isFinite(fromMajor) && fromMajor > 0) {
            return Math.round(fromMajor * 100);
          }
          return 0;
        })();
        if (netPence <= 0) {
          console.error(`[scheduled-dispatch] Activation offer skipped — no driver net for ${trip.id}`);
          continue;
        }

        const offerSnapshot = {
          scheduled_status: "awaiting_activation_accept",
          scheduled_at: trip.scheduled_at,
          dispatch_mode: "scheduled",
          is_scheduled: true,
          confirmed_driver_id: confirmedDriverId,
          pickup_address: trip.pickup_address,
          pickup_latitude: trip.pickup_latitude,
          pickup_longitude: trip.pickup_longitude,
          dropoff_address: trip.dropoff_address,
          dropoff_latitude: trip.dropoff_latitude,
          dropoff_longitude: trip.dropoff_longitude,
          estimated_duration_minutes: trip.estimated_duration_minutes,
          special_instructions: trip.special_instructions,
          driver_net_fare_pence: netPence,
          offered_driver_net_pence: netPence,
          negotiation_disabled: true,
          presets_enabled: false,
          scheduled_kind: due.kind,
        };

        const { data: offerRows, error: offerErr } = await supabase
          .from("ride_offers")
          .insert({
            trip_id: trip.id,
            driver_id: confirmedDriverId,
            status: "pending",
            offered_at: now.toISOString(),
            expires_at: expiresAt,
            offered_driver_net_pence: netPence,
            is_urgent_dispatch: false,
            offer_snapshot: offerSnapshot,
          })
          .select("id");

        if (offerErr || !offerRows?.length) {
          console.error(
            `[scheduled-dispatch] Activation offer insert failed:`,
            trip.id,
            offerErr,
          );
          continue;
        }

        const { data: armedRows, error: commitError } = await supabase
          .from("trips")
          .update({
            scheduled_status: "awaiting_activation_accept",
            updated_at: now.toISOString(),
          })
          .eq("id", trip.id)
          .in("scheduled_status", ["scheduled", "driver_assigned", "scheduled_committed"])
          .is("driver_id", null)
          .select("id");

        if (commitError || !armedRows?.length) {
          console.error(
            `[scheduled-dispatch] Activation NRO arm failed for trip ${trip.id}:`,
            commitError,
          );
          await supabase
            .from("ride_offers")
            .update({ status: "cancelled", updated_at: now.toISOString() })
            .eq("id", offerRows[0].id);
          continue;
        }

        await logSnapshot(supabase, {
          tripId: trip.id,
          action: "scheduled_activation_nro",
          stage: "considered",
          driverId: confirmedDriverId,
          metadata: {
            kind: due.kind,
            activation_at: new Date(due.activationAtMs).toISOString(),
            scheduled_at: trip.scheduled_at,
            offer_id: offerRows[0].id,
            estimated_duration_minutes: trip.estimated_duration_minutes,
          },
        });

        queueBackground(
          sendDriverPush(supabase, {
            driverId: confirmedDriverId,
            type: "SCHEDULED_COMMITMENT",
            title: "SCHEDULED RIDE",
            body: `Accept now to drive to pickup · ${trip.pickup_address ?? "pickup"}`,
            data: {
              trip_id: trip.id,
              type: "scheduled_commitment",
              offer_kind: "scheduled",
              pickup_address: trip.pickup_address ?? "",
              scheduled_at: trip.scheduled_at,
            },
          }),
        );

        committedCount++;
      }
    }

    // ============================================================
    // STEP 1a: ACTIVATION NRO EXPIRED / DECLINED → existing rescue
    // Reuse releaseAndRebroadcast (no parallel rescue engine).
    // ============================================================
    {
      const { data: awaitingRows, error: awaitingErr } = await supabase
        .from("trips")
        .select(
          "id, confirmed_driver_id, driver_id, scheduled_status, status, passenger_id, pickup_address, scheduled_at, trip_number, scheduled_broadcast_at",
        )
        .eq("scheduled_status", "awaiting_activation_accept")
        .is("driver_id", null)
        .limit(50);

      if (awaitingErr) {
        console.error("[scheduled-dispatch] awaiting activation query failed:", awaitingErr);
      } else {
        for (const trip of awaitingRows ?? []) {
          if (isTripTerminalForDispatch(trip)) continue;
          const { data: openOffers } = await supabase
            .from("ride_offers")
            .select("id, status, expires_at")
            .eq("trip_id", trip.id)
            .eq("driver_id", trip.confirmed_driver_id)
            .in("status", ["pending", "offered"])
            .gt("expires_at", now.toISOString())
            .limit(1);

          if (openOffers && openOffers.length > 0) continue;

          // No live activation offer — expire any stale pending, then rescue.
          await supabase
            .from("ride_offers")
            .update({ status: "expired", updated_at: now.toISOString() })
            .eq("trip_id", trip.id)
            .in("status", ["pending", "offered"]);

          console.log("SCHEDULED_ACTIVATION_NRO_RESCUE", {
            trip_id: trip.id,
            confirmed_driver_id: trip.confirmed_driver_id,
          });
          await releaseAndRebroadcast(supabase, {
            trip: trip as ScheduledTrip,
            reason: "scheduled_activation_nro_expired_or_declined",
            now,
            nowMs,
            supabaseUrl,
            supabaseServiceKey,
            urgent: true,
            maxFindDriverMinutes,
          });
        }
      }
    }

    // STEP 1b (commitment not-moving / ETA-risk / critical-late) REMOVED.

    // ============================================================
    // STEP 2: NO-PRECONFIRMED ACTIVATION at Local/Long T-minutes
    // Published Scheduled Jobs (Make Available) stay list-only until T.
    // Admin Broadcast Now/At sets broadcasting + auto-dispatch directly
    // (STEP 0 / Admin UI) — do NOT treat scheduled_broadcast_at alone as NRO.
    // Skip when a future pending_release_* Admin override is still pending.
    // ============================================================

    const lookAheadBroadcast = new Date(nowMs + lookAheadMs).toISOString();
    const { data: ridesToBroadcast, error: broadcastError } = await supabase
      .from("trips")
      .select("*")
      .eq("dispatch_mode", "scheduled")
      .in("scheduled_status", ["admin_held", "scheduled", "pending"])
      .is("confirmed_driver_id", null)
      .is("driver_id", null)
      .lte("scheduled_at", lookAheadBroadcast)
      .gt("scheduled_at", new Date(nowMs - 30 * 60_000).toISOString());

    if (broadcastError) {
      console.error("[scheduled-dispatch] Error fetching rides to broadcast:", broadcastError);
    } else if (ridesToBroadcast && ridesToBroadcast.length > 0) {
      for (const trip of ridesToBroadcast as ScheduledTrip[]) {
        if (isTripTerminalForDispatch(trip)) continue;

        // Admin Assign At / Broadcast At still pending — STEP 0 owns that trip.
        if (
          trip.pending_release_kind &&
          String(trip.pending_release_kind).trim() &&
          trip.pending_release_at
        ) {
          const pendingAt = Date.parse(trip.pending_release_at);
          if (Number.isFinite(pendingAt) && pendingAt > nowMs) {
            continue;
          }
        }

        const due = isScheduledActivationDue({
          scheduledAt: trip.scheduled_at,
          estimatedDurationMinutes: trip.estimated_duration_minutes,
          config: activationConfig,
          nowMs,
        });

        // Canonical activation only — Make Available publication must not NRO early.
        if (!due.due) {
          continue;
        }

        const fromStatus = String(trip.scheduled_status ?? "");
        const { data: updatedRows, error: updateError } = await supabase
          .from("trips")
          .update({
            scheduled_status: "broadcasting",
            status: "offered",
            scheduled_broadcast_at: trip.scheduled_broadcast_at ?? now.toISOString(),
            updated_at: now.toISOString(),
          })
          .eq("id", trip.id)
          .in("scheduled_status", ["admin_held", "scheduled", "pending"])
          .is("confirmed_driver_id", null)
          .is("driver_id", null)
          .select("id");

        if (updateError || !updatedRows?.length) {
          console.error(`[scheduled-dispatch] Error broadcasting trip ${trip.id}:`, updateError);
          continue;
        }

        await logSnapshot(supabase, {
          tripId: trip.id,
          action: "broadcast_start",
          metadata: {
            trigger_reason: "scheduled_activation_no_locked_driver",
            kind: due.kind,
            activation_at: Number.isFinite(due.activationAtMs)
              ? new Date(due.activationAtMs).toISOString()
              : null,
            from_scheduled_status: fromStatus,
          },
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
    // STEP 3: CONVERT TO INSTANT — No-preconfirmed fallback (T−urgent)
    // Does not affect trips with a valid confirmed/active driver.
    // ============================================================

    const { data: ridesToConvert, error: convertError } = await supabase
      .from("trips")
      .select(
        "id, scheduled_at, scheduled_broadcast_at, scheduled_convert_at, driver_id, confirmed_driver_id, scheduled_status, status, dispatch_status, dispatch_mode",
      )
      .eq("dispatch_mode", "scheduled")
      .in("scheduled_status", [...NO_PRECONFIRMED_CONVERT_SCHEDULED_STATUSES])
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
        const conversionPatch = buildScheduledUrgentConversionPatch({
          nowIso: now.toISOString(),
          searchingExpiresAtIso: searchingExpiresAt,
        });

        const { data: convertedRows, error: updateError } = await supabase
          .from("trips")
          .update(conversionPatch)
          .eq("id", trip.id)
          .in("scheduled_status", [...NO_PRECONFIRMED_CONVERT_SCHEDULED_STATUSES])
          .is("driver_id", null)
          .is("confirmed_driver_id", null)
          .select("id");

        if (updateError) {
          console.error(`[scheduled-dispatch] Error converting trip ${trip.id}:`, updateError);
          continue;
        }
        // Assign Now race: 0 matched rows — do NOT triggerAutoDispatch.
        if (!convertedRows || convertedRows.length === 0) {
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
    // Reuses expireTripWhenSearchExhaustedAndNotifyCustomer.
    // Gap fixes:
    //  - null searching_expires_at must not leave past-pickup rides open
    //  - expire RPC invents now+findMinutes when stamp is null → stamp past first
    //  - past-pickup HELD/Jobs/preconfirm/broadcast (never converted) must also
    //    leave the live Scheduled board via the same expire path
    // ============================================================

    const expireSelect =
      "id, status, scheduled_status, dispatch_status, dispatch_mode, updated_at, searching_expires_at, scheduled_at, passenger_id, confirmed_driver_id, is_scheduled";

    const { data: expireConverted, error: expireConvertedError } = await supabase
      .from("trips")
      .select(expireSelect)
      .in("status", ["searching", "searching_new_driver", "offered", "broadcasting"])
      .is("driver_id", null)
      .eq("scheduled_status", "converted_to_instant");

    const { data: expirePastPickup, error: expirePastError } = await supabase
      .from("trips")
      .select(expireSelect)
      .eq("is_scheduled", true)
      .is("driver_id", null)
      .lte("scheduled_at", now.toISOString())
      .not(
        "status",
        "in",
        "(completed,cancelled,customer_cancelled,expired,expired_no_driver,no_show,declined)",
      )
      .or(
        "scheduled_status.is.null,scheduled_status.not.in.(cancelled,expired,no_driver_found)",
      )
      .limit(50);

    if (expireConvertedError) {
      console.error("[scheduled-dispatch] Error fetching converted rides to expire:", expireConvertedError);
    }
    if (expirePastError) {
      console.error("[scheduled-dispatch] Error fetching past-pickup rides to expire:", expirePastError);
    }

    const expireById = new Map<string, ScheduledTrip>();
    for (const row of [...(expireConverted ?? []), ...(expirePastPickup ?? [])] as ScheduledTrip[]) {
      if (row?.id) expireById.set(row.id, row);
    }
    const expireCandidates = [...expireById.values()];

    if (expireCandidates.length > 0) {
      for (const trip of expireCandidates) {
        if (isTripTerminalForDispatch(trip)) continue;

        const schedLower = String(trip.scheduled_status ?? "").toLowerCase();
        const isConverted = schedLower === "converted_to_instant";
        const decision = shouldExpireConvertedScheduledNoDriver({
          searchingExpiresAt: trip.searching_expires_at ?? null,
          scheduledAt: trip.scheduled_at ?? null,
          nowMs,
        });

        if (!decision.expire) {
          // Still before pickup with no stamp — backfill canonical search window
          // so the existing expire path can fire later (no parallel engine).
          if (
            isConverted &&
            decision.reason === "awaiting_search_deadline" &&
            !trip.searching_expires_at
          ) {
            const backfillIso = resolveBackfillSearchingExpiresAtIso({
              nowMs,
              scheduledAt: trip.scheduled_at ?? null,
              maxFindDriverMinutes,
            });
            await supabase
              .from("trips")
              .update({
                searching_expires_at: backfillIso,
                updated_at: now.toISOString(),
              })
              .eq("id", trip.id)
              .eq("scheduled_status", "converted_to_instant")
              .is("driver_id", null)
              .is("searching_expires_at", null);
          }
          continue;
        }

        const pastDeadlineIso = new Date(nowMs - 1000).toISOString();

        // Non-converted past-pickup (HELD / Jobs / preconfirm / broadcast): flip onto
        // the converted search path with an already-past deadline, then reuse expire RPC.
        // Expire RPC returns false while scheduled handover is still pending.
        if (!isConverted) {
          await supabase
            .from("trips")
            .update({
              ...buildScheduledUrgentConversionPatch({
                nowIso: now.toISOString(),
                searchingExpiresAtIso: pastDeadlineIso,
              }),
              confirmed_driver_id: null,
            })
            .eq("id", trip.id)
            .is("driver_id", null);
        } else if (!trip.searching_expires_at) {
          // expire_trip_when_search_exhausted invents now+findMinutes when
          // searching_expires_at is null (scheduled-origin). Stamp past first.
          await supabase
            .from("trips")
            .update({
              searching_expires_at: pastDeadlineIso,
              updated_at: now.toISOString(),
            })
            .eq("id", trip.id)
            .eq("scheduled_status", "converted_to_instant")
            .is("driver_id", null);
        }

        const { expired: didExpire, rpcError } =
          await expireTripWhenSearchExhaustedAndNotifyCustomer(supabase, {
            tripId: trip.id,
            passengerId: trip.passenger_id ?? null,
          });

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
              confirmed_driver_id: null,
              pending_release_kind: null,
              pending_release_at: null,
              pending_release_driver_id: null,
              broadcast_enabled: false,
              updated_at: now.toISOString(),
            })
            .eq("id", trip.id)
            .in("status", ["expired", "expired_no_driver"]);

          await logSnapshot(supabase, {
            tripId: trip.id,
            action: "expire_no_driver",
            metadata: {
              missed_reason: decision.reason,
              was_converted: isConverted,
            },
          });

          // Customer trip_cancelled WAV already sent by expireTripWhenSearchExhaustedAndNotifyCustomer.

          expired++;
        }
      }
    }

    const summary = {
      timestamp: now.toISOString(),
      committedCount,
      broadcastStarted,
      convertedToInstant,
      stackedRedispatched,
      expired,
      pendingReleasesExecuted,
    };

    console.log("[scheduled-dispatch] Summary:", summary);
    return successResponse({ success: true, ...summary });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Internal server error";
    console.error("[scheduled-dispatch] Error:", error);
    return errorResponse("INTERNAL_ERROR", errorMessage, 500);
  }
});
