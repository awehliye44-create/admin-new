import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@14.21.0";
import { validateTripAccounting } from "../_shared/tripAccounting.ts";
import { capturePaymentIntentWithSettlement } from "../_shared/stripeSettlement.ts";
import { assertServiceRole } from "../_shared/internalAuth.ts";
import {
  creditCapturedCardTripLedger,
  recordCardCaptureFailure,
} from "../_shared/onecabFinanceLedger.ts";


const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * capture-trip-payment (LEGACY — prefer finalize-trip-and-capture on drive-hub-buddy)
 *
 * Uses Stripe Connect DESTINATION CHARGES.
 * Currency is passed from complete-trip (already resolved from Region).
 * All financial entries go to driver_wallet_ledger.
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const gate = assertServiceRole(req);
  if (gate) return gate;

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
      .from('driver_wallet_ledger')
      .select('id')
      .eq('related_trip_id', trip_id)
      .eq('type', 'TRIP_EARNING_NET')
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
    const { data: walletEntries } = await supabase
      .from('driver_wallet_ledger')
      .select('amount_pence')
      .eq('driver_id', driver_id)
      .not('type', 'in', '("PLATFORM_COMMISSION","CASH_TRIP_EARNING")');

    const walletBalanceBefore = walletEntries?.reduce((sum, e) => sum + (e.amount_pence || 0), 0) || 0;
    let debtRecoveryPence = 0;

    // === STRIPE: Capture PaymentIntent and enforce real settlement ===
    let stripeChargeId: string | null = null;
    let stripeCapturedAmount = final_trip_total_pence;
    let stripeFee = 0;
    let stripeApplicationFeeId: string | null = null;
    let stripeApplicationFeeAmount: number | null = null;
    let stripeDestinationAccountId: string | null = null;
    let stripeTransferId: string | null = null;
    let stripeTransferAmount: number | null = null;
    let stripeSettlementVerified = false;
    let stripeSettlementWarning: string | null = null;
    let captureSuccess = false;

    if (stripeSecretKey) {
      const stripe = new Stripe(stripeSecretKey, { apiVersion: '2023-10-16' });
      const idempotencyKey = `capture_${trip_id}`;

      try {
        const settlement = await capturePaymentIntentWithSettlement({
          stripe,
          supabase,
          tripId: trip_id,
          driverId: driver_id,
          paymentIntentId: payment_intent_id,
          captureAmountPence: final_trip_total_pence,
          commissionPence: platform_commission_pence,
          driverPayoutPence: driver_total_earnings_pence,
          currencyCode: currency_code,
          driverStripeAccountId: driver_stripe_account_id,
          idempotencyKey: `${idempotencyKey}_capture`,
        });

        console.log(`[capture] PaymentIntent captured: ${settlement.capturedPaymentIntent.id}, status: ${settlement.capturedPaymentIntent.status}`);

        stripeChargeId = settlement.chargeId;
        stripeCapturedAmount = settlement.capturedAmountPence;
        stripeFee = settlement.stripeFeePence;
        stripeApplicationFeeId = settlement.applicationFeeId;
        stripeApplicationFeeAmount = settlement.applicationFeeAmountPence;
        stripeDestinationAccountId = settlement.destinationAccountId;
        stripeTransferId = settlement.transferId;
        stripeTransferAmount = settlement.transferAmountPence;
        stripeSettlementVerified = settlement.settlementVerified;
        stripeSettlementWarning = settlement.settlementWarning;
        console.log(`[capture] Stripe fee: ${stripeFee}p, application_fee_amount=${stripeApplicationFeeAmount ?? 'none'}p, transfer_amount=${stripeTransferAmount ?? 'none'}p`);

        captureSuccess = true;

        if (!driver_stripe_account_id) {
          console.warn(`[capture] No driver connected account — full amount retained by platform. Manual payout required for driver ${driver_id}`);
        }

      } catch (captureErr) {
        console.error(`[capture] Stripe capture failed:`, captureErr);
        const errMsg = (captureErr as Error).message;

        await recordCardCaptureFailure(supabase, {
          tripId: trip_id,
          driverId: driver_id,
          message: errMsg,
          stripePaymentIntentId: payment_intent_id,
        });

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

    // === LEDGER: only after successful capture ===
    if (!captureSuccess) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Capture not completed — no wallet credit created',
      }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const ledgerResult = await creditCapturedCardTripLedger(supabase, {
      driverId: driver_id,
      tripId: trip_id,
      driverNetPence: driver_total_earnings_pence - tip_amount_pence,
      tipPence: tip_amount_pence,
      currency: currency_code,
    });
    debtRecoveryPence = ledgerResult.recovery_pence;
    console.log(`[capture] Ledger credited via SSOT, debt recovery: ${debtRecoveryPence}p`);

    const { error: recalcError } = await supabase.rpc('recalculate_driver_wallet', {
      p_driver_id: driver_id,
    });
    if (recalcError) {
      console.warn(`[capture] Wallet cache recalc failed for ${driver_id}: ${recalcError.message}`);
    }

    await supabase.from('trip_finance').update({
      financial_status: 'recognized',
      updated_at: new Date().toISOString(),
    }).eq('trip_id', trip_id);

    // === Calculate new wallet balance ===
    const walletBalanceAfter = walletBalanceBefore + driver_total_earnings_pence - debtRecoveryPence;

    // === Update trip with settlement data ===
    await supabase.from('trips').update({
      payment_status: captureSuccess ? 'captured' : 'capture_failed',
      capture_amount_pence: stripeCapturedAmount,
      stripe_charge_id: stripeChargeId,
      stripe_processing_fee_pence: stripeFee,
      onecab_net_pence: Math.max(0, platform_commission_pence - stripeFee),
      stripe_application_fee_id: stripeApplicationFeeId,
      stripe_application_fee_amount_pence: stripeApplicationFeeAmount,
      stripe_destination_account_id: stripeDestinationAccountId,
      stripe_transfer_id: stripeTransferId,
      stripe_transfer_amount_pence: stripeTransferAmount,
      stripe_settlement_verified: stripeSettlementVerified,
      stripe_settlement_warning: stripeSettlementWarning,
      debt_recovery_pence: debtRecoveryPence,
      final_payout_pence: finalDriverPayoutPence,
      wallet_balance_before: walletBalanceBefore,
      wallet_balance_after: walletBalanceAfter,
      updated_at: new Date().toISOString(),
    }).eq('id', trip_id);

    console.log(`[capture] Trip ${trip_id} settlement complete`);
    console.log(`[capture] Summary: total=${final_trip_total_pence}p, commission(gross)=${platform_commission_pence}p, stripeFee=${stripeFee}p, onecabNet=${platform_commission_pence - stripeFee}p, driverEarnings=${driver_total_earnings_pence}p, debtRecovery=${debtRecoveryPence}p, finalPayout=${finalDriverPayoutPence}p, appFeeId=${stripeApplicationFeeId ?? 'none'}, appFeeAmount=${stripeApplicationFeeAmount ?? 'none'}p, destination=${stripeDestinationAccountId ?? 'none'}, transfer=${stripeTransferId ?? 'none'}, verified=${stripeSettlementVerified}`);
    // NOTE: commission_pence is GROSS (before Stripe fee). Stripe fee is tracked separately as stripe_processing_fee_pence. ONECAB net = commission - stripe fee. Stripe fee is NEVER deducted from the driver.

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
      stripe_application_fee_amount_pence: stripeApplicationFeeAmount,
      stripe_destination_account_id: stripeDestinationAccountId,
      stripe_transfer_id: stripeTransferId,
      stripe_transfer_amount_pence: stripeTransferAmount,
      stripe_settlement_verified: stripeSettlementVerified,
      stripe_settlement_warning: stripeSettlementWarning,
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
