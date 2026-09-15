import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  fetchTripAndBroadcastUpdated,
  invokePreauthUpdateOnModification,
  upsertTripRoutePolyline,
} from "../_shared/tripModificationApply.ts";
import {
  decideFromPreauthInvokeResult,
  isAlreadyAppliedModification,
} from "../_shared/tripModificationPaymentGateSSOT.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function isCashPaymentMethod(method: unknown): boolean {
  const m = String(method ?? "").toLowerCase();
  return m === "cash" || m === "cash_only" || m.includes("cash");
}

function json(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ error: "Missing authorization" }, 401);
    }

    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { data: { user }, error: userError } = await supabaseUser.auth.getUser();
    if (userError || !user) {
      return json({ error: "Unauthorized" }, 401);
    }

    const body = await req.json();
    const requestId = body.requestId ?? body.request_id;
    if (!requestId) {
      return json({ error: "requestId is required" }, 400);
    }

    const { data: changeRequest, error: requestError } = await supabase
      .from("trip_change_requests")
      .select("*, trips(*)")
      .eq("id", requestId)
      .single();

    if (requestError || !changeRequest) {
      return json({ error: "Modification request not found" }, 404);
    }

    const trip = changeRequest.trips as Record<string, unknown>;
    const { data: customer } = await supabase
      .from("customers")
      .select("id, user_id")
      .eq("user_id", user.id)
      .single();

    if (!customer || trip.passenger_id !== customer.id) {
      return json({ error: "Not authorized" }, 403);
    }

    // Idempotent duplicate confirmation — never re-add the fare delta.
    if (isAlreadyAppliedModification(changeRequest.status)) {
      return json({
        success: true,
        requestId,
        status: changeRequest.status,
        paymentStatus: changeRequest.payment_status,
        requiresApproval: changeRequest.requires_approval,
        navigationImpacted: changeRequest.navigation_impacted,
        alreadyConfirmed: true,
        alreadyApplied: true,
      });
    }

    if (!["payment_required", "payment_pending", "payment_confirmed"].includes(changeRequest.status)) {
      if (["pending_driver_approval", "approved"].includes(changeRequest.status)) {
        return json({
          success: true,
          requestId,
          status: changeRequest.status,
          paymentStatus: changeRequest.payment_status,
          requiresApproval: changeRequest.requires_approval,
          navigationImpacted: changeRequest.navigation_impacted,
          alreadyConfirmed: true,
        });
      }
      return json({
        error: "Request is not awaiting payment confirmation",
        currentStatus: changeRequest.status,
      }, 400);
    }

    const fareDelta = Number(changeRequest.fare_delta_pence ?? 0);
    if (fareDelta <= 0) {
      const { data: advanced, error: advanceError } = await supabase.rpc(
        "advance_trip_change_after_payment",
        { p_request_id: requestId },
      );
      if (advanceError) throw advanceError;
      return json({
        success: true,
        requestId,
        status: advanced?.status ?? "applied",
        paymentStatus: "not_required",
      });
    }

    // MODIFICATION_REQUESTED → PAYMENT_PENDING (do not mutate trip yet).
    await supabase
      .from("trip_change_requests")
      .update({
        status: "payment_pending",
        payment_status: "pending",
        updated_at: new Date().toISOString(),
      })
      .eq("id", requestId)
      .in("status", ["payment_required", "payment_pending"]);

    const newFarePence = Number(
      changeRequest.new_fare_pence
        ?? (trip.final_customer_fare_pence as number)
        ?? (trip.estimated_total_pence as number)
        ?? 0,
    );

    if (!newFarePence || newFarePence <= 0) {
      await supabase
        .from("trip_change_requests")
        .update({
          status: "payment_failed",
          payment_status: "failed",
          rejection_reason: "Payable total missing for paid trip modification",
          updated_at: new Date().toISOString(),
        })
        .eq("id", requestId);
      return json({
        success: false,
        error: "Payment confirmation failed",
        details: "Payable total missing for paid trip modification",
        status: "payment_failed",
        requestId,
        paymentProcessing: false,
      }, 402);
    }

    let gate = decideFromPreauthInvokeResult({
      success: false,
      requiredPayablePence: newFarePence,
      authorisedAmountPence: 0,
      paymentCoverageStatus: "authorization_insufficient",
    });

    if (isCashPaymentMethod(trip.payment_method)) {
      console.log("TRIP_MOD_PAYMENT_CASH_CONFIRMED", { requestId, tripId: trip.id, fareDelta });
      gate = {
        phase: "PROVIDER_CONFIRMED",
        mayApply: true,
        paymentStatus: "confirmed",
        requestStatus: "payment_confirmed",
        authorisedTotalPence: newFarePence,
      };
    } else {
      let preauthResult: Record<string, unknown> | null = null;
      try {
        preauthResult = await invokePreauthUpdateOnModification(
          supabase,
          String(trip.id),
          newFarePence,
        ) as Record<string, unknown> | null;
      } catch (invokeErr) {
        const message = invokeErr instanceof Error ? invokeErr.message : String(invokeErr);
        gate = decideFromPreauthInvokeResult({
          success: false,
          requiredPayablePence: newFarePence,
          authorisedAmountPence: 0,
          paymentCoverageStatus: "authorization_reconciliation_pending",
          errorCode: /timeout/i.test(message)
            ? "TIMEOUT"
            : /network|fetch/i.test(message)
            ? "NETWORK"
            : "AUTHORISATION_RECONCILIATION_PENDING",
          warning: message,
        });
        preauthResult = null;
      }

      if (preauthResult) {
        gate = decideFromPreauthInvokeResult({
          success: preauthResult.success === true,
          skipped: preauthResult.skipped === true,
          paymentCoverageStatus: typeof preauthResult.payment_coverage_status === "string"
            ? preauthResult.payment_coverage_status
            : null,
          authorisedAmountPence: Number(
            preauthResult.authorised_amount_pence
              ?? preauthResult.total_authorized_amount_pence
              ?? preauthResult.amount_capturable
              ?? 0,
          ),
          requiredPayablePence: newFarePence,
          errorCode: typeof preauthResult.error_code === "string"
            ? preauthResult.error_code
            : null,
          warning: typeof preauthResult.warning === "string"
            ? preauthResult.warning
            : typeof preauthResult.error === "string"
            ? preauthResult.error
            : null,
        });
      }
    }

    if (!gate.mayApply) {
      const pending = gate.phase === "PAYMENT_PENDING";
      await supabase
        .from("trip_change_requests")
        .update({
          status: gate.requestStatus,
          payment_status: gate.paymentStatus,
          rejection_reason: pending
            ? `payment_${gate.reason}`
            : `payment_${gate.reason}`,
          updated_at: new Date().toISOString(),
        })
        .eq("id", requestId);

      console.log(pending ? "TRIP_MOD_PAYMENT_PENDING" : "TRIP_MOD_PAYMENT_FAILED", {
        requestId,
        tripId: trip.id,
        phase: gate.phase,
        reason: gate.reason,
        authorised: gate.authorisedTotalPence,
        required: newFarePence,
      });

      // Trip destination / fare / financial snapshot remain unchanged.
      return json({
        success: false,
        error: pending
          ? "Payment is still processing. Your trip has not been changed."
          : "Payment confirmation failed",
        status: gate.requestStatus,
        paymentStatus: gate.paymentStatus,
        paymentProcessing: pending,
        paymentPhase: gate.phase,
        authorisedTotalPence: gate.authorisedTotalPence,
        requiredPayablePence: newFarePence,
        requestId,
        tripUnchanged: true,
      }, pending ? 202 : 402);
    }

    // PROVIDER_CONFIRMED → single DB transaction claim+apply (atomic).
    const expectedPrevious = Number(changeRequest.original_fare_pence ?? 0);
    const expectedTripStatus = String(trip.status ?? "").toLowerCase();
    const { data: claimResult, error: claimError } = await supabase.rpc(
      "claim_and_apply_fare_increase_modification",
      {
        p_trip_id: trip.id,
        p_request_id: requestId,
        p_expected_original_fare_pence: expectedPrevious,
        p_expected_trip_status: expectedTripStatus,
        p_required_authorised_total_pence: newFarePence,
        p_provider_confirmed: true,
        p_authorised_total_pence: gate.authorisedTotalPence,
      },
    );

    if (claimError) {
      const msg = String(claimError.message ?? claimError.details ?? "");
      const code = msg.includes("ALREADY_APPLIED")
        ? "ALREADY_APPLIED"
        : msg.includes("PAYMENT_NOT_CONFIRMED")
        ? "PAYMENT_NOT_CONFIRMED"
        : msg.includes("STALE_MODIFICATION")
        ? "STALE_MODIFICATION"
        : "CLAIM_FAILED";

      console.error("TRIP_MOD_ATOMIC_CLAIM_FAILED", { requestId, tripId: trip.id, code, msg });

      if (code === "ALREADY_APPLIED") {
        return json({
          success: true,
          requestId,
          status: "applied",
          paymentStatus: "confirmed",
          paymentPhase: "MODIFICATION_APPLIED",
          alreadyConfirmed: true,
          alreadyApplied: true,
        });
      }

      if (code === "PAYMENT_NOT_CONFIRMED") {
        await supabase
          .from("trip_change_requests")
          .update({
            status: "payment_pending",
            payment_status: "pending",
            rejection_reason: "payment_not_confirmed_at_claim",
            updated_at: new Date().toISOString(),
          })
          .eq("id", requestId)
          .in("status", ["payment_required", "payment_pending", "payment_confirmed"]);

        return json({
          success: false,
          error: "Payment is still processing. Your trip has not been changed.",
          status: "payment_pending",
          paymentStatus: "pending",
          paymentProcessing: true,
          paymentPhase: "PAYMENT_PENDING",
          requestId,
          tripUnchanged: true,
        }, 202);
      }

      return json({
        success: false,
        error: "Trip fare changed before this modification could apply. Re-check fare impact.",
        status: "payment_failed",
        claimCode: code,
        requestId,
        tripUnchanged: true,
        concurrentOrStale: true,
      }, 409);
    }

    const claim = (claimResult ?? {}) as Record<string, unknown>;
    const claimCode = String(claim.code ?? "MODIFICATION_APPLIED");
    const finalStatus = String(claim.request_status ?? "applied");

    let updatedTrip: Record<string, unknown> | null = null;
    let tripUpdated: Record<string, unknown> | null = null;

    if (
      claimCode === "MODIFICATION_APPLIED"
      || claimCode === "ALREADY_APPLIED"
      || finalStatus === "applied"
      || finalStatus === "approved"
    ) {
      const afterSnapshot = (changeRequest.after_route_snapshot ?? {}) as Record<string, unknown>;
      const farePreview = afterSnapshot.fare_preview as Record<string, unknown> | undefined;
      const polyline =
        typeof farePreview?.polyline === "string" ? farePreview.polyline : null;

      const broadcastResult = await fetchTripAndBroadcastUpdated(
        supabase,
        String(trip.id),
        polyline,
        { changeRequestId: requestId },
      );
      updatedTrip = broadcastResult?.trip ?? null;
      tripUpdated = broadcastResult?.payload ?? null;
      if (updatedTrip) {
        await upsertTripRoutePolyline(supabase, String(trip.id), polyline, updatedTrip);
      }
    }

    const { data: latest } = await supabase
      .from("trip_change_requests")
      .select("status, payment_status, requires_approval, navigation_impacted")
      .eq("id", requestId)
      .single();

    console.log("TRIP_MOD_PAYMENT_CONFIRMED", {
      requestId,
      tripId: trip.id,
      status: latest?.status ?? finalStatus,
      claimCode,
      navigationImpacted: latest?.navigation_impacted,
      authorisedTotalPence: gate.authorisedTotalPence,
    });

    return json({
      success: true,
      requestId,
      status: latest?.status ?? finalStatus,
      paymentStatus: latest?.payment_status ?? "confirmed",
      paymentPhase: "MODIFICATION_APPLIED",
      claimCode,
      alreadyApplied: claimCode === "ALREADY_APPLIED",
      requiresApproval: latest?.requires_approval ?? false,
      navigationImpacted: latest?.navigation_impacted ?? false,
      trip: updatedTrip,
      tripUpdated,
    });
  } catch (error) {
    console.error("confirm-trip-modification-payment error:", error);
    return json({
      error: "Internal server error",
      details: error instanceof Error ? error.message : "Unknown error",
    }, 500);
  }
});
