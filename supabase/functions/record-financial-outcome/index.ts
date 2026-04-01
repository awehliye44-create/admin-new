import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { calculateCommission } from "../_shared/commission.ts";
import { resolveCurrencyFromTrip } from "../_shared/regionCurrency.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

/**
 * record-financial-outcome
 * 
 * Records financial outcomes for NO_SHOW and LATE_PASSENGER_CANCELLATION.
 * These are financially countable outcomes that generate revenue/commission/driver earnings.
 * 
 * Accepts:
 *   - trip_id: UUID
 *   - driver_id: UUID
 *   - outcome: 'NO_SHOW' | 'LATE_PASSENGER_CANCELLATION'
 *   - fee_pence: number (the no-show fee or late cancellation fee)
 *   - payment_method: string (from the original trip)
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { trip_id, driver_id, outcome, fee_pence, payment_method } = await req.json();

    // Validate inputs
    if (!trip_id || !driver_id || !outcome || typeof fee_pence !== 'number') {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: trip_id, driver_id, outcome, fee_pence' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const VALID_OUTCOMES = ['NO_SHOW', 'LATE_PASSENGER_CANCELLATION'];
    if (!VALID_OUTCOMES.includes(outcome)) {
      return new Response(
        JSON.stringify({ error: `Invalid outcome. Must be one of: ${VALID_OUTCOMES.join(', ')}` }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (fee_pence <= 0) {
      return new Response(
        JSON.stringify({ error: 'fee_pence must be positive' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Resolve currency
    let currency_code: string;
    try {
      const regionCurrency = await resolveCurrencyFromTrip(supabase, trip_id);
      currency_code = regionCurrency.currency_code;
    } catch (e) {
      console.error(`[record-financial-outcome] Currency resolution failed:`, e);
      return new Response(
        JSON.stringify({ error: (e as Error).message }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Validate trip exists
    const { data: trip, error: tripError } = await supabase
      .from('trips')
      .select('id, status, driver_id, service_area_id, financial_outcome')
      .eq('id', trip_id)
      .single();

    if (tripError || !trip) {
      return new Response(
        JSON.stringify({ error: 'Trip not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Idempotency: check BOTH trip status AND ledger entries
    // This prevents data gaps where trip was updated but ledger entries failed
    if (trip.financial_outcome === outcome) {
      // Trip already marked — verify ledger entries exist too
      const { data: existingLedger } = await supabase
        .from('driver_ledger')
        .select('id')
        .eq('trip_id', trip_id)
        .in('entry_type', ['CASH_COMMISSION_DEBT', 'TRIP_EARNING_NET', 'COMPANY_COMMISSION'])
        .limit(1);

      if (existingLedger && existingLedger.length > 0) {
        return new Response(
          JSON.stringify({ success: true, idempotent: true, trip_id, outcome }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      // Trip marked but ledger missing — fall through to create ledger entries
      console.warn(`[record-financial-outcome] Trip ${trip_id} has outcome=${outcome} but missing ledger entries — repairing`);
    }

    // Calculate commission on the fee
    const { commission_pct, commission_pence, driver_net_pence } = await calculateCommission(supabase, driver_id, fee_pence);

    const revenue_type = outcome === 'NO_SHOW' ? 'no_show_revenue' : 'late_cancellation_revenue';
    const isCash = (payment_method || '').toUpperCase() === 'CASH';

    console.log(`[record-financial-outcome] ${outcome} for trip ${trip_id}: fee=${fee_pence}p, commission=${commission_pence}p, driverNet=${driver_net_pence}p`);

    // Get wallet balance before
    // IMPORTANT: Exclude COMPANY_COMMISSION from wallet balance — it is platform revenue, not driver funds
    const { data: walletEntries } = await supabase
      .from('driver_ledger')
      .select('amount_pence')
      .eq('driver_id', driver_id)
      .neq('entry_type', 'COMPANY_COMMISSION');
    const walletBefore = walletEntries?.reduce((sum: number, e: any) => sum + (e.amount_pence || 0), 0) || 0;

    // Update trip with financial outcome
    const tripStatusMap: Record<string, string> = {
      'NO_SHOW': 'no_show',
      'LATE_PASSENGER_CANCELLATION': 'cancelled',
    };

    await supabase
      .from('trips')
      .update({
        status: tripStatusMap[outcome] || trip.status,
        financial_outcome: outcome,
        gross_fare_pence: fee_pence,
        commission_pence: commission_pence,
        driver_net_pence: driver_net_pence,
        payment_method: payment_method || trip.status,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', trip_id);

    // Create trip_finance record
    const financeRecord: Record<string, unknown> = {
      trip_id,
      driver_id,
      service_area_id: trip.service_area_id,
      financial_status: 'recognized',
      revenue_type,
      is_financially_countable: true,
      base_fare_pence: fee_pence,
      pickup_waiting_charge_pence: 0,
      stop_waiting_charge_pence: 0,
      stop_modification_charge_pence: 0,
      destination_change_charge_pence: 0,
      extras_charge_pence: 0,
      tip_amount_pence: 0,
      commissionable_subtotal_pence: fee_pence,
      commission_rate_pct: commission_pct,
      platform_commission_pence: commission_pence,
      driver_net_before_tip_pence: driver_net_pence,
      driver_total_earnings_pence: driver_net_pence,
      final_trip_total_pence: fee_pence,
      payment_method: payment_method || 'unknown',
      currency_code,
      wallet_balance_before_pence: walletBefore,
      settlement_status: 'settled',
      settled_at: new Date().toISOString(),
    };

    // Handle cash vs card ledger entries
    if (isCash) {
      // Driver collected cash, owes commission to platform
      if (commission_pence > 0) {
        const { data: ledgerEntry } = await supabase
          .from('driver_ledger')
          .insert({
            driver_id,
            trip_id,
            entry_type: 'CASH_COMMISSION_DEBT',
            amount_pence: -commission_pence,
            currency_code,
            description: `Commission from ${outcome === 'NO_SHOW' ? 'no-show' : 'late cancellation'} fee (cash)`,
          })
          .select('id')
          .single();

        financeRecord.cash_commission_ledger_id = ledgerEntry?.id;
      }
      financeRecord.wallet_balance_after_pence = walletBefore - commission_pence;
    } else {
      // Digital: credit driver earnings to ledger
      if (driver_net_pence > 0) {
        await supabase
          .from('driver_ledger')
          .insert({
            driver_id,
            trip_id,
            entry_type: 'TRIP_EARNING_NET',
            amount_pence: driver_net_pence,
            currency_code,
            description: `Driver earnings from ${outcome === 'NO_SHOW' ? 'no-show' : 'late cancellation'} fee`,
          });
      }
      financeRecord.wallet_balance_after_pence = walletBefore + driver_net_pence;
    }

    // Record COMPANY_COMMISSION in ledger (platform revenue SSOT)
    if (commission_pence > 0) {
      await supabase.from('driver_ledger').insert({
        driver_id,
        trip_id,
        entry_type: 'COMPANY_COMMISSION',
        amount_pence: commission_pence,
        currency_code,
        description: `Platform commission from ${outcome === 'NO_SHOW' ? 'no-show' : 'late cancellation'} fee`,
      });
      console.log(`[record-financial-outcome] COMPANY_COMMISSION: +${commission_pence}p`);
    }

    // Insert trip_finance
    const { error: financeError } = await supabase
      .from('trip_finance')
      .insert(financeRecord);

    if (financeError) {
      console.error('[record-financial-outcome] trip_finance insert error:', financeError);
    }

    // Clear driver current trip
    await supabase
      .from('drivers')
      .update({ current_trip_id: null })
      .eq('id', driver_id);

    console.log(`[record-financial-outcome] ${outcome} recorded for trip ${trip_id}`);

    return new Response(
      JSON.stringify({
        success: true,
        trip_id,
        outcome,
        fee_pence,
        commission_pence,
        driver_net_pence,
        revenue_type,
        currency_code,
        wallet_balance_before: walletBefore,
        wallet_balance_after: isCash ? walletBefore - commission_pence : walletBefore + driver_net_pence,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[record-financial-outcome] Error:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
