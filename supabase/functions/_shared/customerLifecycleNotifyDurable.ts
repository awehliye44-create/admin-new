/**
 * SN1 — Durable Customer lifecycle notify: persist intent + async deliver + sweep.
 *
 * Intent INSERT (pending) is on the HTTP / cron commit path.
 * Provider send stays background / waitUntil / cron reclaim.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { notifyCustomerTripLifecycle } from "./customerTripLifecycleNotify.ts";
import {
  buildSn1NotificationId,
  decideLifecycleIntentPersist,
  decideLifecycleSendLease,
  isSn1LifecycleNotifyObsolete,
  resolveLifecycleDeliveryOutcome,
  scheduledBookingConfirmedCopy,
  scheduledConvertedToInstantCopy,
  sn1KindFromNotificationId,
  type Sn1LifecycleKind,
  type TripStaleSnapshot,
} from "./customerLifecycleNotifyDurableSSOT.ts";

type DeliveryRow = {
  id: string;
  status: string;
  updated_at: string;
  attempts?: number | null;
  passenger_id?: string | null;
  trip_id?: string | null;
  event?: string | null;
  notification_id?: string;
  metadata?: Record<string, unknown> | null;
};

async function loadDelivery(
  supabase: SupabaseClient,
  notificationId: string,
): Promise<DeliveryRow | null> {
  const { data } = await supabase
    .from("customer_trip_notification_deliveries")
    .select(
      "id, status, updated_at, attempts, passenger_id, trip_id, event, notification_id, metadata",
    )
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

function eventForKind(kind: Sn1LifecycleKind): string {
  switch (kind) {
    case "scheduled_booking_confirmed":
      return "scheduled_booking_confirmed";
    case "scheduled_accept":
      return "driver_assigned";
    case "scheduled_converted_to_instant":
      return "finding_another_driver_updated_fare";
    case "scheduled_cancel_rematch":
      return "driver_cancelled";
  }
}

export type PersistLifecycleIntentResult =
  | { ok: true; notificationId: string; deliveryId: string; mode: "new" | "existing" }
  | { ok: false; reason: string; notificationId: string };

/**
 * Durable intent — call on authoritative lifecycle path before HTTP 200.
 * Does not call FCM/APNs.
 */
export async function persistCustomerLifecycleNotifyIntent(
  supabase: SupabaseClient,
  input: {
    kind: Sn1LifecycleKind;
    tripId: string;
    passengerId: string;
    confirmedDriverId?: string | null;
    scheduledAt?: string | null;
    convertedToInstant?: boolean;
    source: string;
    nowMs?: number;
  },
): Promise<PersistLifecycleIntentResult> {
  const tripId = String(input.tripId ?? "").trim();
  const passengerId = String(input.passengerId ?? "").trim();
  const notificationId = buildSn1NotificationId(input.kind, tripId);
  if (!tripId || !passengerId) {
    return { ok: false, reason: "missing_ids", notificationId };
  }

  const existing = await loadDelivery(supabase, notificationId);
  const decision = decideLifecycleIntentPersist({
    existing: existing
      ? { status: existing.status, attempts: existing.attempts }
      : null,
  });
  if (decision.action === "already_durable" && existing?.id) {
    return {
      ok: true,
      notificationId,
      deliveryId: existing.id,
      mode: "existing",
    };
  }

  const nowIso = new Date(input.nowMs ?? Date.now()).toISOString();
  const metadata: Record<string, unknown> = {
    source: input.source,
    sn1_kind: input.kind,
    delivery_confirmation: "not_device_heads_up",
  };
  if (input.confirmedDriverId) {
    metadata.confirmed_driver_id = input.confirmedDriverId;
  }
  if (input.scheduledAt) metadata.scheduled_at = input.scheduledAt;
  if (input.convertedToInstant != null) {
    metadata.converted_to_instant = input.convertedToInstant;
  }

  const { data: inserted, error } = await supabase
    .from("customer_trip_notification_deliveries")
    .insert({
      notification_id: notificationId,
      trip_id: tripId,
      passenger_id: passengerId,
      event: eventForKind(input.kind),
      status: "pending",
      attempts: 0,
      metadata,
      created_at: nowIso,
      updated_at: nowIso,
    })
    .select("id")
    .maybeSingle();

  if (!error && inserted?.id) {
    return {
      ok: true,
      notificationId,
      deliveryId: String(inserted.id),
      mode: "new",
    };
  }

  const raced = await loadDelivery(supabase, notificationId);
  if (raced?.id) {
    return {
      ok: true,
      notificationId,
      deliveryId: raced.id,
      mode: "existing",
    };
  }
  return { ok: false, reason: error?.message ?? "insert_failed", notificationId };
}

