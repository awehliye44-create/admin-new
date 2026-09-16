/**
 * admin-recapture-trip-shortfall
 *
 * Trip History entry point for customer payment shortfall recapture.
 * Reuses create-payment-recovery / Payment Sessions recovery architecture.
 *
 * Input: { trip_id } only — never accepts arbitrary amount / customer / PI ids.
 * Server recomputes payable/capture/shortfall from current evidence.
 * Final capture success is established by provider webhook, not this response.
 *
 * Permission: payments-trip-shortfall-recapture OR super_admin only
 * (not blanket trip-history access).
 */
import {
  corsHeaders,
  jsonResponse,
  requireAdminOrStaff,
  requirePageAccess,
  type GateResult,
  type GateError,
} from "../_shared/adminPaymentGate.ts";
import {
  buildCustomerShortfallEvidence,
  evaluateRecaptureProviderCallBoundary,
  FARE_FIELD_CONTRACT,
  type CustomerShortfallSession,
} from "../_shared/customerShortfallEvidenceSSOT.ts";
import {
  deriveAdminRecaptureOutcome,
  rejectClientChargeAmountFields,
  TRIP_SHORTFALL_RECAPTURE_UI_STATE,
} from "../_shared/tripHistoryShortfallRecaptureSSOT.ts";
import { readTripFinancialModelStamp } from "../_shared/commissionWalletSSOT.ts";

