/**
 * Phase 4 — confirmed-driver JIT monitor + activation pass.
 *
 * Default: arm exclusive NRO (acknowledgement) — does NOT claim en_route without Accept.
 * Optional jit_auto_activate_enabled: direct en_route (ops-only until Phase 5).
 * Unavailable / stale / offline drivers are rescued — never blindly activated via fixed fallback.
 */

import type { AnySupabaseClient } from "./supabaseClientTypes.ts";
import {
  isScheduledActivationDue,
  type ScheduledActivationConfig,
} from "./scheduledActivationSSOT.ts";
import {
  classifyDriverAvailabilityForJit,
  computeJitDepartureDeadlineMs,
  decideConfirmedScheduledActivation,
  isWithinJitPlanningHorizon,
  reconcileStickyJitDeadline,
  resolveJitExecutionMode,
  resolveScheduledJitActivationConfig,
  type ScheduledJitActivationConfig,
} from "./scheduledJitActivationSSOT.ts";
import {
  buildConfirmedActivationPatch,
  buildExclusiveActivationArmPatch,
  CONFIRMED_ACTIVATION_FROM_STATUSES,
  isAlreadyConfirmedActivated,
} from "./scheduledConfirmedActivationSSOT.ts";
import {
  buildJitEtaUnresolvedOpsAlert,
  buildJitMonitorPersistPatch,
  evaluateJitDriverLocationFreshness,
  resolveJitDriverToPickupEta,
} from "./scheduledJitEtaMonitorSSOT.ts";
import {
  activeJourneyThreatensScheduledCommitment,
  evaluateScheduledCommitmentFeasibility,
} from "./scheduledCommitmentFeasibilitySSOT.ts";
import { assertPaymentGate, PaymentGateError } from "./paymentGate.ts";
import { resolvePaymentGateBlockedTrip } from "./paymentGateBlockedResolutionSSOT.ts";
import { assertAirportPricingReady } from "./scheduledMarketplaceHoldSSOT.ts";
import { evaluateConfirmedDriverExclusiveEligibility } from "./scheduledActivationExclusiveRescue.ts";
import {
  buildExclusiveActivationOfferSnapshot,
  resolveActivationGrossPenceForPreview,
  resolveExclusiveActivationDriverNetPence,
  SCHEDULED_ACTIVATION_EXCLUSIVE_REASON,
} from "./scheduledActivationExclusiveSSOT.ts";
import { isTripTerminalForDispatch, TERMINAL_TRIP_STATUS_POSTGREST_LIST } from "./tripTerminalDispatch.ts";
import { notifyCustomerTripLifecycle } from "./customerTripLifecycleNotify.ts";
import { estimateEtaMinutes } from "./scheduledDispatchConfig.ts";

export type JitPassTrip = {
  id: string;
  scheduled_at: string;
  scheduled_status: string | null;
  status: string | null;
  confirmed_driver_id: string | null;
  driver_id: string | null;
  pickup_latitude: number | null;
  pickup_longitude: number | null;
  estimated_duration_minutes?: number | null;
  driver_checked_in_at?: string | null;
  scheduled_hold_reason?: string | null;
  scheduled_jit_activate_at?: string | null;
  scheduled_jit_basis_scheduled_at?: string | null;
  broadcast_enabled?: boolean | null;
  airport_charge_pence?: number | null;
  passenger_id?: string | null;
  pickup_address?: string | null;
  service_area_id?: string | null;
  currency_code?: string | null;
  currency?: string | null;
  [key: string]: unknown;
};

