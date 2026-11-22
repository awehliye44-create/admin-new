/**
 * #79A — Claim + send scheduled traffic_delay with durable ledger ownership.
 *
 * Atomic UNIQUE(notification_id) insert is the concurrency gate across cron,
 * scheduled-ride-action, and scheduledJourneyComplianceGate on-demand sweeps.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { buildTrafficDelayNotificationId } from "../scheduled-dispatch/lib/scheduledPostActivationLatenessSSOT.ts";
import { notifyCustomerTripLifecycle } from "./customerTripLifecycleNotify.ts";
import {
  buildScheduledTrafficDelayCopy,
  decideTrafficDelayClaim,
  isScheduledTrafficDelayObsolete,
  resolveTrafficDelayDeliveryOutcome,
  TRAFFIC_DELAY_EVENT,
  type TrafficDelayDeliveryStatus,
} from "./customerTrafficDelayNotifySSOT.ts";

export type ScheduledTrafficDelayNotifyResult =
  | { status: "sent" | "skipped" | "failed" | "ambiguous"; reason?: string }
  | { status: "already_done"; reason: string }
  | { status: "obsolete"; reason: string }
  | { status: "claim_failed"; reason: string };

type DeliveryRow = {
  id: string;
  status: string;
  updated_at: string;
  attempts?: number | null;
};

async function loadDelivery(
  supabase: SupabaseClient,
  notificationId: string,
): Promise<DeliveryRow | null> {
  const { data } = await supabase
    .from("customer_trip_notification_deliveries")
    .select("id, status, updated_at, attempts")
    .eq("notification_id", notificationId)
    .maybeSingle();
  if (!data?.id) return null;
  return data as DeliveryRow;
}

async function markDelivery(
  supabase: SupabaseClient,
  deliveryId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await supabase
    .from("customer_trip_notification_deliveries")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", deliveryId);
}

async function claimDelivery(args: {
  supabase: SupabaseClient;
  notificationId: string;
  tripId: string;
  passengerId: string;
  nowMs: number;
  obsolete: boolean;
}): Promise<
  | { ok: true; deliveryId: string; mode: "new" | "retry" }
  | { ok: false; reason: string }
> {
  const existing = await loadDelivery(args.supabase, args.notificationId);
  const decision = decideTrafficDelayClaim({
    existing: existing
      ? { status: existing.status, updatedAtIso: existing.updated_at }
      : null,
    nowMs: args.nowMs,
    obsolete: args.obsolete,
  });

  if (decision.action === "skip") {
    if (decision.reason === "obsolete" && !existing) {
      const nowIso = new Date(args.nowMs).toISOString();
      await args.supabase
        .from("customer_trip_notification_deliveries")
        .insert({
          notification_id: args.notificationId,
          trip_id: args.tripId,
          passenger_id: args.passengerId,
          event: TRAFFIC_DELAY_EVENT,
          status: "skipped",
          skipped_reason: "obsolete_trip_state",
          attempts: 1,
          metadata: { source: "scheduled_post_activation_lateness" },
          created_at: nowIso,
          updated_at: nowIso,
        })
        .select("id")
        .maybeSingle();
      return { ok: false, reason: "obsolete" };
    }
    return { ok: false, reason: decision.reason };
  }

  const nowIso = new Date(args.nowMs).toISOString();

  if (decision.action === "insert_new") {
    const { data: inserted, error } = await args.supabase
      .from("customer_trip_notification_deliveries")
      .insert({
        notification_id: args.notificationId,
        trip_id: args.tripId,
        passenger_id: args.passengerId,
        event: TRAFFIC_DELAY_EVENT,
        status: "sending",
        attempts: 1,
        metadata: { source: "scheduled_post_activation_lateness" },
        created_at: nowIso,
        updated_at: nowIso,
      })
      .select("id")
      .maybeSingle();

    if (!error && inserted?.id) {
      return { ok: true, deliveryId: String(inserted.id), mode: "new" };
    }

    const raced = await loadDelivery(args.supabase, args.notificationId);
    if (!raced?.id) return { ok: false, reason: "claim_failed" };
    const racedDecision = decideTrafficDelayClaim({
      existing: { status: raced.status, updatedAtIso: raced.updated_at },
      nowMs: args.nowMs,
      obsolete: args.obsolete,
    });
    if (racedDecision.action !== "reclaim") {
      return {
        ok: false,
        reason: racedDecision.action === "skip"
          ? racedDecision.reason
          : "claim_failed",
      };
    }
    const { data: retried, error: retryErr } = await args.supabase
      .from("customer_trip_notification_deliveries")
      .update({
        status: "sending",
        error_message: null,
        skipped_reason: null,
        attempts: Number(raced.attempts ?? 0) + 1,
        updated_at: nowIso,
      })
      .eq("id", raced.id)
      .in("status", ["failed", "sending"])
      .select("id")
      .maybeSingle();
    if (retryErr || !retried?.id) {
      return { ok: false, reason: "already_terminal" };
    }
    return { ok: true, deliveryId: String(retried.id), mode: "retry" };
  }

  if (!existing?.id) return { ok: false, reason: "claim_failed" };
  const { data: retried, error: retryErr } = await args.supabase
    .from("customer_trip_notification_deliveries")
    .update({
      status: "sending",
      error_message: null,
      skipped_reason: null,
      attempts: Number(existing.attempts ?? 0) + 1,
      updated_at: nowIso,
    })
    .eq("id", existing.id)
    .in("status", ["failed", "sending"])
    .select("id")
    .maybeSingle();

  if (retryErr || !retried?.id) {
    return { ok: false, reason: "already_terminal" };
  }
  return { ok: true, deliveryId: String(retried.id), mode: "retry" };
}

/**
 * One logical traffic_delay heads-up per scheduled booking.
 * Safe across concurrent scheduled-dispatch invocations.
 */
