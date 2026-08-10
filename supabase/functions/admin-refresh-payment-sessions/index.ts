// Admin: force-refresh provider state for active/at-risk payment sessions.
// Fetches Revolut order state via GET /orders/{id} and updates our sessions
// to reflect the ground truth. PAYMENT_RECOVERY COMPLETED uses the same SSOT
// planner as revolut-webhook (never double-credits wallet; never swaps trip order id).
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, jsonResponse, requireAdminOrStaff } from "../_shared/adminPaymentGate.ts";
import { getRevolutMerchantConfig, retrieveRevolutOrder } from "../_shared/revolutOrders.ts";
import { creditCapturedCardTripLedger } from "../_shared/onecabFinanceLedger.ts";
import { logAuditEvent } from "../_shared/security.ts";
import {
  sumVerifiedCapturedFromSessions,
  sumVerifiedRefundedFromSessions,
} from "../_shared/tripHistoryShortfallRecaptureSSOT.ts";
import {
  planRecoveryCaptureCompletion,
  isRecoveryCompletionIdempotent,
} from "../../../shared/paymentSessionsRecoveryCompletionSSOT.ts";

const ACTIVE_STATUSES = [
  "pending_payment",
  "payment_authorised",
  "completed_pending_capture",
  "dispatching",
  "trip_created",
  "processing",
  "RECOVERY_CHECKOUT_CREATED",
  "CUSTOMER_ACTION_REQUIRED",
];