async function loadTripSnapshot(
  supabase: SupabaseClient,
  tripId: string,
): Promise<TripStaleSnapshot | null> {
  const { data } = await supabase
    .from("trips")
    .select(
      "status, scheduled_status, confirmed_driver_id, driver_id, passenger_id, scheduled_at",
    )
    .eq("id", tripId)
    .maybeSingle();
  if (!data) return null;
  return {
    status: data.status,
    scheduledStatus: data.scheduled_status,
    confirmedDriverId: data.confirmed_driver_id,
    driverId: data.driver_id,
    passengerId: data.passenger_id,
  };
}

export type DeliverLifecycleResult =
  | { status: "sent" | "skipped" | "failed" | "ambiguous"; reason?: string }
  | { status: "already_done"; reason: string }
  | { status: "obsolete"; reason: string }
  | { status: "claim_failed"; reason: string };

/**
 * Lease pending/failed/stale-sending → anti-stale → notify → settle ledger.
 */
export async function deliverCustomerLifecycleNotify(
  supabase: SupabaseClient,
  input: {
    notificationId: string;
    title?: string;
    body?: string;
    path?: string;
    driverName?: string;
    nowMs?: number;
  },
): Promise<DeliverLifecycleResult> {
  const notificationId = String(input.notificationId ?? "").trim();
  const kind = sn1KindFromNotificationId(notificationId);
  if (!kind) {
    return { status: "claim_failed", reason: "unknown_sn1_id" };
  }

  const nowMs = input.nowMs ?? Date.now();
  let row = await loadDelivery(supabase, notificationId);
  if (!row?.id) {
    return { status: "claim_failed", reason: "missing_claim" };
  }

  const lease = decideLifecycleSendLease({
    existing: {
      status: row.status,
      updatedAtIso: row.updated_at,
      attempts: row.attempts,
    },
    nowMs,
  });

  if (lease.action === "skip") {
    if (lease.reason === "already_terminal" || lease.reason === "in_flight") {
      return { status: "already_done", reason: lease.reason };
    }
    return { status: "claim_failed", reason: lease.reason };
  }

  if (lease.action === "lease_sending") {
    const nowIso = new Date(nowMs).toISOString();
    const { data: leased, error } = await supabase
      .from("customer_trip_notification_deliveries")
      .update({
        status: "sending",
        error_message: null,
        skipped_reason: null,
        attempts: Number(row.attempts ?? 0) + 1,
        updated_at: nowIso,
      })
      .eq("id", row.id)
      .in("status", ["pending", "failed", "sending"])
      .select("id, status, updated_at, attempts, passenger_id, trip_id, metadata")
      .maybeSingle();
    if (error || !leased?.id) {
      return { status: "already_done", reason: "lease_lost" };
    }
    row = { ...row, ...leased } as DeliveryRow;
  }

  const tripId = String(row.trip_id ?? "").trim();
  const passengerId = String(row.passenger_id ?? "").trim();
  if (!tripId || !passengerId) {
    await markDelivery(supabase, row.id, {
      status: "skipped",
      skipped_reason: "missing_trip_passenger",
    });
    return { status: "obsolete", reason: "missing_trip_passenger" };
  }

  const trip = await loadTripSnapshot(supabase, tripId);
  if (!trip) {
    await markDelivery(supabase, row.id, {
      status: "skipped",
      skipped_reason: "trip_missing",
    });
    return { status: "obsolete", reason: "trip_missing" };
  }

  const meta = (row.metadata && typeof row.metadata === "object")
    ? row.metadata as Record<string, unknown>
    : {};
  const claimedDriver = typeof meta.confirmed_driver_id === "string"
    ? meta.confirmed_driver_id
    : null;

  const stale = isSn1LifecycleNotifyObsolete({
    kind,
    trip,
    claimedPassengerId: passengerId,
    claimedConfirmedDriverId: claimedDriver,
  });
  if (stale.obsolete) {
    await markDelivery(supabase, row.id, {
      status: "skipped",
      skipped_reason: stale.reason ?? "obsolete",
      metadata: { ...meta, stale_suppressed: true, stale_reason: stale.reason },
    });
    return { status: "obsolete", reason: stale.reason ?? "obsolete" };
  }

  let title = input.title;
  let body = input.body;
  let path = input.path;
  if (kind === "scheduled_booking_confirmed") {
    const copy = scheduledBookingConfirmedCopy(
      typeof meta.scheduled_at === "string" ? meta.scheduled_at : null,
    );
    title = title ?? copy.title;
    body = body ?? copy.body;
    path = path ?? "/account/rides";
  } else if (kind === "scheduled_converted_to_instant") {
    const copy = scheduledConvertedToInstantCopy();
    title = title ?? copy.title;
    body = body ?? copy.body;
    path = path ?? "/booking/finding-drivers";
  } else if (kind === "scheduled_accept") {
    path = path ?? "/account/rides";
  }

  let httpOk = false;
  let sent: number | null = null;
  let reason: string | null = null;
  let threw = false;
  try {
    const outcome = await notifyCustomerTripLifecycle(supabase, {
      passengerId,
      tripId,
      event: eventForKind(kind),
      title,
      body,
      driverName: input.driverName,
      notificationId,
      path,
    });
    httpOk = outcome.httpOk;
    sent = outcome.sent;
    reason = outcome.reason;
  } catch (err) {
    threw = true;
    console.warn("[sn1] deliver threw", {
      notification_id: notificationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const settled = resolveLifecycleDeliveryOutcome({
    httpOk,
    sent,
    reason,
    throwError: threw,
  });
  const patch: Record<string, unknown> = { status: settled.status };
  if (settled.skippedReason) patch.skipped_reason = settled.skippedReason;
  if (settled.errorMessage) patch.error_message = settled.errorMessage;
  // Never invent device heads-up proof from provider accept.
  patch.metadata = {
    ...meta,
    provider_sent_count: sent,
    provider_reason: reason,
    delivery_confirmation: "provider_accept_only",
  };
  await markDelivery(supabase, row.id, patch);

  console.log("[sn1] lifecycle_notify_settled", {
    notification_id: notificationId,
    kind,
    trip_id: tripId,
    status: settled.status,
    skipped_reason: settled.skippedReason ?? null,
    // no token values
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

/** Convenience: deliver by kind after intent already persisted. */
export async function deliverCustomerLifecycleNotifyByKind(
  supabase: SupabaseClient,
  input: {
    kind: Sn1LifecycleKind;
    tripId: string;
    title?: string;
    body?: string;
    path?: string;
    driverName?: string;
  },
): Promise<DeliverLifecycleResult> {
  return deliverCustomerLifecycleNotify(supabase, {
    notificationId: buildSn1NotificationId(input.kind, input.tripId),
    title: input.title,
    body: input.body,
    path: input.path,
    driverName: input.driverName,
  });
}

/**
 * Durable recovery: insert missing pending intents from trip state, then
 * reclaim pending / stale sending / failed SN1 rows. Ambiguous stays terminal
 * (observable only — no blind retry / spam).
 * Bounded batch — Shared CPU safe.
 */
export async function reclaimPendingCustomerLifecycleNotifies(
  supabase: SupabaseClient,
  input?: { limit?: number; nowMs?: number },
): Promise<{
  scanned: number;
  delivered: number;
  skipped: number;
  failed: number;
  reconcile?: Record<string, unknown> | null;
  ambiguous_observed?: number;
}> {
  const limit = Math.max(1, Math.min(40, input?.limit ?? 20));

  let reconcile: Record<string, unknown> | null = null;
  try {
    const { data: recon } = await supabase.rpc(
      "sn1_reconcile_missing_lifecycle_intents",
      { p_limit: limit },
    );
    if (recon && typeof recon === "object") {
      reconcile = recon as Record<string, unknown>;
    }
  } catch (err) {
    console.warn(
      "[sn1] reconcile_missing_lifecycle_intents failed",
      err instanceof Error ? err.message : String(err),
    );
  }

  // Observable ambiguous outcomes — never re-lease / re-send.
  let ambiguousObserved = 0;
  try {
    const { data: ambRows, count } = await supabase
      .from("customer_trip_notification_deliveries")
      .select("notification_id", { count: "exact", head: false })
      .eq("status", "ambiguous")
      .order("updated_at", { ascending: false })
      .limit(20);
    ambiguousObserved = typeof count === "number"
      ? count
      : (Array.isArray(ambRows) ? ambRows.length : 0);
    if (ambiguousObserved > 0) {
      console.warn("[sn1] ambiguous_lifecycle_deliveries_observed", {
        count: ambiguousObserved,
        sample_ids: (Array.isArray(ambRows) ? ambRows : [])
          .slice(0, 5)
          .map((r) => String((r as { notification_id?: string }).notification_id ?? ""))
          .filter(Boolean),
      });
    }
  } catch {
    // observability only
  }

  // Fetch a wider pending/sending/failed window, then filter SN1 ids in-process
  // (PostgREST OR+LIKE on mixed prefixes is fragile).
  const { data: rows } = await supabase
    .from("customer_trip_notification_deliveries")
    .select("notification_id, status, updated_at, event")
    .in("status", ["pending", "sending", "failed"])
    .order("updated_at", { ascending: true })
    .limit(Math.min(100, limit * 5));

  let delivered = 0;
  let skipped = 0;
  let failed = 0;
  const list = (Array.isArray(rows) ? rows : [])
    .filter((row) =>
      sn1KindFromNotificationId(
        String((row as { notification_id?: string }).notification_id ?? ""),
      ) != null
    )
    .slice(0, limit);
  for (const row of list) {
    const id = String((row as { notification_id?: string }).notification_id ?? "");
    if (!sn1KindFromNotificationId(id)) continue;
    const result = await deliverCustomerLifecycleNotify(supabase, {
      notificationId: id,
      nowMs: input?.nowMs,
    });
    if (result.status === "sent") delivered++;
    else if (result.status === "failed") failed++;
    else skipped++;
  }
  return {
    scanned: list.length,
    delivered,
    skipped,
    failed,
    reconcile,
    ambiguous_observed: ambiguousObserved,
  };
}
