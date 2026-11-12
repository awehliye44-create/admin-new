/**
 * Persist / refresh Revolut capture_deadline onto payment_sessions.
 * Never invent a universal authorisation TTL. Never overwrite valid with NULL.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  mergeCaptureDeadlinePersistence,
  parseCaptureDeadlineIso,
  type CaptureDeadlineSource,
} from "./scheduledCaptureCoverageSSOT.ts";
import type { RevolutOrder } from "./revolutOrders.ts";

export function extractCaptureDeadlineFromRevolutOrder(
  order: RevolutOrder | Record<string, unknown> | null | undefined,
): string | null {
  if (!order || typeof order !== "object") return null;
  const o = order as Record<string, unknown>;
  const direct = parseCaptureDeadlineIso(
    (o.capture_deadline as string | null | undefined) ??
      (o.captureDeadline as string | null | undefined) ??
      null,
  );
  if (direct) return direct;

  const payments = o.payments;
  if (Array.isArray(payments)) {
    for (const p of payments) {
      if (!p || typeof p !== "object") continue;
      const pr = p as Record<string, unknown>;
      const fromPayment = parseCaptureDeadlineIso(
        (pr.capture_deadline as string | null | undefined) ??
          (pr.captureDeadline as string | null | undefined) ??
          null,
      );
      if (fromPayment) return fromPayment;
    }
  }
  return null;
}

export async function persistCaptureDeadlineOnSession(
  supabase: SupabaseClient,
  args: {
    sessionId?: string | null;
    clientActionId?: string | null;
    providerOrderId?: string | null;
    providerDeadlineRaw: string | null | undefined;
    source: CaptureDeadlineSource;
  },
): Promise<{ captureDeadlineIso: string | null; changed: boolean }> {
  const filter = args.sessionId
    ? { id: args.sessionId }
    : args.clientActionId
    ? { client_action_id: args.clientActionId }
    : args.providerOrderId
    ? { provider_order_id: args.providerOrderId }
    : null;
  if (!filter) {
    return { captureDeadlineIso: parseCaptureDeadlineIso(args.providerDeadlineRaw), changed: false };
  }

  let q = supabase
    .from("payment_sessions")
    .select("id, capture_deadline, provider_order_id")
    .limit(1);
  if ("id" in filter) q = q.eq("id", filter.id);
  else if ("client_action_id" in filter) q = q.eq("client_action_id", filter.client_action_id);
  else q = q.eq("provider_order_id", filter.provider_order_id);

  const { data: row } = await q.maybeSingle();
  if (!row?.id) {
    return { captureDeadlineIso: parseCaptureDeadlineIso(args.providerDeadlineRaw), changed: false };
  }

  const merged = mergeCaptureDeadlinePersistence({
    existingDeadlineIso: (row as { capture_deadline?: string | null }).capture_deadline ?? null,
    providerDeadlineRaw: args.providerDeadlineRaw,
    source: args.source,
  });

  if (!merged.changed && merged.captureDeadlineIso) {
    return { captureDeadlineIso: merged.captureDeadlineIso, changed: false };
  }
  if (!merged.captureDeadlineIso) {
    return { captureDeadlineIso: null, changed: false };
  }

  if (args.providerOrderId) {
    const existingOrder = String((row as { provider_order_id?: string | null }).provider_order_id ?? "");
    if (existingOrder && existingOrder !== String(args.providerOrderId)) {
      return { captureDeadlineIso: merged.captureDeadlineIso, changed: false };
    }
  }

  const { error } = await supabase
    .from("payment_sessions")
    .update({
      capture_deadline: merged.captureDeadlineIso,
      capture_deadline_source: merged.source,
      capture_deadline_updated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id);
  if (error) {
    console.warn("[captureDeadlinePersistence] update failed", error.message);
    return { captureDeadlineIso: merged.captureDeadlineIso, changed: false };
  }
  return { captureDeadlineIso: merged.captureDeadlineIso, changed: true };
}

export async function persistCaptureDeadlineFromOrder(
  supabase: SupabaseClient,
  args: {
    order: RevolutOrder | Record<string, unknown> | null | undefined;
    sessionId?: string | null;
    clientActionId?: string | null;
    providerOrderId?: string | null;
    source: CaptureDeadlineSource;
  },
): Promise<{ captureDeadlineIso: string | null; changed: boolean }> {
  const deadline = extractCaptureDeadlineFromRevolutOrder(args.order);
  return persistCaptureDeadlineOnSession(supabase, {
    sessionId: args.sessionId,
    clientActionId: args.clientActionId,
    providerOrderId: args.providerOrderId ??
      (args.order && typeof args.order === "object"
        ? String((args.order as { id?: string }).id ?? "") || null
        : null),
    providerDeadlineRaw: deadline,
    source: args.source,
  });
}
