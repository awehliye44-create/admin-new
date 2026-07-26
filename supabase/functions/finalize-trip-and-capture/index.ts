import Stripe from "npm:stripe@18.5.0";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  capTierCommissionPercent,
  computeDriverCommissionBreakdown,
} from "../_shared/commission-breakdown.ts";
import {
  computeCaptureAmount,
  computeDriverEarningsBreakdown,
  resolveTripFare,
  type TripFareRow,
} from "../_shared/tripFareSSOT.ts";
import {
  capturePaymentIntentWithSettlement,
  ensureStripeSettlementForCapturedPayment,
  buildCardCaptureRecoverySettlementArgs,
  loadDriverOutstandingRecoveryDebtPence,
  tripSettlementColumnsFromResult,
  type StripeSettlementResult,
} from "../_shared/stripeSettlement.ts";
import {
  creditCapturedCardTripLedger,
} from "../_shared/onecabFinanceLedger.ts";
import { loadServiceAreaTipsEnabled } from "../_shared/serviceAreaTipping.ts";
import { finalizeRevolutTripCapture } from "../_shared/finalizeRevolutTripCapture.ts";
import { looksLikeStripePaymentIntentId } from "../_shared/stripeRetirementGuard.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[FINALIZE-CAPTURE] ${step}${detailsStr}`);
};

const TIP_WINDOW_MS = 2 * 60 * 1000;

const paymentAudit = (stage: string, payload: Record<string, unknown>) => {
  console.log("[PAYMENT_AUDIT]", JSON.stringify({ stage, ...payload }));
};

type TipWindowTrip = {
  tip_window_expires_at?: string | null;
  tip_window_closed_at?: string | null;
  completed_at?: string | null;
};

/** True while customer may still add a tip (server SSOT + completed_at fallback). */
function isTipWindowOpen(trip: TipWindowTrip): boolean {
  if (trip.tip_window_closed_at) return false;
  if (trip.tip_window_expires_at) {
    return new Date(trip.tip_window_expires_at).getTime() > Date.now();
  }
  if (trip.completed_at) {
    return Date.now() - new Date(trip.completed_at).getTime() < TIP_WINDOW_MS;
  }
  return false;
}

async function closeTipWindow(
  supabaseClient: ReturnType<typeof createClient>,
  tripId: string,
  reason: "customer_skip" | "customer_done" | "timer_expired" | "internal_recovery",
): Promise<void> {
  const now = new Date().toISOString();
  await supabaseClient
    .from("trips")
    .update({ tip_window_closed_at: now })
    .eq("id", tripId)
    .is("tip_window_closed_at", null);
  if (reason === "timer_expired") {
    paymentAudit("TIP_WINDOW_EXPIRED", { trip_id: tripId, closed_at: now });
  }
}

async function creditPostCaptureTip(
  supabaseClient: ReturnType<typeof createClient>,
  stripe: Stripe,
  trip: Record<string, unknown>,
  tripId: string,
  paymentIntentId: string,
  additionalTipPence: number,
): Promise<{ success: boolean; tipPiId?: string; error?: string }> {
  const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
  const customerId = pi.customer as string | null;
  const paymentMethodId = pi.payment_method as string | null;

  if (!customerId || !paymentMethodId) {
    return { success: false, error: "no_saved_payment_method_for_tip" };
  }
  if (!pi.currency) {
    return { success: false, error: "missing_currency_for_tip_charge" };
  }

  const tipPi = await stripe.paymentIntents.create({
    amount: additionalTipPence,
    currency: pi.currency,
    customer: customerId,
    payment_method: paymentMethodId,
    off_session: true,
    confirm: true,
    metadata: {
      trip_id: tripId,
      type: "passenger_tip",
      original_pi: paymentIntentId,
      tip_pence: additionalTipPence.toString(),
    },
  }, {
    idempotencyKey: `tip_${tripId}_${additionalTipPence}`,
  });

  if (tipPi.status !== "succeeded") {
    return { success: false, tipPiId: tipPi.id, error: `tip_charge_status_${tipPi.status}` };
  }

  const driverId = trip.driver_id as string | null;
  const existingTipPence = Math.max(0, Number(trip.tip_pence ?? trip.tip_amount_pence ?? 0));
  const newTipPence = existingTipPence + additionalTipPence;
  const driverNetBeforeTip = Number(trip.driver_net_before_tip_pence ?? trip.driver_net_pence ?? 0);

  await supabaseClient.from("trips").update({
    tip_pence: newTipPence,
    tip_amount_pence: newTipPence,
    driver_total_earnings_pence: driverNetBeforeTip + newTipPence,
  }).eq("id", tripId);

  if (driverId) {
    const { data: existingTipLedger } = await supabaseClient
      .from("driver_wallet_ledger")
      .select("id")
      .eq("related_trip_id", tripId)
      .eq("type", "DRIVER_TIP_CREDIT")
      .maybeSingle();

    if (!existingTipLedger) {
      let ledgerCurrency = "GBP";
      const { data: drvRegion } = await supabaseClient
        .from("drivers")
        .select("region_id")
        .eq("id", driverId)
        .single();
      if (drvRegion?.region_id) {
        const { data: region } = await supabaseClient
          .from("regions")
          .select("currency_code")
          .eq("id", drvRegion.region_id)
          .single();
        ledgerCurrency = region?.currency_code || ledgerCurrency;
      }

      await supabaseClient.from("driver_wallet_ledger").insert({
        driver_id: driverId,
        type: "DRIVER_TIP_CREDIT",
        amount_pence: additionalTipPence,
        currency: ledgerCurrency,
        related_trip_id: tripId,
        description: "Tip from passenger",
      });
      paymentAudit("TIP_DRIVER_LEDGER_CREATED", {
        trip_id: tripId,
        driver_id: driverId,
        tip_pence: additionalTipPence,
        mode: "post_capture_separate_charge",
      });
    }
  }

  const { data: paymentRow } = await supabaseClient
    .from("payments")
    .select("metadata, captured_amount_pence")
    .eq("trip_id", tripId)
    .eq("stripe_payment_intent_id", paymentIntentId)
    .maybeSingle();

  const priorMetadata = (paymentRow?.metadata && typeof paymentRow.metadata === "object")
    ? paymentRow.metadata as Record<string, unknown>
    : {};

  await supabaseClient
    .from("payments")
    .update({
      amount_pence: Number(paymentRow?.captured_amount_pence ?? trip.capture_amount_pence ?? 0) + additionalTipPence,
      driver_amount_pence: driverNetBeforeTip + newTipPence,
      metadata: {
        ...priorMetadata,
        tip_pence: newTipPence,
        post_capture_tip_pi_id: tipPi.id,
        post_capture_tip_pence: additionalTipPence,
      },
    })
    .eq("trip_id", tripId)
    .eq("stripe_payment_intent_id", paymentIntentId);

  paymentAudit("TIP_CAPTURE_SUCCESS", {
    trip_id: tripId,
    tip_pi_id: tipPi.id,
    additional_tip_pence: additionalTipPence,
    total_tip_pence: newTipPence,
    mode: "post_capture_separate_charge",
  });

  return { success: true, tipPiId: tipPi.id };
}

