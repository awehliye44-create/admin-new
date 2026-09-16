// Revolut Merchant API webhook receiver.
// Signature spec: https://developer.revolut.com/docs/guides/accept-payments/tutorials/work-with-webhooks/verify-the-payload-signature
//
//   Revolut-Request-Timestamp: <unix ms>
//   Revolut-Signature:         v1=<hex-hmac-sha256>[, v2=...]
//
// signed_payload = `v1.${timestamp}.${rawBody}`
// expected      = HMAC_SHA256(REVOLUT_WEBHOOK_SECRET, signed_payload) hex

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  getRevolutMerchantConfig,
  mapRevolutStateToPaymentStatus,
  retrieveRevolutOrder,
} from "../_shared/revolutOrders.ts";
import { revolutMerchantRequest, extractRevolutProviderFeeMinor } from "../_shared/revolutApi.ts";
import { logAuditEvent } from "../_shared/security.ts";
import { creditCapturedCardTripLedger } from "../_shared/onecabFinanceLedger.ts";
import {
  sumVerifiedCapturedFromSessions,
  sumVerifiedRefundedFromSessions,
} from "../_shared/tripHistoryShortfallRecaptureSSOT.ts";
import {
  planRecoveryCaptureCompletion,
  isRecoveryCompletionIdempotent,
} from "../_shared/paymentSessionsRecoveryCompletionSSOT.ts";
import {
  isRevolutProviderStateRegression,
  revolutProviderStateRank,
} from "../_shared/revolutProviderStateRankSSOT.ts";
import { applyPaymentSessionWebhookLifecycleUpdate } from "../_shared/applyPaymentSessionWebhookLifecycleUpdate.ts";
import { resolvePaymentSessionCaptureAdvanceExtras } from "../_shared/paymentSessionCaptureTimestampSSOT.ts";
import { transitionPaymentSession } from "../_shared/paymentSessionTransitionFacade.ts";
import { persistProviderFeeAndMaybeResumeTerminalSettlement } from "../_shared/terminalFeeSettlementResumptionSSOT.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, revolut-signature, revolut-request-timestamp",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MAX_TIMESTAMP_SKEW_MS = 5 * 60 * 1000; // 5 min
const PROVIDER_AUTHORISED_STATES = new Set(["AUTHORISED", "AUTHORIZED"]);

function hexFromBytes(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let hex = "";
  for (let i = 0; i < view.length; i++) hex += view[i].toString(16).padStart(2, "0");
  return hex;
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

async function computeHmac(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return hexFromBytes(sig);
}

interface RevolutWebhookEvent {
  event?: string;
  order_id?: string;
  merchant_order_ext_ref?: string;
  data?: Record<string, unknown> & { state?: string };
}

function numericMinor(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return Math.round(parsed);
    }
  }
  return null;
}

