import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader.startsWith('Bearer ')) {
      return json({ success: false, error_code: 'UNAUTHORIZED', error: 'Missing bearer token' }, 401);
    }

    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });

    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData?.user) {
      return json({ success: false, error_code: 'UNAUTHORIZED', error: 'Invalid session' }, 401);
    }

    let tripId: string | null = null;
    if (req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      const raw = (body as Record<string, unknown>)?.trip_id;
      if (typeof raw === 'string' && raw.trim()) tripId = raw.trim();
    } else {
      tripId = new URL(req.url).searchParams.get('trip_id');
    }

    if (!tripId || !/^[0-9a-f-]{36}$/i.test(tripId)) {
      return json({ success: false, error_code: 'INVALID_TRIP_ID', error: 'trip_id must be a UUID' }, 400);
    }

    // The RPC derives the driver identity from auth.uid() and only returns
    // rows for trips assigned or offered to that driver.
    const { data, error } = await userClient.rpc('get_trip_passenger_details', { p_trip_id: tripId });

    if (error) {
      console.error('passenger details rpc failed', error);
      return json({ success: false, error_code: 'QUERY_FAILED', error: error.message }, 500);
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      return json({ success: true, passenger: null, error_code: 'NO_PASSENGER_VISIBLE' }, 200);
    }

    return json({
      success: true,
      passenger: {
        trip_id: row.trip_id,
        passenger_id: row.passenger_id,
        first_name: row.first_name,
        display_name: row.display_name,
        customer_code: row.customer_code,
        rating: row.rating === null ? null : Number(row.rating),
        ratings_count: row.ratings_count ?? 0,
        completed_trips: row.completed_trips ?? 0,
        phone_verified: !!row.phone_verified,
      },
    });
  } catch (e) {
    console.error('driver-trip-passenger-details error', e);
    return json({ success: false, error_code: 'INTERNAL_ERROR', error: String(e) }, 500);
  }
});
