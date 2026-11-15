/**
 * Edge gate + release orchestration for scheduled journey compliance.
 * Authoritative SQL twin: assert_driver_scheduled_journey_compliance /
 * release_scheduled_assignment_for_compliance (migration).
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { evaluateDriverDocumentState } from "./driverDocumentEligibility.ts";
import {
  evaluateScheduledJourneyCompliance,
  SCHEDULED_COMPLIANCE_RELEASE_DRIVER_MESSAGE,
  shouldReleaseConfirmedScheduledForCompliance,
  shouldUseUrgentRescueForComplianceRelease,
  type ScheduledJourneyComplianceResult,
} from "./scheduledJourneyComplianceSSOT.ts";
import {
  buildBroadcastNowPatch,
} from "./scheduledAdminReleaseSSOT.ts";
import {
  buildScheduledMarketplaceRematchPatch,
} from "./scheduledPreActivationReleaseSSOT.ts";
import { resolveScheduledDispatchConfig } from "./scheduledDispatchConfig.ts";
import { maxBroadcastSequences } from "./dispatch-settings.ts";
import { notifyCustomerTripLifecycle } from "./customerTripLifecycleNotify.ts";
import { broadcastScheduledMarketplaceChanged } from "./scheduledMarketplaceRealtimeBroadcastSSOT.ts";

type AnySupabase = SupabaseClient<any, "public", any>;

export { SCHEDULED_COMPLIANCE_RELEASE_DRIVER_MESSAGE };

const UNACTIVATED_SCHEDULED_STATUSES = new Set([
  "driver_assigned",
  "scheduled_committed",
  "awaiting_activation_accept",
  "scheduled",
]);

export async function assertScheduledJourneyComplianceForDriverTrip(
  supabase: AnySupabase,
  input: {
    driverId: string;
    tripId: string;
    scheduledAtIso?: string | null;
    estimatedDurationMinutes?: number | null;
    tripStatus?: string | null;
    now?: Date;
  },
): Promise<ScheduledJourneyComplianceResult> {
  // Prefer authoritative SQL when available (post-migration).
  try {
    const { data, error } = await supabase.rpc(
      "assert_driver_scheduled_journey_compliance",
      {
        p_driver_id: input.driverId,
        p_trip_id: input.tripId,
      },
    );
    if (!error && data && typeof data === "object") {
      const row = data as Record<string, unknown>;
      if (typeof row.allowed === "boolean") {
        return {
          allowed: row.allowed === true,
          code: String(row.code ?? (row.allowed ? "OK" : "DOCUMENTS_NOT_APPROVED")) as ScheduledJourneyComplianceResult["code"],
          message: String(row.message ?? ""),
          journeyEndIso: row.journey_end_iso != null
            ? String(row.journey_end_iso)
            : null,
          asOfLondonDate: row.as_of_london_date != null
            ? String(row.as_of_london_date)
            : null,
          expiredDocumentSlugs: Array.isArray(row.expired_documents)
            ? (row.expired_documents as unknown[]).map(String)
            : [],
        };
      }
    }
  } catch {
    // Fall through to Edge mirror when RPC not deployed yet.
  }

  const { data: driver } = await supabase
    .from("drivers")
    .select("id, approval_status, driver_status, deleted_at, service_area_id")
    .eq("id", input.driverId)
    .maybeSingle();

  let scheduledAt = input.scheduledAtIso ?? null;
  let duration = input.estimatedDurationMinutes ?? null;
  let tripStatus = input.tripStatus ?? null;
  if (!scheduledAt || duration == null) {
    const { data: trip } = await supabase
      .from("trips")
      .select("id, scheduled_at, estimated_duration_minutes, status")
      .eq("id", input.tripId)
      .maybeSingle();
    scheduledAt = scheduledAt ?? (trip?.scheduled_at != null ? String(trip.scheduled_at) : null);
    duration = duration ?? (trip?.estimated_duration_minutes != null
      ? Number(trip.estimated_duration_minutes)
      : null);
    tripStatus = tripStatus ?? (trip?.status != null ? String(trip.status) : null);
  }

  if (!scheduledAt) {
    return {
      allowed: false,
      code: "INVALID_SCHEDULED_AT",
      message: "Scheduled pickup time is invalid.",
      journeyEndIso: null,
      asOfLondonDate: null,
      expiredDocumentSlugs: [],
    };
  }

  // Load docs + rules via existing eligibility fetch (today) then re-evaluate
  // with journey-end now via evaluateScheduledJourneyCompliance snapshot path.
  const live = await evaluateDriverDocumentState(supabase, input.driverId);
  const { data: documents } = await supabase
    .from("documents")
    .select("document_type, status, expiry_date, rejection_reason, created_at, updated_at")
    .eq("driver_id", input.driverId);

  const { data: rules } = driver?.service_area_id
    ? await supabase
      .from("service_area_document_rules")
      .select("doc_type_id, mandatory, expiry_required, is_active, display_in_driver_app")
      .eq("service_area_id", driver.service_area_id)
      .eq("is_active", true)
    : { data: [] as unknown[] };

  const typeIds = (rules ?? [])
    .map((r: { doc_type_id?: string }) => r.doc_type_id)
    .filter(Boolean) as string[];
  const { data: types } = typeIds.length
    ? await supabase.from("document_types").select("id, slug").in("id", typeIds)
    : { data: [] as { id: string; slug: string }[] };
  const slugById = new Map((types ?? []).map((t) => [t.id, t.slug]));
  const requiredRules = (rules ?? [])
    .filter((r: { mandatory?: boolean; display_in_driver_app?: boolean }) =>
      r.mandatory !== false && r.display_in_driver_app !== false
    )
    .map((r: { doc_type_id?: string; expiry_required?: boolean; mandatory?: boolean }) => ({
      slug: String(slugById.get(String(r.doc_type_id)) ?? ""),
      expiry_required: r.expiry_required !== false,
      mandatory: r.mandatory !== false,
    }))
    .filter((r: { slug: string }) => r.slug.length > 0);

  // If live evaluator already blocked for non-expiry reasons, preserve that.
  void live;

  return evaluateScheduledJourneyCompliance({
    account: driver,
    documents: documents ?? [],
    requiredRules,
    scheduledAtIso: scheduledAt,
    estimatedDurationMinutes: duration,
    now: input.now ?? new Date(),
    tripStatus,
  });
}

export function isUnactivatedConfirmedScheduledTrip(trip: {
  driver_id?: string | null;
  confirmed_driver_id?: string | null;
  status?: string | null;
  scheduled_status?: string | null;
  started_at?: string | null;
  is_scheduled?: boolean | null;
  dispatch_mode?: string | null;
}): boolean {
  if (trip.started_at) return false;
  if (trip.driver_id) return false;
  if (!trip.confirmed_driver_id) return false;
  const status = String(trip.status ?? "").toLowerCase();
  if (["in_progress", "en_route_to_pickup", "arrived", "completed", "cancelled"].includes(status)) {
    return false;
  }
  const sched = String(trip.scheduled_status ?? "").toLowerCase();
  if (!UNACTIVATED_SCHEDULED_STATUSES.has(sched) && sched !== "broadcasting") {
    // Still treat driver_assigned / committed as unactivated when preconfirm.
    if (!["driver_assigned", "scheduled_committed", "awaiting_activation_accept"].includes(sched)) {
      return false;
    }
  }
  return trip.is_scheduled === true || String(trip.dispatch_mode ?? "") === "scheduled";
}

/**
 * Atomically release an unactivated confirmed scheduled booking for compliance.
 * Prefer SQL RPC when deployed; Edge mirror for local / pre-migration.
 */