async function loadDriverPresenceSnapshot(
  supabase: AnySupabaseClient,
  driverId: string,
  nowMs: number,
  presenceMaxAgeSeconds: number | null,
): Promise<{
  freshness: ReturnType<typeof evaluateJitDriverLocationFreshness>;
  currentTripId: string | null;
  firstName: string | null;
  presenceStatus: string | null;
}> {
  const { data: driver } = await supabase
    .from("drivers")
    .select("id, current_lat, current_lng, current_trip_id, first_name")
    .eq("id", driverId)
    .maybeSingle();

  const { data: presence } = await supabase
    .from("driver_presence")
    .select("lat, lng, last_heartbeat_at, last_location_at, status")
    .eq("driver_id", driverId)
    .maybeSingle();

  const lat = Number(presence?.lat ?? driver?.current_lat);
  const lng = Number(presence?.lng ?? driver?.current_lng);
  const hb = Date.parse(String(presence?.last_heartbeat_at ?? ""));
  const loc = Date.parse(String(presence?.last_location_at ?? ""));
  const lastSeenMs = [hb, loc].filter((n) => Number.isFinite(n)).reduce(
    (a, b) => Math.max(a, b),
    NaN,
  );

  return {
    freshness: evaluateJitDriverLocationFreshness({
      lat: Number.isFinite(lat) ? lat : null,
      lng: Number.isFinite(lng) ? lng : null,
      lastSeenMs: Number.isFinite(lastSeenMs) ? lastSeenMs : null,
      nowMs,
      presenceMaxAgeSeconds,
    }),
    currentTripId: driver?.current_trip_id ? String(driver.current_trip_id) : null,
    firstName: driver?.first_name ? String(driver.first_name) : null,
    presenceStatus: presence?.status != null ? String(presence.status) : null,
  };
}

async function estimateRemainingActiveMinutes(
  supabase: AnySupabaseClient,
  activeTripId: string | null,
  nowMs: number,
): Promise<number> {
  if (!activeTripId) return 0;
  const { data: active } = await supabase
    .from("trips")
    .select(
      "id, status, estimated_duration_minutes, started_at",
    )
    .eq("id", activeTripId)
    .maybeSingle();
  if (!active) return 0;
  const status = String(active.status ?? "").toLowerCase();
  if (["completed", "cancelled", "customer_cancelled", "driver_cancelled", "no_show", "expired"].includes(status)) {
    return 0;
  }
  const dur = Number(active.estimated_duration_minutes);
  if (Number.isFinite(dur) && dur > 0) {
    const started = Date.parse(String(active.started_at ?? ""));
    if (Number.isFinite(started)) {
      const elapsedMin = Math.max(0, (nowMs - started) / 60_000);
      return Math.max(5, Math.ceil(dur - elapsedMin));
    }
    return Math.max(5, Math.ceil(dur));
  }
  return 30;
}

