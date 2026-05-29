import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { calculateCommission } from "../_shared/commission.ts";
import { resolveCurrencyFromTrip } from "../_shared/regionCurrency.ts";
import { assertServiceRole } from "../_shared/internalAuth.ts";

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
    if (trip.financial_outcome === outcome) {
      const { data: existingLedger } = await supabase
        .from('driver_wallet_ledger')
        .select('id')
        .eq('related_trip_id', trip_id)
        .in('type', ['CASH_COMMISSION_DEBT', 'TRIP_EARNING_NET', 'PLATFORM_COMMISSION'])
        .limit(1);

      if (existingLedger && existingLedger.length > 0) {
        return new Response(
          JSON.stringify({ success: true, idempotent: true, trip_id, outcome }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      console.warn(`[record-financial-outcome] Trip ${trip_id} has outcome=${outcome} but missing ledger entries — repairing`);
    }

    // Calculate commission on the fee — tier snapshot is locked on this trip
    const { commission_pct, commission_pence, driver_net_pence } = await calculateCommission(supabase, driver_id, fee_pence);

    const revenue_type = outcome === 'NO_SHOW' ? 'no_show_revenue' : 'late_cancellation_revenue';
    const isCash = (payment_method || '').toUpperCase() === 'CASH';

    console.log(`[record-financial-outcome] ${outcome} for trip ${trip_id}: fee=${fee_pence}p, commission=${commission_pence}p, driverNet=${driver_net_pence}p`);

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
        commission_pct: commission_pct, // Tier snapshot — LOCKED
        driver_net_pence: driver_net_pence,
        payment_method: payment_method || trip.status,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', trip_id);

    // === trip_finance DEPRECATED — all financial data in driver_wallet_ledger ===

    // Handle cash vs card ledger entries — write to driver_wallet_ledger
    if (isCash) {
      if (commission_pence > 0) {
        await supabase
          .from('driver_wallet_ledger')
          .insert({
            driver_id,
            related_trip_id: trip_id,
            type: 'CASH_COMMISSION_DEBT',
            amount_pence: -commission_pence,
            currency: currency_code,
            description: `Commission from ${outcome === 'NO_SHOW' ? 'no-show' : 'late cancellation'} fee (cash)`,
          });
      }

      // Record CASH_TRIP_EARNING (reporting)
      await supabase.from('driver_wallet_ledger').insert({
        driver_id,
        related_trip_id: trip_id,
        type: 'CASH_TRIP_EARNING',
        amount_pence: fee_pence,
        currency: currency_code,
        description: `Cash ${outcome === 'NO_SHOW' ? 'no-show' : 'late cancellation'} fee collected`,
      });
    } else {
      if (driver_net_pence > 0) {
        await supabase
          .from('driver_wallet_ledger')
          .insert({
            driver_id,
            related_trip_id: trip_id,
            type: 'TRIP_EARNING_NET',
            amount_pence: driver_net_pence,
            currency: currency_code,
            description: `Driver earnings from ${outcome === 'NO_SHOW' ? 'no-show' : 'late cancellation'} fee`,
          });
      }
    }

    // Record PLATFORM_COMMISSION in driver_wallet_ledger
    if (commission_pence > 0) {
      await supabase.from('driver_wallet_ledger').insert({
        driver_id,
        related_trip_id: trip_id,
        type: 'PLATFORM_COMMISSION',
        amount_pence: commission_pence,
        currency: currency_code,
        description: `Platform commission from ${outcome === 'NO_SHOW' ? 'no-show' : 'late cancellation'} fee`,
      });
      console.log(`[record-financial-outcome] PLATFORM_COMMISSION: +${commission_pence}p`);
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
