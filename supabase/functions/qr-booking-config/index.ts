import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { data, error } = await supabase
      .from('qr_booking_config')
      .select('pickup_name, pickup_address, pickup_lat, pickup_lng, status, qr_url, allow_cash, allow_card, allow_apple_pay, allow_google_pay')
      .limit(1)
      .single();

    if (error) {
      return new Response(JSON.stringify({ error: 'CONFIG_NOT_FOUND' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // If disabled, return blocked status
    if (data.status === 'disabled') {
      return new Response(JSON.stringify({
        enabled: false,
        message: 'QR booking is temporarily unavailable',
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({
      enabled: true,
      pickup: {
        name: data.pickup_name,
        address: data.pickup_address,
        lat: data.pickup_lat,
        lng: data.pickup_lng,
      },
      qrUrl: data.qr_url,
      paymentMethods: {
        cash: data.allow_cash,
        card: data.allow_card,
        applePay: data.allow_apple_pay,
        googlePay: data.allow_google_pay,
      },
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'INTERNAL_ERROR' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
