import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface DeclineRequest {
  trip_id: string;
  driver_id: string;
  reason?: string;
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

    const body: DeclineRequest = await req.json();
    const { trip_id, driver_id, reason } = body;

    console.log(`[decline-trip] Driver ${driver_id} declining trip ${trip_id}`);

    // Find and update the offer
    const { data: offer, error: offerError } = await supabase
      .from('trip_offers')
      .update({ 
        status: 'declined', 
        responded_at: new Date().toISOString() 
      })
      .eq('trip_id', trip_id)
      .eq('driver_id', driver_id)
      .eq('status', 'offered')
      .select()
      .single();

    if (offerError || !offer) {
      console.log(`[decline-trip] No active offer found`);
      return new Response(JSON.stringify({
        success: false,
        error: 'Offer not found or already processed'
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 404 });
    }

    console.log(`[decline-trip] Offer declined successfully`);

    // Check if all offers are now declined/expired
    const { data: remainingOffers, error: remainingError } = await supabase
      .from('trip_offers')
      .select('id')
      .eq('trip_id', trip_id)
      .eq('status', 'offered');

    if (!remainingError && (!remainingOffers || remainingOffers.length === 0)) {
      // All offers have been declined or expired
      console.log(`[decline-trip] No remaining offers for trip ${trip_id}`);
      
      // Check if trip is still in 'offered' status (not accepted by someone else)
      const { data: trip } = await supabase
        .from('trips')
        .select('status')
        .eq('id', trip_id)
        .single();

      if (trip?.status === 'offered') {
        // Update trip status to no_drivers for potential rebroadcast
        await supabase
          .from('trips')
          .update({ status: 'no_drivers' })
          .eq('id', trip_id);
        
        console.log(`[decline-trip] Trip ${trip_id} marked as no_drivers`);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      declined: true,
      message: 'Offer declined'
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[decline-trip] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }), { 
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500
    });
  }
});
