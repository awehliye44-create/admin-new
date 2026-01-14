import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface AcceptRequest {
  trip_id: string;
  driver_id: string;
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const body: AcceptRequest = await req.json();
    const { trip_id, driver_id } = body;

    console.log(`[accept-trip] Driver ${driver_id} attempting to accept trip ${trip_id}`);

    // Verify the offer exists and is still valid
    const { data: offer, error: offerError } = await supabase
      .from('trip_offers')
      .select('id, status, expires_at')
      .eq('trip_id', trip_id)
      .eq('driver_id', driver_id)
      .single();

    if (offerError || !offer) {
      console.log(`[accept-trip] No offer found for driver ${driver_id} on trip ${trip_id}`);
      return new Response(JSON.stringify({
        success: false,
        error: 'Offer not found',
        message: 'This ride offer is no longer available'
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 404 });
    }

    // Check if offer has expired
    if (new Date(offer.expires_at) < new Date()) {
      console.log(`[accept-trip] Offer expired for driver ${driver_id}`);
      
      await supabase
        .from('trip_offers')
        .update({ status: 'expired', responded_at: new Date().toISOString() })
        .eq('id', offer.id);

      return new Response(JSON.stringify({
        success: false,
        error: 'Offer expired',
        message: 'This offer has expired'
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 });
    }

    // Check if offer was already responded to
    if (offer.status !== 'offered') {
      console.log(`[accept-trip] Offer already processed: ${offer.status}`);
      return new Response(JSON.stringify({
        success: false,
        error: 'Already processed',
        message: offer.status === 'accepted' ? 'You already accepted this ride' : 'This offer is no longer available'
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 });
    }

    // ATOMIC OPERATION: Try to claim the trip
    // This uses a conditional update that only succeeds if confirmed_driver_id is still null
    const { data: updatedTrip, error: tripUpdateError } = await supabase
      .from('trips')
      .update({
        status: 'accepted',
        driver_id: driver_id,
        confirmed_driver_id: driver_id,
        updated_at: new Date().toISOString()
      })
      .eq('id', trip_id)
      .is('confirmed_driver_id', null)  // Only update if no driver assigned yet
      .eq('status', 'offered')  // Only update if still in offered status
      .select()
      .single();

    if (tripUpdateError || !updatedTrip) {
      // Another driver already accepted
      console.log(`[accept-trip] Trip already claimed by another driver`);
      
      // Mark this driver's offer as withdrawn
      await supabase
        .from('trip_offers')
        .update({ status: 'withdrawn', responded_at: new Date().toISOString() })
        .eq('id', offer.id);

      return new Response(JSON.stringify({
        success: false,
        error: 'Already accepted',
        message: 'Another driver accepted this ride first'
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 409 });
    }

    console.log(`[accept-trip] Trip ${trip_id} successfully assigned to driver ${driver_id}`);

    // Mark this driver's offer as accepted
    await supabase
      .from('trip_offers')
      .update({ status: 'accepted', responded_at: new Date().toISOString() })
      .eq('id', offer.id);

    // Withdraw all other offers for this trip
    const { data: withdrawnOffers, error: withdrawError } = await supabase
      .from('trip_offers')
      .update({ status: 'withdrawn', responded_at: new Date().toISOString() })
      .eq('trip_id', trip_id)
      .eq('status', 'offered')
      .neq('driver_id', driver_id)
      .select('driver_id');

    if (withdrawError) {
      console.error('[accept-trip] Error withdrawing other offers:', withdrawError);
    } else {
      console.log(`[accept-trip] Withdrew ${withdrawnOffers?.length || 0} other offers`);
    }

    // Update driver's current trip
    await supabase
      .from('drivers')
      .update({ current_trip_id: trip_id })
      .eq('id', driver_id);

    // Get trip details for response
    const { data: tripDetails, error: tripDetailsError } = await supabase
      .from('trips')
      .select(`
        id,
        trip_code,
        pickup_address,
        pickup_latitude,
        pickup_longitude,
        dropoff_address,
        dropoff_latitude,
        dropoff_longitude,
        passenger_name,
        passenger_phone,
        estimated_fare,
        estimated_distance_km,
        estimated_duration_minutes,
        payment_method,
        special_instructions,
        currency
      `)
      .eq('id', trip_id)
      .single();

    return new Response(JSON.stringify({
      success: true,
      accepted: true,
      message: 'Ride accepted successfully!',
      trip: tripDetails || updatedTrip,
      withdrawn_offers: withdrawnOffers?.length || 0
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[accept-trip] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }), { 
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500
    });
  }
});