/** Driver tier commission % — trip snapshot first, then service_area_driver_tiers via RPC. */
async function resolveDriverTierCommissionPercent(
  supabaseClient: any,
  trip: Record<string, unknown>,
  driverId: string | null,
): Promise<number> {
  const snapshotted = trip.driver_tier_commission_percent;
  if (snapshotted != null && Number.isFinite(Number(snapshotted))) {
    return Number(snapshotted);
  }

  if (!driverId) return 0;

  const { data, error } = await supabaseClient.rpc("resolve_driver_tier_commission_percent", {
    p_driver_id: driverId,
    p_service_area_id: trip.service_area_id ?? null,
  });
  if (error) {
    console.warn("[FINALIZE-CAPTURE] resolve_driver_tier_commission_percent failed", error);
    return 0;
  }
  return capTierCommissionPercent(Number(data ?? 0));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseClient = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } }
  );

  try {
    logStep("Function started");

    // Parse request body first so we know if this is a trusted internal call
    const requestBody = await req.json();
    const { trip_id, tip_pence = 0, internal = false } = requestBody ?? {};
    if (!trip_id) throw new Error("trip_id is required");
    const safeTipPence = Math.max(0, Math.round(tip_pence));

    // Authenticate.
    // - Normal customer call: validate JWT via getClaims and resolve userId.
    // - Trusted internal call (server-to-server, e.g. from update-trip-status
    //   when a driver completes the trip): caller MUST present the service
    //   role key as the bearer AND set body.internal=true. Ownership is
    //   skipped because we trust the source.
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) throw new Error("No authorization header provided");
    const token = authHeader.replace("Bearer ", "");

    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const isInternalTrusted = internal === true && !!serviceRoleKey && token === serviceRoleKey;

    let userId: string | null = null;
    if (!isInternalTrusted) {
      const anonClient = createClient(
        Deno.env.get("SUPABASE_URL") ?? "",
        Deno.env.get("SUPABASE_ANON_KEY") ?? "",
        { auth: { persistSession: false } }
      );
      const { data: claimsData, error: claimsError } = await anonClient.auth.getClaims(token);
      if (claimsError || !claimsData?.claims) {
        throw new Error(`Authentication error: ${claimsError?.message || "invalid token"}`);
      }
      userId = claimsData.claims.sub;
      if (!userId) throw new Error("User not authenticated");
      logStep("User authenticated", { userId });
    } else {
      logStep("Trusted internal call — ownership check bypassed");
    }

    logStep("Request parsed", { trip_id, tip_pence: safeTipPence, internal: isInternalTrusted });

    // Fetch trip
    const { data: trip, error: tripError } = await supabaseClient
      .from("trips")
      .select("*")
      .eq("id", trip_id)
      .single();

    if (tripError || !trip) {
      throw new Error(`Trip not found: ${tripError?.message}`);
    }

    const serviceAreaTipsEnabled = await loadServiceAreaTipsEnabled(
      supabaseClient,
      trip.service_area_id as string | null,
    );

    if (!serviceAreaTipsEnabled && safeTipPence > 0) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "tips_disabled_for_service_area",
          message: "Tipping is not enabled for this service area.",
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 400,
        },
      );
    }

    const isRevolutTrip = (trip.payment_provider ?? "").toLowerCase() === "revolut"
      || (!looksLikeStripePaymentIntentId(trip.stripe_payment_intent_id)
        && !!trip.stripe_payment_intent_id);

    if (isRevolutTrip) {
      logStep("Revolut trip — capturing via Revolut Merchant API");
      const revolutResult = await finalizeRevolutTripCapture({
        supabase: supabaseClient,
        trip: trip as Record<string, unknown>,
        tipPence: safeTipPence,
      });
      return new Response(JSON.stringify(revolutResult), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: revolutResult.success ? 200 : 400,
      });
    }

    {
      const { assertStripeMutationAllowed } = await import("../_shared/stripeRuntimeDisabled.ts");
      const retired = assertStripeMutationAllowed(corsHeaders, "finalize-trip-and-capture:stripe");
      if (retired) return retired;
    }

    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeKey) throw new Error("STRIPE_SECRET_KEY is not set");

    // Ownership check (skipped for trusted internal calls).
    // trips.passenger_id refers to customers.id (not auth.users.id)
    logStep("Trip fetched", { tripId: trip.id, passenger_id: trip.passenger_id, driver_id: trip.driver_id });

    if (!isInternalTrusted) {
      let isOwner = false;

      if (trip.passenger_id) {
        const { data: passengerCustomer, error: passengerCustomerError } = await supabaseClient
          .from("customers")
          .select("id, user_id")
          .eq("id", trip.passenger_id)
          .maybeSingle();

        if (passengerCustomerError) {
          logStep("Passenger customer lookup error", { message: passengerCustomerError.message });
        } else if (passengerCustomer?.user_id) {
          isOwner = passengerCustomer.user_id === userId;
          logStep("Passenger customer resolved", {
            passengerCustomerId: passengerCustomer.id,
            passengerUserId: passengerCustomer.user_id,
            requestUserId: userId,
            isOwner,
          });
        }
      }

      // Backward-compat fallback (some older rows may store auth user id directly)
      if (!isOwner && trip.passenger_id === userId) {
        isOwner = true;
        logStep("Ownership matched via direct passenger_id == user.id fallback");
      }

      if (!isOwner) {
        throw new Error("Unauthorized: You do not own this trip");
      }
    }

    // If no PaymentIntent exists: cash stays on collected_cash path; otherwise mark paid (free/wallet-only).
    if (!trip.stripe_payment_intent_id) {
      const isCashTrip = (trip.payment_method ?? "").trim().toLowerCase() === "cash";
      const storedFarePence = trip.fare
        ? Math.round(trip.fare * 100)
        : (trip.final_fare_pence || trip.estimated_total_pence || Math.round((trip.estimated_fare || 0) * 100));

      if (isCashTrip) {
        logStep("Historical legacy cash trip — read-only finalize (no cash settlement)", {
          payment_status: trip.payment_status,
        });

        const legacyUpdate: Record<string, unknown> = {};
        if (safeTipPence !== (trip.tip_pence ?? 0)) {
          legacyUpdate.tip_pence = safeTipPence;
        }
        if (Object.keys(legacyUpdate).length > 0) {
          await supabaseClient.from("trips").update(legacyUpdate).eq("id", trip_id);
        }

        return new Response(JSON.stringify({
          success: true,
          message: "Historical legacy cash trip — no Stripe capture or cash settlement",
          historical_legacy: true,
          payment_status: trip.payment_status ?? "collected_cash",
          final_total_pence: storedFarePence + safeTipPence,
          wallet_applied_pence: 0,
          stripe_captured_pence: 0,
          tip_pence: safeTipPence,
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 200,
        });
      }

      logStep("No PaymentIntent exists - marking as paid (no payment required)");

      await supabaseClient
        .from("trips")
        .update({
          payment_status: "paid",
          tip_pence: safeTipPence,
        })
        .eq("id", trip_id);

      return new Response(JSON.stringify({
        success: true,
        message: "Trip marked as paid (no payment capture needed)",
        final_total_pence: storedFarePence + safeTipPence,
        wallet_applied_pence: 0,
        stripe_captured_pence: 0,
        tip_pence: safeTipPence,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
    }

    // Check if already captured — idempotent, no duplicate charges.
    //
    // CRITICAL: do NOT trust trips.payment_status alone. Legacy DB function
    // record_digital_trip_payment (and historical bugs) could mark a trip
    // "captured" without ever calling Stripe, which silently leaves the
    // pre-authorization hanging on the customer's bank account. Verify
    // against the actual Stripe PaymentIntent before short-circuiting:
    // if Stripe still has the PI in `requires_capture`, we MUST proceed
    // and capture (or cancel) — regardless of what the DB says.
    if (trip.payment_status === "captured" || trip.payment_status === "paid") {
      try {
        const stripeForCheck = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });
        const piCheck = await stripeForCheck.paymentIntents.retrieve(trip.stripe_payment_intent_id);
        const piStillCapturable = piCheck.status === "requires_capture"
          || piCheck.status === "requires_payment_method"
          || piCheck.status === "requires_confirmation"
          || piCheck.status === "requires_action";
        if (!piStillCapturable) {
          const existingTipPence = Math.max(0, Number(trip.tip_pence ?? trip.tip_amount_pence ?? 0));
          const additionalTipPence = safeTipPence - existingTipPence;

          if (safeTipPence > 0 && additionalTipPence <= 0) {
            paymentAudit("TIP_DUPLICATE_BLOCKED", {
              trip_id,
              requested_tip_pence: safeTipPence,
              stored_tip_pence: existingTipPence,
            });
            return new Response(
              JSON.stringify({
                success: true,
                message: "Tip already saved",
                already_captured: true,
                tip_pence: existingTipPence,
                tip_duplicate_blocked: true,
              }),
              {
                headers: { ...corsHeaders, "Content-Type": "application/json" },
                status: 200,
              },
            );
          }

          if (additionalTipPence > 0 && serviceAreaTipsEnabled) {
            let allowedTipPence = additionalTipPence;
            if (trip.tip_window_expires_at) {
              const windowExpiry = new Date(trip.tip_window_expires_at as string);
              if (new Date() > windowExpiry) {
                logStep("Tip window expired — rejecting post-capture tip", {
                  expires_at: trip.tip_window_expires_at,
                  attempted_tip: additionalTipPence,
                });
                allowedTipPence = 0;
              }
            }

            if (allowedTipPence > 0) {
              logStep("Post-capture tip requested", {
                existingTipPence,
                additionalTipPence: allowedTipPence,
              });
              paymentAudit("TIP_SUBMIT_AFTER_CAPTURE_SEPARATE_CHARGE_STARTED", {
                trip_id,
                additional_tip_pence: allowedTipPence,
                existing_tip_pence: existingTipPence,
              });
              paymentAudit("TIP_SUBMITTED", {
                trip_id,
                tip_pence: safeTipPence,
                additional_tip_pence: allowedTipPence,
                path: "post_capture",
              });

              const stripeForTip = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });
              const tipResult = await creditPostCaptureTip(
                supabaseClient,
                stripeForTip,
                trip as Record<string, unknown>,
                trip_id,
                trip.stripe_payment_intent_id,
                allowedTipPence,
              );

              if (tipResult.success) {
                paymentAudit("TIP_SAVED_TO_TRIP", {
                  trip_id,
                  tip_pence: existingTipPence + allowedTipPence,
                });
                paymentAudit("TIP_CAPTURE_INCLUDED", {
                  trip_id,
                  mode: "post_capture_separate_charge",
                  tip_pence: existingTipPence + allowedTipPence,
                });
                return new Response(
                  JSON.stringify({
                    success: true,
                    message: "Post-capture tip charged",
                    tip_pence: existingTipPence + allowedTipPence,
                    post_capture_tip_charged: true,
                    tip_payment_intent_id: tipResult.tipPiId,
                  }),
                  {
                    headers: { ...corsHeaders, "Content-Type": "application/json" },
                    status: 200,
                  },
                );
              }

              logStep("Post-capture tip charge failed", { error: tipResult.error });
              paymentAudit("TIP_SUBMIT_AFTER_CAPTURE_FAILED_NO_FALSE_SUCCESS", {
                trip_id,
                tip_pence: safeTipPence,
                error: tipResult.error ?? "Post-capture tip charge failed",
              });
              return new Response(
                JSON.stringify({
                  success: false,
                  error: tipResult.error ?? "Post-capture tip charge failed",
                  already_captured: true,
                  tip_saved: false,
                  tip_pence: existingTipPence,
                }),
                {
                  headers: { ...corsHeaders, "Content-Type": "application/json" },
                  status: 402,
                },
              );
            }
          }

          let settlementRecovered = false;
          const existingCommission = Math.max(0, Number(trip.commission_pence ?? 0));
          if (
            piCheck.status === "succeeded"
            && existingCommission > 0
            && !trip.stripe_settlement_verified
          ) {
            try {
              const stripeForRecovery = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });
              const captureAmountPence = piCheck.amount_received ?? piCheck.amount;
              const shortCircuitDriverId = (trip as { driver_id?: string | null }).driver_id ?? null;
              const shortCircuitOutstandingDebt = shortCircuitDriverId
                ? await loadDriverOutstandingRecoveryDebtPence(supabaseClient, shortCircuitDriverId)
                : 0;
              const shortCircuitDriverNet = Math.max(
                0,
                Number(trip.driver_net_pence ?? captureAmountPence - existingCommission),
              );
              const recovery = await ensureStripeSettlementForCapturedPayment({
                stripe: stripeForRecovery,
                supabase: supabaseClient,
                tripId: trip_id,
                driverId: shortCircuitDriverId,
                paymentIntentId: trip.stripe_payment_intent_id,
                commissionPence: existingCommission,
                driverPayoutPence: Math.max(
                  0,
                  captureAmountPence - existingCommission,
                ),
                currencyCode: piCheck.currency ?? "gbp",
                idempotencyKey: `recovery_already_captured_${trip_id}`,
                ...buildCardCaptureRecoverySettlementArgs({
                  driverNetPence: shortCircuitDriverNet,
                  outstandingRecoveryDebtPence: shortCircuitOutstandingDebt,
                  airportChargePence: Number((trip as { airport_charge_pence?: number }).airport_charge_pence ?? 0),
                  otherPassThroughChargesPence: Number((trip as { other_pass_through_charges_pence?: number }).other_pass_through_charges_pence ?? 0),
                  tipPence: Number((trip as { tip_pence?: number; tip_amount_pence?: number }).tip_pence ?? (trip as { tip_amount_pence?: number }).tip_amount_pence ?? 0),
                }),
              });
              await supabaseClient
                .from("trips")
                .update(tripSettlementColumnsFromResult(recovery))
                .eq("id", trip_id);
              settlementRecovered = recovery.settlementVerified;
              logStep("Connect settlement recovered on already_captured short-circuit", {
                settlement_verified: recovery.settlementVerified,
                transfer_id: recovery.transferId,
              });
            } catch (recoveryErr) {
              console.error("[PAYMENT_AUDIT] settlement_recovery_failed", {
                trip_id,
                error: recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr),
              });
            }
          }

          logStep("Trip already finalized — rejecting duplicate", {
            status: trip.payment_status,
            pi_status: piCheck.status,
            settlement_recovered: settlementRecovered,
          });
          return new Response(
            JSON.stringify({
              success: true,
              message: "Payment already finalized",
              already_captured: true,
              settlement_recovered: settlementRecovered,
            }),
            {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
              status: 200,
            }
          );
        }
        // DB says captured but Stripe still has the hold — fall through and
        // capture now to release the buffer on the customer's bank.
        console.warn("[PAYMENT_AUDIT] db_says_captured_but_stripe_still_holds", {
          trip_id,
          payment_intent_id: trip.stripe_payment_intent_id,
          db_payment_status: trip.payment_status,
          stripe_pi_status: piCheck.status,
        });
      } catch (checkErr) {
        // If we can't reach Stripe, fall back to honoring the DB to avoid
        // double-capture risk.
        logStep("Stripe verification failed during dedup check — honoring DB", { error: String(checkErr) });
        return new Response(
          JSON.stringify({
            success: true,
            message: "Payment already finalized",
            already_captured: true,
          }),
          {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: 200,
          }
        );
      }
    }

    // Tip window only gates customer-submitted tips — fare capture proceeds immediately
    // on trip completion (P0 automatic capture). Late tips after window expiry are zeroed.
    let finalTipPence = safeTipPence;
    const tipWindowOpen = serviceAreaTipsEnabled && isTipWindowOpen(trip as TipWindowTrip);
    if (trip.tip_window_expires_at) {
      const windowExpiry = new Date(trip.tip_window_expires_at);
      if (new Date() > windowExpiry && safeTipPence > 0) {
        logStep("Tip window expired — rejecting late tip", {
          expires_at: trip.tip_window_expires_at,
          attempted_tip: safeTipPence,
        });
        finalTipPence = 0;
      }
    }

    // Internal fare-only capture (tip_pence=0) always proceeds — tips are optional and
    // may be added via customer finalize or post-capture tip PI after fare is captured.
    if (isInternalTrusted && tipWindowOpen && finalTipPence === 0) {
      paymentAudit("AUTO_CAPTURE_FARE_DURING_TIP_WINDOW", {
        trip_id,
        tip_window_expires_at: trip.tip_window_expires_at,
        source: "finalize_internal_fare_only",
      });
    }

    // Customer skip/done closes the tip window before capture; recovery runs after expiry.
    if (!isInternalTrusted) {
      await closeTipWindow(
        supabaseClient,
        trip_id,
        finalTipPence > 0 ? "customer_done" : "customer_skip",
      );
    } else if (!tipWindowOpen) {
      await closeTipWindow(supabaseClient, trip_id, "internal_recovery");
    }

    if (finalTipPence > 0) {
      paymentAudit("TIP_SUBMITTED", {
        trip_id,
        tip_pence: finalTipPence,
        path: "primary_capture",
      });
    }

    logStep("Trip validated", { 
      tripId: trip.id, 
      paymentIntentId: trip.stripe_payment_intent_id,
      fare: trip.fare,
      estimatedFare: trip.estimated_fare 
    });

    // ── SSOT fare from trip columns (+ optional route recalc when fare not locked) ──
    const { data: tripStops } = await supabaseClient
      .from("trip_stops")
      .select("stop_index, type, lat, lng, address, status, waiting_charge_pence")
      .eq("trip_id", trip_id)
      .order("stop_index", { ascending: true });

    const pickupStop = tripStops?.find((s: any) => s.type === "pickup");
    const dropoffStop = tripStops?.find((s: any) => s.type === "dropoff");
    const intermediateStops = (tripStops || []).filter((s: any) => s.type === "stop");

    const pickupLat = pickupStop?.lat ?? trip.pickup_latitude;
    const pickupLng = pickupStop?.lng ?? trip.pickup_longitude;
    const dropoffLat = dropoffStop?.lat ?? trip.dropoff_latitude;
    const dropoffLng = dropoffStop?.lng ?? trip.dropoff_longitude;

    const stopWaitingFromStops = (tripStops ?? []).reduce(
      (sum: number, s: { waiting_charge_pence?: number | null }) =>
        sum + (s.waiting_charge_pence || 0),
      0,
    );

    logStep("Trip stops for fare SSOT", {
      pickup: `${pickupLat},${pickupLng}`,
      dropoff: `${dropoffLat},${dropoffLng}`,
      intermediateStops: intermediateStops.length,
      stopWaitingFromStops,
    });

    let fareBreakdown: Record<string, unknown> | null = null;
    let routeRecalcBasePence: number | null = null;
    let recalcDistanceKm = 0;
    let recalcDurationMin = 0;

    if (pickupLat && pickupLng && dropoffLat && dropoffLng) {
      try {
        const routeRes = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/calculate-route`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
            Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""}`,
          },
          body: JSON.stringify({
            originLat: pickupLat,
            originLng: pickupLng,
            destLat: dropoffLat,
            destLng: dropoffLng,
            intermediateStops: intermediateStops.map((s: any) => ({ lat: s.lat, lng: s.lng })),
          }),
        });
        const routeData = await routeRes.json();
        if (routeData?.success && typeof routeData.distanceKm === "number") {
          recalcDistanceKm = routeData.distanceKm;
          recalcDurationMin = Number(routeData.durationMinutes) || 0;
        }
      } catch (routeErr) {
        logStep("Route recalculation failed, using stored fare SSOT", { error: String(routeErr) });
      }
    }

    if (recalcDistanceKm > 0 && trip.vehicle_type_id && trip.service_area_id && !trip.fare_locked) {
      try {
        const estimateRes = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/estimate-fare`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
            Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""}`,
          },
          body: JSON.stringify({
            service_area_id: trip.service_area_id,
            vehicle_type_id: trip.vehicle_type_id,
            estimated_distance_km: recalcDistanceKm,
            estimated_duration_min: recalcDurationMin,
            pickup: pickupLat && pickupLng ? { lat: pickupLat, lng: pickupLng } : undefined,
            dropoff: dropoffLat && dropoffLng ? { lat: dropoffLat, lng: dropoffLng } : undefined,
          }),
        });

        if (estimateRes.ok) {
          const estimateData = await estimateRes.json();
          if (estimateData?.success) {
            routeRecalcBasePence = Number(
              estimateData.totalFarePence || Math.round((estimateData.priceNum || 0) * 100),
            );
            const eb = estimateData.breakdown || {};
            fareBreakdown = {
              baseFare: eb.base_fare ?? null,
              tripFare: eb.trip_fare ?? null,
              distanceCost: eb.distance_cost ?? null,
              timeCost: eb.time_cost ?? null,
              bookingFee: eb.booking_fee ?? null,
              airportCharge: eb.airport_charge ?? 0,
              airportPickupFee: eb.airport_pickup_fee ?? 0,
              airportDropoffFee: eb.airport_dropoff_fee ?? 0,
              fareDetails: eb.fare_details ?? null,
              surcharge: eb.surcharge ?? 0,
              zoneApplied: eb.zone_applied ?? null,
              pickupZone: eb.pickup_zone ?? null,
              dropoffZone: eb.dropoff_zone ?? null,
              fixedFareApplied: eb.fixed_fare_applied ?? false,
              pricingMode: estimateData.pricingMode ?? null,
            };
            logStep("Route recalc base (unlocked fare only)", { routeRecalcBasePence, recalcDistanceKm });
          }
        }
      } catch (fareErr) {
        logStep("Fare Engine recalculation failed, using stored SSOT", { error: String(fareErr) });
      }
    }

    const tripForFare: TripFareRow = {
      ...(trip as TripFareRow),
      stop_waiting_charge_pence: Math.max(
        Number(trip.stop_waiting_charge_pence ?? 0),
        stopWaitingFromStops,
      ),
    };
    if (routeRecalcBasePence != null && routeRecalcBasePence > 0 && !trip.fare_locked) {
      tripForFare.final_fare_pence = routeRecalcBasePence;
      tripForFare.locked_base_fare_pence = routeRecalcBasePence;
    }

    const resolvedFare = resolveTripFare(tripForFare, finalTipPence);
    const finalFarePence = resolvedFare.final_fare_pence;
    const captureResolution = computeCaptureAmount(tripForFare, "completed", finalTipPence);
    const waitingChargePence =
      resolvedFare.arrival_waiting_charge_pence + resolvedFare.stop_waiting_charge_pence;
    const appliedDiscountPence = resolvedFare.discount_pence;
    const finalTotalPence = captureResolution.capture_amount_pence;

    logStep("Final amounts (SSOT)", {
      locked_base_fare_pence: resolvedFare.locked_base_fare_pence,
      arrival_waiting_charge_pence: resolvedFare.arrival_waiting_charge_pence,
      stop_waiting_charge_pence: resolvedFare.stop_waiting_charge_pence,
      customer_modification_charge_pence: resolvedFare.customer_modification_charge_pence,
      airport_charge_pence: resolvedFare.airport_charge_pence,
      pass_through_charge_pence: resolvedFare.pass_through_charge_pence,
      discount_pence: resolvedFare.discount_pence,
      finalFarePence,
      tipPence: resolvedFare.tips_pence,
      waitingChargePence,
      appliedDiscountPence,
      finalTotalPence,
    });

    // Handle wallet application (optional)
    let walletAppliedPence = 0;
    let walletHoldId: string | null = null;
    
    // Use trip.passenger_id (customers.id) for wallet lookup
    if (trip.passenger_id) {
      const { data: wallet } = await supabaseClient
        .from("customer_wallets")
        .select("id, balance_pence")
        .eq("customer_id", trip.passenger_id)
        .single();

      if (wallet && wallet.balance_pence > 0) {
        // Apply wallet up to final total
        walletAppliedPence = Math.min(wallet.balance_pence, finalTotalPence);
        
        if (walletAppliedPence > 0) {
          // Create wallet HOLD
          const { data: holdEntry, error: holdError } = await supabaseClient
            .from("customer_wallet_ledger")
            .insert({
              wallet_id: wallet.id,
              trip_id: trip_id,
              entry_type: "HOLD",
              amount_pence: walletAppliedPence,
              status: "pending",
              description: `Hold for trip ${trip.trip_code || trip.id}`,
            })
            .select("id")
            .single();

          if (!holdError && holdEntry) {
            walletHoldId = holdEntry.id;
            logStep("Wallet hold created", { holdId: walletHoldId, amount: walletAppliedPence });
          }
        }
      }
    }

    // Calculate amount to capture from Stripe after wallet application
    const finalTotalAfterWalletPence = finalTotalPence - walletAppliedPence;
    
    logStep("Amount after wallet", { 
      finalTotalPence, 
      walletAppliedPence, 
      finalTotalAfterWalletPence 
    });

    // Initialize Stripe
    const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });

    // Retrieve PaymentIntent
    const paymentIntent = await stripe.paymentIntents.retrieve(trip.stripe_payment_intent_id);
    logStep("PaymentIntent retrieved", { 
      id: paymentIntent.id, 
      amount: paymentIntent.amount,
      status: paymentIntent.status,
      amountCapturable: paymentIntent.amount_capturable 
    });

    // Check if PI needs amount update before capture
    if (finalTotalAfterWalletPence > 0 && finalTotalAfterWalletPence !== paymentIntent.amount) {
      // Update PI amount to exact final amount if possible
      if (paymentIntent.status === "requires_capture") {
        // Can capture less than authorized amount, Stripe releases the rest
        logStep("Will capture different amount than authorized", {
          authorized: paymentIntent.amount,
          willCapture: finalTotalAfterWalletPence
        });
      } else if (["requires_payment_method", "requires_confirmation", "requires_action"].includes(paymentIntent.status)) {
        // Update the amount before confirmation
        await stripe.paymentIntents.update(trip.stripe_payment_intent_id, {
          amount: finalTotalAfterWalletPence,
        });
        logStep("Updated PI amount before capture");
      }
    }

    // Update trip with final amounts BEFORE capture (including recalculated fare).
    // Do not write modification into extras_pence (duplicates customer_modification_charge_pence).
    const tripUpdate: Record<string, unknown> = {
      fare: finalFarePence / 100,
      estimated_fare: finalFarePence / 100,
      final_fare_pence: finalFarePence,
      final_customer_fare_pence: Math.max(
        Number(trip.final_customer_fare_pence ?? 0),
        finalFarePence - waitingChargePence,
      ),
      locked_base_fare_pence: resolvedFare.locked_base_fare_pence,
      tip_pence: resolvedFare.tips_pence,
      wallet_applied_pence: walletAppliedPence,
      // Expected payable until Stripe confirms — overwritten with Stripe actual after capture.
      capture_amount_pence: finalTotalAfterWalletPence,
      payment_status: "capture_requested",
      total_waiting_charge_pence: waitingChargePence,
      waiting_charge_pence: waitingChargePence,
    };
    if (fareBreakdown) {
      tripUpdate.fare_breakdown = fareBreakdown;
      tripUpdate.base_fare_pence = Math.round((fareBreakdown.baseFare as number || 0) * 100);
    }
    await supabaseClient
      .from("trips")
      .update(tripUpdate)
      .eq("id", trip_id);

    // If wallet covers entire amount, no Stripe capture needed
    if (finalTotalAfterWalletPence <= 0) {
      logStep("Wallet covers full amount, no Stripe capture needed");
      
      // Cancel the PaymentIntent
      await stripe.paymentIntents.cancel(trip.stripe_payment_intent_id);
      
      // Commit wallet hold to debit
      if (walletHoldId) {
        await supabaseClient
          .from("customer_wallet_ledger")
          .update({
            entry_type: "DEBIT",
            status: "committed",
          })
          .eq("id", walletHoldId);
      }

      await supabaseClient
        .from("trips")
        .update({ payment_status: "paid" })
        .eq("id", trip_id);

      return new Response(JSON.stringify({
        success: true,
        message: "Payment completed via wallet",
        final_total_pence: finalTotalPence,
        wallet_applied_pence: walletAppliedPence,
        stripe_captured_pence: 0,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
    }

    paymentAudit("TIP_CAPTURE_STARTED", {
      trip_id,
      tip_pence: finalTipPence,
      capture_amount_pence: finalTotalAfterWalletPence,
    });

    // Capture the PaymentIntent
    // IMPORTANT: Can never capture more than what was authorized
    const maxCapturablePence = paymentIntent.amount_capturable ?? paymentIntent.amount;
    const amountToCapture = Math.min(finalTotalAfterWalletPence, maxCapturablePence);

    // ─────────────────────────────────────────────────────────────────────
    // AUDIT LOG — full pre-capture trace (required for buffer-release debug).
    // Stripe automatically VOIDS the unused authorization portion when you
    // capture less than the authorized amount via `amount_to_capture`.
    // No separate release/void call is required.
    // ─────────────────────────────────────────────────────────────────────
    const authorisedAmountPence = paymentIntent.amount;
    const estimatedFarePence = trip.estimated_total_pence
      ?? (trip.estimated_fare ? Math.round(trip.estimated_fare * 100) : null);
    const configuredBufferPence = (trip.authorised_amount_pence ?? authorisedAmountPence)
      - (estimatedFarePence ?? 0);
    const releasedAmountPence = Math.max(0, authorisedAmountPence - amountToCapture);

    logStep("PRE-CAPTURE AUDIT", {
      trip_id,
      payment_intent_id: paymentIntent.id,
      estimated_fare_pence: estimatedFarePence,
      configured_buffer_pence: configuredBufferPence,
      authorised_amount_pence: authorisedAmountPence,
      final_trip_fare_pence: finalFarePence,
      final_total_after_wallet_pence: finalTotalAfterWalletPence,
      capture_amount_to_stripe_pence: amountToCapture,
      released_amount_pence: releasedAmountPence,
      payment_intent_status_before: paymentIntent.status,
    });

    if (amountToCapture < finalTotalAfterWalletPence) {
      logStep("Capping capture to authorized amount (shortfall will be charged separately)", {
        requested: finalTotalAfterWalletPence,
        maxCapturable: maxCapturablePence,
        willCapture: amountToCapture,
        shortfallPence: finalTotalAfterWalletPence - amountToCapture,
      });
    }

    const driverId = (trip as { driver_id?: string | null }).driver_id ?? null;
    const commissionPercent = await resolveDriverTierCommissionPercent(
      supabaseClient,
      trip as Record<string, unknown>,
      driverId,
    );

    // Settlement base = what Stripe can actually capture (never expected payable alone).
    const expectedPayablePence = finalTotalAfterWalletPence;
    const outstandingShortfallPence = Math.max(0, expectedPayablePence - amountToCapture);
    const settlementBasePence = amountToCapture;

    // Driver/commission settle on captured base only when shortfall exists (MK-260704-002).
    let breakdown = outstandingShortfallPence > 0
      ? computeDriverCommissionBreakdown({
        totalCustomerFarePence: settlementBasePence,
        airportChargePence: Math.min(resolvedFare.airport_charge_pence, settlementBasePence),
        otherPassThroughChargesPence: 0,
        tipsPence: Math.min(resolvedFare.tips_pence, settlementBasePence),
        commissionPercent: capTierCommissionPercent(commissionPercent),
      })
      : computeDriverEarningsBreakdown(
        tripForFare,
        commissionPercent,
        finalTipPence,
      );

    if (outstandingShortfallPence > 0) {
      logStep("SHORTFALL_PENDING — settling on Stripe capturable only", {
        trip_id,
        expected_payable_pence: expectedPayablePence,
        settlement_base_pence: settlementBasePence,
        outstanding_shortfall_pence: outstandingShortfallPence,
        driver_net_pence: breakdown.driver_net_pence,
        commission_pence: breakdown.commission_pence,
      });
      try {
        await supabaseClient.rpc("ops_record_event", {
          p_event_type: "CAPTURE_SHORTFALL",
          p_category: "payment",
          p_severity: "critical",
          p_app: "finalize-trip-and-capture",
          p_trip_id: trip_id,
          p_amount_pence: outstandingShortfallPence,
          p_currency_code: "GBP",
          p_description: `Capture shortfall ${outstandingShortfallPence}p (expected ${expectedPayablePence}, capturable ${settlementBasePence})`,
          p_metadata: {
            expected_payable_pence: expectedPayablePence,
            capturable_pence: settlementBasePence,
            outstanding_shortfall_pence: outstandingShortfallPence,
            payment_intent_id: trip.stripe_payment_intent_id,
          },
          p_create_alert: true,
        });
      } catch (alertErr) {
        logStep("CAPTURE_SHORTFALL alert failed", { error: String(alertErr) });
      }
    }

    let capturedPi: Stripe.PaymentIntent;
    let settlement: StripeSettlementResult | null = null;
    const outstandingRecoveryDebtPence = driverId
      ? await loadDriverOutstandingRecoveryDebtPence(supabaseClient, driverId)
      : 0;
    const recoverySettlementArgs = buildCardCaptureRecoverySettlementArgs({
      driverNetPence: breakdown.driver_net_pence,
      outstandingRecoveryDebtPence,
      airportChargePence: breakdown.airport_charge_pence,
      otherPassThroughChargesPence: breakdown.other_pass_through_charges_pence,
      tipPence: breakdown.tips_pence,
    });
    try {
      if (paymentIntent.status === "succeeded") {
        logStep("PaymentIntent already succeeded — ensuring Connect settlement");
        settlement = await ensureStripeSettlementForCapturedPayment({
          stripe,
          supabase: supabaseClient,
          tripId: trip_id,
          driverId,
          paymentIntentId: trip.stripe_payment_intent_id,
          commissionPence: breakdown.commission_pence,
          driverPayoutPence: Math.max(0, amountToCapture - breakdown.commission_pence),
          currencyCode: paymentIntent.currency ?? "gbp",
          idempotencyKey: `recovery_succeeded_${trip_id}_${amountToCapture}`,
          ...recoverySettlementArgs,
        });
        capturedPi = settlement.capturedPaymentIntent;
        logStep("POST-RECOVERY AUDIT", {
          payment_intent_id: capturedPi.id,
          settlement_verified: settlement.settlementVerified,
          settlement_mode: settlement.settlementMode,
          charge_id: settlement.chargeId,
          application_fee_id: settlement.applicationFeeId,
          transfer_id: settlement.transferId,
        });
      } else if (paymentIntent.status === "requires_capture") {
        settlement = await capturePaymentIntentWithSettlement({
          stripe,
          supabase: supabaseClient,
          tripId: trip_id,
          driverId,
          paymentIntentId: trip.stripe_payment_intent_id,
          captureAmountPence: amountToCapture,
          commissionPence: breakdown.commission_pence,
          driverPayoutPence: Math.max(0, amountToCapture - breakdown.commission_pence),
          currencyCode: paymentIntent.currency ?? "gbp",
          idempotencyKey: `capture_${trip_id}_${amountToCapture}`,
          ...recoverySettlementArgs,
        });
        capturedPi = settlement.capturedPaymentIntent;
        logStep("POST-CAPTURE AUDIT", {
          payment_intent_id: capturedPi.id,
          payment_intent_status_after: capturedPi.status,
          captured_amount_pence: settlement.capturedAmountPence,
          released_amount_pence: releasedAmountPence,
          authorised_amount_pence: authorisedAmountPence,
          settlement_verified: settlement.settlementVerified,
          settlement_mode: settlement.settlementMode,
          charge_id: settlement.chargeId,
          application_fee_id: settlement.applicationFeeId,
          transfer_id: settlement.transferId,
        });

        paymentAudit("TIP_CAPTURE_SUCCESS", {
          trip_id,
          service_area_id: (trip as any).service_area_id ?? null,
          payment_intent_id: capturedPi.id,
          payment_intent_status_before: paymentIntent.status,
          payment_intent_status_after: capturedPi.status,
          estimated_fare_pence: estimatedFarePence,
          buffer_amount_pence: configuredBufferPence,
          preauth_hold_pence: authorisedAmountPence,
          final_fare_pence: finalFarePence,
          extras_pence: resolvedFare.customer_modification_charge_pence,
          tip_pence: resolvedFare.tips_pence,
          waiting_charge_pence: waitingChargePence,
          wallet_applied_pence: walletAppliedPence,
          capture_amount_pence: amountToCapture,
          released_amount_pence: releasedAmountPence,
          reauth_required: (finalTotalAfterWalletPence - amountToCapture) > 0,
          mode: "primary_capture",
        });
        if (resolvedFare.tips_pence > 0) {
          paymentAudit("TIP_SAVED_TO_TRIP", { trip_id, tip_pence: resolvedFare.tips_pence });
          paymentAudit("TIP_CAPTURE_INCLUDED", {
            trip_id,
            mode: "primary_capture",
            tip_pence: resolvedFare.tips_pence,
          });
        }
      } else {
        // PI not in capturable state
        logStep("PaymentIntent not in requires_capture state", { status: paymentIntent.status });
        
        // Release wallet hold if capture fails
        if (walletHoldId) {
          await supabaseClient
            .from("customer_wallet_ledger")
            .update({
              entry_type: "HOLD_RELEASED",
              status: "released",
            })
            .eq("id", walletHoldId);
        }

        return new Response(JSON.stringify({
          success: false,
          error: `PaymentIntent not capturable. Status: ${paymentIntent.status}`,
          payment_intent_status: paymentIntent.status,
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 400,
        });
      }
    } catch (captureError) {
      const errorMessage = captureError instanceof Error ? captureError.message : String(captureError);
      logStep("Capture failed", { error: errorMessage });

      // Release wallet hold on failure
      if (walletHoldId) {
        await supabaseClient
          .from("customer_wallet_ledger")
          .update({
            entry_type: "HOLD_RELEASED",
            status: "released",
          })
          .eq("id", walletHoldId);
      }

      await supabaseClient
        .from("trips")
        .update({ payment_status: "capture_failed" })
        .eq("id", trip_id);

      throw new Error(`Capture failed: ${errorMessage}`);
    }

    // Handle shortfall: if fare increased beyond original auth (e.g. trip modification)
    const shortfallPence = finalTotalAfterWalletPence - amountToCapture;
    let shortfallPiId: string | null = null;

    if (shortfallPence > 0) {
      logStep("Shortfall detected — charging difference with saved payment method", { shortfallPence });

      try {
        // Get the customer's saved payment method from the original PI
        const customerId = paymentIntent.customer as string | null;
        const paymentMethodId = paymentIntent.payment_method as string | null;

        if (customerId && paymentMethodId) {
          // Use the currency from the original PaymentIntent (set from Region at booking)
          if (!paymentIntent.currency) {
            throw new Error("Original PaymentIntent missing currency — cannot charge shortfall");
          }
          const shortfallPi = await stripe.paymentIntents.create({
            amount: shortfallPence,
            currency: paymentIntent.currency,
            customer: customerId,
            payment_method: paymentMethodId,
            off_session: true,
            confirm: true,
            metadata: {
              trip_id: trip_id,
              type: "trip_modification_shortfall",
              original_pi: trip.stripe_payment_intent_id,
              shortfall_pence: shortfallPence.toString(),
            },
          });

          shortfallPiId = shortfallPi.id;
          logStep("Shortfall charge succeeded", { 
            shortfallPiId, 
            amount: shortfallPence, 
            status: shortfallPi.status 
          });
        } else {
          logStep("Cannot charge shortfall — no saved customer/payment method", { customerId, paymentMethodId });
        }
      } catch (shortfallError) {
        const msg = shortfallError instanceof Error ? shortfallError.message : String(shortfallError);
        logStep("Shortfall charge failed (non-blocking)", { error: msg, shortfallPence });
        // Don't fail the whole finalization — log for reconciliation
      }
    }

    // Commission / driver payout computed pre-capture for Connect settlement.
    let stripeFeeAmountPence = settlement?.stripeFeePence ?? 0;
    if (!settlement) {
      try {
        const charges = await stripe.charges.list({
          payment_intent: trip.stripe_payment_intent_id,
          limit: 1,
          expand: ["data.balance_transaction"],
        });
        const ch = charges.data[0];
        const bt = ch?.balance_transaction as Stripe.BalanceTransaction | null;
        if (bt && typeof bt.fee === "number") {
          stripeFeeAmountPence = bt.fee;
        }
      } catch (feeErr) {
        logStep("Could not read Stripe fee (non-fatal)", { error: String(feeErr) });
      }
    }

    logStep("Commission breakdown computed", {
      finalFarePence,
      finalTotalPence,
      extras_pence: resolvedFare.customer_modification_charge_pence,
      finalTipPence: resolvedFare.tips_pence,
      commissionPercent,
      ...breakdown,
      stripeFeeAmountPence,
    });

    // Stripe actual captured amount is SSOT — never write expected payable here.
    const stripeCapturedPence = Math.max(
      0,
      settlement?.capturedAmountPence
        ?? (typeof capturedPi.amount_received === "number" ? capturedPi.amount_received : 0)
        ?? amountToCapture,
    );
    const outstandingAfterCapture = Math.max(0, expectedPayablePence - stripeCapturedPence);

    // Re-settle on Stripe actual if it differs from capturable estimate.
    if (stripeCapturedPence > 0 && stripeCapturedPence !== settlementBasePence) {
      breakdown = computeDriverCommissionBreakdown({
        totalCustomerFarePence: stripeCapturedPence,
        airportChargePence: Math.min(resolvedFare.airport_charge_pence, stripeCapturedPence),
        otherPassThroughChargesPence: 0,
        tipsPence: Math.min(resolvedFare.tips_pence, stripeCapturedPence),
        commissionPercent: capTierCommissionPercent(commissionPercent),
      });
    }

    // ONECAB net = gross commission − Stripe processing fee.
    // Driver payout is unaffected; this is platform accounting only.
    const onecabNetPence = Math.max(
      0,
      breakdown.commission_pence - stripeFeeAmountPence,
    );

    const paymentCoverageStatus = outstandingAfterCapture > 0
      ? "under_captured"
      : "fully_covered";

    // Persist breakdown on the trip (+ Connect settlement when captured this call)
    await supabaseClient
      .from("trips")
      .update({
        gross_fare_pence: breakdown.commissionable_fare_pence,
        commissionable_fare_pence: breakdown.commissionable_fare_pence,
        airport_charge_pence: breakdown.airport_charge_pence,
        other_pass_through_charges_pence: breakdown.other_pass_through_charges_pence,
        driver_tier_commission_percent: commissionPercent,
        commission_pct: commissionPercent,
        commission_pence: breakdown.commission_pence,
        driver_net_pence: breakdown.driver_net_pence,
        driver_net_before_tip_pence: breakdown.driver_net_pence,
        driver_total_earnings_pence: breakdown.driver_total_earnings_pence,
        stripe_fee_amount: stripeFeeAmountPence,
        stripe_processing_fee_pence: stripeFeeAmountPence,
        onecab_net_pence: onecabNetPence,
        payment_coverage_status: paymentCoverageStatus,
        ...(settlement ? tripSettlementColumnsFromResult(settlement) : {}),
      })
      .eq("id", trip_id);

    // When Stripe confirms capture synchronously, mark captured in DB — do not
    // rely solely on payment_intent.succeeded webhook (Connect/webhook delays
    // leave trips stuck at capture_requested while the bank shows a charge).
    const captureConfirmedInStripe = capturedPi.status === "succeeded";
    const paymentStatusAfterCapture = captureConfirmedInStripe ? "captured" : "capture_requested";

    // Update payment record — captured_amount_pence = Stripe actual only.
    await supabaseClient
      .from("payments")
      .update({
        status: paymentStatusAfterCapture,
        captured_amount_pence: stripeCapturedPence,
        amount_pence: stripeCapturedPence + (shortfallPiId ? shortfallPence : 0),
        gross_amount_pence: expectedPayablePence,
        commission_amount_pence: breakdown.commission_pence,
        driver_amount_pence: breakdown.driver_total_earnings_pence,
        stripe_fee_pence: stripeFeeAmountPence,
        net_platform_amount_pence: onecabNetPence,
        metadata: {
          final_fare_pence: finalFarePence,
          expected_payable_pence: expectedPayablePence,
          stripe_captured_pence: stripeCapturedPence,
          outstanding_shortfall_pence: outstandingAfterCapture > 0 ? outstandingAfterCapture : undefined,
          tip_pence: resolvedFare.tips_pence,
          wallet_applied_pence: walletAppliedPence,
          shortfall_pence: shortfallPence > 0 ? shortfallPence : undefined,
          shortfall_pi_id: shortfallPiId || undefined,
          commission_percent: commissionPercent,
          commissionable_fare_pence: breakdown.commissionable_fare_pence,
          airport_charge_pence: breakdown.airport_charge_pence,
          other_pass_through_charges_pence: breakdown.other_pass_through_charges_pence,
          commission_pence: breakdown.commission_pence,
          driver_net_pence: breakdown.driver_net_pence,
          driver_total_earnings_pence: breakdown.driver_total_earnings_pence,
          stripe_fee_amount: stripeFeeAmountPence,
          payment_coverage_status: paymentCoverageStatus,
        },
      })
      .eq("trip_id", trip_id)
      .eq("stripe_payment_intent_id", trip.stripe_payment_intent_id);

    if (captureConfirmedInStripe) {
      await supabaseClient
        .from("trips")
        .update({
          payment_status: "captured",
          capture_amount_pence: stripeCapturedPence,
          payment_coverage_status: paymentCoverageStatus,
          ...(settlement ? tripSettlementColumnsFromResult(settlement) : {}),
        })
        .eq("id", trip_id);

      if (driverId) {
        let ledgerCurrency = "GBP";
        const { data: drvRegion } = await supabaseClient
          .from("drivers")
          .select("region_id")
          .eq("id", driverId)
          .single();
        if (drvRegion?.region_id) {
          const { data: region } = await supabaseClient
            .from("regions")
            .select("currency_code")
            .eq("id", drvRegion.region_id)
            .single();
          ledgerCurrency = region?.currency_code || ledgerCurrency;
        }

        await creditCapturedCardTripLedger(supabaseClient, {
          driverId,
          tripId: trip_id,
          driverNetPence: breakdown.driver_net_pence,
          tipPence: resolvedFare.tips_pence,
          currency: ledgerCurrency,
          commissionPct: commissionPercent,
        });
      }
    }

    logStep(captureConfirmedInStripe ? "Capture confirmed in Stripe and DB" : "Capture requested successfully");

    return new Response(JSON.stringify({
      success: true,
      message: shortfallPiId 
        ? "Capture completed with additional shortfall charge" 
        : "Capture requested - awaiting webhook confirmation",
      payment_intent_id: capturedPi.id,
      payment_intent_status: capturedPi.status,
      final_total_pence: finalTotalPence,
      wallet_applied_pence: walletAppliedPence,
      stripe_captured_pence: stripeCapturedPence,
      expected_payable_pence: expectedPayablePence,
      outstanding_shortfall_pence: outstandingAfterCapture,
      payment_coverage_status: paymentCoverageStatus,
      shortfall_pence: shortfallPence > 0 ? shortfallPence : 0,
      shortfall_charged: !!shortfallPiId,
      tip_pence: resolvedFare.tips_pence,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message: errorMessage });
    return new Response(JSON.stringify({ error: errorMessage }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
