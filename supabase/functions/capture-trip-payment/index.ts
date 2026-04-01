import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@14.21.0";
import { validateTripAccounting } from "../_shared/tripAccounting.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * capture-trip-payment
 * 
 * Uses Stripe Connect DESTINATION CHARGES.
 * Currency is passed from complete-trip (already resolved from Region).
 * No hardcoded currency — currency_code is REQUIRED.
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const {
      trip_id,
      driver_id,
      payment_intent_id,
      final_trip_total_pence,
      commissionable_subtotal_pence,
      platform_commission_pence,
      driver_total_earnings_pence,
      tip_amount_pence = 0,
      currency_code,
      driver_stripe_account_id,
    } = body;

    // Validate required fields — currency_code is mandatory (no GBP fallback)
    if (!trip_id || !driver_id || !payment_intent_id || !final_trip_total_pence || platform_commission_pence === undefined || !currency_code) {
      return new Response(JSON.stringify({ error: 'Missing required fields (including currency_code)' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Verify business rule: final_total = subtotal + tip
    if (final_trip_total_pence !== commissionable_subtotal_pence + tip_amount_pence) {
      console.error(`[capture] Business rule violation: ${final_trip_total_pence} != ${commissionable_subtotal_pence} + ${tip_amount_pence}`);
      return new Response(JSON.stringify({ error: 'final_trip_total must equal subtotal + tip' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const accountingError = validateTripAccounting({
      commissionableSubtotalPence: commissionable_subtotal_pence,
      commissionPence: platform_commission_pence,
      tipAmountPence: tip_amount_pence,
      driverNetBeforeTipPence: commissionable_subtotal_pence - platform_commission_pence,
      driverTotalEarningsPence: driver_total_earnings_pence,
      finalTripTotalPence: final_trip_total_pence,
    });

    if (accountingError) {
      console.error(`[capture] Accounting invariant failed for trip ${trip_id}: ${accountingError}`);
      return new Response(JSON.stringify({ error: accountingError }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const stripeSecretKey = Deno.env.get('STRIPE_SECRET_KEY');
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    console.log(`[capture] Starting capture for trip ${trip_id}, PI: ${payment_intent_id}, currency: ${currency_code}`);
    console.log(`[capture] Total: ${final_trip_total_pence}p, Commission: ${platform_commission_pence}p, DriverEarnings: ${driver_total_earnings_pence}p, Tip: ${tip_amount_pence}p`);

    // === IDEMPOTENCY: Check if already processed ===
    const { data: existingLedger } = await supabase
      .from('driver_ledger')
      .select('id')
      .eq('trip_id', trip_id)
      .eq('entry_type', 'TRIP_EARNING_NET')
      .maybeSingle();

    if (existingLedger) {
      console.log(`[capture] Already processed trip ${trip_id}, returning idempotent response`);
      return new Response(JSON.stringify({
        success: true,
        idempotent: true,
        trip_id,
        message: 'Payment already captured and settled',
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // === Calculate wallet debt for debt recovery ===
    // IMPORTANT: Exclude COMPANY_COMMISSION from wallet balance — it is platform revenue, not driver funds
    const { data: walletEntries } = await supabase
      .from('driver_ledger')
      .select('amount_pence')
      .eq('driver_id', driver_id)
      .neq('entry_type', 'COMPANY_COMMISSION');

    const walletBalanceBefore = walletEntries?.reduce((sum, e) => sum + (e.amount_pence || 0), 0) || 0;
    let debtRecoveryPence = 0;

    if (walletBalanceBefore < 0) {
      debtRecoveryPence = Math.min(Math.abs(walletBalanceBefore), driver_total_earnings_pence);
      console.log(`[capture] Wallet debt: ${walletBalanceBefore}p, recovering: ${debtRecoveryPence}p`);
    }

    const finalDriverPayoutPence = driver_total_earnings_pence - debtRecoveryPence;
    console.log(`[capture] Final payout after debt recovery: ${finalDriverPayoutPence}p`);

    // === STRIPE: Capture PaymentIntent (Destination Charges) ===
    let stripeFee = 0;
    let stripeApplicationFeeId: string | null = null;
    let captureSuccess = false;

    if (stripeSecretKey) {
      const stripe = new Stripe(stripeSecretKey, { apiVersion: '2023-10-16' });
      const idempotencyKey = `capture_${trip_id}`;

      try {
        const captureParams: Record<string, unknown> = {
          amount_to_capture: final_trip_total_pence,
        };

        if (driver_stripe_account_id) {
          captureParams.application_fee_amount = platform_commission_pence;
        }

        const pi = await stripe.paymentIntents.capture(
          payment_intent_id,
          captureParams as Stripe.PaymentIntentCaptureParams,
          { idempotencyKey: `${idempotencyKey}_capture` },
        );

        console.log(`[capture] PaymentIntent captured: ${pi.id}, status: ${pi.status}`);

        if (pi.latest_charge) {
          try {
            const charge = await stripe.charges.retrieve(pi.latest_charge as string, {
              expand: ['balance_transaction', 'application_fee'],
            });
            const bt = charge.balance_transaction;
            if (bt && typeof bt === 'object' && 'fee' in bt) {
              stripeFee = bt.fee;
              console.log(`[capture] Stripe fee: ${stripeFee}p`);
            }
            if (charge.application_fee && typeof charge.application_fee === 'object') {
              stripeApplicationFeeId = charge.application_fee.id;
            } else if (typeof charge.application_fee === 'string') {
              stripeApplicationFeeId = charge.application_fee;
            }
          } catch (feeErr) {
            console.log(`[capture] Could not retrieve Stripe fee: ${(feeErr as Error).message}`);
          }
        }

        captureSuccess = true;

        if (!driver_stripe_account_id) {
          console.warn(`[capture] No driver connected account — full amount retained by platform. Manual payout required for driver ${driver_id}`);
        }

      } catch (captureErr) {
        console.error(`[capture] Stripe capture failed:`, captureErr);
        const errMsg = (captureErr as Error).message;

        await supabase.from('trips').update({
          payment_status: 'capture_failed',
          updated_at: new Date().toISOString(),
        }).eq('id', trip_id);

        return new Response(JSON.stringify({
          success: false,
          error: 'Stripe capture failed',
          details: errMsg,
        }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
    } else {
      captureSuccess = true;
      console.log(`[capture] No STRIPE_SECRET_KEY, operating in ledger-only mode`);
    }

    // === LEDGER: Record driver earning ===
    const { error: ledgerError } = await supabase
      .from('driver_ledger')
      .insert({
        driver_id,
        trip_id,
        entry_type: 'TRIP_EARNING_NET',
        amount_pence: driver_total_earnings_pence,
        currency_code,
        description: `Trip earnings (net + tip)`,
        reference_id: payment_intent_id,
      });

    if (ledgerError) {
      console.error(`[capture] Ledger entry failed:`, ledgerError);
    } else {
      console.log(`[capture] Ledger TRIP_EARNING_NET: +${driver_total_earnings_pence}p`);
    }

    // === LEDGER: Record company commission (platform revenue SSOT) ===
    if (platform_commission_pence > 0) {
      await supabase.from('driver_ledger').insert({
        driver_id,
        trip_id,
        entry_type: 'COMPANY_COMMISSION',
        amount_pence: platform_commission_pence,
        currency_code,
        description: `Platform commission from card trip`,
        reference_id: payment_intent_id,
      });
      console.log(`[capture] COMPANY_COMMISSION: +${platform_commission_pence}p`);
    }

    // === LEDGER: Record debt recovery if applicable ===
    if (debtRecoveryPence > 0) {
      const { error: recoveryError } = await supabase
        .from('driver_ledger')
        .insert({
          driver_id,
          trip_id,
          entry_type: 'DEBT_RECOVERY',
          amount_pence: -debtRecoveryPence,
          currency_code,
          description: `Debt recovery from cash trip commission`,
          reference_id: `recovery_${trip_id}`,
        });

      if (recoveryError) {
        console.error(`[capture] Debt recovery ledger failed:`, recoveryError);
      } else {
        console.log(`[capture] Ledger DEBT_RECOVERY: -${debtRecoveryPence}p`);
      }
    }

    // === Calculate new wallet balance ===
    const walletBalanceAfter = walletBalanceBefore + driver_total_earnings_pence - debtRecoveryPence;

    // === Update trip with settlement data ===
    await supabase.from('trips').update({
      payment_status: captureSuccess ? 'captured' : 'capture_failed',
      stripe_processing_fee_pence: stripeFee,
      debt_recovery_pence: debtRecoveryPence,
      final_payout_pence: finalDriverPayoutPence,
      wallet_balance_before: walletBalanceBefore,
      wallet_balance_after: walletBalanceAfter,
      updated_at: new Date().toISOString(),
    }).eq('id', trip_id);

    console.log(`[capture] Trip ${trip_id} settlement complete`);
    console.log(`[capture] Summary: total=${final_trip_total_pence}p, commission=${platform_commission_pence}p, stripeFee=${stripeFee}p, driverEarnings=${driver_total_earnings_pence}p, debtRecovery=${debtRecoveryPence}p, finalPayout=${finalDriverPayoutPence}p`);
    console.log(`[capture] Platform revenue: commission(${platform_commission_pence}p) - stripeFee(${stripeFee}p) = ${platform_commission_pence - stripeFee}p`);

    return new Response(JSON.stringify({
      success: true,
      trip_id,
      driver_id,
      final_trip_total_pence,
      commissionable_subtotal_pence,
      platform_commission_pence,
      driver_total_earnings_pence,
      tip_amount_pence,
      stripe_fee_pence: stripeFee,
      stripe_application_fee_id: stripeApplicationFeeId,
      debt_recovery_pence: debtRecoveryPence,
      final_driver_payout_pence: finalDriverPayoutPence,
      wallet_balance_before: walletBalanceBefore,
      wallet_balance_after: walletBalanceAfter,
      platform_net_revenue: platform_commission_pence - stripeFee,
      payment_status: 'captured',
      currency_code,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('[capture] Error:', error);
    return new Response(JSON.stringify({
      error: (error as Error).message,
    }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