export async function runConfirmedJitActivationPass(input: {
  supabase: AnySupabaseClient;
  trips: JitPassTrip[];
  now: Date;
  nowMs: number;
  activationConfig: ScheduledActivationConfig;
  jitConfig: ScheduledJitActivationConfig;
  presenceMaxAgeSeconds: number | null;
  lockedDriverResponseMinutes: number;
  maxFindDriverMinutes: number;
  supabaseUrl: string;
  supabaseServiceKey: string;
  releaseAndRebroadcast: (args: {
    trip: JitPassTrip;
    reason: string;
    now: Date;
    nowMs: number;
    supabaseUrl: string;
    supabaseServiceKey: string;
    urgent: boolean;
    maxFindDriverMinutes: number;
    excludeDriverId: string;
  }) => Promise<void>;
  logSnapshot: (args: {
    tripId: string;
    action: string;
    stage: string;
    driverId?: string | null;
    metadata?: Record<string, unknown>;
  }) => Promise<void>;
}): Promise<{ activated: number; armed: number; monitored: number; rescued: number }> {
  const {
    supabase,
    trips,
    now,
    nowMs,
    activationConfig,
    jitConfig,
    presenceMaxAgeSeconds,
    lockedDriverResponseMinutes,
    maxFindDriverMinutes,
    supabaseUrl,
    supabaseServiceKey,
  } = input;

  const executionMode = resolveJitExecutionMode(jitConfig);
  let activated = 0;
  let armed = 0;
  let monitored = 0;
  let rescued = 0;

  for (const trip of trips) {
    if (isTripTerminalForDispatch(trip as any)) continue;
    if (!trip.pickup_latitude || !trip.pickup_longitude) continue;
    const confirmedDriverId = String(trip.confirmed_driver_id ?? "").trim();
    if (!confirmedDriverId) continue;

    if (
      isAlreadyConfirmedActivated({
        scheduledStatus: trip.scheduled_status,
        tripStatus: trip.status,
        driverId: trip.driver_id,
        confirmedDriverId,
      })
    ) {
      continue;
    }

    // Already armed — STEP 1a / expire-offers owns rescue; do not re-arm every minute.
    if (String(trip.scheduled_status) === "awaiting_activation_accept") {
      continue;
    }

    const holdReason = String(trip.scheduled_hold_reason ?? "").trim().toLowerCase();
    const intentionallyHeld =
      holdReason === "admin_exceptional" ||
      holdReason === "manual" ||
      String(trip.scheduled_status ?? "").toLowerCase() === "admin_held";

    const fixedDue = isScheduledActivationDue({
      scheduledAt: trip.scheduled_at,
      estimatedDurationMinutes: trip.estimated_duration_minutes,
      config: activationConfig,
      nowMs,
    });

    const presence = await loadDriverPresenceSnapshot(
      supabase,
      confirmedDriverId,
      nowMs,
      presenceMaxAgeSeconds,
    );

    let jitDeadlineMs: number | null = null;
    let jitKind = "jit";
    let etaSource = "none";
    let routingFailedWithFresh = false;

    const withinHorizon = isWithinJitPlanningHorizon({
      nowMs,
      scheduledAtMs: fixedDue.pickupMs,
      planningHorizonMinutes: jitConfig.planningHorizonMinutes,
    });

    if (withinHorizon) {
      const eta = await resolveJitDriverToPickupEta({
        supabase,
        tripId: trip.id,
        pickupLat: Number(trip.pickup_latitude),
        pickupLng: Number(trip.pickup_longitude),
        freshness: presence.freshness,
      });

      if (eta.ok) {
        const computed = computeJitDepartureDeadlineMs({
          scheduledAtMs: fixedDue.pickupMs,
          driverToPickupEtaMinutes: eta.etaMinutes,
          config: jitConfig,
        });
        const prevMs = trip.scheduled_jit_activate_at
          ? Date.parse(String(trip.scheduled_jit_activate_at))
          : NaN;
        const basisMs = trip.scheduled_jit_basis_scheduled_at
          ? Date.parse(String(trip.scheduled_jit_basis_scheduled_at))
          : NaN;
        const sticky = reconcileStickyJitDeadline({
          previousDeadlineMs: Number.isFinite(prevMs) ? prevMs : null,
          candidateDeadlineMs: computed.deadlineMs,
          fixedActivationAtMs: fixedDue.activationAtMs,
          oscillationToleranceMinutes: jitConfig.oscillationToleranceMinutes,
          maxEarlyPullAheadOfFixedMinutes: jitConfig.maxEarlyPullAheadOfFixedMinutes,
          basisScheduledAtMs: Number.isFinite(basisMs) ? basisMs : null,
          currentScheduledAtMs: fixedDue.pickupMs,
        });
        jitDeadlineMs = sticky.deadlineMs;
        jitKind = computed.kind;
        etaSource = eta.source;
        monitored++;

        if (sticky.changed) {
          await supabase
            .from("trips")
            .update(
              buildJitMonitorPersistPatch({
                deadlineMs: sticky.deadlineMs,
                etaMinutes: computed.etaMinutes,
                kind: computed.kind,
                etaSource: eta.source,
                basisScheduledAtIso: trip.scheduled_at,
                nowIso: now.toISOString(),
              }),
            )
            .eq("id", trip.id)
            .is("driver_id", null);
        }
      } else {
        if (presence.freshness.fresh) routingFailedWithFresh = true;
        try {
          const alert = buildJitEtaUnresolvedOpsAlert({
            tripId: trip.id,
            driverId: confirmedDriverId,
            reason: eta.reason,
            nowIso: now.toISOString(),
          });
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
          console.warn("[jit-activation] ops_alert upsert failed", opsErr);
        }
      }
    }

    const remaining = await estimateRemainingActiveMinutes(
      supabase,
      presence.currentTripId,
      nowMs,
    );
    const travelFromCompletion = (() => {
      if (
        presence.freshness.fresh &&
        presence.freshness.lat != null &&
        presence.freshness.lng != null
      ) {
        return estimateEtaMinutes(
          presence.freshness.lat,
          presence.freshness.lng,
          trip.pickup_latitude,
          trip.pickup_longitude,
        ) ?? 30;
      }
      return 30;
    })();

    const feasibility = evaluateScheduledCommitmentFeasibility({
      nowMs,
      remainingJourneyMinutes: remaining,
      travelToPickupEtaMinutes: travelFromCompletion,
      scheduledAtMs: fixedDue.pickupMs,
      config: jitConfig,
    });
    const threat = activeJourneyThreatensScheduledCommitment({
      hasActiveJourney: Boolean(presence.currentTripId),
      feasibility,
    });

    const availability = classifyDriverAvailabilityForJit({
      presenceStatus: presence.presenceStatus,
      locationFresh: presence.freshness.fresh,
      locationReason: presence.freshness.reason,
      hasActiveJourney: Boolean(presence.currentTripId),
      routingFailedWithFreshLocation: routingFailedWithFresh,
    });

    // Fresh location + temporary routing failure may still arm/activate using
    // conservative haversine for deadline; stale/offline/unreachable may not.
    const driverAvailableForActivation =
      availability === "available" ||
      availability === "routing_api_failure" ||
      availability === "on_active_journey";

    const decision = decideConfirmedScheduledActivation({
      nowMs,
      scheduledAtMs: fixedDue.pickupMs,
      jitDeadlineMs,
      fixedFallbackDue: fixedDue.due,
      fixedFallbackActivationAtMs: fixedDue.activationAtMs,
      fixedFallbackKind: fixedDue.kind,
      intentionallyHeld,
      holdReason,
      activeJourneyThreatensCommitment: threat.threatens,
      activeJourneyThreatReason: threat.reason ?? undefined,
      driverAvailableForActivation:
        driverAvailableForActivation && presence.freshness.fresh,
      availabilityClass: availability,
      executionMode,
    });

    if (decision.action === "wait" || decision.action === "hold_skip") {
      continue;
    }

    if (
      decision.action === "conflict_rescue" ||
      decision.action === "unavailable_rescue"
    ) {
      console.log("SCHEDULED_JIT_RESCUE", {
        trip_id: trip.id,
        driver_id: confirmedDriverId,
        action: decision.action,
        reason: decision.reason,
      });
      await input.releaseAndRebroadcast({
        trip,
        reason: SCHEDULED_ACTIVATION_EXCLUSIVE_REASON.ineligibleBypass,
        now,
        nowMs,
        supabaseUrl,
        supabaseServiceKey,
        urgent: true,
        maxFindDriverMinutes,
        excludeDriverId: confirmedDriverId,
      });
      rescued++;
      continue;
    }

    // Shared gates before arm or activate
    try {
      await assertPaymentGate(supabase, trip.id);
    } catch (gateErr) {
      const detail = gateErr instanceof PaymentGateError
        ? gateErr.message
        : String((gateErr as Error)?.message ?? gateErr);
      console.warn("[jit-activation] payment gate blocked", { trip_id: trip.id, detail });
      await supabase
        .from("trips")
        .update({
          scheduled_status: "payment_gate_blocked",
          updated_at: now.toISOString(),
        })
        .eq("id", trip.id);
      try {
        await resolvePaymentGateBlockedTrip(supabase, trip.id);
      } catch {
        /* best-effort */
      }
      continue;
    }

    const airportReady = assertAirportPricingReady({
      broadcastEnabled: trip.broadcast_enabled,
      airportChargePence: trip.airport_charge_pence as number | null | undefined,
      scheduledHoldReason: trip.scheduled_hold_reason,
    });
    if (!airportReady.ok) {
      await supabase
        .from("trips")
        .update({
          scheduled_status: "admin_held",
          scheduled_hold_reason: "airport_pricing",
          updated_at: now.toISOString(),
        })
        .eq("id", trip.id)
        .is("driver_id", null);
      continue;
    }

    const eligibility = await evaluateConfirmedDriverExclusiveEligibility(supabase, {
      driverId: confirmedDriverId,
      tripId: trip.id,
      nowMs,
      allowOnTrip: Boolean(presence.currentTripId),
    });
    if (!eligibility.eligible) {
      await input.releaseAndRebroadcast({
        trip,
        reason: SCHEDULED_ACTIVATION_EXCLUSIVE_REASON.ineligibleBypass,
        now,
        nowMs,
        supabaseUrl,
        supabaseServiceKey,
        urgent: true,
        maxFindDriverMinutes,
        excludeDriverId: confirmedDriverId,
      });
      rescued++;
      continue;
    }

    if (decision.action === "arm_exclusive_nro") {
      const responseMinutes = Math.max(1, Number(lockedDriverResponseMinutes ?? 3));
      const expiresAt = new Date(nowMs + responseMinutes * 60_000).toISOString();

      let computedPreview: number | null = null;
      const stampedNet = resolveExclusiveActivationDriverNetPence({ trip: trip as any });
      if (stampedNet == null) {
        const gross = resolveActivationGrossPenceForPreview(trip as any);
        if (gross != null && trip.service_area_id) {
          const { data: preview } = await supabase.rpc(
            "compute_driver_net_preview_from_gross",
            {
              p_gross_pence: gross,
              p_driver_id: confirmedDriverId,
              p_service_area_id: trip.service_area_id,
              p_airport_charge_pence: Number(trip.airport_charge_pence ?? 0) || 0,
            },
          );
          const n = Number(preview);
          computedPreview = Number.isFinite(n) && n > 0 ? Math.round(n) : null;
        }
      }
      const netPence = resolveExclusiveActivationDriverNetPence({
        trip: trip as any,
        computedPreviewPence: computedPreview,
      });
      if (netPence == null || netPence <= 0) {
        await input.releaseAndRebroadcast({
          trip,
          reason: SCHEDULED_ACTIVATION_EXCLUSIVE_REASON.netUnavailableBypass,
          now,
          nowMs,
          supabaseUrl,
          supabaseServiceKey,
          urgent: true,
          maxFindDriverMinutes,
          excludeDriverId: confirmedDriverId,
        });
        rescued++;
        continue;
      }

      const offerSnapshot = buildExclusiveActivationOfferSnapshot({
        trip: trip as any,
        confirmedDriverId,
        netPence,
        kind: decision.kind,
        expiresAtIso: expiresAt,
      });

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
          is_stacked: eligibility.isStacked,
          offer_snapshot: offerSnapshot,
        })
        .select("id");

      if (offerErr || !offerRows?.length) {
        await input.releaseAndRebroadcast({
          trip,
          reason: SCHEDULED_ACTIVATION_EXCLUSIVE_REASON.insertBlockedBypass,
          now,
          nowMs,
          supabaseUrl,
          supabaseServiceKey,
          urgent: true,
          maxFindDriverMinutes,
          excludeDriverId: confirmedDriverId,
        });
        rescued++;
        continue;
      }

      const offerId = String(offerRows[0].id);
      const { data: armedRows, error: armErr } = await supabase
        .from("trips")
        .update(buildExclusiveActivationArmPatch({ nowIso: now.toISOString() }))
        .eq("id", trip.id)
        .is("completed_at", null)
        .not("status", "in", TERMINAL_TRIP_STATUS_POSTGREST_LIST)
        .in("scheduled_status", ["scheduled", "driver_assigned", "scheduled_committed"])
        .is("driver_id", null)
        .select("id");

      if (armErr || !armedRows?.length) {
        await supabase
          .from("ride_offers")
          .update({ status: "cancelled", updated_at: now.toISOString() })
          .eq("id", offerId);
        continue;
      }

      await input.logSnapshot({
        tripId: trip.id,
        action: "scheduled_jit_arm_exclusive_nro",
        stage: "offer_inserted",
        driverId: confirmedDriverId,
        metadata: {
          source: decision.source,
          kind: decision.kind,
          deadline_at: new Date(decision.deadlineMs).toISOString(),
          eta_source: etaSource,
          jit_kind: jitKind,
          execution_mode: executionMode,
          phase5_ack_deadline_at: null,
          offer_id: offerId,
        },
      });
      console.log("SCHEDULED_JIT_ARM_EXCLUSIVE_NRO", {
        trip_id: trip.id,
        offer_id: offerId,
        driver_id: confirmedDriverId,
        source: decision.source,
      });
      armed++;
      continue;
    }

    if (decision.action !== "activate_now") {
      continue;
    }

    // Ops-only auto en_route path (jit_auto_activate_enabled=true)
    const patch = buildConfirmedActivationPatch({
      confirmedDriverId,
      nowIso: now.toISOString(),
      existingCheckedInAt: trip.driver_checked_in_at,
      activationSource: decision.source,
    });

    const { data: armedRows, error: armErr } = await supabase
      .from("trips")
      .update(patch)
      .eq("id", trip.id)
      .is("completed_at", null)
      .not("status", "in", TERMINAL_TRIP_STATUS_POSTGREST_LIST)
      .in("scheduled_status", [...CONFIRMED_ACTIVATION_FROM_STATUSES])
      .eq("confirmed_driver_id", confirmedDriverId)
      .is("driver_id", null)
      .select("id");

    if (armErr || !armedRows?.length) {
      console.warn("[jit-activation] CAS activate missed", {
        trip_id: trip.id,
        error: armErr,
      });
      continue;
    }

    await supabase
      .from("ride_offers")
      .update({
        status: "cancelled",
        updated_at: now.toISOString(),
      })
      .eq("trip_id", trip.id)
      .eq("driver_id", confirmedDriverId)
      .in("status", ["pending", "offered", "countered"]);

    await input.logSnapshot({
      tripId: trip.id,
      action: "scheduled_jit_auto_activation",
      stage: "activated",
      driverId: confirmedDriverId,
      metadata: {
        source: decision.source,
        kind: decision.kind,
        deadline_at: new Date(decision.deadlineMs).toISOString(),
        eta_source: etaSource,
        jit_kind: jitKind,
        execution_mode: executionMode,
        phase5_ack_deadline_at: null,
      },
    });

    if (trip.passenger_id) {
      try {
        const driverName = presence.firstName?.trim() || "Your driver";
        await notifyCustomerTripLifecycle(supabase, {
          passengerId: String(trip.passenger_id),
          tripId: trip.id,
          event: "driver_assigned",
          title: "Your driver is on the way",
          body: `${driverName} is heading to your pickup at ${trip.pickup_address ?? "your location"}.`,
          notificationId: `driver_assigned-${trip.id}-scheduled_jit`,
        });
      } catch (notifErr) {
        console.warn("[jit-activation] customer notify failed", notifErr);
      }
    }

    console.log("SCHEDULED_JIT_AUTO_ACTIVATED", {
      trip_id: trip.id,
      driver_id: confirmedDriverId,
      source: decision.source,
    });
    activated++;
  }

  return { activated, armed, monitored, rescued };
}

export function resolveJitConfigFromSettingsRow(
  row: Record<string, unknown> | null | undefined,
): ScheduledJitActivationConfig {
  return resolveScheduledJitActivationConfig(row as any);
}