async function authorizeTripShortfallRecapture(
  gate: GateResult,
): Promise<GateResult | GateError> {
  const dedicated = await requirePageAccess(gate, "payments-trip-shortfall-recapture");
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

    const gate = await authorizeTripShortfallRecapture(baseGate);
    if (!gate.ok) return gate.response;

    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, 400);
    }

    const fieldGate = rejectClientChargeAmountFields(body);
    if (!fieldGate.ok) {
      return jsonResponse({ error: fieldGate.message, code: fieldGate.code }, 400);
    }

    const tripId = typeof body.trip_id === "string" ? body.trip_id : null;
    if (!tripId) {
      return jsonResponse({ error: "trip_id is required", code: "VALIDATION_MISSING_FIELD" }, 400);
    }

    // Optional stale-request witness — must match server shortfall exactly; never charged.
    const clientExpected = body.client_expected_shortfall_pence != null
      ? Math.round(Number(body.client_expected_shortfall_pence))
      : (body.expected_shortfall_pence != null
        ? Math.round(Number(body.expected_shortfall_pence))
        : null);

    const { data: tripRow, error: tripErr } = await gate.supabase
      .from("trips")
      .select(
        "id, trip_number, status, passenger_id, service_area_id, payment_method, payment_status, "
          + "financial_model, final_customer_fare_pence, final_fare_pence, locked_base_fare_pence, "
          + "no_show_charge_pence, cancellation_fee_pence, outstanding_balance_pence, "
          + "estimated_total_pence, capture_amount_pence, tip_pence, tip_amount_pence, "
          + "airport_charge_pence, financial_outcome",
      )
      .eq("id", tripId)
      .maybeSingle();

    if (tripErr || !tripRow) {
      return jsonResponse({ error: "Trip not found", code: "TRIP_NOT_FOUND" }, 404);
    }

    // Wide select strings defeat generated row typing — treat as an untyped record.
    // deno-lint-ignore no-explicit-any
    const trip = tripRow as unknown as Record<string, any>;

    const financialModel = readTripFinancialModelStamp(
      trip.financial_model as string | null,
    );
    if (!financialModel) {
      return jsonResponse({
        error: "Trip financial_model is missing",
        code: "FINANCIAL_MODEL_VIOLATION",
      }, 409);
    }

    const { data: captureSessions } = await gate.supabase
      .from("payment_sessions")
      .select(
        "id, purpose, captured_amount_pence, status, provider_state, refunded_amount_pence, "
          + "customer_id, provider_order_id",
      )
      .eq("trip_id", trip.id);

    const { count: openRecoveryCount } = await gate.supabase
      .from("payment_sessions")
      .select("id", { count: "exact", head: true })
      .eq("trip_id", trip.id)
      .eq("purpose", "PAYMENT_RECOVERY")
      .in("status", ["RECOVERY_CHECKOUT_CREATED", "CUSTOMER_ACTION_REQUIRED"]);

    const hasOpenRecovery = (openRecoveryCount ?? 0) > 0;

    const evidence = buildCustomerShortfallEvidence({
      final_customer_fare_pence: trip.final_customer_fare_pence,
      final_fare_pence: trip.final_fare_pence,
      locked_base_fare_pence: trip.locked_base_fare_pence,
      tip_pence: trip.tip_pence,
      tip_amount_pence: trip.tip_amount_pence,
      airport_charge_pence: trip.airport_charge_pence,
      no_show_charge_pence: trip.no_show_charge_pence,
      cancellation_fee_pence: trip.cancellation_fee_pence,
      outstanding_balance_pence: trip.outstanding_balance_pence,
      payment_status: trip.payment_status,
      financial_outcome: trip.financial_outcome,
      status: trip.status,
      financial_model: financialModel,
      payment_method: trip.payment_method,
      capture_amount_pence: trip.capture_amount_pence,
      fare_field_contract: FARE_FIELD_CONTRACT.TIP_EXCLUSIVE_FINAL,
      sessions: (captureSessions ?? []) as unknown as CustomerShortfallSession[],
      hasOpenRecoveryAttempt: hasOpenRecovery,
      adminPermitted: true,
      client_expected_shortfall_pence: clientExpected,
      passenger_id: trip.passenger_id,
    });

    const boundary = evaluateRecaptureProviderCallBoundary(evidence);
    const outstanding = evidence.outstanding_shortfall_pence;

    if (!boundary.allow_provider_call) {
      if (boundary.reject_code === "NO_SHORTFALL_DUE" || (outstanding ?? 0) <= 0) {
        return jsonResponse({
          success: true,
          code: "NO_SHORTFALL_DUE",
          message: "No outstanding amount to recapture. Payment state is up to date.",
          trip_id: tripId,
          ui_state: TRIP_SHORTFALL_RECAPTURE_UI_STATE.FULLY_PAID,
          outstanding_shortfall_pence: 0,
          customer_payable_pence: evidence.authoritative_customer_payable_pence,
          payable_source: evidence.payable_source,
          verified_captured_pence: evidence.verified_captured_pence,
          provider_attempt_created: false,
        });
      }
      return jsonResponse({
        error: evidence.unavailable_reason ?? boundary.reject_code ?? "Recapture not available",
        code: String(boundary.reject_code ?? "NOT_ELIGIBLE").toUpperCase(),
        ui_state: evidence.recapture_ui_state,
        outstanding_shortfall_pence: outstanding,
        customer_payable_pence: evidence.authoritative_customer_payable_pence,
        payable_source: evidence.payable_source,
        provider_attempt_created: false,
      }, 409);
    }

    // Authoritative parent session: exact trip + customer, non-recovery.
    const { data: parentSession } = await gate.supabase
      .from("payment_sessions")
      .select("id, customer_id, trip_id, status, purpose")
      .eq("trip_id", trip.id)
      .eq("customer_id", trip.passenger_id)
      .neq("purpose", "PAYMENT_RECOVERY")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const authHeader = req.headers.get("Authorization") ?? "";
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonOrServiceKey =
      Deno.env.get("SUPABASE_ANON_KEY")
      ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
      ?? "";

    // Provider boundary — only reached when allow_provider_call is true.
    const recoveryRes = await fetch(`${supabaseUrl}/functions/v1/create-payment-recovery`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
        ...(anonOrServiceKey ? { apikey: anonOrServiceKey } : {}),
      },
      body: JSON.stringify({
        trip_id: trip.id,
        parent_session_id: parentSession?.id ?? null,
        action_mode: "collect_outstanding",
        source: "trip_history_shortfall_recapture",
        admin_user_id: gate.userId,
      }),
    });

    const recoveryText = await recoveryRes.text();
    let recoveryJson: Record<string, unknown> = {};
    try {
      recoveryJson = recoveryText ? JSON.parse(recoveryText) as Record<string, unknown> : {};
    } catch {
      recoveryJson = {};
    }

    if (
      !recoveryRes.ok
      && String(recoveryJson.code ?? recoveryJson.error_code ?? "") === "ALREADY_FULLY_CAPTURED"
    ) {
      return jsonResponse({
        success: true,
        status: TRIP_SHORTFALL_RECAPTURE_UI_STATE.FULLY_PAID,
        requires_customer_action: false,
        saved_card_charged: false,
        checkout_url: null,
        payment_session_id: null,
        provider_order_id: null,
        outstanding_shortfall_pence: 0,
        charged_pence: 0,
        customer_payable_pence: evidence.authoritative_customer_payable_pence,
        verified_captured_pence: evidence.verified_captured_pence,
        net_refunded_pence: evidence.verified_refunded_pence,
        reused: false,
        already_completed: true,
        provider_attempt_created: false,
        message: String(
          recoveryJson.message
            ?? "Payment is already fully captured with the provider. The trip has been re-synced — no further charge is due.",
        ),
      });
    }

    if (!recoveryRes.ok) {
      const bootFailed =
        recoveryRes.status === 546
        || /worker boot error|does not provide an export named/i.test(recoveryText);
      const code = bootFailed
        ? "RECOVERY_FUNCTION_UNAVAILABLE"
        : String(recoveryJson.code ?? recoveryJson.error_code ?? "RECOVERY_FAILED");
      const message = bootFailed
        ? "Payment recovery service failed to start. No provider charge was created. Retry after the recovery function is repaired."
        : String(
          recoveryJson.message
            ?? recoveryJson.error
            ?? "Recovery creation failed",
        );
      return jsonResponse({
        success: false,
        code,
        error: message,
        message,
        retryable: bootFailed || recoveryRes.status >= 500,
        attempt_id: null,
        provider_attempt_created: false,
        payment_session_id: null,
        outstanding_shortfall_pence: outstanding,
        details: Object.keys(recoveryJson).length > 0
          ? {
            recovery_status: recoveryRes.status,
            recovery_code: recoveryJson.code ?? recoveryJson.error_code ?? null,
          }
          : { recovery_status: recoveryRes.status },
      }, bootFailed ? 503 : (recoveryRes.status >= 400 ? recoveryRes.status : 500));
    }

    await gate.supabase.from("admin_payment_audit").insert({
      trip_id: trip.id,
      admin_user_id: gate.userId,
      action: "extra_payment",
      reason: "trip_history_shortfall_recapture",
      amount_pence_before: evidence.verified_net_captured_pence,
      amount_pence_after: evidence.verified_net_captured_pence,
      delta_pence: 0,
      provider: "revolut",
      provider_payment_id: recoveryJson.provider_order_id ?? null,
      metadata: {
        source: "admin-recapture-trip-shortfall",
        payment_session_id: recoveryJson.payment_session_id ?? null,
        customer_id: trip.passenger_id,
        outstanding_shortfall_pence: outstanding,
        customer_payable_pence: evidence.authoritative_customer_payable_pence,
        payable_source: evidence.payable_source,
        verified_captured_pence: evidence.verified_captured_pence,
        net_refunded_pence: evidence.verified_refunded_pence,
        parent_session_id: parentSession?.id ?? null,
        reused: !!recoveryJson.reused || hasOpenRecovery,
        already_completed: !!recoveryJson.already_completed,
        idempotency_key: parentSession?.id
          ? `recover:${trip.id}:${parentSession.id}:${outstanding ?? 0}`
          : `recover:${trip.id}:${outstanding ?? 0}`,
        idempotency_note: "final_success_via_provider_webhook_only",
      },
    });

    const outcome = deriveAdminRecaptureOutcome({
      saved_card_charged: recoveryJson.saved_card_charged,
      requires_customer_action: recoveryJson.requires_customer_action,
      checkout_url: recoveryJson.checkout_url,
      status: recoveryJson.status,
      already_completed: recoveryJson.already_completed,
      reused: recoveryJson.reused === true || hasOpenRecovery,
      message: recoveryJson.message,
      saved_card_error: recoveryJson.saved_card_error,
      saved_card_state: recoveryJson.saved_card_state,
    });

    return jsonResponse({
      success: true,
      status: outcome.status,
      requires_customer_action: outcome.requires_customer_action,
      saved_card_charged: outcome.saved_card_charged,
      saved_card_attempted: recoveryJson.saved_card_attempted === true,
      saved_card_error: recoveryJson.saved_card_error ?? null,
      saved_card_state: recoveryJson.saved_card_state ?? null,
      checkout_url: recoveryJson.checkout_url ?? null,
      payment_session_id: recoveryJson.payment_session_id ?? null,
      provider_order_id: recoveryJson.provider_order_id ?? null,
      outstanding_shortfall_pence: outstanding,
      charged_pence: outstanding,
      customer_payable_pence: evidence.authoritative_customer_payable_pence,
      payable_source: evidence.payable_source,
      verified_captured_pence: evidence.verified_captured_pence,
      net_refunded_pence: evidence.verified_refunded_pence,
      reused: outcome.reused,
      already_completed: outcome.already_completed,
      provider_attempt_created: true,
      message: outcome.message
        ?? (outcome.saved_card_charged
          ? "Saved card charged off-session — awaiting provider webhook confirmation."
          : (outcome.requires_customer_action
            ? "Recapture checkout created — awaiting customer action and provider webhook confirmation."
            : "Recapture accepted for processing — provider webhook remains authoritative for capture success.")),
    });
  } catch (e) {
    console.error("[admin-recapture-trip-shortfall]", e);
    return jsonResponse({ error: (e as Error).message ?? String(e) }, 500);
  }
});
