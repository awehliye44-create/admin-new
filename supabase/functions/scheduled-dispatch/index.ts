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
  resolveConversionBroadcastEnabled,
  NO_PRECONFIRMED_CONVERT_SCHEDULED_STATUSES,
} from "../_shared/scheduledDispatchConfig.ts";
import { maxBroadcastSequences } from "../_shared/dispatch-settings.ts";
import {
  isScheduledActivationDue,
  scheduledActivationLookaheadMs,
} from "../_shared/scheduledActivationSSOT.ts";
import {
  runConfirmedJitActivationPass,
  resolveJitConfigFromSettingsRow,
} from "../_shared/runConfirmedJitActivationPass.ts";
import { SCHEDULED_JIT_ACTIVATION_DEFAULTS } from "../_shared/scheduledJitActivationSSOT.ts";
import {
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
  TERMINAL_TRIP_STATUS_POSTGREST_LIST,
} from "../_shared/tripTerminalDispatch.ts";
import { assertPaymentGate, PaymentGateError } from "../_shared/paymentGate.ts";
import { resolvePaymentGateBlockedTrip } from "../_shared/paymentGateBlockedResolutionSSOT.ts";
import {
  loadStackedRideConfig,
  logStackedRideDisabledSafeGuard,
} from "../_shared/stackedRideConfig.ts";
import {
  expireTripWhenSearchExhaustedAndNotifyCustomer,
  notifyCustomerTripLifecycle,
} from "../_shared/customerTripLifecycleNotify.ts";
import { notifyScheduledMarketplaceOpen } from "../_shared/scheduledMarketplaceNotifySSOT.ts";
import { broadcastScheduledMarketplaceChanged } from "../_shared/scheduledMarketplaceRealtimeBroadcastSSOT.ts";
import {
  attemptScheduledMarketplaceAutoPublish,
  evaluateScheduledMarketplaceAutoPublishEligibility,
  SCHEDULED_MARKETPLACE_AUTO_PUBLISH_VIA,
} from "../_shared/scheduledMarketplaceAutoPublishSSOT.ts";
import {
  assertAirportPricingReady,
  AUTO_PUBLISH_ELIGIBLE_HOLD_REASONS,
} from "../_shared/scheduledMarketplaceHoldSSOT.ts";
import {
  SCHEDULED_ACTIVATION_EXCLUSIVE_REASON,
} from "../_shared/scheduledActivationExclusiveSSOT.ts";
import {
  rescueExclusiveActivationToNearby,
} from "../_shared/scheduledActivationExclusiveRescue.ts";

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
  driver_net_pence?: number | null;
  driver_net_before_tip_pence?: number | null;
  special_instructions?: string | null;
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
  currency?: string | null;
  fare?: number | null;
  airport_charge_pence?: number | null;
  service_area_id?: string | null;
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
  declinedDriverId?: string | null;
}) {
  const {
    supabaseUrl,
    supabaseServiceKey,
    tripId,
    forceRebroadcast = true,
    triggerReason,
    declinedDriverId,
  } = args;
  try {
    const body: Record<string, unknown> = {
      trip_id: tripId,
      force_rebroadcast: forceRebroadcast,
      trigger_reason: triggerReason,
    };
    if (declinedDriverId) body.declined_driver_id = declinedDriverId;
    const resp = await fetch(`${supabaseUrl}/functions/v1/auto-dispatch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${supabaseServiceKey}`,
      },
      body: JSON.stringify(body),
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

/** Release exclusive / committed driver → urgent nearby convert (SSOT rescue). */
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
    excludeDriverId?: string | null;
  },
) {
  if (args.urgent === false) {
    // Legacy non-urgent branch kept for call-site compatibility — prefer urgent.
    const nowIso = args.now.toISOString();
    const broadcastAt = args.trip.scheduled_broadcast_at &&
        String(args.trip.scheduled_broadcast_at).trim()
      ? args.trip.scheduled_broadcast_at
      : nowIso;
    await supabase
      .from("trips")
      .update({
        driver_id: null,
        confirmed_driver_id: null,
        scheduled_status: "broadcasting",
        scheduled_broadcast_at: broadcastAt,
        status: "offered",
        commitment_time: null,
        scheduled_committed_at: null,
        updated_at: nowIso,
      })
      .eq("id", args.trip.id)
      .is("completed_at", null)
      .not("status", "in", TERMINAL_TRIP_STATUS_POSTGREST_LIST)
      .in("scheduled_status", [
        "scheduled_committed",
        "driver_assigned",
        "awaiting_activation_accept",
      ]);
    return;
  }

  await rescueExclusiveActivationToNearby(supabase, {
    tripId: args.trip.id,
    reason: args.reason,
    now: args.now,
    maxFindDriverMinutes: args.maxFindDriverMinutes ?? 6,
    supabaseUrl: args.supabaseUrl,
    supabaseServiceKey: args.supabaseServiceKey,
    excludeDriverId: args.excludeDriverId ??
      args.trip.confirmed_driver_id ??
      args.trip.driver_id,
    expireOpenOffers: true,
  });
}