export async function releaseConfirmedScheduledForCompliance(
  supabase: AnySupabase,
  input: {
    tripId: string;
    driverId: string;
    complianceCode: string;
    scheduledAtIso: string;
    now?: Date;
    urgentTriggerMinutesBeforePickup?: number;
    supabaseUrl?: string;
    supabaseServiceKey?: string;
    notifyDriver?: boolean;
    notifyCustomer?: boolean;
  },
): Promise<{ ok: boolean; released: boolean; urgent: boolean; error?: string }> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const urgent = shouldUseUrgentRescueForComplianceRelease({
    scheduledAtIso: input.scheduledAtIso,
    nowMs: now.getTime(),
    urgentTriggerMinutesBeforePickup: input.urgentTriggerMinutesBeforePickup,
  });

  // Authoritative SQL path
  try {
    const { data, error } = await supabase.rpc(
      "release_scheduled_assignment_for_compliance",
      {
        p_trip_id: input.tripId,
        p_expected_driver_id: input.driverId,
        p_reason: input.complianceCode,
        p_urgent: urgent,
      },
    );
    if (!error && data && typeof data === "object") {
      const row = data as Record<string, unknown>;
      if (row.success === true || row.released === true) {
        await afterComplianceReleaseSideEffects(supabase, {
          ...input,
          urgent: Boolean(row.urgent ?? urgent),
          nowIso,
        });
        return {
          ok: true,
          released: true,
          urgent: Boolean(row.urgent ?? urgent),
        };
      }
      if (row.idempotent === true || row.error === "ALREADY_RELEASED") {
        return { ok: true, released: false, urgent };
      }
      return {
        ok: false,
        released: false,
        urgent,
        error: String(row.error ?? "release_failed"),
      };
    }
  } catch {
    // Fall through
  }

  // Edge mirror — same CAS semantics as cancel_confirmed rematch.
  const { data: trip, error: tripErr } = await supabase
    .from("trips")
    .select(
      "id, driver_id, confirmed_driver_id, status, scheduled_status, scheduled_at, scheduled_broadcast_at, broadcast_enabled, service_area_id, passenger_id, started_at, is_scheduled, dispatch_mode, estimated_duration_minutes",
    )
    .eq("id", input.tripId)
    .maybeSingle();

  if (tripErr || !trip) {
    return { ok: false, released: false, urgent, error: "TRIP_NOT_FOUND" };
  }
  if (!isUnactivatedConfirmedScheduledTrip(trip)) {
    return { ok: true, released: false, urgent, error: "NOT_UNACTIVATED_CONFIRMED" };
  }
  if (String(trip.confirmed_driver_id) !== String(input.driverId)) {
    return { ok: true, released: false, urgent, error: "DRIVER_MISMATCH" };
  }

  await supabase.rpc("decline_scheduled_ride", {
    p_trip_id: input.tripId,
    p_driver_id: input.driverId,
    p_reason: "compliance_ineligible",
  }).catch(() => null);

  const broadcastAt =
    trip.scheduled_broadcast_at && String(trip.scheduled_broadcast_at).trim()
      ? trip.scheduled_broadcast_at
      : nowIso;

  const rematchBroadcastEnabled = trip.broadcast_enabled !== false;

  let patch: Record<string, unknown>;
  if (urgent && rematchBroadcastEnabled) {
    const { data: globalCfg } = await supabase
      .from("global_dispatch_settings")
      .select("max_driver_find_time_minutes, max_dispatch_rounds")
      .eq("singleton", true)
      .maybeSingle();
    const maxFind = resolveScheduledDispatchConfig(globalCfg ?? {}).maxFindDriverMinutes;
    const { data: prior } = await supabase
      .from("ride_offers")
      .select("broadcast_round")
      .eq("trip_id", input.tripId)
      .order("broadcast_round", { ascending: false })
      .limit(1);
    patch = buildBroadcastNowPatch({
      nowIso,
      searchingExpiresAtIso: new Date(now.getTime() + maxFind * 60_000).toISOString(),
      maxExistingBroadcastRound: Number(prior?.[0]?.broadcast_round ?? 0) || 0,
      maxBroadcastSequences: maxBroadcastSequences(
        { max_dispatch_rounds: globalCfg?.max_dispatch_rounds },
        null,
      ),
      currentBroadcastEnabled: trip.broadcast_enabled,
    });
  } else {
    // Bug #22 shared SSOT with cancel_confirmed — never stamp status=offered.
    patch = buildScheduledMarketplaceRematchPatch({
      nowIso,
      broadcastAtIso: String(broadcastAt),
      broadcastEnabled: rematchBroadcastEnabled,
      cancellationReason: null,
      cancellationNote: null,
    });
  }

  const { data: updated, error: updErr } = await supabase
    .from("trips")
    .update(patch)
    .eq("id", input.tripId)
    .eq("confirmed_driver_id", input.driverId)
    .is("driver_id", null)
    .is("started_at", null)
    .select("id")
    .maybeSingle();

  if (updErr) {
    return { ok: false, released: false, urgent, error: updErr.message };
  }
  if (!updated) {
    return { ok: true, released: false, urgent, error: "CAS_MISS" };
  }

  await supabase
    .from("ride_offers")
    .update({ status: "cancelled", updated_at: nowIso })
    .eq("trip_id", input.tripId)
    .eq("driver_id", input.driverId)
    .in("status", ["pending", "offered", "countered"]);

  await afterComplianceReleaseSideEffects(supabase, {
    ...input,
    urgent,
    nowIso,
    serviceAreaId: trip.service_area_id ?? null,
    passengerId: trip.passenger_id ?? null,
  });

  return { ok: true, released: true, urgent };
}

