/**
 * P7 M4 — replay unprocessed WhatsApp inbound messages without waiting for Meta.
 *
 * Candidates: processed_at IS NULL, attempt_count < MAX, received_at older than 2 minutes
 * (and younger than 24h). Each row is claimed with the SAME atomic CAS the webhook uses
 * (`claim_whatsapp_inbound_retry`), so the sweep, a Meta redelivery and a concurrent sweep
 * can never process one message twice. Outcome handling is the shared durable contract:
 * success → markInboundProcessed; thrown error OR send-failure action → recordInboundFailure
 * (never processed_at). Exhausted rows get a durable `WHATSAPP_INBOUND_RETRY_EXHAUSTED` alert.
 */
import { parseWhatsAppWebhookPayload, type WhatsAppInboundMessage } from "../../_shared/whatsappInboundParse.ts";
import { processWhatsAppInboundMessage } from "../../_shared/whatsappWorkflow.ts";
import {
  isInboundAttemptsExhausted,
  isInboundSendFailureAction,
  markInboundProcessed,
  recordInboundExhaustedAlert,
  recordInboundFailure,
  WHATSAPP_INBOUND_CLAIM_RPC,
  WHATSAPP_INBOUND_EXHAUSTED_AUDIT_WINDOW_DAYS,
  WHATSAPP_INBOUND_MAX_ATTEMPTS,
  WHATSAPP_INBOUND_STALE_CLAIM_SECONDS,
  WHATSAPP_INBOUND_SWEEP_MAX_AGE_HOURS,
  WHATSAPP_INBOUND_SWEEP_MIN_AGE_SECONDS,
} from "../../_shared/whatsappInboundDurability.ts";

// deno-lint-ignore no-explicit-any
type ClientLike = any;

export type InboundRow = {
  meta_message_id: string;
  message_type: string | null;
  raw_payload: Record<string, unknown> | null;
  attempt_count: number | null;
  last_error: string | null;
};

export type SweepSummary = {
  scanned: number;
  claimed: number;
  succeeded: number;
  failed: number;
  exhausted_alerts: number;
  skipped_unclaimed: number;
  skipped_unparseable: number;
};

export type SweepDeps = {
  processMessage?: (client: ClientLike, message: WhatsAppInboundMessage) => Promise<string>;
  now?: () => number;
};

/** Rebuild the inbound message from the stored `value` block (raw_payload). */
export function rebuildInboundMessage(row: InboundRow): WhatsAppInboundMessage | null {
  if (!row.raw_payload || typeof row.raw_payload !== "object") return null;
  const parsed = parseWhatsAppWebhookPayload({
    object: "whatsapp_business_account",
    entry: [{ changes: [{ field: "messages", value: row.raw_payload }] }],
  });
  return parsed.messages.find((m) => m.metaMessageId === row.meta_message_id) ?? null;
}

