/**
 * submit-customer-trip-tip — one-shot passenger tip after trip completion.
 *
 * Hard rules:
 * - Requires service_areas.tips_enabled (positive tip)
 * - Customer App channel only (WhatsApp / guest / corporate excluded)
 * - Only after status=completed and within tip window
 * - tip_amount_pence >= 0; one-shot only (no duplicate tip transaction)
 * - Tip is non-commissionable (finalize/settlement SSOT)
 * - Capture fare (+ tip when tip > 0) then close tip window
 * - On capture failure: revert tip claim and leave window open for retry
 */

import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { invokeFinalizeTripCapture } from "../_shared/invokeFinalizeTripCapture.ts";
import { isCustomerAppTipChannelEligible } from "../_shared/tipChannelEligibilitySSOT.ts";
import { TIP_WINDOW_STATUS } from "../../../shared/tipWindowConstants.ts";
import {
  isTipWindowOpen,
  recordedTipPenceAfterCapture,
  tipWindowCloseAllowedAfterFinalize,
} from "../../../shared/tripPaymentFinalised.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function nonNegInt(value: unknown): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    if (!supabaseUrl || !serviceRoleKey) {
      return json({ success: false, error: "Server misconfigured", error_code: "CONFIG" }, 500);
    }

    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.toLowerCase().startsWith("bearer ")) {
      return json({ success: false, error: "Unauthorized", error_code: "UNAUTHORIZED" }, 401);
    }

    const userClient = createClient(supabaseUrl, anonKey || serviceRoleKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });
    const {
      data: { user },
      error: userErr,
    } = await userClient.auth.getUser();
    if (userErr || !user) {
      return json({ success: false, error: "Unauthorized", error_code: "UNAUTHORIZED" }, 401);
    }

    const body = await req.json().catch(() => ({}));
    const tripId = String(body.trip_id ?? body.tripId ?? "").trim();
    let tipAmountPence = nonNegInt(body.tip_amount_pence ?? body.tipAmountPence ?? 0);
    // £1 steps only (UI stepper).
    if (tipAmountPence % 100 !== 0) {
      return json({ success: false, error: "Invalid tip", error_code: "INVALID_TIP" }, 400);
    }
    if (!tripId) {
      return json({ success: false, error: "trip_id is required", error_code: "INVALID_TIP" }, 400);
    }

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false },
    });

    const { data: customer } = await admin
      .from("customers")
      .select("id")
      .eq("user_id", user.id)
      .maybeSingle();
    if (!customer?.id) {
      return json({ success: false, error: "Forbidden", error_code: "FORBIDDEN" }, 403);
    }

    const { data: trip, error: tripErr } = await admin
      .from("trips")
      .select(
        "id, status, passenger_id, service_area_id, booking_source, corporate_account_id, payment_method, payment_provider, payment_status, tip_pence, tip_amount_pence, tip_window_expires_at, tip_window_closed_at, tip_window_status, completed_at, provider_order_id, payment_intent_id, financial_model",
      )
      .eq("id", tripId)
      .maybeSingle();

    if (tripErr || !trip) {
      return json({ success: false, error: "Trip not found", error_code: "NOT_FOUND" }, 404);
    }
    if (String(trip.passenger_id) !== String(customer.id)) {
      return json({ success: false, error: "Forbidden", error_code: "FORBIDDEN" }, 403);
    }
    if (String(trip.status ?? "").toLowerCase() !== "completed") {
      return json({
        success: false,
        error: "Trip must be completed",
        error_code: "TRIP_NOT_COMPLETED",
      }, 409);
    }

    if (
      String(trip.financial_model ?? "").toUpperCase() ===
        "DRIVER_COLLECTED_COMMISSION_WALLET"
    ) {
      return json({
        success: false,
        error: "Platform tip capture forbidden on DRIVER_COLLECTED_COMMISSION_WALLET",
        error_code: "FINANCIAL_MODEL_VIOLATION",
      }, 409);
    }

    // Every action on this endpoint, including tip=0 and Skip, is a tip-window
    // capture. Excluded channels must not reach it even to close a leftover window.
    if (
      !isCustomerAppTipChannelEligible({
        booking_source: trip.booking_source,
        corporate_account_id: trip.corporate_account_id,
      })
    ) {
      return json({
        success: false,
        error: "Tips are not available for this booking channel",
        error_code: "TIPS_NOT_ALLOWED_FOR_CHANNEL",
      }, 409);
    }

    const existingTip = nonNegInt(trip.tip_amount_pence ?? trip.tip_pence);
    if (trip.tip_window_closed_at) {
      return json({
        success: true,
        already_submitted: true,
        tip_amount_pence: existingTip,
        error_code: "TIP_ALREADY_SUBMITTED",
      });
    }

    let tipsEnabled = false;
    if (trip.service_area_id) {
      const { data: area, error: areaErr } = await admin
        .from("service_areas")
        .select("tips_enabled")
        .eq("id", trip.service_area_id)
        .maybeSingle();
      if (areaErr) {
        // A failed read is not "tips off". The client treats TIPS_DISABLED as
        // continue-without-tip and would drop a selected tip and leave the fare.
        console.error("[submit-customer-trip-tip] tips_enabled read failed", areaErr.message);
        return json({
          success: false,
          error: "Unable to check tip settings. Please try again.",
          error_code: "TIP_STATUS_UNAVAILABLE",
        }, 503);
      }
      tipsEnabled = area?.tips_enabled === true;
    }

    const windowOpen = isTipWindowOpen(trip, Date.now());

    if (!tipsEnabled && tipAmountPence > 0) {
      if (!windowOpen) {
        return json({
          success: false,
          error: "Tips disabled",
          error_code: "TIPS_DISABLED",
        }, 409);
      }
      // Tips turned off after the stepper was shown. Do not capture that tip.
      // Fare still captures now — do not leave the window open until expiry.
      tipAmountPence = 0;
    }

    // Tips toggled off mid-window: tip=0 still closes window + fare-captures once.
    if (!tipsEnabled && tipAmountPence === 0 && !windowOpen) {
      return json({ success: true, tip_amount_pence: 0, tips_disabled: true });
    }

    if (!windowOpen) {
      return json({
        success: false,
        error: "Tip window closed",
        error_code: "TIP_WINDOW_CLOSED",
      }, 409);
    }

    // Pending unreverted claim (prior capture failure should usually have cleared tip).
    // Never let tip=0/Skip wipe a positive claim — finish capture of the claimed tip instead.
    if (existingTip > 0 && tipAmountPence > 0 && tipAmountPence !== existingTip) {
      tipAmountPence = existingTip;
    } else if (existingTip > 0 && tipAmountPence === 0) {
      tipAmountPence = existingTip;
    }

    const nowIso = new Date().toISOString();
    // Window must already be stamped at complete — never invent expires_at here.
    const expiresAt = trip.tip_window_expires_at;
    if (!expiresAt) {
      return json({
        success: false,
        error: "Tip window closed",
        error_code: "TIP_WINDOW_CLOSED",
      }, 409);
    }

    // Persist tip amount (or tip=0/Skip while claim is still zero). Do not close until capture succeeds.
    {
      let claimQuery = admin
        .from("trips")
        .update({
          tip_amount_pence: tipAmountPence,
          tip_pence: tipAmountPence,
          tip_window_expires_at: expiresAt,
          updated_at: nowIso,
        })
        .eq("id", tripId)
        .is("tip_window_closed_at", null);
      // First positive tip claim must win only against zero tip.
      if (existingTip === 0 && tipAmountPence > 0) {
        claimQuery = claimQuery.or("tip_amount_pence.is.null,tip_amount_pence.eq.0");
      }
      // tip=0/Skip must not overwrite a concurrent positive claim.
      if (tipAmountPence === 0) {
        claimQuery = claimQuery.or("tip_amount_pence.is.null,tip_amount_pence.eq.0");
      }
      const { data: claimed, error: claimErr } = await claimQuery.select("id").maybeSingle();

      if (claimErr) {
        console.error("[submit-customer-trip-tip] claim failed", claimErr.message);
        return json({ success: false, error: "Could not save tip", error_code: "CAPTURE_FAILED" }, 500);
      }
      if (!claimed) {
        const { data: raced } = await admin
          .from("trips")
          .select("tip_amount_pence, tip_pence, tip_window_closed_at")
          .eq("id", tripId)
          .maybeSingle();
        if (raced?.tip_window_closed_at) {
          return json({
            success: true,
            already_submitted: true,
            tip_amount_pence: nonNegInt(raced.tip_amount_pence ?? raced.tip_pence),
            error_code: "TIP_ALREADY_SUBMITTED",
          });
        }
        const racedTip = nonNegInt(raced?.tip_amount_pence ?? raced?.tip_pence);
        if (racedTip > 0) {
          // Concurrent claim won — capture that tip (idempotent finalize).
          tipAmountPence = racedTip;
        } else if (tipAmountPence > 0) {
          return json({
            success: false,
            error: "Could not save tip",
            error_code: "CAPTURE_FAILED",
          }, 409);
        }
      }
    }

    const paymentMethod = String(trip.payment_method ?? "").toLowerCase();
    const isCash = paymentMethod === "cash";
    const provider = String(trip.payment_provider ?? "").toLowerCase();
    const hasProvider =
      Boolean(String(trip.provider_order_id ?? "").trim()) ||
      Boolean(String(trip.payment_intent_id ?? "").trim());

    const closeWindow = async (): Promise<boolean> => {
      const { error } = await admin.from("trips").update({
        tip_amount_pence: tipAmountPence,
        tip_pence: tipAmountPence,
        tip_window_expires_at: expiresAt,
        tip_window_closed_at: nowIso,
        tip_window_status: TIP_WINDOW_STATUS.CLOSED,
        updated_at: nowIso,
      }).eq("id", tripId).is("tip_window_closed_at", null);
      if (error) {
        console.error("[submit-customer-trip-tip] closeWindow failed", error.message);
        return false;
      }
      return true;
    };

    const revertTipClaim = async () => {
      await admin.from("trips").update({
        tip_amount_pence: 0,
        tip_pence: 0,
        updated_at: new Date().toISOString(),
      }).eq("id", tripId).is("tip_window_closed_at", null);
    };

    // Card / Revolut: capture first while window open, then close on success.
    // Crash-safe: failed/interrupted capture leaves window open for retry or expiry.
    // Never seal the tip window without a Revolut capture on card trips (would strand fare).
    if (!isCash && hasProvider && provider === "revolut") {
      const rec = await invokeFinalizeTripCapture({
        supabaseUrl,
        serviceRoleKey,
        tripId,
        tipPence: tipAmountPence,
        source: "submit_customer_trip_tip",
      });
      if (!tipWindowCloseAllowedAfterFinalize(rec.body)) {
        // Shortfall / processing is business-ok for invoke callers. Do not seal
        // the window or keep a tip claim until a positive capture lands.
        console.error("[submit-customer-trip-tip] capture not confirmed", {
          trip_id: tripId,
          error: rec.error,
          body: rec.body,
        });
        await revertTipClaim();
        return json({
          success: false,
          error: rec.error ?? "Capture failed",
          error_code: "CAPTURE_FAILED",
        }, 502);
      }
      if (tipAmountPence > 0) {
        // Missing collected amount fails closed to 0, never the requested tip.
        tipAmountPence = recordedTipPenceAfterCapture(rec.body?.tip_collected_pence) ?? 0;
      }
      if (!(await closeWindow())) {
        // Capture landed; leave window open so client/expiry can close idempotently.
        return json({
          success: false,
          error: "Tip captured but window close failed — retry",
          error_code: "CAPTURE_FAILED",
        }, 502);
      }
    } else if (isCash) {
      if (!(await closeWindow())) {
        return json({
          success: false,
          error: "Could not close tip window",
          error_code: "CAPTURE_FAILED",
        }, 500);
      }
    } else {
      await revertTipClaim();
      return json({
        success: false,
        error: "Card tip capture requires Revolut provider order",
        error_code: "CAPTURE_FAILED",
      }, 409);
    }

    return json({
      success: true,
      tip_amount_pence: tipAmountPence,
      tip_window_closed_at: nowIso,
      tips_disabled: tipsEnabled ? undefined : true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[submit-customer-trip-tip]", message);
    return json({ success: false, error: message, error_code: "CAPTURE_FAILED" }, 500);
  }
});