async function afterComplianceReleaseSideEffects(
  supabase: AnySupabase,
  input: {
    tripId: string;
    driverId: string;
    complianceCode: string;
    urgent: boolean;
    nowIso: string;
    notifyDriver?: boolean;
    notifyCustomer?: boolean;
    supabaseUrl?: string;
    supabaseServiceKey?: string;
    serviceAreaId?: string | null;
    passengerId?: string | null;
  },
): Promise<void> {
  try {
    await supabase.rpc("log_audit_event", {
      p_event_type: "scheduled_job_compliance_released",
      p_driver_id: input.driverId,
      p_trip_id: input.tripId,
      p_details: JSON.stringify({
        code: input.complianceCode,
        urgent: input.urgent,
        at: input.nowIso,
      }),
    });
  } catch {
    // non-fatal
  }

  if (input.notifyDriver !== false) {
    try {
      await supabase.functions.invoke("send-driver-notification", {
        body: {
          driver_id: input.driverId,
          type: "SCHEDULED_COMPLIANCE_RELEASE",
          title: "Scheduled trip released",
          body: SCHEDULED_COMPLIANCE_RELEASE_DRIVER_MESSAGE,
          data: {
            trip_id: input.tripId,
            type: "SCHEDULED_COMPLIANCE_RELEASE",
            notification_type: "SCHEDULED_COMPLIANCE_RELEASE",
            reason: "compliance_ineligible",
          },
          notification_id: `scheduled_compliance_release-${input.tripId}`,
        },
      });
    } catch (err) {
      console.warn("[scheduledJourneyComplianceGate] driver notify failed:", err);
    }
  }

  if (input.notifyCustomer !== false) {
    try {
      let passengerId = input.passengerId ?? null;
      if (!passengerId) {
        const { data: t } = await supabase
          .from("trips")
          .select("passenger_id")
          .eq("id", input.tripId)
          .maybeSingle();
        passengerId = t?.passenger_id ?? null;
      }
      if (passengerId) {
        await notifyCustomerTripLifecycle(supabase, {
          passengerId,
          tripId: input.tripId,
          event: "driver_cancelled",
          title: "Looking for another driver",
          body: input.urgent
            ? "We're finding you a replacement driver right now."
            : "We're looking for another driver for your scheduled trip.",
          notificationId: `compliance_release-${input.tripId}`,
          path: input.urgent ? "/booking/finding-drivers" : "/account/rides",
        });
      }
    } catch (err) {
      console.warn("[scheduledJourneyComplianceGate] customer notify failed:", err);
    }
  }

  try {
    await broadcastScheduledMarketplaceChanged(supabase, {
      tripId: input.tripId,
      serviceAreaId: input.serviceAreaId ?? null,
      reason: input.urgent ? "converted" : "cancelled",
    });
  } catch {
    // non-fatal
  }

  const url = input.supabaseUrl ?? Deno.env.get("SUPABASE_URL");
  const key = input.supabaseServiceKey ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (url && key) {
    try {
      if (input.urgent) {
        await fetch(`${url}/functions/v1/auto-dispatch`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`,
          },
          body: JSON.stringify({ trip_id: input.tripId, force_rebroadcast: true }),
        });
      } else {
        await fetch(`${url}/functions/v1/scheduled-dispatch`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`,
          },
          body: JSON.stringify({}),
        });
      }
    } catch (err) {
      console.warn("[scheduledJourneyComplianceGate] dispatch kick failed:", err);
    }
  }
}