export async function runWhatsAppInboundRetrySweep(args: {
  client: ClientLike;
  limit?: number;
  dryRun?: boolean;
  deps?: SweepDeps;
}): Promise<SweepSummary> {
  const now = args.deps?.now?.() ?? Date.now();
  const process = args.deps?.processMessage ?? processWhatsAppInboundMessage;
  const limit = Math.min(50, Math.max(1, Math.round(Number(args.limit ?? 20))));
  const minAgeIso = new Date(now - WHATSAPP_INBOUND_SWEEP_MIN_AGE_SECONDS * 1000).toISOString();
  const maxAgeIso = new Date(now - WHATSAPP_INBOUND_SWEEP_MAX_AGE_HOURS * 3600 * 1000).toISOString();
  const auditFromIso = new Date(
    now - WHATSAPP_INBOUND_EXHAUSTED_AUDIT_WINDOW_DAYS * 86400 * 1000,
  ).toISOString();

  const summary: SweepSummary = {
    scanned: 0,
    claimed: 0,
    succeeded: 0,
    failed: 0,
    exhausted_alerts: 0,
    skipped_unclaimed: 0,
    skipped_unparseable: 0,
  };

  // 1) Replay retryable rows.
  const { data: candidates, error } = await args.client
    .from("whatsapp_inbound_messages")
    .select("meta_message_id, message_type, raw_payload, attempt_count, last_error")
    .is("processed_at", null)
    .lt("attempt_count", WHATSAPP_INBOUND_MAX_ATTEMPTS)
    .lt("received_at", minAgeIso)
    .gt("received_at", maxAgeIso)
    .order("received_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(`candidate_query_failed: ${error.message}`);

  const rows = (candidates ?? []) as InboundRow[];
  summary.scanned = rows.length;

  if (!args.dryRun) {
    for (const row of rows) {
      const { data: claimRows, error: claimErr } = await args.client.rpc(WHATSAPP_INBOUND_CLAIM_RPC, {
        p_meta_message_id: row.meta_message_id,
        p_max_attempts: WHATSAPP_INBOUND_MAX_ATTEMPTS,
        p_stale_after_seconds: WHATSAPP_INBOUND_STALE_CLAIM_SECONDS,
      });
      if (claimErr) {
        console.error("[whatsapp-inbound-retry-sweep] claim failed", claimErr.message);
        summary.skipped_unclaimed++;
        continue;
      }
      const claimed = Array.isArray(claimRows) ? claimRows[0] : claimRows;
      const attemptCount = Math.round(Number(claimed?.attempt_count ?? 0));
      if (attemptCount <= 0) {
        summary.skipped_unclaimed++;
        continue;
      }
      summary.claimed++;

      const message = rebuildInboundMessage(row);
      if (!message) {
        summary.skipped_unparseable++;
        summary.failed++;
        await recordInboundFailure(
          args.client,
          row.meta_message_id,
          attemptCount,
          new Error("sweep_unparseable_raw_payload"),
          { messageType: row.message_type, source: "whatsapp-inbound-retry-sweep" },
        );
        continue;
      }

      let action: string;
      try {
        action = await process(args.client, message);
      } catch (err) {
        summary.failed++;
        await recordInboundFailure(args.client, row.meta_message_id, attemptCount, err, {
          messageType: row.message_type,
          source: "whatsapp-inbound-retry-sweep",
        });
        continue;
      }
      if (isInboundSendFailureAction(action)) {
        summary.failed++;
        await recordInboundFailure(
          args.client,
          row.meta_message_id,
          attemptCount,
          new Error(`send_failed:${action}`),
          { messageType: row.message_type, source: "whatsapp-inbound-retry-sweep" },
        );
        continue;
      }
      await markInboundProcessed(args.client, row.meta_message_id, action);
      summary.succeeded++;
    }
  }

  // 2) Durable alerts for exhausted rows that never got one (e.g. the final attempt's worker
  //    crashed before recordInboundFailure ran). Idempotent per meta_message_id.
  const { data: exhausted } = await args.client
    .from("whatsapp_inbound_messages")
    .select("meta_message_id, message_type, attempt_count, last_error")
    .is("processed_at", null)
    .gte("attempt_count", WHATSAPP_INBOUND_MAX_ATTEMPTS)
    .lt("received_at", minAgeIso)
    .gt("received_at", auditFromIso)
    .order("received_at", { ascending: true })
    .limit(50);
  for (const row of (exhausted ?? []) as InboundRow[]) {
    if (!isInboundAttemptsExhausted(Number(row.attempt_count ?? 0))) continue;
    if (args.dryRun) {
      summary.exhausted_alerts++;
      continue;
    }
    await recordInboundExhaustedAlert(args.client, {
      metaMessageId: row.meta_message_id,
      attemptCount: Math.round(Number(row.attempt_count ?? 0)),
      lastError: row.last_error,
      messageType: row.message_type,
      source: "whatsapp-inbound-retry-sweep",
    });
    summary.exhausted_alerts++;
  }

  return summary;
}
