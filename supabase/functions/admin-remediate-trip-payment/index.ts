/**
 * P0 — Controlled trip payment remediation via canonical resolver.
 * Modes: dry_run | execute
 * Never invents amounts — always resolveTripPaymentOutcome + live Revolut truth.
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { z } from "https://esm.sh/zod@3.23.8";
import { corsHeaders, jsonResponse, requireAdminOrStaff } from "../_shared/adminPaymentGate.ts";
import {
  resolveTripPaymentOutcome,
  TRIP_PAYMENT_OUTCOME,
} from "../../../shared/resolveTripPaymentOutcomeSSOT.ts";
import { resolveRevolutMerchantContext } from "../_shared/revolutMerchantContext.ts";
import { retrieveRevolutOrder } from "../_shared/revolutOrders.ts";
import { releaseHoldOnTripTerminal } from "../_shared/holdReleaseSSOT.ts";
import { markPaymentSessionReleased } from "../_shared/paymentSessionSSOT.ts";
import { finalizeRevolutTripCapture } from "../_shared/finalizeRevolutTripCapture.ts";
import { transitionPaymentSession } from "../_shared/paymentSessionTransitionFacade.ts";

const InputSchema = z.object({
  trip_id: z.string().uuid().optional(),
  trip_code: z.string().trim().min(3).optional(),
  mode: z.enum(["dry_run", "execute"]).default("dry_run"),
}).refine((v) => Boolean(v.trip_id || v.trip_code), {
  message: "trip_id or trip_code required",
});

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const gate = await requireAdminOrStaff(req);
    if (!gate.ok) return gate.response;
    const { supabase, userId } = gate;

    const parsed = InputSchema.safeParse(await req.json());
    if (!parsed.success) {
      return jsonResponse({ success: false, error: parsed.error.message }, 400);
    }
    const { mode } = parsed.data;

    let tripQuery = supabase.from("trips").select("*");
    if (parsed.data.trip_id) tripQuery = tripQuery.eq("id", parsed.data.trip_id);
    else tripQuery = tripQuery.eq("trip_code", parsed.data.trip_code!);
    const { data: trip, error: tripErr } = await tripQuery.maybeSingle();
    if (tripErr || !trip) {
      return jsonResponse({ success: false, error: "trip_not_found" }, 404);
    }

    const orderId = String(trip.provider_order_id ?? "").trim();
    let providerState: string | null = null;
    let providerUnknown = false;
    let liveAmount: number | null = null;
    if (orderId) {
      try {
        const merchant = await resolveRevolutMerchantContext(supabase, "live");
        const order = await retrieveRevolutOrder(merchant.environment, merchant.secretKey, orderId);
        providerState = String(order.state ?? "").toUpperCase();
        liveAmount = Number(order.amount ?? null);
        await transitionPaymentSession(supabase, {
          providerOrderId: orderId,
          patch: {
            provider_state: providerState,
            provider_state_verified_at: new Date().toISOString(),
            provider_state_verified_by: "admin-remediate-trip-payment",
            updated_at: new Date().toISOString(),
          },
          source: "admin_remediate",
        });
      } catch (err) {
        providerUnknown = true;
        console.warn("[admin-remediate-trip-payment] provider refresh failed", err);
      }
    } else {
      providerUnknown = true;
    }

    const canonicalPayable = Math.max(
      0,
      Number(trip.final_customer_fare_pence ?? trip.final_fare_pence ?? 0)
        + Number(trip.waiting_charge_pence ?? trip.total_waiting_charge_pence ?? 0)
        + Number(trip.tip_pence ?? trip.tip_amount_pence ?? 0),
    );

    const { data: paymentSession } = orderId
      ? await supabase.from("payment_sessions").select(
        "id,status,provider_state,released_amount_pence,captured_amount_pence,authorised_amount_pence,refunded_amount_pence",
      ).eq("provider_order_id", orderId).maybeSingle()
      : { data: null };

    const decision = resolveTripPaymentOutcome({
      trip_status: trip.status,
      canonical_payable_pence: String(trip.status).toLowerCase() === "completed"
        ? (Number(trip.final_customer_fare_pence ?? trip.final_fare_pence ?? 0)
          + Number(trip.waiting_charge_pence ?? 0)
          + Number(trip.tip_pence ?? trip.tip_amount_pence ?? 0))
        : null,
      final_fare_pence: trip.final_fare_pence,
      cancellation_fee_pence: trip.cancellation_fee_pence
        ?? trip.late_cancel_fee_pence
        ?? trip.arrival_cancellation_fee
        ?? 0,
      no_show_fee_pence: trip.no_show_charge_pence ?? 0,
      total_authorised_pence: trip.authorised_amount_pence
        ?? trip.authorized_amount_pence
        ?? paymentSession?.authorised_amount_pence
        ?? liveAmount,
      total_captured_pence: trip.capture_amount_pence
        ?? paymentSession?.captured_amount_pence
        ?? 0,
      total_released_pence: paymentSession?.released_amount_pence ?? null,
      total_refunded_pence: trip.refund_amount_pence
        ?? paymentSession?.refunded_amount_pence
        ?? 0,
      outstanding_balance_pence: trip.outstanding_balance_pence ?? 0,
      provider_state: providerState,
      payment_status: trip.payment_status,
      payment_hold_status: trip.payment_hold_status,
      recovery_required: String(trip.payment_hold_status ?? "") === "payment_shortfall",
      provider_state_unknown: providerUnknown,
    });

    const auditBase = {
      trip_id: trip.id,
      trip_code: trip.trip_code,
      actor_id: userId,
      mode,
      provider_order_id: orderId || null,
      provider_state_before: providerState,
      decision,
    };

    await supabase.from("admin_payment_audit").insert({
      action: "trip_payment_remediation_decision",
      trip_id: trip.id,
      provider: "revolut",
      provider_payment_id: orderId || null,
      reason: decision.outcome,
      metadata: auditBase,
    });

    if (mode === "dry_run") {
      return jsonResponse({
        success: true,
        mode: "dry_run",
        trip_id: trip.id,
        trip_code: trip.trip_code,
        provider_state: providerState,
        decision,
        money_moved: false,
      });
    }

    // EXECUTE
    let actionTaken = "none";
    let providerStateAfter = providerState;
    let captureResult: unknown = null;
    let releaseResult: unknown = null;

    if (decision.outcome === TRIP_PAYMENT_OUTCOME.NO_ACTION_ALREADY_RESOLVED
      && decision.local_reconcile_only
      && String(decision.reason ?? "").includes("provider_already_cancelled")) {
      if (orderId) {
        const releasedAmt = Number(trip.authorised_amount_pence ?? liveAmount ?? 0) || null;
        const sessionFilter = trip.payment_session_id
          ? { id: trip.payment_session_id }
          : { provider_order_id: orderId };
        // Trigger prevent_authorised_session_client_cancel uses OLD.provider_state.
        // Flip provider_state first (no status change), then close session.
        const nowIso = new Date().toISOString();
        const ps1Result = await transitionPaymentSession(supabase, {
          sessionId: trip.payment_session_id ?? undefined,
          providerOrderId: trip.payment_session_id ? undefined : orderId,
          patch: {
            provider_state: "CANCELLED",
            provider_state_verified_at: nowIso,
            provider_state_verified_by: "admin-remediate-trip-payment",
            updated_at: nowIso,
          },
          source: "admin_remediate",
        });
        if (!ps1Result.ok) {
          console.warn("[admin-remediate-trip-payment] provider_state pre-flip failed", ps1Result.error);
        }

        await markPaymentSessionReleased(supabase, {
          providerOrderId: orderId,
          clientActionId: trip.client_action_id,
          tripId: trip.id,
          reason: "remediation_provider_already_cancelled",
          holdTerminalReason: "provider_cancelled",
          providerReleaseReference: orderId,
          releasedAmountPence: releasedAmt,
          releaseEvidenceStatus: "CONFIRMED",
          releaseEvidenceSource: "admin-remediate-trip-payment",
          idempotencyKey: `remediate_local_${trip.id}`,
        });
        const ps2Result = await transitionPaymentSession(supabase, {
          sessionId: trip.payment_session_id ?? undefined,
          providerOrderId: trip.payment_session_id ? undefined : orderId,
          patch: {
            status: "cancelled",
            provider_state: "CANCELLED",
            released_at: nowIso,
            released_amount_pence: releasedAmt,
            hold_release_state: "released",
            hold_terminal_reason: "provider_cancelled",
            release_evidence_status: "CONFIRMED",
            release_evidence_source: "admin-remediate-trip-payment",
            provider_release_reference: orderId,
            provider_state_verified_at: nowIso,
            provider_state_verified_by: "admin-remediate-trip-payment",
            updated_at: nowIso,
          },
          source: "admin_remediate",
        });
        if (!ps2Result.ok) {
          console.warn("[admin-remediate-trip-payment] session close failed", ps2Result.error, sessionFilter);
        }
      }
      await supabase.from("trips").update({
        payment_hold_status: "released",
        payment_status: "released",
        updated_at: new Date().toISOString(),
      }).eq("id", trip.id);
      actionTaken = "local_reconcile_released";
      providerStateAfter = providerState;
    } else if (decision.outcome === TRIP_PAYMENT_OUTCOME.NO_ACTION_ALREADY_RESOLVED) {
      // Already captured / already released — never mutate provider or rewrite capture SSOT.
      actionTaken = "no_action_already_resolved";
      providerStateAfter = providerState;
    } else if (
      decision.outcome === TRIP_PAYMENT_OUTCOME.CAPTURE_FULL
      || decision.outcome === TRIP_PAYMENT_OUTCOME.CAPTURE_AND_RELEASE_REMAINDER
    ) {
      if (!decision.provider_mutation_allowed) {
        return jsonResponse({
          success: false,
          error: "provider_mutation_not_allowed",
          decision,
        }, 200);
      }
      // Prefer in-process Revolut capture (avoids edge-to-edge BOOT_ERROR cold starts).
      let capture: { ok: boolean; error?: string; body?: Record<string, unknown> };
      try {
        const revolutResult = await finalizeRevolutTripCapture({
          supabase,
          trip: trip as Record<string, unknown>,
          tipPence: 0,
        });
        capture = {
          ok: Boolean(revolutResult.success),
          error: revolutResult.error ?? revolutResult.message,
          body: revolutResult as unknown as Record<string, unknown>,
        };
        if (!revolutResult.success) {
          await supabase.from("trips").update({
            payment_status: "capture_failed",
            updated_at: new Date().toISOString(),
          }).eq("id", trip.id);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        capture = { ok: false, error: message };
        await supabase.from("trips").update({
          payment_status: "capture_failed",
          updated_at: new Date().toISOString(),
        }).eq("id", trip.id);
      }
      captureResult = capture;
      actionTaken = capture.ok ? "capture_invoked" : "capture_failed";
      if (orderId) {
        try {
          const merchant = await resolveRevolutMerchantContext(supabase, "live");
          const order = await retrieveRevolutOrder(merchant.environment, merchant.secretKey, orderId);
          providerStateAfter = String(order.state ?? "").toUpperCase();
        } catch { /* keep prior */ }
      }
      if (!capture.ok) {
        await supabase.from("admin_payment_audit").insert({
          action: "trip_payment_remediation_capture_failed",
          trip_id: trip.id,
          provider: "revolut",
          provider_payment_id: orderId || null,
          reason: String(capture.error ?? "capture_failed"),
          metadata: { ...auditBase, capture },
        });
        return jsonResponse({
          success: false,
          mode: "execute",
          trip_id: trip.id,
          trip_code: trip.trip_code,
          decision,
          action_taken: actionTaken,
          provider_state_before: providerState,
          provider_state_after: providerStateAfter,
          capture,
          money_moved: false,
        }, 200);
      }
    } else if (decision.outcome === TRIP_PAYMENT_OUTCOME.RELEASE_FULL_HOLD) {
      if (!decision.provider_mutation_allowed && providerState !== "CANCELLED") {
        return jsonResponse({
          success: false,
          error: "release_not_allowed",
          decision,
        }, 200);
      }
      releaseResult = await releaseHoldOnTripTerminal(supabase, {
        tripId: trip.id,
        terminalReason: "admin_remediate_zero_fee_release",
        source: "admin-remediate-trip-payment",
        idempotencyKey: `remediate_release_${trip.id}`,
        forceRelease: true,
        feePence: 0,
      });
      actionTaken = "release_invoked";
      if (orderId) {
        try {
          const merchant = await resolveRevolutMerchantContext(supabase, "live");
          const order = await retrieveRevolutOrder(merchant.environment, merchant.secretKey, orderId);
          providerStateAfter = String(order.state ?? "").toUpperCase();
        } catch { /* keep */ }
      }
    } else {
      return jsonResponse({
        success: false,
        error: "outcome_requires_manual_review",
        decision,
        money_moved: false,
      }, 200);
    }

    const { data: tripAfter } = await supabase
      .from("trips")
      .select("payment_status, payment_hold_status, capture_amount_pence, authorised_amount_pence")
      .eq("id", trip.id)
      .maybeSingle();

    await supabase.from("admin_payment_audit").insert({
      action: "trip_payment_remediation_executed",
      trip_id: trip.id,
      provider: "revolut",
      provider_payment_id: orderId || null,
      reason: decision.outcome,
      metadata: {
        ...auditBase,
        action_taken: actionTaken,
        provider_state_after: providerStateAfter,
        trip_after: tripAfter,
        captureResult,
        releaseResult,
      },
    });

    return jsonResponse({
      success: true,
      mode: "execute",
      trip_id: trip.id,
      trip_code: trip.trip_code,
      decision,
      action_taken: actionTaken,
      provider_state_before: providerState,
      provider_state_after: providerStateAfter,
      trip_after: tripAfter,
      capture: captureResult,
      release: releaseResult,
      money_moved: actionTaken.startsWith("capture") || actionTaken.startsWith("release"),
    });
  } catch (err) {
    console.error("[admin-remediate-trip-payment]", err);
    return jsonResponse({
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }, 500);
  }
});
