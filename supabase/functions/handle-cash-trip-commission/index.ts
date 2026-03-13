import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * handle-cash-trip-commission
 * 
 * For cash trips where driver collected cash from passenger.
 * Creates a CASH_COMMISSION_DEBT ledger entry (debt owed to ONECAB).
 * 
 * Cash trip rules:
 * - Passenger pays driver directly in cash
 * - Stripe is NOT involved (no Stripe fee)
 * - ONECAB earns full platform commission
 * - Wallet debit = platform commission
 * - If wallet goes negative, that's acceptable (debt)
 * 
 * Uses driver_ledger as single source of truth (NOT driver_wallet_ledger).
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { trip_id, cash_collected_confirmed } = await req.json();

    if (!trip_id) {
      return new Response(
        JSON.stringify({ error: 'trip_id is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (cash_collected_confirmed !== true) {
      return new Response(
        JSON.stringify({ error: 'cash_collected_confirmed must be true' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[cash-commission] Processing trip: ${trip_id}`);

    // === Fetch and validate trip ===
    const { data: trip, error: tripError } = await supabase
      .from('trips')
      .select('id, driver_id, payment_method, status, completed_at, gross_fare_pence, extras_pence, tip_pence, commission_pence, driver_net_pence, payment_status')
      .eq('id', trip_id)
      .maybeSingle();

    if (tripError || !trip) {
      return new Response(
        JSON.stringify({ error: tripError ? 'Failed to fetch trip' : 'Trip not found' }),
        { status: tripError ? 500 : 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if ((trip.payment_method || '').toUpperCase() !== 'CASH') {
      return new Response(
        JSON.stringify({ error: 'Trip is not a cash payment trip' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (trip.status !== 'completed' && !trip.completed_at) {
      return new Response(
        JSON.stringify({ error: 'Trip is not completed' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!trip.driver_id) {
      return new Response(
        JSON.stringify({ error: 'Trip has no assigned driver' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // === IDEMPOTENCY: Check if already processed in driver_ledger ===
    const { data: existingDebt } = await supabase
      .from('driver_ledger')
      .select('id, amount_pence')
      .eq('trip_id', trip_id)
      .eq('entry_type', 'CASH_COMMISSION_DEBT')
      .maybeSingle();

    if (existingDebt) {
      console.log(`[cash-commission] Already processed for trip ${trip_id}`);
      const { data: walletEntries } = await supabase
        .from('driver_ledger').select('amount_pence').eq('driver_id', trip.driver_id);
      const balance = walletEntries?.reduce((sum, e) => sum + (e.amount_pence || 0), 0) || 0;

      return new Response(JSON.stringify({
        success: true,
        idempotent: true,
        trip_id,
        driver_id: trip.driver_id,
        commission_pence: Math.abs(existingDebt.amount_pence),
        wallet_balance_pence: balance,
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // === Calculate fare and commission ===
    const grossFarePence = trip.gross_fare_pence || 0;
    const extrasPence = trip.extras_pence || 0;
    const tipPence = trip.tip_pence || 0;
    const totalGrossPence = grossFarePence + extrasPence + tipPence;

    if (totalGrossPence <= 0) {
      return new Response(
        JSON.stringify({ error: 'Trip has no fare amount' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Use commission already calculated on the trip (from complete-trip)
    let commissionPence = trip.commission_pence || 0;

    // If not set, calculate from driver tier commission (single source of truth)
    if (commissionPence <= 0) {
      let commissionPercentage = 20; // default fallback only if no tier assigned

      const { data: driverData } = await supabase
        .from('drivers')
        .select('category_id')
        .eq('id', trip.driver_id)
        .single();

      if (driverData?.category_id) {
        const { data: cat } = await supabase
          .from('driver_categories')
          .select('commission_pct')
          .eq('id', driverData.category_id)
          .single();
        if (cat?.commission_pct != null) commissionPercentage = cat.commission_pct;
      }

      commissionPence = Math.round(totalGrossPence * commissionPercentage / 100);
      commissionPence = Math.max(0, Math.min(commissionPence, totalGrossPence));
    }

    const driverNetPence = totalGrossPence - commissionPence;

    console.log(`[cash-commission] Gross: ${totalGrossPence}p, Commission: ${commissionPence}p, Net: ${driverNetPence}p`);

    // === Get wallet balance before ===
    const { data: walletBefore } = await supabase
      .from('driver_ledger').select('amount_pence').eq('driver_id', trip.driver_id);
    const balanceBefore = walletBefore?.reduce((sum, e) => sum + (e.amount_pence || 0), 0) || 0;

    // === Update trip with financial fields ===
    await supabase.from('trips').update({
      gross_fare_pence: totalGrossPence,
      commission_pence: commissionPence,
      driver_net_pence: driverNetPence,
      payment_status: 'collected_cash',
      stripe_processing_fee_pence: 0, // No Stripe fee on cash
      debt_recovery_pence: 0,
      final_payout_pence: 0,
      wallet_balance_before: balanceBefore,
      wallet_balance_after: balanceBefore - commissionPence,
      updated_at: new Date().toISOString(),
    }).eq('id', trip_id);

    // === Create ledger entry in driver_ledger (single source of truth) ===
    if (commissionPence > 0) {
      const { error: ledgerError } = await supabase
        .from('driver_ledger')
        .insert({
          driver_id: trip.driver_id,
          trip_id,
          entry_type: 'CASH_COMMISSION_DEBT',
          amount_pence: -commissionPence,
          currency_code: 'GBP',
          description: 'Cash trip commission owed to platform',
        });

      if (ledgerError) {
        if (ledgerError.code === '23505') {
          console.log('[cash-commission] Duplicate entry, already processed');
        } else {
          console.error('[cash-commission] Ledger error:', ledgerError);
          return new Response(
            JSON.stringify({ error: 'Failed to create ledger entry' }),
            { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }
      } else {
        console.log(`[cash-commission] CASH_COMMISSION_DEBT: -${commissionPence}p`);
      }
    }

    const balanceAfter = balanceBefore - commissionPence;
    console.log(`[cash-commission] Wallet: ${balanceBefore}p → ${balanceAfter}p`);

    return new Response(JSON.stringify({
      success: true,
      trip_id,
      driver_id: trip.driver_id,
      gross_fare_pence: totalGrossPence,
      commission_pence: commissionPence,
      driver_net_pence: driverNetPence,
      stripe_fee_pence: 0,
      platform_net_revenue: commissionPence, // Full commission, no Stripe fee
      wallet_balance_before: balanceBefore,
      wallet_balance_after: balanceAfter,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error: unknown) {
    console.error('[cash-commission] Error:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
