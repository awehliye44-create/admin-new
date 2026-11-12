/**
 * Persist / refresh Revolut capture_deadline onto payment_sessions.
 * Never invent a universal authorisation TTL. Never overwrite valid with NULL.
 * Freshness is driven by observation time — not by picking the maximum deadline.
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
    /** When this provider observation was obtained (retrieve/webhook time). */
    observedAtIso?: string | null;
  },
): Promise<{
  captureDeadlineIso: string | null;
  changed: boolean;
  needsAuthoritativeRetrieve: boolean;
}> {
  const filter = args.sessionId
    ? { id: args.sessionId }
    : args.clientActionId
    ? { client_action_id: args.clientActionId }
    : args.providerOrderId
    ? { provider_order_id: args.providerOrderId }
    : null;
  if (!filter) {
    return {
      captureDeadlineIso: parseCaptureDeadlineIso(args.providerDeadlineRaw),
      changed: false,
      needsAuthoritativeRetrieve: false,
    };
  }

  let q = supabase
    .from("payment_sessions")
    .select("id, capture_deadline, capture_deadline_observed_at, provider_order_id, trip_id")
    .limit(1);
  if ("id" in filter) q = q.eq("id", filter.id);
  else if ("client_action_id" in filter) q = q.eq("client_action_id", filter.client_action_id);
  else q = q.eq("provider_order_id", filter.provider_order_id);

  const { data: row } = await q.maybeSingle();
  if (!row?.id) {
    return {
      captureDeadlineIso: parseCaptureDeadlineIso(args.providerDeadlineRaw),
      changed: false,
      needsAuthoritativeRetrieve: false,
    };
  }

  const observedNow = args.observedAtIso ?? new Date().toISOString();
  const merged = mergeCaptureDeadlinePersistence({
    existingDeadlineIso: (row as { capture_deadline?: string | null }).capture_deadline ?? null,
    existingObservedAtIso:
      (row as { capture_deadline_observed_at?: string | null }).capture_deadline_observed_at ?? null,
    providerDeadlineRaw: args.providerDeadlineRaw,
    providerObservedAtIso: args.providerDeadlineRaw ? observedNow : null,
    source: args.source,
  });

  if (merged.needsAuthoritativeRetrieve) {
    return {
      captureDeadlineIso: merged.captureDeadlineIso,
      changed: false,
      needsAuthoritativeRetrieve: true,
    };
  }

  if (!merged.changed) {
    return {
      captureDeadlineIso: merged.captureDeadlineIso,
      changed: false,
      needsAuthoritativeRetrieve: false,
    };
  }
  if (!merged.captureDeadlineIso) {
    return { captureDeadlineIso: null, changed: false, needsAuthoritativeRetrieve: false };
  }

  if (args.providerOrderId) {
    const existingOrder = String((row as { provider_order_id?: string | null }).provider_order_id ?? "");
    if (existingOrder && existingOrder !== String(args.providerOrderId)) {
      return {
        captureDeadlineIso: merged.captureDeadlineIso,
        changed: false,
        needsAuthoritativeRetrieve: false,
      };
    }
  }

  const patch: Record<string, unknown> = {
    capture_deadline: merged.captureDeadlineIso,
    capture_deadline_source: merged.source,
    capture_deadline_updated_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (merged.observedAtIso) {
    patch.capture_deadline_observed_at = merged.observedAtIso;
  }

  const { error } = await supabase
    .from("payment_sessions")
    .update(patch)
    .eq("id", row.id);
  if (error) {
    console.warn("[captureDeadlinePersistence] update failed", error.message);
    return {
      captureDeadlineIso: merged.captureDeadlineIso,
      changed: false,
      needsAuthoritativeRetrieve: false,
    };
  }

  // After an authoritative shortening, re-check coverage for any bound scheduled trip.
  if (merged.reason === "authoritative_deadline_shortened" && row.trip_id) {
    try {
      const { data: trip } = await supabase
        .from("trips")
        .select("id, scheduled_at, estimated_duration_minutes, is_scheduled, started_at, status")
        .eq("id", row.trip_id)
        .maybeSingle();
      if (
        trip?.scheduled_at &&
        !trip.started_at &&
        (trip.is_scheduled || trip.scheduled_at)
      ) {
        const { evaluateCaptureDeadlineCoverage } = await import("./scheduledCaptureCoverageSSOT.ts");
        const coverage = evaluateCaptureDeadlineCoverage({
          scheduledAtIso: String(trip.scheduled_at),
          estimatedDurationMinutes: Number(trip.estimated_duration_minutes ?? 30),
          captureDeadlineIso: merged.captureDeadlineIso,
          session: {
            capture_deadline: merged.captureDeadlineIso,
            provider_state: "AUTHORISED",
            status: "authorised",
            trip_id: String(row.trip_id),
          },
          expectedTripId: String(row.trip_id),
        });
        if (!coverage.covered && coverage.definitive) {
          await supabase
            .from("trips")
            .update({
              scheduled_status: "payment_gate_blocked",
              updated_at: new Date().toISOString(),
            })
            .eq("id", row.trip_id)
            .is("started_at", null);
        }
      }
    } catch (reevalErr) {
      console.warn("[captureDeadlinePersistence] coverage re-eval failed", reevalErr);
    }
  }

  return {
    captureDeadlineIso: merged.captureDeadlineIso,
    changed: true,
    needsAuthoritativeRetrieve: false,
  };
}

export async function persistCaptureDeadlineFromOrder(
  supabase: SupabaseClient,
  args: {
    order: RevolutOrder | Record<string, unknown> | null | undefined;
    sessionId?: string | null;
    clientActionId?: string | null;
    providerOrderId?: string | null;
    source: CaptureDeadlineSource;
    observedAtIso?: string | null;
  },
): Promise<{
  captureDeadlineIso: string | null;
  changed: boolean;
  needsAuthoritativeRetrieve: boolean;
}> {
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
    observedAtIso: args.observedAtIso ?? new Date().toISOString(),
  });
}