async function resolveAuthorisedAmountMinor(
  orderId: string,
  eventData: Record<string, unknown> | undefined,
): Promise<number | null> {
  const direct = numericMinor(
    eventData?.authorised_amount,
    eventData?.authorized_amount,
    eventData?.amount,
  );
  if (direct != null && direct > 0) return direct;

  try {
    const { secretKey, environment } = getRevolutMerchantConfig();
    const order = await retrieveRevolutOrder(environment, secretKey, orderId);
    const fromOrder = numericMinor(order.amount);
    return fromOrder != null && fromOrder > 0 ? fromOrder : null;
  } catch (error) {
    console.error(`[revolut-webhook] authorised amount lookup failed for ${orderId}:`, (error as Error).message);
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const secret = Deno.env.get("REVOLUT_WEBHOOK_SECRET");
  if (!secret) {
    console.error("[revolut-webhook] REVOLUT_WEBHOOK_SECRET not configured");
    return new Response(JSON.stringify({ error: "webhook_secret_missing" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const rawBody = await req.text();
  const sigHeader = req.headers.get("revolut-signature") ?? "";
  const tsHeader = req.headers.get("revolut-request-timestamp") ?? "";

  if (!sigHeader || !tsHeader) {
    return new Response(JSON.stringify({ error: "missing_signature_headers" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const tsMs = Number(tsHeader);
  if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > MAX_TIMESTAMP_SKEW_MS) {
    return new Response(JSON.stringify({ error: "stale_timestamp" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const expected = await computeHmac(secret, `v1.${tsHeader}.${rawBody}`);
  const provided = sigHeader
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("v1="))
    .map((s) => s.slice(3).toLowerCase());

  if (!provided.some((p) => timingSafeEqualHex(p, expected))) {
    console.error("[revolut-webhook] signature mismatch");
    return new Response(JSON.stringify({ error: "invalid_signature" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let event: RevolutWebhookEvent;
  try {
    event = JSON.parse(rawBody) as RevolutWebhookEvent;
  } catch {
    return new Response(JSON.stringify({ error: "invalid_json" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const orderId = event.order_id ?? null;
  const extRef = event.merchant_order_ext_ref ?? null;
  const eventName = event.event ?? null;

  // === Recovery-path detection ===
  // Recovery orders use ext_ref = `recover:<trip_id>:<sessionUuid>` and are
  // linked to a payment_sessions row of purpose=PAYMENT_RECOVERY. Never mutate
  // trips.provider_order_id or the parent session for recovery events.
  let recoverySession:
    | { id: string; trip_id: string | null; status: string }
    | null = null;
  if (orderId) {
    const { data: recSess } = await supabase
      .from("payment_sessions")
      .select("id, trip_id, status, purpose")
      .eq("provider_order_id", orderId)
      .eq("purpose", "PAYMENT_RECOVERY")
      .maybeSingle();
    if (recSess) {
      recoverySession = { id: recSess.id, trip_id: recSess.trip_id, status: recSess.status };
    }
  }

  // Locate the trip. Prefer provider_order_id, fall back to the ext_ref (trip id)
  // written by create-payment-intent. For recovery orders, use the linked session's trip.
  let tripId: string | null = null;
  if (recoverySession?.trip_id) {
    tripId = recoverySession.trip_id;
  } else {
    if (orderId) {
      const { data } = await supabase
        .from("trips")
        .select("id")
        .eq("payment_provider", "revolut")
        .eq("provider_order_id", orderId)
        .maybeSingle();
      tripId = data?.id ?? null;
    }
    if (!tripId && extRef && !extRef.startsWith("recover:")) tripId = extRef;
  }

  const stateFromEvent =
    (event.data?.state as string | undefined) ??
    (eventName ? eventName.replace(/^ORDER_/, "").toUpperCase() : undefined);
  const stateUpper = String(stateFromEvent ?? "").toUpperCase();
  const nextStatus = mapRevolutStateToPaymentStatus(stateFromEvent);

  // === Recovery lifecycle: never overwrite trip.provider_order_id ===
  if (recoverySession) {
    const recoveryNextStatus =
      stateUpper === "COMPLETED" ? "RECOVERY_COMPLETED" :
      stateUpper === "FAILED" ? "RECOVERY_DECLINED" :
      stateUpper === "CANCELLED" ? "RECOVERY_CANCELLED" :
      stateUpper === "EXPIRED" ? "RECOVERY_EXPIRED" :
      null;
    if (recoveryNextStatus) {
      const nowIso = new Date().toISOString();
      const capturedAmt = (event.data as { captured_amount?: unknown; amount?: unknown } | undefined);
      const amt =
        typeof capturedAmt?.captured_amount === "number" ? capturedAmt.captured_amount :
        typeof capturedAmt?.amount === "number" ? capturedAmt.amount :
        null;

      if (recoveryNextStatus === "RECOVERY_COMPLETED" && recoverySession.trip_id) {
        const { data: recoveryFull } = await supabase
          .from("payment_sessions")
          .select("id, status, captured_amount_pence, metadata, parent_session_id, provider_order_id")
          .eq("id", recoverySession.id)
          .maybeSingle();

        const recoveryCapture = amt != null
          ? Math.round(amt)
          : Math.round(Number(recoveryFull?.captured_amount_pence ?? 0));

        const { data: tripRow } = await supabase
          .from("trips")
          .select("final_customer_fare_pence, final_fare_pence, no_show_charge_pence, cancellation_fee_pence, estimated_total_pence, capture_amount_pence, authorised_amount_pence, payment_provider, payment_method, driver_id, driver_net_pence, tip_pence, currency_code")
          .eq("id", recoverySession.trip_id)
          .maybeSingle();

        const { data: allSessions } = await supabase
          .from("payment_sessions")
          .select("id, purpose, captured_amount_pence, status, provider_state, refunded_amount_pence, parent_session_id, provider_order_id, metadata")
          .eq("trip_id", recoverySession.trip_id);

        const verified = sumVerifiedCapturedFromSessions(
          (allSessions ?? []).filter((s) => s.id !== recoverySession.id),
        );
        let originalCaptured = verified.original_captured_pence;
        let priorRecovery = verified.recaptured_pence;
        const netRefunded = sumVerifiedRefundedFromSessions(allSessions ?? []);
        let parent: {
          id: string;
          provider_order_id: string | null;
          metadata: Record<string, unknown> | null;
          provider_state?: string | null;
        } | null = null;
        for (const s of allSessions ?? []) {
          if (
            String(s.purpose ?? "").toUpperCase() === "RIDE_BOOKING"
            && (recoveryFull?.parent_session_id == null || s.id === recoveryFull.parent_session_id)
          ) {
            parent = {
              id: s.id,
              provider_order_id: s.provider_order_id,
              metadata: (s.metadata && typeof s.metadata === "object")
                ? s.metadata as Record<string, unknown>
                : null,
            };
          }
        }
        if (originalCaptured <= 0 && Number(tripRow?.capture_amount_pence ?? 0) > 0) {
          originalCaptured = Math.round(Number(tripRow?.capture_amount_pence));
        }

        const priorCompletedRecoveryExists = (allSessions ?? []).some(
          (s) =>
            s.id !== recoverySession.id
            && String(s.purpose ?? "").toUpperCase() === "PAYMENT_RECOVERY"
            && String(s.status ?? "").toUpperCase() === "RECOVERY_COMPLETED",
        );

        // Detect existing trip earning ledger (idempotent wallet gate).
        const { data: existingEarning } = await supabase
          .from("driver_wallet_ledger")
          .select("id")
          .eq("related_trip_id", recoverySession.trip_id)
          .eq("type", "TRIP_EARNING_NET")
          .maybeSingle();

        if (isRecoveryCompletionIdempotent({
          priorRecoveryStatus: recoveryFull?.status ?? recoverySession.status,
          priorRecoveryCapturedPence: recoveryFull?.captured_amount_pence,
          newRecoveryCapturedPence: recoveryCapture,
        })) {
          // Already applied — still ensure trip outstanding is closed.
        }

        const plan = planRecoveryCaptureCompletion({
          recoveryCapturedPence: recoveryCapture,
          recoverySessionId: recoverySession.id,
          recoveryProviderOrderId: orderId ?? recoveryFull?.provider_order_id ?? "",
          parentSessionId: parent?.id ?? recoveryFull?.parent_session_id ?? null,
          parentProviderOrderId: parent?.provider_order_id ?? null,
          parentMetadata: parent?.metadata ?? null,
          recoveryMetadata: (recoveryFull?.metadata && typeof recoveryFull.metadata === "object")
            ? recoveryFull.metadata as Record<string, unknown>
            : null,
          originalCapturedPence: originalCaptured,
          priorRecoveryCapturedPence: priorRecovery,
          netRefundedTotalPence: netRefunded,
          priorCompletedRecoveryExists,
          finalCustomerFarePence: tripRow?.final_customer_fare_pence,
          finalFarePence: tripRow?.final_fare_pence,
          noShowChargePence: tripRow?.no_show_charge_pence,
          cancellationFeePence: tripRow?.cancellation_fee_pence,
          estimatedTotalPence: tripRow?.estimated_total_pence,
          totalAuthorisedPence: tripRow?.authorised_amount_pence,
          paymentProvider: tripRow?.payment_provider ?? "revolut",
          paymentMethod: tripRow?.payment_method ?? null,
          originalDriverEarningAlreadyCredited: Boolean(existingEarning?.id),
          driverEarningWithheldPendingRecovery: !existingEarning?.id,
          nowIso,
        });

        await transitionPaymentSession(supabase, {
          sessionId: recoverySession.id,
          patch: plan.recovery_session_patch,
          source: "recovery",
        });
        if (plan.parent_session_patch && parent?.id) {
          await transitionPaymentSession(supabase, {
            sessionId: parent.id,
            patch: plan.parent_session_patch,
            source: "recovery",
          });
        }
        // Never set provider_order_id to the recovery order.
        await supabase.from("trips").update(plan.trip_patch).eq("id", recoverySession.trip_id);

        // Wallet credit only via existing ledger helper after provider-verified capture.
        // Never double-credit when TRIP_EARNING_NET already exists.
        if (plan.wallet.write_driver_credit && tripRow?.driver_id) {
          try {
            const creditResult = await creditCapturedCardTripLedger(supabase, {
              driverId: tripRow.driver_id,
              tripId: recoverySession.trip_id,
              driverNetPence: Math.max(0, Math.round(Number(tripRow.driver_net_pence ?? 0))),
              tipPence: Math.max(0, Math.round(Number(tripRow.tip_pence ?? 0))),
              currency: String(tripRow.currency_code ?? "GBP"),
              paymentId: recoverySession.id,
            });
            await logAuditEvent(supabase, "payment_recovery_wallet_credit", {
              tripId: recoverySession.trip_id,
              details: {
                recovery_session_id: recoverySession.id,
                credited: creditResult.credited,
                recovery_pence: creditResult.recovery_pence,
                write_driver_credit: true,
              },
            });
          } catch (walletErr) {
            console.error(
              "[revolut-webhook] recovery wallet credit failed:",
              (walletErr as Error).message,
            );
          }
        }

        await logAuditEvent(supabase, "payment_recovery_completed", {
          tripId: recoverySession.trip_id,
          details: {
            recovery_session_id: recoverySession.id,
            outstanding_pence: plan.outstanding_pence,
            total_captured_pence: plan.total_captured_pence,
            wallet_write_driver_credit: plan.wallet.write_driver_credit,
            prevent_further_payment_links: plan.prevent_further_payment_links,
          },
        });

        // Release residual AUTHORISED parent hold after recovery capture.
        if (parent?.provider_order_id) {
          const { data: parentFresh } = await supabase
            .from("payment_sessions")
            .select("id, provider_state, provider_order_id, metadata")
            .eq("id", parent.id)
            .maybeSingle();
          if (parentFresh && (parentFresh.provider_state ?? "").toUpperCase() === "AUTHORISED") {
            try {
              const { secretKey, environment } = getRevolutMerchantConfig();
              const { cancelRevolutOrder } = await import("../_shared/revolutOrders.ts");
              await cancelRevolutOrder(environment, secretKey, parentFresh.provider_order_id!);
              await transitionPaymentSession(supabase, {
                sessionId: parentFresh.id,
                patch: {
                  provider_state: "CANCELLED",
                  status: "released_after_recovery",
                  provider_state_verified_at: nowIso,
                  provider_state_verified_by: "recovery_captured",
                  updated_at: nowIso,
                },
                source: "recovery",
              });
            } catch (releaseErr) {
              console.error(`[revolut-webhook] parent hold release after recovery failed:`, (releaseErr as Error).message);
            }
          }
        }
      } else {
        const sessionUpdate: Record<string, unknown> = {
          status: recoveryNextStatus,
          updated_at: nowIso,
        };
        if (amt != null) sessionUpdate.captured_amount_pence = Math.round(amt);
        await transitionPaymentSession(supabase, {
          sessionId: recoverySession.id,
          patch: sessionUpdate,
          source: "recovery",
        });
      }
    }
  } else {
    let finaliseTripId: string | null = null;

    if (orderId) {
      const { data: session } = await supabase
        .from("payment_sessions")
        .select(
          "id, trip_id, status, authorised_amount_pence, captured_amount_pence, captured_at, provider_state, failure_reason, metadata, financial_operation_state, purpose, refunded_amount_pence, hold_release_state, provider_capture_id, provider_order_id",
        )
        .eq("provider_order_id", orderId)
        .eq("purpose", "RIDE_BOOKING")
        .maybeSingle();

      if (session) {
        if (!tripId && session.trip_id) tripId = session.trip_id;

        const nowIso = new Date().toISOString();
        const sessionMeta =
          session.metadata && typeof session.metadata === "object"
            ? session.metadata as Record<string, unknown>
            : {};

        const eventCaptured = numericMinor(
          (event.data as { captured_amount?: unknown; amount?: unknown } | undefined)?.captured_amount,
          (event.data as { captured_amount?: unknown; amount?: unknown } | undefined)?.amount,
        );

        // Stronger terminal provider states must not be overwritten by weaker/stale events.
        const priorProvider = String(session.provider_state ?? "").toUpperCase();
        const priorRank = revolutProviderStateRank;
        const incomingIsRegression = isRevolutProviderStateRegression(priorProvider, stateUpper);

        const providerEvidencePatch: Record<string, unknown> = {
          provider_state: stateUpper || null,
          provider_state_verified_at: nowIso,
          provider_state_verified_by: "webhook",
          metadata: {
            ...sessionMeta,
            revolut_last_webhook_event: eventName,
            revolut_last_webhook_state: stateUpper || null,
            revolut_last_webhook_at: nowIso,
          },
        };

        let statusAdvanceExtras: Record<string, unknown> = {};

        if (incomingIsRegression) {
          // Do not regress provider_state — still log structured lifecycle skip below.
          delete providerEvidencePatch.provider_state;
          console.warn(
            `[revolut-webhook] ignoring regressive provider_state ${stateUpper} after ${priorProvider} for session ${session.id}`,
          );
        } else if (["AUTHORISED", "AUTHORIZED", "COMPLETED", "CAPTURED"].includes(stateUpper)) {
          const authorisedAmount = await resolveAuthorisedAmountMinor(orderId, event.data);
          if (authorisedAmount != null && authorisedAmount > 0) {
            statusAdvanceExtras.authorised_amount_pence = authorisedAmount;
            statusAdvanceExtras.total_authorised_amount_pence = authorisedAmount;
          }
          if (PROVIDER_AUTHORISED_STATES.has(stateUpper)) {
            statusAdvanceExtras.authorised_at = nowIso;
            statusAdvanceExtras.failure_reason = null;
          }
          if (["COMPLETED", "CAPTURED"].includes(stateUpper)) {
            const captureAmt = eventCaptured ?? (
              Number(session.captured_amount_pence ?? 0) > 0
                ? Math.round(Number(session.captured_amount_pence))
                : null
            );
            if (captureAmt != null && captureAmt > 0) {
              Object.assign(
                statusAdvanceExtras,
                resolvePaymentSessionCaptureAdvanceExtras({
                  storedCapturedAt: session.captured_at as string | null,
                  storedCapturedAmountPence: session.captured_amount_pence as number | null,
                  incomingCapturedAmountPence: captureAmt,
                  nowIso,
                }),
              );
            }
          }
        } else if (["CANCELLED", "FAILED"].includes(stateUpper)) {
          if (priorRank(priorProvider) >= 40) {
            console.warn(
              `[revolut-webhook] ignoring ${stateUpper} after ${priorProvider} for session ${session.id}`,
            );
            providerEvidencePatch.provider_state = priorProvider || providerEvidencePatch.provider_state;
          } else {
            statusAdvanceExtras.failure_reason = `REVOLUT_${stateUpper}`;
          }
        }

        let tripFinancialModel: string | null = null;
        if (session.trip_id) {
          const { data: tripRow } = await supabase
            .from("trips")
            .select("financial_model")
            .eq("id", session.trip_id)
            .maybeSingle();
          tripFinancialModel = (tripRow?.financial_model as string | null) ?? null;
        }

        const lifecycleResult = await applyPaymentSessionWebhookLifecycleUpdate({
          supabase,
          context: {
            sessionId: session.id,
            tripId: session.trip_id,
            providerOrderId: orderId,
            currentStatus: String(session.status ?? ""),
            financialOperationState: session.financial_operation_state,
            financialModel: tripFinancialModel,
            purpose: session.purpose,
            storedCapturedAmountPence: session.captured_amount_pence,
            refundedAmountPence: session.refunded_amount_pence,
            holdReleaseState: session.hold_release_state,
            storedProviderCaptureId: session.provider_capture_id,
            storedProviderOrderId: session.provider_order_id,
            priorProviderState: priorProvider,
          },
          providerState: stateUpper,
          incomingCapturedAmountPence: eventCaptured,
          providerEvidencePatch: incomingIsRegression
            ? {
              provider_state_verified_at: nowIso,
              provider_state_verified_by: "webhook",
              updated_at: nowIso,
              metadata: providerEvidencePatch.metadata,
            }
            : providerEvidencePatch,
          statusAdvanceExtras,
        });

        if (lifecycleResult.error_message) {
          console.error("[revolut-webhook] payment_session lifecycle update failed", {
            session_id: lifecycleResult.session_id,
            trip_id: lifecycleResult.trip_id,
            provider_order_id: lifecycleResult.provider_order_id,
            provider_capture_id: lifecycleResult.provider_capture_id,
            previous_status: lifecycleResult.previous_status,
            attempted_status: lifecycleResult.attempted_status,
            provider_state: lifecycleResult.provider_state,
            error_code: lifecycleResult.error_code ?? null,
            error_message: lifecycleResult.error_message,
            decision: lifecycleResult.decision,
          });
        } else if (lifecycleResult.lifecycle_conflict) {
          console.warn("[revolut-webhook] payment_session lifecycle conflict", {
            session_id: lifecycleResult.session_id,
            trip_id: lifecycleResult.trip_id,
            previous_status: lifecycleResult.previous_status,
            attempted_status: lifecycleResult.attempted_status,
            provider_state: lifecycleResult.provider_state,
            decision: lifecycleResult.decision,
            reason: lifecycleResult.reason,
          });
        }

        // P0: never auto-finalise superseded / orphaned / already-trip sessions.
        const sessionStatus = String(session.status ?? "").toLowerCase();
        const sessionMeta =
          session.metadata && typeof session.metadata === "object"
            ? (session.metadata as Record<string, unknown>)
            : {};
        const alreadyOrphaned =
          sessionStatus === "payment_orphaned" ||
          sessionStatus === "orphan_authorisation" ||
          sessionMeta.orphan_reason === "CUSTOMER_ALREADY_HAS_ACTIVE_TRIP" ||
          sessionMeta.never_capture === true;

        if (
          ["AUTHORISED", "AUTHORIZED", "COMPLETED", "CAPTURED"].includes(stateUpper) &&
          !session.trip_id &&
          !alreadyOrphaned &&
          !["cancelled", "failed", "released"].includes(sessionStatus)
        ) {
          const { data: finaliseData, error: finaliseError } = await supabase.rpc(
            "finalize_paid_booking_session",
            { p_payment_session_id: session.id },
          );
          if (finaliseError) {
            const msg = String(finaliseError.message || "");
            const duplicateActive =
              msg.includes("CUSTOMER_ALREADY_HAS_ACTIVE_TRIP");
            console.error(
              `[revolut-webhook] finalize failed for session ${session.id}:`,
              msg,
            );

            // Idempotent orphan + release: late AUTHORISED after passenger already
            // has a live immediate trip — never create/dispatch/capture.
            if (duplicateActive) {
              const existingTripMatch = msg.match(
                /CUSTOMER_ALREADY_HAS_ACTIVE_TRIP:([0-9a-f-]{36})/i,
              );
              const existingTripId = existingTripMatch?.[1] ?? null;
              await supabase
                .from("payment_sessions")
                .update({
                  status: "payment_orphaned",
                  updated_at: nowIso,
                  metadata: {
                    ...sessionMeta,
                    revolut_last_webhook_event: eventName,
                    revolut_last_webhook_state: stateUpper || null,
                    revolut_last_webhook_at: nowIso,
                    orphan_reason: "CUSTOMER_ALREADY_HAS_ACTIVE_TRIP",
                    existing_trip_id: existingTripId,
                    orphaned_at: nowIso,
                    orphaned_by: "revolut_webhook",
                    release_recommended: true,
                    never_capture: true,
                  },
                })
                .eq("id", session.id)
                .is("trip_id", null);

              // Best-effort release of unused authorisation (provider cancel).
              // Do not invent success — log failures; webhook still returns 2xx.
              if (orderId) {
                try {
                  const { secretKey, environment } = getRevolutMerchantConfig();
                  const { cancelRevolutOrder } = await import(
                    "../_shared/revolutOrders.ts"
                  );
                  await cancelRevolutOrder(environment, secretKey, orderId);
                  await supabase
                    .from("payment_sessions")
                    .update({
                      provider_state: "CANCELLED",
                      hold_release_state: "released",
                      released_at: nowIso,
                      updated_at: nowIso,
                      metadata: {
                        ...sessionMeta,
                        orphan_reason: "CUSTOMER_ALREADY_HAS_ACTIVE_TRIP",
                        existing_trip_id: existingTripId,
                        orphaned_at: nowIso,
                        orphaned_by: "revolut_webhook",
                        release_attempted_at: nowIso,
                        release_result: "cancel_requested",
                        never_capture: true,
                      },
                    })
                    .eq("id", session.id);
                  console.log(
                    `[revolut-webhook] orphaned session=${session.id} release requested existing_trip=${existingTripId ?? "?"}`,
                  );
                } catch (releaseErr) {
                  console.error(
                    `[revolut-webhook] orphan release failed for session ${session.id}:`,
                    (releaseErr as Error).message,
                  );
                  await supabase
                    .from("payment_sessions")
                    .update({
                      hold_release_state: "release_failed",
                      updated_at: nowIso,
                      metadata: {
                        ...sessionMeta,
                        orphan_reason: "CUSTOMER_ALREADY_HAS_ACTIVE_TRIP",
                        existing_trip_id: existingTripId,
                        orphaned_at: nowIso,
                        orphaned_by: "revolut_webhook",
                        release_attempted_at: nowIso,
                        release_result: "cancel_failed",
                        release_error: (releaseErr as Error).message,
                        never_capture: true,
                      },
                    })
                    .eq("id", session.id);
                }
              }
            } else {
              await supabase
                .from("payment_sessions")
                .update({
                  recovery_attempt_count: 1,
                  last_recovery_attempt_at: nowIso,
                  metadata: {
                    ...sessionMeta,
                    revolut_last_webhook_event: eventName,
                    revolut_last_webhook_state: stateUpper || null,
                    revolut_last_webhook_at: nowIso,
                    last_auto_recovery_error: msg,
                    last_auto_recovery_error_at: nowIso,
                  },
                })
                .eq("id", session.id);
            }
          } else {
            finaliseTripId = typeof finaliseData === "string" ? finaliseData : null;
            if (finaliseTripId) tripId = finaliseTripId;
            console.log(`[revolut-webhook] finalised authorised session=${session.id} trip=${finaliseTripId ?? "?"}`);
          }
        } else if (
          ["AUTHORISED", "COMPLETED"].includes(stateUpper) &&
          !session.trip_id &&
          alreadyOrphaned
        ) {
          // Idempotent webhook retry after orphan — do not re-finalise.
          console.log(
            `[revolut-webhook] skip finalize orphaned/superseded session=${session.id}`,
          );
        }
      } else if (stateUpper === "AUTHORISED") {
        console.warn(`[revolut-webhook] authorised order has no RIDE_BOOKING payment_session: ${orderId}`);
      }
    }

    if (tripId && nextStatus) {
    let effectiveStatus = nextStatus;

    // Payment-gate SSOT: if this trip is in additional-auth recovery
    // (child re-hold cancelled/failed) but the ORIGINAL parent order is
    // still AUTHORISED, do NOT flip the trip to `canceled`. Keep it in
    // `recovery_required` so admins can run create-payment-recovery.
    if (nextStatus === "canceled" || nextStatus === "failed") {
      const { data: parentSession } = await supabase
        .from("payment_sessions")
        .select("provider_state, metadata")
        .eq("trip_id", tripId)
        .eq("purpose", "RIDE_BOOKING")
        .maybeSingle();
      const addl =
        (parentSession?.metadata as { additional_auth_status?: string } | null)
          ?.additional_auth_status ?? null;
      if (
        parentSession?.provider_state === "AUTHORISED"
        && addl === "PAYMENT_RECOVERY_REQUIRED"
      ) {
        effectiveStatus = "recovery_required";
      }
    }

    const update: Record<string, unknown> = {
      payment_status: effectiveStatus,
      updated_at: new Date().toISOString(),
    };
    // On terminal capture, keep provider_charge_id fresh from the webhook payload.
    if (effectiveStatus === "captured" && orderId) {
      update.provider_charge_id = orderId;
    }
    const { error } = await supabase.from("trips").update(update).eq("id", tripId);
    if (error) {
      console.error(`[revolut-webhook] trip update failed for ${tripId}:`, error.message);
    }
    }
  }


  // On capture: hydrate provider processing fee from Revolut order details.
  // Writes payment_sessions.provider_processing_fee_pence + trips.provider_fee_pence.
  let feeMinor: number | null = null;
  if (nextStatus === "captured" && orderId) {
    try {
      const secretKey = Deno.env.get("REVOLUT_MERCHANT_SECRET_KEY")
        ?? Deno.env.get("REVOLUT_SECRET_KEY");
      if (secretKey) {
        const order = await revolutMerchantRequest<unknown>(
          "live",
          secretKey,
          `/orders/${encodeURIComponent(orderId)}`,
          { method: "GET" },
        );
        feeMinor = extractRevolutProviderFeeMinor(order);
        if (feeMinor != null) {
          await persistProviderFeeAndMaybeResumeTerminalSettlement(supabase, {
            providerOrderId: orderId,
            tripId,
            providerFeePence: feeMinor,
            retrieveSucceeded: true,
            source: "revolut_webhook",
          });
        }
      } else {
        console.warn("[revolut-webhook] no merchant secret env; skipping fee hydration");
      }
    } catch (feeErr) {
      console.error(`[revolut-webhook] fee hydration error:`, (feeErr as Error).message);
    }
  }

  // Idempotent audit log.
  const { error: auditError } = await supabase.from("admin_payment_audit").insert({
    action: "revolut_webhook",
    provider: "revolut",
    provider_payment_id: orderId,
    trip_id: tripId,
    metadata: {
      event: eventName,
      state: stateFromEvent ?? null,
      applied_status: nextStatus,
      provider_fee_pence: feeMinor,
      data: event.data ?? null,
    },
  });
  if (auditError) console.error("[revolut-webhook] audit insert failed:", auditError.message);

  console.log(
    `[revolut-webhook] verified event=${eventName ?? "?"} order=${orderId ?? "?"} trip=${tripId ?? "?"} → status=${nextStatus ?? "none"}`,
  );

  return new Response(JSON.stringify({ received: true, applied_status: nextStatus }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
