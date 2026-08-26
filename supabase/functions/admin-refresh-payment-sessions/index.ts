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
} from "../_shared/paymentSessionsRecoveryCompletionSSOT.ts";
import { applyPaymentSessionWebhookLifecycleUpdate } from "../_shared/applyPaymentSessionWebhookLifecycleUpdate.ts";
import { FINANCIAL_MODEL, resolveServiceAreaFinancialScope } from "../_shared/financialModelScopeGate.ts";
import { classifyTripForPlatformCollectedAdminPage } from "../../../shared/financialModelScopeSSOT.ts";

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

    let body: { session_ids?: string[]; service_area_id?: string | null } = {};
    try { body = (await req.json()) ?? {}; } catch { /* optional */ }

    // Payment Sessions page is PLATFORM_COLLECTED only — never refresh CW sessions.
    const modelScope = await resolveServiceAreaFinancialScope(
      gate.supabase,
      FINANCIAL_MODEL.PLATFORM_COLLECTED,
      body.service_area_id ?? null,
    );
    if (!modelScope.ok) {
      return jsonResponse({
        ok: false,
        error: modelScope.error,
        error_code: modelScope.code,
      }, 400);
    }
    const allowedSa = new Set(modelScope.allowedServiceAreaIds);

    const query = gate.supabase
      .from("payment_sessions")
      .select(
        "id, provider_order_id, provider_capture_id, status, provider_state, authorised_amount_pence, trip_id, purpose, metadata, parent_session_id, captured_amount_pence, refunded_amount_pence, hold_release_state, financial_operation_state, financial_model, service_area_id",
      )
      .eq("payment_provider", "revolut")
      .not("provider_order_id", "is", null);

    const { data: sessionsRaw, error } = Array.isArray(body.session_ids) && body.session_ids.length > 0
      ? await query.in("id", body.session_ids)
      : await query.or(
          `status.in.(${ACTIVE_STATUSES.join(",")}),provider_state.in.(AUTHORISED,PENDING,PROCESSING,UNKNOWN)`,
        );

    if (error) return jsonResponse({ error: error.message }, 500);
    if (!sessionsRaw?.length) return jsonResponse({ ok: true, refreshed: 0, results: [] });

    const tripIdsForClassify = [
      ...new Set(
        sessionsRaw
          .map((s) => String(s.trip_id ?? ""))
          .filter(Boolean),
      ),
    ];
    const tripById = new Map<string, { financial_model?: unknown; commission_wallet_enabled?: unknown }>();
    if (tripIdsForClassify.length > 0) {
      const { data: trips } = await gate.supabase
        .from("trips")
        .select("id, financial_model, commission_wallet_enabled")
        .in("id", tripIdsForClassify);
      for (const t of trips ?? []) {
        tripById.set(String(t.id), t as { financial_model?: unknown; commission_wallet_enabled?: unknown });
      }
    }

    const sessions = sessionsRaw.filter((s) => {
      const sa = s.service_area_id ? String(s.service_area_id) : "";
      if (sa && !allowedSa.has(sa)) return false;
      const trip = s.trip_id ? tripById.get(String(s.trip_id)) : undefined;
      if (!sa && !trip) return false;
      return classifyTripForPlatformCollectedAdminPage({
        financial_model: s.financial_model ?? trip?.financial_model,
        commission_wallet_enabled: trip?.commission_wallet_enabled,
      }).includeOnPlatformPage;
    });
    if (!sessions.length) return jsonResponse({ ok: true, refreshed: 0, results: [], skipped_out_of_scope: sessionsRaw.length });

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

        const providerEvidencePatch: Record<string, unknown> = {
          provider_state: stateUpper || null,
          provider_state_verified_at: nowIso,
          provider_state_verified_by: "admin_refresh",
          updated_at: nowIso,
        };
        const statusAdvanceExtras: Record<string, unknown> = {};

        if (["CANCELLED", "FAILED"].includes(stateUpper)) {
          statusAdvanceExtras.failure_reason = `REVOLUT_${stateUpper}`;
        } else if (["AUTHORISED", "AUTHORIZED"].includes(stateUpper)) {
          if (s.authorised_amount_pence != null && Number(s.authorised_amount_pence) > 0) {
            statusAdvanceExtras.authorised_amount_pence = Math.round(Number(s.authorised_amount_pence));
            statusAdvanceExtras.total_authorised_amount_pence = Math.round(Number(s.authorised_amount_pence));
          }
          statusAdvanceExtras.authorised_at = nowIso;
          statusAdvanceExtras.failure_reason = null;
        } else if (["COMPLETED", "CAPTURED"].includes(stateUpper)) {
          if (amountMinor != null && amountMinor > 0) {
            statusAdvanceExtras.captured_amount_pence = amountMinor;
            statusAdvanceExtras.captured_at = nowIso;
          }
        }

        const lifecycleResult = await applyPaymentSessionWebhookLifecycleUpdate({
          supabase: gate.supabase,
          context: {
            sessionId: s.id,
            tripId: s.trip_id,
            providerOrderId: s.provider_order_id,
            providerCaptureId: s.provider_capture_id,
            currentStatus: String(s.status ?? ""),
            financialOperationState: s.financial_operation_state,
            financialModel: s.financial_model,
            purpose: s.purpose,
            storedCapturedAmountPence: s.captured_amount_pence,
            refundedAmountPence: s.refunded_amount_pence,
            holdReleaseState: s.hold_release_state,
            storedProviderCaptureId: s.provider_capture_id,
            storedProviderOrderId: s.provider_order_id,
            priorProviderState: s.provider_state,
          },
          providerState: stateUpper,
          incomingCapturedAmountPence: amountMinor,
          providerEvidencePatch,
          statusAdvanceExtras,
        });

        results.push({
          session_id: s.id,
          provider_order_id: s.provider_order_id,
          previous_state: s.provider_state,
          new_state: stateUpper,
          previous_status: s.status,
          new_status: lifecycleResult.attempted_status ?? s.status,
          decision: lifecycleResult.decision,
          reason: lifecycleResult.reason,
          error: lifecycleResult.error_message ?? null,
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