function voidBackground(promise: Promise<unknown>): void {
  promise.catch((err) => console.error("[scheduled-dispatch] background task failed:", err));
}

// ─── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleCORSPreflight();

  const clientIP = getClientIP(req);
  const rateLimitResult = checkRateLimit(clientIP, RATE_LIMIT_CONFIG);
  if (!rateLimitResult.allowed) return rateLimitResponse(rateLimitResult);

  {
    const { assertCronOrServiceRoleAuth } = await import("../_shared/cronEdgeAuth.ts");
    const cronAuth = await assertCronOrServiceRoleAuth(req);
    if (!cronAuth.ok) {
      const { requireAdminOrService } = await import("../_shared/callerGate.ts");
      const adminGate = await requireAdminOrService(req);
      if (!adminGate.ok) return adminGate.response;
    }
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Admin Make Available (Now) — list-only marketplace alert, not NRO.
    {
      let body: Record<string, unknown> = {};
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        body = {};
      }
      const notifyTripId = String(body.notify_marketplace_trip_id ?? "").trim();
      if (notifyTripId) {
        const { data: tripRow, error: tripErr } = await supabase
          .from("trips")
          .select(
            "id, service_area_id, pickup_address, scheduled_at, trip_code, trip_number, scheduled_status, scheduled_broadcast_at, confirmed_driver_id, driver_id, dispatch_mode, status",
          )
          .eq("id", notifyTripId)
          .maybeSingle();
        if (tripErr || !tripRow) {
          return errorResponse("TRIP_NOT_FOUND", "Scheduled trip not found", 404);
        }
        const sched = String(tripRow.scheduled_status ?? "").toLowerCase();
        if (sched === "admin_held" || !tripRow.scheduled_broadcast_at) {
          return errorResponse(
            "INVALID_STATE",
            "Trip is not open on the Scheduled Jobs marketplace",
            409,
          );
        }
        if (tripRow.confirmed_driver_id || tripRow.driver_id) {
          return successResponse({
            success: true,
            notified: 0,
            skipped: "already_assigned",
          });
        }
        const result = await notifyScheduledMarketplaceOpen(supabase, tripRow);
        console.log("SCHEDULED_MARKETPLACE_NOTIFY", {
          trip_id: notifyTripId,
          notified: result.notified,
        });
        return successResponse({
          success: true,
          notified: result.notified,
          trip_id: notifyTripId,
        });
      }
    }

    const now = new Date();
    const nowMs = now.getTime();
    console.log(`[scheduled-dispatch] Running at ${now.toISOString()}`);

    // Phase 1: never leave payment_gate_blocked rows unresolved indefinitely.
    {
      const { data: blocked } = await supabase
        .from("trips")
        .select("id")
        .eq("scheduled_status", "payment_gate_blocked")
        .is("started_at", null)
        .is("completed_at", null)
        .order("updated_at", { ascending: true })
        .limit(50);
      for (const row of blocked ?? []) {
        try {
          const result = await resolvePaymentGateBlockedTrip(supabase, String(row.id));
          console.log("[scheduled-dispatch] payment_gate_blocked sweep", {
            trip_id: row.id,
            action: result.action,
          });
        } catch (sweepErr) {
          console.warn("[scheduled-dispatch] payment_gate_blocked sweep failed", {
            trip_id: row.id,
            error: String(sweepErr),
          });
        }
      }
    }

    const { data: globalSettings } = await supabase
      .from("global_dispatch_settings")
      .select(
        `enable_scheduled_to_urgent_conversion, scheduled_response_window_minutes,
         urgent_dispatch_trigger_minutes_before_pickup, locked_driver_response_minutes,
         max_driver_find_time_minutes, scheduled_urgent_card_label,
         long_trip_threshold_minutes, local_activation_minutes_before_pickup,
         long_activation_minutes_before_pickup, max_dispatch_rounds,
         presence_max_age_seconds,
         jit_target_early_arrival_minutes, jit_local_safety_buffer_minutes,
         jit_long_safety_buffer_minutes, jit_long_distance_eta_threshold_minutes,
         jit_oscillation_tolerance_minutes, jit_planning_horizon_minutes,
         jit_max_early_pull_ahead_of_fixed_minutes, jit_auto_activate_enabled,
         scheduled_departure_ack_enabled, scheduled_departure_ack_seconds,
         scheduled_departure_ack_grace_seconds,
         scheduled_departure_ack_capability_key,
         scheduled_departure_ack_min_app_version`,
      )
      .eq("singleton", true)
      .maybeSingle();

    const schedConfig = resolveScheduledDispatchConfig(globalSettings);
    const maxFindDriverMinutes = schedConfig.maxFindDriverMinutes;
    const activationConfig = schedConfig.activation;
    const jitConfig = resolveJitConfigFromSettingsRow(
      (globalSettings as Record<string, unknown> | null) ?? null,
    );
    const presenceMaxAgeSeconds = (() => {
      const n = Number(
        (globalSettings as { presence_max_age_seconds?: number } | null)
          ?.presence_max_age_seconds,
      );
      return Number.isFinite(n) && n > 0 ? n : 60;
    })();
    const instantMaxSequences = maxBroadcastSequences(
      { max_dispatch_rounds: (globalSettings as { max_dispatch_rounds?: number } | null)?.max_dispatch_rounds },
      null,
    );

    let committedCount = 0;
    let broadcastStarted = 0;
    let convertedToInstant = 0;
    let expired = 0;
    let stackedRedispatched = 0;
    let pendingReleasesExecuted = 0;

    // ============================================================
    // STEP 0: ADMIN PENDING RELEASE (Assign At / Broadcast At / Jobs At)
    // Backend cron — not browser timers. One pending action per trip.
    // ============================================================
    {
      const { data: dueReleases, error: dueErr } = await supabase
        .from("trips")
        .select(
          "id, pending_release_kind, pending_release_at, pending_release_driver_id, confirmed_driver_id, driver_id, scheduled_status, status, dispatch_mode, passenger_id, broadcast_enabled",
        )
        .not("pending_release_kind", "is", null)
        .not("pending_release_at", "is", null)
        .lte("pending_release_at", now.toISOString())
        .order("pending_release_at", { ascending: true })
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
            // Live accepted ownership cannot be overwritten from Scheduled board.
            // Pre-confirmed (confirmed_driver_id) MAY be swapped via Assign At.
            if (trip.driver_id) {
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
            // Deferred assign_at execution: SQL revalidates payment + commitment +
            // commission wallet under the same driver_sched_accept advisory lock as
            // marketplace accept / Admin assign_now (no direct trips UPDATE bypass).
            const { data: assignRaw, error } = await supabase.rpc(
              "execute_due_pending_scheduled_assign",
              { p_trip_id: trip.id },
            );
            if (error) {
              console.error("[scheduled-dispatch] pending assign RPC failed:", trip.id, error);
              continue;
            }
            const assignResult = (assignRaw ?? {}) as {
              success?: boolean;
              error?: string;
              message?: string;
              pending_cleared?: boolean;
              confirmed_driver_id?: string;
            };
            if (assignResult.success !== true) {
              const errCode = String(assignResult.error ?? "");
              console.warn("[scheduled-dispatch] pending assign blocked", {
                trip_id: trip.id,
                error: errCode,
                detail: assignResult.message ?? null,
              });
              if (errCode === "PAYMENT_GATE_NOT_SATISFIED") {
                await supabase
                  .from("trips")
                  .update({
                    scheduled_status: "payment_gate_blocked",
                    pending_release_kind: null,
                    pending_release_at: null,
                    pending_release_driver_id: null,
                    updated_at: now.toISOString(),
                  })
                  .eq("id", trip.id);
                try {
                  await resolvePaymentGateBlockedTrip(supabase, trip.id);
                } catch (resolveErr) {
                  console.warn("[scheduled-dispatch] payment_gate_blocked resolve failed", {
                    trip_id: trip.id,
                    error: String(resolveErr),
                  });
                }
              }
              // Commitment / wallet / CAS: pending cleared inside RPC; booking recoverable.
              continue;
            }
            pendingReleasesExecuted++;
            await logSnapshot(supabase, {
              tripId: trip.id,
              action: "admin_pending_assign_executed",
              metadata: {
                driver_id: driverId,
                confirmed_driver_id: assignResult.confirmed_driver_id ?? driverId,
              },
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
            // Live accepted ownership stays off this path.
            // Pre-confirmed may be released by Broadcast At (patch clears confirmed_driver_id).
            if (trip.driver_id) {
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
            // MK-261105-002: never broadcast unpaid / lost-auth scheduled rides.
            try {
              await assertPaymentGate(supabase, trip.id);
            } catch (gateErr) {
              const detail = gateErr instanceof PaymentGateError
                ? gateErr.message
                : String((gateErr as Error)?.message ?? gateErr);
              console.warn("[scheduled-dispatch] pending broadcast payment gate blocked", {
                trip_id: trip.id,
                detail,
              });
              await supabase
                .from("trips")
                .update({
                  scheduled_status: "payment_gate_blocked",
                  pending_release_kind: null,
                  pending_release_at: null,
                  pending_release_driver_id: null,
                  updated_at: now.toISOString(),
                })
                .eq("id", trip.id);
              try {
                await resolvePaymentGateBlockedTrip(supabase, trip.id);
              } catch (resolveErr) {
                console.warn("[scheduled-dispatch] payment_gate_blocked resolve failed", {
                  trip_id: trip.id,
                  error: String(resolveErr),
                });
              }
              continue;
            }
            const searchingExpiresAt = new Date(
              nowMs + maxFindDriverMinutes * 60_000,
            ).toISOString();
            const { data: priorBroadcastOffers } = await supabase
              .from("ride_offers")
              .select("broadcast_round")
              .eq("trip_id", trip.id)
              .order("broadcast_round", { ascending: false })
              .limit(1);
            const maxExistingBroadcastRound = Number(
              priorBroadcastOffers?.[0]?.broadcast_round ?? 0,
            );
            const allowBroadcast = resolveConversionBroadcastEnabled({
              currentBroadcastEnabled: (trip as { broadcast_enabled?: boolean | null })
                .broadcast_enabled,
            });
            const { data: broadcastRows, error } = await supabase
              .from("trips")
              .update(
                buildBroadcastNowPatch({
                  nowIso: now.toISOString(),
                  searchingExpiresAtIso: searchingExpiresAt,
                  maxExistingBroadcastRound: Number.isFinite(maxExistingBroadcastRound)
                    ? maxExistingBroadcastRound
                    : 0,
                  maxBroadcastSequences: instantMaxSequences,
                  currentBroadcastEnabled: (trip as { broadcast_enabled?: boolean | null })
                    .broadcast_enabled,
                }),
              )
              .eq("id", trip.id)
              .is("completed_at", null)
              .not("status", "in", TERMINAL_TRIP_STATUS_POSTGREST_LIST)
              .eq("pending_release_kind", "broadcast")
              .in("scheduled_status", [
                "admin_held",
                "scheduled",
                "pending",
                "driver_assigned",
              ])
              .is("driver_id", null)
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
              metadata: { broadcast_enabled: allowBroadcast },
            });
            // Broadcast At = NRO path. Never kick dispatch while airport hold remains.
            if (!allowBroadcast) {
              console.warn(
                `[scheduled-dispatch] pending Broadcast At held (airport/fare) for ${trip.id}`,
              );
              continue;
            }
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
            // Phase 3: never publish unpaid / lost-auth or airport-held rows via Jobs At.
            try {
              await assertPaymentGate(supabase, trip.id);
            } catch (gateErr) {
              const detail = gateErr instanceof PaymentGateError
                ? gateErr.message
                : String((gateErr as Error)?.message ?? gateErr);
              console.warn("[scheduled-dispatch] pending jobs payment gate blocked", {
                trip_id: trip.id,
                detail,
              });
              await supabase
                .from("trips")
                .update({
                  scheduled_status: "payment_gate_blocked",
                  pending_release_kind: null,
                  pending_release_at: null,
                  pending_release_driver_id: null,
                  updated_at: now.toISOString(),
                })
                .eq("id", trip.id);
              try {
                await resolvePaymentGateBlockedTrip(supabase, trip.id);
              } catch (resolveErr) {
                console.warn("[scheduled-dispatch] payment_gate_blocked resolve failed", {
                  trip_id: trip.id,
                  error: String(resolveErr),
                });
              }
              continue;
            }
            const tripAirport = trip as {
              broadcast_enabled?: boolean | null;
              airport_charge_pence?: number | null;
              scheduled_hold_reason?: string | null;
            };
            const airportReady = assertAirportPricingReady({
              broadcastEnabled: tripAirport.broadcast_enabled,
              airportChargePence: tripAirport.airport_charge_pence,
              scheduledHoldReason: tripAirport.scheduled_hold_reason,
            });
            if (!airportReady.ok) {
              // Only the existing persist-failure latch — never invent pricing.
              console.warn(
                `[scheduled-dispatch] pending Jobs At held (airport charge persist failure) for ${trip.id}`,
              );
              await supabase
                .from("trips")
                .update({
                  pending_release_kind: null,
                  pending_release_at: null,
                  pending_release_driver_id: null,
                  scheduled_hold_reason: "airport_pricing",
                  updated_at: now.toISOString(),
                })
                .eq("id", trip.id)
                .eq("pending_release_kind", "jobs");
              continue;
            }
            const { data: jobsRows, error } = await supabase
              .from("trips")
              .update({
                ...buildMakeAvailableScheduledJobsPatch({ nowIso: now.toISOString() }),
                scheduled_hold_reason: null,
              })
              .eq("id", trip.id)
              .is("completed_at", null)
              .not("status", "in", TERMINAL_TRIP_STATUS_POSTGREST_LIST)
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
            const { data: jobsTrip } = await supabase
              .from("trips")
              .select(
                "id, service_area_id, pickup_address, scheduled_at, trip_code, trip_number, scheduled_status, scheduled_broadcast_at, confirmed_driver_id, driver_id, dispatch_mode, status",
              )
              .eq("id", trip.id)
              .maybeSingle();
            if (jobsTrip) {
              voidBackground(
                notifyScheduledMarketplaceOpen(supabase, jobsTrip).then((r) => {
                  console.log("SCHEDULED_MARKETPLACE_NOTIFY", {
                    trip_id: trip.id,
                    notified: r.notified,
                    suppressed: r.suppressed,
                    via: "pending_jobs_at",
                  });
                }),
              );
            }
          }
        }
      }
    }

    // ============================================================
    // STEP 0b: Phase 3 auto-publish recovery (no Admin session required)
    // Catches CTAP post-commit failures / webhook races / premature ideal
    // broadcast stamps. Skips Manual Trip holds, airport holds, payment
    // blocks, and Assign/Broadcast pending.
    // ============================================================
    {
      let autoPublished = 0;
      const recoverySelect =
        "id, dispatch_mode, status, scheduled_status, scheduled_at, scheduled_broadcast_at, scheduled_hold_reason, scheduled_publish_attempts, driver_id, confirmed_driver_id, broadcast_enabled, airport_charge_pence, pending_release_kind, pending_release_at, booking_source, service_area_id, vehicle_type_id, vehicle_type, completed_at, cancelled_at, pickup_address, trip_code, trip_number, created_at";

      const { data: heldCandidates, error: heldErr } = await supabase
        .from("trips")
        .select(recoverySelect)
        .eq("dispatch_mode", "scheduled")
        .in("scheduled_status", ["admin_held", "scheduled", "pending"])
        .in("scheduled_hold_reason", [...AUTO_PUBLISH_ELIGIBLE_HOLD_REASONS])
        .is("driver_id", null)
        .is("confirmed_driver_id", null)
        .is("completed_at", null)
        .not("status", "in", TERMINAL_TRIP_STATUS_POSTGREST_LIST)
        .gt("scheduled_at", now.toISOString())
        .order("created_at", { ascending: true })
        .limit(50);

      // Premature ideal-anchor race (MK-261112-006 class): hold null + future broadcast_at.
      const { data: prematureCandidates, error: prematureErr } = await supabase
        .from("trips")
        .select(recoverySelect)
        .eq("dispatch_mode", "scheduled")
        .in("scheduled_status", ["scheduled", "pending"])
        .is("scheduled_hold_reason", null)
        .is("driver_id", null)
        .is("confirmed_driver_id", null)
        .is("completed_at", null)
        .not("status", "in", TERMINAL_TRIP_STATUS_POSTGREST_LIST)
        .gt("scheduled_at", now.toISOString())
        .gt("scheduled_broadcast_at", now.toISOString())
        .order("created_at", { ascending: true })
        .limit(50);

      if (heldErr) {
        console.error("[scheduled-dispatch] auto-publish recovery query failed:", heldErr);
      }
      if (prematureErr) {
        console.error("[scheduled-dispatch] premature-broadcast recovery query failed:", prematureErr);
      }

      const seen = new Set<string>();
      const recoveryCandidates = [...(heldCandidates ?? []), ...(prematureCandidates ?? [])]
        .filter((trip) => {
          const id = String(trip?.id ?? "");
          if (!id || seen.has(id)) return false;
          seen.add(id);
          return true;
        });

      for (const trip of recoveryCandidates) {
        if (isTripTerminalForDispatch(trip)) continue;
        const eligibility = evaluateScheduledMarketplaceAutoPublishEligibility(trip, {
          nowMs,
          allowUnknownBookingSource: false,
        });
        if (!eligibility.ok) continue;
        // Only recover unpublished / not-yet-due marketplace rows.
        const broadcastAtMs = trip.scheduled_broadcast_at
          ? Date.parse(String(trip.scheduled_broadcast_at))
          : NaN;
        const alreadyOpen = Number.isFinite(broadcastAtMs) && broadcastAtMs <= nowMs &&
          String(trip.scheduled_status ?? "").toLowerCase() !== "admin_held";
        if (alreadyOpen) continue;

        try {
          await assertPaymentGate(supabase, trip.id);
        } catch (gateErr) {
          const detail = gateErr instanceof PaymentGateError
            ? gateErr.message
            : String((gateErr as Error)?.message ?? gateErr);
          console.warn("[scheduled-dispatch] auto-publish recovery payment gate", {
            trip_id: trip.id,
            detail,
          });
          continue;
        }

        const result = await attemptScheduledMarketplaceAutoPublish(supabase, {
          tripId: trip.id,
          trip,
          nowIso: now.toISOString(),
          via: SCHEDULED_MARKETPLACE_AUTO_PUBLISH_VIA.recovery_sweep,
          allowUnknownBookingSource: false,
          stampRetryOnFailure: true,
        });
        if (!result.published) continue;
        autoPublished++;
        await logSnapshot(supabase, {
          tripId: trip.id,
          action: "scheduled_marketplace_auto_published",
          metadata: {
            via: "recovery_sweep",
            premature_ideal_broadcast: Number.isFinite(broadcastAtMs) && broadcastAtMs > nowMs,
          },
        });
        voidBackground(
          notifyScheduledMarketplaceOpen(supabase, {
            ...trip,
            scheduled_status: "scheduled",
            scheduled_broadcast_at: now.toISOString(),
          }).then((r) => {
            console.log("SCHEDULED_MARKETPLACE_NOTIFY", {
              trip_id: trip.id,
              notified: r.notified,
              suppressed: r.suppressed,
              via: "auto_publish_recovery_sweep",
            });
          }),
        );
      }
      if (autoPublished > 0) {
        console.log(`[scheduled-dispatch] auto-publish recovery published=${autoPublished}`);
      }
    }

    // ============================================================
    // STEP 1: PRE-CONFIRMED JIT ACTIVATION (Phase 4)
    // Dynamic departure deadline for confirmed drivers → auto en_route.
    // No second Accept. Phase 5 may later insert ack before activate.
    // Unclaimed Local/Long timings are unchanged (STEP 2 / STEP 3).
    // ============================================================

    const fixedLookAheadMs = scheduledActivationLookaheadMs(activationConfig);
    // Candidate load must cover the full JIT planning horizon (default 180m)
    // so long ETAs can stamp deadlines before fixed T−11 becomes due.
    const jitLookAheadMs =
      Math.max(
        jitConfig.planningHorizonMinutes,
        jitConfig.longDistanceEtaThresholdMinutes +
          jitConfig.targetEarlyArrivalMinutes +
          jitConfig.longSafetyBufferMinutes +
          15,
        SCHEDULED_JIT_ACTIVATION_DEFAULTS.planningHorizonMinutes,
      ) * 60_000;
    const lookAheadMs = Math.max(fixedLookAheadMs, jitLookAheadMs);
    const lookAheadThreshold = new Date(nowMs + lookAheadMs).toISOString();
    console.log("SCHEDULED_JIT_CANDIDATE_LOOKAHEAD", {
      look_ahead_minutes: Math.round(lookAheadMs / 60_000),
      planning_horizon_minutes: jitConfig.planningHorizonMinutes,
      fixed_lookahead_minutes: Math.round(fixedLookAheadMs / 60_000),
    });

    const { data: tripsForActivation, error: activationError } = await supabase
      .from("trips")
      .select("*")
      .eq("dispatch_mode", "scheduled")
      .in("scheduled_status", [
        "scheduled",
        "driver_assigned",
        "scheduled_committed",
        "awaiting_activation_accept",
      ])
      .not("confirmed_driver_id", "is", null)
      .is("driver_id", null)
      .lte("scheduled_at", lookAheadThreshold)
      .gt("scheduled_at", new Date(nowMs - 30 * 60_000).toISOString());

    if (activationError) {
      console.error("[scheduled-dispatch] Error fetching trips for activation:", activationError);
    } else if (tripsForActivation && tripsForActivation.length > 0) {
      const jitResult = await runConfirmedJitActivationPass({
        supabase,
        trips: tripsForActivation as any[],
        now,
        nowMs,
        activationConfig,
        jitConfig,
        presenceMaxAgeSeconds,
        lockedDriverResponseMinutes: schedConfig.lockedDriverResponseMinutes,
        maxFindDriverMinutes,
        supabaseUrl,
        supabaseServiceKey,
        releaseAndRebroadcast: async (args) => {
          await releaseAndRebroadcast(supabase, {
            trip: args.trip as ScheduledTrip,
            reason: args.reason,
            now: args.now,
            nowMs: args.nowMs,
            supabaseUrl: args.supabaseUrl,
            supabaseServiceKey: args.supabaseServiceKey,
            urgent: args.urgent,
            maxFindDriverMinutes: args.maxFindDriverMinutes,
            excludeDriverId: args.excludeDriverId,
          });
        },
        logSnapshot: async (args) => {
          await logSnapshot(supabase, args);
        },
      });
      committedCount += jitResult.armed + jitResult.activated;
      console.log("SCHEDULED_JIT_PASS", jitResult);
    }

    // ============================================================
    // STEP 1z: Post–Heading to Pickup lateness / stale GPS (D6)
    // Never auto-reassign. Ops alert + deduped traffic_delay only.
    // ============================================================
    {
      const {
        shouldSurfacePostActivationLateness,
        buildPostActivationLatenessOpsAlert,
        buildTrafficDelayNotificationId,
      } = await import("../_shared/scheduledPostActivationLatenessSSOT.ts");
      const { data: enRouteLateRows } = await supabase
        .from("trips")
        .select(
          "id, status, scheduled_status, scheduled_at, driver_id, confirmed_driver_id, passenger_id",
        )
        .eq("scheduled_status", "driver_en_route")
        .not("driver_id", "is", null)
        .lte("scheduled_at", now.toISOString())
        .order("scheduled_at", { ascending: true })
        .limit(30);

      for (const row of enRouteLateRows ?? []) {
        const driverId = String(row.driver_id ?? row.confirmed_driver_id ?? "").trim();
        if (!driverId) continue;
        let gpsAt: string | null = null;
        try {
          const { data: presence } = await supabase
            .from("driver_presence")
            .select("last_gps_sample_at, last_location_at, updated_at")
            .eq("driver_id", driverId)
            .maybeSingle();
          gpsAt =
            (presence?.last_gps_sample_at as string | null) ??
            (presence?.last_location_at as string | null) ??
            (presence?.updated_at as string | null);
        } catch {
          gpsAt = null;
        }
        const verdict = shouldSurfacePostActivationLateness({
          nowMs,
          scheduledAtIso: row.scheduled_at,
          status: row.status,
          scheduledStatus: row.scheduled_status,
          driverId,
          gpsSampledAtIso: gpsAt,
        });
        if (!verdict.escalate) continue;
        const alert = buildPostActivationLatenessOpsAlert({
          tripId: row.id,
          driverId,
          nowIso: now.toISOString(),
          lateVsPickup: verdict.lateVsPickup,
          staleGps: verdict.staleGps,
          minutesPastPickup: verdict.minutesPastPickup,
        });
        try {
          await supabase.from("ops_alerts").upsert(
            {
              fingerprint: alert.fingerprint,
              title: alert.title,
              related_trip_id: alert.related_trip_id,
              metadata: alert.metadata,
              status: "open",
              updated_at: now.toISOString(),
            },
            { onConflict: "fingerprint" },
          );
        } catch (opsErr) {
          console.warn("[scheduled-dispatch] lateness ops_alert failed", opsErr);
        }
        if (verdict.lateVsPickup && row.passenger_id) {
          void notifyCustomerTripLifecycle(supabase, {
            passengerId: row.passenger_id,
            tripId: row.id,
            event: "traffic_delay",
            title: "Traffic Update",
            body: "Your driver is running late — still on the way to pick you up.",
            notificationId: buildTrafficDelayNotificationId(row.id),
          }).catch((e) =>
            console.warn("[scheduled-dispatch] traffic_delay notify failed:", e)
          );
        }
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
          "id, confirmed_driver_id, driver_id, scheduled_status, status, passenger_id, pickup_address, scheduled_at, trip_number, scheduled_broadcast_at, scheduled_ack_status, scheduled_ack_deadline_at",
        )
        .eq("scheduled_status", "awaiting_activation_accept")
        .is("driver_id", null)
        .order("scheduled_at", { ascending: true })
        .limit(50);

      if (awaitingErr) {
        console.error("[scheduled-dispatch] awaiting activation query failed:", awaitingErr);
      } else {
        const { shouldRescueAwaitingActivation } = await import(
          "../_shared/scheduledDepartureAckRescueGateSSOT.ts"
        );
        const { data: ackGds } = await supabase
          .from("global_dispatch_settings")
          .select("scheduled_departure_ack_grace_seconds")
          .eq("singleton", true)
          .maybeSingle();
        const graceSeconds = Math.max(
          0,
          Number(ackGds?.scheduled_departure_ack_grace_seconds ?? 10) || 10,
        );
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

          const gate = shouldRescueAwaitingActivation({
            nowMs,
            ackStatus: (trip as { scheduled_ack_status?: string }).scheduled_ack_status,
            ackDeadlineAt: (trip as { scheduled_ack_deadline_at?: string })
              .scheduled_ack_deadline_at,
            graceSeconds,
            hasOpenLiveOffer: Boolean(openOffers?.length),
          });
          if (!gate.rescue) continue;

          // Expire any stale pending, then rescue (preserve trip id / fare / auth).
          await supabase
            .from("ride_offers")
            .update({ status: "expired", updated_at: now.toISOString() })
            .eq("trip_id", trip.id)
            .in("status", ["pending", "offered"]);

          const rescueReason = gate.reason === "acknowledgement_timeout"
            ? SCHEDULED_ACTIVATION_EXCLUSIVE_REASON.acknowledgementTimeout
            : SCHEDULED_ACTIVATION_EXCLUSIVE_REASON.expiredOrDeclined;

          console.log("SCHEDULED_ACTIVATION_NRO_RESCUE", {
            trip_id: trip.id,
            confirmed_driver_id: trip.confirmed_driver_id,
            reason: rescueReason,
          });
          await releaseAndRebroadcast(supabase, {
            trip: trip as ScheduledTrip,
            reason: rescueReason,
            now,
            nowMs,
            supabaseUrl,
            supabaseServiceKey,
            urgent: true,
            maxFindDriverMinutes,
            excludeDriverId: trip.confirmed_driver_id,
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
        const activationNowIso = now.toISOString();
        const { data: updatedRows, error: updateError } = await supabase
          .from("trips")
          .update({
            scheduled_status: "broadcasting",
            status: "offered",
            // Preserve marketplace open stamp when already published; do not
            // invent marketplace open from activation alone when already set.
            scheduled_broadcast_at: trip.scheduled_broadcast_at ?? activationNowIso,
            // Response-window / NRO clock starts at legitimate fallback activation.
            broadcast_started_at: trip.broadcast_started_at ?? activationNowIso,
            updated_at: activationNowIso,
          })
          .eq("id", trip.id)
          .is("completed_at", null)
          .not("status", "in", TERMINAL_TRIP_STATUS_POSTGREST_LIST)
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
        "id, scheduled_at, scheduled_broadcast_at, scheduled_convert_at, broadcast_started_at, driver_id, confirmed_driver_id, scheduled_status, status, dispatch_status, dispatch_mode, broadcast_enabled",
      )
      .eq("dispatch_mode", "scheduled")
      .in("scheduled_status", [...NO_PRECONFIRMED_CONVERT_SCHEDULED_STATUSES])
      .is("driver_id", null)
      .is("confirmed_driver_id", null)
      .order("scheduled_at", { ascending: true })
      .limit(50);

    if (convertError) {
      console.error("[scheduled-dispatch] Error fetching rides to convert:", convertError);
    } else if (ridesToConvert && ridesToConvert.length > 0) {
      const convertTripIds = ridesToConvert.map((t: { id: string }) => t.id);
      const { data: convertOffers } = await supabase
        .from("ride_offers")
        .select("trip_id, status, offered_at, created_at, broadcast_round")
        .in("trip_id", convertTripIds)
        .order("created_at", { ascending: true });

      const offersByTrip = new Map<string, NonNullable<typeof convertOffers>>();
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
        const maxExistingBroadcastRound = tripOffers.reduce((max, offer) => {
          const round = Number(offer.broadcast_round ?? 0);
          return Number.isFinite(round) ? Math.max(max, Math.floor(round)) : max;
        }, 0);
        const allowBroadcast = resolveConversionBroadcastEnabled({
          currentBroadcastEnabled: (trip as { broadcast_enabled?: boolean | null })
            .broadcast_enabled,
        });
        const conversionPatch = buildScheduledUrgentConversionPatch({
          nowIso: now.toISOString(),
          searchingExpiresAtIso: searchingExpiresAt,
          maxExistingBroadcastRound,
          maxBroadcastSequences: instantMaxSequences,
          broadcastEnabled: allowBroadcast,
        });

        const { data: convertedRows, error: updateError } = await supabase
          .from("trips")
          .update(conversionPatch)
          .eq("id", trip.id)
          .is("completed_at", null)
          .not("status", "in", TERMINAL_TRIP_STATUS_POSTGREST_LIST)
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
          metadata: {
            convert_reason: decision.reason,
            broadcast_enabled: allowBroadcast,
          },
        });
        if (!allowBroadcast) {
          console.warn(
            `[scheduled-dispatch] Convert held broadcast (airport/fare enrich) for ${trip.id}`,
          );
          convertedToInstant++;
          continue;
        }
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
      "id, status, scheduled_status, dispatch_status, dispatch_mode, updated_at, searching_expires_at, scheduled_at, passenger_id, confirmed_driver_id, is_scheduled, broadcast_enabled";

    const { data: expireConverted, error: expireConvertedError } = await supabase
      .from("trips")
      .select(expireSelect)
      .in("status", ["searching", "searching_new_driver", "offered", "broadcasting"])
      .is("driver_id", null)
      .eq("scheduled_status", "converted_to_instant")
      .order("scheduled_at", { ascending: true })
      .limit(50);

    // D2: never expire confirmed / pending-ack / heading / active assignments.
    // Exclusive rescue (STEP 1a / expire-offers) owns expired acknowledgements.
    const { data: expirePastPickup, error: expirePastError } = await supabase
      .from("trips")
      .select(expireSelect)
      .eq("is_scheduled", true)
      .is("driver_id", null)
      .is("confirmed_driver_id", null)
      .lte("scheduled_at", now.toISOString())
      .not(
        "status",
        "in",
        "(completed,cancelled,customer_cancelled,expired,expired_no_driver,no_show,declined,en_route_to_pickup,arrived_at_pickup,in_progress)",
      )
      .or(
        "scheduled_status.is.null,scheduled_status.not.in.(cancelled,expired,no_driver_found,awaiting_activation_accept,driver_en_route,driver_assigned,scheduled_committed)",
      )
      .order("scheduled_at", { ascending: true })
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
          const { data: priorExpireOffers } = await supabase
            .from("ride_offers")
            .select("broadcast_round")
            .eq("trip_id", trip.id)
            .order("broadcast_round", { ascending: false })
            .limit(1);
          const maxExistingBroadcastRound = Number(
            priorExpireOffers?.[0]?.broadcast_round ?? 0,
          );
          await supabase
            .from("trips")
            .update({
              ...buildScheduledUrgentConversionPatch({
                nowIso: now.toISOString(),
                searchingExpiresAtIso: pastDeadlineIso,
                maxExistingBroadcastRound: Number.isFinite(maxExistingBroadcastRound)
                  ? maxExistingBroadcastRound
                  : 0,
                maxBroadcastSequences: instantMaxSequences,
                broadcastEnabled: resolveConversionBroadcastEnabled({
                  currentBroadcastEnabled: (trip as { broadcast_enabled?: boolean | null })
                    .broadcast_enabled,
                }),
              }),
              confirmed_driver_id: null,
            })
            .eq("id", trip.id)
            .is("completed_at", null)
            .not("status", "in", TERMINAL_TRIP_STATUS_POSTGREST_LIST)
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
          await expireTripWhenSearchExhaustedAndNotifyCustomer(supabase as never, {
            tripId: trip.id,
            passengerId: trip.passenger_id ?? null,
          });

        if (rpcError) {
          console.warn("[scheduled-dispatch] expire_trip_when_search_exhausted failed:", trip.id, rpcError);
          continue;
        }

        if (didExpire === true) {
          await revokePendingOffersForTerminalTrip(supabase as never, trip.id, "trip_expired_no_driver");
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

          try {
            await broadcastScheduledMarketplaceChanged(supabase, {
              tripId: String(trip.id),
              serviceAreaId: trip.service_area_id ?? null,
              reason: "expired",
            });
          } catch (broadcastErr) {
            console.warn(
              "[scheduled-dispatch] expire marketplace broadcast non-fatal",
              broadcastErr instanceof Error ? broadcastErr.message : String(broadcastErr),
            );
          }

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
