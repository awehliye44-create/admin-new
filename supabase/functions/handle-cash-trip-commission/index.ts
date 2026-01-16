import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Parse request body
    const { trip_id, cash_collected_confirmed } = await req.json();

    // Validate input
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

    console.log(`Processing cash trip commission for trip: ${trip_id}`);

    // Step 1: Fetch and validate the trip
    const { data: trip, error: tripError } = await supabase
      .from('trips')
      .select('id, driver_id, payment_method, status, completed_at, gross_fare_pence, extras_pence, tip_pence, commission_pence, driver_net_pence, payment_status')
      .eq('id', trip_id)
      .maybeSingle();

    if (tripError) {
      console.error('Error fetching trip:', tripError);
      return new Response(
        JSON.stringify({ error: 'Failed to fetch trip', details: tripError.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!trip) {
      return new Response(
        JSON.stringify({ error: 'Trip not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Validate payment method is CASH
    const paymentMethod = (trip.payment_method || '').toUpperCase();
    if (paymentMethod !== 'CASH') {
      return new Response(
        JSON.stringify({ error: 'Trip is not a cash payment trip', payment_method: trip.payment_method }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Validate trip is completed
    if (trip.status !== 'completed' && !trip.completed_at) {
      return new Response(
        JSON.stringify({ error: 'Trip is not completed', status: trip.status }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Validate driver exists
    if (!trip.driver_id) {
      return new Response(
        JSON.stringify({ error: 'Trip has no assigned driver' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Calculate gross fare (final fare + extras + tip)
    const grossFarePence = trip.gross_fare_pence || 0;
    const extrasPence = trip.extras_pence || 0;
    const tipPence = trip.tip_pence || 0;
    const totalGrossPence = grossFarePence + extrasPence + tipPence;

    if (totalGrossPence <= 0) {
      return new Response(
        JSON.stringify({ error: 'Trip has no fare amount', gross_fare_pence: totalGrossPence }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Step 2: Check if CASH_COMMISSION_DEBT already exists (idempotency check)
    const { data: existingDebt, error: debtCheckError } = await supabase
      .from('driver_wallet_ledger')
      .select('id, amount_pence')
      .eq('related_trip_id', trip_id)
      .eq('type', 'CASH_COMMISSION_DEBT')
      .maybeSingle();

    if (debtCheckError) {
      console.error('Error checking existing debt:', debtCheckError);
      return new Response(
        JSON.stringify({ error: 'Failed to check existing debt entry', details: debtCheckError.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (existingDebt) {
      console.log(`Cash commission debt already exists for trip ${trip_id}, returning existing data`);
      
      // Fetch current wallet balance
      const { data: wallet } = await supabase
        .from('driver_wallets')
        .select('available_pence')
        .eq('driver_id', trip.driver_id)
        .maybeSingle();

      return new Response(
        JSON.stringify({
          success: true,
          idempotent: true,
          trip_id,
          driver_id: trip.driver_id,
          gross_fare_pence: totalGrossPence,
          commission_pence: Math.abs(existingDebt.amount_pence),
          wallet_debt_created: false,
          new_wallet_balance_pence: wallet?.available_pence || 0,
          message: 'Cash commission debt already recorded for this trip'
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Step 3: Fetch commission settings from admin_settings
    const { data: commissionPercentSetting } = await supabase
      .from('admin_settings')
      .select('setting_value')
      .eq('setting_key', 'commission_percent')
      .maybeSingle();

    const { data: commissionFixedSetting } = await supabase
      .from('admin_settings')
      .select('setting_value')
      .eq('setting_key', 'commission_fixed_pence')
      .maybeSingle();

    // Parse commission settings (default: 20% commission, 0 fixed)
    let commissionPercent = 0.20;
    let commissionFixedPence = 0;

    if (commissionPercentSetting?.setting_value) {
      const val = commissionPercentSetting.setting_value;
      commissionPercent = typeof val === 'number' ? val : parseFloat(String(val)) || 0.20;
    }

    if (commissionFixedSetting?.setting_value) {
      const val = commissionFixedSetting.setting_value;
      commissionFixedPence = typeof val === 'number' ? val : parseInt(String(val)) || 0;
    }

    console.log(`Commission settings: ${commissionPercent * 100}% + ${commissionFixedPence}p fixed`);

    // Step 4: Calculate commission
    let commissionPence = Math.round(totalGrossPence * commissionPercent) + commissionFixedPence;
    
    // Ensure commission is within valid range
    commissionPence = Math.max(0, Math.min(commissionPence, totalGrossPence));
    
    const driverNetPence = totalGrossPence - commissionPence;

    console.log(`Calculated: gross=${totalGrossPence}, commission=${commissionPence}, driverNet=${driverNetPence}`);

    // Step 5: Update trip with financial fields
    const { error: updateTripError } = await supabase
      .from('trips')
      .update({
        gross_fare_pence: totalGrossPence,
        commission_pence: commissionPence,
        driver_net_pence: driverNetPence,
        payment_status: 'paid_cash',
        updated_at: new Date().toISOString()
      })
      .eq('id', trip_id);

    if (updateTripError) {
      console.error('Error updating trip:', updateTripError);
      return new Response(
        JSON.stringify({ error: 'Failed to update trip', details: updateTripError.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Step 6: Create CASH_COMMISSION_DEBT ledger entry (only if commission > 0)
    let walletDebtCreated = false;

    if (commissionPence > 0) {
      const { error: ledgerError } = await supabase
        .from('driver_wallet_ledger')
        .insert({
          driver_id: trip.driver_id,
          type: 'CASH_COMMISSION_DEBT',
          amount_pence: -commissionPence, // Negative = debt
          related_trip_id: trip_id,
          description: 'Cash trip commission owed to platform',
          currency: 'GBP'
        });

      if (ledgerError) {
        // Check if it's a duplicate key error (idempotency)
        if (ledgerError.code === '23505') {
          console.log('Duplicate entry detected, already processed');
          walletDebtCreated = false;
        } else {
          console.error('Error creating ledger entry:', ledgerError);
          return new Response(
            JSON.stringify({ error: 'Failed to create ledger entry', details: ledgerError.message }),
            { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }
      } else {
        walletDebtCreated = true;
        console.log(`Created CASH_COMMISSION_DEBT of -${commissionPence}p for driver ${trip.driver_id}`);
      }
    }

    // Step 7: Fetch updated wallet balance (the trigger should have updated it)
    // If no trigger exists, we calculate manually
    const { data: ledgerSum } = await supabase
      .from('driver_wallet_ledger')
      .select('amount_pence')
      .eq('driver_id', trip.driver_id);

    const newWalletBalancePence = ledgerSum?.reduce((sum, entry) => sum + (entry.amount_pence || 0), 0) || 0;

    // Update or create wallet cache
    await supabase
      .from('driver_wallets')
      .upsert({
        driver_id: trip.driver_id,
        available_pence: newWalletBalancePence,
        updated_at: new Date().toISOString()
      }, { onConflict: 'driver_id' });

    console.log(`Cash trip commission processed successfully. New wallet balance: ${newWalletBalancePence}p`);

    return new Response(
      JSON.stringify({
        success: true,
        trip_id,
        driver_id: trip.driver_id,
        gross_fare_pence: totalGrossPence,
        commission_pence: commissionPence,
        driver_net_pence: driverNetPence,
        wallet_debt_created: walletDebtCreated,
        new_wallet_balance_pence: newWalletBalancePence
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: unknown) {
    console.error('Unexpected error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: 'Internal server error', details: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
