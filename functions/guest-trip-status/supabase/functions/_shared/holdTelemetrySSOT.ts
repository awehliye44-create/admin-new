/**
 * Unified hold lifecycle telemetry — server-side admin_payment_audit + console.
 * HOLD_RECONCILIATION_RED emails are gated: per-incident email only when
 * `sendAdminEmail: true` AND the incident requires human action. Prefer
 * grouped summary emails from the sweep scanner.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  shouldEmailHoldReconciliationIncident,
  type PaymentHoldAttentionClass,
  type PaymentHoldClassification,
  type CanonicalProviderHoldState,
} from "../../../shared/paymentHoldClassificationSSOT.ts";

export type HoldTelemetryEvent =
  | "HOLD_AUTHORISED"
  | "HOLD_LINKED_TO_TRIP"
  | "HOLD_ORPHAN_DETECTED"
  | "HOLD_RECOVERY_STARTED"
  | "HOLD_RECOVERY_SUCCEEDED"
  | "HOLD_RECOVERY_FAILED"
  | "HOLD_RELEASE_REQUESTED"
  | "HOLD_RELEASE_SUCCEEDED"
  | "HOLD_RELEASE_FAILED"
  | "HOLD_RECONCILIATION_RED";

export async function emitHoldTelemetry(
  supabase: SupabaseClient,
  event: HoldTelemetryEvent,
  detail: {
    tripId?: string | null;
    paymentSessionId?: string | null;
    providerOrderId?: string | null;
    clientActionId?: string | null;
    customerId?: string | null;
    source?: string;
    terminalReason?: string;
    idempotencyKey?: string;
    error?: string;
    providerState?: string | null;
    /** Opt-in per-incident email (default false — use grouped sweep summary). */
    sendAdminEmail?: boolean;
    attentionClass?: PaymentHoldAttentionClass | null;
    classification?: PaymentHoldClassification | null;
    recoveryAttemptCount?: number;
    purposeLegacy?: boolean;
    purposeSaveCard?: boolean;
    metadataTest?: boolean;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const payload = {
    event,
    trip_id: detail.tripId ?? null,
    payment_session_id: detail.paymentSessionId ?? null,
    provider_order_id: detail.providerOrderId ?? null,
    client_action_id: detail.clientActionId ?? null,
    customer_id: detail.customerId ?? null,
    source: detail.source ?? null,
    terminal_reason: detail.terminalReason ?? null,
    idempotency_key: detail.idempotencyKey ?? null,
    error: detail.error ?? null,
    provider_state: detail.providerState ?? null,
    ...detail.metadata,
  };

  console.info(event, payload);

  const auditAction = event.toLowerCase();
  await supabase.from("admin_payment_audit").insert({
    action: auditAction,
    trip_id: detail.tripId ?? null,
    provider: "revolut",
    provider_payment_id: detail.providerOrderId ?? null,
    reason: detail.terminalReason ?? detail.error ?? event,
    metadata: payload,
  }).then(({ error }) => {
    if (error) console.warn("[holdTelemetry] audit insert failed", error.message);
  });

  if (event === "HOLD_RECONCILIATION_RED") {
    const allowEmail = detail.sendAdminEmail === true
      && shouldEmailHoldReconciliationIncident({
        attentionClass: detail.attentionClass ?? "RELEASE_FAILED",
        classification: detail.classification ?? "RED",
        providerState: (detail.providerState
          ? String(detail.providerState).toUpperCase()
          : null) as CanonicalProviderHoldState | null,
        recoveryAttemptCount: detail.recoveryAttemptCount,
        purposeLegacy: detail.purposeLegacy,
        purposeSaveCard: detail.purposeSaveCard,
        metadataTest: detail.metadataTest,
      });

    if (!allowEmail) {
      console.info("[holdTelemetry] HOLD_RECONCILIATION_RED audit only — email suppressed", {
        provider_order_id: detail.providerOrderId ?? null,
        trip_id: detail.tripId ?? null,
        sendAdminEmail: detail.sendAdminEmail === true,
        attention: detail.attentionClass ?? null,
        classification: detail.classification ?? null,
      });
      return;
    }

    const orderRef = detail.providerOrderId ? ` order ${detail.providerOrderId.slice(0, 8)}…` : "";
    const tripRef = detail.tripId ? ` trip ${detail.tripId.slice(0, 8)}…` : "";
    const reason = detail.terminalReason ?? detail.error ?? "authorised hold requires release";
    try {
      const { sendAdminNotification } = await import("./adminNotificationSSOT.ts");
      await sendAdminNotification(supabase, {
        type: "HOLD_RECONCILIATION_RED",
        title: "Payment hold RED — release required",
        body: `Revolut hold needs attention:${tripRef}${orderRef}. ${reason}`,
        category: "payment",
        priority: "urgent",
        actionUrl: "/payment-sessions?tab=recovery&opFilter=release_failed",
        actionLabel: "Open Payment Sessions",
        alertKey: `hold_red:${detail.providerOrderId ?? detail.paymentSessionId ?? detail.tripId ?? "unknown"}`,
        cooldownMinutes: 60,
        emailTag: "hold_reconciliation_red",
        data: payload,
      });
    } catch (alertErr) {
      console.warn("[holdTelemetry] admin alert failed", alertErr);
    }
  }

  if (event === "HOLD_RECOVERY_FAILED") {
    // Recovery failure is expected to fall through to automatic release —
    // do not email unless release also fails (covered by grouped RED summary).
    console.info("[holdTelemetry] HOLD_RECOVERY_FAILED audit only — email suppressed", {
      provider_order_id: detail.providerOrderId ?? null,
    });
  }
}

