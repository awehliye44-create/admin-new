import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { resolveCurrencyFromDriver } from "../_shared/regionCurrency.ts";
import { finalizePayoutAfterProviderSuccess } from "../_shared/payoutLedgerSync.ts";
import {
  buildPayoutSettlementSnapshot,
  recordPayoutFailureAndReturnToWallet,
  recordPayoutSuccessDiagnostics,
} from "../_shared/payoutFailureRecovery.ts";
import Stripe from "https://esm.sh/stripe@14.21.0";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * admin-driver-payout
 *
 * Pays out from the driver's wallet balance to their Stripe connected account.
 * Completion requires: provider transfer succeeds → ledger debit → wallet recalc.
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

    const { data: roleData } = await supabase
      .from('user_roles').select('role')
      .eq('user_id', user.id).eq('role', 'admin').maybeSingle();

    if (!roleData) {
      return new Response(JSON.stringify({ error: 'Admin access required' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const body = await req.json();
    const { driver_id, amount_pence, kind = 'MANUAL_ADMIN', payout_item_id } = body;

    // Retry ledger sync for existing payout item (provider already paid)
    if (payout_item_id) {
      const { data: syncResult, error: syncError } = await supabase.rpc(
        'sync_payout_item_ledger_debit',
        { p_payout_item_id: payout_item_id },
      );
      if (syncError) throw syncError;
      return new Response(JSON.stringify({
        success: (syncResult as { success?: boolean })?.success ?? false,
        retry: true,
        result: syncResult,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!driver_id) {
      return new Response(JSON.stringify({ error: 'driver_id is required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

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

    const { data: driver, error: driverError } = await supabase
      .from('drivers')
      .select('id, first_name, last_name, stripe_account_id, payouts_enabled')
      .eq('id', driver_id).single();

    if (driverError || !driver) {
      return new Response(JSON.stringify({ error: 'Driver not found' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: ledgerEntries } = await supabase
      .from('driver_wallet_ledger')
      .select('amount_pence')
      .eq('driver_id', driver_id)
      .not('type', 'in', '("PLATFORM_COMMISSION","CASH_TRIP_EARNING")');

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

    const runDate = batch.run_date ?? new Date().toISOString().slice(0, 10);
    const settlementSnapshot = await buildPayoutSettlementSnapshot(
      supabase,
      driver_id,
      payoutAmount,
      runDate,
    );

    await supabase.from('payout_items').update({
      settlement_status: 'PROCESSING',
      gross_payable_pence: settlementSnapshot.gross_payable_pence,
      cash_commission_recovered_pence: settlementSnapshot.cash_commission_recovered_pence,
      net_driver_payout_pence: settlementSnapshot.net_driver_payout_pence,
      updated_at: new Date().toISOString(),
    }).eq('id', payoutItem.id);

    let stripeTransferId: string | null = null;
    let stripePayoutId: string | null = null;
    let stripeError: string | null = null;

    if (stripeSecretKey) {
      try {
        const stripe = new Stripe(stripeSecretKey, { apiVersion: '2023-10-16' });
        const idempotencyKey = `payout_${payoutItem.id}`;

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
    } else {
      stripeError = 'STRIPE_SECRET_KEY not configured';
    }

    if (stripeError) {
      const failure = await recordPayoutFailureAndReturnToWallet({
        supabase,
        payoutItemId: payoutItem.id,
        batchId: batch.id,
        batchKind: kind,
        driverId: driver_id,
        netDriverPayoutPence: payoutAmount,
        snapshot: settlementSnapshot,
        providerStatus: 'failed',
        providerReference: null,
        rawFailureReason: stripeError,
      });

      return new Response(JSON.stringify({
        success: false,
        batchId: batch.id,
        payoutItemId: payoutItem.id,
        amount: payoutAmount,
        settlement_status: settlementSnapshot.cash_commission_recovered_pence > 0
          ? 'PARTIAL_SETTLEMENT'
          : 'FAILED',
        gross_payable_pence: settlementSnapshot.gross_payable_pence,
        cash_commission_recovered_pence: settlementSnapshot.cash_commission_recovered_pence,
        net_driver_payout_pence: settlementSnapshot.net_driver_payout_pence,
        driver_paid_out_pence: 0,
        failed_payout_amount_pence: payoutAmount,
        returned_to_wallet_pence: failure.returned_pence ?? payoutAmount,
        wallet_balance_before: available,
        wallet_balance_after: available + (failure.returned_pence ?? payoutAmount),
        currency_code,
        error: stripeError,
        wallet_returned: failure.success,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const finalize = await finalizePayoutAfterProviderSuccess({
      supabase,
      payoutItemId: payoutItem.id,
      batchId: batch.id,
      driverId: driver_id,
      payoutAmount,
      currencyCode: currency_code,
      batchKind: kind,
      stripeTransferId,
      stripePayoutId,
      walletBalanceBefore: available,
    });

    if (!finalize.success) {
      console.error('[payout] CRITICAL: Provider payout succeeded but ledger sync failed', finalize);
      return new Response(JSON.stringify({
        success: false,
        critical: true,
        alert: 'Provider payout completed but driver ledger was not fully debited. Retry ledger sync.',
        batchId: batch.id,
        payoutItemId: payoutItem.id,
        amount: payoutAmount,
        status: finalize.status,
        wallet_balance_before: available,
        wallet_balance_after: finalize.walletBalanceAfter,
        stripeTransferId,
        stripePayoutId,
        ledgerEntryId: finalize.ledgerEntryId,
        currency_code,
        error: finalize.error,
      }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    await recordPayoutSuccessDiagnostics({
      supabase,
      payoutItemId: payoutItem.id,
      snapshot: settlementSnapshot,
      netDriverPayoutPence: payoutAmount,
      providerStatus: 'paid',
      providerReference: stripeTransferId ?? stripePayoutId,
    });

    return new Response(JSON.stringify({
      success: true,
      batchId: batch.id,
      payoutItemId: payoutItem.id,
      amount: payoutAmount,
      settlement_status: 'COMPLETE',
      gross_payable_pence: settlementSnapshot.gross_payable_pence,
      cash_commission_recovered_pence: settlementSnapshot.cash_commission_recovered_pence,
      net_driver_payout_pence: settlementSnapshot.net_driver_payout_pence,
      driver_paid_out_pence: payoutAmount,
      wallet_balance_before: available,
      wallet_balance_after: finalize.walletBalanceAfter,
      stripeTransferId,
      stripePayoutId,
      ledgerEntryId: finalize.ledgerEntryId,
      walletRecalculated: finalize.walletRecalculated,
      currency_code,
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
