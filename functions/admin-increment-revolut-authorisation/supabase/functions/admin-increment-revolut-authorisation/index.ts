/**
 * admin-increment-revolut-authorisation
 *
 * Restricted Admin action: same-order Revolut incremental authorisation.
 * Never creates a second provider order. Never called from the browser to Revolut directly.
 *
 * Permission: payments-increment-authorisation OR super_admin
 */
import {
  corsHeaders,
  jsonResponse,
  requireAdminOrStaff,
  requirePageAccess,
  type GateResult,
  type GateError,
} from "../_shared/adminPaymentGate.ts";
import { getRevolutMerchantConfig, retrieveRevolutOrder, revolutProviderAuthorisedTotalPence } from "../_shared/revolutOrders.ts";
import { executeSameOrderIncrement } from "../_shared/executeSameOrderIncrementSSOT.ts";
import {
  evaluateRevolutIncrementEligibility,
  REVOLUT_MAX_INCREMENTS_PER_ORDER,
  REVOLUT_MAX_INCREMENT_MULTIPLIER,
} from "../_shared/revolutIncrementAuthorisationSSOT.ts";

async function authorizeIncrement(
  gate: GateResult,
): Promise<GateResult | GateError> {
  const dedicated = await requirePageAccess(gate, "payments-increment-authorisation");
  if (dedicated.ok) return dedicated;

  const { data: staffRow } = await gate.supabase
    .from("staff_profiles")
    .select("role")
    .eq("user_id", gate.userId)
    .eq("is_active", true)
    .maybeSingle();

  const role = staffRow?.role ? String(staffRow.role) : "super_admin";
  if (role === "super_admin") return gate;
  return dedicated;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  try {
    const baseGate = await requireAdminOrStaff(req);
    if (!baseGate.ok) return baseGate.response;
    const gate = await authorizeIncrement(baseGate);
    if (!gate.ok) return gate.response;

    const body = await req.json().catch(() => ({}));
    const paymentSessionId = typeof body.payment_session_id === "string"
      ? body.payment_session_id
      : null;
    const targetTotal = Math.round(Number(body.target_total_authorised_pence ?? body.target_fare_pence ?? 0));
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";

    if (!paymentSessionId) {
      return jsonResponse({ error: "payment_session_id is required" }, 400);
    }
    if (!Number.isFinite(targetTotal) || targetTotal < 1) {
      return jsonResponse({ error: "target_total_authorised_pence is required" }, 400);
    }
    if (!reason || reason.length < 3) {
      return jsonResponse({ error: "reason is required" }, 400);
    }

    const { data: session, error: sessErr } = await gate.supabase
      .from("payment_sessions")
      .select(
        "id, trip_id, provider_order_id, authorised_amount_pence, total_authorised_amount_pence, "
          + "captured_amount_pence, currency, purpose, financial_operation_state",
      )
      .eq("id", paymentSessionId)
      .maybeSingle();

    if (sessErr || !session) {
      return jsonResponse({ error: "Payment session not found" }, 404);
    }
    if (!session.provider_order_id) {
      return jsonResponse({ error: "Payment session has no provider order" }, 409);
    }
    if (String(session.purpose ?? "") === "PAYMENT_RECOVERY") {
      return jsonResponse({
        error: "Cannot increment a recovery session; use the parent booking session",
      }, 409);
    }

    const { secretKey, environment } = getRevolutMerchantConfig();
    const order = await retrieveRevolutOrder(
      environment,
      secretKey,
      String(session.provider_order_id),
    );
    const providerTotal = revolutProviderAuthorisedTotalPence(order);
    const initial = Math.round(Number(session.authorised_amount_pence ?? providerTotal));
    const eligibility = evaluateRevolutIncrementEligibility({
      order,
      targetTotalAuthorisedPence: targetTotal,
      initialAuthorisedPence: initial,
    });

    if (body.preview_only === true) {
      return jsonResponse({
        preview: true,
        eligible: eligibility.eligible,
        reason: eligibility.reason,
        provider_confirmed_authorised_total_pence: providerTotal,
        original_hold_pence: initial,
        target_total_authorised_pence: targetTotal,
        max_provider_eligible_target_pence: eligibility.maxTargetTotalPence,
        increment_count: eligibility.incrementCount,
        max_increments: REVOLUT_MAX_INCREMENTS_PER_ORDER,
        max_multiplier: REVOLUT_MAX_INCREMENT_MULTIPLIER,
        payment_method_type: eligibility.paymentMethodType,
        financial_operation_state: session.financial_operation_state ?? "IDLE",
      });
    }

    if (!eligibility.eligible && eligibility.reason !== "target_not_above_current") {
      return jsonResponse({
        error: `Order not eligible for increment: ${eligibility.reason}`,
        code: eligibility.reason.toUpperCase(),
        eligible: false,
        provider_confirmed_authorised_total_pence: providerTotal,
      }, 409);
    }

    const result = await executeSameOrderIncrement({
      supabase: gate.supabase,
      environment,
      secretKey,
      paymentSessionId: String(session.id),
      providerOrderId: String(session.provider_order_id),
      requiredTotalPence: targetTotal,
      currency: String(session.currency ?? order.currency ?? "GBP"),
      source: "admin_increment",
      reason,
      owner: `admin:${gate.userId}`,
    });

    if (!result.ok) {
      return jsonResponse({
        success: false,
        error: result.message,
        code: result.errorClassification,
        kind: result.kind,
        provider_confirmed_authorised_total_pence: result.providerConfirmedTotalPence,
      }, result.kind === "declined" ? 402 : 409);
    }

    return jsonResponse({
      success: true,
      kind: result.kind,
      provider_confirmed_authorised_total_pence: result.providerConfirmedTotalPence,
      sequence_number: result.sequenceNumber,
      business_key: result.businessKey,
      trip_id: session.trip_id,
    });
  } catch (error) {
    console.error("[admin-increment-revolut-authorisation]", error);
    return jsonResponse({
      error: error instanceof Error ? error.message : String(error),
    }, 500);
  }
});
