import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { resolveCurrencyFromDriver } from "../_shared/regionCurrency.ts";
import Stripe from "https://esm.sh/stripe@14.21.0";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * admin-driver-payout
 * 
 * Pays out from the driver's wallet balance to their Stripe connected account.
 * Currency is resolved from the driver's Region (single source of truth).
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

    // === Calculate wallet balance from ledger (source of truth) ===
    // IMPORTANT: Exclude COMPANY_COMMISSION from wallet balance — it is platform revenue, not driver funds
    const { data: ledgerEntries } = await supabase
      .from('driver_ledger')
      .select('amount_pence')
      .eq('driver_id', driver_id)
      .neq('entry_type', 'COMPANY_COMMISSION');

    const available = ledgerEntries?.reduce((sum, e) => sum + (e.amount_pence || 0), 0) || 0;
    const payoutAmount = amount_pence || available;

    console.log(`[payout] Driver ${driver_id}: wallet balance = ${available}p, requested payout = ${payoutAmount}p, currency: ${currency_code}`);

    if (payoutAmount <= 0) {
      return new Response(JSON.stringify({ error: 'No funds available for payout', available_pence: available }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (payoutAmount > available) {
      return new Response(JSON.stringify({ error: 'Payout amount exceeds available balance', available_pence: available, requested_pence: payoutAmount }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
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
        const stripe = new Stripe(stripeSecretKey, { apiVersion: '2023-10-16' });
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
      }
    }

    // === Create ledger entry for payout (debit from wallet) ===
    // CRITICAL: Only create debit if Stripe transfer succeeded — prevents phantom deductions
    if (!stripeError) {
      const ledgerType = kind === 'EARLY_CASHOUT' ? 'EARLY_CASHOUT' : 'PAYOUT';

      const { data: ledgerEntry, error: ledgerError } = await supabase
        .from('driver_ledger')
        .insert({
          driver_id,
          entry_type: ledgerType,
          amount_pence: -payoutAmount,
          currency_code,
          description: `${kind} payout`,
          reference_id: stripeTransferId,
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
        wallet_balance_before: available,
        wallet_balance_after: newBalance,
        stripeTransferId,
        stripePayoutId,
        ledgerEntryId: ledgerEntry?.id,
        currency_code,
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

      return new Response(JSON.stringify({
        success: false,
        batchId: batch.id,
        payoutItemId: payoutItem.id,
        amount: payoutAmount,
        wallet_balance_before: available,
        wallet_balance_after: available, // Unchanged — no debit on failure
        currency_code,
        error: stripeError,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // === Update payout item ===
    const finalStatus = stripeError ? 'failed' : 'completed';
    await supabase.from('payout_items').update({
      status: finalStatus,
      stripe_transfer_id: stripeTransferId,
      stripe_payout_id: stripePayoutId,
      error_message: stripeError,
      ledger_entry_id: ledgerEntry?.id,
      completed_at: stripeError ? null : new Date().toISOString(),
    }).eq('id', payoutItem.id);

    // === Update batch ===
    await supabase.from('payout_batches').update({
      status: stripeError ? 'failed' : 'completed',
      successful_payouts: stripeError ? 0 : 1,
      failed_payouts: stripeError ? 1 : 0,
      completed_at: new Date().toISOString(),
    }).eq('id', batch.id);

    // Calculate new balance
    const newBalance = available - payoutAmount;

    return new Response(JSON.stringify({
      success: !stripeError,
      batchId: batch.id,
      payoutItemId: payoutItem.id,
      amount: payoutAmount,
      wallet_balance_before: available,
      wallet_balance_after: newBalance,
      stripeTransferId,
      stripePayoutId,
      ledgerEntryId: ledgerEntry?.id,
      currency_code,
      error: stripeError,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('[payout] Error:', error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
