import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { resolveCurrencyFromTrip } from "../_shared/regionCurrency.ts";
import { assertServiceRole } from "../_shared/internalAuth.ts";
import { tripBlocksDriverWalletLedgerPosting } from "../_shared/commissionWalletDeduction.ts";
import { postTerminalOutcomeSettlement } from "../_shared/canonicalTypedWalletPostingSSOT.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

/**
 * record-financial-outcome
 *
 * Records financial outcomes for NO_SHOW and LATE_PASSENGER_CANCELLATION.
 * Wallet posting delegates to canonicalTypedWalletPostingSSOT.
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const gate = assertServiceRole(req);
  if (gate) return gate;

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { trip_id, driver_id, outcome, fee_pence, payment_method } = await req.json();

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

    if (trip.financial_outcome === outcome) {
      const { data: existingLedger } = await supabase
        .from('driver_wallet_ledger')
        .select('id')
        .eq('related_trip_id', trip_id)
        .eq('type', 'TRIP_EARNING_NET')
        .limit(1);

      if (existingLedger && existingLedger.length > 0) {
        return new Response(
          JSON.stringify({ success: true, idempotent: true, trip_id, outcome }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      console.warn(`[record-financial-outcome] Trip ${trip_id} has outcome=${outcome} but missing ledger entries — repairing`);
    }

    if (await tripBlocksDriverWalletLedgerPosting(supabase, trip_id)) {
      console.log(`[record-financial-outcome] FINANCIAL_MODEL_VIOLATION — DWL forbidden ${trip_id}`);
      await supabase
        .from('drivers')
        .update({ current_trip_id: null })
        .eq('id', driver_id);
      return new Response(
        JSON.stringify({
          success: false,
          trip_id,
          outcome,
          error: "FINANCIAL_MODEL_VIOLATION: driver_wallet_ledger forbidden on DRIVER_COLLECTED_COMMISSION_WALLET",
          error_code: "FINANCIAL_MODEL_VIOLATION",
        }),
        { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const revenue_type = outcome === 'NO_SHOW' ? 'no_show_revenue' : 'late_cancellation_revenue';

    const posted = await postTerminalOutcomeSettlement({
      supabase,
      tripId: trip_id,
      driverId: driver_id,
      serviceAreaId: trip.service_area_id,
      feePence: fee_pence,
      outcome,
      paymentMethod: payment_method,
      currencyCode: currency_code,
    });

    console.log(
      `[record-financial-outcome] ${outcome} for trip ${trip_id}: fee=${fee_pence}p, commission=${posted.commission_pence}p, driverNet=${posted.driver_net_pence}p`,
    );

    await supabase
      .from('drivers')
      .update({ current_trip_id: null })
      .eq('id', driver_id);

    return new Response(
      JSON.stringify({
        success: true,
        trip_id,
        outcome,
        fee_pence,
        commission_pence: posted.commission_pence,
        driver_net_pence: posted.driver_net_pence,
        revenue_type,
        currency_code,
        wallet_credited: posted.credited,
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