export async function claimAndNotifyScheduledTrafficDelay(
  supabase: SupabaseClient,
  input: {
    tripId: string;
    passengerId: string;
    status: string | null | undefined;
    scheduledStatus?: string | null;
    nowMs?: number;
  },
): Promise<ScheduledTrafficDelayNotifyResult> {
  const tripId = String(input.tripId ?? "").trim();
  const passengerId = String(input.passengerId ?? "").trim();
  if (!tripId || !passengerId) {
    return { status: "claim_failed", reason: "missing_ids" };
  }

  const nowMs = input.nowMs ?? Date.now();
  const notificationId = buildTrafficDelayNotificationId(tripId);
  const obsolete = isScheduledTrafficDelayObsolete({
    status: input.status,
    scheduledStatus: input.scheduledStatus,
  });

  const claim = await claimDelivery({
    supabase,
    notificationId,
    tripId,
    passengerId,
    nowMs,
    obsolete,
  });

  if (!claim.ok) {
    if (claim.reason === "obsolete") {
      return { status: "obsolete", reason: claim.reason };
    }
    if (claim.reason === "already_terminal" || claim.reason === "in_flight") {
      return { status: "already_done", reason: claim.reason };
    }
    return { status: "claim_failed", reason: claim.reason };
  }

  if (
    isScheduledTrafficDelayObsolete({
      status: input.status,
      scheduledStatus: input.scheduledStatus,
    })
  ) {
    await markDelivery(supabase, claim.deliveryId, {
      status: "skipped",
      skipped_reason: "obsolete_after_claim",
    });
    return { status: "obsolete", reason: "obsolete_after_claim" };
  }

  const copy = buildScheduledTrafficDelayCopy({ status: input.status });

  let httpOk = false;
  let sent: number | null = null;
  let reason: string | null = null;
  let threw = false;

  try {
    const outcome = await notifyCustomerTripLifecycle(supabase, {
      passengerId,
      tripId,
      event: TRAFFIC_DELAY_EVENT,
      title: copy.title,
      body: copy.body,
      notificationId,
    });
    httpOk = outcome.httpOk;
    sent = outcome.sent;
    reason = outcome.reason;
  } catch (err) {
    threw = true;
    console.warn("[customerTrafficDelayNotify] notify threw", {
      trip_id: tripId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const settled = resolveTrafficDelayDeliveryOutcome({
    httpOk,
    sent,
    reason,
    throwError: threw,
  });

  const patch: Record<string, unknown> = {
    status: settled.status as TrafficDelayDeliveryStatus,
  };
  if (settled.skippedReason) patch.skipped_reason = settled.skippedReason;
  if (settled.errorMessage) patch.error_message = settled.errorMessage;

  await markDelivery(supabase, claim.deliveryId, patch);

  console.log("[customerTrafficDelayNotify] settled", {
    trip_id: tripId,
    notification_id: notificationId,
    claim_mode: claim.mode,
    status: settled.status,
    skipped_reason: settled.skippedReason ?? null,
    error_message: settled.errorMessage ?? null,
  });

  if (settled.status === "sent") return { status: "sent" };
  if (settled.status === "skipped") {
    return { status: "skipped", reason: settled.skippedReason };
  }
  if (settled.status === "ambiguous") {
    return { status: "ambiguous", reason: settled.errorMessage };
  }
  return { status: "failed", reason: settled.errorMessage };
}