const TERMINAL_SESSION = new Set([
  "RECOVERY_COMPLETED",
  "captured",
  "cancelled",
  "canceled",
  "failed",
  "RECOVERY_DECLINED",
  "RECOVERY_CANCELLED",
  "RECOVERY_EXPIRED",
  "released_after_recovery",
]);

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const gate = await requireAdminOrStaff(req);
    if (!gate.ok) return gate.response;

    let body: { session_ids?: string[] } = {};
    try { body = (await req.json()) ?? {}; } catch { /* optional */ }

    const query = gate.supabase
      .from("payment_sessions")
      .select(
        "id, provider_order_id, status, provider_state, authorised_amount_pence, trip_id, purpose, metadata, parent_session_id, captured_amount_pence",
      )
      .eq("payment_provider", "revolut")
      .not("provider_order_id", "is", null);

    const { data: sessions, error } = Array.isArray(body.session_ids) && body.session_ids.length > 0
      ? await query.in("id", body.session_ids)
      : await query.or(
          `status.in.(${ACTIVE_STATUSES.join(",")}),provider_state.in.(AUTHORISED,PENDING,PROCESSING,UNKNOWN)`,
        );

    if (error) return jsonResponse({ error: error.message }, 500);
    if (!sessions?.length) return jsonResponse({ ok: true, refreshed: 0, results: [] });

    const { secretKey, environment } = getRevolutMerchantConfig();
    const nowIso = new Date().toISOString();
    const results: Array<Record<string, unknown>> = [];

    for (const s of sessions) {
      try {
        if (TERMINAL_SESSION.has(String(s.status ?? ""))) {
          results.push({
            session_id: s.id,
            provider_order_id: s.provider_order_id,
            skipped: true,
            reason: "already_terminal",
            status: s.status,
          });
          continue;
        }

        const order = await retrieveRevolutOrder(environment, secretKey, s.provider_order_id!);
        const stateUpper = String(order.state ?? "").toUpperCase();
        const purpose = String(s.purpose ?? "").toUpperCase();
        const amountMinor = typeof order.amount === "number"
          ? Math.round(order.amount)
          : typeof order.completed_amount === "number"
            ? Math.round(order.completed_amount)
            : null;

        if (purpose === "PAYMENT_RECOVERY" && stateUpper === "COMPLETED" && s.trip_id) {
          const recoveryCapture = amountMinor != null && amountMinor > 0
            ? amountMinor
            : Math.round(Number(s.captured_amount_pence ?? s.authorised_amount_pence ?? 0));

          if (recoveryCapture <= 0) {
            results.push({
              session_id: s.id,
              provider_order_id: s.provider_order_id,
              new_state: stateUpper,
              error: "COMPLETED but amount unresolved",
            });
            continue;
          }

          if (isRecoveryCompletionIdempotent({
            priorRecoveryStatus: s.status,
            priorRecoveryCapturedPence: s.captured_amount_pence,
            newRecoveryCapturedPence: recoveryCapture,
          })) {
            results.push({
              session_id: s.id,
              provider_order_id: s.provider_order_id,
              new_state: stateUpper,
              new_status: s.status,
              reused: true,
            });
            continue;
          }

          const { data: tripRow } = await gate.supabase
            .from("trips")
            .select("final_customer_fare_pence, final_fare_pence, no_show_charge_pence, cancellation_fee_pence, estimated_total_pence, capture_amount_pence, authorised_amount_pence, payment_provider, payment_method, driver_id, driver_net_pence, tip_pence, currency_code")
            .eq("id", s.trip_id)
            .maybeSingle();

          const { data: allSessions } = await gate.supabase
            .from("payment_sessions")
            .select("id, purpose, captured_amount_pence, status, provider_state, refunded_amount_pence, parent_session_id, provider_order_id, metadata")
            .eq("trip_id", s.trip_id);

          const verified = sumVerifiedCapturedFromSessions(
            (allSessions ?? []).filter((row) => row.id !== s.id),
          );
          let originalCaptured = verified.original_captured_pence;
          const priorRecovery = verified.recaptured_pence;
          const netRefunded = sumVerifiedRefundedFromSessions(allSessions ?? []);
          if (originalCaptured <= 0 && Number(tripRow?.capture_amount_pence ?? 0) > 0) {
            originalCaptured = Math.round(Number(tripRow.capture_amount_pence));
          }

          let parent: {
            id: string;
            provider_order_id: string | null;
            metadata: Record<string, unknown> | null;
          } | null = null;
          for (const row of allSessions ?? []) {
            if (
              String(row.purpose ?? "").toUpperCase() === "RIDE_BOOKING"
              && (s.parent_session_id == null || row.id === s.parent_session_id)
            ) {
              parent = {
                id: row.id,
                provider_order_id: row.provider_order_id,
                metadata: (row.metadata && typeof row.metadata === "object")
                  ? row.metadata as Record<string, unknown>
                  : null,
              };
            }
          }

          const priorCompletedRecoveryExists = (allSessions ?? []).some(
            (row) =>
              row.id !== s.id
              && String(row.purpose ?? "").toUpperCase() === "PAYMENT_RECOVERY"
              && String(row.status ?? "").toUpperCase() === "RECOVERY_COMPLETED",
          );

          const { data: existingEarning } = await gate.supabase
            .from("driver_wallet_ledger")
            .select("id")
            .eq("related_trip_id", s.trip_id)
            .eq("type", "TRIP_EARNING_NET")
            .maybeSingle();

          const plan = planRecoveryCaptureCompletion({
            recoveryCapturedPence: recoveryCapture,
            recoverySessionId: s.id,
            recoveryProviderOrderId: s.provider_order_id ?? "",
            parentSessionId: parent?.id ?? s.parent_session_id ?? null,
            parentProviderOrderId: parent?.provider_order_id ?? null,
            parentMetadata: parent?.metadata ?? null,
            recoveryMetadata: (s.metadata && typeof s.metadata === "object")
              ? s.metadata as Record<string, unknown>
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

          plan.recovery_session_patch.provider_state_verified_by = "admin_refresh_recovery";

          await gate.supabase.from("payment_sessions").update(plan.recovery_session_patch).eq("id", s.id);
          if (plan.parent_session_patch && parent?.id) {
            await gate.supabase.from("payment_sessions").update(plan.parent_session_patch).eq("id", parent.id);
          }
          await gate.supabase.from("trips").update(plan.trip_patch).eq("id", s.trip_id);

          if (plan.wallet.write_driver_credit && tripRow?.driver_id) {
            try {
              await creditCapturedCardTripLedger(gate.supabase, {
                driverId: tripRow.driver_id,
                tripId: s.trip_id,
                driverNetPence: Math.max(0, Math.round(Number(tripRow.driver_net_pence ?? 0))),
                tipPence: Math.max(0, Math.round(Number(tripRow.tip_pence ?? 0))),
                currency: String(tripRow.currency_code ?? "GBP"),
                paymentId: s.id,
              });
            } catch (walletErr) {
              console.error(
                "[admin-refresh-payment-sessions] recovery wallet credit failed:",
                (walletErr as Error).message,
              );
            }
          }

          await logAuditEvent(gate.supabase, "payment_recovery_completed", {
            tripId: s.trip_id,
            details: {
              recovery_session_id: s.id,
              source: "admin_refresh_payment_sessions",
              outstanding_pence: plan.outstanding_pence,
              total_captured_pence: plan.total_captured_pence,
              wallet_write_driver_credit: plan.wallet.write_driver_credit,
            },
          });

          results.push({
            session_id: s.id,
            provider_order_id: s.provider_order_id,
            previous_state: s.provider_state,
            new_state: stateUpper,
            previous_status: s.status,
            new_status: plan.recovery_session_patch.status,
            captured_amount_pence: recoveryCapture,
            wallet_write_driver_credit: plan.wallet.write_driver_credit,
          });
          continue;
        }

        const update: Record<string, unknown> = {
          provider_state: stateUpper || null,
          provider_state_verified_at: nowIso,
          provider_state_verified_by: "admin_refresh",
          updated_at: nowIso,
        };

        if (["CANCELLED", "FAILED"].includes(stateUpper)) {
          update.status = stateUpper === "CANCELLED" ? "cancelled" : "failed";
          update.failure_reason = `REVOLUT_${stateUpper}`;
        } else if (stateUpper === "COMPLETED" && purpose !== "PAYMENT_RECOVERY") {
          update.status = "captured";
          if (amountMinor != null && amountMinor > 0) {
            update.captured_amount_pence = amountMinor;
            update.captured_at = nowIso;
          }
        } else if (stateUpper === "AUTHORISED" && s.status === "pending_payment") {
          update.status = s.trip_id ? "trip_created" : "payment_authorised";
        }

        const { error: updErr } = await gate.supabase
          .from("payment_sessions")
          .update(update)
          .eq("id", s.id);

        results.push({
          session_id: s.id,
          provider_order_id: s.provider_order_id,
          previous_state: s.provider_state,
          new_state: stateUpper,
          previous_status: s.status,
          new_status: update.status ?? s.status,
          error: updErr?.message ?? null,
        });
      } catch (e) {
        results.push({
          session_id: s.id,
          provider_order_id: s.provider_order_id,
          error: (e as Error).message ?? String(e),
        });
      }
    }

    return jsonResponse({ ok: true, refreshed: results.length, environment, results });
  } catch (e) {
    return jsonResponse({ error: (e as Error).message ?? String(e) }, 500);
  }
});
