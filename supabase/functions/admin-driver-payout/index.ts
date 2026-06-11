import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { resolveCurrencyFromDriver } from "../_shared/regionCurrency.ts";
import {
  buildInsufficientFundsDiagnosis,
  computeSafePayoutAmount,
  parseInsufficientFundsReason,
} from "../_shared/financeSettlementSummary.ts";
import Stripe from "https://esm.sh/stripe@14.21.0";

const MIN_PAYOUT_PENCE = 100;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * admin-driver-payout
 * 
 * Pays out from the driver's wallet balance to their Stripe connected account.
 * Currency is resolved from the driver's Region (single source of truth).
 * All financial entries use driver_wallet_ledger exclusively.
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const stripeSecretKey = Deno.env.get('STRIPE_SECRET_KEY');
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // === Auth: verify admin ===
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Check admin role via user_roles table (NOT profiles — prevents privilege escalation)
    const { data: roleData } = await supabase
      .from('user_roles').select('role')
      .eq('user_id', user.id).eq('role', 'admin').maybeSingle();

    if (!roleData) {
      return new Response(JSON.stringify({ error: 'Admin access required' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { driver_id, amount_pence, kind = 'MANUAL_ADMIN' } = await req.json();

    if (!driver_id) {
      return new Response(JSON.stringify({ error: 'driver_id is required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // === Resolve currency from Region (single source of truth) ===
    let currency_code: string;
    try {
      const regionCurrency = await resolveCurrencyFromDriver(supabase, driver_id);
      currency_code = regionCurrency.currency_code;
    } catch (e) {
      console.error('[payout] Currency resolution failed:', e);
      return new Response(JSON.stringify({ error: (e as Error).message, error_code: 'REGION_CURRENCY_UNRESOLVABLE' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // === Get driver info ===
    const { data: driver, error: driverError } = await supabase
      .from('drivers')
      .select('id, first_name, last_name, stripe_account_id, payouts_enabled')
      .eq('id', driver_id).single();

    if (driverError || !driver) {
      return new Response(JSON.stringify({ error: 'Driver not found' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // === Calculate wallet balance from driver_wallet_ledger (source of truth) ===
    const { data: ledgerEntries } = await supabase
      .from('driver_wallet_ledger')
      .select('amount_pence')
      .eq('driver_id', driver_id)
      .not('type', 'in', '("PLATFORM_COMMISSION","CASH_TRIP_EARNING")');

    const available = ledgerEntries?.reduce((sum, e) => sum + (e.amount_pence || 0), 0) || 0;
    const requestedPayout = amount_pence || available;

    console.log(`[payout] Driver ${driver_id}: wallet balance = ${available}p, requested payout = ${requestedPayout}p, currency: ${currency_code}`);

    if (requestedPayout <= 0) {
      return new Response(JSON.stringify({ error: 'No funds available for payout', available_pence: available }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (requestedPayout > available) {
      return new Response(JSON.stringify({ error: 'Payout amount exceeds available balance', available_pence: available, requested_pence: requestedPayout }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    let stripeAvailablePence = 0;
    let stripePendingPence = 0;
    if (!stripeSecretKey) {
      return new Response(JSON.stringify({ error: 'Stripe not configured', error_code: 'STRIPE_NOT_CONFIGURED' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const stripe = new Stripe(stripeSecretKey, { apiVersion: '2023-10-16' });
    const balance = await stripe.balance.retrieve();
    const currencyLower = currency_code.toLowerCase();
    stripeAvailablePence = balance.available.find((b) => b.currency === currencyLower)?.amount ?? 0;
    stripePendingPence = balance.pending.find((b) => b.currency === currencyLower)?.amount ?? 0;

    const safe = computeSafePayoutAmount({
      driverAvailablePence: requestedPayout,
      stripeAvailablePence,
      minimumPayoutPence: MIN_PAYOUT_PENCE,
    });
    const payoutAmount = safe.payout_amount_pence;

    if (payoutAmount < MIN_PAYOUT_PENCE) {
      const diagnoses = buildInsufficientFundsDiagnosis({
        failureReason: 'insufficient funds',
        requestedPayoutPence: requestedPayout,
        stripeAvailablePence,
        stripePendingPence,
        calculatedOnecabNetPence: 0,
        driverPendingSettlementPence: 0,
      });
      return new Response(JSON.stringify({
        success: false,
        error: 'INSUFFICIENT_STRIPE_BALANCE',
        message: 'Stripe available balance was lower than requested driver payout.',
        available_pence: available,
        requested_pence: requestedPayout,
        stripe_available_balance_pence: stripeAvailablePence,
        stripe_pending_balance_pence: stripePendingPence,
        payout_amount_pence: 0,
        waiting_for_stripe_funds: true,
        diagnoses,
      }), {
        status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!driver.payouts_enabled) {
      return new Response(JSON.stringify({ error: 'Driver payouts not enabled' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!driver.stripe_account_id) {
      return new Response(JSON.stringify({ error: 'Driver has no connected Stripe account' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // === Create payout batch ===
    const { data: batch, error: batchError } = await supabase
      .from('payout_batches')
      .insert({
        kind,
        status: 'processing',
        total_drivers: 1,
        total_amount_pence: payoutAmount,
        created_by: user.id,
      })
      .select().single();

    if (batchError) throw batchError;

    // === Create payout item ===
    const { data: payoutItem, error: itemError } = await supabase
      .from('payout_items')
      .insert({
        batch_id: batch.id,
        driver_id,
        amount_pence: payoutAmount,
        status: 'processing',
      })
      .select().single();

    if (itemError) throw itemError;

    let stripeTransferId: string | null = null;
    let stripePayoutId: string | null = null;
    let stripeError: string | null = null;

    // === Stripe transfer ===
    if (stripeSecretKey) {
      try {
        const idempotencyKey = `payout_${payoutItem.id}`;

        // Transfer from platform to connected account
        const transfer = await stripe.transfers.create({
          amount: payoutAmount,
          currency: currency_code.toLowerCase(),
          destination: driver.stripe_account_id,
          description: `Payout for driver ${driver.first_name} ${driver.last_name}`,
          metadata: {
            payout_item_id: payoutItem.id,
            driver_id,
            batch_id: batch.id,
          },
        }, { idempotencyKey });

        stripeTransferId = transfer.id;
        console.log(`[payout] Transfer created: ${transfer.id}`);

        // Trigger payout to bank
        try {
          const payout = await stripe.payouts.create({
            amount: payoutAmount,
            currency: currency_code.toLowerCase(),
          }, {
            stripeAccount: driver.stripe_account_id,
            idempotencyKey: `${idempotencyKey}_payout`,
          });
          stripePayoutId = payout.id;
          console.log(`[payout] Bank payout created: ${payout.id}`);
        } catch (payoutErr) {
          console.log('[payout] Bank payout skipped (may be automatic):', (payoutErr as Error).message);
        }
      } catch (stripeErr) {
        console.error('[payout] Stripe error:', stripeErr);
        stripeError = (stripeErr as Error).message;
        if (parseInsufficientFundsReason(stripeError)) {
          stripeError = 'Stripe available balance was lower than requested driver payout.';
        }
      }
    }

    // === Create ledger entry for payout (debit from wallet) ===
    // CRITICAL: Only create debit if Stripe transfer succeeded — prevents phantom deductions
    if (!stripeError) {
      const ledgerType = kind === 'EARLY_CASHOUT' ? 'EARLY_CASHOUT' : 'PAYOUT';

      const { data: ledgerEntry, error: ledgerError } = await supabase
        .from('driver_wallet_ledger')
        .insert({
          driver_id,
          type: ledgerType,
          amount_pence: -payoutAmount,
          currency: currency_code,
          description: `${kind} payout`,
          stripe_transfer_id: stripeTransferId,
          stripe_payout_id: stripePayoutId,
        })
        .select().single();

      if (ledgerError) {
        console.error('[payout] Ledger error:', ledgerError);
      }

      // Calculate new balance
      const newBalance = available - payoutAmount;

      // === Update payout item ===
      await supabase.from('payout_items').update({
        status: 'completed',
        stripe_transfer_id: stripeTransferId,
        stripe_payout_id: stripePayoutId,
        ledger_entry_id: ledgerEntry?.id,
        completed_at: new Date().toISOString(),
      }).eq('id', payoutItem.id);

      // === Update batch ===
      await supabase.from('payout_batches').update({
        status: 'completed',
        successful_payouts: 1,
        failed_payouts: 0,
        completed_at: new Date().toISOString(),
      }).eq('id', batch.id);

      return new Response(JSON.stringify({
        success: true,
        batchId: batch.id,
        payoutItemId: payoutItem.id,
        amount: payoutAmount,
        requested_pence: requestedPayout,
        partial_payout: safe.partial,
        wallet_balance_before: available,
        wallet_balance_after: newBalance,
        stripe_available_balance_pence: stripeAvailablePence,
        stripe_pending_balance_pence: stripePendingPence,
        stripeTransferId,
        stripePayoutId,
        ledgerEntryId: ledgerEntry?.id,
        currency_code,
        waiting_for_stripe_funds: safe.waiting_for_stripe_funds && safe.partial,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    } else {
      // Stripe failed — do NOT create ledger entry, mark payout as failed
      await supabase.from('payout_items').update({
        status: 'failed',
        error_message: stripeError,
      }).eq('id', payoutItem.id);

      await supabase.from('payout_batches').update({
        status: 'failed',
        successful_payouts: 0,
        failed_payouts: 1,
        completed_at: new Date().toISOString(),
      }).eq('id', batch.id);

      const diagnoses = buildInsufficientFundsDiagnosis({
        failureReason: stripeError,
        requestedPayoutPence: payoutAmount,
        stripeAvailablePence,
        stripePendingPence,
        calculatedOnecabNetPence: 0,
        driverPendingSettlementPence: 0,
      });

      return new Response(JSON.stringify({
        success: false,
        batchId: batch.id,
        payoutItemId: payoutItem.id,
        amount: payoutAmount,
        requested_pence: requestedPayout,
        wallet_balance_before: available,
        wallet_balance_after: available,
        stripe_available_balance_pence: stripeAvailablePence,
        stripe_pending_balance_pence: stripePendingPence,
        currency_code,
        error: stripeError,
        diagnoses,
        waiting_for_stripe_funds: stripeAvailablePence < requestedPayout,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

  } catch (error) {
    console.error('[payout] Error:', error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