/** One grouped email for a sweep of human-action RED incidents. */
export async function sendGroupedHoldReconciliationSummary(
  supabase: SupabaseClient,
  args: {
    source: string;
    incidents: Array<{
      tripId?: string | null;
      paymentSessionId?: string | null;
      providerOrderId?: string | null;
      reason: string;
      amountPence?: number | null;
    }>;
  },
): Promise<{ sent: boolean; skipped?: boolean }> {
  if (args.incidents.length === 0) {
    return { sent: false, skipped: true };
  }

  const totalPence = args.incidents.reduce(
    (sum, i) => sum + (Number(i.amountPence) > 0 ? Number(i.amountPence) : 0),
    0,
  );
  const lines = args.incidents.slice(0, 25).map((i, idx) => {
    const order = i.providerOrderId ? i.providerOrderId.slice(0, 8) : "—";
    const trip = i.tripId ? i.tripId.slice(0, 8) : "no-trip";
    const gbp = i.amountPence != null ? `£${(Number(i.amountPence) / 100).toFixed(2)}` : "£?";
    return `${idx + 1}. ${trip} / ${order} / ${gbp} — ${i.reason}`;
  });
  const more = args.incidents.length > 25
    ? `\n…and ${args.incidents.length - 25} more.`
    : "";

  try {
    const { sendAdminNotification } = await import("./adminNotificationSSOT.ts");
    await sendAdminNotification(supabase, {
      type: "HOLD_RECONCILIATION_SUMMARY",
      title: "Payment reconciliation summary",
      body: [
        `${args.incidents.length} hold(s) need human intervention`,
        totalPence > 0 ? `(£${(totalPence / 100).toFixed(2)} at risk)` : "",
        "after automatic recovery was exhausted.",
        "",
        ...lines,
        more,
      ].filter(Boolean).join("\n"),
      category: "payment",
      priority: "urgent",
      actionUrl: "/payment-sessions?tab=issues&issueFilter=action_required",
      actionLabel: "Open Payment Sessions",
      alertKey: `hold_red_summary:${args.source}`,
      cooldownMinutes: 30,
      emailTag: "hold_reconciliation_summary",
      data: {
        source: args.source,
        incident_count: args.incidents.length,
        at_risk_pence: totalPence,
        incidents: args.incidents.slice(0, 50),
      },
    });
    return { sent: true };
  } catch (err) {
    console.warn("[holdTelemetry] grouped summary email failed", err);
    return { sent: false };
  }
}
