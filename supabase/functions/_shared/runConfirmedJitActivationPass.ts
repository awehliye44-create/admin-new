/**
 * Phase 5 — confirmed-driver JIT monitor + departure acknowledgement pass.
 *
 * Default: arm_ack (45s Heading to Pickup / Cancel) — never stamps driver_en_route without ack.
 * jit_auto_activate_enabled hard-locked false.
 * Offline/stale: still arm so driver can reconnect within countdown — no premature rescue.
 * Compatible active journey: defer arm; infeasible → conflict rematch (never interrupt passenger).
 * Reuses exclusive ride_offers insert for urgent audible NEW_RIDE_OFFER (OTA-compatible).
 */

import type { AnySupabaseClient } from "./supabaseClientTypes.ts";
import {
  isScheduledActivationDue,
  type ScheduledActivationConfig,
} from "./scheduledActivationSSOT.ts";
import {
  classifyDriverAvailabilityForJit,
  decideConfirmedScheduledActivation,
  effectiveJitPlanningHorizonMinutes,
  isWithinJitPlanningHorizon,
  resolveScheduledJitActivationConfig,
  validateJitEtaMinutes,
  type ScheduledJitActivationConfig,
} from "./scheduledJitActivationSSOT.ts";
import {
  buildDepartureAckArmPatch,
  buildExclusiveActivationArmPatch,
  isAlreadyConfirmedActivated,
} from "./scheduledConfirmedActivationSSOT.ts";
import { computeDepartureAckDeadlineMs } from "./scheduledDepartureAckSSOT.ts";
import {
  normalizeCapabilityList,
  resolveDepartureAckCapabilityConfig,
  resolveDepartureAckExecutionModeForDriver,
  type DriverClientCapabilitySnapshot,
} from "./scheduledDepartureAckCapabilitySSOT.ts";
import {
  buildJitEtaUnresolvedOpsAlert,
  buildJitMonitorPersistPatch,
  buildLastKnownConservativeSample,
  evaluateJitDriverLocationFreshness,
  loadRecentDriverToPickupRouteSample,
  resolveJitDriverToPickupEta,
} from "./scheduledJitEtaMonitorSSOT.ts";
import {
  buildJitLateRiskOpsAlert,
  buildJitLocationReadinessOpsAlert,
  buildScheduledJitLocationReadinessPushBody,
  resolvePickupAwareJitDeadline,
  shouldEscalateScheduledLocationReadiness,
  shouldSendJitLocationReadinessPush,
  SCHEDULED_JIT_FALLBACK_DEFAULTS,
} from "./scheduledJitPickupAwareFallbackSSOT.ts";
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
import { estimateEtaMinutes } from "./scheduledDispatchConfig.ts";
import { upsertScheduledJitOpsAlert } from "./scheduledJitOpsAlertSSOT.ts";

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
  scheduled_jit_eta_minutes?: number | null;
  scheduled_jit_eta_spike_samples?: number | null;
  scheduled_ack_status?: string | null;
  scheduled_ack_deadline_at?: string | null;
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
  gpsSampleAtMs: number | null;
}> {
  const { data: driver } = await supabase
    .from("drivers")
    .select(
      "id, current_lat, current_lng, current_trip_id, first_name, last_gps_sample_at",
    )
    .eq("id", driverId)
    .maybeSingle();

  const { data: presence } = await supabase
    .from("driver_presence")
    .select(
      "lat, lng, last_heartbeat_at, last_location_at, last_gps_sample_at, status",
    )
    .eq("driver_id", driverId)
    .maybeSingle();

  const lat = Number(presence?.lat ?? driver?.current_lat);
  const lng = Number(presence?.lng ?? driver?.current_lng);
  const hb = Date.parse(String(presence?.last_heartbeat_at ?? ""));
  const gps = Date.parse(
    String(
      presence?.last_gps_sample_at ??
        driver?.last_gps_sample_at ??
        presence?.last_location_at ??
        "",
    ),
  );

  return {
    freshness: evaluateJitDriverLocationFreshness({
      lat: Number.isFinite(lat) ? lat : null,
      lng: Number.isFinite(lng) ? lng : null,
      gpsSampleAtMs: Number.isFinite(gps) ? gps : null,
      heartbeatAtMs: Number.isFinite(hb) ? hb : null,
      nowMs,
      presenceMaxAgeSeconds,
      lastKnownMaxAgeSeconds: SCHEDULED_JIT_FALLBACK_DEFAULTS.lastKnownMaxAgeSeconds,
    }),
    currentTripId: driver?.current_trip_id ? String(driver.current_trip_id) : null,
    firstName: driver?.first_name ? String(driver.first_name) : null,
    presenceStatus: presence?.status != null ? String(presence.status) : null,
    gpsSampleAtMs: Number.isFinite(gps) ? gps : null,
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

  // Global flag alone is insufficient — per-driver capability decides arm_ack vs ack_nro.
  const capabilityConfig = resolveDepartureAckCapabilityConfig({
    scheduled_departure_ack_enabled: jitConfig.departureAckEnabled,
    scheduled_departure_ack_capability_key: jitConfig.departureAckCapabilityKey,
    scheduled_departure_ack_min_app_version: jitConfig.departureAckMinAppVersion,
  });
  let activated = 0;
  let armed = 0;
  let monitored = 0;
  let rescued = 0;

  for (const trip of trips) {
    try {
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
    let resolvedEtaMinutes: number | null = null;

    const lastKnownEta = Number(trip.scheduled_jit_eta_minutes);
    const horizonMinutes = effectiveJitPlanningHorizonMinutes({
      config: jitConfig,
      lastKnownEtaMinutes: Number.isFinite(lastKnownEta) ? lastKnownEta : null,
      fixedLongActivationMinutes:
        activationConfig.longActivationMinutesBeforePickup,
    });
    const withinHorizon = isWithinJitPlanningHorizon({
      nowMs,
      scheduledAtMs: fixedDue.pickupMs,
      planningHorizonMinutes: horizonMinutes,
    });

    const prevDeadlineMs = trip.scheduled_jit_activate_at
      ? Date.parse(String(trip.scheduled_jit_activate_at))
      : NaN;

    let freshRouteEtaMinutes: number | null = null;
    let etaFailReason: string | null = null;

    if (withinHorizon) {
      const eta = await resolveJitDriverToPickupEta({
        supabase,
        tripId: trip.id,
        pickupLat: Number(trip.pickup_latitude),
        pickupLng: Number(trip.pickup_longitude),
        freshness: presence.freshness,
      });

      if (eta.ok) {
        const hav = presence.freshness.fresh &&
            presence.freshness.lat != null &&
            presence.freshness.lng != null
          ? estimateEtaMinutes(
            presence.freshness.lat,
            presence.freshness.lng,
            trip.pickup_latitude,
            trip.pickup_longitude,
          )
          : null;
        const validated = validateJitEtaMinutes({
          proposedEtaMinutes: eta.etaMinutes,
          previousEtaMinutes: Number.isFinite(lastKnownEta) ? lastKnownEta : null,
          haversineEtaMinutes: hav,
          consecutiveElevatedSamples: Number(trip.scheduled_jit_eta_spike_samples) || 0,
          config: jitConfig,
        });
        freshRouteEtaMinutes = validated.acceptedEtaMinutes;
        monitored++;
        if (validated.rejectedSpike) {
          await supabase
            .from("trips")
            .update({
              scheduled_jit_eta_spike_samples: validated.consecutiveElevatedSamples,
              updated_at: now.toISOString(),
            })
            .eq("id", trip.id)
            .is("driver_id", null);
        }
      } else {
        if (presence.freshness.fresh) routingFailedWithFresh = true;
        etaFailReason = eta.reason;
      }
    } else {
      etaFailReason = "outside_horizon";
    }

    const recentRoute = withinHorizon
      ? await loadRecentDriverToPickupRouteSample(
        supabase,
        trip.id,
        confirmedDriverId,
      )
      : null;
    const lastKnown = buildLastKnownConservativeSample({
      freshness: presence.freshness,
      pickupLat: Number(trip.pickup_latitude),
      pickupLng: Number(trip.pickup_longitude),
      gpsMeasuredAtMs: presence.gpsSampleAtMs,
    });

    // Always resolve a pickup-aware deadline for confirmed drivers.
    // Never silently assume fixed Local T−11 / Long T−30 can reach pickup.
    const aware = resolvePickupAwareJitDeadline({
      nowMs,
      scheduledAtMs: fixedDue.pickupMs,
      jitConfig,
      freshRouteEtaMinutes,
      stickyActivateAtIso: trip.scheduled_jit_activate_at,
      stickyBasisScheduledAtIso: trip.scheduled_jit_basis_scheduled_at,
      evaluatingConfirmedDriverId: confirmedDriverId,
      tripConfirmedDriverId: trip.confirmed_driver_id,
      recentRoute,
      currentDriverLat: presence.freshness.lat,
      currentDriverLng: presence.freshness.lng,
      lastKnown,
      previousDeadlineMs: Number.isFinite(prevDeadlineMs) ? prevDeadlineMs : null,
    });

    jitDeadlineMs = aware.deadlineMs;
    jitKind = aware.kind;
    etaSource = `${aware.tier}:${aware.reason}`;
    resolvedEtaMinutes = aware.etaMinutes;

    const shouldPersist =
      aware.tier === "route_fresh" ||
      aware.tier === "route_recent" ||
      aware.tier === "last_known_conservative" ||
      (aware.tier === "degraded_unknown" &&
        (!Number.isFinite(prevDeadlineMs) ||
          aware.deadlineMs < (prevDeadlineMs as number)));

    if (shouldPersist && aware.tier !== "sticky") {
      const persistEta = aware.etaMinutes ??
        (Number.isFinite(lastKnownEta) ? lastKnownEta : null);
      if (persistEta != null && Number.isFinite(persistEta)) {
        await supabase
          .from("trips")
          .update({
            ...buildJitMonitorPersistPatch({
              deadlineMs: aware.deadlineMs,
              etaMinutes: persistEta,
              kind: aware.kind,
              etaSource: etaSource,
              basisScheduledAtIso: trip.scheduled_at,
              nowIso: now.toISOString(),
            }),
          })
          .eq("id", trip.id)
          .is("driver_id", null);
      }
    }

    if (aware.tier === "sticky") {
      console.log("SCHEDULED_JIT_STICKY_DEADLINE_REUSED", {
        trip_id: trip.id,
        driver_id: confirmedDriverId,
        reason: aware.reason,
        eta_fail_reason: etaFailReason,
        freshness_reason: presence.freshness.reason,
        gps_age_seconds: presence.freshness.gpsAgeSeconds,
        deadline_iso: new Date(aware.deadlineMs).toISOString(),
      });
    }

    if (aware.tier === "degraded_unknown" || etaFailReason) {
      console.log("SCHEDULED_JIT_ETA_UNRESOLVED", {
        trip_id: trip.id,
        driver_id: confirmedDriverId,
        reason: etaFailReason ?? aware.reason,
        tier: aware.tier,
        freshness_reason: presence.freshness.reason,
        freshness_age_seconds: presence.freshness.ageSeconds,
        gps_age_seconds: presence.freshness.gpsAgeSeconds,
        presence_status: presence.presenceStatus,
        deadline_iso: new Date(aware.deadlineMs).toISOString(),
      });
      try {
        const alert = buildJitEtaUnresolvedOpsAlert({
          tripId: trip.id,
          driverId: confirmedDriverId,
          reason: etaFailReason ?? aware.reason,
          nowIso: now.toISOString(),
          tier: aware.tier,
        });
        await upsertScheduledJitOpsAlert(supabase, {
          fingerprint: alert.fingerprint,
          title: alert.title,
          related_trip_id: alert.related_trip_id,
          severity: "warning",
          metadata: {
            ...alert.metadata,
            freshness_reason: presence.freshness.reason,
            freshness_age_seconds: presence.freshness.ageSeconds,
            gps_age_seconds: presence.freshness.gpsAgeSeconds,
            presence_status: presence.presenceStatus,
          },
        });
      } catch (opsErr) {
        console.warn("[jit-activation] ops_alert upsert failed", opsErr);
      }
    }

    if (aware.lateRisk.cannotMeetTarget) {
      try {
        const lateAlert = buildJitLateRiskOpsAlert({
          tripId: trip.id,
          driverId: confirmedDriverId,
          nowIso: now.toISOString(),
          lateRisk: aware.lateRisk,
          etaMinutes: resolvedEtaMinutes,
          tier: aware.tier,
        });
        await upsertScheduledJitOpsAlert(supabase, {
          fingerprint: lateAlert.fingerprint,
          title: lateAlert.title,
          related_trip_id: lateAlert.related_trip_id,
          severity: "warning",
          metadata: lateAlert.metadata,
        });
      } catch (opsErr) {
        console.warn("[jit-activation] late-risk ops_alert upsert failed", opsErr);
      }
    }

    // Proactive location readiness (silent ops + optional silent push). Never
    // sends Heading to pickup / audible NEW_RIDE_OFFER.
    if (
      shouldEscalateScheduledLocationReadiness({
        nowMs,
        degradedDeadlineMs: aware.deadlineMs,
        hasStickyDeadline: Number.isFinite(prevDeadlineMs),
        gpsFreshForRouting: presence.freshness.fresh,
      })
    ) {
      try {
        const ready = buildJitLocationReadinessOpsAlert({
          tripId: trip.id,
          driverId: confirmedDriverId,
          reason: presence.freshness.reason,
          nowIso: now.toISOString(),
          degradedDeadlineIso: new Date(aware.deadlineMs).toISOString(),
          gpsAgeSeconds: presence.freshness.gpsAgeSeconds,
        });

        // Rate-limit FCM/APNs wakes using prior ops_alert metadata.last_push_at.
        // Ops visibility still upserts every escalate; push is capped.
        let lastPushAtMs: number | null = null;
        try {
          const { data: existingReady } = await supabase
            .from("ops_alerts")
            .select("metadata")
            .eq("fingerprint", ready.fingerprint)
            .maybeSingle();
          const rawLast =
            existingReady &&
            typeof existingReady === "object" &&
            existingReady.metadata &&
            typeof (existingReady.metadata as Record<string, unknown>)
              .last_push_at === "string"
              ? String(
                (existingReady.metadata as Record<string, unknown>)
                  .last_push_at,
              )
              : null;
          const parsedLast = rawLast ? Date.parse(rawLast) : NaN;
          lastPushAtMs = Number.isFinite(parsedLast) ? parsedLast : null;
        } catch {
          lastPushAtMs = null;
        }

        const sendPush = shouldSendJitLocationReadinessPush({
          nowMs,
          lastPushAtMs,
        });
        const metadata = {
          ...ready.metadata,
          ...(sendPush
            ? { last_push_at: now.toISOString(), push_attempted: true }
            : {
              last_push_at: lastPushAtMs != null
                ? new Date(lastPushAtMs).toISOString()
                : null,
              push_attempted: false,
              push_skipped_reason: "cooldown",
            }),
        };

        await upsertScheduledJitOpsAlert(supabase, {
          fingerprint: ready.fingerprint,
          title: ready.title,
          related_trip_id: ready.related_trip_id,
          severity: "warning",
          metadata,
        });

        if (sendPush) {
          // Best-effort silent data wake — no sound / no Heading copy.
          // OS may suppress; sticky/cached/degraded hierarchy remains authoritative.
          const pushBody = buildScheduledJitLocationReadinessPushBody({
            driverId: confirmedDriverId,
            tripId: trip.id,
          });
          void supabase.functions.invoke("send-driver-notification", {
            body: pushBody,
          }).catch((err: unknown) => {
            console.warn(
              "[jit-activation] location readiness push failed",
              err,
            );
          });
        }
      } catch (opsErr) {
        console.warn("[jit-activation] location readiness escalate failed", opsErr);
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

    const capabilitySnapshot = await loadDriverClientCapabilitySnapshot(
      supabase,
      confirmedDriverId,
    );
    const executionMode = resolveDepartureAckExecutionModeForDriver({
      config: capabilityConfig,
      snapshot: capabilitySnapshot,
    });

    // Confirmed path always supplies a pickup-aware jitDeadlineMs (A–E).
    // fixedFallbackDue is forced false so T−11/T−30 cannot silently win.
    const decision = decideConfirmedScheduledActivation({
      nowMs,
      scheduledAtMs: fixedDue.pickupMs,
      jitDeadlineMs,
      fixedFallbackDue: false,
      fixedFallbackActivationAtMs: fixedDue.activationAtMs,
      fixedFallbackKind: fixedDue.kind,
      intentionallyHeld,
      holdReason,
      activeJourneyThreatensCommitment: threat.threatens,
      activeJourneyThreatReason: threat.reason ?? undefined,
      // Compatible active journey: retain assignment; reassess after dropoff.
      // Do not start 45s countdown while completing a compatible journey.
      deferForCompatibleActiveJourney:
        Boolean(presence.currentTripId) && feasibility.feasible && !threat.threatens,
      availabilityClass: availability,
      executionMode,
      departureAckCountdownSeconds: jitConfig.departureAckSeconds,
    });

    console.log("SCHEDULED_JIT_DEADLINE_RESOLVED", {
      trip_id: trip.id,
      driver_id: confirmedDriverId,
      eta_source: etaSource,
      jit_kind: jitKind,
      deadline_iso: jitDeadlineMs != null
        ? new Date(jitDeadlineMs).toISOString()
        : null,
      eta_minutes: resolvedEtaMinutes,
      freshness_reason: presence.freshness.reason,
      gps_age_seconds: presence.freshness.gpsAgeSeconds,
      fixed_long_at: Number.isFinite(fixedDue.activationAtMs)
        ? new Date(fixedDue.activationAtMs).toISOString()
        : null,
      fixed_suppressed: true,
      execution_mode: executionMode,
    });

    if (decision.action === "wait" || decision.action === "hold_skip") {
      // Overdue sticky/dynamic deadline still waiting = ops escalate (Bug #29).
      if (
        decision.action === "wait" &&
        Number.isFinite(decision.deadlineMs) &&
        nowMs - decision.deadlineMs >= 3 * 60_000
      ) {
        try {
          await upsertScheduledJitOpsAlert(supabase, {
            fingerprint: `scheduled_jit_overdue_unactivated:${trip.id}`,
            title: "Confirmed scheduled JIT overdue without activation",
            related_trip_id: trip.id,
            severity: "critical",
            description:
              "Confirmed scheduled booking past sticky JIT deadline without arming. Investigate dispatch health.",
            metadata: {
              deadline_iso: new Date(decision.deadlineMs).toISOString(),
              overdue_minutes: Math.round((nowMs - decision.deadlineMs) / 60_000),
              reason: decision.kind,
              confirmed_driver_id: confirmedDriverId,
              scheduled_status: trip.scheduled_status,
            },
          });
        } catch {
          /* best-effort */
        }
      }
      continue;
    }

    // Due for arm — escalate if already 2+ minutes past authoritative deadline.
    if (
      Number.isFinite(decision.deadlineMs) &&
      nowMs - decision.deadlineMs >= 2 * 60_000
    ) {
      try {
        await upsertScheduledJitOpsAlert(supabase, {
          fingerprint: `scheduled_jit_overdue_unactivated:${trip.id}`,
          title: "Confirmed scheduled JIT overdue — arming now",
          related_trip_id: trip.id,
          severity: "critical",
          description:
            "Confirmed scheduled booking overdue; JIT pass is attempting departure-ack arm now.",
          metadata: {
            deadline_iso: new Date(decision.deadlineMs).toISOString(),
            overdue_minutes: Math.round((nowMs - decision.deadlineMs) / 60_000),
            decision_action: decision.action,
            confirmed_driver_id: confirmedDriverId,
          },
        });
      } catch {
        /* best-effort */
      }
    }

    // Only infeasible commitment (or explicit conflict) rescues — never premature
    // offline rescue before Phase 5 acknowledgement opportunity.
    if (decision.action === "conflict_rescue") {
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

    const isDepartureAck = decision.action === "arm_ack";
    const eligibility = await evaluateConfirmedDriverExclusiveEligibility(supabase, {
      driverId: confirmedDriverId,
      tripId: trip.id,
      nowMs,
      allowOnTrip: Boolean(presence.currentTripId),
      // Phase 5: offline/stale still get acknowledgement opportunity.
      allowOfflineForDepartureAck: isDepartureAck || executionMode === "departure_ack",
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

    if (decision.action === "arm_ack" || decision.action === "arm_exclusive_nro") {
      const departureAck = decision.action === "arm_ack";
      const countdownSeconds = departureAck
        ? Math.max(
          1,
          Math.floor(
            (decision as { countdownSeconds?: number }).countdownSeconds ??
              jitConfig.departureAckSeconds,
          ),
        )
        : Math.max(1, Number(lockedDriverResponseMinutes ?? 3)) * 60;
      const ackDeadlineMs = departureAck
        ? computeDepartureAckDeadlineMs({
          nowMs,
          countdownSeconds,
        })
        : nowMs + countdownSeconds * 1000;
      const expiresAt = new Date(ackDeadlineMs).toISOString();
      const ackNonce = crypto.randomUUID();

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
        departureAcknowledgement: departureAck,
        ackNonce: departureAck ? ackNonce : null,
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
      const armPatch = departureAck
        ? buildDepartureAckArmPatch({
          nowIso: now.toISOString(),
          deadlineIso: expiresAt,
          driverId: confirmedDriverId,
          nonce: ackNonce,
        })
        : buildExclusiveActivationArmPatch({ nowIso: now.toISOString() });

      const { data: armedRows, error: armErr } = await supabase
        .from("trips")
        .update(armPatch)
        .eq("id", trip.id)
        .is("completed_at", null)
        .not("status", "in", TERMINAL_TRIP_STATUS_POSTGREST_LIST)
        .in("scheduled_status", ["scheduled", "driver_assigned", "scheduled_committed"])
        .is("driver_id", null)
        .select("id");

      if (armErr || !armedRows?.length) {
        // Explicit block reason — never silent (Bug #29). Next cron retries.
        console.error("SCHEDULED_JIT_ARM_CAS_FAILED", {
          trip_id: trip.id,
          offer_id: offerId,
          driver_id: confirmedDriverId,
          arm_error: armErr?.message ?? null,
          armed_rows: armedRows?.length ?? 0,
          scheduled_status: trip.scheduled_status,
          trip_status: trip.status,
        });
        await upsertScheduledJitOpsAlert(supabase, {
          fingerprint: `scheduled_jit_arm_cas_failed:${trip.id}`,
          title: "Scheduled JIT arm CAS failed — offer cancelled",
          related_trip_id: trip.id,
          severity: "critical",
          description:
            "JIT arm CAS matched zero rows; exclusive offer cancelled. Next cron retries.",
          metadata: {
            offer_id: offerId,
            confirmed_driver_id: confirmedDriverId,
            arm_error: armErr?.message ?? "zero_rows",
            scheduled_status: trip.scheduled_status,
            trip_status: trip.status,
            decision_action: decision.action,
            deadline_iso: new Date(decision.deadlineMs).toISOString(),
          },
        });
        await supabase
          .from("ride_offers")
          .update({ status: "cancelled", updated_at: now.toISOString() })
          .eq("id", offerId);
        continue;
      }

      const logAction = departureAck
        ? "scheduled_jit_arm_departure_ack"
        : "scheduled_jit_arm_exclusive_nro";
      await input.logSnapshot({
        tripId: trip.id,
        action: logAction,
        stage: "offer_inserted",
        driverId: confirmedDriverId,
        metadata: {
          source: decision.source,
          kind: decision.kind,
          deadline_at: new Date(decision.deadlineMs).toISOString(),
          eta_source: etaSource,
          jit_kind: jitKind,
          execution_mode: executionMode,
          phase5_ack_deadline_at: departureAck ? expiresAt : null,
          departure_acknowledgement: departureAck,
          offer_id: offerId,
          ack_nonce: departureAck ? ackNonce : null,
          // Same device_id authoritative push will target.
          active_device_id: capabilitySnapshot?.deviceId ?? null,
          client_capabilities: capabilitySnapshot?.capabilities ?? [],
        },
      });
      console.log(
        departureAck ? "SCHEDULED_JIT_ARM_DEPARTURE_ACK" : "SCHEDULED_JIT_ARM_EXCLUSIVE_NRO",
        {
          trip_id: trip.id,
          offer_id: offerId,
          driver_id: confirmedDriverId,
          source: decision.source,
          ack_deadline_at: departureAck ? expiresAt : null,
          active_device_id: capabilitySnapshot?.deviceId ?? null,
        },
      );
      armed++;
      continue;
    }

    // activate_now must never run — en_route only after Heading to Pickup.
    console.warn("[jit-activation] unexpected decision ignored (Phase 5 fail-closed)", {
      trip_id: trip.id,
      action: (decision as { action?: string }).action,
    });
    } catch (tripErr) {
      // One trip must never abort the whole confirmed-JIT sweep (Bug #29).
      console.error("[jit-activation] per-trip failure isolated", {
        trip_id: trip?.id ?? null,
        error: tripErr instanceof Error ? tripErr.message : String(tripErr),
      });
      await upsertScheduledJitOpsAlert(supabase, {
        fingerprint: `scheduled_jit_trip_eval_failed:${String(trip?.id ?? "unknown")}`,
        title: "Scheduled JIT trip evaluation failed",
        related_trip_id: trip?.id ? String(trip.id) : null,
        severity: "critical",
        description:
          "Per-trip JIT evaluation threw; sweep continued for other confirmed bookings.",
        metadata: {
          error: tripErr instanceof Error ? tripErr.message : String(tripErr),
          confirmed_driver_id: trip?.confirmed_driver_id ?? null,
        },
      });
    }
  }

  return { activated, armed, monitored, rescued };
}

export function resolveJitConfigFromSettingsRow(
  row: Record<string, unknown> | null | undefined,
): ScheduledJitActivationConfig {
  return resolveScheduledJitActivationConfig(row as any);
}

async function loadDriverClientCapabilitySnapshot(
  supabase: AnySupabaseClient,
  driverId: string,
): Promise<DriverClientCapabilitySnapshot | null> {
  try {
    // Sole active device only — same row authoritative push resolves.
    const { data } = await supabase
      .from("driver_active_devices")
      .select("device_id, client_capabilities, app_version")
      .eq("driver_id", driverId)
      .maybeSingle();
    if (!data) return null;
    const deviceId =
      typeof (data as { device_id?: unknown }).device_id === "string"
        ? String((data as { device_id: string }).device_id).trim()
        : "";
    return {
      deviceId: deviceId || null,
      capabilities: normalizeCapabilityList(
        (data as { client_capabilities?: unknown }).client_capabilities,
      ),
      appVersion:
        typeof (data as { app_version?: unknown }).app_version === "string"
          ? String((data as { app_version: string }).app_version)
          : null,
    };
  } catch {
    return null;
  }
}