/**
 * Bounded reconciliation: revalidate unactivated confirmed scheduled bookings.
 */
export async function reconcileConfirmedScheduledJourneyCompliance(
  supabase: AnySupabase,
  input?: {
    now?: Date;
    limit?: number;
    supabaseUrl?: string;
    supabaseServiceKey?: string;
    urgentTriggerMinutesBeforePickup?: number;
  },
): Promise<{ scanned: number; released: number; protected: number }> {
  const now = input?.now ?? new Date();
  const limit = Math.min(Math.max(input?.limit ?? 40, 1), 100);
  const { data: rows } = await supabase
    .from("trips")
    .select(
      "id, driver_id, confirmed_driver_id, status, scheduled_status, scheduled_at, estimated_duration_minutes, started_at, is_scheduled, dispatch_mode, service_area_id, passenger_id, broadcast_enabled, scheduled_broadcast_at",
    )
    .eq("is_scheduled", true)
    .eq("dispatch_mode", "scheduled")
    .not("confirmed_driver_id", "is", null)
    .is("driver_id", null)
    .is("started_at", null)
    .is("completed_at", null)
    .is("cancelled_at", null)
    .in("scheduled_status", [
      "driver_assigned",
      "scheduled_committed",
      "awaiting_activation_accept",
    ])
    .gt("scheduled_at", now.toISOString())
    .order("scheduled_at", { ascending: true })
    .limit(limit);

  let scanned = 0;
  let released = 0;
  let protectedCount = 0;

  for (const trip of rows ?? []) {
    scanned += 1;
    const driverId = String(trip.confirmed_driver_id ?? "");
    if (!driverId) continue;

    const compliance = await assertScheduledJourneyComplianceForDriverTrip(supabase, {
      driverId,
      tripId: String(trip.id),
      scheduledAtIso: String(trip.scheduled_at),
      estimatedDurationMinutes: trip.estimated_duration_minutes != null
        ? Number(trip.estimated_duration_minutes)
        : null,
      tripStatus: trip.status != null ? String(trip.status) : null,
      now,
    });

    if (
      !shouldReleaseConfirmedScheduledForCompliance({
        compliance,
        tripStatus: trip.status != null ? String(trip.status) : null,
        hasStartedAt: Boolean(trip.started_at),
      })
    ) {
      if (compliance.code === "IN_PROGRESS_PROTECTED") protectedCount += 1;
      continue;
    }

    const result = await releaseConfirmedScheduledForCompliance(supabase, {
      tripId: String(trip.id),
      driverId,
      complianceCode: compliance.code,
      scheduledAtIso: String(trip.scheduled_at),
      now,
      urgentTriggerMinutesBeforePickup: input?.urgentTriggerMinutesBeforePickup,
      supabaseUrl: input?.supabaseUrl,
      supabaseServiceKey: input?.supabaseServiceKey,
    });
    if (result.released) released += 1;
  }

  return { scanned, released, protected: protectedCount };
}
