import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { calculateCommission } from "../_shared/commission.ts";
import { resolveCurrencyFromTrip } from "../_shared/regionCurrency.ts";
import { buildTripAccounting, validateTripAccounting } from "../_shared/tripAccounting.ts";
import { assertServiceRole } from "../_shared/internalAuth.ts";

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
 * Currency is resolved from Region (single source of truth).
 * Uses driver_wallet_ledger as single source of truth.
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

    // === Resolve currency from Region (single source of truth) ===
    let regionCurrency: { currency_code: string };
    try {
      regionCurrency = await resolveCurrencyFromTrip(supabase, trip_id);
    } catch (e) {
      console.error('[cash-commission] Currency resolution failed:', e);
      return new Response(
        JSON.stringify({ error: (e as Error).message, error_code: 'REGION_CURRENCY_UNRESOLVABLE' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    const currency_code = regionCurrency.currency_code;

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

    // === IDEMPOTENCY: Check if already processed in driver_wallet_ledger ===
    const { data: existingDebt } = await supabase
      .from('driver_wallet_ledger')
      .select('id, amount_pence')
      .eq('related_trip_id', trip_id)
      .eq('type', 'CASH_COMMISSION_DEBT')
      .maybeSingle();

    if (existingDebt) {
      console.log(`[cash-commission] Already processed for trip ${trip_id}`);
      const { data: walletEntries } = await supabase
        .from('driver_wallet_ledger').select('amount_pence').eq('driver_id', trip.driver_id)
        .not('type', 'in', '("PLATFORM_COMMISSION","CASH_TRIP_EARNING")');
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
    const tipPence = trip.tip_pence || 0;
    const totalGrossPence = grossFarePence + tipPence;

    if (grossFarePence <= 0) {
      return new Response(
        JSON.stringify({ error: 'Trip has no fare amount' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { commission_pct: commissionPct, commission_pence: commissionPence } = await calculateCommission(supabase, trip.driver_id, grossFarePence);
    const accounting = buildTripAccounting({
      commissionableSubtotalPence: grossFarePence,
      commissionPence,
      tipAmountPence: tipPence,
    });
    const accountingError = validateTripAccounting({
      commissionableSubtotalPence: grossFarePence,
      commissionPence,
      tipAmountPence: tipPence,
      driverNetBeforeTipPence: accounting.driverNetBeforeTipPence,
      driverTotalEarningsPence: accounting.driverTotalEarningsPence,
      finalTripTotalPence: accounting.finalTripTotalPence,
    });

    if (accountingError) {
      return new Response(
        JSON.stringify({ error: accountingError }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const driverNetPence = accounting.driverNetBeforeTipPence;
    const driverTotalEarningsPence = accounting.driverTotalEarningsPence;

    console.log(`[cash-commission] Gross: ${grossFarePence}p, Tip: ${tipPence}p, Commission: ${commissionPence}p, Net: ${driverNetPence}p, DriverTotal: ${driverTotalEarningsPence}p, Currency: ${currency_code}`);

    // === Get wallet balance before ===
    const { data: walletBefore } = await supabase
      .from('driver_wallet_ledger').select('amount_pence').eq('driver_id', trip.driver_id)
      .not('type', 'in', '("PLATFORM_COMMISSION","CASH_TRIP_EARNING")');
    const balanceBefore = walletBefore?.reduce((sum, e) => sum + (e.amount_pence || 0), 0) || 0;

    // === Update trip with financial fields ===
    await supabase.from('trips').update({
      gross_fare_pence: grossFarePence,
      commission_pence: commissionPence,
      commission_pct: commissionPct, // Tier snapshot — LOCKED
      driver_net_pence: driverNetPence,
      payment_status: 'collected_cash',
      stripe_processing_fee_pence: 0,
      debt_recovery_pence: 0,
      final_payout_pence: 0,
      wallet_balance_before: balanceBefore,
      wallet_balance_after: balanceBefore - commissionPence,
      updated_at: new Date().toISOString(),
    }).eq('id', trip_id);

    // === Create ledger entries in driver_wallet_ledger (single source of truth) ===
    if (commissionPence > 0) {
      const { error: ledgerError } = await supabase
        .from('driver_wallet_ledger')
        .insert({
          driver_id: trip.driver_id,
          related_trip_id: trip_id,
          type: 'CASH_COMMISSION_DEBT',
          amount_pence: -commissionPence,
          currency: currency_code,
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

      // Record CASH_TRIP_EARNING (reporting — driver collected cash)
      await supabase.from('driver_wallet_ledger').insert({
        driver_id: trip.driver_id,
        related_trip_id: trip_id,
        type: 'CASH_TRIP_EARNING',
        amount_pence: grossFarePence,
        currency: currency_code,
        description: `Cash trip gross fare collected`,
      });

      // Record PLATFORM_COMMISSION (platform revenue SSOT)
      await supabase.from('driver_wallet_ledger').insert({
        driver_id: trip.driver_id,
        related_trip_id: trip_id,
        type: 'PLATFORM_COMMISSION',
        amount_pence: commissionPence,
        currency: currency_code,
        description: 'Platform commission from cash trip',
      });
      console.log(`[cash-commission] PLATFORM_COMMISSION: +${commissionPence}p`);
    }

    const balanceAfter = balanceBefore - commissionPence;
    console.log(`[cash-commission] Wallet: ${balanceBefore}p → ${balanceAfter}p`);

    return new Response(JSON.stringify({
      success: true,
      trip_id,
      driver_id: trip.driver_id,
      gross_fare_pence: grossFarePence,
      final_trip_total_pence: totalGrossPence,
      commission_pence: commissionPence,
      driver_net_pence: driverNetPence,
      driver_total_earnings_pence: driverTotalEarningsPence,
      stripe_fee_pence: 0,
      platform_net_revenue: commissionPence,
      wallet_balance_before: balanceBefore,
      wallet_balance_after: balanceAfter,
      currency_code,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error: unknown) {
    console.error('[cash-commission] Error:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
