/**
 * admin-recapture-trip-shortfall
 *
 * Trip History entry point for customer payment shortfall recapture.
 * Reuses create-payment-recovery / Payment Sessions recovery architecture.
 *
 * Input: { trip_id } only — never accepts arbitrary amount / customer / PI ids.
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
  computeOutstandingBalancePence,
  resolveCanonicalCustomerPayablePence,
} from "../../../shared/paymentSessionsCaptureConfirmationSSOT.ts";
import {
  evaluateTripHistoryShortfallRecaptureEligibility,
  isPlatformCollectedEligible,
  rejectClientChargeAmountFields,
  sumVerifiedCapturedFromSessions,
} from "../../../shared/tripHistoryShortfallRecaptureSSOT.ts";

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

  // Legacy JWT admin without staff_profiles is treated as super_admin by page gate.
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

    const { data: trip, error: tripErr } = await gate.supabase
      .from("trips")
      .select(
        "id, trip_number, status, passenger_id, service_area_id, payment_method, payment_status, "
          + "financial_model, final_customer_fare_pence, final_fare_pence, no_show_charge_pence, "
          + "cancellation_fee_pence, outstanding_balance_pence, estimated_total_pence, capture_amount_pence",
      )
      .eq("id", tripId)
      .maybeSingle();

    if (tripErr || !trip) {
      return jsonResponse({ error: "Trip not found", code: "TRIP_NOT_FOUND" }, 404);
    }

    let financialModel = trip.financial_model ?? null;
    if (!financialModel && trip.service_area_id) {
      const { data: sa } = await gate.supabase
        .from("service_areas")
        .select("financial_model")
        .eq("id", trip.service_area_id)
        .maybeSingle();
      financialModel = sa?.financial_model ?? null;
    }

    if (!isPlatformCollectedEligible(financialModel)) {
      return jsonResponse({
        error: "Only PLATFORM_COLLECTED trips may use Trip History shortfall recapture",
        code: "DRIVER_COLLECTED_NOT_ALLOWED",
      }, 409);
    }

    const payableResolved = resolveCanonicalCustomerPayablePence({
      finalCustomerFarePence: trip.final_customer_fare_pence,
      finalFarePence: trip.final_fare_pence,
      noShowChargePence: trip.no_show_charge_pence,
      cancellationFeePence: trip.cancellation_fee_pence,
      outstandingBalancePence: trip.outstanding_balance_pence,
      estimatedTotalPence: trip.estimated_total_pence,
    });

    const { data: captureSessions } = await gate.supabase
      .from("payment_sessions")
      .select("id, purpose, captured_amount_pence, status, provider_state")
      .eq("trip_id", trip.id);

    const verified = sumVerifiedCapturedFromSessions(captureSessions ?? []);
    // Trip projection fallback only when no verified session captures exist.
    let originalCaptured = verified.original_captured_pence;
    const recoveryCaptured = verified.recaptured_pence;
    if (originalCaptured <= 0 && Number(trip.capture_amount_pence ?? 0) > 0) {
      // Only use trip projection when payment_status does not look canceled/failed.
      const ps = String(trip.payment_status ?? "").toLowerCase();
      if (!ps.includes("cancel") && !ps.includes("fail") && !ps.includes("void")) {
        originalCaptured = Math.round(Number(trip.capture_amount_pence));
      }
    }

    const outstanding = computeOutstandingBalancePence({
      canonicalPayablePence: payableResolved.payable_pence,
      confirmedCapturePence: originalCaptured,
      confirmedRecoveryCapturePence: recoveryCaptured,
    });

    const { count: openRecoveryCount } = await gate.supabase
      .from("payment_sessions")
      .select("id", { count: "exact", head: true })
      .eq("trip_id", trip.id)
      .eq("purpose", "PAYMENT_RECOVERY")
      .in("status", ["RECOVERY_CHECKOUT_CREATED", "CUSTOMER_ACTION_REQUIRED"]);

    const eligibility = evaluateTripHistoryShortfallRecaptureEligibility({
      tripStatus: trip.status,
      financialModel,
      paymentMethod: trip.payment_method,
      customerPayablePence: payableResolved.payable_pence,
      verifiedCapturedTotalPence: originalCaptured + recoveryCaptured,
      hasOpenRecoveryAttempt: (openRecoveryCount ?? 0) > 0,
      adminPermitted: true,
    });

    if (!eligibility.eligible) {
      return jsonResponse({
        error: eligibility.reject_reason ?? "Recapture not available",
        code: String(eligibility.reject_reason ?? "NOT_ELIGIBLE").toUpperCase(),
        ui_state: eligibility.ui_state,
        outstanding_shortfall_pence: eligibility.outstanding_shortfall_pence ?? outstanding,
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

    if (parentSession && parentSession.customer_id !== trip.passenger_id) {
      return jsonResponse({
        error: "Payment session customer does not match trip passenger",
        code: "SESSION_CUSTOMER_MISMATCH",
      }, 409);
    }

    const authHeader = req.headers.get("Authorization") ?? "";
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const recoveryRes = await fetch(`${supabaseUrl}/functions/v1/create-payment-recovery`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      body: JSON.stringify({
        trip_id: trip.id,
        parent_session_id: parentSession?.id ?? null,
        action_mode: "collect_outstanding",
        source: "trip_history_shortfall_recapture",
        admin_user_id: gate.userId,
      }),
    });

    const recoveryJson = await recoveryRes.json().catch(() => ({}));
    if (!recoveryRes.ok) {
      return jsonResponse({
        error: recoveryJson.error ?? recoveryJson.message ?? "Recovery creation failed",
        code: recoveryJson.code ?? recoveryJson.error_code ?? "RECOVERY_FAILED",
        details: recoveryJson,
      }, recoveryRes.status >= 400 ? recoveryRes.status : 500);
    }

    await gate.supabase.from("admin_payment_audit").insert({
      trip_id: trip.id,
      admin_user_id: gate.userId,
      action: "extra_payment",
      reason: "trip_history_shortfall_recapture",
      amount_pence_before: originalCaptured + recoveryCaptured,
      amount_pence_after: originalCaptured + recoveryCaptured,
      delta_pence: 0,
      provider: "revolut",
      provider_payment_id: recoveryJson.provider_order_id ?? null,
      metadata: {
        source: "admin-recapture-trip-shortfall",
        payment_session_id: recoveryJson.payment_session_id ?? null,
        customer_id: trip.passenger_id,
        outstanding_shortfall_pence: outstanding,
        effective_paid_before_pence: originalCaptured + recoveryCaptured,
        canonical_payable_pence: payableResolved.payable_pence,
        original_captured_pence: originalCaptured,
        recaptured_pence_before: recoveryCaptured,
        parent_session_id: parentSession?.id ?? null,
        reused: !!recoveryJson.reused,
        already_completed: !!recoveryJson.already_completed,
        idempotency_key: parentSession?.id
          ? `recover:${trip.id}:${parentSession.id}:${outstanding ?? 0}`
          : `recover:${trip.id}:${outstanding ?? 0}`,
        idempotency_note: "final_success_via_provider_webhook_only",
      },
    });

    const requiresCustomerAction = !!(
      recoveryJson.checkout_url
      || recoveryJson.requires_customer_action
      || recoveryJson.status === "CUSTOMER_ACTION_REQUIRED"
      || recoveryJson.status === "RECOVERY_CHECKOUT_CREATED"
    );

    return jsonResponse({
      success: true,
      status: requiresCustomerAction ? "customer_action_required" : "processing",
      requires_customer_action: requiresCustomerAction,
      checkout_url: recoveryJson.checkout_url ?? null,
      payment_session_id: recoveryJson.payment_session_id ?? null,
      provider_order_id: recoveryJson.provider_order_id ?? null,
      outstanding_shortfall_pence: outstanding,
      charged_pence: recoveryJson.amount ?? outstanding,
      original_captured_pence: originalCaptured,
      recaptured_pence_before: recoveryCaptured,
      reused: !!recoveryJson.reused,
      already_completed: !!recoveryJson.already_completed,
      message: recoveryJson.message
        ?? (requiresCustomerAction
          ? "Recapture checkout created — awaiting customer action and provider webhook confirmation."
          : "Recapture accepted for processing — provider webhook remains authoritative for capture success."),
    });
  } catch (e) {
    console.error("[admin-recapture-trip-shortfall]", e);
    return jsonResponse({ error: (e as Error).message ?? String(e) }, 500);
  }
});
