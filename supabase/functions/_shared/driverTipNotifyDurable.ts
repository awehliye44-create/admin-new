/**
 * DT1 — Durable Driver tip-received notify: lease + async deliver + reclaim.
 * Intent is created by SQL trigger on DRIVER_TIP_CREDIT insert (same txn).
 * This module never invents historical tip notifications.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  buildDriverTipNotificationId,
  decideDriverTipSendLease,
  driverTipReceivedCopy,
  isDriverTipNotificationId,
  isDriverTipNotifyObsolete,
  resolveDriverTipDeliveryOutcome,
  walletTipDeepLinkPath,
} from "./driverTipNotifyDurableSSOT.ts";

type DeliveryRow = {
  id: string;
  status: string;
  updated_at: string;
  attempts?: number | null;
  driver_id: string;
  ledger_id: string;
  trip_id?: string | null;
  tip_pence: number;
  notification_id: string;
  metadata?: Record<string, unknown> | null;
};

async function loadByNotificationId(
  supabase: SupabaseClient,
  notificationId: string,
): Promise<DeliveryRow | null> {
  const { data } = await supabase
    .from("driver_tip_notification_deliveries")
    .select(
      "id, status, updated_at, attempts, driver_id, ledger_id, trip_id, tip_pence, notification_id, metadata",
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
    .from("driver_tip_notification_deliveries")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", deliveryId);
}

export type DeliverDriverTipResult =
  | { status: "sent" | "skipped" | "failed" | "ambiguous"; reason?: string }
  | { status: "already_done"; reason: string }
  | { status: "obsolete"; reason: string }
  | { status: "claim_failed"; reason: string }
  | { status: "missing"; reason: string };

/**
 * Lease pending/failed/stale-sending → anti-stale → send-driver-notification → settle.
 */
