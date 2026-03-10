import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@14.21.0";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * capture-trip-payment
 * 
 * Called after complete-trip to handle the Stripe settlement for digital trips.
 * 
 * Flow:
 * 1. Capture the pre-authorized PaymentIntent for the final fare
 * 2. Create a Transfer to the driver's connected account for driver_net only
 * 3. Platform retains commission automatically (fare - driver_net stays on platform)
 * 4. Record ledger entry for driver earnings
 * 5. Check wallet debt and apply debt recovery before final payout amount
 * 
 * Business rules:
 * - driver_net = fare - platform_commission
 * - Stripe fees are absorbed by ONECAB (platform cost)
 * - driver_net shown in app = actual payout amount (before debt recovery)
 * - debt_recovery reduces the transfer amount, NOT the driver_net
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
      final_fare_pence,
      commission_pence,
      driver_net_pence,
      currency_code = 'GBP',
    } = body;

    // Validate required fields
    if (!trip_id || !driver_id || !payment_intent_id || !final_fare_pence || commission_pence === undefined || !driver_net_pence) {
      return new Response(JSON.stringify({ error: 'Missing required fields' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Verify business rule: driver_net = fare - commission
    if (driver_net_pence !== final_fare_pence - commission_pence) {
      console.error(`[capture] Business rule violation: ${driver_net_pence} != ${final_fare_pence} - ${commission_pence}`);
      return new Response(JSON.stringify({ error: 'driver_net must equal fare minus commission' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const stripeSecretKey = Deno.env.get('STRIPE_SECRET_KEY');
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    console.log(`[capture] Starting capture for trip ${trip_id}, PI: ${payment_intent_id}`);
    console.log(`[capture] Fare: ${final_fare_pence}p, Commission: ${commission_pence}p, Driver Net: ${driver_net_pence}p`);

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

    // === Get driver info ===
    const { data: driver, error: driverError } = await supabase
      .from('drivers')
      .select('id, first_name, last_name, stripe_account_id, payouts_enabled')
      .eq('id', driver_id)
      .single();

    if (driverError || !driver) {
      return new Response(JSON.stringify({ error: 'Driver not found' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // === Calculate wallet debt for debt recovery ===
    const { data: walletEntries } = await supabase
      .from('driver_ledger')
      .select('amount_pence')
      .eq('driver_id', driver_id);

    const walletBalanceBefore = walletEntries?.reduce((sum, e) => sum + (e.amount_pence || 0), 0) || 0;
    let debtRecoveryPence = 0;

    // If wallet is negative (debt from cash trips), recover from this earning
    if (walletBalanceBefore < 0) {
      debtRecoveryPence = Math.min(Math.abs(walletBalanceBefore), driver_net_pence);
      console.log(`[capture] Wallet debt: ${walletBalanceBefore}p, recovering: ${debtRecoveryPence}p`);
    }

    const finalPayoutPence = driver_net_pence - debtRecoveryPence;
    console.log(`[capture] Final payout after debt recovery: ${finalPayoutPence}p`);

    // === STRIPE: Capture PaymentIntent and create Transfer ===
    let stripeFee = 0;
    let stripeTransferId: string | null = null;
    let captureSuccess = false;

    if (stripeSecretKey) {
      const stripe = new Stripe(stripeSecretKey, { apiVersion: '2023-10-16' });
      const idempotencyKey = `capture_${trip_id}`;

      try {
        // Step 1: Capture the PaymentIntent for the full fare amount
        const pi = await stripe.paymentIntents.capture(payment_intent_id, {
          amount_to_capture: final_fare_pence,
        }, { idempotencyKey: `${idempotencyKey}_capture` });

        console.log(`[capture] PaymentIntent captured: ${pi.id}, status: ${pi.status}`);

        // Extract Stripe processing fee from the charge
        if (pi.latest_charge) {
          try {
            const charge = await stripe.charges.retrieve(pi.latest_charge as string, {
              expand: ['balance_transaction'],
            });
            const bt = charge.balance_transaction;
            if (bt && typeof bt === 'object' && 'fee' in bt) {
              stripeFee = bt.fee; // Stripe fee in smallest currency unit
              console.log(`[capture] Stripe fee: ${stripeFee}p`);
            }
          } catch (feeErr) {
            console.log(`[capture] Could not retrieve Stripe fee: ${(feeErr as Error).message}`);
          }
        }

        captureSuccess = true;

        // Step 2: Transfer driver_net (minus debt recovery) to connected account
        // Only transfer if driver has a connected account AND there's money to send
        if (driver.stripe_account_id && finalPayoutPence > 0) {
          try {
            const transfer = await stripe.transfers.create({
              amount: finalPayoutPence,
              currency: currency_code.toLowerCase(),
              destination: driver.stripe_account_id,
              source_transaction: pi.latest_charge as string,
              description: `Trip earnings for ${driver.first_name} ${driver.last_name}`,
              metadata: {
                trip_id,
                driver_id,
                fare_pence: String(final_fare_pence),
                commission_pence: String(commission_pence),
                driver_net_pence: String(driver_net_pence),
                debt_recovery_pence: String(debtRecoveryPence),
                final_payout_pence: String(finalPayoutPence),
              },
            }, { idempotencyKey: `${idempotencyKey}_transfer` });

            stripeTransferId = transfer.id;
            console.log(`[capture] Transfer created: ${transfer.id}, amount: ${finalPayoutPence}p to ${driver.stripe_account_id}`);
          } catch (transferErr) {
            console.error(`[capture] Transfer failed:`, transferErr);
            // Payment captured but transfer failed - needs manual resolution
            // Still record ledger entry so wallet is correct
          }
        } else if (!driver.stripe_account_id) {
          console.log(`[capture] No Stripe connected account for driver ${driver_id}, skipping transfer`);
        } else {
          console.log(`[capture] Final payout is 0 (full debt recovery), no transfer needed`);
        }

      } catch (captureErr) {
        console.error(`[capture] Stripe capture failed:`, captureErr);
        const errMsg = (captureErr as Error).message;

        // Update trip with failure
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
      // No Stripe key - just record the ledger entries (test/dev mode)
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
        amount_pence: driver_net_pence, // Full net earning (before debt recovery)
        currency_code,
        description: `Net earnings from digital trip`,
        reference_id: stripeTransferId || payment_intent_id,
      });

    if (ledgerError) {
      console.error(`[capture] Ledger entry failed:`, ledgerError);
    } else {
      console.log(`[capture] Ledger TRIP_EARNING_NET: +${driver_net_pence}p`);
    }

    // === LEDGER: Record debt recovery if applicable ===
    if (debtRecoveryPence > 0) {
      const { error: recoveryError } = await supabase
        .from('driver_ledger')
        .insert({
          driver_id,
          trip_id,
          entry_type: 'DEBT_RECOVERY',
          amount_pence: -debtRecoveryPence, // Negative = debit from wallet
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
    const walletBalanceAfter = walletBalanceBefore + driver_net_pence - debtRecoveryPence;

    // === Update trip with full settlement data ===
    await supabase.from('trips').update({
      payment_status: captureSuccess ? 'captured' : 'capture_failed',
      stripe_processing_fee_pence: stripeFee,
      stripe_transfer_id: stripeTransferId,
      debt_recovery_pence: debtRecoveryPence,
      final_payout_pence: finalPayoutPence,
      wallet_balance_before: walletBalanceBefore,
      wallet_balance_after: walletBalanceAfter,
      updated_at: new Date().toISOString(),
    }).eq('id', trip_id);

    console.log(`[capture] Trip ${trip_id} settlement complete`);
    console.log(`[capture] Summary: fare=${final_fare_pence}p, commission=${commission_pence}p (platform retains), stripeFee=${stripeFee}p, driverNet=${driver_net_pence}p, debtRecovery=${debtRecoveryPence}p, finalPayout=${finalPayoutPence}p`);
    console.log(`[capture] Platform revenue: commission(${commission_pence}p) - stripeFee(${stripeFee}p) = ${commission_pence - stripeFee}p`);

    return new Response(JSON.stringify({
      success: true,
      trip_id,
      driver_id,
      fare_pence: final_fare_pence,
      commission_pence,
      driver_net_pence,
      stripe_fee_pence: stripeFee,
      debt_recovery_pence: debtRecoveryPence,
      final_payout_pence: finalPayoutPence,
      wallet_balance_before: walletBalanceBefore,
      wallet_balance_after: walletBalanceAfter,
      stripe_transfer_id: stripeTransferId,
      platform_net_revenue: commission_pence - stripeFee,
      payment_status: 'captured',
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('[capture] Error:', error);
    return new Response(JSON.stringify({
      error: (error as Error).message,
    }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
