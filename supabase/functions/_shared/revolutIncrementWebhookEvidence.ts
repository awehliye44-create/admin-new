/**
 * ORDER_INCREMENTAL_AUTHORISATION_{AUTHORISED,DECLINED,FAILED} webhook handling.
 *
 * Evidence / reconciliation only. Revolut's payload carries just
 * { event, order_id, merchant_order_ext_ref }, so the order is retrieved
 * (read-only GET) to capture increment state + reason.
 *
 * Never mutates money: no payment_sessions status/amount writes, no trip
 * writes, no capture, cancel or release. The executeSameOrderIncrement SSOT
 * remains the only writer of increment status.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  revolutProviderAuthorisedTotalPence,
  type RevolutOrder,
} from "./revolutOrders.ts";
import {
  buildIncrementWebhookEventId,
  buildRevolutIncrementProviderEvidence,
  findIncrementForWebhook,
  providerIncrementOutcome,
  sanitizeProviderToken,
  type RevolutIncrementWebhookEvent,
} from "./revolutIncrementEvidenceSSOT.ts";

export type IncrementWebhookOutcome = {
  httpStatus: number;
  body: {
    received: boolean;
    evidence_only: true;
    event: RevolutIncrementWebhookEvent;
    duplicate?: boolean;
    increment_state?: string | null;
    state_matches_event?: boolean;
    reconciled_increment_row?: boolean;
    error?: string;
  };
};

const UNIQUE_VIOLATION = "23505";

function isUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export async function handleRevolutIncrementWebhookEvidence(args: {
  supabase: SupabaseClient;
  eventName: RevolutIncrementWebhookEvent;
  orderId: string | null;
  merchantOrderExtRef: string | null;
  requestTimestamp: string | null;
  retrieveOrder: (orderId: string) => Promise<RevolutOrder>;
  nowIso?: string;
}): Promise<IncrementWebhookOutcome> {
  const nowIso = args.nowIso ?? new Date().toISOString();
  const orderId = String(args.orderId ?? "").trim();
  const base = { received: true, evidence_only: true as const, event: args.eventName };

  if (!orderId) {
    console.warn("[revolut-webhook] increment event without order_id", { event: args.eventName });
    return { httpStatus: 200, body: { ...base, error: "missing_order_id" } };
  }

  const { data: session } = await args.supabase
    .from("payment_sessions")
    .select("id, trip_id")
    .eq("provider_order_id", orderId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const tripId = isUuid(session?.trip_id) ? session!.trip_id as string : null;
  const paymentSessionId = session?.id ? String(session.id) : null;

  let order: RevolutOrder | null = null;
  let retrieveError: string | null = null;
  try {
    order = await args.retrieveOrder(orderId);
  } catch (err) {
    retrieveError = sanitizeProviderToken((err as { message?: unknown })?.message) ?? "retrieve_failed";
  }

  const match = findIncrementForWebhook(order, args.eventName);
  const evidence = buildRevolutIncrementProviderEvidence({
    order,
    evidenceSource: "webhook_retrieve",
    reference: match.entry?.reference ?? null,
    targetTotalPence: match.entry?.new_amount ?? match.entry?.amount ?? null,
    providerAuthorisedTotalPence: order ? revolutProviderAuthorisedTotalPence(order) : null,
    nowIso,
  });

  const eventId = buildIncrementWebhookEventId({
    eventName: args.eventName,
    orderId,
    incrementReference: order ? evidence.increment_reference : null,
    incrementNewAmountPence: order ? evidence.increment_new_amount_pence : null,
    incrementState: order ? evidence.increment_state : null,
    requestTimestamp: args.requestTimestamp,
  });
  // Retrieve lagging behind the webhook: record what was seen, then ask
  // Revolut to redeliver so the settled state + reason are captured.
  const retrieveLagging = !retrieveError
    && !match.stateMatchesEvent
    && providerIncrementOutcome(evidence) === "unsettled";

  const webhookEvidence = {
    event: args.eventName,
    received_at: nowIso,
    state_matches_event: match.stateMatchesEvent,
    retrieve_error: retrieveError,
    ...evidence,
  };

  const { error: insertErr } = await args.supabase
    .from("processed_revolut_events")
    .insert({
      event_id: eventId,
      event_type: args.eventName,
      order_id: orderId,
      trip_id: tripId,
      applied_status: retrieveError ? "evidence_unresolved" : "evidence_only",
      payload: {
        ...webhookEvidence,
        payment_session_id: paymentSessionId,
        merchant_order_ext_ref: sanitizeProviderToken(args.merchantOrderExtRef, 100),
      },
    });

  if (insertErr) {
    if (String((insertErr as { code?: unknown }).code ?? "") === UNIQUE_VIOLATION) {
      if (retrieveError || retrieveLagging) {
        return {
          httpStatus: 503,
          body: {
            ...base,
            received: false,
            duplicate: true,
            error: retrieveError ? "provider_retrieve_failed" : "provider_state_not_settled",
          },
        };
      }
      console.log("[revolut-webhook] increment event duplicate ignored", {
        event: args.eventName,
        event_id: eventId,
      });
      return {
        httpStatus: 200,
        body: {
          ...base,
          duplicate: true,
          increment_state: evidence.increment_state,
          state_matches_event: match.stateMatchesEvent,
        },
      };
    }
    console.error("[revolut-webhook] increment evidence persist failed", {
      event: args.eventName,
      message: insertErr.message,
    });
    // Non-2xx so Revolut redelivers; nothing else was written.
    return { httpStatus: 500, body: { ...base, received: false, error: "evidence_persist_failed" } };
  }

  if (retrieveError || retrieveLagging) {
    // Receipt recorded; ask Revolut to redeliver so the reason can be captured.
    return {
      httpStatus: 503,
      body: {
        ...base,
        received: false,
        increment_state: evidence.increment_state,
        error: retrieveError ? "provider_retrieve_failed" : "provider_state_not_settled",
      },
    };
  }

  let reconciled = false;
  const reference = evidence.increment_reference;
  const newAmount = evidence.increment_new_amount_pence;
  if (paymentSessionId && (reference || newAmount)) {
    let rowQuery = args.supabase
      .from("payment_session_authorisations")
      .select("id, metadata")
      .eq("payment_session_id", paymentSessionId)
      .eq("provider_order_id", orderId);
    rowQuery = reference
      ? rowQuery.eq("idempotency_key", reference)
      : rowQuery.eq("requested_target_total_pence", newAmount);
    const { data: row } = await rowQuery.maybeSingle();
    if (row?.id) {
      const existing = row.metadata && typeof row.metadata === "object"
        ? row.metadata as Record<string, unknown>
        : {};
      const { error: rowErr } = await args.supabase
        .from("payment_session_authorisations")
        .update({ metadata: { ...existing, provider_webhook_evidence: webhookEvidence } })
        .eq("id", row.id);
      reconciled = !rowErr;
      if (rowErr) {
        console.warn("[revolut-webhook] increment row evidence merge failed", {
          event: args.eventName,
          message: rowErr.message,
        });
      }
    }
  }

  const { error: auditErr } = await args.supabase.from("admin_payment_audit").insert({
    action: "revolut_webhook",
    provider: "revolut",
    provider_payment_id: orderId,
    trip_id: tripId,
    metadata: {
      event: args.eventName,
      state: evidence.increment_state,
      applied_status: "evidence_only",
      increment_evidence: webhookEvidence,
    },
  });
  if (auditErr) console.error("[revolut-webhook] audit insert failed:", auditErr.message);

  console.log("[revolut-webhook] increment evidence persisted", {
    event: args.eventName,
    increment_state: evidence.increment_state,
    increment_reason: evidence.increment_reason,
    state_matches_event: match.stateMatchesEvent,
    reconciled_increment_row: reconciled,
  });

  return {
    httpStatus: 200,
    body: {
      ...base,
      duplicate: false,
      increment_state: evidence.increment_state,
      state_matches_event: match.stateMatchesEvent,
      reconciled_increment_row: reconciled,
    },
  };
}
