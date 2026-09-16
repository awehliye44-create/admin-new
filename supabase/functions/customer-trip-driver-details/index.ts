import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const DRIVER_DOCUMENTS_BUCKET = 'driver-documents';
const SIGNED_URL_TTL_SECONDS = 3600;

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

    if (tripId && !/^[0-9a-f-]{36}$/i.test(tripId)) {
      return json({ success: false, error_code: 'INVALID_TRIP_ID', error: 'trip_id must be a UUID' }, 400);
    }

    // RLS-scoped: the RPC itself only returns rows for the caller's own trips.
    const { data, error } = tripId
      ? await userClient.rpc('get_trip_driver_details', { p_trip_id: tripId })
      : await userClient.rpc('get_my_last_trip_driver_details');

    if (error) {
      console.error('driver details rpc failed', error);
      return json({ success: false, error_code: 'QUERY_FAILED', error: error.message }, 500);
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      return json({ success: true, driver: null, error_code: 'NO_DRIVER_ASSIGNED' }, 200);
    }

    let photoUrl: string | null = null;
    if (row.driver_photo_path) {
      const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
      const { data: signed, error: signError } = await admin.storage
        .from(DRIVER_DOCUMENTS_BUCKET)
        .createSignedUrl(row.driver_photo_path, SIGNED_URL_TTL_SECONDS);
      if (signError) {
        console.error('photo sign failed', row.driver_photo_path, signError.message);
      } else {
        photoUrl = signed?.signedUrl ?? null;
      }
    }

    return json({
      success: true,
      driver: {
        trip_id: row.trip_id,
        trip_status: row.trip_status,
        driver_id: row.driver_id,
        first_name: row.driver_first_name,
        display_name: row.driver_display_name,
        photo_url: photoUrl,
        rating: row.driver_rating === null ? null : Number(row.driver_rating),
        rating_count: row.driver_rating_count ?? 0,
        vehicle: {
          make: row.vehicle_make,
          model: row.vehicle_model,
          color: row.vehicle_color,
          license_plate: row.vehicle_license_plate,
        },
      },
    });
  } catch (e) {
    console.error('customer-trip-driver-details error', e);
    return json({ success: false, error_code: 'INTERNAL_ERROR', error: String(e) }, 500);
  }
});