export async function deliverDriverTipReceivedNotify(
  supabase: SupabaseClient,
  input: { notificationId: string; nowMs?: number },
): Promise<DeliverDriverTipResult> {
  const notificationId = String(input.notificationId ?? "").trim();
  if (!isDriverTipNotificationId(notificationId)) {
    return { status: "missing", reason: "not_dt1_id" };
  }

  const nowMs = input.nowMs ?? Date.now();
  let row = await loadByNotificationId(supabase, notificationId);
  if (!row) return { status: "missing", reason: "no_claim" };

  const lease = decideDriverTipSendLease({
    existing: {
      status: row.status,
      updatedAtIso: row.updated_at,
      attempts: row.attempts,
    },
    nowMs,
  });
  if (lease.action === "skip") {
    return { status: "already_done", reason: lease.reason };
  }

  const attempts = Number(row.attempts ?? 0) + 1;
  const { data: leased, error: leaseErr } = await supabase
    .from("driver_tip_notification_deliveries")
    .update({
      status: "sending",
      attempts,
      updated_at: new Date(nowMs).toISOString(),
    })
    .eq("id", row.id)
    .in("status", ["pending", "failed", "sending"])
    .select("id, status, updated_at, attempts, driver_id, ledger_id, trip_id, tip_pence, notification_id, metadata")
    .maybeSingle();
  if (leaseErr || !leased?.id) {
    return { status: "claim_failed", reason: "lease_lost" };
  }
  row = leased as DeliveryRow;

  const { data: ledger } = await supabase
    .from("driver_wallet_ledger")
    .select("id, type, driver_id, amount_pence")
    .eq("id", row.ledger_id)
    .maybeSingle();

  const stale = isDriverTipNotifyObsolete({
    ledger: ledger
      ? {
        id: ledger.id,
        type: ledger.type,
        driverId: ledger.driver_id,
        amountPence: ledger.amount_pence,
      }
      : null,
    claimedDriverId: row.driver_id,
    claimedLedgerId: row.ledger_id,
  });
  if (stale.obsolete) {
    await markDelivery(supabase, row.id, {
      status: "skipped",
      skipped_reason: stale.reason ?? "obsolete",
      metadata: {
        ...(row.metadata && typeof row.metadata === "object" ? row.metadata : {}),
        stale_suppressed: true,
        stale_reason: stale.reason,
      },
    });
    return { status: "obsolete", reason: stale.reason ?? "obsolete" };
  }

  const tipPence = Math.max(
    0,
    Math.round(Number(row.tip_pence) || Number(ledger?.amount_pence) || 0),
  );
  const copy = driverTipReceivedCopy(tipPence);
  const path = walletTipDeepLinkPath(row.ledger_id);
  const meta = (row.metadata && typeof row.metadata === "object")
    ? row.metadata as Record<string, unknown>
    : {};

  let httpOk = false;
  let sent: number | null = null;
  let reason: string | null = null;
  let threw = false;
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const res = await fetch(`${supabaseUrl}/functions/v1/send-driver-notification`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        apikey: serviceKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        driverId: row.driver_id,
        type: "DRIVER_TIP_RECEIVED",
        title: copy.title,
        body: copy.body,
        data: {
          type: "driver_tip_received",
          event: "driver_tip_received",
          ledger_id: row.ledger_id,
          trip_id: row.trip_id ? String(row.trip_id) : "",
          tip_pence: String(tipPence),
          path,
          screen: "wallet",
        },
      }),
    });
    httpOk = res.ok;
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (typeof body.sent === "number") sent = body.sent;
    if (typeof body.reason === "string") reason = body.reason;
    if (!httpOk && typeof body.error === "string") {
      reason = String(body.error);
    }
    // NO_TOKENS is a skippable outcome — not a hard deliver failure.
    if (
      res.status === 404 &&
      (String(body.error ?? "").toUpperCase() === "NO_TOKENS" ||
        String(reason ?? "").toLowerCase().includes("token"))
    ) {
      reason = "no_tokens";
      httpOk = true;
      sent = 0;
    }
  } catch (err) {
    threw = true;
    console.warn("[dt1] deliver threw", {
      notification_id: notificationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const settled = resolveDriverTipDeliveryOutcome({
    httpOk,
    sent,
    reason,
    throwError: threw,
  });
  await markDelivery(supabase, row.id, {
    status: settled.status,
    skipped_reason: settled.skippedReason ?? null,
    error_message: settled.errorMessage ?? null,
    metadata: {
      ...meta,
      provider_sent_count: sent,
      provider_reason: reason,
      delivery_confirmation: "provider_accept_only",
      path,
    },
  });

  console.log("[dt1] tip_notify_settled", {
    notification_id: notificationId,
    ledger_id: row.ledger_id,
    status: settled.status,
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

export async function deliverDriverTipReceivedByLedgerId(
  supabase: SupabaseClient,
  ledgerId: string,
): Promise<DeliverDriverTipResult> {
  return deliverDriverTipReceivedNotify(supabase, {
    notificationId: buildDriverTipNotificationId(ledgerId),
  });
}

/** After tip credit: kick async deliver for this trip's tip ledger (if any). */
export async function kickDriverTipReceivedDeliverForTrip(
  supabase: SupabaseClient,
  tripId: string,
): Promise<DeliverDriverTipResult | { status: "noop"; reason: string }> {
  const id = String(tripId ?? "").trim();
  if (!id) return { status: "noop", reason: "missing_trip" };

  const { data: tipRow } = await supabase
    .from("driver_wallet_ledger")
    .select("id")
    .eq("related_trip_id", id)
    .eq("type", "DRIVER_TIP_CREDIT")
    .maybeSingle();
  if (!tipRow?.id) return { status: "noop", reason: "no_tip_credit" };

  return deliverDriverTipReceivedByLedgerId(supabase, String(tipRow.id));
}

/**
 * Reclaim pending/sending/failed tip notifies. Never synthesises historical tips.
 * Ambiguous stays terminal — observed only.
 */
export async function reclaimPendingDriverTipNotifies(
  supabase: SupabaseClient,
  input?: { limit?: number; nowMs?: number },
): Promise<{
  scanned: number;
  delivered: number;
  skipped: number;
  failed: number;
  ambiguous_observed: number;
}> {
  const limit = Math.max(1, Math.min(40, input?.limit ?? 20));

  let ambiguousObserved = 0;
  try {
    const { count } = await supabase
      .from("driver_tip_notification_deliveries")
      .select("id", { count: "exact", head: true })
      .eq("status", "ambiguous");
    ambiguousObserved = typeof count === "number" ? count : 0;
    if (ambiguousObserved > 0) {
      console.warn("[dt1] ambiguous_tip_deliveries_observed", {
        count: ambiguousObserved,
      });
    }
  } catch {
    // observability only
  }

  const { data: rows } = await supabase
    .from("driver_tip_notification_deliveries")
    .select("notification_id, status, updated_at")
    .in("status", ["pending", "sending", "failed"])
    .order("updated_at", { ascending: true })
    .limit(limit);

  let delivered = 0;
  let skipped = 0;
  let failed = 0;
  const list = Array.isArray(rows) ? rows : [];
  for (const row of list) {
    const id = String((row as { notification_id?: string }).notification_id ?? "");
    if (!isDriverTipNotificationId(id)) continue;
    const result = await deliverDriverTipReceivedNotify(supabase, {
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
    ambiguous_observed: ambiguousObserved,
  };
}
